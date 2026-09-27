import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { deviceCodeAuth, deviceCodeTerminalRenderer, loginToCodex } from "./integrations/codex-login.js";
import { TesotaCredentials } from "./integrations/tesota-credentials.js";

/**
 * `tesota auth` for each route (decisions 021 and 031). Tesota stores Codex's
 * OAuth login, an Anthropic API key, an OpenRouter key and one OpenCode key,
 * which Zen and Go share. It never holds a Claude subscription login: for the
 * `claude-code` route it runs Claude Code's own sign-in and status, and reads
 * only whether Claude Code is signed in and how.
 */

const routes = ["codex", "anthropic", "claude-code", "openrouter", "opencode"] as const;
type AuthRoute = typeof routes[number];

/** A route whose credential is a key the operator pastes: its name, Pi's provider, the key's environment variable, and where to get one. */
interface KeyRoute {
  readonly label: string;
  readonly provider: string;
  readonly variable: string;
  readonly source: string;
}

const keyRoutes: Readonly<Record<"anthropic" | "openrouter" | "opencode", KeyRoute>> = {
  anthropic: { label: "Anthropic API", provider: "anthropic", variable: "ANTHROPIC_API_KEY", source: "https://console.anthropic.com" },
  openrouter: { label: "OpenRouter", provider: "openrouter", variable: "OPENROUTER_API_KEY", source: "https://openrouter.ai/settings/keys" },
  opencode: { label: "OpenCode (Zen and Go)", provider: "opencode", variable: "OPENCODE_API_KEY", source: "https://opencode.ai/auth" },
};

/** The Claude Code program bundled with the Claude Agent SDK for this platform, unmodified. */
export function claudeCodeExecutable(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
  const executable = join(dirname(manifest), process.platform === "win32" ? "claude.exe" : "claude");
  if (!existsSync(executable)) throw new Error("Claude Code is not installed with Tesota for this platform");
  return executable;
}

/** What Claude Code says about its own sign-in, without any credential in it. */
export function claudeCodeStatus(output: string): string {
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null) return "Claude Code: status unavailable.";
  if (Reflect.get(value, "loggedIn") !== true) return "Claude Code: signed out. Run tesota auth login claude-code.";
  const method = Reflect.get(value, "authMethod");
  return `Claude Code: signed in${typeof method === "string" ? ` (${method})` : ""}. Tesota does not hold this login.`;
}

/** Read a line from the terminal without showing it; the value is never printed. */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (input.isTTY !== true || typeof input.setRawMode !== "function") throw new Error("An interactive terminal is required");
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((settle, fail) => {
    let value = "";
    const finish = (error?: Error): void => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
      if (error === undefined) settle(value); else fail(error);
    };
    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u0003") { finish(new Error("Cancelled")); return; }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}

async function codex(action: string, credentials: TesotaCredentials): Promise<number> {
  if (action === "status") {
    console.log(await credentials.read("openai-codex") !== undefined
      ? "Codex: saved login available. Model access is checked when used." : "Codex: logged out. Run tesota auth login.");
    return 0;
  }
  if (action === "logout") {
    const models = createModels({ credentials });
    models.setProvider(openaiCodexProvider());
    await models.logout("openai-codex");
    console.log("Codex: local Tesota credentials removed.");
    return 0;
  }
  if (await credentials.read("openai-codex") !== undefined) {
    console.log("Codex: already logged in. To change accounts, run tesota auth logout first.");
    return 0;
  }
  const cancel = new AbortController();
  const watchdog = setTimeout(() => process.exit(1), 185_000);
  try {
    if (await loginToCodex(deviceCodeAuth(deviceCodeTerminalRenderer(), cancel.signal), credentials) !== "succeeded") {
      throw new Error("Login did not complete");
    }
    console.log("Codex: login saved for future Tesota runs.");
    return 0;
  } finally { cancel.abort(); clearTimeout(watchdog); }
}

async function pastedKey(route: "anthropic" | "openrouter" | "opencode", action: string, credentials: TesotaCredentials): Promise<number> {
  const { label, provider, variable, source } = keyRoutes[route];
  if (action === "status") {
    const saved = await credentials.read(provider);
    const ambient = (process.env[variable] ?? "").length > 0;
    console.log(saved !== undefined ? `${label}: saved ${saved.type === "oauth" ? "key from your sign-in" : "key"} available.` : ambient
      ? `${label}: ${variable} is set; no key saved.` : `${label}: no key. Run tesota auth login ${route}.`);
    return 0;
  }
  if (action === "logout") {
    await credentials.delete(provider);
    console.log(`${label}: saved key removed.`);
    return 0;
  }
  console.log(`Create a key at ${source}.`);
  const key = (await readSecret(`${label} key (not shown): `)).trim();
  if (key.length === 0) { console.error("No key entered; nothing was saved."); return 1; }
  await credentials.modify(provider, async () => ({ type: "api_key", key }));
  console.log(`${label}: key saved for future Tesota runs.`);
  return 0;
}

async function claudeCode(action: string): Promise<number> {
  if (action === "logout") {
    console.log("Claude Code: Tesota does not hold this login, and signing out here would also sign out your own Claude " +
      "Code. Use claude auth logout if that is what you want.");
    return 0;
  }
  const executable = claudeCodeExecutable();
  if (action === "status") {
    const result = spawnSync(executable, ["auth", "status"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (result.status !== 0) { console.log("Claude Code: status unavailable."); return 1; }
    console.log(claudeCodeStatus(result.stdout));
    return 0;
  }
  // Anthropic's own sign-in, in the operator's terminal; nothing passes through Tesota.
  return new Promise((settle) => {
    const child = spawn(executable, ["auth", "login"], { stdio: "inherit" });
    child.once("error", () => { settle(1); });
    child.once("close", (code) => { settle(code ?? 1); });
  });
}

export async function runAuthCommand(action: string, route: string = "codex",
  credentials: TesotaCredentials = new TesotaCredentials()): Promise<number> {
  if (!["login", "status", "logout"].includes(action) || !(routes as readonly string[]).includes(route)) {
    console.error(`Usage: tesota auth <login|status|logout> [${routes.join("|")}]`);
    return 2;
  }
  try {
    switch (route as AuthRoute) {
      case "codex": return await codex(action, credentials);
      case "claude-code": return await claudeCode(action);
      case "anthropic": case "openrouter": case "opencode": return await pastedKey(route as "anthropic" | "openrouter" | "opencode",
        action, credentials);
    }
  } catch {
    console.error(`${route} authentication operation failed. Credentials were not printed. Check private storage or retry after resolving the failure.`);
    return 1;
  }
}
