import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { animatedSidebarState, attentionSidebarState, type SidebarSessionState } from "./verification/sidebar-rule.js";
import { bold, colorText, mutedText, selectedRow, surfaceText, type ShellSurfaces, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { safeTerminalText } from "./tesota-shell-transcript.js";

export interface SidebarSession {
  readonly id: string;
  readonly title: string;
  readonly state: SidebarSessionState;
  readonly selected: boolean;
}

/** Repository identity above the session navigation. */
export class SessionSidebarHeader implements Component {
  readonly #theme: TesotaShellTheme;
  #repository = "";
  #branch: string | undefined;

  constructor(theme: TesotaShellTheme) { this.#theme = theme; }
  setContext(repository: string, branch: string | undefined): void {
    this.#repository = repository;
    this.#branch = branch;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const repository = bold(colorText(safeTerminalText(this.#repository), this.#theme.accent));
    const branch = this.#branch === undefined ? "" : mutedText(` · ${safeTerminalText(this.#branch)}`, this.#theme);
    return [truncateToWidth(` ${repository}${branch}`, width)];
  }
}

interface StatePresentation {
  readonly icon: string;
  readonly label: string;
  readonly color: string | null;
  readonly muted?: boolean;
}

/** Scrollable, newest-first session navigation. */
/**
 * The sessions, two rows each. A click or a tap on a session's rows selects
 * it, as Alt+J and Alt+K do, so a phone over SSH reaches each session too.
 */
export class SessionRail implements Component {
  readonly #theme: TesotaShellTheme;
  readonly #onSelect: ((id: string) => void) | undefined;
  #sessions: readonly SidebarSession[] = [];
  /** The sessions as last drawn, the whole list or the overlay's window of it, for a click to find its session. */
  #drawn: readonly SidebarSession[] = [];
  #frame = "";

  constructor(theme: TesotaShellTheme, onSelect?: (id: string) => void) { this.#theme = theme; this.#onSelect = onSelect; }
  setSessions(sessions: readonly SidebarSession[]): void { this.#sessions = sessions; }
  setFrame(frame: string): void { this.#frame = frame; }
  get lineCount(): number { return this.#sessions.length * 2; }
  rowFor(id: string): number | undefined {
    const index = this.#sessions.findIndex((session) => session.id === id);
    return index < 0 ? undefined : index * 2;
  }
  invalidate(): void {}
  render(width: number): string[] { return this.renderSessions(this.#sessions, width); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.clickRow(event, event.y); }

  /**
   * A press on a session's rows is taken, so the click that follows it reaches here and selects that session; `row`
   * counts from the first row drawn.
   */
  clickRow(event: TuiMouseEvent, row: number): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click") || row < 0) return undefined;
    const session = this.#drawn[Math.floor(row / 2)];
    if (session === undefined) return undefined;
    if (event.type === "click") this.#onSelect?.(session.id);
    return { handled: true, render: event.type === "click" };
  }

  /** A selected-session window for overlays, whose renderer does not allocate a nested scroll viewport. */
  renderWindow(width: number, height: number): string[] {
    const count = Math.max(1, Math.floor(height / 2));
    if (this.#sessions.length <= count) return this.render(width);
    const selected = Math.max(0, this.#sessions.findIndex((session) => session.selected));
    const start = Math.max(0, Math.min(selected - Math.floor(count / 2), this.#sessions.length - count));
    return this.renderSessions(this.#sessions.slice(start, start + count), width);
  }

  private renderSessions(sessions: readonly SidebarSession[], width: number): string[] {
    this.#drawn = sessions;
    const lines: string[] = [];
    for (const session of sessions) {
      const title = safeTerminalText(session.title);
      const heading = ` ${session.selected ? bold(title) : title}`;
      const state = this.presentation(session.state);
      const stateText = `${state.icon} ${state.label}`;
      const detail = `  ${state.muted === true ? mutedText(stateText, this.#theme) : colorText(stateText, state.color)}`;
      if (session.selected) {
        lines.push(selectedRow(truncateToWidth(heading, width), width, this.#theme));
        lines.push(selectedRow(truncateToWidth(detail, width), width, this.#theme));
      } else {
        lines.push(truncateToWidth(heading, width));
        lines.push(truncateToWidth(detail, width));
      }
    }
    return lines;
  }

  private presentation(state: SidebarSessionState): StatePresentation {
    const icon = sessionStateIcon(state, this.#frame);
    if (animatedSidebarState(state)) return { icon, label: activeLabel(state), color: this.#theme.accent };
    if (state === "unresolved") return { icon, label: "Unresolved", color: this.#theme.error };
    if (state === "needs_operator") return { icon, label: "Needs you", color: this.#theme.warning };
    if (state === "awaiting_command") return { icon, label: "Needs approval", color: this.#theme.warning };
    if (state === "awaiting_decision") return { icon, label: "Needs decision", color: this.#theme.warning };
    if (state === "unread") return { icon, label: "Unread", color: this.#theme.accent };
    if (state === "ended") return { icon, label: "Ended", color: this.#theme.muted, muted: true };
    return { icon, label: "Idle", color: this.#theme.muted, muted: true };
  }
}

/** A session state's one-character mark, shared by the sidebar and the terminal's title: `frame` while it works. */
export function sessionStateIcon(state: SidebarSessionState, frame: string): string {
  if (animatedSidebarState(state)) return frame;
  if (attentionSidebarState(state)) return "!";
  return state === "unread" ? "•" : state === "ended" ? "–" : "·";
}

function activeLabel(state: SidebarSessionState): string {
  if (state === "preparing") return "Preparing";
  if (state === "checking") return "Running checks";
  if (state === "reviewing") return "Reviewing";
  if (state === "applying") return "Applying changes";
  return "Working";
}

/** The narrow-screen form retains the repository header and keeps the selected session in view. */
export class SessionSidebarOverlay implements Component {
  readonly #header: SessionSidebarHeader;
  readonly #rail: SessionRail;
  readonly #height: () => number;
  readonly #surfaces: (() => ShellSurfaces) | undefined;
  /** The header's rows as last drawn, above a blank row and the sessions. */
  #headerRows = 0;

  /** Over the conversation on a narrow terminal, on the side surface its whole height, with a rule down its left edge. */
  constructor(header: SessionSidebarHeader, rail: SessionRail, height: () => number, surfaces?: () => ShellSurfaces) {
    this.#header = header;
    this.#rail = rail;
    this.#height = height;
    this.#surfaces = surfaces;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const height = Math.max(1, this.#height());
    const inner = Math.max(1, width - 1);
    const header = this.#header.render(inner);
    this.#headerRows = header.length;
    const lines = height <= 1 ? header : [...header, "", ...this.#rail.renderWindow(inner, height - 2)].slice(0, height);
    const surfaces = this.#surfaces?.();
    if (surfaces === undefined) return lines;
    const rule = surfaces.rule === null ? "\x1b[2m│\x1b[22m" : colorText("│", surfaces.rule);
    return Array.from({ length: height }, (_, row) => {
      const line = lines[row] ?? "";
      return rule + surfaceText(line + " ".repeat(Math.max(0, inner - visibleWidth(line))), surfaces.side);
    });
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.#rail.clickRow({ ...event, x: event.x - 1 }, event.y - this.#headerRows - 1);
  }
}
