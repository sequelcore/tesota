import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseJson } from "../../../src/json.ts";

/**
 * MCP servers as `mcp.json` configures them (#459), in the `mcpServers`
 * format Claude Code, Pi and Gemini CLI share, read as Pi reads it: a
 * `command` runs a local server, a `url` reaches a remote one over
 * streamable HTTP. Read without the MCP client, which loads only when a
 * server is configured.
 */

/** A server's `oauth` entry; every field optional. */
export interface McpOAuthConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** The loopback port of the redirect URI, `http://127.0.0.1:<port>/callback`, for a client registered with it. */
  readonly callbackPort?: number;
  /** A loopback redirect URI sent exactly as written; its port is used, or `callbackPort`, or a free one. */
  readonly callbackUrl?: string;
  /** Scopes to ask for, separated by spaces, for servers that do not say which they need. */
  readonly scope?: string;
  /** The name Tesota registers as; `tesota` when not given. */
  readonly clientName?: string;
}

interface Common {
  readonly name: string;
  /** The file it came from. */
  readonly source: string;
  readonly enabled: boolean;
  /** Seconds a request may take; progress the server reports restarts it. */
  readonly timeout: number;
}

export type McpServerConfig = Common & (
  | { readonly transport: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string }
  | { readonly transport: "http"; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly oauth?: McpOAuthConfig });

/** A project entry with no `command`, `url` or `type`: it only turns a server of the operator's on or off there. */
interface Override { readonly name: string; readonly source: string; readonly enabled: boolean }

export interface McpConfig {
  readonly servers: readonly McpServerConfig[];
  /** Entries left out, each saying why. */
  readonly errors: readonly string[];
}

const defaultTimeoutSeconds = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Server names whose `-` and `_` differ name one server: their tools would be named alike. */
const sameServer = (name: string): string => name.replaceAll("-", "_");

/** `${NAME}` replaced by the environment's value; one not set is an error naming it. */
function expanded(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name: string) => {
    const found = env[name];
    if (found === undefined) throw new Error(`the environment variable ${name} is not set`);
    return found;
  });
}

/** A leading `~/` names the operator's home. */
const homed = (value: string): string => value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

function texts(value: unknown, what: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${what} must be a list of text`);
  return value;
}

function textRecord(value: unknown, what: string, env: NodeJS.ProcessEnv): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${what} must be an object of text`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (typeof item !== "string") throw new Error(`${what}.${key} must be text`);
    return [key, expanded(item, env)];
  }));
}

const loopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Validates an `oauth` value, saying what is wrong. */
export function readOAuthConfig(value: unknown): McpOAuthConfig {
  if (!isRecord(value)) throw new Error("oauth must be an object");
  const read: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "callbackPort") {
      if (typeof field !== "number" || !Number.isInteger(field) || field < 1 || field > 65_535) throw new Error("oauth.callbackPort must be a port number");
    } else if (["clientId", "clientSecret", "callbackUrl", "scope", "clientName"].includes(key)) {
      if (typeof field !== "string" || field.trim() === "") throw new Error(`oauth.${key} must be text`);
    } else throw new Error(`oauth.${key} is not an OAuth setting Tesota reads`);
    read[key] = field;
  }
  if (typeof read["callbackUrl"] === "string") {
    let url: URL;
    try { url = new URL(read["callbackUrl"]); } catch { throw new Error("oauth.callbackUrl must be a URL"); }
    if (url.protocol !== "http:" || !loopback(url.hostname)) throw new Error("oauth.callbackUrl must be http on localhost, 127.0.0.1 or [::1]");
  }
  return read as McpOAuthConfig;
}

/** One entry, as a server or, from a project, an override; `cwd` is where a relative `cwd` starts. */
function entry(name: string, value: unknown, source: string, cwd: string, env: NodeJS.ProcessEnv): McpServerConfig | Override {
  if (!isRecord(value)) throw new Error("must be an object");
  const enabled = value["enabled"] ?? true;
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  const type = value["type"];
  if (type === "sse") throw new Error("the SSE transport is not supported; servers that offer it usually serve streamable HTTP at /mcp");
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") throw new Error("type must be stdio, http or streamable-http");
  const command = value["command"];
  const url = value["url"];
  if (type === undefined && command === undefined && url === undefined) return { name, source, enabled };
  const timeout = value["timeout"] ?? defaultTimeoutSeconds;
  if (typeof timeout !== "number" || !(timeout > 0)) throw new Error("timeout must be seconds");
  const common = { name, source, enabled, timeout };
  if (command !== undefined && url !== undefined) throw new Error("a server has a command or a url, not both");
  return type === "stdio" || (type === undefined && command !== undefined) ? local(common, value, cwd, env) : remote(common, value, env);
}

type Shared = Pick<McpServerConfig, "name" | "source" | "enabled" | "timeout">;

