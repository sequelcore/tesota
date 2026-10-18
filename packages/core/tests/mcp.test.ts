import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hooks } from "../src/hooks.ts";
import type { McpTools } from "../src/loop.ts";
import { type McpServers, startMcp } from "../src/mcp.ts";
import { type McpServerConfig, projectServers, readMcpConfig, readOAuthConfig, toolNames } from "../src/mcp-config.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import type { EngineTool } from "../src/tool.ts";
import { startHttpMcp } from "./mcp-http-server.ts";
import { accepts, scriptedReply } from "./scripted.ts";
import type { ScriptStep } from "./engine.ts";

/** MCP servers (#459): their configuration, their tools' names, a real local and a real remote server, sign-in, and in a session. */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const serverScript = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
const spool = (): string => folder("tesota-core-mcp-spool-");

/** A local server entry as `readMcpConfig` gives it. */
const local = (name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ name, source: "test", enabled: true, timeout: 60,
  transport: "stdio", command: process.execPath, args: [serverScript], env: {}, cwd: tmpdir(), ...extra } as McpServerConfig);

const running: McpServers[] = [];
const started = (configs: readonly McpServerConfig[], options: { waitMs?: number; home?: string } = {}): McpServers => {
  const servers = startMcp(configs, { cwd: tmpdir(), ...options });
  running.push(servers);
  return servers;
};
afterEach(async () => { await Promise.all(running.splice(0).map((servers) => servers.close())); });

const ready = (servers: McpTools): Promise<void> => servers.ready(new AbortController().signal);
const tool = (servers: McpTools, name: string): EngineTool => {
  const found = servers.tools(spool).find((each) => each.name === name);
  if (found === undefined) throw new Error(`no tool ${name} in ${servers.tools(spool).map((each) => each.name).join(", ")}`);
  return found;
};
const call = (servers: McpTools, name: string, args: object = {}) => tool(servers, name).execute(args as never, new AbortController().signal, "c");

