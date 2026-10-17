import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CallToolResult, McpClient, type McpTransport, McpTimeoutError, type ReadResourceResult, StdioTransport,
  StreamableHttpTransport, type Tool, toLlmContent,
} from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import manifest from "../package.json" with { type: "json" };
import type { McpTools } from "./loop.ts";
import { needsSignIn, signIn, signOut, storedAuth } from "./mcp-auth.ts";
import { type McpServerConfig, toolNames } from "./mcp-config.ts";
import type { EngineTool, ToolOutput } from "./tool.ts";
import { keepHead } from "./truncate.ts";

/**
 * The MCP servers a shell runs (#459), on Pi's MCP client: each connects in
 * the background as the shell starts, and its tools reach the model as
 * `mcp__<server>__<tool>`, with the resource tools Codex, OpenCode and Pi
 * add. A first request waits up to 10 s for the servers still connecting;
 * one that connects later offers its tools from the next request. A dropped
 * server reconnects on its next call.
 */

/** Where a server stands, as `/mcp` shows it. */
export type McpState = "connecting" | "connected" | "disconnected" | "failed" | "needs sign-in" | "disabled";

export interface McpStatus {
  readonly name: string;
  readonly source: string;
  readonly transport: "stdio" | "http";
  readonly state: McpState;
  readonly tools: number;
  /** Why it failed, and the end of what a local server wrote to its error output. */
  readonly error?: string;
}

/** What the shell does with the servers, besides what sessions call. */
export interface McpServers extends McpTools {
  status(): McpStatus[];
  reconnect(name: string): Promise<void>;
  /** Signs in to a remote server, `open` showing the operator the page, then connects it again. */
  signIn(name: string, open: (page: URL) => void, signal: AbortSignal): Promise<void>;
  signOut(name: string): Promise<void>;
  close(): Promise<void>;
}

export interface McpOptions {
  /** The folder the servers serve: their root, and where a local server runs unless its entry says. */
  readonly cwd: string;
  /** Where sign-ins are kept; Tesota's home when not given. */
  readonly home?: string;
  /** How long a first request waits for servers still connecting; 10 s when not given, as Pi waits. */
  readonly waitMs?: number;
}

interface Server {
  readonly config: McpServerConfig;
  state: McpState;
  error?: string;
  client?: McpClient;
  /** The client still connecting, which closing stops rather than waiting out its timeout. */
  opening?: McpClient;
  tools: Tool[];
  /** Whether it offers resources, as it said when it last connected. */
  resources: boolean;
  /** The connection being made, which a call or `/mcp` waits for rather than starting another. */
  connecting?: Promise<void>;
}

