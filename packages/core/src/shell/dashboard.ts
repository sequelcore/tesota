import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ReceiptStanding, standingWords } from "../../../../src/receipt.ts";
import type { ShellTheme, ThemeToken } from "../../../../src/theme.ts";

/** A session's first request and current status, as the dashboard shows them. */
export interface SessionRow {
  readonly id: string;
  readonly request: string;
  readonly state: "idle" | "working" | "verifying" | "waiting" | "ended";
  readonly outcome?: string;
  /** Where its last receipt stands; none before it has one, which reads as unverified. */
  readonly verification?: ReceiptStanding;
  readonly workspace: string;
  readonly startedAt: number;
  readonly attached: boolean;
}

/** What the operator can do to a session from the dashboard. */
export interface DashboardActions {
  attach(id: string): void;
  peek(id: string): readonly string[];
  create(): void;
  close(id: string): void;
  back(): void;
}

/** The session list (#455), with a conversation preview and confirmation before stopping a busy session. */
export class Dashboard implements Component {
  private readonly theme: ShellTheme;
  private readonly rows: () => readonly SessionRow[];
  private readonly actions: DashboardActions;
  private readonly now: () => number;
  private index = 0;
  private selectedId: string | undefined;
  private confirming: string | undefined;
  private peeking = false;

  constructor(theme: ShellTheme, rows: () => readonly SessionRow[], actions: DashboardActions, now: () => number = Date.now) {
    this.theme = theme;
    this.rows = rows;
    this.actions = actions;
    this.now = now;
  }

  /** Draws the current sessions, key hints and any open preview or confirmation. */
  render(width: number): string[] {
    const rows = this.rows();
    const selected = this.selection(rows);
    const { theme } = this;
    const lines = [theme.bold(theme.fg("accent", `Sessions (${rows.length})`))];
    for (const row of rows) lines.push(this.row(row, width));
    if (rows.length === 0) lines.push(theme.fg("muted", "No sessions. Press n to start one."));
    lines.push(theme.fg("dim", "↑↓ choose · enter attach · space peek · n new · x close · esc back"));
    if (this.peeking && selected !== undefined) {
      lines.push(theme.fg("accent", "Peek"));
      lines.push(...this.actions.peek(selected.id).slice(-10));
    }
    if (this.confirming !== undefined) lines.push(theme.fg("warning", "Stop and close this session? y/n"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** Moves the selection or performs the operator's session action. */
  handleInput(data: string): void {
    const rows = this.rows();
    const selected = this.selection(rows);
    if (this.confirming !== undefined) {
      const id = this.confirming;
      if (data === "y") {
        this.confirming = undefined;
        this.actions.close(id);
      } else if (data === "n" || matchesKey(data, "escape")) this.confirming = undefined;
      return;
    }
    if (matchesKey(data, "escape")) this.actions.back();
    else if (data === "n") this.actions.create();
    else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.index += matchesKey(data, "up") ? -1 : 1;
      this.selectedId = undefined;
      this.selection(rows);
    } else if (selected !== undefined) {
      if (matchesKey(data, "enter")) this.actions.attach(selected.id);
      else if (matchesKey(data, "space")) this.peeking = !this.peeking;
      else if (data === "x") {
        if (selected.state === "working" || selected.state === "verifying" || selected.state === "waiting") {
          this.confirming = selected.id;
        } else this.actions.close(selected.id);
      }
    }
  }

  /** Nothing is cached; every render reads the rows and theme again. */
  invalidate(): void {}

  private selection(rows: readonly SessionRow[]): SessionRow | undefined {
    const found = rows.findIndex((row) => row.id === this.selectedId);
    this.index = found >= 0 ? found : Math.max(0, Math.min(this.index, rows.length - 1));
    const selected = rows[this.index];
    this.selectedId = selected?.id;
    if (this.confirming !== undefined && !rows.some((row) => row.id === this.confirming)) this.confirming = undefined;
    if (selected === undefined) this.peeking = false;
    return selected;
  }

  private row(row: SessionRow, width: number): string {
    const { theme } = this;
    const marker = row.id === this.selectedId ? theme.fg("accent", "> ") : "  ";
    const state = row.state === "waiting" ? "waiting for you"
      : row.state === "ended" && row.outcome !== undefined ? `ended (${row.outcome})` : row.state;
    const verification = row.verification ?? "unverified";
    const tones: Record<NonNullable<SessionRow["verification"]>, ThemeToken> = {
      verified: "success", incomplete: "warning", failed: "error", unverified: "dim", unchanged: "muted",
    };
    const seconds = Math.max(0, Math.floor((this.now() - row.startedAt) / 1_000));
    const minutes = Math.floor(seconds / 60);
    const elapsed = seconds < 60 ? `${seconds}s` : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    const attached = row.attached ? theme.fg("accent", " (attached)") : "";
    const prefix = `${marker}${theme.fg(row.state === "waiting" ? "warning" : "muted", state)} · ${theme.fg(tones[verification], standingWords[verification])} · ${theme.fg("muted", row.workspace)} · ${theme.fg("dim", elapsed)}${attached} · `;
    const request = row.request.split(/\r?\n|\r/)[0] || "new session";
    return truncateToWidth(prefix + truncateToWidth(request, Math.max(0, width - visibleWidth(prefix))), width);
  }
}