describe("reading mcp.json", () => {
  const write = (value: unknown): string => {
    const path = join(folder("tesota-core-mcp-config-"), "mcp.json");
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const cwd = join(tmpdir(), "project");

  test("a file that begins with a byte-order mark reads as any other (#470)", () => {
    const own = write(`\uFEFF${JSON.stringify({ mcpServers: { files: { command: "files" } } })}`);
    expect(readMcpConfig(own, undefined, cwd, {})).toMatchObject({ servers: [{ name: "files", command: "files" }], errors: [] });
  });

  test("local and remote servers, environment variables, the home folder and a relative folder", () => {
    const own = write({ mcpServers: {
      files: { command: "~/bin/files", args: ["~/data", "--x"], env: { TOKEN: "${MCP_TEST_TOKEN}" }, cwd: "sub", timeout: 5 },
      docs: { url: "https://example.test/mcp", headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}" }, enabled: false },
      issues: { type: "streamable-http", url: "https://example.test/issues", oauth: { clientId: "c", clientSecret: "${MCP_TEST_TOKEN}", callbackPort: 8765 } },
    } });
    const { servers, errors } = readMcpConfig(own, undefined, cwd, { MCP_TEST_TOKEN: "secret" });
    expect(errors).toEqual([]);
    expect(servers).toEqual([
      { name: "files", source: own, enabled: true, timeout: 5, transport: "stdio", command: join(homedir(), "bin/files"),
        args: [join(homedir(), "data"), "--x"], env: { TOKEN: "secret" }, cwd: join(cwd, "sub") },
      { name: "docs", source: own, enabled: false, timeout: 60, transport: "http", url: "https://example.test/mcp",
        headers: { Authorization: "Bearer secret" } },
      { name: "issues", source: own, enabled: true, timeout: 60, transport: "http", url: "https://example.test/issues", headers: {},
        oauth: { clientId: "c", clientSecret: "secret", callbackPort: 8765 } },
    ]);
  });

  test("an entry it cannot read is left out, saying why, and the others stay", () => {
    const own = write({ mcpServers: {
      good: { command: "x" },
      "bad name!": { command: "x" },
      "good-twin": { command: "x" },
      good_twin: { command: "y" },
      unset: { command: "x", env: { A: "${MCP_TEST_UNSET}" } },
      sse: { type: "sse", url: "https://example.test/sse" },
      both: { command: "x", url: "https://example.test" },
      ftp: { url: "ftp://example.test" },
      slow: { command: "x", timeout: 0 },
      nothing: {},
      oauth: { url: "https://example.test", oauth: { callbackUrl: "https://example.test/callback" } },
    } });
    const { servers, errors } = readMcpConfig(own, undefined, cwd, {});
    expect(servers.map(({ name }) => name)).toEqual(["good", "good-twin"]);
    for (const [name, why] of [["bad name!", "only letters, digits"], ["good_twin", 'same server as "good-twin"'],
      ["unset", "MCP_TEST_UNSET is not set"], ["sse", "SSE transport is not supported"], ["both", "not both"], ["ftp", "http or https"],
      ["slow", "timeout must be seconds"], ["nothing", "needs a command or a url"], ["oauth", "callbackUrl must be http on localhost"]]) {
      expect(errors.find((error) => error.includes(`"${name}"`))).toContain(why);
    }
    expect(readMcpConfig(write("{ not json"), undefined, cwd).errors[0]).toContain("is not JSON");
    expect(readMcpConfig(join(tmpdir(), "no-such", "mcp.json"), undefined, cwd)).toEqual({ servers: [], errors: [] });
  });

  test("a project entry replaces yours of the same name, one with only enabled turns yours on or off, and the project's own are added", () => {
    const own = write({ mcpServers: { a: { command: "mine" }, b: { command: "mine" }, c: { command: "mine", enabled: false } } });
    const project = write({ mcpServers: { a: { command: "theirs" }, b: { enabled: false }, c: { enabled: true }, d: { url: "https://example.test" },
      e: { enabled: true } } });
    const { servers, errors } = readMcpConfig(own, project, cwd);
    expect(servers.map(({ name, enabled, source }) => [name, enabled, source === project ? "project" : "own"])).toEqual([
      ["a", true, "project"], ["b", false, "own"], ["c", true, "project"], ["d", true, "project"]]);
    expect(servers[0]).toMatchObject({ command: "theirs" });
    expect(errors).toEqual([expect.stringContaining('"e" was left out: it turns on or off a server you have not configured')]);
    // Turning yours on runs it at the project's word: it is the project's for trust. Turning yours off is not.
    expect(projectServers({ servers, errors }, project).map(({ name }) => name)).toEqual(["a", "c", "d"]);
  });

  test("an oauth entry takes only the settings Tesota reads", () => {
    expect(readOAuthConfig({ clientId: "c", clientSecret: "s", callbackUrl: "http://localhost/cb", scope: "a b", clientName: "n" }))
      .toEqual({ clientId: "c", clientSecret: "s", callbackUrl: "http://localhost/cb", scope: "a b", clientName: "n" });
    expect(() => readOAuthConfig({ clientRegistration: "cimd" })).toThrow("not an OAuth setting");
    expect(() => readOAuthConfig({ callbackPort: 70_000 })).toThrow("port number");
    expect(() => readOAuthConfig("x")).toThrow("must be an object");
  });
});

describe("naming a server's tools", () => {
  test("as Claude Code, Codex and Pi do, within 64 characters, and apart when they would collide", () => {
    const mine = (tool: string) => ({ server: "my-server", tool });
    const [search, dotted, plain, long] = toolNames([mine("search"), mine("read.file"), mine("read_file"), mine("x".repeat(80))]);
    expect(search).toBe("mcp__my_server__search");
    expect(dotted).not.toBe(plain);
    for (const name of [dotted, plain, long]) {
      expect(name).toMatch(/^mcp__my_server__[A-Za-z0-9_]+$/u);
      expect(name?.length).toBeLessThanOrEqual(64);
    }
  });

  test("across servers: a long server name or a `__` inside a name never gives two tools one name", () => {
    const shared = "s".repeat(60);
    const names = toolNames([{ server: `${shared}a`, tool: "search" }, { server: `${shared}b`, tool: "search" },
      { server: "a__b", tool: "c" }, { server: "a", tool: "b__c" }]);
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("a local server", () => {
  test("its tools reach the model by their names; a failure, an image and a long result reach it as text", async () => {
    const servers = started([local("test")]);
    await ready(servers);
    expect(servers.status()).toEqual([{ name: "test", source: "test", transport: "stdio", state: "connected", tools: 11 }]);
    const echo = tool(servers, "mcp__test__echo");
    expect(echo.description).toBe("Says the text back.");
    expect(echo.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    expect(await call(servers, "mcp__test__echo", { text: "hi" })).toEqual({ text: "echo: hi", isError: false });
    expect(await call(servers, "mcp__test__fails")).toEqual({ text: "it went wrong", isError: true });
    expect((await call(servers, "mcp__test__image")).text).toBe("a picture:\n[An image (image/png) the model is not shown: Tesota's tool results carry text.]");
    const big = await call(servers, "mcp__test__big");
    expect(big.text).toContain("[Output truncated: showing the first 2000 of 3000 lines. Full output: ");
    const saved = /Full output: (.+)\]$/u.exec(big.text)?.[1] ?? "";
    expect(readFileSync(saved, "utf8").split("\n")).toHaveLength(3000);
  });

  test("a tool that says it only reads still counts as running something, since that is the server's word", async () => {
    const servers = started([local("test")]);
    await ready(servers);
    expect(tool(servers, "mcp__test__read_only").access).toBeUndefined();
  });

  test("runs in its folder with its environment added to the shell's", async () => {
    const at = folder("tesota-core-mcp-cwd-");
    const servers = started([local("test", { cwd: at, env: { TESOTA_MCP_TEST: "given" } } as Partial<McpServerConfig>)]);
    await ready(servers);
    const [where, env] = (await call(servers, "mcp__test__where")).text.split("|");
    // By real names: macOS reports its temporary folder as /private/var, and Windows CI's may be spelled RUNNER~1.
    expect(realpathSync.native(where ?? "").toLowerCase()).toBe(realpathSync.native(at).toLowerCase());
    expect(env).toBe("given");
  });

  test("a call past the server's time fails saying so; progress the server reports keeps a call going", async () => {
    const servers = started([local("test", { timeout: 1 })]);
    await ready(servers);
    const slow = call(servers, "mcp__test__slow", { ms: 5000 });
    expect(slow).rejects.toThrow('The MCP server "test" did not answer within 1 s.');
    await slow.catch(() => undefined);
    expect(await call(servers, "mcp__test__progress")).toEqual({ text: "done", isError: false });
  });

  test("a server that drops is connected again on its next call, and new tools it announces join", async () => {
    const servers = started([local("test")]);
    await ready(servers);
    await call(servers, "mcp__test__crash").catch(() => undefined);
    for (let tries = 0; servers.status()[0]?.state !== "disconnected" && tries < 100; tries++) await Bun.sleep(20);
    expect(servers.status()[0]).toMatchObject({ state: "disconnected", error: expect.stringContaining("test server started") });
    expect(await call(servers, "mcp__test__echo", { text: "back" })).toEqual({ text: "echo: back", isError: false });
    expect(servers.status()[0]?.state).toBe("connected");
    await call(servers, "mcp__test__grow");
    for (let tries = 0; servers.status()[0]?.tools !== 12 && tries < 100; tries++) await Bun.sleep(20);
    expect(servers.tools(spool).map(({ name }) => name)).toContain("mcp__test__late");
  });

  test("one that cannot start fails with why, a disabled one never starts, and the others work", async () => {
    const servers = started([local("test"), local("broken", { command: join(tmpdir(), "no-such-server.exe") }),
      local("off", { enabled: false })]);
    await ready(servers);
    expect(servers.status().map(({ name, state }) => [name, state])).toEqual([["test", "connected"], ["broken", "failed"], ["off", "disabled"]]);
    expect(servers.status()[1]?.error).toBeDefined();
    expect(servers.tools(spool).some(({ name }) => name.startsWith("mcp__broken__") || name.startsWith("mcp__off__"))).toBe(false);
    await expect(servers.reconnect("off")).resolves.toBeUndefined();
    expect(servers.status()[2]?.state).toBe("disabled");
  });

  test("a server's protocol error reaches the model within the output limit, and what a server wrote to its errors only the operator", async () => {
    const leaky = local("leaky", { args: ["-e", "process.stderr.write('token=hunter2'); process.exit(1)"] });
    const servers = started([local("test"), leaky]);
    await ready(servers);
    const loud = await call(servers, "mcp__test__loud").catch((error: unknown) => error as Error);
    expect(loud).toBeInstanceOf(Error);
    expect((loud as Error).message).toContain("[Output truncated: showing the first 2000 of 3000 lines. Full output: ");
    expect(servers.status()[1]?.error).toContain("token=hunter2");
    const told = await call(servers, "read_mcp_resource", { server: "leaky", uri: "mem://note" }).catch((error: unknown) => error as Error);
    expect((told as Error).message).toContain('The MCP server "leaky" is failed');
    expect((told as Error).message).not.toContain("hunter2");
  });

  test("a server that offers only resources connects, with no tools, and its resources are read", async () => {
    const servers = started([local("library", { env: { TESOTA_MCP_RESOURCES_ONLY: "1" } } as Partial<McpServerConfig>)]);
    await ready(servers);
    expect(servers.status()[0]).toMatchObject({ state: "connected", tools: 0 });
    expect(await call(servers, "read_mcp_resource", { server: "library", uri: "mem://note" })).toEqual({ text: "a note", isError: false });
  });

  test("a first request waits for a server still connecting only so long, and once", async () => {
    // A process that never answers: it connects for as long as its timeout.
    const silent = local("silent", { args: ["-e", "setInterval(() => {}, 1000)"], timeout: 30 });
    const servers = started([silent], { waitMs: 300 });
    const begun = Date.now();
    await ready(servers);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(250);
    expect(Date.now() - begun).toBeLessThan(5000);
    expect(servers.status()[0]?.state).toBe("connecting");
    const again = Date.now();
    await ready(servers);
    expect(Date.now() - again).toBeLessThan(50);
  });

  test("a request already stopped does not wait for a server still connecting", async () => {
    const servers = started([local("silent", { args: ["-e", "setInterval(() => {}, 1000)"] })], { waitMs: 500 });
    const stop = new AbortController();
    stop.abort();
    const begun = Date.now();
    await servers.ready(stop.signal);
    expect(Date.now() - begun).toBeLessThan(100);
    expect(servers.status()[0]?.state).toBe("connecting");
  });

  test("closing a server still connecting waits for its process to stop, without waiting out its request timeout", async () => {
    const pidFile = join(folder("tesota-core-mcp-opening-"), "pid");
    const servers = started([local("silent", {
      args: ["-e", "process.stdin.once('data', () => { require('node:fs').writeFileSync(process.env.TESOTA_MCP_PID, String(process.pid)); }); process.stdin.resume();"],
      env: { TESOTA_MCP_PID: pidFile },
    })]);
    // The child has received initialize but never answers it: close must stop a real connection in progress.
    for (let tries = 0; !existsSync(pidFile) && tries < 100; tries++) await Bun.sleep(20);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(servers.status()[0]?.state).toBe("connecting");
    const begun = Date.now();
    await servers.close();
    expect(Date.now() - begun).toBeLessThan(5000);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(servers.tools(spool)).toEqual([]);
    await servers.reconnect("silent");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(servers.status()[0]?.state).not.toBe("connected");
  });

  test("closing during a reconnect waits for the previous connection's release", async () => {
    const at = folder("tesota-core-mcp-reconnecting-");
    const pidFile = join(at, "pid");
    const closingFile = join(at, "closing");
    const servers = started([local("test", {
      args: ["-e", "await import(process.env.TESOTA_MCP_SERVER); process.stdin.removeAllListeners('end'); process.stdin.on('end', () => { require('node:fs').writeFileSync(process.env.TESOTA_MCP_CLOSING, 'closing'); }); require('node:fs').writeFileSync(process.env.TESOTA_MCP_PID, String(process.pid)); setInterval(() => {}, 1000);"],
      env: { TESOTA_MCP_SERVER: new URL("./mcp-server.mjs", import.meta.url).href, TESOTA_MCP_PID: pidFile, TESOTA_MCP_CLOSING: closingFile },
    })]);
    await ready(servers);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const reconnecting = servers.reconnect("test");
    // The old server ignores stdin closing. Its transport must finish stopping it before close returns.
    for (let tries = 0; !existsSync(closingFile) && tries < 100; tries++) await Bun.sleep(20);
    expect(existsSync(closingFile)).toBe(true);
    await servers.close();
    await reconnecting;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("its resources are listed, their templates too, and read: text as text, data saved to a file", async () => {
    const servers = started([local("test")]);
    await ready(servers);
    const listed = JSON.parse((await call(servers, "list_mcp_resources")).text) as { resources: { server: string; uri: string }[] };
    expect(listed.resources.map(({ server, uri }) => `${server} ${uri}`)).toEqual(["test mem://note", "test mem://blob"]);
    expect(JSON.parse((await call(servers, "list_mcp_resource_templates", { server: "test" })).text))
      .toEqual({ server: "test", resourceTemplates: [{ server: "test", uriTemplate: "mem://{name}", name: "any" }] });
    expect(await call(servers, "read_mcp_resource", { server: "test", uri: "mem://note" })).toEqual({ text: "a note", isError: false });
    const blob = (await call(servers, "read_mcp_resource", { server: "test", uri: "mem://blob" })).text;
    const file = /saved to (.+)\]$/u.exec(blob)?.[1] ?? "";
    expect([...readFileSync(file)]).toEqual([0, 1, 2]);
    expect(tool(servers, "read_mcp_resource").access).toBe("read");
    expect(call(servers, "list_mcp_resources", { cursor: "x" })).rejects.toThrow("name the server");
    expect(call(servers, "read_mcp_resource", { server: "none", uri: "x" })).rejects.toThrow('No MCP server is named "none"');
  });
});

describe("a remote server", () => {
  const remotes: { close: () => unknown }[] = [];
  afterEach(() => { for (const remote of remotes.splice(0)) remote.close(); });
  const remote = async (oauth: boolean) => {
    const server = await startHttpMcp({ oauth });
    remotes.push(server);
    return server;
  };
  const http = (name: string, url: string, extra: object = {}): McpServerConfig =>
    ({ name, source: "test", enabled: true, timeout: 10, transport: "http", url, headers: {}, ...extra } as McpServerConfig);
  /** The operator, in a browser: opens the sign-in page, which redirects to the loopback callback. */
  const browser = (page: URL): void => {
    void fetch(page, { redirect: "manual" }).then((answer) => fetch(answer.headers.get("location") ?? ""));
  };

  test("with its own Authorization header it connects without sign-in, and one it refuses failed", async () => {
    const server = await remote(false);
    const servers = started([http("keyed", server.url, { headers: { Authorization: "Bearer static" } }),
      http("wrong", server.url, { headers: { authorization: "Bearer other" } })]);
    await ready(servers);
    expect(servers.status().map(({ state }) => state)).toEqual(["connected", "failed"]);
    expect(await call(servers, "mcp__keyed__whoami")).toEqual({ text: "token static", isError: false });
  });

  test("with OAuth it needs a sign-in, which registers, uses PKCE, keeps the tokens by name and URL, refreshes them, and signing out forgets them", async () => {
    const server = await remote(true);
    const home = folder("tesota-core-mcp-home-");
    const servers = started([http("issues", server.url), http("other", server.url)], { home });
    await ready(servers);
    expect(servers.status().map(({ state }) => state)).toEqual(["needs sign-in", "needs sign-in"]);
    await servers.signIn("issues", browser, new AbortController().signal);
    expect(servers.status()[0]?.state).toBe("connected");
    expect(server.registrations[0]).toMatchObject({ client_name: "tesota" });
    expect(await call(servers, "mcp__issues__whoami")).toEqual({ text: "token access-1", isError: false });
    // Another name for the same URL is another account.
    await servers.reconnect("other");
    expect(servers.status()[1]?.state).toBe("needs sign-in");
    const stored = JSON.parse(readFileSync(join(home, "mcp-auth.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([`issues|${server.url}`]);
    // A refused token is refreshed once, and the call goes on.
    server.expire();
    expect(await call(servers, "mcp__issues__whoami")).toEqual({ text: "token access-2", isError: false });
    expect(server.log).toContain("token refresh");
    await servers.signOut("issues");
    expect(servers.status()[0]?.state).toBe("needs sign-in");
    expect(JSON.parse(readFileSync(join(home, "mcp-auth.json"), "utf8"))).toEqual({});
  });

  test("two shells refresh an expired token once between them, and each goes on with the new one", async () => {
    const server = await remote(true);
    const home = folder("tesota-core-mcp-home-");
    const first = started([http("issues", server.url)], { home });
    await ready(first);
    await first.signIn("issues", browser, new AbortController().signal);
    const second = started([http("issues", server.url)], { home });
    await ready(second);
    server.expire();
    const answers = await Promise.all([call(first, "mcp__issues__whoami"), call(second, "mcp__issues__whoami")]);
    expect(answers.map(({ text }) => text)).toEqual(["token access-2", "token access-2"]);
    expect(server.log.filter((line) => line === "token refresh")).toHaveLength(1);
  });

  test("a server that restarted and forgot the session is reached again on a new one", async () => {
    const server = await remote(false);
    const servers = started([http("keyed", server.url, { headers: { Authorization: "Bearer static" } })]);
    await ready(servers);
    expect(await call(servers, "mcp__keyed__whoami")).toEqual({ text: "token static", isError: false });
    server.restart();
    expect(await call(servers, "mcp__keyed__whoami")).toEqual({ text: "token static", isError: false });
    expect(server.log).toContain("404 session-1");
  });

  test("a configured client signs in without registering, with its secret", async () => {
    const server = await remote(true);
    const servers = started([http("issues", server.url, { oauth: { clientId: "mine", clientSecret: "s3cret" } })],
      { home: folder("tesota-core-mcp-home-") });
    await ready(servers);
    await servers.signIn("issues", browser, new AbortController().signal);
    expect(server.registrations).toEqual([]);
    expect(server.log).toContain("authorize mine");
    expect(server.log).toContain("token code mine with secret s3cret");
  });

  test("a sign-in stopped while it waits for the browser rejects, and a local server has none", async () => {
    const server = await remote(true);
    const servers = started([http("issues", server.url), local("test")], { home: folder("tesota-core-mcp-home-") });
    await ready(servers);
    const stop = new AbortController();
    const signing = servers.signIn("issues", () => { stop.abort(); }, stop.signal);
    expect(signing).rejects.toThrow("Sign-in cancelled.");
    await signing.catch(() => undefined);
    expect(servers.signIn("test", browser, new AbortController().signal)).rejects.toThrow("local server");
  });
});

describe("MCP tools in a session", () => {
  const open: EngineSession[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

  function session(steps: readonly ScriptStep[], servers: McpTools, extra: { mode?: "read" | "ask" | "full"; hooks?: Hooks } = {}) {
    const faux = fauxProvider();
    faux.setResponses(steps.map(scriptedReply));
    const models = createModels();
    models.setProvider(faux.provider);
    const created = createSession({ cwd: folder("tesota-core-mcp-cwd-"), folder: folder("tesota-core-mcp-sessions-"), models,
      model: faux.getModel(), verifier: accepts, mcp: () => servers,
      ...extra.mode === undefined ? {} : { permissions: { mode: () => extra.mode ?? "full", rules: [] } },
      ...extra.hooks === undefined ? {} : { hooks: () => extra.hooks ?? {} } });
    open.push(created);
    return created;
  }
  const results = (created: EngineSession) => created.messages().filter((message) => message.role === "toolResult")
    .map((message) => ({ text: message.text, isError: message.isError }));

  /** The tools the session last recorded as offered. */
  const offered = (created: EngineSession): string[] => {
    const last = readFileSync(created.file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as { type: string; names?: string[] })
      .findLast((entry) => entry.type === "active_tools");
    return last?.names ?? [];
  };

  test("the model is offered the servers' tools and calls them, and the session records them among its tools", async () => {
    const servers = started([local("test")]);
    const created = session([{ tool: "mcp__test__echo", args: { text: "from the model" } }, "done"], servers);
    await created.prompt("echo");
    expect(results(created)).toEqual([{ text: "echo: from the model", isError: false }]);
    expect(offered(created)).toEqual(expect.arrayContaining(["read", "mcp__test__echo", "read_mcp_resource"]));
  });

  test("read only refuses a server's tool, even one that says it only reads, and lets its resources be read", async () => {
    const servers = started([local("test")]);
    const created = session([{ calls: [{ tool: "mcp__test__read_only", args: {} },
      { tool: "read_mcp_resource", args: { server: "test", uri: "mem://note" } }] }, "done"], servers, { mode: "read" });
    await created.prompt("read");
    const [refused, read] = results(created);
    expect(refused?.isError).toBe(true);
    expect(read).toEqual({ text: "a note", isError: false });
  });

  test("a hook that matches a server's tools refuses them", async () => {
    const servers = started([local("test")]);
    const refuse = `"${process.execPath}" -e "process.stderr.write('no mcp'); process.exit(2)"`;
    const created = session([{ tool: "mcp__test__echo", args: { text: "x" } }, "done"], servers,
      { hooks: { PreToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command: refuse }] }] } });
    await created.prompt("echo");
    expect(results(created)).toEqual([{ text: "Not run: A hook refused it: no mcp", isError: true }]);
  });

  test("tools the servers withdraw are no longer offered, and a call to one is not found", async () => {
    const servers = started([local("test")]);
    const created = session(["looked", { tool: "mcp__test__echo", args: { text: "x" } }, "done"], servers);
    await created.prompt("look");
    expect(offered(created)).toContain("mcp__test__echo");
    await servers.close();
    await created.prompt("echo");
    expect(offered(created).some((name) => name.startsWith("mcp__") || name.endsWith("mcp_resource"))).toBe(false);
    expect(results(created)).toEqual([{ text: 'Tool "mcp__test__echo" not found.', isError: true }]);
  });
});
