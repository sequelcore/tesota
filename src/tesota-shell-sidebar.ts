import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { animatedSidebarState, type SidebarSessionState } from "./verification/sidebar-rule.js";
import { bold, colorText, mutedText, selectedRow, type TesotaShellTheme } from "./tesota-shell-theme.js";
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
export class SessionRail implements Component {
  readonly #theme: TesotaShellTheme;
  #sessions: readonly SidebarSession[] = [];
  #frame = "";

  constructor(theme: TesotaShellTheme) { this.#theme = theme; }
  setSessions(sessions: readonly SidebarSession[]): void { this.#sessions = sessions; }
  setFrame(frame: string): void { this.#frame = frame; }
  get lineCount(): number { return this.#sessions.length * 2; }
  rowFor(id: string): number | undefined {
    const index = this.#sessions.findIndex((session) => session.id === id);
    return index < 0 ? undefined : index * 2;
  }
  invalidate(): void {}
  render(width: number): string[] { return this.renderSessions(this.#sessions, width); }

  /** A selected-session window for overlays, whose renderer does not allocate a nested scroll viewport. */
  renderWindow(width: number, height: number): string[] {
    const count = Math.max(1, Math.floor(height / 2));
    if (this.#sessions.length <= count) return this.render(width);
    const selected = Math.max(0, this.#sessions.findIndex((session) => session.selected));
    const start = Math.max(0, Math.min(selected - Math.floor(count / 2), this.#sessions.length - count));
    return this.renderSessions(this.#sessions.slice(start, start + count), width);
  }

  private renderSessions(sessions: readonly SidebarSession[], width: number): string[] {
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
    if (animatedSidebarState(state)) return { icon: this.#frame, label: activeLabel(state), color: this.#theme.accent };
    if (state === "unresolved") return { icon: "!", label: "Unresolved", color: this.#theme.error };
    if (state === "needs_operator") return { icon: "!", label: "Needs you", color: this.#theme.warning };
    if (state === "awaiting_command") return { icon: "!", label: "Needs approval", color: this.#theme.warning };
    if (state === "awaiting_decision") return { icon: "!", label: "Needs decision", color: this.#theme.warning };
    if (state === "unread") return { icon: "•", label: "Unread", color: this.#theme.accent };
    if (state === "ended") return { icon: "–", label: "Ended", color: this.#theme.muted, muted: true };
    return { icon: "·", label: "Idle", color: this.#theme.muted, muted: true };
  }
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

  constructor(header: SessionSidebarHeader, rail: SessionRail, height: () => number) {
    this.#header = header;
    this.#rail = rail;
    this.#height = height;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const height = Math.max(1, this.#height());
    const header = this.#header.render(width);
    if (height <= 1) return header;
    return [...header, "", ...this.#rail.renderWindow(width, height - 2)].slice(0, height);
  }
}
