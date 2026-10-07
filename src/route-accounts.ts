import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which account a route is signed in to, as its own sign-in records it
 * (#235): Claude Code in its configuration folder's `.claude.json`, Codex in
 * the profile its OAuth token carries. Read locally, with no request; a token
 * or key is never shown, and an email only masked unless the operator asks.
 */
export interface RouteAccount {
  /** What tells two accounts apart: Claude Code's account id, or Codex's ChatGPT account id. */
  readonly id: string;
  readonly email?: string;
  /** The ChatGPT plan a Codex sign-in is on, as its token names it: `free`, `plus`, `pro` and the like (#296). */
  readonly plan?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/** The account Claude Code records in a configuration folder, the operator's own when none is named. */
export function claudeCodeAccount(configDirectory: string | undefined): RouteAccount | undefined {
  const own = process.env["CLAUDE_CONFIG_DIR"];
  const file = configDirectory !== undefined ? join(configDirectory, ".claude.json")
    : own !== undefined ? join(own, ".claude.json") : join(homedir(), ".claude.json");
  if (!existsSync(file)) return undefined;
  try {
    const account = record(record(JSON.parse(readFileSync(file, "utf8")))?.["oauthAccount"]);
    const id = account?.["accountUuid"];
    const email = account?.["emailAddress"];
    if (typeof id !== "string" || id.length === 0) return undefined;
    return { id, ...typeof email === "string" && email.length > 0 ? { email } : {} };
  } catch { return undefined; }
}

/** The account a Codex sign-in is for, from its stored credential: the access token's claims, read but never verified or shown. */
export function codexAccount(credential: unknown): RouteAccount | undefined {
  const stored = record(credential);
  const access = stored?.["access"];
  let claims: Record<string, unknown> | undefined;
  if (typeof access === "string") {
    try { claims = record(JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"))); } catch { claims = undefined; }
  }
  const auth = record(claims?.["https://api.openai.com/auth"]);
  const id = [stored?.["accountId"], auth?.["chatgpt_account_id"], claims?.["sub"]]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (id === undefined) return undefined;
  const email = record(claims?.["https://api.openai.com/profile"])?.["email"];
  const plan = auth?.["chatgpt_plan_type"];
  return { id, ...typeof email === "string" && email.length > 0 ? { email } : {},
    ...typeof plan === "string" && plan.length > 0 ? { plan } : {} };
}

/** An email with most of its name hidden, as `r3…@outlook.es`, for screens others may see. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "…";
  const name = email.slice(0, at);
  return `${name.slice(0, name.length > 2 ? 2 : 1)}…${email.slice(at)}`;
}

/** How an account reads in a table: its email, masked unless shown; a placeholder when the sign-in names none. */
export function accountText(account: RouteAccount | undefined, show: boolean): string {
  if (account === undefined) return "—";
  if (account.email === undefined) return "(no email recorded)";
  return show ? account.email : maskEmail(account.email);
}

/** Routes signed in to the same account, each group in the routes' order; a route alone is left out. */
export function sharedAccounts(routes: readonly { readonly route: string; readonly account?: RouteAccount | undefined }[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const entry of routes) {
    if (entry.account === undefined) continue;
    groups.set(entry.account.id, [...groups.get(entry.account.id) ?? [], entry.route]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/** What a group of routes on one account means for the operator, said once under a table. */
export function sharedAccountNote(group: readonly string[]): string {
  return `${group.join(" and ")} are signed in to the same account: their limits are one plan's, and their meters one reading.`;
}

/**
 * Where roles spread across routes still draw on one account (#235): each
 * group of routes on one account that more than one gives a role to. A route
 * no role uses changes nothing.
 */
export function sharedRoleGroups(routes: readonly { readonly route: string; readonly account?: RouteAccount | undefined }[],
  usedBy: (route: string) => readonly string[]): string[][] {
  return sharedAccounts(routes.filter((entry) => usedBy(entry.route).length > 0));
}

/** What a group of routes on one account means for the roles on them, said with the roles on each route. */
export function sharedRoleNote(group: readonly string[], usedBy: (route: string) => readonly string[]): string {
  return `Roles on ${group.map((route) => `${route} (${usedBy(route).join(", ")})`).join(" and ")} share one plan's limits: ` +
    `${group.length === 2 ? "both" : "these"} routes are signed in to the same account.`;
}