/** A local server: the program to run, its arguments, environment and folder. */
function local(common: Shared, value: Record<string, unknown>, cwd: string, env: NodeJS.ProcessEnv): McpServerConfig {
  const command = value["command"];
  if (typeof command !== "string" || command.trim() === "") throw new Error("command must be the program to run");
  const at = value["cwd"];
  if (at !== undefined && typeof at !== "string") throw new Error("cwd must be a folder");
  const folder = at === undefined ? cwd : homed(at);
  return { ...common, transport: "stdio", command: homed(command), args: texts(value["args"], "args").map(homed),
    env: textRecord(value["env"], "env", env), cwd: isAbsolute(folder) ? folder : join(cwd, folder) };
}

/** A remote server: its address, headers and sign-in. */
function remote(common: Shared, value: Record<string, unknown>, env: NodeJS.ProcessEnv): McpServerConfig {
  const url = value["url"];
  if (typeof url !== "string") throw new Error("url must be the server's address");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("url must be a URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("url must be http or https");
  const read = value["oauth"] === undefined ? undefined : readOAuthConfig(value["oauth"]);
  // A client secret is given as Pi documents it, from the environment: `"clientSecret": "${NAME}"`.
  const oauth = read?.clientSecret === undefined ? read : { ...read, clientSecret: expanded(read.clientSecret, env) };
  return { ...common, transport: "http", url, headers: textRecord(value["headers"], "headers", env), ...oauth === undefined ? {} : { oauth } };
}

/** The entries of the `mcp.json` at `path`; none when it does not exist; an unreadable file or entry is an error that leaves it out. */
function readFile(path: string, cwd: string, env: NodeJS.ProcessEnv, overrides: boolean): { entries: (McpServerConfig | Override)[]; errors: string[] } {
  if (!existsSync(path)) return { entries: [], errors: [] };
  let file: unknown;
  try { file = parseJson(readFileSync(path, "utf8")); } catch (error) {
    return { entries: [], errors: [`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const servers = isRecord(file) ? file["mcpServers"] ?? {} : undefined;
  if (!isRecord(servers)) return { entries: [], errors: [`${path}: mcpServers must be an object of servers`] };
  const entries: (McpServerConfig | Override)[] = [];
  const errors: string[] = [];
  for (const [name, value] of Object.entries(servers)) {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new Error("its name may hold only letters, digits, _ and -");
      const twin = entries.find((other) => sameServer(other.name) === sameServer(name));
      if (twin !== undefined) throw new Error(`it names the same server as "${twin.name}"`);
      const read = entry(name, value, path, cwd, env);
      if (!overrides && !("transport" in read)) throw new Error("it needs a command or a url");
      entries.push(read);
    } catch (error) {
      errors.push(`${path}: server "${name}" was left out: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, errors };
}

/**
 * The servers of the operator's `mcp.json` and the project's, in that order.
 * A project entry replaces the operator's of the same name; one with only
 * `enabled` turns the operator's on or off in the project and keeps the rest.
 */
export function readMcpConfig(own: string, project: string | undefined, cwd: string, env: NodeJS.ProcessEnv = process.env): McpConfig {
  const mine = readFile(own, cwd, env, false);
  const theirs = project === undefined ? { entries: [], errors: [] } : readFile(project, cwd, env, true);
  const servers = mine.entries.filter((server): server is McpServerConfig => "transport" in server);
  const errors = [...mine.errors, ...theirs.errors];
  for (const server of theirs.entries) {
    const at = servers.findIndex((other) => sameServer(other.name) === sameServer(server.name));
    if ("transport" in server) {
      if (at < 0) servers.push(server); else servers[at] = server;
    } else if (at < 0) errors.push(`${server.source}: server "${server.name}" was left out: it turns on or off a server you have not configured`);
    else {
      // Turning one of yours on runs it at the project's word, so it asks the project's trust; turning one off does not.
      const yours = servers[at] as McpServerConfig;
      servers[at] = { ...yours, enabled: server.enabled, ...server.enabled && !yours.enabled ? { source: server.source } : {} };
    }
  }
  return { servers, errors };
}

/** The project's servers that run its own commands, reach its own addresses or turn on yours, for its trust; turning yours off needs none. */
export function projectServers(config: McpConfig, project: string): readonly McpServerConfig[] {
  return config.servers.filter((server) => server.source === project);
}

/** Providers take tool names of at most 64 letters, digits, `_` and `-`. */
const maxName = 64;
const shortHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

/**
 * The model's names for the servers' tools, in order, as Claude Code, Codex
 * and Pi name them: `mcp__<server>__<tool>`, every character but letters,
 * digits and `_` made `_`. Tools whose names then collide, across all the
 * servers, or run past 64 characters, are told apart by a hash of their
 * server and tool.
 */
export function toolNames(tools: readonly { readonly server: string; readonly tool: string }[]): string[] {
  const plain = tools.map(({ server, tool }) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/gu, "_"));
  const counts = new Map<string, number>();
  for (const name of plain) counts.set(name, (counts.get(name) ?? 0) + 1);
  return plain.map((name, index) => {
    if (counts.get(name) === 1 && name.length <= maxName) return name;
    const { server, tool } = tools[index] ?? { server: "", tool: "" };
    return `${name.slice(0, maxName - 9)}_${shortHash(`${server}\0${tool}`)}`;
  });
}
