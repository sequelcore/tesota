import { type AuthInteraction, InMemoryCredentialStore, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AccountHands, accountsCommand, accountsView, addAccount, claudeAccountFolder, removeAccount, signInAgain } from "../src/accounts.ts";
import { chosenModel, engineModels } from "../src/model-access.ts";
import { readSettings, writeSettings } from "../src/settings.ts";

/**
 * Adding, signing in again, viewing and removing an account in one step
 * (#642). Signing in itself is Claude Code's and ChatGPT's: both are faked,
 * and Tesota's part is checked: the folder it makes, what it records in the
 * operator's settings, and what it refuses.
 */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const noInteraction: AuthInteraction = { prompt: () => Promise.reject(new Error("no prompt expected")), notify: () => undefined };

/** Claude Code faked: each sign-in in a folder makes that folder signed in to `emails[folder]`, or to nothing. */
function fakeClaude(emails: Record<string, string> = {}) {
  const signedIn = new Map<string, string>();
  const signIns: string[] = [];
  return {
    signIns,
    signedIn,
    claude: {
      signIn: async (at: string) => {
        signIns.push(at);
        expect(existsSync(at)).toBe(true);
        const email = emails[at] ?? emails["*"];
        if (email !== undefined) signedIn.set(at, email);
      },
      status: async (at?: string) => {
        const email = at === undefined ? emails["default"] : signedIn.get(at);
        return email === undefined ? { loggedIn: false } : { loggedIn: true, email };
      },
    },
  };
}

/** The engine's models, with ChatGPT's sign-in scripted: each login stores a token for `accountId`. */
function hands(overrides: Partial<AccountHands> = {}, accountId = "chatgpt-account-1") {
  const credentials = new InMemoryCredentialStore();
  const models = engineModels(credentials, []);
  const codex = models.getProvider("openai-codex");
  if (codex?.auth.oauth === undefined) throw new Error("no Codex provider");
  let logins = 0;
  models.setProvider({ ...codex, auth: { oauth: { ...codex.auth.oauth,
    login: async (_interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
      logins++;
      return { type: "oauth", access: `token-${logins}`, refresh: "refresh", expires: Date.now() + 3_600_000, accountId };
    } } } });
  const settingsPath = join(folder("tesota-accounts-"), "settings.json");
  const cwd = folder("tesota-accounts-cwd-");
  const fake = fakeClaude({ "*": "owner@example.test" });
  const given: AccountHands = { settingsPath, models, credentials, interaction: noInteraction, cwd, claude: fake.claude, ...overrides };
  return { hands: given, credentials, models, settingsPath, cwd, fake, logins: () => logins };
}

