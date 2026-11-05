import { describe, expect, test } from "bun:test";
import type { AgentType } from "../src/agents.ts";
import { roleRows } from "../src/roles.ts";

/** Each role's model as the gate and a subagent's start choose it, and where that choice is made. */
const type = (name: string, model?: string): AgentType => ({ name, description: name, path: `/a/${name}.md`, instructions: "",
  ...model === undefined ? {} : { model } });
const session = "claude-code/claude-opus-5-5";

describe("role rows", () => {
  test("a verification role takes its flag, then its setting, then the session's model", () => {
    const byRole = (settings: Parameters<typeof roleRows>[1], flags: Record<string, string>) =>
      Object.fromEntries(roleRows(session, settings, flags, []).map((row) => [row.role, row]));
    expect(byRole({}, {})["open cases"]).toEqual({ group: "verification", role: "open cases", model: session, from: "inherited" });
    expect(byRole({ openCasesModel: "openai-codex/gpt-6-sol" }, {})["open cases"])
      .toEqual({ group: "verification", role: "open cases", model: "openai-codex/gpt-6-sol", from: "setting openCasesModel" });
    expect(byRole({ claimcheckModel: "openai-codex/gpt-6-sol" }, { "claimcheck-model": "off" })["ClaimCheck"])
      .toEqual({ group: "verification", role: "ClaimCheck", model: "off", from: "--claimcheck-model" });
  });

  test("lists the session first, then the verification roles, then each agent type, which inherits without a model of its own", () => {
    const rows = roleRows(session, {}, {}, [type("explorer"), type("worker", "openai-codex@work/gpt-6-sol")]);
    expect(rows.map(({ group, role }) => `${group}:${role}`))
      .toEqual(["session:this session", "verification:open cases", "verification:ClaimCheck", "agent:explorer", "agent:worker"]);
    expect(rows.slice(3).map(({ model, from }) => [model, from])).toEqual([[session, "inherited"], ["openai-codex@work/gpt-6-sol", "type file"]]);
  });

  test("with no session model, what would inherit has none selected", () => {
    const rows = roleRows(undefined, { claimcheckModel: "openai-codex/gpt-6-sol" }, {}, [type("explorer")]);
    expect(rows.map(({ model }) => model)).toEqual(["", "", "openai-codex/gpt-6-sol", ""]);
  });
});
