import type { AuthInteraction, CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { accountUses } from "./account-rule.ts";
import { agentTypes } from "./agents.ts";
import { fileCredentialStore } from "./credentials.ts";
import { accountId, accountLabels, type AccountState, accountStates, type AccountStatesOptions, engineModels, loginOptions,
  setAccountProvider } from "./model-access.ts";
import { claudeCodeLogin, claudeCodeStatus } from "./providers/claude-code.ts";
import { type Account, accountName, readSettings, updateSettings } from "./settings.ts";

/**
 * The operator's accounts (#642), added, signed in again, listed and
 * removed in one step each, kept in the `accounts` setting (#636) and
 * nowhere else. Signing in is the provider's own: Claude Code's in the
 * account's folder, which Tesota only starts, and pi-ai's ChatGPT sign-in
 * into the account's own credential slot.
 */

/** Claude Code in an account's folder: its own sign-in, and what it says of it. A test gives its own. */
export interface ClaudeCode {
  readonly signIn: (folder: string) => Promise<void>;
  readonly status: typeof claudeCodeStatus;
}

/** What managing accounts works with. */
export interface AccountHands {
  readonly settingsPath: string;
  readonly models: MutableModels;
  readonly credentials: CredentialStore;
  /** How ChatGPT's sign-in shows its link and asks. */
  readonly interaction: AuthInteraction;
  /** Where the agent types that may name an account are read from. */
  readonly cwd: string;
  /** The operator's own Claude Code, when not given. */
  readonly claude?: ClaudeCode;
}

const providers = ["claude-code", "openai-codex"] as const;
const usage = "Use: tesota accounts, tesota accounts add claude-code|openai-codex <name>, "
  + "tesota accounts login <provider>@<name>, tesota accounts remove <provider>@<name>.";

/** The folder Tesota makes for the Claude account `name`: under `accounts/claude-code` beside the settings, in `~/.tesota`. */
export const claudeAccountFolder = (settingsPath: string, name: string): string => join(dirname(settingsPath), "accounts", "claude-code", name);

/** The declared accounts; a list the settings check rejects is refused rather than written over, which would lose it. */
function declared(hands: AccountHands): readonly Account[] {
  const read = readSettings(hands.settingsPath);
  if (read.invalid.includes("accounts")) throw new Error(`The accounts setting is invalid: fix it in ${hands.settingsPath} first.`);
  return read.settings.accounts ?? [];
}

/** `given`, or the operator's own Claude Code. */
export const claudeOf = (given: ClaudeCode | undefined): ClaudeCode => given ?? { signIn: claudeCodeLogin, status: claudeCodeStatus };

function find(hands: AccountHands, id: string): Account {
  const account = declared(hands).find((each) => accountId(each) === id);
  if (account === undefined) throw new Error(`There is no account ${id}: tesota accounts lists them.`);
  return account;
}

/** Signs `account` in with its provider's own sign-in, then says what it is signed in to, as the view does. */
async function signIn(hands: AccountHands, account: Account, accounts: readonly Account[]): Promise<string> {
  const id = accountId(account);
  const claude = claudeOf(hands.claude);
  if (account.provider === "claude-code") {
    await claude.signIn(account.folder);
    if (!(await claude.status(account.folder)).loggedIn) throw new Error(`${id} is not signed in: Claude Code's sign-in did not finish.`);
  } else {
    if (hands.models.getProvider(id) === undefined) setAccountProvider(hands.models, account);
    await hands.models.login(id, "oauth", hands.interaction, loginOptions(hands.settingsPath));
  }
  return `${id}: ${(await accountLabels(hands.credentials, accounts, claude.status)).get(id) ?? "signed in"}`;
}

/**
 * Adds the account `name` of `provider` in one step: for Claude, its own
 * folder and Claude Code's sign-in there; for ChatGPT, the sign-in for its
 * own slot. It is recorded only once signed in, and is then a provider of
 * this Tesota's models and of the next one's, with no edit by hand.
 */
export async function addAccount(hands: AccountHands, provider: string, name: string): Promise<string> {
  if (!providers.some((each) => each === provider)) throw new Error(`An account's provider is claude-code or openai-codex, not ${provider}.`);
  if (!accountName.test(name)) throw new Error(`An account's name is letters, digits, _ or -, not "${name}".`);
  const account: Account = provider === "claude-code" ? { name, provider, folder: claudeAccountFolder(hands.settingsPath, name) }
    : { name, provider: "openai-codex" };
  const id = accountId(account);
  const accounts = declared(hands);
  // Names that differ only in case would share a folder where the file system does not tell them apart.
  if (accounts.some((each) => each.provider === provider && each.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`${id} is already an account: sign it in again with tesota accounts login ${id}.`);
  }
  if (account.provider === "claude-code") {
    // Only a folder Tesota made is ever removed with its account, so it never takes over one that is already there.
    if (existsSync(account.folder)) throw new Error(`${account.folder} already exists: declare it by hand in the accounts setting, or remove it.`);
    mkdirSync(account.folder, { recursive: true, mode: 0o700 });
  }
  let said: string;
  try {
    said = await signIn(hands, account, [...accounts, account]);
  } catch (error) {
    // Nothing of an account that did not sign in is kept: not its instance, nor the folder made for it here.
    hands.models.deleteProvider(id);
    if (account.provider === "claude-code") rmSync(account.folder, { recursive: true, force: true });
    throw error;
  }
  updateSettings((current) => ({ accounts: [...(current.accounts ?? []).filter((each) => accountId(each) !== id), account] }), hands.settingsPath);
  setAccountProvider(hands.models, account);
  return `Added ${said}.`;
}

/** Signs the account `id` in again, with its own sign-in, without removing it. */
export async function signInAgain(hands: AccountHands, id: string): Promise<string> {
  return `${await signIn(hands, find(hands, id), declared(hands))}.`;
}

/**
 * Removes the account `id`, unless the model setting or an agent type still
 * names it. Its ChatGPT sign-in goes with it, and so does the Claude folder
 * Tesota made for it; a folder the operator made by hand stays.
 */
export async function removeAccount(hands: AccountHands, id: string): Promise<string> {
  const account = find(hands, id);
  const { model } = readSettings(hands.settingsPath).settings;
  const users = [...model === undefined ? [] : [{ who: `the model setting (${model})`, model }],
    ...agentTypes(hands.cwd).flatMap(({ name, path, model: typed }) => typed === undefined ? [] : [{ who: `agent type ${name} (${path})`, model: typed }])];
  const uses = accountUses(users.map((user) => user.model.split("/")[0] ?? ""), id);
  const using = users.filter((_, at) => uses[at] === true).map(({ who }) => who);
  if (using.length > 0) throw new Error(`${id} is in use by ${using.join(", ")}: choose another account there first.`);
  updateSettings((current) => ({ accounts: (current.accounts ?? []).filter((each) => accountId(each) !== id) }), hands.settingsPath);
  hands.models.deleteProvider(id);
  if (account.provider === "openai-codex") {
    await hands.credentials.delete(id);
    return `Removed ${id} and its ChatGPT sign-in.`;
  }
  const own = claudeAccountFolder(hands.settingsPath, account.name);
  if (!sameFolder(account.folder, own)) return `Removed ${id}. Its folder, ${account.folder}, is yours and stays.`;
  const sharing = declared(hands).filter((each) => each.provider === "claude-code" && sameFolder(each.folder, own)).map(accountId);
  if (sharing.length > 0) return `Removed ${id}. Its folder, ${own}, stays: ${sharing.join(", ")} uses it.`;
  rmSync(own, { recursive: true, force: true });
  return `Removed ${id} and the folder Tesota made for it, ${own}.`;
}

/**
 * Each account, with what it is signed in to and whether another is the same
 * account, as `/accounts` and `tesota accounts` list them. `session` is the
 * provider the shell's session runs on: its default sign-in is listed too.
 * `options` checks sign-ins at once and tells of the rows as each returns, as
 * `accountStates` does; one at a time, telling no one, unless given.
 */
export async function accountRows(hands: AccountHands, session?: string,
  { onUpdate, ...options }: Omit<AccountStatesOptions, "onUpdate"> & { readonly onUpdate?: (rows: readonly AccountRow[]) => void } = {}):
  Promise<readonly AccountRow[]> {
  const accounts = declared(hands);
  const rows = (states: readonly AccountState[]): AccountRow[] => states.map(({ id, provider, label, signedIn, identity, checking }) => {
    const account = accounts.find((each) => accountId(each) === id);
    return { id, provider, label, signedIn, ...identity === undefined ? {} : { identity }, ...checking === true ? { checking } : {},
      ...account === undefined ? { default: true as const } : account.provider === "claude-code" ? { folder: account.folder } : {} };
  });
  return rows(await accountStates(hands.credentials, accounts, claudeOf(hands.claude).status, session === undefined ? [] : [session],
    { ...options, ...onUpdate === undefined ? {} : { onUpdate: (states) => { onUpdate(rows(states)); } } }));
}

/** An account in the view: a declared one, or a provider's default sign-in, listed so a duplicate of it is plain. */
export interface AccountRow {
  readonly id: string;
  readonly provider: Account["provider"];
  readonly label: string;
  readonly signedIn: boolean;
  /** Whom it is signed in to, when the provider says. */
  readonly identity?: string;
  readonly folder?: string;
  readonly default?: true;
  /** Its sign-in is still being checked. */
  readonly checking?: true;
}

/** The accounts as text, one to a line, or how to add one. */
export async function accountsView(hands: AccountHands): Promise<string> {
  const rows = await accountRows(hands);
  if (rows.length === 0) return "No accounts. Add one: tesota accounts add claude-code <name>, or tesota accounts add openai-codex <name>; in the shell, /login.\n";
  return rows.map((row) => `${row.id}${row.default === true ? " (default)" : ""}  ${row.label}${row.folder === undefined ? "" : `  ${row.folder}`}\n`).join("");
}

/**
 * `tesota accounts`: lists the accounts, or adds, signs in again or removes
 * one; 0 when done, 1 when refused or not signed in, 2 for a command it does
 * not know.
 */
export async function accountsCommand(args: readonly string[], output: { out(text: string): void; error(text: string): void },
  hands: AccountHands = cliHands(output)): Promise<number> {
  const [action, first, second] = args;
  try {
    if (action === undefined || action === "list") output.out(await accountsView(hands));
    else if (action === "add" && first !== undefined && second !== undefined) output.out(`${await addAccount(hands, first, second)}\n`);
    else if (action === "login" && first !== undefined) output.out(`${await signInAgain(hands, first)}\n`);
    else if (action === "remove" && first !== undefined) output.out(`${await removeAccount(hands, first)}\n`);
    else { output.error(`${usage}\n`); return 2; }
    return 0;
  } catch (error) {
    output.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** The operator's own settings, credentials and models, and a sign-in that asks on this terminal. */
function cliHands(output: { error(text: string): void }): AccountHands {
  const settingsPath = join(tesotaHome(), "settings.json");
  const credentials = fileCredentialStore();
  return { settingsPath, credentials, models: engineModels(credentials, readSettings(settingsPath).settings.accounts ?? []),
    cwd: process.cwd(), interaction: terminalInteraction(output) };
}

/** A sign-in's link, code and questions on the terminal: on standard error, so standard output stays the command's answer. */
function terminalInteraction(output: { error(text: string): void }): AuthInteraction {
  return {
    notify: (event) => {
      output.error(`${event.type === "auth_url" ? `Open ${event.url}${event.instructions === undefined ? "" : ` (${event.instructions})`}`
        : event.type === "device_code" ? `Enter ${event.userCode} at ${event.verificationUri}` : event.message}\n`);
    },
    prompt: async (prompt) => {
      const { createInterface } = await import("node:readline/promises");
      const lines = createInterface({ input: process.stdin, output: process.stderr });
      const options = prompt.type === "select" ? prompt.options : [];
      try {
        const answer = await lines.question(`${[prompt.message, ...options.map(({ label }, at) => `${at + 1}. ${label}`)].join("\n")}\n> `,
          prompt.signal === undefined ? {} : { signal: prompt.signal });
        return options[Number(answer) - 1]?.id ?? answer.trim();
      } finally { lines.close(); }
    },
  };
}

/** Whether two folders are the same; by name without case, since the file systems of Windows and macOS do not tell case apart. */
const sameFolder = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();
