import type { Api, AuthInteraction, CredentialStore, Model, ModelThinkingLevel, MutableModels } from "@earendil-works/pi-ai";
import { getTerminalColorMode, ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tesotaHome } from "../../../../src/home.ts";
import { provideHost } from "../../../../src/host.ts";
import { entryReceipt, isReceipt, isStanding, type Receipt, type ReceiptStanding, receiptStanding, sessionGraphs, standingWords }
  from "../../../../src/receipt.ts";
import { terminalText } from "../../../../src/terminal-text.ts";
import tesota from "../../../../src/tesota.ts";
import { type AccountHands, accountRows, addAccount, type ClaudeCode, claudeOf, removeAccount, signInAgain } from "../accounts.ts";
import { fileCredentialStore } from "../credentials.ts";
import { unusedModels } from "../agents.ts";
import { startingModel } from "../resume-model-rule.ts";
import { accountLabels, chosenModel, loginOptions, runnableModel, runnableModels, shellModels } from "../model-access.ts";
import { claudeCodeProviderId, claudeCodeSignIn } from "../providers/claude-code.ts";
import type { Mode } from "../permission-rule.ts";
import type { HistoryMessage } from "../loop.ts";
import type { McpServers, startMcp } from "../mcp.ts";
import { readMcpConfig } from "../mcp-config.ts";
import { loadRules } from "../permissions.ts";
import { askedSessions, createSession, type EngineSession, firstRequest, openSession, sessionsFolder, type Verifier } from "../session.ts";
import { checkoutRoot } from "../workspace.ts";
import { anyHooks, type Hooks, joinHooks } from "../hooks.ts";
import { lastFloorNotice, peekSessionFile } from "../session-file.ts";
import { readStandards } from "../standards.ts";
import { trust } from "../trust.ts";
import { readSettings, type Settings, updateSettings } from "../settings.ts";
import { pendingUsage, readUsage, type UsageSources } from "../usage.ts";
import { usageSources } from "../usage-sources.ts";
import { Dashboard, type SessionRow } from "./dashboard.ts";
import { UsagePanel, type UsageTab, type UsageView } from "./usage-panel.ts";
import { type Confirmation, type Shell, startShell } from "./shell.ts";
import { diffLines } from "./transcript.ts";
import { createSurface, footerData, shellHost, type Surface } from "./surface.ts";
import { shellTheme } from "../../../../src/theme.ts";
import type { QuestionResponder } from "../questions.ts";

export interface AppOptions {
  readonly cwd: string;
  readonly terminal?: Terminal;
  /** System browser boundary; tests supply a recorder instead of launching a browser. */
  readonly openGraphFile?: (path: string) => Promise<void>;
  readonly openSignInPage?: (url: string) => Promise<void>;
  /** The operator's credentials; the engine's own file when not given. */
  readonly credentials?: CredentialStore;
  /** The models over those credentials; the engine's when not given. */
  readonly models?: MutableModels;
  /** Where the settings live; `~/.tesota/settings.json` when not given. */
  readonly settingsPath?: string;
  /** Where the sessions live; the project's folder under `~/.tesota/sessions` when not given. */
  readonly sessions?: string;
  /** The verifier's flags, by name, as the command line gave them. */
  readonly flags?: Readonly<Record<string, string>>;
  /** Claude Code's sign-in and status in an account's folder (#642); the operator's own Claude Code when not given. */
  readonly claude?: ClaudeCode | undefined;
  /** Where the usage panel reads from; Claude Code's usage report and ChatGPT's usage endpoint when not given. */
  readonly usage?: UsageSources;
}

const levels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const label = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/** Names once the agent types whose model Tesota does not run, with the model they run on instead (#568). */
function noteUnusedModels(shell: Shell, session: EngineSession, model: Model<Api> | undefined): void {
  const unused = model === undefined ? undefined : unusedModels(session.types, label(model));
  if (unused !== undefined) shell.note(unused, "warning");
}

/** How many lines of a command or change a permission question shows before it says how many more there are. */
const shownLines = 12;

function clipped(lines: readonly string[]): string {
  return lines.length <= shownLines ? lines.join("\n") : [...lines.slice(0, shownLines), `… ${lines.length - shownLines} more lines`].join("\n");
}

/**
 * How a permission question reads for `call` (#449): what it would do, as
 * Claude Code and Codex ask it, then the command, the edit's replacements or
 * the file's start in their own block, then why Tesota asks.
 */
