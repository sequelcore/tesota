import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { accountText, claudeCodeAccount, chatgptAccount, maskEmail, sharedAccountNote, sharedAccounts, sharedRoleGroups, sharedRoleNote }
  from "../src/route-accounts.js";
import { routeAfter } from "../src/verification/route-removal-rule.js";

/**
 * Which account each route is signed in to (#235), read from the route's own
 * sign-in with no request, and never a token: two routes on one account share
 * one plan, which the operator must see before planning a team around them.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-route-accounts-"));
  roots.push(root);
  return root;
}

/** A token shaped as OpenAI's: only its claims matter here, and it is never a real one. */
function token(claims: Record<string, unknown>): string {
  return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");
}

it("reads the account Claude Code records in a configuration folder, and nothing when it records none", () => {
  const signedIn = folder();
  writeFileSync(join(signedIn, ".claude.json"), JSON.stringify({ oauthAccount:
    { accountUuid: "45e4b49f-85fa-4e49-8064-669deb6124e6", emailAddress: "r3xed@outlook.es", organizationName: "Org" } }));
  expect(claudeCodeAccount(signedIn)).toEqual({ id: "45e4b49f-85fa-4e49-8064-669deb6124e6", email: "r3xed@outlook.es" });
  const never = folder();
  expect(claudeCodeAccount(never)).toBeUndefined();
  writeFileSync(join(never, ".claude.json"), "{ not json");
  expect(claudeCodeAccount(never)).toBeUndefined();
});

it("reads a ChatGPT sign-in's account from its token's claims, the stored account id first", () => {
  const access = token({ sub: "user-1", "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-claim" },
    "https://api.openai.com/profile": { email: "plus@example.com" } });
  expect(chatgptAccount({ type: "oauth", access, refresh: "", expires: 0, accountId: "acct-stored" }))
    .toEqual({ id: "acct-stored", email: "plus@example.com" });
  expect(chatgptAccount({ type: "oauth", access, refresh: "", expires: 0 })).toEqual({ id: "acct-from-claim", email: "plus@example.com" });
  // Sign in with ChatGPT's token may name no email; the account is still told apart by its id.
  const bare = token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-bare" } });
  expect(chatgptAccount({ type: "oauth", access: bare })).toEqual({ id: "acct-bare" });
  expect(chatgptAccount({ type: "oauth", access: "not-a-token" })).toBeUndefined();
  expect(chatgptAccount(undefined)).toBeUndefined();
});

it("masks an email unless it is shown, and says when a sign-in names none", () => {
  expect(maskEmail("r3xed@outlook.es")).toBe("r3…@outlook.es");
  expect(maskEmail("ab@x.io")).toBe("a…@x.io");
  expect(accountText({ id: "a", email: "r3xed@outlook.es" }, false)).toBe("r3…@outlook.es");
  expect(accountText({ id: "a", email: "r3xed@outlook.es" }, true)).toBe("r3xed@outlook.es");
  expect(accountText({ id: "a" }, false)).toBe("(no email recorded)");
  expect(accountText(undefined, true)).toBe("—");
});

it("names the routes signed in to one account, once each, and none alone", () => {
  const ours = { id: "45e4b49f" };
  const groups = sharedAccounts([{ route: "chatgpt", account: { id: "plus" } }, { route: "claude-code", account: ours },
    { route: "chatgpt-free1" }, { route: "claude-2", account: ours }]);
  expect(groups).toEqual([["claude-code", "claude-2"]]);
  expect(sharedAccountNote(groups[0] ?? [])).toContain("claude-code and claude-2 are signed in to the same account");
});

it("names roles spread across routes that draw on one account, and not a shared route no role uses", () => {
  const ours = { id: "45e4b49f" };
  const routes = [{ route: "claude-code", account: ours }, { route: "claude-2", account: ours }, { route: "claude-3", account: ours },
    { route: "chatgpt", account: { id: "plus" } }];
  const roles: Readonly<Record<string, readonly string[]>> = { "claude-code": ["agent", "reviewer"], "claude-2": ["advisor"], chatgpt: ["refuter"] };
  const usedBy = (route: string): readonly string[] => roles[route] ?? [];
  const groups = sharedRoleGroups(routes, usedBy);
  expect(groups).toEqual([["claude-code", "claude-2"]]);
  expect(sharedRoleNote(groups[0] ?? [], usedBy)).toBe("Roles on claude-code (agent, reviewer) and claude-2 (advisor) share one plan's " +
    "limits: both routes are signed in to the same account.");
  // Roles all on one route draw on one account by choice, which needs no note.
  expect(sharedRoleGroups(routes, (route) => route === "claude-code" ? ["agent", "advisor"] : [])).toEqual([]);
});

it("keeps a route and its roles when it is signed in or out, and removes it only when no role uses it", () => {
  expect(routeAfter("login", true)).toBe("keep");
  expect(routeAfter("logout", true)).toBe("keep");
  expect(routeAfter("remove", true)).toBe("refuse");
  expect(routeAfter("remove", false)).toBe("delete");
});

it("shows each route's account in the shell's Sign-ins tab, masked until s shows it, and the shared account where it matters", async () => {
  const { AccountsPanel } = await import("../src/tesota-shell-accounts.js");
  const { tesotaShellTheme } = await import("../src/tesota-shell-theme.js");
  const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
  const panel = new AccountsPanel(tesotaShellTheme("tesota-dark"), () => 40, () => 0);
  const ours = { id: "45e4b49f", email: "r3xed@outlook.es" };
  panel.setSignIns({ rows: [{ route: "claude-code", kind: "Claude Code", signIn: "signed in with claude.ai", account: ours },
    { route: "claude-2", kind: "Claude Code", signIn: "signed in with claude.ai", account: ours }], usedBy: () => [] });
  const reading = { plan: "pro", notes: [], meters: [{ label: "week", left: 80 }] };
  panel.setUsage([{ route: "claude-code", kind: "claude-code", state: "read", reading },
    { route: "claude-2", kind: "claude-code", state: "read", reading, sameAccountAs: "claude-code" }]);
  panel.setRoles([{ role: "agent", choice: "claude-code:opus", route: "claude-code" }, { role: "advisor", choice: "claude-2:opus", route: "claude-2" }]);
  const text = (): string => stripTerminalSequences(panel.render(140).join("\n"));
  // The Usage tab reads the shared account once, and its second route points to that reading.
  expect(text()).toContain("same account as claude-code: one reading, above");
  // The Roles tab says the agent and the advisor share one plan, and each role's meter is that one reading.
  panel.handleKey("3");
  expect(text()).toContain("Roles on claude-code (agent) and claude-2 (advisor) share one plan's limits");
  expect(text().match(/80%/gu)).toHaveLength(2);
  panel.handleKey("2");
  expect(text()).toContain("claude-code and claude-2 are signed in to the same account");
  expect(text()).toContain("r3…@outlook.es");
  expect(text()).not.toContain("r3xed@outlook.es");
  expect(text()).toContain("s show emails");
  panel.handleKey("s");
  expect(text()).toContain("r3xed@outlook.es");
  expect(text()).toContain("s hide emails");
});
