// A local MCP server for the engine's MCP tests (#459), over stdio: JSON-RPC
// messages one per line. Its tools each show one behavior the client must
// handle; `crash` exits, so the next call must connect again.
let tools = [
  { name: "echo", description: "Says the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fails", inputSchema: { type: "object" } },
  { name: "slow", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "progress", inputSchema: { type: "object" } },
  { name: "crash", inputSchema: { type: "object" } },
  { name: "big", inputSchema: { type: "object" } },
  { name: "image", inputSchema: { type: "object" } },
  { name: "where", inputSchema: { type: "object" } },
  { name: "grow", inputSchema: { type: "object" } },
  { name: "read.only", description: "Says it only reads.", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
];
const resources = [
  { uri: "mem://note", name: "note", mimeType: "text/plain" },
  { uri: "mem://blob", name: "blob", mimeType: "application/octet-stream" },
];
const send = (message) => { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
const text = (value) => ({ content: [{ type: "text", text: value }] });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function answer(method, params) {
  if (method === "initialize") {
    return { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {} },
      serverInfo: { name: "test", version: "1.0.0" } };
  }
  if (method === "tools/list") return { tools };
  if (method === "resources/list") return { resources };
  if (method === "resources/templates/list") return { resourceTemplates: [{ uriTemplate: "mem://{name}", name: "any" }] };
  if (method === "resources/read") {
    if (params.uri === "mem://note") return { contents: [{ uri: params.uri, mimeType: "text/plain", text: "a note" }] };
    return { contents: [{ uri: params.uri, mimeType: "application/octet-stream", blob: Buffer.from([0, 1, 2]).toString("base64") }] };
  }
  if (method !== "tools/call") throw new Error(`no method ${method}`);
  return call(params);
}

async function call(params) {
  const args = params.arguments ?? {};
  switch (params.name) {
    case "echo": return text(`echo: ${args.text}`);
    case "fails": return { ...text("it went wrong"), isError: true };
    case "slow": await sleep(args.ms ?? 5000); return text("slept");
    case "progress": {
      const token = params._meta?.progressToken;
      // Longer than the test's one-second timeout in all, each step within it: progress keeps the call alive.
      for (let step = 1; step <= 3; step++) {
        await sleep(600);
        if (token !== undefined) send({ method: "notifications/progress", params: { progressToken: token, progress: step, total: 3 } });
      }
      return text("done");
    }
    case "crash": process.exit(1);
    case "big": return text(Array.from({ length: 3000 }, (_, line) => `line ${line + 1}`).join("\n"));
    case "image": return { content: [{ type: "text", text: "a picture:" }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
    case "where": return text(`${process.cwd()}|${process.env.TESOTA_MCP_TEST ?? ""}`);
    case "grow":
      tools = [...tools, { name: "late", inputSchema: { type: "object" } }];
      send({ method: "notifications/tools/list_changed" });
      return text("grown");
    case "read.only": return text("read");
    default: return { ...text(`no tool ${params.name}`), isError: true };
  }
}

process.stderr.write("test server started\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    if (message.id === undefined || message.method === undefined) continue;
    answer(message.method, message.params ?? {}).then(
      (result) => { send({ id: message.id, result }); },
      (error) => { send({ id: message.id, error: { code: -32601, message: error.message } }); });
  }
});
process.stdin.on("end", () => { process.exit(0); });