export function confirmation(call: { name: string; arguments: unknown }, reason: string): Omit<Confirmation, "items"> {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const path = typeof args["path"] === "string" ? args["path"] : undefined;
  const note = `${reason} Shift+Tab changes the mode.`;
  if (typeof args["command"] === "string") {
    return { title: `Run a ${call.name === "powershell" ? "PowerShell" : "shell"} command?`, body: clipped(args["command"].split("\n")), note };
  }
  if (call.name === "edit" && path !== undefined) {
    return { title: `Edit ${path}?`, body: clipped(diffLines({ arguments: args })), note };
  }
  if (call.name === "write" && path !== undefined) {
    const content = typeof args["content"] === "string" ? args["content"].trimEnd() : "";
    return { title: `Write ${path}?`, body: clipped(content === "" ? [] : content.split("\n")), note };
  }
  return { title: `Use ${call.name}?`, body: JSON.stringify(args), note };
}

/** How many accounts' sign-ins the shell checks at once: for the usage panel, /model and /login (#744). */
const checksAtOnce = 4;

/** On Windows over SSH the inline shell, which the remote terminal draws reliably; otherwise the operator's choice (#432). */
const modeFor = (settings: Settings): "fullscreen" | "inline" =>
  process.platform === "win32" && (process.env["SSH_CONNECTION"] ?? process.env["SSH_CLIENT"]) !== undefined ? "inline"
    : settings.tuiMode ?? "fullscreen";

/**
 * `tesota-core`: the engine's shell in the current folder (#444), on the
 * engine's models and settings, verified by Tesota's gate, with the
 * commands an operator needs every day. Resolves when the shell ends.
 */