describe("adding an account in one step", () => {
  test("a Claude account gets its own folder, Claude Code's sign-in there, and its record, keeping every other setting", async () => {
    const { hands: given, settingsPath, fake } = hands();
    writeSettings({ model: "openai/gpt-6.1-sol", permissionMode: "full", accounts: [{ name: "work", provider: "openai-codex" }] }, settingsPath);
    const said = await addAccount(given, "claude-code", "b");
    const made = claudeAccountFolder(settingsPath, "b");
    expect(made).toBe(join(dirname(settingsPath), "accounts", "claude-code", "b"));
    expect(fake.signIns).toEqual([made]);
    expect(said).toContain("claude-code@b");
    expect(said).toContain("owner@example.test");
    const { settings } = readSettings(settingsPath);
    expect(settings).toEqual({ model: "openai/gpt-6.1-sol", permissionMode: "full",
      accounts: [{ name: "work", provider: "openai-codex" }, { name: "b", provider: "claude-code", folder: made }] });
    // With no hand edit, the next Tesota offers it as a provider for --model, on that folder.
    const next = engineModels(new InMemoryCredentialStore(), settings.accounts);
    const id = next.getModels("claude-code@b")[0]?.id;
    expect(id).toBeDefined();
    expect(chosenModel(next, { model: `claude-code@b/${id}` })?.provider).toBe("claude-code@b");
  });

  test("a Claude account whose sign-in did not finish is not recorded", async () => {
    const fake = fakeClaude();
    const { hands: given, settingsPath } = hands({ claude: fake.claude });
    await expect(addAccount(given, "claude-code", "b")).rejects.toThrow("not signed in");
    expect(fake.signIns).toHaveLength(1);
    expect(readSettings(settingsPath).settings.accounts).toBeUndefined();
    // The folder made for it goes too, so adding it again starts afresh.
    expect(existsSync(claudeAccountFolder(settingsPath, "b"))).toBe(false);
  });

  test("a Claude account is added only in a folder Tesota makes, never in one already there", async () => {
    const { hands: given, settingsPath, fake } = hands();
    const there = claudeAccountFolder(settingsPath, "b");
    mkdirSync(there, { recursive: true });
    writeFileSync(join(there, "yours.json"), "{}");
    await expect(addAccount(given, "claude-code", "b")).rejects.toThrow("already exists");
    expect(fake.signIns).toEqual([]);
    expect(existsSync(join(there, "yours.json"))).toBe(true);
  });

  test("an invalid accounts setting is never written over: adding and removing are refused until it is fixed", async () => {
    const { hands: given, settingsPath, fake } = hands();
    const written = [{ name: "a", provider: "claude-code", folder: "relative/a" }, { name: "b", provider: "openai-codex" }];
    writeFileSync(settingsPath, JSON.stringify({ accounts: written }));
    await expect(addAccount(given, "openai-codex", "c")).rejects.toThrow("accounts setting is invalid");
    await expect(removeAccount(given, "openai-codex@b")).rejects.toThrow("accounts setting is invalid");
    expect(fake.signIns).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ accounts: written });
  });

  test("a name that differs from another only in case is the same account, since folders may not tell them apart", async () => {
    const { hands: given } = hands();
    await addAccount(given, "claude-code", "work");
    await expect(addAccount(given, "claude-code", "Work")).rejects.toThrow("already");
  });

  test("a ChatGPT account signs in to its own slot, then is recorded, and runs at once in this Tesota", async () => {
    const { hands: given, settingsPath, credentials, models } = hands();
    writeSettings({ model: "claude-code/claude-opus-5-5" }, settingsPath);
    const said = await addAccount(given, "openai-codex", "work");
    expect(said).toContain("openai-codex@work");
    expect(await credentials.read("openai-codex@work")).toMatchObject({ type: "oauth", access: "token-1" });
    expect(await credentials.read("openai-codex")).toBeUndefined();
    expect(readSettings(settingsPath).settings).toEqual({ model: "claude-code/claude-opus-5-5", accounts: [{ name: "work", provider: "openai-codex" }] });
    expect(models.getProvider("openai-codex@work")).toBeDefined();
  });

  test("a ChatGPT sign-in that fails records nothing", async () => {
    const { hands: given, settingsPath, models } = hands();
    const codex = models.getProvider("openai-codex");
    if (codex?.auth.oauth === undefined) throw new Error("no Codex provider");
    models.setProvider({ ...codex, auth: { oauth: { ...codex.auth.oauth, login: () => Promise.reject(new Error("Login cancelled")) } } });
    await expect(addAccount(given, "openai-codex", "work")).rejects.toThrow("Login cancelled");
    expect(readSettings(settingsPath).settings.accounts).toBeUndefined();
  });

  test("an account already there, an invalid name, or another provider is refused before any sign-in", async () => {
    const { hands: given, settingsPath, fake, logins } = hands();
    writeSettings({ accounts: [{ name: "b", provider: "claude-code", folder: folder("claude-b-") }] }, settingsPath);
    await expect(addAccount(given, "claude-code", "b")).rejects.toThrow("already");
    await expect(addAccount(given, "claude-code", "not a name")).rejects.toThrow("name");
    await expect(addAccount(given, "anthropic", "b")).rejects.toThrow("claude-code or openai-codex");
    expect(fake.signIns).toEqual([]);
    expect(logins()).toBe(0);
  });
});

describe("signing an account in again", () => {
  test("a Claude account signs in again in its own folder; its record is unchanged", async () => {
    const { hands: given, settingsPath, fake } = hands();
    const own = folder("claude-b-");
    const accounts = [{ name: "b", provider: "claude-code" as const, folder: own }];
    writeSettings({ accounts }, settingsPath);
    expect(await signInAgain(given, "claude-code@b")).toContain("owner@example.test");
    expect(fake.signIns).toEqual([own]);
    expect(readSettings(settingsPath).settings.accounts).toEqual(accounts);
  });

  test("a ChatGPT account replaces its own slot's sign-in only", async () => {
    const { hands: given, settingsPath, credentials } = hands();
    writeSettings({ accounts: [{ name: "work", provider: "openai-codex" }] }, settingsPath);
    await credentials.modify("openai-codex", async () => ({ type: "oauth", access: "default", refresh: "r", expires: 0 }));
    await addAccount(given, "openai-codex", "other");
    await signInAgain(given, "openai-codex@work");
    expect(await credentials.read("openai-codex@work")).toMatchObject({ access: "token-2" });
    expect(await credentials.read("openai-codex@other")).toMatchObject({ access: "token-1" });
    expect(await credentials.read("openai-codex")).toMatchObject({ access: "default" });
  });

  test("an account that is not there is named", async () => {
    const { hands: given } = hands();
    await expect(signInAgain(given, "claude-code@nobody")).rejects.toThrow("no account claude-code@nobody");
  });
});

