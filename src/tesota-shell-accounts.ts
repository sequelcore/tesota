import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { bar, span, USAGE_SOURCES_NOTE, usageLines, type RouteUsage, type UsagePaint } from "./account-usage.js";
import { accountNotes, type RouteStatus, SIGN_IN_NOTE, statusLines, type StatusPaint } from "./auth.js";
import { bold, colorText, mutedText, selectedRow, surfaceText, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { meterTone } from "./verification/usage-meter-rule.js";

export const ACCOUNTS_TABS = ["usage", "sign-ins", "roles"] as const;

/** The share of the terminal the panel may take across and down, so the layout beneath still shows around it. */
export const ACCOUNTS_PANEL_WIDTH = 0.88;
export const ACCOUNTS_PANEL_HEIGHT = 0.85;
export type AccountsTab = typeof ACCOUNTS_TABS[number];

const tabLabels: Readonly<Record<AccountsTab, string>> = { usage: "Usage", "sign-ins": "Sign-ins", roles: "Roles" };

/** A role, the model it uses, and the route whose account that model draws on. */
export interface RoleAccount {
  readonly role: string;
  readonly choice: string;
  readonly route?: string;
}

/** The routes' sign-ins and the roles that use each route. */
export interface SignIns {
  readonly rows: readonly RouteStatus[];
  readonly usedBy: (route: string) => readonly string[];
}

/**
 * What the Accounts panel shows, read by the shell: every route's usage,
 * first the saved readings and then each fresh one; the routes' sign-ins;
 * and each role's account.
 */
export interface AccountsSource {
  readUsage(update: (usage: readonly RouteUsage[]) => void): Promise<void>;
  readSignIns(): Promise<SignIns>;
  roles(): readonly RoleAccount[];
}

/** What a key in the panel asks the shell to do. */
export type AccountsAction = "close" | "refresh" | { readonly changeRole: string } | undefined;

/** The rows the body does not get: the frame's two edges, the tab row, a blank row above and below the body, and the hint. */
const CHROME_ROWS = 6;

/**
 * The shell's Accounts panel (decision 051): how much each account has left,
 * the routes' sign-ins and the account each role draws on, in one framed
 * panel over the session, which keeps working beneath it. Nothing in it is
 * written to the session's transcript.
 */
export class AccountsPanel implements Component {
  readonly #theme: TesotaShellTheme;
  readonly #rows: () => number;
  readonly #now: () => number;
  #tab: AccountsTab = "usage";
  #usage: readonly RouteUsage[] = [];
  #usageReadAt: number | undefined;
  #signIns: SignIns | undefined;
  #signInsFailed = false;
  /** Whether the Sign-ins tab shows each route's email whole; masked until the operator asks, for screens others see. */
  #showAccounts = false;
  #roles: readonly RoleAccount[] = [];
  #selectedRole = 0;
  readonly #scroll: Record<AccountsTab, number> = { usage: 0, "sign-ins": 0, roles: 0 };
  /** The body rows the last frame showed, which a page key moves by. */
  #shownRows = 3;

  constructor(theme: TesotaShellTheme, rows: () => number, now: () => number) {
    this.#theme = theme;
    this.#rows = rows;
    this.#now = now;
  }

  get tab(): AccountsTab { return this.#tab; }
  show(tab: AccountsTab): void { this.#tab = tab; }

  setUsage(usage: readonly RouteUsage[]): void {
    this.#usage = usage;
    if (usage.length > 0 && usage.every((entry) => entry.state !== "reading")) this.#usageReadAt = this.#now();
  }
  setSignIns(signIns: SignIns | undefined, failed = false): void {
    this.#signIns = signIns;
    this.#signInsFailed = failed;
  }
  setRoles(roles: readonly RoleAccount[]): void {
    this.#roles = roles;
    this.#selectedRole = Math.min(this.#selectedRole, Math.max(0, roles.length - 1));
  }

  handleKey(data: string): AccountsAction {
    if (matchesKey(data, "escape")) return "close";
    if (data === "r" || data === "R") return "refresh";
    if (this.#tab === "sign-ins" && (data === "s" || data === "S")) { this.#showAccounts = !this.#showAccounts; return undefined; }
    if (this.#switchTab(data)) return undefined;
    if (this.#tab === "roles") return this.#roleKey(data);
    this.#scrollKey(data);
    return undefined;
  }

  /** `←→`, `Tab` and `Shift+Tab` step through the tabs, and `1`–`3` choose one; false for any other key. */
  #switchTab(data: string): boolean {
    const numbered = ["1", "2", "3"].indexOf(data);
    if (numbered >= 0) { this.#tab = ACCOUNTS_TABS[numbered] ?? this.#tab; return true; }
    const step = matchesKey(data, "right") || matchesKey(data, "tab") ? 1 : matchesKey(data, "left") || matchesKey(data, "shift+tab") ? -1 : 0;
    if (step === 0) return false;
    const index = ACCOUNTS_TABS.indexOf(this.#tab);
    this.#tab = ACCOUNTS_TABS[(index + step + ACCOUNTS_TABS.length) % ACCOUNTS_TABS.length] ?? "usage";
    return true;
  }

  /** On the Roles tab, `↑↓` choose a role and `Enter` asks to change its model. */
  #roleKey(data: string): AccountsAction {
    const count = this.#roles.length;
    if ((matchesKey(data, "up") || matchesKey(data, "down")) && count > 0) {
      this.#selectedRole = (this.#selectedRole + (matchesKey(data, "up") ? -1 : 1) + count) % count;
    }
    const role = matchesKey(data, "enter") ? this.#roles[this.#selectedRole]?.role : undefined;
    return role === undefined ? undefined : { changeRole: role };
  }

  /** On the other tabs, `↑↓` scroll a row and `PgUp`/`PgDn` a page. */
  #scrollKey(data: string): void {
    const page = Math.max(1, this.#shownRows - 1);
    const move = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : matchesKey(data, "pageUp") ? -page
      : matchesKey(data, "pageDown") ? page : 0;
    this.#scroll[this.#tab] = Math.max(0, this.#scroll[this.#tab] + move);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(10, width - 4);
    // As tall as the longest tab, so switching tabs never moves the frame, and no taller than the terminal allows.
    const tallest = Math.max(...ACCOUNTS_TABS.map((tab) => this.#body(tab, inner).length));
    const bodyRows = Math.max(3, Math.min(this.#bodyRows(), tallest));
    this.#shownRows = bodyRows;
    const body = this.#body(this.#tab, inner);
    const offset = this.#tab === "roles"
      ? Math.max(0, Math.min(this.#selectedRole + 1 - bodyRows + 1, body.length - bodyRows))
      : Math.min(this.#scroll[this.#tab], Math.max(0, body.length - bodyRows));
    this.#scroll[this.#tab] = offset;
    const shown = body.slice(offset, offset + bodyRows);
    const more = body.length > offset + bodyRows ? `  ↓ ${body.length - offset - bodyRows} more` : "";
    const lines = [this.#tabRow(inner), "", ...shown, ...Array.from({ length: bodyRows - shown.length }, () => ""), "",
      mutedText(truncateToWidth(`${this.#hint()}${more}`, inner), this.#theme)];
    // Every line, the frame included, lies on the panel's own surface, so it reads as above the layout, not part of it.
    return [this.#edge("╭", "╮", width, " Accounts "), ...lines.map((line) => this.#side(line, inner)), this.#edge("╰", "╯", width)]
      .map((line) => surfaceText(line, this.#theme.panelBackground));
  }

  /** The most rows the body may have: the panel leaves the layout showing around it, as `ACCOUNTS_PANEL_HEIGHT` says. */
  #bodyRows(): number { return Math.max(3, Math.floor(this.#rows() * ACCOUNTS_PANEL_HEIGHT) - CHROME_ROWS); }

  #frame(text: string): string { return mutedText(text, this.#theme); }

  #edge(left: string, right: string, width: number, title = ""): string {
    const label = title.length === 0 ? "" : bold(colorText(title, this.#theme.accent));
    const rule = "─".repeat(Math.max(0, width - 2 - 1 - visibleWidth(title)));
    return title.length === 0 ? this.#frame(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`)
      : `${this.#frame(`${left}─`)}${label}${this.#frame(`${rule}${right}`)}`;
  }

  #side(line: string, inner: number): string {
    const fitted = truncateToWidth(line, inner);
    return `${this.#frame("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${this.#frame("│")}`;
  }

  /** The tabs, the selected one highlighted as a selected row is, and on the right how fresh the tab's content is. */
  #tabRow(inner: number): string {
    const tabs = ACCOUNTS_TABS.map((tab, index) => {
      const label = ` ${index + 1} ${tabLabels[tab]} `;
      return tab === this.#tab ? bold(selectedRow(label, label.length, this.#theme)) : mutedText(label, this.#theme);
    }).join(" ");
    const state = mutedText(this.#freshness(), this.#theme);
    const gap = inner - visibleWidth(tabs) - visibleWidth(state);
    return gap >= 2 ? `${tabs}${" ".repeat(gap)}${state}` : tabs;
  }

  #freshness(): string {
    if (this.#tab === "sign-ins") return this.#signIns === undefined && !this.#signInsFailed ? "reading…" : "";
    if (this.#tab === "roles") return `${this.#roles.length} roles`;
    const waiting = this.#usage.filter((entry) => entry.state === "reading").length;
    if (waiting > 0) return `reading ${this.#usage.length - waiting} of ${this.#usage.length}…`;
    if (this.#usageReadAt === undefined) return "";
    const age = this.#now() - this.#usageReadAt;
    return age < 60_000 ? "read just now" : `read ${span(age)} ago`;
  }

  #hint(): string {
    const common = "←→ tabs · r read again · Esc close";
    if (this.#tab === "roles") return `↑↓ choose · Enter change its model · ${common}`;
    if (this.#tab === "sign-ins") {
      return `↑↓ scroll · s ${this.#showAccounts ? "hide" : "show"} emails · sign in with tesota auth login <route> · ${common}`;
    }
    return `↑↓ scroll · ${common}`;
  }

  #body(tab: AccountsTab, inner: number): string[] {
    if (tab === "usage") return this.#usageBody(inner);
    if (tab === "sign-ins") return this.#signInBody(inner);
    return this.#roleBody(inner);
  }

  /** A note under a table, wrapped to the panel rather than cut. */
  #footnote(text: string, inner: number): string[] {
    return wrapTextWithAnsi(text, inner).map((line) => mutedText(line, this.#theme));
  }

  #usagePaint(): UsagePaint {
    const theme = this.#theme;
    return { muted: (text) => mutedText(text, theme), strong: bold,
      meter: (text, tone) => colorText(text, tone === "out" ? theme.error : tone === "low" ? theme.warning : theme.accent) };
  }

  #usageBody(inner: number): string[] {
    if (this.#usage.length === 0) return [mutedText("Reading each account's usage…", this.#theme)];
    // Twenty segments where the table fits, as Codex draws them; ten where it would not.
    const wide = usageLines(this.#usage, this.#now());
    const segments = wide.every((line) => visibleWidth(line) <= inner) ? 20 : 10;
    // Routes on one account, known once the sign-ins are read, show one plan's limits twice (#235).
    const shared = accountNotes(this.#signIns?.rows ?? []).flatMap((note) =>
      wrapTextWithAnsi(note, inner).map((line) => colorText(line, this.#theme.warning)));
    return [...usageLines(this.#usage, this.#now(), { segments, paint: this.#usagePaint(), width: inner }), "", ...shared,
      ...this.#footnote(USAGE_SOURCES_NOTE, inner)];
  }

  #signInBody(inner: number): string[] {
    if (this.#signInsFailed) return [colorText("The routes' sign-ins could not be read. No credential was shown. Press r to try again.",
      this.#theme.warning)];
    if (this.#signIns === undefined) return [mutedText("Reading each route's sign-in…", this.#theme)];
    const paint: StatusPaint = { muted: (text) => mutedText(text, this.#theme), strong: bold,
      attention: (text) => colorText(text, this.#theme.warning) };
    // Routes on one account matter to the team the operator plans, so they stand out from the notes.
    const shared = accountNotes(this.#signIns.rows).flatMap((note) =>
      wrapTextWithAnsi(note, inner).map((line) => colorText(line, this.#theme.warning)));
    return [...statusLines(this.#signIns.rows, this.#signIns.usedBy, paint, this.#showAccounts), "", ...shared,
      ...this.#footnote(SIGN_IN_NOTE, inner)];
  }

  /** The tightest meter of a route's account: the one with the least left, as a short bar. */
  #tightest(route: string | undefined): string {
    if (route === undefined) return "";
    const entry = this.#usage.find((usage) => usage.route === route);
    if (entry === undefined) return mutedText("—", this.#theme);
    const reading = entry.state === "read" || entry.state === "last_known" ? entry.reading
      : entry.state === "reading" ? entry.last?.reading : undefined;
    const meter = reading?.meters.reduce<typeof reading.meters[number] | undefined>((least, current) =>
      least === undefined || current.left < least.left ? current : least, undefined);
    if (meter === undefined) {
      const why = entry.state === "unavailable" ? entry.problem : entry.state === "reading" ? "reading…" : reading?.notes[0] ?? "no limits reported";
      return mutedText(why, this.#theme);
    }
    const tone = meterTone(meter.left);
    const painted = colorText(`${bar(meter.left, 10)} ${String(meter.left).padStart(3)}%`,
      tone === "out" ? this.#theme.error : tone === "low" ? this.#theme.warning : this.#theme.accent);
    const reset = meter.resetsAt !== undefined && meter.resetsAt > this.#now() ? ` · resets in ${span(meter.resetsAt - this.#now())}` : "";
    return `${painted}  ${mutedText(`${meter.label}${reset}`, this.#theme)}`;
  }

  #roleBody(inner: number): string[] {
    if (this.#roles.length === 0) return [mutedText("No roles.", this.#theme)];
    const roleWidth = Math.max(4, ...this.#roles.map((row) => row.role.length)) + 2;
    const choiceWidth = Math.max(5, ...this.#roles.map((row) => row.choice.length)) + 2;
    const routeWidth = Math.max(7, ...this.#roles.map((row) => (row.route ?? "").length)) + 2;
    const heading = mutedText(`  ${"Role".padEnd(roleWidth)}${"Model".padEnd(choiceWidth)}${"Account".padEnd(routeWidth)}Least left`, this.#theme);
    return [heading, ...this.#roles.map((row, index) => {
      const selected = index === this.#selectedRole;
      const choice = row.route === undefined ? mutedText(row.choice.padEnd(choiceWidth), this.#theme) : row.choice.padEnd(choiceWidth);
      const lead = `${selected ? "›" : " "} ${row.role.padEnd(roleWidth)}${choice}${(row.route ?? "").padEnd(routeWidth)}`;
      const line = `${selected ? bold(lead) : lead}${this.#tightest(row.route)}`;
      return selected ? selectedRow(truncateToWidth(line, inner), inner, this.#theme) : line;
    })];
  }
}