export async function runApp(options: AppOptions): Promise<void> {
  const credentials = options.credentials ?? fileCredentialStore();
  const read = readSettings(options.settingsPath);
  let settings = read.settings;
  // Only the providers the saved model and accounts are built on before the first frame; the rest of the catalog right after (#743).
  const { models, rest } = options.models === undefined ? await shellModels(credentials, settings.accounts ?? [], settings.model)
    : { models: options.models, rest: () => Promise.resolve() };
  // Another Tesota may have saved since this one started: only what changed here is written over it (#453).
  const save = (change: Partial<Settings>): void => {
    settings = { ...settings, ...change };
    updateSettings(change, options.settingsPath);
  };
  const folder = options.sessions ?? sessionsFolder(options.cwd);
  // Tesota's interface takes the shell's editor, key names, version and shell, never Pi's (#446).
  provideHost(shellHost(options.settingsPath));
  const theme = shellTheme("dark", getTerminalColorMode());
  const verifier: Verifier = (pi, request) => { tesota(pi, request); };
  let providers = 0;
  let model = chosenModel(models, settings);
  let permissionMode: Mode = settings.permissionMode ?? "ask";
  const rules = loadRules(options.cwd);
  /** The operator's answer to a call the mode and rules leave to them (#449): once, for this session, or no. */
  const answer = async (call: { name: string; arguments: unknown }, reason: string): Promise<"once" | "session" | "deny"> => {
    const picked = await shell.confirm({ ...confirmation(call, reason), items: [
      { value: "once", label: "Yes" },
      { value: "session", label: "Yes, and don't ask again this session" },
      { value: "deny", label: "No  (esc)" },
    ] });
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
  /** The shell callback bound to one live session: hidden questions register without blocking `attach`. */
  const questionsFor = (live: Live): QuestionResponder => (asked, submit, finish) => {
    live.pendingQuestions++;
    live.state = "waiting";
    showStatuses();
    shell.redraw();
    const release = shell.askUser(live.session, asked, submit, finish);
    return () => {
      release();
      live.pendingQuestions = Math.max(0, live.pendingQuestions - 1);
      if (live.pendingQuestions === 0 && live.waiting.length === 0 && live.state === "waiting") {
        live.state = "working";
        if (live === attached) shell.busy("working");
      }
      showStatuses();
      shell.redraw();
    };
  };
  const sessionOptions = (live: Live) => ({ models, model: model ?? models.getModels()[0] as Model<Api>, verifier, surface: live.surface,
    hooks: () => hooks, mcp: () => serversIn(live.session.workspace.cwd), ...options.flags === undefined ? {} : { flags: options.flags },
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
    } }, questions: questionsFor(live),
    ...settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel },
    ...settings.agentLimit === undefined ? {} : { agentLimit: settings.agentLimit },
    ...settings.subagentBranchGuard === undefined ? {} : { branchGuard: settings.subagentBranchGuard } });
  /** A session the shell runs, made by `open` with its own surface, and followed for the dashboard. */
  const live = (open: (made: Live) => EngineSession): Live => {
    const made = { surface: createSurface(theme), state: "idle", startedAt: Date.now(), waiting: [], pendingQuestions: 0 } as unknown as Live;
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
    const last = made.session.history().findLast((message) => message.role === "custom" && entryReceipt({ ...message, type: "custom_message" }) !== undefined);
    const held = last?.role === "custom" ? entryReceipt({ ...last, type: "custom_message" }) : undefined;
    if (isReceipt(held)) made.verification = receiptStanding(held as Receipt); else delete made.verification;
    made.unsubscribe = made.session.subscribe((event) => {
      if (event.type === "state") made.state = made.waiting.length > 0 || made.pendingQuestions > 0 ? "waiting" : event.state === "settling" ? "verifying" : "working";
      else if (event.type === "ended") {
        made.state = "ended";
        made.outcome = event.outcome;
        if (made !== attached) shell.note(`“${firstLine(made.request)}” ended ${event.outcome}${made.verification === undefined ? "" : `, ${standingWords[made.verification]}`}.`);
        // What the floor refused shows at every request's end, whatever else happened (#622).
        const refused = lastFloorNotice(peekSessionFile(made.session.file).entries);
        if (refused !== undefined) shell.note(refused.trimEnd());
      } else if (event.type === "job") follows(made, event.details);
      else if (event.type === "message") {
        made.request ??= made.session.ledger()[0]?.text;
        const receipt = event.message.role === "custom" ? entryReceipt({ ...event.message, type: "custom_message" }) : undefined;
        if (isReceipt(receipt)) made.verification = receiptStanding(receipt as Receipt);
      }
    });
  };
  /** The subagents the shell's sessions started (#525), by their session's file, as their jobs last said, for the dashboard. */
  const children = new Map<string, { readonly parent: Live; readonly row: SessionRow }>();
  const follows = (parent: Live, details: unknown): void => {
    const { session, description, outcome, verification, branch, writes } = (details ?? {}) as Record<string, unknown>;
    if (typeof session !== "string") return;
    const ended = outcome !== "running";
    children.set(session, { parent, row: { id: session, request: `↳ ${String(description ?? "")}`, state: ended ? "ended" : "working",
      ...ended ? { outcome: String(outcome) } : {},
      ...isStanding(verification) ? { verification } : {},
      workspace: typeof branch === "string" ? branch : writes === true ? "its worktree" : "reads", attached: false,
      startedAt: children.get(session)?.row.startedAt ?? Date.now() } });
  };
  /** Shows `next`, then puts the questions it held to the operator, in the order they came. */
  const attach = async (next: Live): Promise<void> => {
    attached = next;
    showStatuses();
    shell.show(next.session, next.surface, next.state === "working" ? "working" : next.state === "verifying" ? "settling" : undefined);
    for (const { put } of next.waiting.splice(0)) await put();
    if (next.state === "waiting" && next.pendingQuestions === 0 && next.waiting.length === 0) {
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
   * work. Closing it again while it closes does nothing. Another session is
   * shown in its place, unless the caller shows one next (`replace` false).
   */
  const close = async (gone: Live, replace = true): Promise<void> => {
    const at = lives.indexOf(gone);
    if (at < 0) return;
    lives.splice(at, 1);
    gone.unsubscribe();
    shell.cancelQuestions(gone.session, "The session was closed.");
    for (const { refuse } of gone.waiting.splice(0)) refuse();
    await gone.session.dispose();
    const kept = gone.session.kept();
    if (gone === attached && replace) await attach(lives[0] ?? live((made) => createSession({ cwd: options.cwd, folder, ...sessionOptions(made) })));
    if (kept !== undefined) shell.note(kept, "warning");
  };
  /** The resumed session's model, or the current model with a warning when the recorded one cannot run. */
  const modelForResume = async (picked: string): Promise<Awaited<ReturnType<typeof runnableModel>> | undefined> => {
    const last = peekSessionFile(picked).entries.findLast((entry) => entry.type === "assistant")?.message;
    const lastModel = last === undefined ? "" : `${last.provider}/${last.model}`;
    const chosen = startingModel("", lastModel, model === undefined ? "" : label(model));
    if (lastModel === "") return model === undefined ? undefined : { model };
    const next = await runnableModel(models, chosen);
    if (typeof next !== "string") return next;
    const reason = `The session last ran on ${lastModel}, which cannot run now: ${next}`;
    return model === undefined ? `${reason} No current model to continue on; choose one with /model.`
      : { model, unchecked: `${reason} Continuing on ${label(model)}. Use /model to choose another.` };
  };
  /**
   * Opens the session in `picked` and shows it (#595). `holder`, the session
   * that holds its checkout, is closed first: kept resumable, or deleted if it
   * was never asked anything.
   */
  const resumeHere = async (picked: string, holder?: Live): Promise<void> => {
    try {
      const next = await modelForResume(picked);
      if (typeof next === "string") {
        shell.note(`Not resumed: ${next}`, "warning");
        return;
      }
      if (holder !== undefined && lives.includes(holder)) {
        const asked = firstRequest(holder.session.file) !== undefined;
        await close(holder, false);
        if (!asked) for (const file of [holder.session.file, holder.session.file.replace(/\.jsonl$/u, ".lock")]) rmSync(file, { force: true });
      }
      const resumed = live((made) => openSession(picked, { ...sessionOptions(made), ...next === undefined ? {} : { model: next.model } }));
      const previous = model === undefined ? "" : label(model);
      await attach(resumed);
      model = next?.model;
      shell.redraw();
      if (next?.unchecked !== undefined) shell.note(next.unchecked, "warning");
      if (next !== undefined && label(next.model) !== previous) shell.note(`Continuing on ${label(next.model)}. Use /model to choose another.`);
    } catch (error) {
      shell.note(error instanceof Error ? error.message : String(error), "warning");
      if (!lives.includes(attached)) await attach(lives[0] ?? live((made) => createSession({ cwd: options.cwd, folder, ...sessionOptions(made) })));
    }
  };
  attached = live((made) => createSession({ cwd: options.cwd, folder, ...sessionOptions(made) }));
  showStatuses();
  const status = (): string => [model === undefined ? "no model: /login, then /model" : label(model),
    ...settings.thinkingLevel === undefined || settings.thinkingLevel === "off" ? [] : [settings.thinkingLevel]].join(" · ");

  let shell: Shell;
  const terminal = options.terminal ?? new ProcessTerminal();
  const mode = modeFor(settings);
  /**
   * `/graph` (#592): a graph the shown session captured, newest first or by its name, read through step 3a's
   * disposable worker. It opens full-screen over the shell; with `--plain`, or in a terminal that cannot hold a full
   * screen, its text rendering is appended to the conversation instead.
   */
  const graphCommand = async (args: string): Promise<void> => {
    const words = args.split(/\s+/u).filter((word) => word !== "");
    const plain = words.includes("--plain");
    if (words.filter(word => word !== "--plain").length > 1 || words.some(word => word.startsWith("--") && word !== "--plain")) {
      shell.note("Use: /graph [--plain] [name]", "warning"); return;
    }
    const named = words.find((word) => word !== "--plain");
    const graphs = sessionGraphs(attached.session.history());
    const stem = (manifest: string): string => basename(manifest).replace(/\.manifest\.json$/u, "");
    const graph = graphs.flatMap(({ subject, capture }) => capture?.status === "captured" ? [{ subject, manifest: capture.manifest }] : [])
      .find(({ manifest }) => named === undefined || stem(manifest) === named);
    if (graph === undefined) {
      const newest = graphs[0];
      shell.note(named !== undefined ? `No captured graph ${terminalText(named)} in this session.`
        : newest === undefined ? "No captured graph in this session: a model check with TLC captures one."
          : newest.capture === undefined || newest.capture.status === "captured" ? "Graph unavailable: no capture" : `Graph ${newest.capture.status}: ${terminalText(newest.capture.reason)}`,
      "warning");
      return;
    }
    const [{ appendOnlyText, fitsFullScreen, fullScreen, ModelViewer }, { loadModelView, writeModelViewHtml, openBrowser }] =
      await Promise.all([import("./model-viewer.ts"), import("../../../../src/model-view-process.ts")]);
    if (plain || mode === "inline" || !fitsFullScreen(terminal.columns, terminal.rows)) {
      try { shell.note(appendOnlyText(await loadModelView(graph.manifest, {}, new AbortController().signal), graph.manifest)); } catch (error) {
        shell.note(terminalText(error instanceof Error ? error.message : String(error)), "warning");
        return;
      }
      // Said last, beside the prompt, where a short terminal still shows it.
      if (!plain) shell.note(`The graph is above as text: this terminal cannot hold the full-screen viewer (the fullscreen shell, at least ${fullScreen.columns}×${fullScreen.rows}).`);
      return;
    }
    let hide = (): void => undefined;
    hide = shell.overlay(new ModelViewer({ theme, subject: graph.subject, rows: () => terminal.rows,
      load: (request, signal) => loadModelView(graph.manifest, request, signal),
      browser: async (signal, written) => {
        const path = await writeModelViewHtml(graph.manifest, signal);
        written(path);
        if (signal.aborted) return;
        await (options.openGraphFile ?? openBrowser)(path);
      }, close: () => { hide(); }, redraw: () => { shell.redraw(); } }));
  };
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
  const rows = (): SessionRow[] => [...lives.map((each) => ({
    id: each.session.file, request: each.request ?? "", state: each.state, ...each.outcome === undefined ? {} : { outcome: each.outcome },
    ...each.verification === undefined ? {} : { verification: each.verification },
    workspace: each.session.workspace.branch ?? "checkout", startedAt: each.startedAt, attached: each === attached,
  })), ...[...children.values()].filter(({ parent }) => lives.includes(parent)).map(({ row }) => row)];
  /** Opens the dashboard over the shell (#455), until a session is attached or the operator goes back. */
  const agents = (): void => {
    const byId = (id: string): Live | undefined => lives.find((each) => each.session.file === id);
    let hide = (): void => undefined;
    const dashboard = new Dashboard(theme, rows, {
      attach: (id) => {
        hide();
        const next = byId(id);
        if (next !== undefined) void attach(next);
        // A subagent's session is its parent's job until it ends; then it opens like any other (#525).
        else if (children.has(id)) shell.note(`That is a subagent's session: once it ends, /resume opens it (${basename(id)}).`);
      },
      peek: (id) => peekLines(byId(id)?.session.history() ?? childHistory(id)),
      create: () => { hide(); void commands["/new"]?.run(""); },
      close: (id) => { const gone = byId(id); if (gone !== undefined) void close(gone).then(() => { shell.redraw(); }); },
      back: () => { hide(); },
    });
    hide = shell.overlay(dashboard);
  };
  const interaction: AuthInteraction = {
    prompt: async (prompt) => {
      const answer = prompt.type === "select" ? await shell.pick(prompt.message, prompt.options.map(({ id, label, description }) =>
        ({ value: id, label, ...description === undefined ? {} : { description } })))
        : await shell.ask(prompt.message, { secret: prompt.type === "secret", ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder } });
      if (answer === undefined) throw new Error("Login cancelled");
      return answer;
    },
    notify: (event) => {
      if (event.type !== "auth_url" && event.type !== "device_code") shell.note(event.message);
    },
  };
  const browserSignIn = <T,>(work: (interaction: AuthInteraction) => Promise<T>): Promise<T> => shell.handOver(async () => {
    const { terminalSignIn } = await import("./sign-in.ts");
    return terminalSignIn(work, { terminal, ...options.openSignInPage === undefined ? {} : { open: options.openSignInPage } });
  });
  const claude = claudeOf(options.claude);
  /** The accounts as this shell manages them (#642): Claude Code's sign-in gets the terminal while it runs. */
  const hands: AccountHands = { settingsPath, models, credentials, interaction, cwd: options.cwd,
    claude: { signIn: (at) => shell.handOver(() => claude.signIn(at)), status: claude.status } };
  /** Runs an account's step, says what it did or why not, and keeps this shell's list of accounts as the settings now say. */
  const accountStep = async (step: () => Promise<string>): Promise<void> => {
    try { shell.note(await step()); } catch (error) { shell.note(error instanceof Error ? error.message : String(error), "warning"); }
    const { accounts } = readSettings(settingsPath).settings;
    settings = { ...settings, ...accounts === undefined ? {} : { accounts } };
  };
  /** Adds an account in one step (#642): a provider, a name, and its own sign-in. */
  const addAnAccount = async (): Promise<void> => {
    const provider = await shell.pick("Account of", [
      { value: "claude-code", label: "Claude Code", description: "signs in with your own Claude Code, in a folder of its own" },
      { value: "openai-codex", label: "ChatGPT", description: "signs in to ChatGPT for this account alone" },
    ]);
    if (provider === undefined) return;
    const name = await shell.ask("Name the account: letters, digits, _ or -", { placeholder: "work" });
    if (name === undefined || name.trim() === "") return;
    await accountStep(() => provider === "openai-codex" ? browserSignIn((interaction) => addAccount({ ...hands, interaction }, provider, name.trim())) : addAccount(hands, provider, name.trim()));
  };
  /** An account picked in the usage panel (#642): signed in again or removed. */
  const manageAccount = async (id: string): Promise<void> => {
    const action = await shell.pick(id, [{ value: "login", label: "Sign in again" }, { value: "remove", label: "Remove" }]);
    if (action === "login") await accountStep(() => id.startsWith("openai-codex") ? browserSignIn((interaction) => signInAgain({ ...hands, interaction }, id)) : signInAgain(hands, id));
    else if (action === "remove") await accountStep(() => removeAccount(hands, id));
  };
  /**
   * `/usage` and `/accounts`: one panel over the session, with a tab for how much each account has left and one for the accounts
   * (#642), opened on the tab the command names. Its readings are read and time-limited off the session's path.
   */
  const usagePanel = (tab: UsageTab): Promise<void> => {
    let hide = (): void => undefined;
    const view: UsageView = { accounts: (signal, onUpdate) => accountRows(hands, model?.provider, { concurrency: checksAtOnce, signal, onUpdate }),
      pending: (accounts) => pendingUsage(accounts),
      read: (accounts, onEach, signal) => readUsage(accounts, options.usage ?? usageSources(models), { onEach, signal }),
      openaiChatGPT: async () => (await models.checkAuth("openai"))?.type === "oauth" };
    const panel = new UsagePanel({ theme, view, tab, session: () => model?.provider, rows: () => terminal.rows, redraw: () => { shell.redraw(); },
      actions: { close: () => { hide(); }, manage: (id) => { hide(); void manageAccount(id); }, add: () => { hide(); void addAnAccount(); } } });
    hide = shell.panel("Usage", panel);
    void panel.start();
    return Promise.resolve();
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
      else if (action === "login") {
        await shell.handOver(async () => {
          const { terminalSignIn } = await import("./sign-in.ts");
          await terminalSignIn(async (_interaction, show, signal) => servers.signIn(name, (page) => { show(page.href); }, signal),
            { terminal, ...options.openSignInPage === undefined ? {} : { open: options.openSignInPage } });
        });
      }
      else if (action === "logout") await servers.signOut(name);
      else { shell.note(`/mcp ${action} is not an MCP action: login, logout or reconnect.`, "warning"); return; }
      const now = servers.status().find((server) => server.name === name);
      shell.note(`${name}: ${now?.state ?? "unknown"}${now?.error === undefined ? "" : ` · ${now.error}`}.`,
        now?.state === "connected" || action === "logout" ? undefined : "warning");
    } catch (error) {
      shell.note(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const commands: Readonly<Record<string, { description: string; argumentHint?: string; run: (args: string) => Promise<void> }>> = {
    "/model": { description: "Choose the model", run: async () => {
      // The labels are checked while the models are, so a Claude Code folder's two checks share one run (#744).
      const labels = accountLabels(credentials, settings.accounts ?? [], claude.status, { concurrency: checksAtOnce });
      let available: readonly Model<Api>[];
      try { available = await runnableModels(models); } catch (error) {
        void labels.catch(() => undefined);
        shell.note(`No models to choose from: ${error instanceof Error ? error.message : String(error)}.`, "warning");
        return;
      }
      // Claude Code signs in by itself, never through Tesota's /login (#546).
      if (models.getProvider(claudeCodeProviderId) !== undefined && !available.some(({ provider }) => provider === claudeCodeProviderId)) {
        shell.note(claudeCodeSignIn);
      }
      const accounts = await labels;
      for (const [id, account] of accounts) {
        if (id.startsWith("claude-code@") && !available.some(({ provider }) => provider === id)) {
          shell.note(`${id}: ${account}. Sign it in again with /accounts.`);
        }
      }
      if (available.length === 0) { shell.note("No provider is logged in: /login first, or set its API key.", "warning"); return; }
      const picked = await shell.pick("Model", available.map((candidate) => ({ value: label(candidate), label: label(candidate),
        description: accounts.get(candidate.provider) ?? "" })));
      const next = available.find((candidate) => label(candidate) === picked);
      if (next === undefined) return;
      model = next;
      save({ model: label(next) });
      await reopen();
      shell.note(`Model: ${label(next)}.`);
    } },
    "/login": { description: "Sign in to a model provider", run: async () => {
      // The one list read before an async use: the whole catalog is loaded first (#743).
      await rest();
      const providers = models.getProviders().filter(({ auth }) => auth.oauth !== undefined || auth.apiKey?.login !== undefined);
      const accounts = await accountLabels(credentials, settings.accounts ?? [], claude.status, { concurrency: checksAtOnce });
      const picked = await shell.pick("Log in to", [{ value: "", label: "Add an account", description: "Claude Code or ChatGPT, under a name" },
        ...providers.map(({ id, name }) => ({ value: id, label: name, description: accounts.get(id) ?? "" }))]);
      if (picked === "") { await addAnAccount(); return; }
      const provider = providers.find(({ id }) => id === picked);
      if (provider === undefined) return;
      const type = provider.auth.oauth !== undefined && provider.auth.apiKey?.login !== undefined
        ? await shell.pick("With", [{ value: "oauth", label: provider.auth.oauth.name }, { value: "api_key", label: "API key" }])
        : provider.auth.oauth !== undefined ? "oauth" : "api_key";
      if (type !== "oauth" && type !== "api_key") return;
      try {
        const login = (interaction: AuthInteraction) => models.login(provider.id, type, interaction, loginOptions(options.settingsPath));
        if (type === "oauth") await browserSignIn(login);
        else await login(interaction);
        shell.note(model === undefined ? `Logged in to ${provider.name}. Choose a model with /model.` : `Logged in to ${provider.name}.`);
      } catch (error) {
        shell.note(error instanceof Error ? error.message : String(error), "error");
      }
    } },
    "/usage": { description: "How much each account has left", run: () => usagePanel("usage") },
    "/accounts": { description: "Your accounts: add, sign in again, remove", run: () => usagePanel("accounts") },
    "/logout": { description: "Forget a provider's sign-in", run: async () => {
      const stored = await credentials.list();
      if (stored.length === 0) { shell.note("No provider is logged in."); return; }
      const picked = await shell.pick("Log out of", stored.map(({ providerId, type }) => ({ value: providerId, label: providerId,
        description: type === "oauth" ? "signed in" : "API key" })));
      if (picked === undefined) return;
      await models.logout(picked);
      shell.note(`Logged out of ${picked}.`);
    } },
    // A new session runs beside the others, in its own worktree when another holds the checkout (#453, #455).
    "/new": { description: "Start another session beside this one", run: async () => {
      try {
        await attach(live((made) => createSession({ cwd: options.cwd, folder, ...sessionOptions(made) })));
      } catch (error) {
        shell.note(error instanceof Error ? error.message : String(error), "warning");
      }
    } },
    "/resume": { description: "Open an earlier session", run: async () => {
      const running = new Set(lives.map((each) => each.session.file));
      const asked = askedSessions(folder).filter(({ file }) => !running.has(file));
      if (asked.length === 0) { shell.note("No other session in this folder."); return; }
      const picked = await shell.pick("Resume", asked.map(({ file, request }) => ({ value: file, label: request,
        description: basename(file).slice(0, 19) })));
      if (picked === undefined) return;
      const recorded = peekSessionFile(picked).header;
      const holder = recorded.worktree !== undefined ? undefined : lives.find((each) => each.session.workspace.worktree === undefined
        && sameFolder(checkoutRoot(each.session.workspace.cwd), checkoutRoot(recorded.cwd)));
      if (holder === undefined) { await resumeHere(picked); return; }
      // The session that holds the checkout hands it over once it has no running work (#595).
      const named = `“${firstLine(holder.request)}”`;
      if (holder.state === "idle" || holder.state === "ended") { await resumeHere(picked, holder); return; }
      const wait = await shell.pick(`${named} is running in ${recorded.cwd}, which this session needs`,
        [{ value: "wait", label: "Resume when it is idle" }, { value: "cancel", label: "Cancel" }]);
      if (wait !== "wait") return;
      shell.note(`Will resume the session when ${named} ends.`);
      const stop = holder.session.subscribe((event) => {
        if (event.type !== "ended") return;
        stop();
        void resumeHere(picked, holder);
      });
    } },
    "/agents": { description: "Open the sessions dashboard", run: () => { agents(); return Promise.resolve(); } },
    "/graph": { description: "Open a model graph a receipt captured", argumentHint: "[--plain] [name]", run: graphCommand },
    "/settings": { description: "Change terminal mode and thinking", run: async () => {
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
    } },
    "/compact": { description: "Summarize the older conversation", run: async () => {
      shell.note("Compacting…");
      await attached.session.compact().catch((error: unknown) => { shell.note(error instanceof Error ? error.message : String(error), "warning"); });
    } },
    "/mcp": { description: "Manage MCP servers", argumentHint: "[login|logout|reconnect <server>]", run: async (args) => { await mcpCommand(args); } },
    "/quit": { description: "End the shell", run: () => { shell.stop(); return Promise.resolve(); } },
  };

  shell = startShell({ terminal, mode,
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
    commands: Object.entries(commands).map(([name, command]) => ({ name: name.slice(1), ...command })),
    command: async (text) => {
      const word = text.split(/\s/u)[0] ?? "";
      const command = commands[word];
      if (command === undefined) return false;
      await command.run(text.slice(word.length).trim());
      return true;
    } });
  // The first frame is drawn: the rest of the catalog loads now, while the shell starts its hooks and servers (#743).
  // A failure stays for the uses that wait on it, where it is reported, not as an unhandled rejection here.
  rest().catch(() => undefined);
  if (read.invalid.length > 0) shell.note(`Settings left out as invalid: ${read.invalid.join(", ")}.`, "warning");
  providers = (await credentials.list()).length;
  if (typeof standards.ownHooks === "string") shell.note(`Your hooks were left out: ${standards.ownHooks}`, "error");
  await trustProjectHooks();
  serversStarted = startServers();
  await serversStarted;
  // A saved model the sign-in does not serve is refused before the first request (#566).
  const saved = model === undefined ? undefined : await runnableModel(models, label(model));
  if (typeof saved === "string") {
    model = undefined;
    await reopen();
    shell.note(`The saved model is not used: ${saved} Choose one with /model.`, "warning");
  } else if (saved?.unchecked !== undefined) shell.note(saved.unchecked, "warning");
  else if (model === undefined) shell.note("No provider is logged in: /login, or set a provider's API key, then /model.", "warning");
  noteUnusedModels(shell, attached.session, model);
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
  verification?: ReceiptStanding;
  request?: string | undefined;
  readonly startedAt: number;
  /** Questions it holds for the operator: put when it is shown, refused when it closes. */
  readonly waiting: { readonly put: () => Promise<void>; readonly refuse: () => void }[];
  /** Native clarification callbacks waiting for their session's live run. */
  pendingQuestions: number;
  unsubscribe: () => void;
}

/** Whether two folders are the same, as the platform compares names. */
const sameFolder = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

const firstLine = (text: string | undefined): string => (text ?? "").split("\n")[0]?.trim() || "new session";

/** What a subagent's session file holds so far (#525): its request and replies, for the dashboard to peek at. */
function childHistory(file: string): HistoryMessage[] {
  try {
    return peekSessionFile(file).entries.flatMap((entry): HistoryMessage[] => entry.type === "request"
      ? [{ role: "user", content: entry.text, timestamp: 0 }] : entry.type === "assistant" ? [entry.message] : []);
  } catch { return []; }
}

/** A session's last lines as the dashboard peeks at them: what was asked and answered, in plain text. */
function peekLines(history: readonly HistoryMessage[]): string[] {
  return history.flatMap((message) => {
    if (message.role === "user") return typeof message.content === "string" ? [`> ${message.content}`] : [];
    if (message.role !== "assistant") return [];
    return message.content.flatMap((part) => part.type === "text" ? [part.text] : part.type === "toolCall" ? [`· ${part.name}`] : []);
  }).flatMap((text) => text.split("\n")).slice(-10);
}
