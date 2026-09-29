import { mkdtemp, rm } from "node:fs/promises";
import { connect as connectTcp, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EgressProxy } from "../src/egress-proxy.js";

/**
 * The native sandbox's egress proxy (decision 030): a destination passes
 * only if it is allowed and resolves to public addresses, the connection goes
 * to the address that was checked, and what was not allowed is recorded for
 * the operator's question. Names resolve to documentation addresses, and every
 * connection lands on a local echo server.
 */

const addresses: Record<string, readonly string[]> = {
  "registry.example.com": ["93.184.215.14"], "example.org": ["93.184.215.15"], "intranet.example.com": ["10.0.0.5"],
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function echoServer(): Promise<number> {
  const server: Server = createServer((socket) => { socket.pipe(socket); });
  await new Promise<void>((listening) => { server.listen(0, "127.0.0.1", listening); });
  cleanup.push(() => new Promise((closed) => { server.close(() => { closed(); }); }));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function proxy(allowed: readonly string[], socket?: string) {
  const echo = await echoServer();
  const connected: string[] = [];
  const started = await EgressProxy.start({ allowed, ...socket === undefined ? {} : { socket },
    resolve: async (host) => addresses[host] ?? [],
    connect: (address, port) => { connected.push(`${address}:${port}`); return connectTcp(echo, "127.0.0.1"); } });
  cleanup.push(() => started.close());
  return { proxy: started, connected };
}

/** Send raw bytes to the proxy and collect what comes back until the reply is complete or the socket ends. */
async function exchange(url: string, request: string, then?: string): Promise<string> {
  const socket: Socket = url.startsWith("http:") ? connectTcp(Number(new URL(url).port), "127.0.0.1") : connectTcp(url);
  let received = "";
  return new Promise((settle) => {
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (then !== undefined && received.includes("\r\n\r\n") && received.startsWith("HTTP/1.1 200") && !received.includes(then)) {
        socket.write(then);
      } else if (then === undefined || received.includes(then) || !received.startsWith("HTTP/1.1 200")) {
        socket.end();
      }
    });
    socket.on("close", () => { settle(received); });
    socket.write(request);
  });
}

it("tunnels to an allowed destination, through the address it checked", async () => {
  const { proxy: started, connected } = await proxy(["registry.example.com:443"]);
  expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  const reply = await exchange(started.url, "CONNECT registry.example.com:443 HTTP/1.1\r\nHost: registry.example.com:443\r\n\r\n", "ping");
  expect(reply.startsWith("HTTP/1.1 200")).toBe(true);
  expect(reply).toContain("ping");
  expect(connected).toEqual(["93.184.215.14:443"]);
});

it("refuses what is not allowed, records it, and passes it once the operator allows it", async () => {
  const { proxy: started, connected } = await proxy(["registry.example.com:443"]);
  const before = new Date(Date.now() - 1_000);
  expect(await exchange(started.url, "CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/u);
  expect(await started.blockedSince(before)).toEqual(["example.org:443"]);
  expect(connected).toEqual([]);
  await started.allow(["example.org:443"]);
  expect((await exchange(started.url, "CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n", "x")).startsWith("HTTP/1.1 200"))
    .toBe(true);
  expect(await started.blockedSince(new Date())).toEqual([]);
});

it("never reaches the operator's own network, even for an allowed name, and does not ask about it", async () => {
  const { proxy: started, connected } = await proxy(["intranet.example.com:443"]);
  const before = new Date(Date.now() - 1_000);
  expect(await exchange(started.url, "CONNECT intranet.example.com:443 HTTP/1.1\r\nHost: intranet.example.com:443\r\n\r\n"))
    .toMatch(/^HTTP\/1\.1 403/u);
  expect(connected).toEqual([]);
  expect(await started.blockedSince(before)).toEqual([]);
});

it("refuses plain HTTP requests and malformed destinations, recording only real destinations", async () => {
  const { proxy: started } = await proxy([]);
  const before = new Date(Date.now() - 1_000);
  expect(await exchange(started.url, "GET http://example.org/ HTTP/1.1\r\nHost: example.org\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/u);
  expect(await exchange(started.url, "CONNECT not a host HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/u);
  expect(await started.blockedSince(before)).toEqual(["example.org:80"]);
});

// A Linux sandbox's network namespace reaches the proxy only through a socket bound into it (issue 163).
it.skipIf(process.platform === "win32")("listens on a Unix socket, with the same admission", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-proxy-"));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const { proxy: started, connected } = await proxy(["registry.example.com:443"], join(folder, "proxy.sock"));
  expect(started.url).toBe(join(folder, "proxy.sock"));
  expect((await exchange(started.url, "CONNECT registry.example.com:443 HTTP/1.1\r\n\r\n", "ping"))).toMatch(/^HTTP\/1\.1 200[^]*ping/u);
  expect(await exchange(started.url, "CONNECT example.org:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/u);
  expect(connected).toEqual(["93.184.215.14:443"]);
});
