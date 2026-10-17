import type { Api, AuthInteraction, CredentialStore, Model, ModelThinkingLevel, MutableModels } from "@earendil-works/pi-ai";
import { getTerminalColorMode, ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { provideHost } from "../../../../src/host.ts";
import tesota from "../../../../src/tesota.ts";
import { fileCredentialStore } from "../credentials.ts";
import { engineModels, loginOptions } from "../model-access.ts";
import type { Mode } from "../permission-rule.ts";
import { loadRules } from "../permissions.ts";
import { createSession, type EngineSession, openSession, sessionsFolder, type Verifier } from "../session.ts";
import { readSettings, type Settings, writeSettings } from "../settings.ts";
import { type Shell, startShell } from "./shell.ts";
import { createSurface, footerData, shellHost } from "./surface.ts";
import { shellTheme } from "./theme.ts";

export interface AppOptions {
  readonly cwd: string;
  readonly terminal?: Terminal;
  /** The operator's credentials; the engine's own file when not given. */
  readonly credentials?: CredentialStore;
  /** The models over those credentials; the engine's when not given. */
  readonly models?: MutableModels;
  /** Where the settings live; `~/.tesota/settings.json` when not given. */
  readonly settingsPath?: string;
  /** Where the sessions live; the project's folder under `~/.tesota/sessions` when not given. */
  readonly sessions?: string;
}

const levels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const label = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/** On Windows over SSH the inline shell, which the remote terminal draws reliably; otherwise the operator's choice (#432). */
const modeFor = (settings: Settings): "fullscreen" | "inline" =>
  process.platform === "win32" && (process.env["SSH_CONNECTION"] ?? process.env["SSH_CLIENT"]) !== undefined ? "inline"
    : settings.tuiMode ?? "fullscreen";

/** The model the operator chose, if it still exists, else the first one with a credential, else none. */
async function chosenModel(models: MutableModels, settings: Settings): Promise<Model<Api> | undefined> {
  const [provider, ...id] = settings.model?.split("/") ?? [];
  const named = provider === undefined ? undefined : models.getModel(provider, id.join("/"));
  return named ?? (await models.getAvailable())[0];
}

/** The first request of the session in `file`, to name it in `/resume`; none for a session never asked anything. */
function firstRequest(file: string): string | undefined {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const entry = JSON.parse(line) as { type?: string; text?: string };
      if (entry.type === "request" && typeof entry.text === "string") return entry.text.split("\n")[0] ?? "";
    }
  } catch { /* a session being written, or not one */ }
  return undefined;
}

/**
 * `tesota-core`: the engine's shell in the current folder (#444), on the
 * engine's models and settings, verified by Tesota's gate, with the
 * commands an operator needs every day. Resolves when the shell ends.
 */
