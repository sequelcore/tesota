import {
  createModels, fauxProvider, InMemoryCredentialStore, type MutableModels, type OAuthCredential,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { claudeCodeProvider } from "../src/providers/claude-code.ts";
import { readSettings, writeSettings } from "../src/settings.ts";
import { runApp } from "../src/shell/app.ts";
import type { ScriptStep } from "./engine.ts";
import { scriptedReply, signInWithChatGPT } from "./scripted.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * `tesota-core`'s commands (#444), typed into an emulated terminal as the
 * operator would, on a scripted provider and temporary settings and sessions.
 */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const enter = "\r";

/** A scripted model, and a provider that logs in by OAuth with a pasted code. */
function scripted(replies: readonly ScriptStep[]): { models: MutableModels; credentials: InMemoryCredentialStore } {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const faux = fauxProvider();
  faux.setResponses(replies.map(scriptedReply));
  models.setProvider(faux.provider);
  const oauth = fauxProvider();
  models.setProvider({ ...oauth.provider, id: "scripted-login", name: "Scripted login", auth: { oauth: {
    name: "Scripted OAuth",
    login: async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
      interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      return { type: "oauth", access: `token-${code}`, refresh: "r", expires: Date.now() + 3_600_000 };
    },
    refresh: (credential: OAuthCredential) => Promise.resolve(credential),
    toAuth: (credential: OAuthCredential) => Promise.resolve({ apiKey: credential.access }),
  } } } as never);
  const keyed = fauxProvider();
  models.setProvider({ ...keyed.provider, id: "scripted-key", name: "Scripted key", auth: { apiKey: {
    name: "Scripted API key",
    login: async (interaction: ProviderAuthInteraction) =>
      ({ type: "api_key" as const, key: await interaction.prompt({ type: "secret", message: "Paste the key" }) }),
    resolve: () => Promise.resolve(undefined),
  } } } as never);
  return { models, credentials };
}

/** The app in a temporary folder, its settings and sessions there too, once it has drawn its first frame. */
async function app(replies: readonly ScriptStep[] = [], { repository = false, mcp, projectMcp, skills = {}, served, model, claudeCode }:
  { repository?: boolean; mcp?: object; projectMcp?: object; skills?: Record<string, string>;
    /** Signed in to OpenAI with ChatGPT, which serves these models (#566), or whose list cannot be fetched. */
    served?: readonly string[] | "offline"; model?: string;
    /** Claude through Claude Code (#546), signed in there or not. */
    claudeCode?: "signed in" | "signed out" } = {}) {
  const terminal = new VirtualTerminal(100, 30);
  const { models, credentials } = scripted(replies);
  if (claudeCode !== undefined) {
    models.setProvider(claudeCodeProvider(anthropicProvider().getModels(), { signedIn: async () => claudeCode === "signed in" }));
  }
  const signOut = served === undefined ? () => undefined : await signInWithChatGPT(models, credentials, served);
  const settingsPath = join(folder("tesota-core-app-settings-"), "settings.json");
  if (model !== undefined) writeSettings({ model }, settingsPath);
  const sessions = folder("tesota-core-app-sessions-");
  const cwd = folder("tesota-core-app-");
  // Further sessions need a Git repository with a commit, for their own worktrees (#453).
  if (repository) {
    writeFileSync(join(cwd, "README.md"), "# App\n");
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]]) {
      spawnSync("git", args, { cwd });
    }
  }
  // The operator's MCP servers beside their settings, and the project's in its .tesota folder (#459).
  if (mcp !== undefined) writeFileSync(join(dirname(settingsPath), "mcp.json"), JSON.stringify(mcp));
  if (projectMcp !== undefined) {
    mkdirSync(join(cwd, ".tesota"));
    writeFileSync(join(cwd, ".tesota", "mcp.json"), JSON.stringify(projectMcp));
  }
  // The project's skills, by folder, each its SKILL.md (#540).
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(join(cwd, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", name, "SKILL.md"), content);
  }
  const running = runApp({ cwd, terminal, models, credentials, settingsPath, sessions }).finally(signOut);
  await terminal.until("tesota-core");
  return { terminal, credentials, settingsPath, sessions, running, cwd };
}

