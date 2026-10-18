import { type AuthPrompt, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileCredentialStore } from "../src/credentials.ts";
import { chosenModel, engineModels, loginOptions } from "../src/model-access.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import { accepts, scriptedReply } from "./scripted.ts";

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

  test("the model is the one the operator chose, never one picked for them from what a credential reaches (#425)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const models = engineModels(new InMemoryCredentialStore());
    const [first] = await models.getAvailable("anthropic");
    if (first === undefined) throw new Error("No model is available with the key");
    expect(chosenModel(models, {})).toBeUndefined();
    expect(chosenModel(models, { model: `anthropic/${first.id}` })).toMatchObject({ provider: "anthropic", id: first.id });
    expect(chosenModel(models, { model: "anthropic/no-such-model" })).toBeUndefined();
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