/** The end of what a local server wrote to its error output, for `/mcp`. */
const stderrTail = (transport: McpTransport | undefined): string => {
  const text = transport instanceof StdioTransport ? transport.stderr.trim() : "";
  return text === "" ? "" : `\n${text.split("\n").slice(-5).join("\n")}`;
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Whether a header named `Authorization` is set, in any case: OAuth then stays out. */
const authorized = (headers: Readonly<Record<string, string>>): boolean => Object.keys(headers).some((key) => key.toLowerCase() === "authorization");

/** The model's text of a result: text as it came, images and other blocks named, within the tool output limit, the whole saved when cut. */
function resultText(text: string, spool: () => string, saved: string): string {
  const kept = keepHead(text.split("\n"));
  if (!kept.truncated) return text;
  const file = join(spool(), saved);
  writeFileSync(file, text);
  return `${kept.text}\n\n[Output truncated: showing the first ${kept.lines} of ${kept.total} lines. Full output: ${file}]`;
}

function callText(result: CallToolResult): string {
  return toLlmContent(result).map((part) => part.type === "text" ? part.text
    : `[An image (${part.mimeType}) the model is not shown: Tesota's tool results carry text.]`).join("\n");
}

function resourceText(result: ReadResourceResult, spool: () => string, saved: string): string {
  return result.contents.map((content, index) => {
    if ("text" in content && typeof content.text === "string") return content.text;
    if ("blob" in content && typeof content.blob === "string") {
      const file = join(spool(), `${saved}-${index}`);
      writeFileSync(file, Buffer.from(content.blob, "base64"));
      return `[${content.mimeType ?? "Binary"} content of ${content.uri}, saved to ${file}]`;
    }
    return `[Content of ${content.uri} with neither text nor data]`;
  }).join("\n\n");
}

/** Starts the configured servers that are enabled, each in the background. */
export function startMcp(configs: readonly McpServerConfig[], options: McpOptions): McpServers {
  const servers: Server[] = configs.map((config) => ({ config, state: config.enabled ? "connecting" : "disabled", tools: [], resources: false }));
  const started = Date.now();
  const waitMs = options.waitMs ?? 10_000;
  let outputs = 0;
  let closing = false;

  function transportFor(config: McpServerConfig): McpTransport {
    if (config.transport === "stdio") {
      return new StdioTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...config.env }, inheritEnv: true });
    }
    const auth = authorized(config.headers) ? {} : { authProvider: storedAuth(config.name, config.url, config.oauth ?? {}, options.home) };
    return new StreamableHttpTransport({ url: config.url, headers: { ...config.headers }, ...auth });
  }

  /** Connects `server` and lists its tools; a failure is its state, never thrown. */
  function connect(server: Server): Promise<void> {
    server.connecting ??= (async () => {
      await server.client?.close().catch(() => undefined);
      const client = new McpClient({ name: "tesota", version: manifest.version, requestTimeoutMs: server.config.timeout * 1000,
        roots: [{ uri: pathToFileURL(options.cwd).href, name: basename(options.cwd) }] });
      const transport = transportFor(server.config);
      server.state = "connecting";
      delete server.error;
      server.opening = client;
      try {
        if (closing) throw new Error("The MCP servers are closing.");
        await client.connect(transport);
        server.tools = await client.listTools();
        server.resources = client.serverCapabilities?.resources !== undefined;
      } catch (error) {
        await client.close().catch(() => undefined);
        // A server given its own Authorization header is not signed in to: refused, it failed.
        const signs = server.config.transport === "http" && !authorized(server.config.headers);
        server.state = signs && needsSignIn(error) ? "needs sign-in" : "failed";
        server.error = `${message(error)}${stderrTail(transport)}`;
        return;
      } finally {
        delete server.opening;
      }
      if (closing) { await client.close().catch(() => undefined); return; }
      server.client = client;
      server.state = "connected";
      client.onNotification("notifications/tools/list_changed", () => {
        void client.listTools().then((tools) => { if (server.client === client) server.tools = tools; }, () => undefined);
      });
      client.onClose(() => {
        if (server.client !== client) return;
        delete server.client;
        if (server.state === "connected") {
          server.state = "disconnected";
          server.error = `The connection closed.${stderrTail(transport)}`;
        }
      });
    })().finally(() => { delete server.connecting; });
    return server.connecting;
  }

  /** A connected client for `server`, connecting it again when it dropped; an error saying why when it cannot. */
  async function clientOf(server: Server): Promise<McpClient> {
    if (server.client === undefined && server.state !== "disabled") await connect(server);
    if (server.client === undefined) throw new Error(`The MCP server "${server.config.name}" is ${server.state}${server.error === undefined ? "" : `: ${server.error}`}`);
    return server.client;
  }

  const initial = Promise.allSettled(servers.filter((server) => server.config.enabled).map(connect));
  const reachable = (): Server[] => servers.filter((server) => server.state === "connected" || server.state === "disconnected");

  function serverTools(server: Server, spool: () => string): EngineTool[] {
    const names = toolNames(server.config.name, server.tools.map((tool) => tool.name));
    return server.tools.map((tool) => ({
      name: names.get(tool.name) ?? tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      // Providers ask for an object schema, and some for one with `properties`.
      parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema["properties"] ?? {} }),
      // What the tool says it does is the server's word: it runs, for permissions, whatever its annotations say.
      execute: async (args, signal): Promise<ToolOutput> => {
        const client = await clientOf(server);
        let result: CallToolResult;
        try {
          result = await client.callTool(tool.name, args as Record<string, unknown>,
            { signal, timeoutMs: server.config.timeout * 1000, onProgress: () => undefined });
        } catch (error) {
          if (error instanceof McpTimeoutError) throw new Error(`The MCP server "${server.config.name}" did not answer within ${server.config.timeout} s.`, { cause: error });
          throw error;
        }
        return { text: resultText(callText(result), spool, `mcp-${++outputs}.txt`), isError: result.isError === true };
      },
    }));
  }

  /** The servers with resources, one named, or every one. */
  function withResources(name: string | undefined): Server[] {
    const offering = reachable().filter((server) => server.resources);
    if (name === undefined) return offering;
    const named = servers.find((server) => server.config.name === name);
    if (named === undefined) throw new Error(`No MCP server is named "${name}".`);
    return [named];
  }

  const listing = Type.Object({
    server: Type.Optional(Type.String({ description: "One server's name; every server's when not given." })),
    cursor: Type.Optional(Type.String({ description: "Where the server's last page ended (`nextCursor`); needs `server`." })),
  });

  /** The resource tools Codex, OpenCode and Pi add (#459), while a server offers resources; they only read. */
  function resourceTools(spool: () => string): EngineTool[] {
    if (withResources(undefined).length === 0) return [];
    const pages = (what: "resources" | "resourceTemplates") => async ({ server, cursor }: { server?: string; cursor?: string }): Promise<ToolOutput> => {
      if (cursor !== undefined && server === undefined) throw new Error("A cursor continues one server's list: name the server.");
      const listed: Record<string, unknown>[] = [];
      let next: string | undefined;
      for (const each of withResources(server)) {
        const client = await clientOf(each);
        const page = what === "resources" ? await client.listResourcesPage(cursor) : await client.listResourceTemplatesPage(cursor);
        const items = what === "resources" ? (page as { resources: object[] }).resources : (page as { resourceTemplates: object[] }).resourceTemplates;
        listed.push(...items.map((item) => ({ server: each.config.name, ...item })));
        if (server !== undefined) next = page.nextCursor;
      }
      return { text: resultText(JSON.stringify({ ...server === undefined ? {} : { server }, [what]: listed,
        ...next === undefined ? {} : { nextCursor: next } }, null, 2), spool, `mcp-${++outputs}.txt`), isError: false };
    };
    return [
      { name: "list_mcp_resources", access: "read", parameters: listing,
        description: "Lists the resources the MCP servers offer: each one's server, uri and name. Read one with read_mcp_resource.",
        execute: pages("resources") },
      { name: "list_mcp_resource_templates", access: "read", parameters: listing,
        description: "Lists the URI templates of resources the MCP servers do not list one by one.",
        execute: pages("resourceTemplates") },
      { name: "read_mcp_resource", access: "read",
        parameters: Type.Object({ server: Type.String({ description: "The server's name." }), uri: Type.String({ description: "The resource's URI." }) }),
        description: "Reads one resource of an MCP server by its server and uri.",
        execute: async ({ server, uri }) => {
          const [named] = withResources(server);
          if (named === undefined) throw new Error(`No MCP server is named "${server}".`);
          const read = await (await clientOf(named)).readResource(uri);
          return { text: resultText(resourceText(read, spool, `mcp-${++outputs}`), spool, `mcp-${++outputs}.txt`), isError: false };
        } },
    ] as EngineTool[];
  }

  const find = (name: string): Server => {
    const server = servers.find((each) => each.config.name === name);
    if (server === undefined) throw new Error(`No MCP server is named "${name}".`);
    return server;
  };

  return {
    // Closed, they offer nothing: a session still running then calls none of them.
    tools: (spool) => closing ? [] : [...reachable().flatMap((server) => serverTools(server, spool)), ...resourceTools(spool)],
    async ready(signal) {
      const left = started + waitMs - Date.now();
      if (left <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      await Promise.race([initial, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
        stop = resolve;
        signal.addEventListener("abort", stop, { once: true });
      })]);
      clearTimeout(timer);
      if (stop !== undefined) signal.removeEventListener("abort", stop);
    },
    status: () => servers.map((server) => ({ name: server.config.name, source: server.config.source, transport: server.config.transport,
      state: server.state, tools: server.tools.length, ...server.error === undefined ? {} : { error: server.error } })),
    reconnect: async (name) => {
      const server = find(name);
      if (server.state === "disabled") return;
      await server.connecting;
      await connect(server);
    },
    signIn: async (name, open, signal) => {
      const { config } = find(name);
      if (config.transport !== "http") throw new Error(`"${name}" is a local server: it has no sign-in.`);
      await signIn(name, config.url, config.oauth ?? {}, open, signal, options.home);
      await connect(find(name));
    },
    signOut: async (name) => {
      const server = find(name);
      if (server.config.transport !== "http") throw new Error(`"${name}" is a local server: it has no sign-in.`);
      signOut(name, server.config.url, options.home);
      const client = server.client;
      delete server.client;
      await client?.close().catch(() => undefined);
      server.tools = [];
      server.state = "needs sign-in";
      delete server.error;
    },
    close: async () => {
      closing = true;
      await Promise.all(servers.map(async (server) => {
        await server.opening?.close().catch(() => undefined);
        await server.connecting?.catch(() => undefined);
        const client = server.client;
        delete server.client;
        await client?.close().catch(() => undefined);
      }));
    },
  };
}
