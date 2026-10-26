import { type AuthPrompt, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileCredentialStore } from "../src/credentials.ts";
import { accountLabels, accountStates, chosenModel, engineModels, loginOptions } from "../src/model-access.ts";
import { runPrint } from "../src/print.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import { writeSettings } from "../src/settings.ts";
import { accepts, scriptedReply, signInWithChatGPT } from "./scripted.ts";

/** The models a session runs on (#443): pi-ai's catalog over the engine's credentials, never the operator's real ones. */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const open: EngineSession[] = [];
const saved = process.env["ANTHROPIC_API_KEY"];
afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.dispose()));
  if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = saved;
});

/** A scripted provider that logs in by OAuth: it shows a link, asks for the code, and is authorized by what it stored. */
function oauthProvider(id: string) {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("signed in and answering")]);
  const seen: { links: string[]; prompts: AuthPrompt["type"][] } = { links: [], prompts: [] };
  const provider = {
    ...faux.provider, id,
    auth: {
      oauth: {
        name: "Scripted OAuth",
        login: async (interaction: { notify(event: { type: string; url?: string }): void; prompt(prompt: AuthPrompt): Promise<string> }):
          Promise<OAuthCredential> => {
          interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
          const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
          return { type: "oauth", access: `token-${code}`, refresh: "refresh", expires: Date.now() + 3_600_000 };
        },
        refresh: (credential: OAuthCredential) => Promise.resolve(credential),
        toAuth: (credential: OAuthCredential) => Promise.resolve({ apiKey: credential.access }),
      },
    },
  };
  return { provider, model: { ...faux.getModel(), provider: id }, seen };
}

