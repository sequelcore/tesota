import type { Api, AuthInteraction, CredentialStore, Model, ModelThinkingLevel, MutableModels } from "@earendil-works/pi-ai";
import { getTerminalColorMode, ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { provideHost } from "../../../../src/host.ts";
import { isReceipt, type Receipt, receiptStanding } from "../../../../src/receipt.ts";
import tesota from "../../../../src/tesota.ts";
import { fileCredentialStore } from "../credentials.ts";
import { engineModels, loginOptions } from "../model-access.ts";
import type { Mode } from "../permission-rule.ts";
import type { HistoryMessage } from "../loop.ts";
import { loadRules } from "../permissions.ts";
import { createSession, type EngineSession, openSession, sessionsFolder, type Verifier } from "../session.ts";
import { readSettings, type Settings, updateSettings } from "../settings.ts";
import { Dashboard, type SessionRow } from "./dashboard.ts";
import { type Shell, startShell } from "./shell.ts";
import { createSurface, footerData, shellHost, type Surface } from "./surface.ts";
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
  // Another Tesota may have saved since this one started: only what changed here is written over it (#453).
  const save = (change: Partial<Settings>): void => {
    settings = { ...settings, ...change };
    updateSettings(change, options.settingsPath);
  };
  const folder = options.sessions ?? sessionsFolder(options.cwd);
  // Tesota's interface takes the shell's editor, key names, version and shell, never Pi's (#446).
  provideHost(shellHost());
  const theme = shellTheme("dark", getTerminalColorMode());
  const verifier: Verifier = (pi, request) => { tesota(pi, request); };
  let providers = 0;
  let model = await chosenModel(models, settings);
  let permissionMode: Mode = settings.permissionMode ?? "ask";
  const rules = loadRules(options.cwd);
  /** The operator's answer to a call the mode and rules leave to them (#449): once, for this session, or no. */
  const answer = async (call: { name: string; arguments: unknown }, reason: string): Promise<"once" | "session" | "deny"> => {
    const args = call.arguments as Record<string, unknown>;
    const about = typeof args["path"] === "string" ? args["path"] : typeof args["command"] === "string" ? args["command"] : "";
    const picked = await shell.pick(`Allow ${call.name} ${about}`.trim(), [
      { value: "once", label: "Yes, this once", description: reason },
      { value: "session", label: "Yes, for this session" },
      { value: "deny", label: "No" },
    ]);
    return picked === "once" || picked === "session" ? picked : "deny";
  };
  const modeNames: Readonly<Record<Mode, string>> = { read: "read only", ask: "ask", full: "full access" };
  /** The sessions this shell runs (#455): each its own workspace, surface, state and questions; one is shown. */
  const lives: Live[] = [];
  let attached: Live;
  /**
   * The statuses Tesota's footer shows on its third row: the permission mode
   * (#449), and how many other sessions wait for the operator (#455).
   */
  const showStatuses = (): void => {
    for (const live of lives) live.surface.statuses.set("permissions", modeNames[permissionMode]);
    const waiting = lives.filter((live) => live !== attached && live.state === "waiting").length;
    if (waiting === 0) attached.surface.statuses.delete("sessions");
    else attached.surface.statuses.set("sessions", `${waiting} ${waiting === 1 ? "session waits" : "sessions wait"} for you: /agents`);
  };
  const sessionOptions = (live: Live) => ({ models, model: model ?? models.getModels()[0] as Model<Api>, verifier, surface: live.surface,
    mode: "tui",
    // A shown session asks at once; another waits, flagged, until the operator shows it.
    permissions: { mode: () => permissionMode, rules, ask: (call: { name: string; arguments: unknown }, reason: string) => {
      if (live === attached) return answer(call, reason);
      return new Promise<"once" | "session" | "deny">((resolve) => {
        live.waiting.push({ put: async () => { resolve(await answer(call, reason)); }, refuse: () => { resolve("deny"); } });
        live.state = "waiting";
        showStatuses();
        shell.redraw();
      });
    } },
    ...settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel } });
  /** A session the shell runs, made by `open` with its own surface, and followed for the dashboard. */
  const live = (open: (made: Live) => EngineSession): Live => {
    const made = { surface: createSurface(theme), state: "idle", startedAt: Date.now(), waiting: [] } as unknown as Live;
    made.session = open(made);
    follow(made);
    lives.push(made);
    return made;
  };
  /**
   * Keeps `made`'s row up to date from its events: its state, its first
   * request and its receipt; a background end is noted. A session opened again
   * starts from what it holds: its last run's end and its last receipt.
   */
  const follow = (made: Live): void => {
    made.request = made.session.ledger()[0]?.text;
    const ended = made.session.outcome();
    made.state = ended === undefined ? "idle" : "ended";
    if (ended === undefined) delete made.outcome; else made.outcome = ended;
    const last = made.session.history().findLast((message) => message.role === "custom" && message.customType === "tesota-receipt");
    const held = last?.role === "custom" ? last.details : undefined;
    if (isReceipt(held)) made.verification = receiptStanding(held as Receipt); else delete made.verification;
    made.unsubscribe = made.session.subscribe((event) => {
      if (event.type === "state") made.state = made.waiting.length > 0 ? "waiting" : event.state === "settling" ? "verifying" : "working";
      else if (event.type === "ended") {
        made.state = "ended";
        made.outcome = event.outcome;
        if (made !== attached) shell.note(`“${firstLine(made.request)}” ended ${event.outcome}${made.verification === undefined ? "" : `, ${made.verification}`}.`);
      } else if (event.type === "message") {
        made.request ??= made.session.ledger()[0]?.text;
        const receipt = event.message.role === "custom" && event.message.customType === "tesota-receipt" ? event.message.details : undefined;
        if (isReceipt(receipt)) made.verification = receiptStanding(receipt as Receipt);
      }
    });
  };
  /** Shows `next`, then puts the questions it held to the operator, in the order they came. */
  const attach = async (next: Live): Promise<void> => {
    attached = next;
    showStatuses();
    shell.show(next.session, next.surface, next.state === "working" ? "working" : next.state === "verifying" ? "settling" : undefined);
    for (const { put } of next.waiting.splice(0)) await put();
    if (next.state === "waiting") {
      // Its run goes on once answered, without an event to say so: the shell shows it working, so Esc stops it.
      next.state = "working";
      if (next === attached) shell.busy("working");
    }
    showStatuses();
    shell.redraw();
  };
  /**
   * Closes `gone`: the questions it held refused, so its run can stop, its
   * file let go, its worktree removed when unchanged, or named when it holds
   * work. Closing it again while it closes does nothing.
   */
  const close = async (gone: Live): Promise<void> => {
    const at = lives.indexOf(gone);
    if (at < 0) return;
    lives.splice(at, 1);
    gone.unsubscribe();
    for (const { refuse } of gone.waiting.splice(0)) refuse();
    await gone.session.dispose();
    const kept = gone.session.kept();
    if (gone === attached) await attach(lives[0] ?? live((made) => createSession({ cwd: options.cwd, folder, ...sessionOptions(made) })));
    if (kept !== undefined) shell.note(kept, "warning");
  };
  attached = live((made) => createSession({ cwd: options.cwd, folder, ...sessionOptions(made) }));
  showStatuses();
  const status = (): string => [model === undefined ? "no model: /login, then /model" : label(model),
    ...settings.thinkingLevel === undefined || settings.thinkingLevel === "off" ? [] : [settings.thinkingLevel]].join(" · ");

  let shell: Shell;
  /** Opens the shown session again, as a change of model or thinking needs, once it has let go of its file. */
  const reopen = async (): Promise<void> => {
    const shown = attached;
    shown.unsubscribe();
    await shown.session.dispose();
    shown.session = openSession(shown.session.file, sessionOptions(shown));
    follow(shown);
    await attach(shown);
  };
  /** The sessions as the dashboard lists them. */
  const rows = (): SessionRow[] => lives.map((each) => ({
    id: each.session.file, request: each.request ?? "", state: each.state, ...each.outcome === undefined ? {} : { outcome: each.outcome },
    ...each.verification === undefined ? {} : { verification: each.verification },
    workspace: each.session.workspace.branch ?? "checkout", startedAt: each.startedAt, attached: each === attached,
  }));
  /** Opens the dashboard over the shell (#455), until a session is attached or the operator goes back. */
  const agents = (): void => {
    const byId = (id: string): Live | undefined => lives.find((each) => each.session.file === id);
    let hide = (): void => undefined;
    const dashboard = new Dashboard(theme, rows, {
      attach: (id) => { hide(); const next = byId(id); if (next !== undefined) void attach(next); },
      peek: (id) => peekLines(byId(id)?.session.history() ?? []),
      create: () => { hide(); void commands["/new"]?.(); },
      close: (id) => { const gone = byId(id); if (gone !== undefined) void close(gone).then(() => { shell.redraw(); }); },
      back: () => { hide(); },
    });
    hide = shell.overlay(dashboard);
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
      await reopen();
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
    // A new session runs beside the others, in its own worktree when another holds the checkout (#453, #455).
    "/new": async () => {
      try {
        await attach(live((made) => createSession({ cwd: options.cwd, folder, ...sessionOptions(made) })));
      } catch (error) {
        shell.note(error instanceof Error ? error.message : String(error), "warning");
      }
    },
    "/resume": async () => {
      const running = new Set(lives.map((each) => each.session.file));
      const asked = readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort().reverse()
        .map((name) => join(folder, name)).filter((file) => !running.has(file))
        .flatMap((file) => { const request = firstRequest(file); return request === undefined ? [] : [{ file, request }]; });
      if (asked.length === 0) { shell.note("No other session in this folder."); return; }
      const picked = await shell.pick("Resume", asked.map(({ file, request }) => ({ value: file, label: request,
        description: basename(file).slice(0, 19) })));
      if (picked === undefined) return;
      try {
        await attach(live((made) => openSession(picked, sessionOptions(made))));
      } catch (error) {
        shell.note(error instanceof Error ? error.message : String(error), "warning");
      }
    },
    "/agents": () => { agents(); return Promise.resolve(); },
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
          await reopen();
          shell.note(`Thinking: ${chosen}.`);
        }
      }
    },
    "/compact": async () => {
      shell.note("Compacting…");
      await attached.session.compact().catch((error: unknown) => { shell.note(error instanceof Error ? error.message : String(error), "warning"); });
    },
    "/quit": () => { shell.stop(); return Promise.resolve(); },
  };

  shell = startShell({ terminal: options.terminal ?? new ProcessTerminal(), mode: modeFor(settings),
    fullRepaint: process.platform === "win32", theme, session: attached.session, status, surface: attached.surface,
    // The shown session's folder and statuses, whichever session that is (#455).
    footerData: footerData(() => attached.session.workspace.cwd, () => attached.surface.statuses, () => providers),
    nextMode: () => {
      permissionMode = permissionMode === "ask" ? "full" : permissionMode === "full" ? "read" : "ask";
      save({ permissionMode });
      showStatuses();
      shell.redraw();
    },
    agents,
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
  for (const each of lives) {
    each.unsubscribe();
    for (const { refuse } of each.waiting.splice(0)) refuse();
  }
  await Promise.all(lives.map((each) => each.session.dispose()));
  // The shell has given the terminal back: worktrees with work in them are named where the operator sees them (#453).
  for (const each of lives) {
    const kept = each.session.kept();
    if (kept !== undefined) console.log(kept);
  }
}

/** A session the shell runs (#455): its own surface, where its run stands, its receipt, and the questions it holds for the operator. */
interface Live {
  session: EngineSession;
  readonly surface: Surface;
  state: SessionRow["state"];
  outcome?: string;
  verification?: "verified" | "incomplete" | "failed";
  request?: string | undefined;
  readonly startedAt: number;
  /** Questions it holds for the operator: put when it is shown, refused when it closes. */
  readonly waiting: { readonly put: () => Promise<void>; readonly refuse: () => void }[];
  unsubscribe: () => void;
}

const firstLine = (text: string | undefined): string => (text ?? "").split("\n")[0]?.trim() || "new session";

/** A session's last lines as the dashboard peeks at them: what was asked and answered, in plain text. */
function peekLines(history: readonly HistoryMessage[]): string[] {
  return history.flatMap((message) => {
    if (message.role === "user") return typeof message.content === "string" ? [`> ${message.content}`] : [];
    if (message.role !== "assistant") return [];
    return message.content.flatMap((part) => part.type === "text" ? [part.text] : part.type === "toolCall" ? [`· ${part.name}`] : []);
  }).flatMap((text) => text.split("\n")).slice(-10);
}
