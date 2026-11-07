import { roleModel, roleSource } from "../../../src/verification/role-model-rule.ts";
import type { AgentType } from "./agents.ts";
import type { Settings } from "./settings.ts";

/** A role the usage panel's Roles tab lists: the model it runs on and where that choice is made. */
export interface RoleRow {
  readonly group: "session" | "verification" | "agent";
  readonly role: string;
  /** A `provider/id`, `off`, or empty when no model is selected. */
  readonly model: string;
  /** Where the model is chosen, said as the operator would change it. */
  readonly from: string;
}

const verificationRoles = [
  { role: "open cases", flag: "open-cases-model", setting: "openCasesModel" },
  { role: "ClaimCheck", flag: "claimcheck-model", setting: "claimcheckModel" },
] as const;

/**
 * The session, the verification roles and the agent types, each with the
 * model it runs on: a verification role's by the gate's precedence, an agent
 * type's from its file or else the session's, as a subagent starts.
 */
export function roleRows(session: string | undefined, settings: Pick<Settings, "openCasesModel" | "claimcheckModel">,
  flags: Readonly<Record<string, string>>, types: readonly AgentType[]): RoleRow[] {
  const own = session ?? "";
  return [
    { group: "session", role: "this session", model: own, from: "/model" },
    ...verificationRoles.map(({ role, flag, setting }): RoleRow => {
      const given = flags[flag] ?? "";
      const set = settings[setting] ?? "";
      const source = roleSource(given, set);
      return { group: "verification", role, model: roleModel(given, set, own),
        from: source === "flag" ? `--${flag}` : source === "setting" ? `setting ${setting}` : "inherited" };
    }),
    ...types.map((type): RoleRow => ({ group: "agent", role: type.name, model: type.model ?? own,
      from: type.model === undefined ? "inherited" : "type file" })),
  ];
}