const send = (terminal: VirtualTerminal, text: string): void => { terminal.type(text); terminal.type(enter); };

test("a subagent shows under its call and in the dashboard (#525)", async () => {
  const { terminal, running } = await app([{ tool: "agent", args: { prompt: "say hi", description: "greet the operator", wait: true } },
    "hi from the child", "parent done"]);
  try {
    send(terminal, "/model");
    await terminal.until("Model"); terminal.type(enter); await terminal.until("Model: ");
    send(terminal, "delegate the greeting");
    await terminal.until("parent done");
    expect((await terminal.screen()).join("\n")).toMatch(/↳ agent · reads · faux\/[^ ]+ · depth 1 · completed/u);
    terminal.type("\x14"); await terminal.until("Sessions (2)");
    expect((await terminal.screen()).join("\n")).toContain("↳ greet the operator");
    terminal.type("\x1b"); await terminal.untilGone("Sessions");
  } finally {
    send(terminal, "/quit");
    await running;
  }
});

test("a native question remains waiting after reattachment and can close while hidden", async () => {
  const { terminal, running } = await app([{ tool: "ask_user", args: { questions: [{ question: "Choose a path.", options: [
    { label: "Small", description: "Use the small change." }, { label: "Full", description: "Use the complete change." },
  ] }] } }, "answered"], { repository: true });
  send(terminal, "/model");
  await terminal.until("Model"); terminal.type(enter); await terminal.until("Model: ");
  send(terminal, "Choose for this request.");
  await terminal.until("Submit answers");
  terminal.type("\x14"); await terminal.until("Sessions"); terminal.type("n");
  await terminal.untilGone("Submit answers");
  await terminal.until("1 session waits for you");
  terminal.type("\x14"); await terminal.until("Sessions"); terminal.type("\x1b[A"); terminal.type(enter);
  await terminal.until("Submit answers");
  terminal.type("\x14"); await terminal.until("Sessions"); terminal.type("\x1b[B"); terminal.type(enter);
  await terminal.untilGone("Submit answers");
  try {
    expect((await terminal.screen()).join("\n")).toContain("1 session waits for you");
    terminal.type("\x14"); await terminal.until("Sessions"); terminal.type("\x1b[B"); terminal.type("x");
    await terminal.until("Sessions (1)");
    terminal.type("\x1b"); await terminal.untilGone("Sessions");
    await terminal.until("Submit answers");
    terminal.type("1"); terminal.type("\t"); terminal.type("\t"); terminal.type(enter);
    await terminal.until("answered");
  } finally {
    send(terminal, "/quit");
    await running;
  }
});

test("a question arriving behind the dashboard waits until the dashboard gives focus back", async () => {
  const { terminal, running } = await app([{ tool: "ask_user", args: { questions: [{ question: "Choose after inspecting sessions.", options: [
    { label: "A", description: "First path." }, { label: "B", description: "Second path." },
  ] }] } }, "question dismissed"]);
  send(terminal, "/model"); await terminal.until("Model"); terminal.type(enter); await terminal.until("Model: ");
  send(terminal, "Ask me."); terminal.type("\x14");
  await terminal.until("Sessions"); await terminal.until("waiting for you");
  expect((await terminal.screen()).join("\n")).not.toContain("Submit answers");
  terminal.type("\x1b"); await terminal.untilGone("Sessions"); await terminal.until("Submit answers");
  terminal.type("\x1b"); await terminal.until("question dismissed");
  send(terminal, "/quit"); await running;
});

