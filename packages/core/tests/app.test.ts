import {
  createModels, fauxProvider, InMemoryCredentialStore, type MutableModels, type OAuthCredential,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../src/settings.ts";
import { runApp } from "../src/shell/app.ts";
import type { ScriptStep } from "./engine.ts";
import { scriptedReply } from "./scripted.ts";
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
async function app(replies: readonly ScriptStep[] = []) {
  const terminal = new VirtualTerminal(100, 30);
  const { models, credentials } = scripted(replies);
  const settingsPath = join(folder("tesota-core-app-settings-"), "settings.json");
  const sessions = folder("tesota-core-app-sessions-");
  const cwd = folder("tesota-core-app-");
  const running = runApp({ cwd, terminal, models, credentials, settingsPath, sessions });
  await terminal.until("tesota-core");
  return { terminal, credentials, settingsPath, sessions, running, cwd };
}

const send = (terminal: VirtualTerminal, text: string): void => { terminal.type(text); terminal.type(enter); };

describe("tesota-core", () => {
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

  test("/new starts another session, and /resume brings the first back with its conversation", async () => {
    const { terminal, sessions, running } = await app(["first answer"]);
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
    send(terminal, "/resume");
    await terminal.until("the first request");
    terminal.type(enter);
    await terminal.until("first answer");
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
    await terminal.until("Allow write allowed.txt");
    terminal.type(enter);
    await terminal.until("written");
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

  test("an unknown command is named, and /quit ends the shell", async () => {
    const { terminal, running } = await app();
    send(terminal, "/nope");
    await terminal.until("No command /nope.");
    send(terminal, "/quit");
    await running;
  });
});