describe("the view of the accounts", () => {
  test("lists each account with its signed-in identity and flags the same account signed in twice", async () => {
    const fake = fakeClaude({ default: "owner@example.test" });
    const { hands: given, settingsPath, credentials } = hands({ claude: fake.claude });
    const b = folder("claude-b-");
    const c = folder("claude-c-");
    fake.signedIn.set(b, "owner@example.test");
    fake.signedIn.set(c, "second@example.test");
    writeSettings({ accounts: [{ name: "b", provider: "claude-code", folder: b }, { name: "c", provider: "claude-code", folder: c },
      { name: "work", provider: "openai-codex" }, { name: "idle", provider: "openai-codex" }] }, settingsPath);
    await credentials.modify("openai-codex@work", async () => ({ type: "oauth", access: "t", refresh: "r", expires: 0, accountId: "chatgpt-1" }));
    const view = await accountsView(given);
    expect(view).toContain("claude-code@b");
    expect(view).toMatch(/claude-code@b .*owner@example\.test · same account as claude-code/u);
    expect(view).toMatch(/claude-code@c .*second@example\.test/u);
    expect(view).not.toMatch(/claude-code@c .*same account/u);
    expect(view).toMatch(/openai-codex@work .*chatgpt-1/u);
    expect(view).toMatch(/openai-codex@idle .*not signed in/u);
    expect(view).toContain(b);
  });

  test("with no account, says how to add one", async () => {
    const { hands: given } = hands();
    expect(await accountsView(given)).toContain("tesota accounts add");
  });
});

describe("removing an account", () => {
  test("refused while the model setting or an agent type names it, saying which", async () => {
    const { hands: given, settingsPath, cwd } = hands();
    const accounts = [{ name: "b", provider: "claude-code" as const, folder: folder("claude-b-") }, { name: "work", provider: "openai-codex" as const }];
    writeSettings({ accounts, model: "claude-code@b/claude-opus-5-5" }, settingsPath);
    mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews\nmodel: openai-codex@work/gpt-6.1-sol\n---\nReview.\n");
    await expect(removeAccount(given, "claude-code@b")).rejects.toThrow(/model setting/u);
    await expect(removeAccount(given, "openai-codex@work")).rejects.toThrow(/agent type reviewer/u);
    expect(readSettings(settingsPath).settings.accounts).toEqual(accounts);
  });

  test("an account in no use is removed from the settings, and its ChatGPT sign-in with it", async () => {
    const { hands: given, settingsPath, credentials } = hands();
    writeSettings({ accounts: [{ name: "work", provider: "openai-codex" }, { name: "home", provider: "openai-codex" }], model: "openai-codex@home/gpt-6.1-sol" }, settingsPath);
    await credentials.modify("openai-codex@work", async () => ({ type: "oauth", access: "t", refresh: "r", expires: 0 }));
    await removeAccount(given, "openai-codex@work");
    expect(readSettings(settingsPath).settings).toEqual({ accounts: [{ name: "home", provider: "openai-codex" }], model: "openai-codex@home/gpt-6.1-sol" });
    expect(await credentials.read("openai-codex@work")).toBeUndefined();
  });

  test("removes the folder Tesota made, never one the operator made by hand", async () => {
    const { hands: given, settingsPath } = hands();
    await addAccount(given, "claude-code", "made");
    const made = claudeAccountFolder(settingsPath, "made");
    const own = folder("claude-own-");
    writeFileSync(join(own, "keep.json"), "{}");
    const accounts = readSettings(settingsPath).settings.accounts ?? [];
    writeSettings({ accounts: [...accounts, { name: "own", provider: "claude-code", folder: own }] }, settingsPath);
    await removeAccount(given, "claude-code@made");
    expect(existsSync(made)).toBe(false);
    // Nor one another account still uses.
    await addAccount(given, "claude-code", "shared");
    const shared = claudeAccountFolder(settingsPath, "shared");
    writeSettings({ accounts: [...readSettings(settingsPath).settings.accounts ?? [], { name: "same", provider: "claude-code", folder: shared }] }, settingsPath);
    expect(await removeAccount(given, "claude-code@shared")).toContain("claude-code@same");
    expect(existsSync(shared)).toBe(true);
    await removeAccount(given, "claude-code@same");
    expect(await removeAccount(given, "claude-code@own")).toContain(own);
    expect(existsSync(join(own, "keep.json"))).toBe(true);
    expect(readSettings(settingsPath).settings.accounts).toEqual([]);
  });
});

describe("tesota accounts", () => {
  test("adds, lists and removes, answering with a code a script can read", async () => {
    const { hands: given, settingsPath } = hands();
    let out = "";
    let error = "";
    const output = { out: (text: string) => { out += text; }, error: (text: string) => { error += text; } };
    expect(await accountsCommand(["add", "claude-code", "b"], output, given)).toBe(0);
    expect(await accountsCommand([], output, given)).toBe(0);
    expect(out).toMatch(/claude-code@b .*owner@example\.test/u);
    writeSettings({ ...readSettings(settingsPath).settings, model: "claude-code@b/claude-opus-5-5" }, settingsPath);
    expect(await accountsCommand(["remove", "claude-code@b"], output, given)).toBe(1);
    expect(error).toContain("model setting");
    expect(await accountsCommand(["rename", "b"], output, given)).toBe(2);
    expect(error).toContain("tesota accounts add");
  });
});