describe("tesota-core", () => {
  test("/ lists the commands with descriptions, and the list scrolls to /quit", async () => {
    const { terminal, running } = await app();
    try {
      terminal.type("/");
      expect(await terminal.until("Choose the model")).toMatch(/model\s+Choose the model/u);
      terminal.type("\x1b[A");
      expect(await terminal.until("End the shell")).toMatch(/quit\s+End the shell/u);
      terminal.type("\x03");
      terminal.type("/mcp");
      const screen = await terminal.until("Manage MCP servers");
      expect(screen).toContain("[login|logout|reconnect <server>]");
    } finally {
      terminal.type("\x03");
      send(terminal, "/quit");
      await running;
    }
  });

  test("/res narrows to /resume and Tab leaves the completed command in the input", async () => {
    const { terminal, running } = await app();
    try {
      terminal.type("/");
      await terminal.until("Choose the model");
      terminal.type("res");
      const screen = await terminal.until("Open an earlier session");
      expect(screen).toMatch(/resume\s+Open an earlier session/u);
      expect(screen).not.toContain("Choose the model");
      expect(screen).not.toContain("End the shell");
      terminal.type("\t");
      expect(await terminal.untilGone("Open an earlier session")).toContain("/resume");
      terminal.type(enter);
      await terminal.until("No other session in this folder.");
    } finally {
      terminal.type("\x03");
      send(terminal, "/quit");
      await running;
    }
  });

  test("Enter on a slash suggestion completes and runs it, then the dialog takes the keyboard", async () => {
    const { terminal, running } = await app();
    try {
      terminal.type("/mod");
      await terminal.until("Choose the model");
      terminal.type(enter);
      await terminal.until("faux/");
      terminal.type(enter);
      await terminal.until("Model: ");
    } finally {
      terminal.type("\x03");
      send(terminal, "/quit");
      await running;
    }
  });

  test("/model lists the available models, and the choice is saved and shown", async () => {
    const { terminal, settingsPath, running } = await app();
    send(terminal, "/model");
    await terminal.until("Model");
    terminal.type(enter);
    const screen = await terminal.until("Model: ");
    expect(readSettings(settingsPath).settings.model).toMatch(/^faux/u);
    expect(screen).toContain(readSettings(settingsPath).settings.model ?? "missing");
    send(terminal, "/quit");
    await running;
  });

  test("with ChatGPT sign-in, /model lists only the OpenAI models it serves (#566)", async () => {
    const { terminal, running } = await app([], { served: ["gpt-6.1-sol"] });
    send(terminal, "/model");
    const screen = await terminal.until("openai/");
    expect(screen).toContain("openai/gpt-6.1-sol");
    // The catalog's first OpenAI models, which the sign-in does not serve.
    expect(screen).not.toContain("openai/gpt-4");
    terminal.type("\x1b");
    send(terminal, "/quit");
    await running;
  });

  test("/model lists Claude Code's models once it is signed in, and says how to sign in to it before (#546)", async () => {
    const signedOut = await app([], { claudeCode: "signed out" });
    send(signedOut.terminal, "/model");
    const before = await signedOut.terminal.until("sign in there");
    expect(before).toContain("sign in there (run `claude`, then `/login`)");
    expect(before).not.toContain("claude-code/");
    signedOut.terminal.type("");
    send(signedOut.terminal, "/quit");
    await signedOut.running;
    const signedIn = await app([], { claudeCode: "signed in" });
    send(signedIn.terminal, "/model");
    expect(await signedIn.terminal.until("claude-code/")).not.toContain("sign in there");
    signedIn.terminal.type("");
    send(signedIn.terminal, "/quit");
    await signedIn.running;
  });

  test("with ChatGPT sign-in, a saved model it does not serve is refused at start, naming those it serves (#566)", async () => {
    const { terminal, running } = await app([], { served: ["gpt-6.1-sol"], model: "openai/gpt-5.5" });
    const screen = await terminal.until("no model openai/gpt-5.5");
    expect(screen).toContain("openai/gpt-6.1-sol");
    expect(screen).toContain("Choose one with /model.");
    send(terminal, "/quit");
    await running;
  });

  test("with ChatGPT sign-in, a saved model it could not check is kept at start, saying why (#567)", async () => {
    const { terminal, running } = await app([], { served: "offline", model: "openai/gpt-6.1-sol" });
    const screen = await terminal.until("was not checked");
    expect(screen).not.toContain("The saved model is not used");
    expect(screen.split("\n").at(-1)).toContain("gpt-6.1-sol");
    send(terminal, "/quit");
    await running;
  });

  test("/settings changes the thinking level and the terminal mode, saved for the next start", async () => {
    const { terminal, settingsPath, running } = await app();
    send(terminal, "/settings");
    await terminal.until("Thinking:");
    terminal.type("\x1b[B");
    terminal.type(enter);
    await terminal.until("xhigh");
    for (let down = 0; down < 4; down++) terminal.type("\x1b[B");
    terminal.type(enter);
    await terminal.until("Thinking: high.");
    send(terminal, "/settings");
    await terminal.until("Terminal:");
    terminal.type(enter);
    await terminal.until("inline");
    terminal.type("\x1b[B");
    terminal.type(enter);
    await terminal.until("Terminal: inline, from the next start.");
    expect(readSettings(settingsPath).settings).toMatchObject({ thinkingLevel: "high", tuiMode: "inline" });
    send(terminal, "/quit");
    await running;
  });

  test("/new starts another session beside the first, and the dashboard brings the first back (#455)", async () => {
    const { terminal, sessions, running } = await app(["first answer"], { repository: true });
    send(terminal, "/model");
    await terminal.until("Model");
    terminal.type(enter);
    await terminal.until("Model: ");
    send(terminal, "the first request");
    await terminal.until("first answer");
    // The gate verifies the run before it ends, slower on some machines than others.
    await terminal.untilGone("Verifying");
    send(terminal, "/new");
    await terminal.untilGone("first answer");
    expect(readdirSync(sessions).filter((name) => name.endsWith(".jsonl")).length).toBe(2);
    // The first still runs: the dashboard lists both, the new one attached, and Enter on the first shows it again.
    terminal.type("\x14");
    await terminal.until("Sessions");
    await terminal.until("the first request");
    terminal.type("\x1b[A");
    terminal.type(enter);
    await terminal.until("first answer");
    send(terminal, "/quit");
    await running;
  });

  test("a background session's question waits, flagged, until it is shown, and runs once answered (#455)", async () => {
    const { terminal, cwd, running } = await app([{ tool: "write", args: { path: "asked.md", content: "x" } }, "written"],
      { repository: true });
    send(terminal, "/model");
    await terminal.until("Model");
    terminal.type(enter);
    await terminal.until("Model: ");
    // The first session asks after its request's base is recorded, by which time the second is shown.
    send(terminal, "write it");
    send(terminal, "/new");
    await terminal.until("1 session waits for you");
    expect((await terminal.screen()).join("\n")).not.toContain("Write asked.md?");
    terminal.type("\x14");
    await terminal.until("waiting");
    terminal.type("\x1b[A");
    terminal.type(enter);
    await terminal.until("Write asked.md?");
    terminal.type(enter);
    await terminal.until("written");
    expect(existsSync(join(cwd, "asked.md"))).toBe(true);
    send(terminal, "/quit");
    await running;
  });

  test("closing a session whose question waits refuses it, so the session closes and the shell ends (#455)", async () => {
    const { terminal, cwd, running } = await app([{ tool: "write", args: { path: "refused.md", content: "x" } }, "after"],
      { repository: true });
    send(terminal, "/model");
    await terminal.until("Model");
    terminal.type(enter);
    await terminal.until("Model: ");
    send(terminal, "write it");
    send(terminal, "/new");
    await terminal.until("1 session waits for you");
    terminal.type("\x14");
    await terminal.until("waiting");
    terminal.type("\x1b[A");
    terminal.type("x");
    await terminal.until("Stop and close this session?");
    terminal.type("y");
    await terminal.untilGone("waiting");
    terminal.type("\x1b");
    await terminal.untilGone("Sessions");
    expect(existsSync(join(cwd, "refused.md"))).toBe(false);
    send(terminal, "/quit");
    await running;
  });

  test("in the dashboard Esc goes back, and each session keeps its own unsent text (#455)", async () => {
    const { terminal, running } = await app([], { repository: true });
    terminal.type("a draft for the first");
    terminal.type("\x14");
    await terminal.until("Sessions");
    terminal.type("n");
    await terminal.untilGone("a draft for the first");
    terminal.type("\x14");
    await terminal.until("Sessions");
    terminal.type("\x1b");
    await terminal.untilGone("Sessions");
    terminal.type("\x14");
    await terminal.until("Sessions");
    terminal.type("\x1b[A");
    terminal.type(enter);
    await terminal.until("a draft for the first");
    terminal.type("\x03");
    send(terminal, "/quit");
    await running;
  });

  test("outside Git /new says why a second session cannot start, and the first stays (#455)", async () => {
    const { terminal, running } = await app();
    send(terminal, "/new");
    // The reason names the folder, so a long one, as macOS's temporary folders are, wraps it across lines.
    const screen = await terminal.until("Another session is working in");
    expect(screen.replace(/\s+/gu, " ")).toContain("which is not a Git repository with a commit");
    send(terminal, "/quit");
    await running;
  });

  test("/login runs a provider's sign-in, showing its link and asking for the code; /logout forgets it", async () => {
    const { terminal, credentials, running } = await app();
    send(terminal, "/login");
    await terminal.until("Scripted login");
    for (let down = 0; down < 40 && !(await terminal.screen()).join("\n").includes("→ Scripted login"); down++) terminal.type("\x1b[B");
    terminal.type(enter);
    await terminal.until("Paste the code");
    expect((await terminal.screen()).join("\n")).toContain("https://example.test/authorize");
    send(terminal, "1234");
    await terminal.until("Logged in to Scripted login.");
    expect(await credentials.read("scripted-login")).toMatchObject({ access: "token-1234" });
    send(terminal, "/logout");
    await terminal.until("Log out of");
    terminal.type(enter);
    await terminal.until("Logged out of scripted-login.");
    expect(await credentials.read("scripted-login")).toBeUndefined();
    send(terminal, "/quit");
    await running;
  });

  test("a key typed at a login prompt never shows, and is stored", async () => {
    const { terminal, credentials, running } = await app();
    send(terminal, "/login");
    await terminal.until("Scripted key");
    for (let down = 0; down < 40 && !(await terminal.screen()).join("\n").includes("→ Scripted key"); down++) terminal.type("\x1b[B");
    terminal.type(enter);
    await terminal.until("Paste the key");
    terminal.type("sk-secret-123");
    const screen = await terminal.until("•••••••••••••");
    expect(screen).not.toContain("sk-secret");
    terminal.type(enter);
    await terminal.until("Logged in to Scripted key.");
    expect(await credentials.read("scripted-key")).toEqual({ type: "api_key", key: "sk-secret-123" });
    send(terminal, "/quit");
    await running;
  });

  test("Shift+Tab turns the mode from ask to full access to read only and back, shown in the footer and saved", async () => {
    const { terminal, settingsPath, running } = await app();
    expect((await terminal.screen()).at(-1)).toContain("ask");
    terminal.type("\x1b[Z");
    await terminal.until("full access");
    terminal.type("\x1b[Z");
    await terminal.until("read only");
    expect(readSettings(settingsPath).settings.permissionMode).toBe("read");
    // Another Tesota saves its model meanwhile; this one's next save keeps it (#453).
    writeSettings({ ...readSettings(settingsPath).settings, model: "faux/elsewhere" }, settingsPath);
    terminal.type("\x1b[Z");
    await terminal.untilGone("read only");
    expect(readSettings(settingsPath).settings).toMatchObject({ permissionMode: "ask", model: "faux/elsewhere" });
    send(terminal, "/quit");
    await running;
  });

  test("in ask mode a write asks the operator, and runs once allowed", async () => {
    const { terminal, running, cwd } = await app([{ tool: "write", args: { path: "allowed.txt", content: "x" } }, "written"]);
    send(terminal, "/model");
    await terminal.until("Model");
    terminal.type(enter);
    await terminal.until("Model: ");
    send(terminal, "write it");
    const rows = (await terminal.until("Write allowed.txt?")).split("\n");
    // The question takes the input's place, under the conversation rather than drawn over it, and the input comes back after.
    const asked = rows.findIndex((row) => row.includes("Write allowed.txt?"));
    expect(asked).toBeGreaterThan(rows.findIndex((row) => row.includes("› write it")));
    // A bar sets it apart; the file's content, why it asks, then numbered choices.
    expect(rows[asked]?.startsWith("▌ ")).toBe(true);
    const question = rows.slice(asked).join("\n");
    expect(question).toContain("x");
    expect(question).toContain("The session is in ask. Shift+Tab changes the mode.");
    expect(question).toContain("1. Yes");
    expect(question).toContain("2. Yes, and don't ask again this session");
    expect(question).toContain("3. No  (esc)");
    expect(rows.some((row) => row.includes("/ for commands"))).toBe(false);
    // While it asks, the footer says the run waits for the operator, not for the agent.
    expect(rows.at(-1)).toContain("◌ waiting for you");
    // A digit answers at once.
    terminal.type("1");
    const answered = (await terminal.until("written")).split("\n");
    expect(answered.some((row) => row.includes("/ for commands"))).toBe(true);
    expect(answered.at(-1)).not.toContain("waiting for you");
    expect(existsSync(join(cwd, "allowed.txt"))).toBe(true);
    send(terminal, "/quit");
    await running;
  });

  test("/compact says why it cannot compact before a run, and when the recent messages alone are what it keeps", async () => {
    const { terminal, running } = await app(["hello"]);
    send(terminal, "/compact");
    await terminal.until("There is nothing to compact yet.");
    send(terminal, "/model");
    await terminal.until("Model");
    terminal.type(enter);
    await terminal.until("Model: ");
    send(terminal, "say hello");
    await terminal.until("hello");
    // Compacting waits for the run to settle, which ends its indicator.
    await terminal.untilGone("Working…");
    await terminal.untilGone("Verifying…");
    send(terminal, "/compact");
    await terminal.until("Nothing to compact");
    send(terminal, "/quit");
    await running;
  });

  test("your MCP servers start, the project's once trusted, and /mcp lists them and reconnects one (#459)", async () => {
    const server = { command: process.execPath, args: [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))] };
    const { terminal, running } = await app([], { mcp: { mcpServers: { mine: server } }, projectMcp: { mcpServers: { theirs: server } } });
    expect(await terminal.until("This project's MCP servers would start")).toContain("theirs");
    terminal.type(enter);
    send(terminal, "/mcp reconnect theirs");
    await terminal.until("theirs: connected.", 15_000);
    send(terminal, "/mcp");
    const listed = await terminal.until("MCP servers");
    expect(listed).toContain("mine");
    expect(listed).toContain("theirs");
    terminal.type("\x1b");
    send(terminal, "/mcp login mine");
    await terminal.until('"mine" is a local server: it has no sign-in.');
    send(terminal, "/quit");
    await running;
  });

  test("/mcp with no server configured says where one goes, and a project's untrusted servers do not start (#459)", async () => {
    const server = { command: process.execPath, args: [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))] };
    const { terminal, running } = await app([], { projectMcp: { mcpServers: { theirs: server } } });
    await terminal.until("This project's MCP servers would start");
    terminal.type("\x1b[B");
    terminal.type(enter);
    await terminal.until("The project's MCP servers do not start in this shell.");
    send(terminal, "/mcp");
    await terminal.until("No MCP server is configured");
    send(terminal, "/quit");
    await running;
  });

  test("/name runs a project's skill on the rest of the line, and a command wins over a skill of its name (#540)", async () => {
    const { terminal } = await app(["Checked the ledger."], { skills: {
      "verify-ledger": "---\nname: verify-ledger\ndescription: Verify the ledger formally.\ndisable-model-invocation: true\n---\nHidden playbook.\n",
      model: "---\nname: model\ndescription: A skill the model command shadows.\n---\nShadowed.\n",
    } });
    terminal.type("/verify");
    expect(await terminal.until("Verify the ledger formally.")).toContain("verify-ledger");
    terminal.type("\x03");
    terminal.type("/mod");
    expect(await terminal.until("Choose the model")).not.toContain("A skill the model command shadows.");
    terminal.type("\x03");
    send(terminal, "/verify-ledger the session file");
    const screen = await terminal.until("Checked the ledger.");
    expect(screen).toContain("/verify-ledger the session file");
    expect(screen).not.toContain("Hidden playbook.");
  });

  test("an unknown command is named, and /quit ends the shell", async () => {
    const { terminal, running } = await app();
    send(terminal, "/nope");
    await terminal.until("No command /nope.");
    send(terminal, "/quit");
    await running;
  });
});
