import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ShellTheme } from "../../../../src/theme.ts";
import type { AccountRow } from "../accounts.ts";
import type { RoleRow } from "../roles.ts";
import { type AccountUsage, bar, span, USAGE_SOURCES_NOTE, type UsageMeter, type UsageReading } from "../usage.ts";
import { meterTone, shownPercent } from "../usage-rule.ts";

export type UsageTab = "usage" | "accounts" | "roles";
const tabs: readonly { readonly tab: UsageTab; readonly title: string }[] = [{ tab: "usage", title: "Usage" }, { tab: "accounts", title: "Accounts" },
  { tab: "roles", title: "Roles" }];
export const ROLES_NOTE: string = "Change a verification role's model with its flag or setting (openCasesModel, claimcheckModel), an agent type's in its file "
  + "(/agents types), and the session's with /model.";

/** What the operator can do from the panel; managing an account closes it first, since the choice that follows is the shell's own. */
export interface UsageActions {
  close(): void;
  /** Sign the declared account `id` in again, or remove it. */
  manage(id: string): void;
  add(): void;
}

/** What the panel shows, read by the shell. Each stops, and lets go of what it started, when `signal` aborts. */
export interface UsageView {
  /**
   * The accounts: every row `tesota accounts` lists, and the session's own
   * sign-in, told to `onUpdate` at once with their sign-ins being checked,
   * then again as each check returns.
   */
  accounts(signal: AbortSignal, onUpdate: (accounts: readonly AccountRow[]) => void): Promise<readonly AccountRow[]>;
  /** These accounts as being read, with the saved readings that may stand for them. */
  pending(accounts: readonly AccountRow[]): readonly AccountUsage[];
  /** Reads them, telling `onEach` of each as it arrives. */
  read(accounts: readonly AccountRow[], onEach: (usage: AccountUsage) => void, signal: AbortSignal): Promise<unknown>;
  /** Whether OpenAI is signed in with ChatGPT (OAuth, not an API key), whose limits no source reads. */
  openaiChatGPT(): Promise<boolean>;
  /** Each role with the model it runs on, read when the panel opens. */
  roles(): readonly RoleRow[];
}

/** The `openai` provider id, on which a session can draw on ChatGPT without any account whose limits the panel reads. */
const OPENAI = "openai";
export const OPENAI_ROUTE_NOTE = "ChatGPT through the OpenAI sign-in doesn't report its limits. A Codex sign-in does: /login, then OpenAI Codex (legacy).";

export interface UsagePanelOptions {
  readonly theme: ShellTheme;
  readonly view: UsageView;
  readonly actions: UsageActions;
  /** The provider the shell's session draws on, whose account is marked. */
  readonly session: () => string | undefined;
  readonly rows: () => number;
  readonly redraw: () => void;
  readonly now?: () => number;
  readonly tab?: UsageTab;
}

const providerNames: Readonly<Record<AccountRow["provider"], string>> = { "claude-code": "Claude Code", "openai-codex": "ChatGPT" };
/**
 * The rows the body does not get: the tabs, a rule, a blank row above the
 * hint and the hint; the dialog's title, the blank row above it and the
 * footer; and three rows of the session above.
 */
const CHROME_ROWS = 10;

/** A role's row on the Roles tab, each cell painted. */
interface RoleCells { readonly role: string; readonly model: string; readonly from: string; readonly account: string; readonly left: string }
const SEGMENTS = [20, 10, 5] as const;

/**
 * The shell's usage panel: how much each account has left, the accounts
 * themselves, and the account each role draws on, in three tabs of a dialog
 * in the input's place, under the session, which keeps running above it.
 * It opens at once on the saved readings and replaces each as it is read;
 * nothing in it is written to the session's transcript.
 */
export class UsagePanel implements Component, Focusable {
  focused = false;
  readonly #options: UsagePanelOptions;
  readonly #now: () => number;
  #tab: UsageTab;
  #accounts: readonly AccountRow[] | undefined;
  #problem: string | undefined;
  #usage = new Map<string, AccountUsage>();
  #openaiChatGPT = false;
  #roles: readonly RoleRow[];
  #selected = 0;
  #scroll = 0;
  /** What stops the current round of reads: a new round, or closing the panel. */
  #round: AbortController | undefined;

  constructor(options: UsagePanelOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#tab = options.tab ?? "usage";
    this.#roles = options.view.roles();
  }

