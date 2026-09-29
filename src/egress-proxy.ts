import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isNetworkDestination, type NetworkControl } from "./execution-environment.js";
import { isPublicAddress } from "./web-address.js";
import { resolveHost } from "./web-fetch.js";
import { type NetworkPhase, permitted } from "./verification/setup-network-rule.js";
import { webAdmission } from "./verification/web-admission.js";

/**
 * The sandbox's egress proxy (decisions 030 and 043). A sandboxed command can
 * reach only this proxy, through a socket bound into its network namespace;
 * the proxy opens an HTTPS
 * tunnel (`CONNECT`) to a destination only when it is allowed and every
 * address it resolves to is public, and connects to the address it checked,
 * so an allowed name cannot point inside the operator's network. The order is
 * the rule `webAdmission` proves for web access. What was not allowed is
 * recorded for the operator's question after the command. Plain HTTP is
 * refused: package registries and Git use HTTPS. While an environment is set
 * up, the proxy also permits the destinations setup opened, and only then
 * (`permitted`, proved; decision 048).
 */

export interface EgressProxyOptions {
  /** Destinations allowed from the start, as `host:port`. */
  readonly allowed: readonly string[];
  /** Every address a host resolves to; the operator's resolver by default. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** A connection to exactly this address; a TCP connection by default. */
  readonly connect?: (address: string, port: number) => Socket;
  /** The socket to listen on, which the sandbox binds into each command's network namespace. */
  readonly socket: string;
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
  readonly #opened = new Set<string>();
  #phase: NetworkPhase = "agent";
  readonly #resolve: (host: string) => Promise<readonly string[]>;
  readonly #connect: (address: string, port: number) => Socket;
  readonly #refused: { at: number; destination: string }[] = [];
  /** Open tunnels by the destination each reaches. */
  readonly #tunnels = new Map<Duplex, string>();

  private constructor(options: EgressProxyOptions) {
    this.#allowed = new Set(options.allowed.map((destination) => destination.toLowerCase()));
    this.#resolve = options.resolve ?? resolveHost;
    this.#connect = options.connect ?? ((address, port) => connectTcp({ host: address, port }));
    this.#server = createServer((request, response) => { this.#plain(request, response); });
    this.#server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => { void this.#tunnel(request, socket, head); });
  }

  /** Listen on the socket given; only a sandbox that binds it reaches the proxy. */
  static async start(options: EgressProxyOptions): Promise<EgressProxy> {
    const proxy = new EgressProxy(options);
    await new Promise<void>((listening, failed) => {
      proxy.#server.once("error", failed);
      proxy.#server.listen(options.socket, () => { listening(); });
    });
    return proxy;
  }

  async blockedSince(time: Date): Promise<readonly string[]> {
    return [...new Set(this.#refused.filter((refusal) => refusal.at >= time.getTime()).map((refusal) => refusal.destination))];
  }

  async allow(destinations: readonly string[]): Promise<void> {
    for (const destination of destinations) if (isNetworkDestination(destination)) this.#allowed.add(destination.toLowerCase());
  }

  /**
   * Run setup with these destinations also permitted, then close them
   * whatever setup did: tunnels no longer permitted are ended, and the
   * destinations are read back through the proved rule. When any is still
   * permitted without being allowed on its own, this throws whatever setup
   * did; otherwise it returns or throws setup's own result.
   */
  async during<T>(destinations: readonly string[], setup: () => Promise<T>): Promise<T> {
    if (this.#phase === "setup") throw new Error("Setup is already under way");
    for (const destination of destinations) if (isNetworkDestination(destination)) this.#opened.add(destination.toLowerCase());
    this.#phase = "setup";
    const outcome = await setup().then((value) => ({ done: true as const, value }), (error: unknown) => ({ done: false as const, error }));
    this.#phase = "agent";
    for (const [tunnel, destination] of this.#tunnels) if (!this.#permits(destination)) tunnel.destroy();
    const stillOpen = [...this.#opened].filter((destination) => this.#permits(destination) && !this.#allowed.has(destination));
    this.#opened.clear();
    if (stillOpen.length > 0) throw new Error(`Setup's destinations could not be confirmed closed: ${stillOpen.join(", ")}`);
    if (!outcome.done) throw outcome.error;
    return outcome.value;
  }

  async close(): Promise<void> {
    for (const tunnel of this.#tunnels.keys()) tunnel.destroy();
    await new Promise<void>((closed) => { this.#server.close(() => { closed(); }); });
  }

  #permits(destination: string): boolean {
    return permitted(this.#allowed.has(destination), this.#opened.has(destination), this.#phase);
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
    const permission = this.#permits(wanted.destination) ? "allowed" : "denied";
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
      // Setup can end while a connection opens; what it no longer permits never becomes a tunnel.
      if (!this.#permits(wanted.destination)) { upstream.destroy(); refuse(socket, 403, "Forbidden"); return; }
      this.#tunnels.set(socket, wanted.destination);
      socket.once("close", () => { this.#tunnels.delete(socket); upstream.destroy(); });
      upstream.once("close", () => { socket.destroy(); });
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  }
}
