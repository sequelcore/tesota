import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SessionRail } from "../src/tesota-shell-sidebar.js";
import { tesotaShellTheme } from "../src/tesota-shell-theme.js";
import { animatedSidebarState, newestFirstSourceIndex, sidebarPresentation, sidebarSessionState,
  type SidebarProgressPhase } from "../src/verification/sidebar-rule.js";

describe("sidebar presentation", () => {
  it.each([
    { preference: "auto" as const, width: 120, expected: "inline" },
    { preference: "open" as const, width: 120, expected: "inline" },
    { preference: "hidden" as const, width: 120, expected: "hidden" },
    { preference: "auto" as const, width: 70, expected: "hidden" },
    { preference: "open" as const, width: 70, expected: "overlay" },
    { preference: "hidden" as const, width: 70, expected: "hidden" },
  ])("is $expected for $preference at $width columns", ({ preference, width, expected }) => {
    expect(sidebarPresentation(preference, width)).toBe(expected);
  });
});

describe("sidebar session state", () => {
  it("keeps terminal and operator states ahead of stale activity", () => {
    expect(sidebarSessionState(true, true, true, "working", true)).toBe("unresolved");
    expect(sidebarSessionState(false, true, true, "working", true)).toBe("ended");
    expect(sidebarSessionState(false, false, true, "awaiting_command", true)).toBe("awaiting_command");
    expect(sidebarSessionState(false, false, true, "awaiting_decision", true)).toBe("awaiting_decision");
    expect(sidebarSessionState(false, false, true, "working", true)).toBe("needs_operator");
  });

  it.each<SidebarProgressPhase>([
    "preparing", "working", "awaiting_command", "checking", "reviewing", "awaiting_decision", "applying",
  ])("preserves the precise %s phase", (phase) => {
    expect(sidebarSessionState(false, false, false, phase, true)).toBe(phase);
  });

  it("shows unread only when no stronger state remains", () => {
    expect(sidebarSessionState(false, false, false, "none", true)).toBe("unread");
    expect(sidebarSessionState(false, false, false, "none", false)).toBe("idle");
  });

  it.each([
    ["preparing", true], ["working", true], ["checking", true], ["reviewing", true], ["applying", true],
    ["awaiting_command", false], ["awaiting_decision", false], ["needs_operator", false],
    ["unresolved", false], ["ended", false], ["unread", false], ["idle", false],
  ] as const)("marks %s animation as %s", (state, expected) => {
    expect(animatedSidebarState(state)).toBe(expected);
  });
});

it("maps newest-first visual positions without accepting invalid positions", () => {
  expect([0, 1, 2].map((visual) => newestFirstSourceIndex(3, visual))).toEqual([2, 1, 0]);
  expect(newestFirstSourceIndex(3, 3)).toBe(-1);
  expect(newestFirstSourceIndex(0, 0)).toBe(-1);
});

it("renders precise state labels and keeps the selected session inside an overlay window", () => {
  const rail = new SessionRail(tesotaShellTheme("terminal"));
  rail.setFrame("⠹");
  rail.setSessions([
    { id: "new", title: "Newest", state: "checking", selected: false },
    { id: "approval", title: "Approval", state: "awaiting_command", selected: false },
    { id: "decision", title: "Decision", state: "awaiting_decision", selected: false },
    { id: "old", title: "Oldest", state: "unresolved", selected: true },
  ]);
  const all = stripTerminalSequences(rail.render(30).join("\n"));
  expect(all).toContain("⠹ Running checks");
  expect(all).toContain("! Needs approval");
  expect(all).toContain("! Needs decision");
  expect(all).toContain("! Unresolved");
  expect(stripTerminalSequences(rail.renderWindow(30, 4).join("\n"))).toContain("Oldest");
});
