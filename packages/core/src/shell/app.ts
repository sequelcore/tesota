import type { Api, AuthInteraction, CredentialStore, Model, ModelThinkingLevel, MutableModels } from "@earendil-works/pi-ai";
import { getTerminalColorMode, ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tesotaHome } from "../../../../src/home.ts";
import { provideHost } from "../../../../src/host.ts";
import { isReceipt, type Receipt, receiptStanding } from "../../../../src/receipt.ts";
import tesota from "../../../../src/tesota.ts";
import { fileCredentialStore } from "../credentials.ts";
import { chosenModel, engineModels, loginOptions } from "../model-access.ts";
import type { Mode } from "../permission-rule.ts";
import type { HistoryMessage } from "../loop.ts";
import type { McpServers, startMcp } from "../mcp.ts";
import { readMcpConfig } from "../mcp-config.ts";
import { loadRules } from "../permissions.ts";
import { createSession, type EngineSession, openSession, sessionsFolder, type Verifier } from "../session.ts";
import { anyHooks, type Hooks, joinHooks } from "../hooks.ts";
import { readStandards } from "../standards.ts";
import { trust } from "../trust.ts";
import { readSettings, type Settings, updateSettings } from "../settings.ts";
import { Dashboard, type SessionRow } from "./dashboard.ts";
import { type Shell, startShell } from "./shell.ts";
import { createSurface, footerData, shellHost, type Surface } from "./surface.ts";
import { shellTheme } from "../../../../src/theme.ts";

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
  const settingsPath = options.settingsPath ?? join(tesotaHome(), "settings.json");
  /**
   * The command hooks every session's calls pass (#457) and the MCP servers
   * they reach (#459): the operator's own, and the project's once the
   * operator trusts them as they are now.
   */
  const standards = readStandards(options.cwd, settingsPath);
  let hooks: Hooks = typeof standards.ownHooks === "string" ? {} : standards.ownHooks;
  /** The MCP servers every session reaches (#459), started once the project's are trusted or left out; none configured, none. */
  let mcp: { readonly start: typeof startMcp; readonly own: string; readonly project: string | undefined } | undefined;
  /** Each workspace's servers (#459): a session in its own worktree reaches servers that run there, never in another's. */
  const workspaces = new Map<string, McpServers | undefined>();
  /** The servers of the workspace at `cwd`, started the first time a session there asks; none when none is configured. */
  const serversIn = (cwd: string): McpServers | undefined => {
    if (mcp === undefined) return undefined;
    if (!workspaces.has(cwd)) {
      const { servers } = readMcpConfig(mcp.own, mcp.project, cwd);
      workspaces.set(cwd, servers.length === 0 ? undefined : mcp.start(servers, { cwd, home: dirname(settingsPath) }));
    }
    return workspaces.get(cwd);
  };
  /** Settles once the servers started, or were left out; `/mcp` waits for it. */
  let serversStarted: Promise<void> = Promise.resolve();
  const sessionOptions = (live: Live) => ({ models, model: model ?? models.getModels()[0] as Model<Api>, verifier, surface: live.surface,
    hooks: () => hooks, mcp: () => serversIn(live.session.workspace.cwd),
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
      create: () => { hide(); void commands["/new"]?.(""); },
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
  /** A project's hooks run its own commands: they run only once the operator trusts them as they are now (#457). */
  const trustProjectHooks = async (): Promise<void> => {
    const { hooks: project, hash, trusted: already } = standards.projectHooks;
    if (typeof project === "string") { shell.note(`The project's hooks were left out: ${project}`, "error"); return; }
    if (!anyHooks(project)) return;
    let given = already;
    if (!given) {
      const commands = [...new Set(Object.values(project).flatMap((groups) => groups.flatMap((group) => group.hooks.map(({ command }) => command))))];
      const picked = await shell.pick(`This project's hooks would run: ${commands.join("; ")}`, [
        { value: "trust", label: "Trust them", description: "kept until their commands change" },
        { value: "skip", label: "Not now", description: "the project's hooks do not run in this shell" },
      ]);
      given = picked === "trust";
      if (given) trust(standards.root, "hooks", hash);
      else shell.note("The project's hooks do not run in this shell.", "warning");
    }
    if (given) hooks = joinHooks(hooks, project);
  };
  /**
   * Starts the MCP servers (#459): the operator's from beside their settings,
   * and the project's once the operator trusts them as they are now, since
   * they run the project's commands; without that trust only the operator's
   * start. Their configuration errors are noted.
   */
  const startServers = async (): Promise<void> => {
    const { own, project, theirs, hash } = standards.mcp;
    let { config } = standards.mcp;
    let given = standards.mcp.trusted;
    for (const error of config.errors) shell.note(error, "error");
    if (!given) {
      const runs = theirs.map((server) => `${server.name} (${server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url})`);
      const picked = await shell.pick(`This project's MCP servers would start: ${runs.join("; ")}`, [
        { value: "trust", label: "Trust them", description: "kept until they change" },
        { value: "skip", label: "Not now", description: "only your own MCP servers start in this shell" },
      ]);
      given = picked === "trust";
      if (given) trust(standards.root, "mcp", hash);
      else {
        config = readMcpConfig(own, undefined, resolve(options.cwd));
        shell.note("The project's MCP servers do not start in this shell.", "warning");
      }
    }
    if (config.servers.length === 0) return;
    // The MCP client loads only when a server is configured, so a shell without one starts as fast as before.
    const { startMcp } = await import("../mcp.ts");
    // Every workspace reads the same files the operator answered for: the project's only when trusted.
    mcp = { start: startMcp, own, project: given ? project : undefined };
    serversIn(attached.session.workspace.cwd);
  };
  /**
   * `/mcp` (#459): the servers with their state, and for one picked, or named
   * after `login`, `logout` or `reconnect`, that action; a sign-in shows the
   * page to open and waits for the browser's redirect.
   */
  const mcpCommand = async (args: string): Promise<void> => {
    await serversStarted;
    const servers = serversIn(attached.session.workspace.cwd);
    if (servers === undefined) { shell.note("No MCP server is configured: add one under mcpServers in ~/.tesota/mcp.json, or the project's .tesota/mcp.json."); return; }
    const [said, named] = args.split(/\s+/u);
    const asked = said === "" || said === undefined ? await pickServerAction(servers) : { action: said, name: named };
    if (asked === undefined) return;
    if (asked.name === undefined) { shell.note("Name the server: /mcp login <server>, /mcp logout <server> or /mcp reconnect <server>.", "warning"); return; }
    await serverAction(servers, asked.action, asked.name);
  };
  /** A server the operator picks from the list, its error shown, and what to do with it. */
  const pickServerAction = async (servers: McpServers): Promise<{ action: string; name: string } | undefined> => {
    const name = await shell.pick("MCP servers", servers.status().map((server) => ({ value: server.name, label: server.name,
      description: `${server.state} · ${server.tools} ${server.tools === 1 ? "tool" : "tools"}${server.error === undefined ? "" : ` · ${firstLine(server.error)}`}` })));
    const picked = servers.status().find((server) => server.name === name);
    if (picked === undefined) return undefined;
    if (picked.error !== undefined) shell.note(`${picked.name}: ${picked.error}`, picked.state === "connected" ? "muted" : "warning");
    const action = await shell.pick(picked.name, [{ value: "reconnect", label: "Reconnect" },
      ...picked.transport === "http" ? [{ value: "login", label: "Sign in" }, { value: "logout", label: "Sign out" }] : []]);
    return action === undefined ? undefined : { action, name: picked.name };
  };
  /** Reconnects, signs in to or out of the server `name`, and says where it stands then. */
  const serverAction = async (servers: McpServers, action: string, name: string): Promise<void> => {
    try {
      if (action === "reconnect") await servers.reconnect(name);
      else if (action === "login") await servers.signIn(name, (page) => { shell.note(`Open ${page.href} to sign in to ${name}.`); }, new AbortController().signal);
      else if (action === "logout") await servers.signOut(name);
      else { shell.note(`/mcp ${action} is not an MCP action: login, logout or reconnect.`, "warning"); return; }
      const now = servers.status().find((server) => server.name === name);
      shell.note(`${name}: ${now?.state ?? "unknown"}${now?.error === undefined ? "" : ` · ${now.error}`}.`,
        now?.state === "connected" || action === "logout" ? undefined : "warning");
    } catch (error) {
      shell.note(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const commands: Readonly<Record<string, (args: string) => Promise<void>>> = {
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
    "/mcp": async (args) => { await mcpCommand(args); },
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
      const word = text.split(/\s/u)[0] ?? "";
      const run = commands[word];
      if (run === undefined) return false;
      await run(text.slice(word.length).trim());
      return true;
    } });
  if (read.invalid.length > 0) shell.note(`Settings left out as invalid: ${read.invalid.join(", ")}.`, "warning");
  providers = (await credentials.list()).length;
  if (typeof standards.ownHooks === "string") shell.note(`Your hooks were left out: ${standards.ownHooks}`, "error");
  await trustProjectHooks();
  serversStarted = startServers();
  await serversStarted;
  if (model === undefined) shell.note("No provider is logged in: /login, or set a provider's API key, then /model.", "warning");
  await shell.stopped;
  for (const each of lives) {
    each.unsubscribe();
    for (const { refuse } of each.waiting.splice(0)) refuse();
  }
  await Promise.all(lives.map((each) => each.session.dispose()));
  await Promise.all([...workspaces.values()].map((servers) => servers?.close()));
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
