import { createHash } from "node:crypto";

/**
 * A remote MCP server for the engine's MCP tests (#459), over streamable
 * HTTP at `/mcp`, with its own OAuth authorization server when `oauth`:
 * discovery, dynamic registration, PKCE and refresh. Adapted from Pi's
 * `test/suite/mcp-oauth-server.ts`. Without `oauth` it takes a request whose
 * `Authorization` header is `Bearer static`, and none other. It names
 * each session, and once restarted answers 404 to the old one, as a server
 * that restarted does.
 */
export interface HttpMcp {
  readonly url: string;
  /** What the server was asked, in order: refusals, registrations, authorizations, token requests and calls. */
  readonly log: string[];
  readonly registrations: Record<string, unknown>[];
  /** Every access token stops working, as when they expire. */
  expire(): void;
  /** The server forgets its sessions, as when it restarts. */
  restart(): void;
  /** The next refresh waits for `release` before it is answered; `arrived` settles once it is asked. */
  holdRefresh(): { readonly arrived: Promise<void>; release(): void };
  close(): void;
}

export async function startHttpMcp(options: { oauth?: boolean } = {}): Promise<HttpMcp> {
  const log: string[] = [];
  const registrations: Record<string, unknown>[] = [];
  const valid = new Set<string>();
  const refreshes = new Set<string>();
  const challenges = new Map<string, string>();
  let issued = 0;
  let origin = "";
  let session = 1;
  let held: { readonly arrive: () => void; readonly released: Promise<void> } | undefined;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const tokens = () => {
    issued++;
    valid.add(`access-${issued}`);
    refreshes.add(`refresh-${issued}`);
    return { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, token_type: "Bearer", expires_in: 3600 };
  };

  async function mcp(request: Request): Promise<Response> {
    const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
    if (request.method !== "POST") return new Response(null, { status: request.method === "GET" ? 405 : 200 });
    if (options.oauth === true ? token === undefined || !valid.has(token) : token !== "static") {
      log.push(`401 ${token ?? "none"}`);
      return new Response(null, { status: 401, headers: options.oauth === true
        ? { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } : {} });
    }
    const message = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string } };
    const said = request.headers.get("mcp-session-id");
    if (message.method !== "initialize" && said !== null && said !== `session-${session}`) {
      log.push(`404 ${said}`);
      return new Response(null, { status: 404 });
    }
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown = {};
    if (message.method === "initialize") {
      result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1.0.0" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }] };
    } else if (message.method === "tools/call") {
      log.push(`call ${token}`);
      result = { content: [{ type: "text", text: `token ${token}` }] };
    }
    return json({ jsonrpc: "2.0", id: message.id, result }, 200, { "mcp-session-id": `session-${session}` });
  }

  /** The operator approves at once: back to the client's redirect URI with a code tied to its PKCE challenge. */
  function authorize(url: URL): Response {
    const code = `code-${challenges.size + 1}`;
    challenges.set(code, url.searchParams.get("code_challenge") ?? "");
    log.push(`authorize ${url.searchParams.get("client_id") ?? ""}`);
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    return new Response(null, { status: 302, headers: { location: redirect.href } });
  }

  /** A code for tokens, its PKCE verifier checked, or a refresh token for new ones, each used once. */
  async function token(request: Request): Promise<Response> {
    const params = new URLSearchParams(await request.text());
    if (params.get("grant_type") === "authorization_code") {
      const challenge = challenges.get(params.get("code") ?? "");
      const verified = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
      if (challenge === undefined || challenge !== verified) return json({ error: "invalid_grant" }, 400);
      challenges.delete(params.get("code") ?? "");
      log.push(`token code ${params.get("client_id") ?? ""}${params.has("client_secret") ? ` with secret ${params.get("client_secret") ?? ""}` : ""}`);
      return json(tokens());
    }
    if (!refreshes.delete(params.get("refresh_token") ?? "")) {
      log.push("token refresh refused");
      return json({ error: "invalid_grant" }, 400);
    }
    const hold = held;
    held = undefined;
    if (hold !== undefined) { hold.arrive(); await hold.released; }
    log.push("token refresh");
    return json(tokens());
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/mcp": return mcp(request);
      case "/.well-known/oauth-protected-resource/mcp": return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      case "/.well-known/oauth-authorization-server":
        return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"] });
      case "/register": {
        const metadata = await request.json() as Record<string, unknown>;
        log.push("register");
        registrations.push(metadata);
        return json({ ...metadata, client_id: "client-1" }, 201);
      }
      case "/authorize": return authorize(url);
      case "/token": return token(request);
      default: return new Response(null, { status: 404 });
    }
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    url: `${origin}/mcp`,
    log,
    registrations,
    expire: () => { valid.clear(); },
    restart: () => { session++; },
    holdRefresh: () => {
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      held = { arrive: arrived.resolve, released: released.promise };
      return { arrived: arrived.promise, release: released.resolve };
    },
    close: () => { void server.stop(true); },
  };
}
