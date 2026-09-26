import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { convert } from "html-to-text";
import { isPublicAddress } from "./web-address.js";
import { type WebPermission, webAdmission } from "./verification/web-admission.js";

/**
 * Reading a web page from the operator's computer (decision 024). A URL is
 * admitted only as `https` on the standard port, without credentials; the
 * operator allows its host before the host is looked up; the page is read
 * only from an address on the public internet, and from that same address,
 * so a public name cannot point inside the operator's network. Each redirect
 * is a new destination, at most five; responses are limited in size, time and
 * type, and HTML becomes text.
 */

export const WEB_PAGE_LIMIT_BYTES: number = 2 * 1024 * 1024;
export const WEB_TIME_LIMIT_MS: number = 30_000;
export const WEB_REDIRECT_LIMIT: number = 5;

export type WebError = "url_refused" | "destination_denied" | "address_refused" | "too_many_redirects" | "too_large" |
  "unsupported_type" | "timeout" | "empty_page" | "fetch_failed";

export interface WebPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly contentType: string;
  readonly text: string;
}

export type WebFetchResult =
  | Readonly<{ status: "ok"; page: WebPage }>
  | Readonly<{ status: "failed"; error: WebError; detail: string }>;

export interface WebResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface WebFetchDependencies {
  /** The operator's permission for a host: allowed or denied, asking when it has not been decided. */
  permit(host: string): Promise<Exclude<WebPermission, "unasked">>;
  /** Every address the host resolves to. */
  resolve(host: string): Promise<readonly string[]>;
  /** A GET of `url` connected to `address`, the one that was checked. */
  get(url: URL, address: string, signal: AbortSignal): Promise<WebResponse>;
}

const textTypes = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"]);

function failed(error: WebError, detail: string): WebFetchResult {
  return { status: "failed", error, detail };
}

/** The URL as it would be fetched, or undefined when no fetch of it can be admitted. */
export function admissibleUrl(raw: string): URL | undefined {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return undefined; }
  if (url.protocol === "http:") url = new URL(`https:${url.href.slice("http:".length)}`);
  const standardPort = url.port === "" || url.port === "443";
  if (url.protocol !== "https:" || !standardPort || url.username !== "" || url.password !== "" || url.hostname === "") {
    return undefined;
  }
  url.hash = "";
  return url;
}

async function readLimited(body: AsyncIterable<Uint8Array>): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > WEB_PAGE_LIMIT_BYTES) return undefined;
    chunks.push(chunk);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

