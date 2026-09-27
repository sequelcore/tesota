import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isNetworkDestination, type NetworkControl } from "./execution-environment.js";
import { isPublicAddress } from "./web-address.js";
import { resolveHost } from "./web-fetch.js";
import { webAdmission } from "./verification/web-admission.js";

/**
 * The native sandbox's egress proxy (decision 030). A sandboxed command can
 * reach only this proxy, on the loopback address; the proxy opens an HTTPS
 * tunnel (`CONNECT`) to a destination only when it is allowed and every
 * address it resolves to is public, and connects to the address it checked,
 * so an allowed name cannot point inside the operator's network. The order is
 * the rule `webAdmission` proves for web access. What was not allowed is
 * recorded for the operator's question after the command. Plain HTTP is
 * refused: package registries and Git use HTTPS.
 */

export interface EgressProxyOptions {
  /** Destinations allowed from the start, as `host:port`. */
  readonly allowed: readonly string[];
  /** Every address a host resolves to; the operator's resolver by default. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** A connection to exactly this address; a TCP connection by default. */
  readonly connect?: (address: string, port: number) => Socket;
}

/** Refusals kept for the operator's question; older ones are dropped. */
const REFUSALS_KEPT = 500;
const CONNECT_TIMEOUT_MS = 30_000;

function destinationOf(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`.toLowerCase();
}

/** A `CONNECT` target as host and port, or undefined when it is not a destination. */
function target(value: string | undefined): { host: string; port: number; destination: string } | undefined {
  if (value === undefined || !isNetworkDestination(value)) return undefined;
  const separator = value.lastIndexOf(":");
  const host = value.slice(0, separator).replace(/^\[(.*)\]$/u, "$1");
  const port = Number(value.slice(separator + 1));
  return port > 0 && port < 65_536 ? { host, port, destination: destinationOf(host, port) } : undefined;
}

function refuse(socket: Duplex, status: 400 | 403 | 502, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class EgressProxy implements NetworkControl {
  readonly #server: Server;
  readonly #allowed: Set<string>;
  readonly #resolve: (host: string) => Promise<readonly string[]>;
  readonly #connect: (address: string, port: number) => Socket;
  readonly #refused: { at: number; destination: string }[] = [];
  readonly #tunnels = new Set<Duplex>();
  #port = 0;

  private constructor(options: EgressProxyOptions) {
    this.#allowed = new Set(options.allowed.map((destination) => destination.toLowerCase()));
    this.#resolve = options.resolve ?? resolveHost;
    this.#connect = options.connect ?? ((address, port) => connectTcp({ host: address, port }));
    this.#server = createServer((request, response) => { this.#plain(request, response); });
    this.#server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => { void this.#tunnel(request, socket, head); });
  }

  /** Listen on a free loopback port; only a sandbox given this address uses it. */
  static async start(options: EgressProxyOptions): Promise<EgressProxy> {
    const proxy = new EgressProxy(options);
    await new Promise<void>((listening, failed) => {
      proxy.#server.once("error", failed);
      proxy.#server.listen(0, "127.0.0.1", () => { listening(); });
    });
    const address = proxy.#server.address();
    proxy.#port = typeof address === "object" && address !== null ? address.port : 0;
    return proxy;
  }

  /** The proxy's address, as sandboxes are configured with it. */
  get url(): string { return `http://127.0.0.1:${this.#port}`; }

  async blockedSince(time: Date): Promise<readonly string[]> {
    return [...new Set(this.#refused.filter((refusal) => refusal.at >= time.getTime()).map((refusal) => refusal.destination))];
  }

  async allow(destinations: readonly string[]): Promise<void> {
    for (const destination of destinations) if (isNetworkDestination(destination)) this.#allowed.add(destination.toLowerCase());
  }

  async close(): Promise<void> {
    for (const tunnel of this.#tunnels) tunnel.destroy();
    await new Promise<void>((closed) => { this.#server.close(() => { closed(); }); });
  }

  #record(destination: string): void {
    this.#refused.push({ at: Date.now(), destination });
    if (this.#refused.length > REFUSALS_KEPT) this.#refused.splice(0, this.#refused.length - REFUSALS_KEPT);
  }

  #plain(request: IncomingMessage, response: ServerResponse): void {
    let url: URL | undefined;
    try { url = new URL(request.url ?? ""); } catch { url = undefined; }
    if (url?.hostname) this.#record(destinationOf(url.hostname, Number(url.port) || (url.protocol === "https:" ? 443 : 80)));
    response.writeHead(403, { "Content-Length": "0", Connection: "close" }).end();
  }

  async #tunnel(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    const wanted = target(request.url);
    // The proved order: a readable destination, then the operator's permission, then only public addresses.
    if (webAdmission(wanted !== undefined, "denied", false) === "refuse_url" || wanted === undefined) {
      refuse(socket, 400, "Bad Request");
      return;
    }
    const permission = this.#allowed.has(wanted.destination) ? "allowed" : "denied";
    if (webAdmission(true, permission, false) === "deny") {
      this.#record(wanted.destination);
      refuse(socket, 403, "Forbidden");
      return;
    }
    const addresses = await this.#resolve(wanted.host).catch(() => [] as readonly string[]);
    const [address] = addresses;
    if (webAdmission(true, permission, addresses.length > 0 && addresses.every(isPublicAddress)) !== "fetch" || address === undefined) {
      refuse(socket, 403, "Forbidden");
      return;
    }
    const upstream = this.#connect(address, wanted.port);
    const opened = setTimeout(() => { upstream.destroy(); refuse(socket, 502, "Bad Gateway"); }, CONNECT_TIMEOUT_MS);
    upstream.once("error", () => { clearTimeout(opened); refuse(socket, 502, "Bad Gateway"); });
    upstream.once("connect", () => {
      clearTimeout(opened);
      this.#tunnels.add(socket);
      socket.once("close", () => { this.#tunnels.delete(socket); upstream.destroy(); });
      upstream.once("close", () => { socket.destroy(); });
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  }
}
