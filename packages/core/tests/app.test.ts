import {
  createModels, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type MutableModels, type OAuthCredential,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "../src/settings.ts";
import { runApp } from "../src/shell/app.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * `tesota-core`'s commands (#444), typed into an emulated terminal as the
 * operator would, on a scripted provider and temporary settings and sessions.
 */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const enter = "\r";

/** A scripted model, and a provider that logs in by OAuth with a pasted code. */
function scripted(replies: readonly string[]): { models: MutableModels; credentials: InMemoryCredentialStore } {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const faux = fauxProvider();
  faux.setResponses(replies.map((reply) => fauxAssistantMessage(reply)));
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
  return { models, credentials };
}

/** The app in a temporary folder, its settings and sessions there too, once it has drawn its first frame. */
async function app(replies: readonly string[] = []) {
  const terminal = new VirtualTerminal(100, 30);
  const { models, credentials } = scripted(replies);
  const settingsPath = join(folder("tesota-core-app-settings-"), "settings.json");
  const sessions = folder("tesota-core-app-sessions-");
  const running = runApp({ cwd: folder("tesota-core-app-"), terminal, models, credentials, settingsPath, sessions });
  await until(terminal, "tesota-core");
  return { terminal, credentials, settingsPath, sessions, running };
}

/** Waits until the screen shows `text`, typing nothing. */
async function until(terminal: VirtualTerminal, text: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const screen = (await terminal.screen()).join("\n");
    if (screen.includes(text)) return screen;
    if (Date.now() > deadline) throw new Error(`The screen never showed "${text}":\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const send = (terminal: VirtualTerminal, text: string): void => { terminal.type(text); terminal.type(enter); };

describe("tesota-core", () => {
  test("/model lists the available models, and the choice is saved and shown", async () => {
    const { terminal, settingsPath, running } = await app();
    send(terminal, "/model");
    await until(terminal, "Model");
    terminal.type(enter);
    const screen = await until(terminal, "Model: ");
    expect(readSettings(settingsPath).settings.model).toMatch(/^faux/u);
    expect(screen).toContain(readSettings(settingsPath).settings.model ?? "missing");
    send(terminal, "/quit");
    await running;
  });

  test("/settings changes the thinking level and the terminal mode, saved for the next start", async () => {
    const { terminal, settingsPath, running } = await app();
    send(terminal, "/settings");
    await until(terminal, "Thinking:");
    terminal.type("\x1b[B");
    terminal.type(enter);
    await until(terminal, "xhigh");
    for (let down = 0; down < 4; down++) terminal.type("\x1b[B");
    terminal.type(enter);
    await until(terminal, "Thinking: high.");
    send(terminal, "/settings");
    await until(terminal, "Terminal:");
    terminal.type(enter);
    await until(terminal, "inline");
    terminal.type("\x1b[B");
    terminal.type(enter);
    await until(terminal, "Terminal: inline, from the next start.");
    expect(readSettings(settingsPath).settings).toMatchObject({ thinkingLevel: "high", tuiMode: "inline" });
    send(terminal, "/quit");
    await running;
  });

  test("/new starts another session, and /resume brings the first back with its conversation", async () => {
    const { terminal, sessions, running } = await app(["first answer"]);
    send(terminal, "/model");
    await until(terminal, "Model");
    terminal.type(enter);
    await until(terminal, "Model: ");
    send(terminal, "the first request");
    await until(terminal, "first answer");
    send(terminal, "/new");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await terminal.screen()).join("\n")).not.toContain("first answer");
    expect(readdirSync(sessions).filter((name) => name.endsWith(".jsonl")).length).toBe(2);
    send(terminal, "/resume");
    await until(terminal, "the first request");
    terminal.type(enter);
    await until(terminal, "first answer");
    send(terminal, "/quit");
    await running;
  });

  test("/login runs a provider's sign-in, showing its link and asking for the code; /logout forgets it", async () => {
    const { terminal, credentials, running } = await app();
    send(terminal, "/login");
    await until(terminal, "Scripted login");
    for (let down = 0; down < 40 && !(await terminal.screen()).join("\n").includes("→ Scripted login"); down++) terminal.type("\x1b[B");
    terminal.type(enter);
    await until(terminal, "Paste the code");
    expect((await terminal.screen()).join("\n")).toContain("https://example.test/authorize");
    send(terminal, "1234");
    await until(terminal, "Logged in to Scripted login.");
    expect(await credentials.read("scripted-login")).toMatchObject({ access: "token-1234" });
    send(terminal, "/logout");
    await until(terminal, "Log out of");
    terminal.type(enter);
    await until(terminal, "Logged out of scripted-login.");
    expect(await credentials.read("scripted-login")).toBeUndefined();
    send(terminal, "/quit");
    await running;
  });

  test("an unknown command is named, and /quit ends the shell", async () => {
    const { terminal, running } = await app();
    send(terminal, "/nope");
    await until(terminal, "No command /nope.");
    send(terminal, "/quit");
    await running;
  });
});
