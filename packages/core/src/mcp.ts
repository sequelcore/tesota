import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CallToolResult, type ListResourcesResult, type ListResourceTemplatesResult, McpClient, McpSessionExpiredError, type McpTransport, McpTimeoutError, type ReadResourceResult, StdioTransport,
  StreamableHttpTransport, type Tool, toLlmContent,
} from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import manifest from "../package.json" with { type: "json" };
import type { McpTools } from "./loop.ts";
import { needsSignIn, signIn, signOut, type StoredAuth, storedAuth } from "./mcp-auth.ts";
import { type McpServerConfig, toolNames } from "./mcp-config.ts";
import type { EngineTool, ToolOutput } from "./tool.ts";
import { keepHead } from "./truncate.ts";

/**
 * The MCP servers of one workspace (#459), on Pi's MCP client: each connects
 * in the background as they start, and its tools reach the model as
 * `mcp__<server>__<tool>`, with the resource tools Codex, OpenCode and Pi
 * add. A first request waits up to 10 s for the servers still connecting;
 * one that connects later offers its tools from the next request. A dropped
 * server reconnects on its next call, an expired HTTP session at once.
 */

/** Where a server stands, as `/mcp` shows it. */
export type McpState = "connecting" | "connected" | "disconnected" | "failed" | "needs sign-in" | "disabled";

export interface McpStatus {
  readonly name: string;
  readonly source: string;
  readonly transport: "stdio" | "http";
  readonly state: McpState;
  readonly tools: number;
  /** Why it failed, and the end of what a local server wrote to its error output; for the operator only. */
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
  /** Its stored credentials, one for every connection, so a refresh is never sent twice. */
  readonly auth?: StoredAuth;
  state: McpState;
  /** Why it failed or dropped: what the model may be told. */
  error?: string;
  /** The end of what a local server wrote to its error output, which may hold anything it was given: the operator's only. */
  stderr?: string;
  client?: McpClient;
  /** The client still connecting, which closing stops rather than waiting out its timeout. */
  opening?: McpClient;
  tools: Tool[];
  /** Whether it offers resources, as it said when it last connected. */
  resources: boolean;
  /** The connection being made, which a call or `/mcp` waits for rather than starting another. */
  connecting?: Promise<void>;
}