  get tab(): UsageTab { return this.#tab; }

  /**
   * Lists the accounts and their saved readings at once, fills in each
   * sign-in as it is checked, then reads each again. A round still going is
   * stopped first, so only this one is shown or saved.
   */
  async start(): Promise<void> {
    this.#round?.abort();
    const round = new AbortController();
    this.#round = round;
    const { signal } = round;
    const { view, redraw } = this.#options;
    const shown = (accounts: readonly AccountRow[]): void => {
      this.#accounts = accounts;
      this.#problem = undefined;
      this.#selected = Math.min(this.#selected, Math.max(0, accounts.length - 1));
      this.#usage = new Map(view.pending(accounts).map((usage) => [usage.id, usage]));
      redraw();
    };
    void view.openaiChatGPT().then((signedIn) => {
      if (signal.aborted || signedIn === this.#openaiChatGPT) return;
      this.#openaiChatGPT = signedIn;
      redraw();
    }, () => undefined);
    try {
      const accounts = await view.accounts(signal, (listed) => { if (!signal.aborted) shown(listed); });
      if (signal.aborted) return;
      shown(accounts);
      await view.read(accounts, (usage) => {
        if (signal.aborted) return;
        this.#usage.set(usage.id, usage);
        redraw();
      }, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.#problem = error instanceof Error ? error.message : String(error);
      redraw();
    }
  }

  /** Closing the panel stops its reads. */
  dispose(): void { this.#round?.abort(); }
  invalidate(): void {}

  handleInput(data: string): void {
    const { actions } = this.#options;
    if (matchesKey(data, "escape")) { actions.close(); return; }
    const turn = matchesKey(data, "tab") || matchesKey(data, "right") ? 1 : matchesKey(data, "shift+tab") || matchesKey(data, "left") ? -1 : 0;
    if (turn !== 0) {
      const at = tabs.findIndex(({ tab }) => tab === this.#tab);
      this.#tab = tabs[(at + turn + tabs.length) % tabs.length]?.tab ?? "usage";
      this.#scroll = 0;
      this.#options.redraw();
      return;
    }
    if (data === "r" || data === "R") { void this.start(); return; }
    const step = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : matchesKey(data, "pageUp") ? -5 : matchesKey(data, "pageDown") ? 5 : 0;
    if (this.#tab === "accounts") this.#accountKey(data, step);
    else this.#scroll = Math.max(0, this.#scroll + step);
    this.#options.redraw();
  }

  /** On the Accounts tab, ↑↓ choose an account, Enter manages a declared one, and `a` adds one. */
  #accountKey(data: string, step: number): void {
    const { actions } = this.#options;
    const count = this.#accounts?.length ?? 0;
    if (step !== 0 && count > 0) this.#selected = Math.max(0, Math.min(count - 1, this.#selected + Math.sign(step)));
    const chosen = matchesKey(data, "enter") ? this.#accounts?.[this.#selected] : undefined;
    if (chosen !== undefined && chosen.default !== true) actions.manage(chosen.id);
    else if (data === "a" || data === "A") actions.add();
  }

  render(width: number): string[] {
    const { theme } = this.#options;
    const inner = Math.max(10, width);
    const usage = this.#usageBody(inner);
    const accounts = this.#accountsList(inner);
    const roles = this.#rolesBody(inner);
    const room = Math.max(3, this.#options.rows() - CHROME_ROWS);
    // As tall as the tallest tab, so switching never moves the frame, and no taller than the terminal allows.
    const height = Math.min(room, Math.max(usage.length, accounts.length, roles.length));
    let body: string[];
    let more = "";
    if (this.#tab === "accounts") {
      // Scrolls to keep the chosen account in view.
      const at = this.#rowStarts(inner)[this.#selected] ?? 0;
      const offset = Math.max(0, Math.min(accounts.length - height, at - Math.max(0, height - 4)));
      body = accounts.slice(offset, offset + height);
      more = accounts.length > offset + height ? `  ↓ ${accounts.length - offset - height} more` : "";
    } else {
      const shown = this.#tab === "roles" ? roles : usage;
      this.#scroll = Math.min(this.#scroll, Math.max(0, shown.length - height));
      body = shown.slice(this.#scroll, this.#scroll + height);
      more = shown.length > this.#scroll + height ? `  ↓ ${shown.length - this.#scroll - height} more` : "";
    }
    // The dialog's frame gives the title; the hint is the last row.
    const lines = [this.#tabRow(inner), theme.fg("dim", "─".repeat(inner)), ...body,
      ...Array.from({ length: height - body.length }, () => ""), "",
      ...wrapTextWithAnsi(theme.fg("dim", `${this.#hint()}${more}`), inner)];
    return lines.map((line) => truncateToWidth(line, inner));
  }

  #hint(): string {
    const common = "Tab/←→ switch · r read again · Esc close";
    return this.#tab === "accounts" ? `↑↓ choose · Enter sign in again or remove · a add an account · ${common}` : `↑↓ scroll · ${common}`;
  }

  /**
   * The tabs, the open one bracketed on the selected background, which still
   * marks it without colors, and the other muted; on the right how many
   * readings are in.
   */
  #tabRow(inner: number): string {
    const { theme } = this.#options;
    const row = tabs.map(({ tab, title }) => tab === this.#tab ? theme.bg("selectedBg", theme.bold(theme.fg("text", `[ ${title} ]`)))
      : theme.fg("muted", `  ${title}  `)).join(" ");
    const waiting = [...this.#usage.values()].filter((usage) => usage.state === "reading").length;
    const state = this.#tab !== "accounts" && waiting > 0 ? theme.fg("dim", `reading ${this.#usage.size - waiting} of ${this.#usage.size}…`) : "";
    const gap = inner - visibleWidth(row) - visibleWidth(state);
    return gap >= 2 ? `${row}${" ".repeat(gap)}${state}` : row;
  }

  // ---- the Usage tab

  #usageBody(inner: number): string[] {
    const { theme } = this.#options;
    if (this.#problem !== undefined) return wrapTextWithAnsi(theme.fg("warning", `The accounts could not be read: ${this.#problem}. Press r to try again.`), inner);
    const accounts = this.#accounts;
    if (accounts === undefined) return [theme.fg("muted", "Reading the accounts…")];
    const session = this.#options.session();
    const route = this.#openaiRoute(accounts, session, inner);
    if (accounts.length === 0) return [theme.fg("muted", "No accounts. Add one on the Accounts tab."), ...route];
    const layout = this.#layout(inner);
    return [...accounts.flatMap((account, index) => [...index === 0 ? [] : [""], ...this.#accountLines(account, session, layout, inner)]),
      ...route, "", ...wrapTextWithAnsi(theme.fg("muted", USAGE_SOURCES_NOTE), inner)];
  }

  /**
   * A line saying ChatGPT on the `openai` route reports no limits, when OpenAI
   * is signed in with ChatGPT and no Codex sign-in, whose limits are read, is
   * among the accounts; marked when the session draws on it.
   */
  #openaiRoute(accounts: readonly AccountRow[], session: string | undefined, inner: number): string[] {
    if (!this.#openaiChatGPT || accounts.some(({ provider, signedIn }) => provider === "openai-codex" && signedIn)) return [];
    const { theme } = this.#options;
    const mark = session === OPENAI ? theme.fg("accent", " · this session") : "";
    return ["", ...wrapTextWithAnsi(`${theme.fg("muted", OPENAI_ROUTE_NOTE)}${mark}`, inner)];
  }

  /** Every meter drawn alike: the label column, and the most segments the details still fit beside, down to five. */
  #layout(inner: number): { labels: number; segments: number; inline: boolean } {
    const meters = [...this.#usage.values()].flatMap((usage) => this.#reading(usage)?.meters ?? []);
    const labels = Math.max(0, ...meters.map(({ label }) => label.length));
    const details = Math.max(0, ...meters.map((meter) => this.#detail(meter).length));
    const room = (segments: number): number => 2 + labels + 2 + segments + 5;
    const segments = SEGMENTS.find((each) => room(each) + 2 + details <= inner);
    return { labels, segments: segments ?? 5, inline: segments !== undefined };
  }

  #reading(usage: AccountUsage): UsageReading | undefined {
    return usage.state === "read" || usage.state === "last_known" ? usage.reading : usage.state === "reading" ? usage.last?.reading : undefined;
  }

  #detail(meter: UsageMeter): string {
    const now = this.#now();
    return meter.resetsAt === undefined ? "" : meter.resetsAt > now ? `resets in ${span(meter.resetsAt - now)}` : "reset due";
  }

  #note(text: string, inner: number, tone: "muted" | "warning" = "muted"): string[] {
    return wrapTextWithAnsi(text, Math.max(8, inner - 2)).map((line) => `  ${this.#options.theme.fg(tone, line)}`);
  }

  #accountLines(account: AccountRow, session: string | undefined, layout: { labels: number; segments: number; inline: boolean }, inner: number): string[] {
    const { theme } = this.#options;
    const usage = this.#usage.get(account.id);
    const reading = usage === undefined ? undefined : this.#reading(usage);
    const plan = reading?.plan === undefined ? "" : ` · ${providerNames[account.provider]} ${reading.plan}`;
    const heading = `${theme.bold(account.id)}${account.default === true ? theme.fg("muted", " (default)") : ""}${this.#mark(account, session)}`
      + theme.fg("muted", plan);
    if (account.checking === true) return [heading, ...this.#note("checking sign-in…", inner)];
    if (usage === undefined) return [heading, ...this.#note("reading…", inner)];
    if (usage.sameAccountAs !== undefined) return [heading, ...this.#note(`same account as ${usage.sameAccountAs}: one reading, above`, inner)];
    const stale = usage.state === "reading" || usage.state === "last_known";
    const lines = [heading];
    if (reading !== undefined) {
      lines.push(...reading.meters.flatMap((meter) => this.#meterLines(meter, layout, inner, stale)));
      if (reading.meters.length === 0 && reading.notes.length === 0) lines.push(...this.#note("no limits reported", inner));
      for (const each of reading.notes) lines.push(...this.#note(each, inner));
    }
    if (usage.state === "unavailable") lines.push(...this.#note(usage.problem, inner, "warning"));
    if (usage.state === "last_known") lines.push(...this.#note(`last known, ${span(this.#now() - usage.readAt)} ago: ${usage.problem}`, inner, "warning"));
    if (usage.state === "reading") {
      lines.push(...this.#note(usage.last === undefined ? "reading…" : `saved ${span(this.#now() - usage.last.readAt)} ago, reading…`, inner));
    }
    return lines;
  }

  /** A window: its label, the share left as segments with its percent, and when it resets, beneath the meter when it does not fit beside. */
  #meterLines(meter: UsageMeter, layout: { labels: number; segments: number; inline: boolean }, inner: number, stale: boolean): string[] {
    const { theme } = this.#options;
    const tone = meterTone(meter.hundredthsLeft);
    const paint = (text: string): string => stale ? theme.fg("dim", text)
      : theme.fg(tone === "out" ? "error" : tone === "low" ? "warning" : "accent", text);
    const detail = this.#detail(meter);
    const lead = `  ${meter.label.padEnd(layout.labels)}  ${paint(`${bar(meter.hundredthsLeft, layout.segments)} ${String(shownPercent(meter.hundredthsLeft)).padStart(3)}%`)}`;
    if (detail === "") return [lead];
    if (layout.inline) return [`${lead}  ${theme.fg("muted", detail)}`];
    return [lead, ...wrapTextWithAnsi(detail, Math.max(8, inner - 4)).map((line) => `    ${theme.fg("muted", line)}`)];
  }

  #mark(account: AccountRow, session: string | undefined): string {
    return account.id === session ? this.#options.theme.fg("accent", " · this session") : "";
  }

  // ---- the Roles tab

  /**
   * A table of each role: the model it runs on, where that is chosen, the
   * account it draws on, and that account's least-left window; the session
   * first, then the verification roles and the agent types under their own
   * headings. Where the table is wider than the panel, each role takes two lines.
   */
  #rolesBody(inner: number): string[] {
    const { theme } = this.#options;
    const cells = this.#roles.map((row) => this.#roleCells(row));
    const width = (pick: (cell: RoleCells) => string, title: string): number => Math.max(title.length, ...cells.map((cell) => visibleWidth(pick(cell)))) + 2;
    const widths = [width((cell) => cell.role, "Role"), width((cell) => cell.model, "Model"), width((cell) => cell.from, "From"),
      width((cell) => cell.account, "Account")] as const;
    const wide = 2 + widths.reduce((sum, each) => sum + each, 0) + Math.max(10, ...cells.map((cell) => visibleWidth(cell.left))) <= inner;
    const pad = (text: string, to: number): string => text + " ".repeat(Math.max(0, to - visibleWidth(text)));
    const line = (cell: RoleCells): string[] => wide
      ? [`  ${pad(cell.role, widths[0])}${pad(cell.model, widths[1])}${pad(cell.from, widths[2])}${pad(cell.account, widths[3])}${cell.left}`]
      : [`  ${pad(cell.role, widths[0])}${cell.model}`, `    ${[cell.from, cell.account, cell.left].filter((each) => each !== "").join(theme.fg("muted", " · "))}`];
    const heading = wide ? [theme.fg("muted", `  ${"Role".padEnd(widths[0])}${"Model".padEnd(widths[1])}${"From".padEnd(widths[2])}${"Account".padEnd(widths[3])}Least left`)] : [];
    const group = (name: RoleRow["group"], title: string): string[] => {
      const rows = cells.filter((_, at) => this.#roles[at]?.group === name);
      return rows.length === 0 ? [] : ["", theme.fg("muted", title), ...rows.flatMap(line)];
    };
    return [...heading, ...cells.filter((_, at) => this.#roles[at]?.group === "session").flatMap(line),
      ...group("verification", "Verification"), ...group("agent", "Agent types"), "", ...wrapTextWithAnsi(theme.fg("muted", ROLES_NOTE), inner)];
  }

  #roleCells(row: RoleRow): RoleCells {
    const { theme } = this.#options;
    const from = theme.fg("muted", row.from);
    if (row.model === "" || row.model === "off") {
      return { role: row.role, model: theme.fg("muted", row.model === "" ? "none selected" : "off"), from, account: "", left: "" };
    }
    const at = row.model.indexOf("/");
    const account = at < 0 ? row.model : row.model.slice(0, at);
    return { role: row.role, model: at < 0 ? row.model : row.model.slice(at + 1), from, account, left: this.#leastLeft(account) };
  }

  /** The account's window with the least left, as its meter is painted; nothing for a provider no account reads. */
  #leastLeft(id: string): string {
    const { theme } = this.#options;
    const row = this.#accounts?.find((each) => each.id === id);
    if (row === undefined) return "";
    const own = this.#usage.get(id);
    const usage = own?.sameAccountAs === undefined ? own : this.#usage.get(own.sameAccountAs) ?? own;
    const reading = usage === undefined ? undefined : this.#reading(usage);
    const least = reading?.meters.reduce<UsageMeter | undefined>((low, meter) => low === undefined || meter.hundredthsLeft < low.hundredthsLeft ? meter : low, undefined);
    if (least === undefined) return theme.fg("muted", usage === undefined || usage.state === "reading" ? "reading…" : "—");
    const tone = meterTone(least.hundredthsLeft);
    const text = `${shownPercent(least.hundredthsLeft)}% ${least.label}`;
    const stale = usage?.state === "reading" || usage?.state === "last_known";
    return stale ? theme.fg("dim", text) : theme.fg(tone === "out" ? "error" : tone === "low" ? "warning" : "accent", text);
  }

  // ---- the Accounts tab

  /** The line each account's rows start at, for scrolling to the chosen one. */
  #rowStarts(inner: number): number[] {
    const starts: number[] = [];
    let at = 0;
    for (const account of this.#accounts ?? []) {
      starts.push(at);
      at += this.#accountRow(account, false, inner).length;
    }
    return starts;
  }

  #accountsList(inner: number): string[] {
    const { theme } = this.#options;
    if (this.#problem !== undefined) return wrapTextWithAnsi(theme.fg("warning", `The accounts could not be read: ${this.#problem}. Press r to try again.`), inner);
    const accounts = this.#accounts;
    if (accounts === undefined) return [theme.fg("muted", "Reading the accounts…")];
    if (accounts.length === 0) return [theme.fg("muted", "No accounts. Press a to add one."), ...this.#signInNote(undefined, inner)];
    return [...accounts.flatMap((account, index) => this.#accountRow(account, index === this.#selected, inner)),
      "", ...this.#signInNote(accounts[this.#selected], inner)];
  }

  /** An account: its name and marks, whether it is signed in and to whom, and its folder. */
  #accountRow(account: AccountRow, selected: boolean, inner: number): string[] {
    const { theme } = this.#options;
    const head = `${selected ? theme.fg("accent", "› ") : "  "}${theme.bold(account.id)}${account.default === true ? theme.fg("muted", " (default)") : ""}`
      + this.#mark(account, this.#options.session());
    const status = account.checking === true ? theme.fg("muted", account.label) : !account.signedIn ? theme.fg("warning", "not signed in")
      : theme.fg("text", account.identity === undefined ? account.label : `signed in as ${account.label}`);
    const lines = wrapTextWithAnsi(`${providerNames[account.provider]} · ${status}`, Math.max(8, inner - 4)).map((line) => `    ${line}`);
    return [head, ...lines, ...account.folder === undefined ? [] : [`    ${theme.fg("muted", account.folder)}`]];
  }

  /** Which command signs the chosen account in, for a terminal; a default sign-in is the provider's own. */
  #signInNote(account: AccountRow | undefined, inner: number): string[] {
    const { theme } = this.#options;
    const text = account === undefined ? "From a terminal: tesota accounts add claude-code|openai-codex <name>"
      : account.default === true
        ? `${account.id} is the provider's own sign-in, not an account Tesota manages: ${account.provider === "claude-code"
          ? "sign in with Claude Code itself (run claude, then /login)" : "sign in with /login"}.`
        : `From a terminal: tesota accounts login ${account.id}`;
    return wrapTextWithAnsi(theme.fg("muted", text), inner);
  }
}