function pageText(bytes: Uint8Array, type: string, charset: string | undefined): string {
  let decoded: string;
  try { decoded = new TextDecoder(charset ?? "utf-8").decode(bytes); } catch { decoded = new TextDecoder("utf-8").decode(bytes); }
  if (type === "text/html" || type === "application/xhtml+xml") {
    // Headings and table headers keep their case, so a reader can quote them as the page wrote them.
    return convert(decoded, { wordwrap: false, selectors: [{ selector: "img", format: "skip" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
      { selector: "table", options: { uppercaseHeaderCells: false } }] });
  }
  return decoded;
}

/** One admitted request: the destination checked, then the response read or the redirect named. */
async function fetchOnce(url: URL, dependencies: WebFetchDependencies, signal: AbortSignal):
  Promise<Readonly<{ response: WebResponse }> | Readonly<{ failure: WebFetchResult }>> {
  const host = url.hostname;
  // The proved rule orders the steps: permission before the lookup, the address after it.
  const permission = await dependencies.permit(host);
  if (webAdmission(true, permission, false) === "deny") return { failure: failed("destination_denied", `${host} is not allowed`) };
  const addresses = await dependencies.resolve(host);
  const publicAddress = addresses.length > 0 && addresses.every(isPublicAddress);
  if (webAdmission(true, permission, publicAddress) !== "fetch") {
    return { failure: failed("address_refused", `${host} resolves to an address outside the public internet`) };
  }
  return { response: await dependencies.get(url, addresses[0] ?? "", signal) };
}

/** Where a redirect leads, as an admissible URL; a failure when it leads nowhere readable. */
function redirectTarget(response: WebResponse, from: URL, hops: number): URL | WebFetchResult | undefined {
  const location = response.headers["location"];
  if (response.status < 300 || response.status >= 400 || location === undefined) return undefined;
  if (hops >= WEB_REDIRECT_LIMIT) return failed("too_many_redirects", `More than ${WEB_REDIRECT_LIMIT} redirects`);
  return admissibleUrl(new URL(location, from).href) ?? failed("url_refused", `A redirect led to a URL that cannot be read: ${location}`);
}

/** A final response as a page: a success status, a text type, within the size limit, and with some text. */
async function readPage(response: WebResponse, first: URL, final: URL): Promise<WebFetchResult> {
  if (response.status < 200 || response.status >= 300) return failed("fetch_failed", `The server answered ${response.status}`);
  const [type = "", ...parameters] = (response.headers["content-type"] ?? "").split(";").map((part) => part.trim().toLowerCase());
  if (!textTypes.has(type)) return failed("unsupported_type", `${type || "An unnamed type"} is not text`);
  const bytes = await readLimited(response.body);
  if (bytes === undefined) return failed("too_large", `The page is larger than ${WEB_PAGE_LIMIT_BYTES / 1024 / 1024} MB`);
  const charset = parameters.find((part) => part.startsWith("charset="))?.slice("charset=".length);
  const text = pageText(bytes, type, charset).trim();
  if (text === "") return failed("empty_page", "The page has no text");
  return { status: "ok", page: { url: first.href, finalUrl: final.href, contentType: type, text } };
}

/** Read one page, following redirects, under the limits above. */
export async function fetchPage(raw: string, dependencies: WebFetchDependencies, signal: AbortSignal,
  options: { readonly timeLimitMs?: number } = {}): Promise<WebFetchResult> {
  const first = admissibleUrl(raw);
  if (webAdmission(first !== undefined, "unasked", false) === "refuse_url" || first === undefined) {
    return failed("url_refused", "Only https URLs on the standard port and without credentials can be read");
  }
  const limit = AbortSignal.timeout(options.timeLimitMs ?? WEB_TIME_LIMIT_MS);
  const combined = AbortSignal.any([signal, limit]);
  let url = first;
  try {
    for (let hops = 0; ; hops += 1) {
      const outcome = await fetchOnce(url, dependencies, combined);
      if ("failure" in outcome) return outcome.failure;
      const next = redirectTarget(outcome.response, url, hops);
      if (next === undefined) return await readPage(outcome.response, first, url);
      if (!(next instanceof URL)) return next;
      url = next;
    }
  } catch (error) {
    if (limit.aborted && !signal.aborted) return failed("timeout", `No page within ${(options.timeLimitMs ?? WEB_TIME_LIMIT_MS) / 1000} s`);
    if (signal.aborted) throw error;
    return failed("fetch_failed", error instanceof Error ? error.message : "The request failed");
  }
}

/** Every address a host resolves to, from the operator's resolver. */
export async function resolveHost(host: string): Promise<readonly string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/**
 * A GET connected to exactly `address`: the connection skips a second lookup,
 * while TLS still verifies the certificate for the URL's host. No cookies or
 * credentials are sent.
 */
export function pinnedGet(url: URL, address: string, signal: AbortSignal): Promise<WebResponse> {
  const family = address.includes(":") ? 6 : 4;
  return new Promise((settle, fail) => {
    const outgoing = request(url, { method: "GET", signal,
      headers: { "user-agent": "Tesota (web access)", accept: "text/html, text/markdown, text/plain, application/json;q=0.9" },
      lookup: (_host, _options, callback) => {
        (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address, family }]);
      } }, (incoming) => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(incoming.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      settle({ status: incoming.statusCode ?? 0, headers, body: incoming });
    });
    outgoing.on("error", fail);
    outgoing.end();
  });
}