/** The end of what a local server wrote to its error output. */
const stderrTail = (transport: McpTransport): string | undefined => {
  const text = transport instanceof StdioTransport ? transport.stderr.trim() : "";
  return text === "" ? undefined : text.split("\n").slice(-5).join("\n");
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Whether a header named `Authorization` is set, in any case: OAuth then stays out. */
const authorized = (headers: Readonly<Record<string, string>>): boolean => Object.keys(headers).some((key) => key.toLowerCase() === "authorization");

/** The model's text, within the tool output limit, the whole saved when cut. */
function resultText(text: string, spool: () => string, saved: string): string {
  const kept = keepHead(text.split("\n"));
  if (!kept.truncated) return text;
  const file = join(spool(), saved);
  writeFileSync(file, text);
  return `${kept.text}\n\n[Output truncated: showing the first ${kept.lines} of ${kept.total} lines. Full output: ${file}]`;
}

/** A result's text as it came, images and other blocks named. */
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
  const servers: Server[] = configs.map((config) => ({ config, state: config.enabled ? "connecting" : "disabled", tools: [], resources: false,
    ...config.transport === "http" && !authorized(config.headers)
      ? { auth: storedAuth(config.name, config.url, config.oauth ?? {}, options.home) } : {} }));
  const started = Date.now();
  const waitMs = options.waitMs ?? 10_000;
  let outputs = 0;
  let closing = false;

  function transportFor(server: Server): McpTransport {
    const { config } = server;
    if (config.transport === "stdio") {
      return new StdioTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...config.env }, inheritEnv: true });
    }
    return new StreamableHttpTransport({ url: config.url, headers: { ...config.headers }, ...server.auth === undefined ? {} : { authProvider: server.auth } });
  }

  /** Connects `server` and lists its tools; a failure is its state, never thrown. */
  function connect(server: Server): Promise<void> {
    server.connecting ??= (async () => {
      await server.client?.close().catch(() => undefined);
      const client = new McpClient({ name: "tesota", version: manifest.version, requestTimeoutMs: server.config.timeout * 1000,
        roots: [{ uri: pathToFileURL(options.cwd).href, name: basename(options.cwd) }] });
      const transport = transportFor(server);
      server.state = "connecting";
      delete server.error;
      delete server.stderr;
      server.opening = client;
      // Heard before the first list, so a change announced right after it is not missed.
      client.onNotification("notifications/tools/list_changed", () => {
        void client.listTools().then((tools) => { if (server.client === client || server.opening === client) server.tools = tools; }, () => undefined);
      });
      try {
        if (closing) throw new Error("The MCP servers are closing.");
        await client.connect(transport);
        // A server may offer only resources, and answer no tools list.
        server.tools = client.serverCapabilities?.tools === undefined ? [] : await client.listTools();
        server.resources = client.serverCapabilities?.resources !== undefined;
      } catch (error) {
        await client.close().catch(() => undefined);
        server.state = server.auth !== undefined && needsSignIn(error) ? "needs sign-in" : "failed";
        server.error = message(error);
        const tail = stderrTail(transport);
        if (tail !== undefined) server.stderr = tail;
        return;
      } finally {
        delete server.opening;
      }
      if (closing) { await client.close().catch(() => undefined); return; }
      server.client = client;
      server.state = "connected";
      client.onClose(() => {
        if (server.client !== client) return;
        delete server.client;
        if (server.state !== "connected") return;
        server.state = "disconnected";
        server.error = "The connection closed.";
        const tail = stderrTail(transport);
        if (tail !== undefined) server.stderr = tail;
      });
    })().finally(() => { delete server.connecting; });
    return server.connecting;
  }

  /** A connected client for `server`, connecting it again when it dropped; an error the model may read when it cannot. */
  async function clientOf(server: Server): Promise<McpClient> {
    if (server.client === undefined && server.state !== "disabled") await connect(server);
    if (server.client === undefined) throw new Error(`The MCP server "${server.config.name}" is ${server.state}${server.error === undefined ? "" : `: ${server.error}`}`);
    return server.client;
  }

  /**
   * Sends a request on `server`'s connection; one whose HTTP session the
   * server no longer knows, as after it restarted, is sent once more on a new
   * one. What fails reaches the model within the tool output limit.
   */
  async function request<Result>(server: Server, send: (client: McpClient) => Promise<Result>, spool: () => string): Promise<Result> {
    try {
      try {
        return await send(await clientOf(server));
      } catch (error) {
        if (!(error instanceof McpSessionExpiredError)) throw error;
        await connect(server);
        return await send(await clientOf(server));
      }
    } catch (error) {
      const said = error instanceof McpTimeoutError ? `The MCP server "${server.config.name}" did not answer within ${server.config.timeout} s.` : message(error);
      throw new Error(resultText(said, spool, `mcp-${++outputs}.txt`), { cause: error });
    }
  }

  const initial = Promise.allSettled(servers.filter((server) => server.config.enabled).map(connect));
  const reachable = (): Server[] => servers.filter((server) => server.state === "connected" || server.state === "disconnected");

  /** Every reachable server's tools, named apart across all of them. */
  function serverTools(spool: () => string): EngineTool[] {
    const offered = reachable().flatMap((server) => server.tools.map((tool) => ({ server, tool })));
    const names = toolNames(offered.map(({ server, tool }) => ({ server: server.config.name, tool: tool.name })));
    return offered.map(({ server, tool }, index) => ({
      name: names[index] ?? tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      // Providers ask for an object schema, and some for one with `properties`.
      parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema["properties"] ?? {} }),
      // What the tool says it does is the server's word: it runs, for permissions, whatever its annotations say.
      execute: async (args, signal): Promise<ToolOutput> => {
        const result = await request(server, (client) => client.callTool(tool.name, args as Record<string, unknown>,
          { signal, timeoutMs: server.config.timeout * 1000, onProgress: () => undefined }), spool);
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
    const pages = (what: "resources" | "resourceTemplates") =>
      async ({ server, cursor }: { server?: string; cursor?: string }, signal: AbortSignal): Promise<ToolOutput> => {
        if (cursor !== undefined && server === undefined) throw new Error("A cursor continues one server's list: name the server.");
        const listed: Record<string, unknown>[] = [];
        let next: string | undefined;
        for (const each of withResources(server)) {
          const page = await request<ListResourcesResult | ListResourceTemplatesResult>(each, (client) => what === "resources" ? client.listResourcesPage(cursor, { signal })
            : client.listResourceTemplatesPage(cursor, { signal }), spool);
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
        execute: async ({ server, uri }: { server: string; uri: string }, signal: AbortSignal) => {
          const [named] = withResources(server);
          if (named === undefined) throw new Error(`No MCP server is named "${server}".`);
          const read = await request(named, (client) => client.readResource(uri, { signal }), spool);
          return { text: resultText(resourceText(read, spool, `mcp-${++outputs}`), spool, `mcp-${++outputs}.txt`), isError: false };
        } },
    ] as EngineTool[];
  }

  const find = (name: string): Server => {
    const server = servers.find((each) => each.config.name === name);
    if (server === undefined) throw new Error(`No MCP server is named "${name}".`);
    return server;
  };

  /** Stops `server`'s connection, one still being made included. */
  async function disconnect(server: Server): Promise<void> {
    await server.opening?.close().catch(() => undefined);
    await server.connecting?.catch(() => undefined);
    const client = server.client;
    delete server.client;
    await client?.close().catch(() => undefined);
  }

  return {
    // Closed, they offer nothing: a session still running then calls none of them.
    tools: (spool) => closing ? [] : [...serverTools(spool), ...resourceTools(spool)],
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
    status: () => servers.map((server) => {
      const error = [server.error, server.stderr].filter((part) => part !== undefined).join("\n");
      return { name: server.config.name, source: server.config.source, transport: server.config.transport,
        state: server.state, tools: server.tools.length, ...error === "" ? {} : { error } };
    }),
    reconnect: async (name) => {
      const server = find(name);
      if (server.state === "disabled") return;
      await server.connecting;
      await connect(server);
    },
    signIn: async (name, open, signal) => {
      const server = find(name);
      const { config } = server;
      if (config.transport !== "http") throw new Error(`"${name}" is a local server: it has no sign-in.`);
      if (server.auth === undefined) throw new Error(`"${name}" is given its own Authorization header: it has no sign-in.`);
      await signIn(name, config.url, config.oauth ?? {}, open, signal, options.home, server.auth.challenge());
      await connect(server);
    },
    signOut: async (name) => {
      const server = find(name);
      if (server.config.transport !== "http") throw new Error(`"${name}" is a local server: it has no sign-in.`);
      // A connection or refresh under way finishes first, so nothing it saves outlives the sign-out.
      await disconnect(server);
      await server.auth?.settled();
      signOut(name, server.config.url, options.home);
      server.tools = [];
      server.state = "needs sign-in";
      delete server.error;
      delete server.stderr;
    },
    close: async () => {
      closing = true;
      await Promise.all(servers.map(async (server) => {
        await disconnect(server);
        // A refresh the server answered may have replaced the refresh token: it is saved before the shell exits.
        await server.auth?.settled();
      }));
    },
  };
}
