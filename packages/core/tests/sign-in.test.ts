import { afterEach, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { resetCapabilitiesCache, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "./virtual-terminal.ts";
import { terminalSignIn } from "../src/shell/sign-in.ts";

afterEach(() => { resetCapabilitiesCache(); });

function terminal() {
  const input = new PassThrough();
  let ready = (): void => undefined;
  const prompted = new Promise<void>((resolve) => { ready = resolve; });
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) {
    if (chunk.toString().includes("> ")) ready();
    done();
  } }), { isTTY: true });
  const written: string[] = [];
  return { input, output, written, prompted, write: (text: string) => { written.push(text); } };
}

test("failed browser launch still shows one whole unframed OSC 8 URL and keeps provider instructions", async () => {
  setCapabilityOverrides({ hyperlinks: true });
  const io = terminal();
  const url = `https://example.test/authorize?scope=openid+profile+email+offline_access&state=${"x".repeat(160)}`;
  await terminalSignIn(async (auth) => {
    auth.notify({ type: "auth_url", url, instructions: "A browser window should open. Enter device code EXAMPLE." });
  }, { ...io, open: async () => { throw new Error("No desktop"); } });
  const text = io.written.join("");
  expect(text).toContain("Couldn't open a browser\n");
  expect(text.split("\n")[1]).toBe(`\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`);
  expect(text).not.toContain("▌");
  expect(text).not.toContain("A browser window should open");
  expect(text).toContain("Enter device code EXAMPLE.");
  expect(text).toContain("Ctrl+click the link or press c to copy it");
});

test("c copies while empty; a pasted redirect containing c still completes sign-in", async () => {
  setCapabilityOverrides({ hyperlinks: false });
  const io = terminal();
  const copied: string[] = [];
  const redirect = "http://localhost:1455/auth/callback?code=example-code&state=example";
  const result = terminalSignIn(async (auth) => {
    auth.notify({ type: "auth_url", url: "https://example.test/sign-in" });
    return await auth.prompt({ type: "text", message: "Paste redirect URL" });
  }, { ...io, open: async () => {}, copy: async (url) => {
    copied.push(url);
    queueMicrotask(() => { io.input.write(`\x1b[200~${redirect}\x1b[201~\r`); });
    return true;
  } });
  await io.prompted;
  io.input.write("c");
  expect(await result).toBe(redirect);
  expect(copied).toEqual(["https://example.test/sign-in"]);
  expect(io.written.join("")).toContain("Copied sign-in link.");
  expect(io.written.join("\n")).toContain("\nhttps://example.test/sign-in\n");
  expect(io.input.listenerCount("data")).toBe(0);
});


test("c remains text after the first character, and bracketed paste may start with c", async () => {
  const io = terminal();
  const copied: string[] = [];
  const result = terminalSignIn(async (auth) => {
    auth.notify({ type: "auth_url", url: "https://example.test/sign-in" });
    return await auth.prompt({ type: "text", message: "Paste code" });
  }, { ...io, open: async () => {}, copy: async (url) => { copied.push(url); return true; } });
  await io.prompted;
  io.input.write("a");
  io.input.write("c");
  io.input.write("\r");
  expect(await result).toBe("ac");
  expect(copied).toEqual([]);

  const second = terminal();
  const pasted = terminalSignIn(async (auth) => {
    auth.notify({ type: "auth_url", url: "https://example.test/sign-in" });
    return auth.prompt({ type: "text", message: "Paste code" });
  }, { ...second, open: async () => {}, copy: async () => { throw new Error("Must not copy paste"); } });
  await second.prompted;
  second.input.write("\x1b[200~");
  second.input.write("c");
  second.input.write("ode-example\x1b[201~\r");
  expect(await pasted).toBe("code-example");
});

test("Ctrl+C cancels sign-in rather than copying and releases terminal input", async () => {
  const io = terminal();
  const result = terminalSignIn(async (auth) => {
    auth.notify({ type: "auth_url", url: "https://example.test/sign-in" });
    return auth.prompt({ type: "text", message: "Paste redirect" });
  }, { ...io, open: async () => {} });
  await io.prompted;
  io.input.write("\x03");
  await expect(result).rejects.toThrow();
  expect(io.input.listenerCount("data")).toBe(0);
});


test.each(["file:///example.html", "ms-msdt:example", "search-ms:example", "not a URL"])("does not auto-open a non-web authorization endpoint: %s", async (url) => {
  const io = terminal();
  const opened: string[] = [];
  await terminalSignIn(async (_auth, show) => { show(url); }, { ...io, open: async (page) => { opened.push(page); } });
  expect(opened).toEqual([]);
  expect(io.written.join("")).toContain("Couldn't open a browser");
});

test("Ctrl+D cancels a redirect wait even without a paste prompt", async () => {
  const io = terminal();
  let displayed = (): void => undefined;
  const ready = new Promise<void>((resolve) => { displayed = resolve; });
  const result = terminalSignIn(async (_auth, show, signal) => {
    show("https://example.test/sign-in");
    await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => { reject(signal.reason); }, { once: true }); });
  }, { ...io, open: async () => {}, write: (text) => { io.write(text); displayed(); } });
  await ready;
  io.input.write("\x04");
  await expect(result).rejects.toThrow("Login cancelled");
  expect(io.input.listenerCount("data")).toBe(0);
});


test("shell terminal keyboard protocols still copy, type and submit", async () => {
  const terminal = new VirtualTerminal(100, 30);
  const copied: string[] = [];
  const result = terminalSignIn(async (auth) => {
    auth.notify({ type: "auth_url", url: "https://example.test/sign-in" });
    return auth.prompt({ type: "manual_code", message: "Paste code here" });
  }, { terminal, open: async () => {}, copy: async (url) => { copied.push(url); return true; } });
  await terminal.until("Paste code here");
  terminal.type("\x1b[99u");
  await terminal.until("Copied sign-in link.");
  terminal.type("\x1b[97u");
  terminal.type("\x1b[99u");
  terminal.type("\x1b[13u");
  expect(await result).toBe("ac");
  expect(copied).toEqual(["https://example.test/sign-in"]);
});