describe("the engine's models", () => {
  test("ChatGPT instances use separate credential slots, never the plain provider's key", async () => {
    const path = join(folder("tesota-accounts-"), "auth.json");
    const credentials = fileCredentialStore(path);
    const models = engineModels(credentials, [{ name: "work", provider: "openai-codex" }, { name: "personal", provider: "openai-codex" }]);
    expect(models.getProvider("openai-codex@work")?.auth.oauth).toBeDefined();
    expect(models.getProvider("openai-codex@work")?.auth.apiKey).toBeUndefined();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "default-key" }));
    await credentials.modify("openai-codex@work", async () => ({ type: "oauth", access: "work-token", refresh: "work-refresh", expires: Date.now() + 3_600_000, accountId: "account-work" }));
    await credentials.modify("openai-codex@personal", async () => ({ type: "oauth", access: "personal-token", refresh: "personal-refresh", expires: Date.now() + 3_600_000, accountId: "account-personal" }));
    expect((await models.getAuth("openai-codex@work"))?.auth.apiKey).toBe("work-token");
    expect((await models.getAuth("openai-codex@personal"))?.auth.apiKey).toBe("personal-token");
    expect(chosenModel(models, { model: "openai-codex@work/gpt-6.1-sol" })?.provider).toBe("openai-codex@work");
    await models.logout("openai-codex@work");
    expect(await models.checkAuth("openai-codex@work")).toBeUndefined();
    expect((await models.getAuth("openai-codex@personal"))?.auth.apiKey).toBe("personal-token");
    expect(await fileCredentialStore(path).read("openai")).toMatchObject({ key: "default-key" });
  });

  test("print mode loads accounts from its operator settings for --model and the saved model", async () => {
    const credentials = fileCredentialStore();
    await credentials.modify("openai-codex@print", async () => ({ type: "oauth", access: "print-token", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "print-account" }));
    try {
      const settingsPath = join(folder("tesota-print-accounts-"), "settings.json");
      writeSettings({ accounts: [{ name: "print", provider: "openai-codex" }], model: "openai-codex@print/not-a-model" }, settingsPath);
      for (const args of [["hi", "--model", "openai-codex@print/not-a-model"], ["hi"]]) {
        let errors = "";
        expect(await runPrint(args, folder("tesota-print-cwd-"), { out: () => undefined, error: (text) => { errors += text; } }, {}, settingsPath)).toBe(1);
        expect(errors).toContain("openai-codex@print/gpt-");
      }
    } finally { await credentials.delete("openai-codex@print"); }
  });

  test("instances are labeled by signed-in identity and duplicates flagged, including defaults", async () => {
    const credentials = new InMemoryCredentialStore();
    for (const id of ["openai-codex", "openai-codex@work"]) await credentials.modify(id, async () =>
      ({ type: "oauth", access: "token", refresh: "refresh", expires: 0, accountId: "chatgpt-account-1" }));
    const seen: (string | undefined)[] = [];
    const labels = await accountLabels(credentials, [{ name: "b", provider: "claude-code", folder: "/claude-b" },
      { name: "work", provider: "openai-codex" }], async (folder) => {
      seen.push(folder);
      return { loggedIn: true, email: "owner@example.test" };
    });
    expect(seen).toEqual([undefined, "/claude-b"]);
    expect(labels.get("claude-code")).toContain("owner@example.test");
    expect(labels.get("claude-code@b")).toBe("owner@example.test · same account as claude-code");
    expect(labels.get("openai-codex@work")).toBe("chatgpt-account-1 · same account as openai-codex");
  });

  /** Claude Code's status faked: each check waits until released, and counts how many wait at once. */
  const heldStatus = () => {
    const waiting: (() => void)[] = [];
    let open = 0;
    let most = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const status = (folder?: string, _execute?: unknown, signal?: AbortSignal) => {
      signals.push(signal);
      open += 1;
      most = Math.max(most, open);
      return new Promise<{ loggedIn: boolean; email?: string }>((resolve) => {
        waiting.push(() => { open -= 1; resolve({ loggedIn: true, email: `${folder ?? "default"}@example.test` }); });
      });
    };
    return { status, waiting, signals, most: () => most };
  };
  const claudeAccounts = ["a", "b", "c", "d", "e"].map((name) => ({ name, provider: "claude-code" as const, folder: `/claude-${name}` }));

  test("tells of the accounts at once, as being checked, then as each sign-in check returns, a bounded number at a time (#1)", async () => {
    const held = heldStatus();
    const updates: (readonly { id: string; checking?: true; identity?: string }[])[] = [];
    const states = accountStates(new InMemoryCredentialStore(), claudeAccounts, held.status, [], { concurrency: 3, onUpdate: (each) => { updates.push(each); } });
    // Before any check returns, every account is told of, being checked.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.map(({ id, checking }) => `${id} ${String(checking)}`))
      .toEqual(["claude-code true", ...claudeAccounts.map(({ name }) => `claude-code@${name} true`)]);
    await Bun.sleep(0);
    expect(held.waiting).toHaveLength(3);
    held.waiting[1]?.();
    await Bun.sleep(0);
    expect(updates.at(-1)?.map(({ checking }) => checking)).toEqual([true, undefined, true, true, true, true]);
    expect(updates.at(-1)?.[1]?.identity).toBe("/claude-a@example.test");
    for (let round = 0; round < 10 && held.waiting.length < 6; round++) { for (const release of held.waiting) release(); await Bun.sleep(0); }
    for (const release of held.waiting) release();
    const done = await states;
    expect(done.every(({ checking }) => checking === undefined)).toBe(true);
    expect(held.most()).toBe(3);
  });

  test("accountLabels, as tesota accounts lists them, still checks one sign-in at a time", async () => {
    const held = heldStatus();
    const labels = accountLabels(new InMemoryCredentialStore(), claudeAccounts, held.status);
    for (let round = 0; round < 10 && held.waiting.length < 6; round++) { held.waiting.at(-1)?.(); await Bun.sleep(0); }
    held.waiting.at(-1)?.();
    expect((await labels).size).toBe(6);
    expect(held.most()).toBe(1);
  });

  test("a stopped check gives Claude Code's status its signal, and ends without telling of more (#3)", async () => {
    const held = heldStatus();
    const stop = new AbortController();
    const updates: unknown[] = [];
    const states = accountStates(new InMemoryCredentialStore(), claudeAccounts, held.status, [], { concurrency: 2, signal: stop.signal, onUpdate: (each) => { updates.push(each); } });
    await Bun.sleep(0);
    expect(held.signals).toEqual([stop.signal, stop.signal]);
    stop.abort();
    for (const release of held.waiting) release();
    await expect(states).rejects.toThrow();
    expect(updates).toHaveLength(1);
    expect(held.signals).toHaveLength(2);
  });

  test("pi-ai's built-in providers are there, and none is available without a credential", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const models = engineModels(new InMemoryCredentialStore());
    expect(models.getProviders().map(({ id }) => id)).toEqual(expect.arrayContaining(["anthropic", "openai", "google"]));
    expect((await models.getAvailable("anthropic")).length).toBe(0);
  });

  test("an API key in the environment makes its provider available", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const models = engineModels(new InMemoryCredentialStore());
    expect((await models.getAvailable("anthropic")).length).toBeGreaterThan(0);
    expect(await models.checkAuth("anthropic")).toMatchObject({ type: "api_key" });
  });

  test("no provider offers a Claude sign-in: Anthropic takes an API key alone", () => {
    const models = engineModels(new InMemoryCredentialStore());
    expect(models.getProvider("anthropic")?.auth.oauth).toBeUndefined();
    const signIns = models.getProviders().flatMap(({ id, auth }) => auth.oauth === undefined ? [] : [`${id}: ${auth.oauth.name}`]);
    expect(signIns.filter((name) => /anthropic|claude/iu.test(name))).toEqual([]);
    // The operator's other sign-ins stay.
    expect(signIns.some((name) => name.startsWith("openai:"))).toBe(true);
  });

  test("a Claude plan's token reaches no request, from the environment, a stored key or a key entered at login", async () => {
    const saved = process.env["ANTHROPIC_OAUTH_TOKEN"];
    try {
      delete process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_OAUTH_TOKEN"] = "sk-ant-oat01-test";
      expect(await engineModels(new InMemoryCredentialStore()).checkAuth("anthropic")).toBeUndefined();
      delete process.env["ANTHROPIC_OAUTH_TOKEN"];
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-oat01-test";
      expect(await engineModels(new InMemoryCredentialStore()).checkAuth("anthropic")).toBeUndefined();
      delete process.env["ANTHROPIC_API_KEY"];
      const stored = new InMemoryCredentialStore();
      await stored.modify("anthropic", () => Promise.resolve({ type: "api_key", key: "sk-ant-oat01-test" }));
      expect(await engineModels(stored).checkAuth("anthropic")).toBeUndefined();
      const models = engineModels(new InMemoryCredentialStore());
      await expect(models.login("anthropic", "api_key", { prompt: () => Promise.resolve("sk-ant-oat01-test"), notify: () => undefined }))
        .rejects.toThrow("Tesota takes no Claude plan token");
      expect(await models.checkAuth("anthropic")).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env["ANTHROPIC_OAUTH_TOKEN"];
      else process.env["ANTHROPIC_OAUTH_TOKEN"] = saved;
    }
  });

  test("the model is the one the operator chose, never one picked for them from what a credential reaches (#425)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const models = engineModels(new InMemoryCredentialStore());
    const [first] = await models.getAvailable("anthropic");
    if (first === undefined) throw new Error("No model is available with the key");
    expect(chosenModel(models, {})).toBeUndefined();
    expect(chosenModel(models, { model: `anthropic/${first.id}` })).toMatchObject({ provider: "anthropic", id: first.id });
    expect(chosenModel(models, { model: "anthropic/no-such-model" })).toBeUndefined();
  });

  test("with ChatGPT sign-in, -p refuses a --model or a saved model it does not serve, naming those it serves (#566)", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = engineModels(credentials);
    const signOut = await signInWithChatGPT(models, credentials, ["gpt-6.1-sol"]);
    try {
      const settingsPath = join(folder("tesota-core-print-"), "settings.json");
      writeSettings({ model: "openai/gpt-5.5" }, settingsPath);
      for (const args of [["hi", "--model", "openai/gpt-5.5"], ["hi"]]) {
        let errors = "";
        const code = await runPrint(args, folder("tesota-core-print-cwd-"), { out: () => undefined, error: (text) => { errors += text; } },
          {}, settingsPath, models);
        expect(code).toBe(1);
        expect(errors).toContain("no model openai/gpt-5.5");
        expect(errors).toContain("openai/gpt-6.1-sol");
      }
    } finally {
      signOut();
    }
  });

  test("with ChatGPT sign-in, -p keeps a --model or saved model it could not check, saying why (#567)", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = engineModels(credentials);
    const signOut = await signInWithChatGPT(models, credentials, "offline");
    try {
      const settingsPath = join(folder("tesota-core-print-"), "settings.json");
      writeSettings({ model: "openai/gpt-6.1-sol" }, settingsPath);
      for (const args of [["hi", "--model", "openai/gpt-6.1-sol"], ["hi"]]) {
        let errors = "";
        await runPrint(args, folder("tesota-core-print-cwd-"), { out: () => undefined, error: (text) => { errors += text; } },
          {}, settingsPath, models);
        expect(errors).not.toContain("Not run:");
        expect(errors).toContain("openai/gpt-6.1-sol was not checked against the models the ChatGPT sign-in serves");
        // It ran: offline, the request itself fails.
        expect(errors).toContain("Ended error");
      }
    } finally {
      signOut();
    }
  });

  test("-p names an agent type whose model it does not run, with the model it runs on instead (#568)", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = engineModels(credentials);
    const signOut = await signInWithChatGPT(models, credentials, "offline");
    try {
      const cwd = folder("tesota-core-print-cwd-");
      mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
      writeFileSync(join(cwd, ".agents", "agents", "advisor.md"), "---\nname: advisor\ndescription: Advises\nclaude.model: opus\n---\nAdvise.\n");
      let errors = "";
      await runPrint(["hi", "--model", "openai/gpt-6.1-sol"], cwd, { out: () => undefined, error: (text) => { errors += text; } },
        {}, join(folder("tesota-core-print-"), "settings.json"), models);
      expect(errors).toContain("Agent type advisor (claude.model) runs on the session's model, openai/gpt-6.1-sol, unless the call names one");
    } finally {
      signOut();
    }
  });

  test("logging in stores the credential in the engine's file, and logging out removes it", async () => {
    const path = join(folder("tesota-core-models-"), "auth.json");
    const models = engineModels(fileCredentialStore(path));
    const scripted = oauthProvider("scripted-oauth");
    models.setProvider(scripted.provider as never);
    const credential = await models.login("scripted-oauth", "oauth", {
      prompt: (prompt) => { scripted.seen.prompts.push(prompt.type); return Promise.resolve("1234"); },
      notify: (event) => { if (event.type === "auth_url") scripted.seen.links.push(event.url); },
    }, loginOptions(join(folder("tesota-core-settings-"), "settings.json")));
    expect(credential).toMatchObject({ type: "oauth", access: "token-1234" });
    expect(scripted.seen).toEqual({ links: ["https://example.test/authorize"], prompts: ["manual_code"] });
    expect(await fileCredentialStore(path).read("scripted-oauth")).toMatchObject({ access: "token-1234" });
    await models.logout("scripted-oauth");
    expect(await fileCredentialStore(path).read("scripted-oauth")).toBeUndefined();
  });

  test("each request carries the session's id, which providers use as its prompt-cache key", async () => {
    const asked: (string | undefined)[] = [];
    const faux = fauxProvider();
    faux.setResponses([scriptedReply({ seen: (_context, options) => { asked.push(options?.sessionId); }, reply: "done" })]);
    const models = engineModels(new InMemoryCredentialStore());
    models.setProvider(faux.provider);
    const session = createSession({ cwd: folder("tesota-core-cwd-"), folder: folder("tesota-core-sessions-"), models,
      model: faux.getModel(), verifier: accepts });
    open.push(session);
    await session.prompt("go");
    expect(asked).toEqual([basename(session.file, ".jsonl")]);
  });

  test("a session runs on the engine's models once its provider is logged in", async () => {
    const models = engineModels(fileCredentialStore(join(folder("tesota-core-models-"), "auth.json")));
    const scripted = oauthProvider("scripted-session");
    models.setProvider(scripted.provider as never);
    await models.login("scripted-session", "oauth", { prompt: () => Promise.resolve("5678"), notify: () => undefined });
    const session = createSession({ cwd: folder("tesota-core-cwd-"), folder: folder("tesota-core-sessions-"), models,
      model: scripted.model, verifier: accepts });
    open.push(session);
    await session.prompt("hello");
    expect(session.lastAssistantText()).toBe("signed in and answering");
    expect(session.outcome()).toBe("completed");
  });
});