export async function runApp(options: AppOptions): Promise<void> {
  const credentials = options.credentials ?? fileCredentialStore();
  const models = options.models ?? engineModels(credentials);
  const read = readSettings(options.settingsPath);
  let settings = read.settings;
  const save = (change: Partial<Settings>): void => {
    settings = { ...settings, ...change };
    writeSettings(settings, options.settingsPath);
  };
  const folder = options.sessions ?? sessionsFolder(options.cwd);
  // Tesota's interface takes the shell's editor, key names, version and shell, never Pi's (#446).
  provideHost(shellHost());
  const theme = shellTheme("dark", getTerminalColorMode());
  const surface = createSurface(theme);
  const verifier: Verifier = (pi, request) => { tesota(pi, request); };
  let providers = 0;
  let model = await chosenModel(models, settings);
  let permissionMode: Mode = settings.permissionMode ?? "ask";
  const rules = loadRules(options.cwd);
  // The operator answers what the mode and rules leave to them (#449): once, for this session, or no.
  const permissions = {
    mode: () => permissionMode,
    rules,
    ask: async (call: { name: string; arguments: unknown }, reason: string) => {
      const args = call.arguments as Record<string, unknown>;
      const about = typeof args["path"] === "string" ? args["path"] : typeof args["command"] === "string" ? args["command"] : "";
      const answer = await shell.pick(`Allow ${call.name} ${about}`.trim(), [
        { value: "once", label: "Yes, this once", description: reason },
        { value: "session", label: "Yes, for this session" },
        { value: "deny", label: "No" },
      ]);
      return answer === "once" || answer === "session" ? answer : "deny";
    },
  };
  const sessionOptions = () => ({ models, model: model ?? models.getModels()[0] as Model<Api>, verifier, permissions, surface, mode: "tui",
    ...settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel } });
  let session: EngineSession = createSession({ cwd: options.cwd, folder, ...sessionOptions() });
  const modeNames: Readonly<Record<Mode, string>> = { read: "read only", ask: "ask", full: "full access" };
  // The mode is a status, which Tesota's footer shows on its third row (#449).
  const showMode = (): void => { surface.statuses.set("permissions", modeNames[permissionMode]); };
  showMode();
  const status = (): string => [model === undefined ? "no model: /login, then /model" : label(model),
    ...settings.thinkingLevel === undefined || settings.thinkingLevel === "off" ? [] : [settings.thinkingLevel]].join(" · ");

  let shell: Shell;
  /** Replaces the running session with `next`, once the old one has let go of its file. */
  const replace = async (next: () => EngineSession): Promise<void> => {
    await session.dispose();
    session = next();
    shell.show(session);
  };
  /** The link or code the sign-in last gave, shown with its next question so the dialog never hides it. */
  let given: string | undefined;
  const interaction: AuthInteraction = {
    prompt: async (prompt) => {
      const message = given === undefined ? prompt.message : `${given}\n${prompt.message}`;
      given = undefined;
      const answer = prompt.type === "select" ? await shell.pick(message, prompt.options.map(({ id, label: text, description }) =>
        ({ value: id, label: text, ...description === undefined ? {} : { description } })))
        : await shell.ask(message, { secret: prompt.type === "secret", ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder } });
      if (answer === undefined) throw new Error("Login cancelled");
      return answer;
    },
    notify: (event) => {
      if (event.type === "auth_url" || event.type === "device_code") {
        given = event.type === "auth_url" ? `Open ${event.url}${event.instructions === undefined ? "" : ` — ${event.instructions}`}`
          : `Enter ${event.userCode} at ${event.verificationUri}`;
        shell.note(given);
      } else shell.note(event.message);
    },
  };
  const commands: Readonly<Record<string, () => Promise<void>>> = {
    "/model": async () => {
      const available = await models.getAvailable();
      if (available.length === 0) { shell.note("No provider is logged in: /login first, or set its API key.", "warning"); return; }
      const picked = await shell.pick("Model", available.map((candidate) => ({ value: label(candidate), label: label(candidate) })));
      const next = available.find((candidate) => label(candidate) === picked);
      if (next === undefined) return;
      model = next;
      save({ model: label(next) });
      await replace(() => openSession(session.file, sessionOptions()));
      shell.note(`Model: ${label(next)}.`);
    },
    "/login": async () => {
      const providers = models.getProviders().filter(({ auth }) => auth.oauth !== undefined || auth.apiKey?.login !== undefined);
      const picked = await shell.pick("Log in to", providers.map(({ id, name }) => ({ value: id, label: name })));
      const provider = providers.find(({ id }) => id === picked);
      if (provider === undefined) return;
      const type = provider.auth.oauth !== undefined && provider.auth.apiKey?.login !== undefined
        ? await shell.pick("With", [{ value: "oauth", label: provider.auth.oauth.name }, { value: "api_key", label: "API key" }])
        : provider.auth.oauth !== undefined ? "oauth" : "api_key";
      if (type !== "oauth" && type !== "api_key") return;
      try {
        await models.login(provider.id, type, interaction, loginOptions(options.settingsPath));
        shell.note(`Logged in to ${provider.name}.`);
        model ??= await chosenModel(models, settings);
      } catch (error) {
        shell.note(error instanceof Error ? error.message : String(error), "error");
      }
    },
    "/logout": async () => {
      const stored = await credentials.list();
      if (stored.length === 0) { shell.note("No provider is logged in."); return; }
      const picked = await shell.pick("Log out of", stored.map(({ providerId, type }) => ({ value: providerId, label: providerId,
        description: type === "oauth" ? "signed in" : "API key" })));
      if (picked === undefined) return;
      await models.logout(picked);
      shell.note(`Logged out of ${picked}.`);
    },
    "/new": async () => { await replace(() => createSession({ cwd: options.cwd, folder, ...sessionOptions() })); },
    "/resume": async () => {
      const asked = readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort().reverse()
        .map((name) => join(folder, name)).filter((file) => file !== session.file)
        .flatMap((file) => { const request = firstRequest(file); return request === undefined ? [] : [{ file, request }]; });
      if (asked.length === 0) { shell.note("No other session in this folder."); return; }
      const picked = await shell.pick("Resume", asked.map(({ file, request }) => ({ value: file, label: request,
        description: basename(file).slice(0, 19) })));
      if (picked !== undefined) await replace(() => openSession(picked, sessionOptions()));
    },
    "/settings": async () => {
      const picked = await shell.pick("Settings", [
        { value: "mode", label: `Terminal: ${settings.tuiMode ?? "fullscreen"}`, description: "fullscreen or inline, from the next start" },
        { value: "thinking", label: `Thinking: ${settings.thinkingLevel ?? "off"}`, description: "for a model that reasons" },
      ]);
      if (picked === "mode") {
        const mode = await shell.pick("Terminal", [{ value: "fullscreen", label: "fullscreen" }, { value: "inline", label: "inline" }]);
        if (mode === "fullscreen" || mode === "inline") { save({ tuiMode: mode }); shell.note(`Terminal: ${mode}, from the next start.`); }
      } else if (picked === "thinking") {
        const level = await shell.pick("Thinking", levels.map((value) => ({ value, label: value })));
        const chosen = levels.find((value) => value === level);
        if (chosen !== undefined) {
          save({ thinkingLevel: chosen });
          await replace(() => openSession(session.file, sessionOptions()));
          shell.note(`Thinking: ${chosen}.`);
        }
      }
    },
    "/compact": async () => {
      shell.note("Compacting…");
      await session.compact().catch((error: unknown) => { shell.note(error instanceof Error ? error.message : String(error), "warning"); });
    },
    "/quit": () => { shell.stop(); return Promise.resolve(); },
  };

  shell = startShell({ terminal: options.terminal ?? new ProcessTerminal(), mode: modeFor(settings),
    fullRepaint: process.platform === "win32", theme, session, status, surface,
    footerData: footerData(options.cwd, surface, () => providers),
    nextMode: () => {
      permissionMode = permissionMode === "ask" ? "full" : permissionMode === "full" ? "read" : "ask";
      save({ permissionMode });
      showMode();
      shell.redraw();
    },
    command: async (text) => {
      const run = commands[text.split(/\s/u)[0] ?? ""];
      if (run === undefined) return false;
      await run();
      return true;
    } });
  if (read.invalid.length > 0) shell.note(`Settings left out as invalid: ${read.invalid.join(", ")}.`, "warning");
  providers = (await credentials.list()).length;
  if (model === undefined) shell.note("No provider is logged in: /login, or set a provider's API key, then /model.", "warning");
  await shell.stopped;
  await session.dispose();
}
