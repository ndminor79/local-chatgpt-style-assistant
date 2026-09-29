import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { assertSafeFetchUrl, isPublicIpAddress } from "./security";

const maxResponseBytes = 512_000;
const maxRedirects = 3;

type SafeResponse = {
  status: number;
  location?: string;
  contentType?: string;
  text: string;
};

async function resolvePublicAddresses(host: string): Promise<LookupAddress[]> {
  if (!host.includes(".") && isIP(host) === 0) {
    throw new Error("Single-label hostnames are not allowed.");
  }
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await dnsLookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error("The host resolves to a private or reserved network address.");
  }
  return addresses;
}

function requestOnce(url: URL, addresses: LookupAddress[], signal: AbortSignal): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const allowed = addresses.filter(({ family }) =>
        options.family === undefined || options.family === 0 || options.family === family ||
        (options.family === "IPv4" && family === 4) || (options.family === "IPv6" && family === 6)
      );
      if (allowed.length === 0) {
        callback(Object.assign(new Error("No validated address for host."), { code: "ENOTFOUND" }), "", 0);
        return;
      }
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    };

    const request = transport(url, {
      method: "GET",
      signal,
      lookup: pinnedLookup,
      maxHeaderSize: 16_384,
      headers: {
        "Accept": "text/html, text/plain;q=0.9, */*;q=0.1",
        "Accept-Encoding": "identity",
        "User-Agent": "LocalLLMAssistant/0.1 (+http://localhost)"
      }
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const contentType = response.headers["content-type"];
      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        response.destroy(new Error("Web page exceeded the response size limit."));
        reject(new Error("Web page exceeded the response size limit."));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > maxResponseBytes) {
          response.destroy(new Error("Web page exceeded the response size limit."));
          reject(new Error("Web page exceeded the response size limit."));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        resolve({
          status,
          location,
          contentType: Array.isArray(contentType) ? contentType[0] : contentType,
          text: Buffer.concat(chunks).toString("utf8")
        });
      });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Web page response ended unexpectedly.")));
    });
    request.on("error", reject);
    request.end();
  });
}

export async function fetchPublicText(rawUrl: string, signal: AbortSignal): Promise<SafeResponse> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    assertSafeFetchUrl(url.href);
    const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
    const addresses = await resolvePublicAddresses(hostname);
    const response = await requestOnce(url, addresses, signal);
    if (response.status < 300 || response.status >= 400 || !response.location) return response;
    if (redirects === maxRedirects) throw new Error("Too many web redirects.");
    url = new URL(response.location, url);
  }
  throw new Error("Too many web redirects.");
}
