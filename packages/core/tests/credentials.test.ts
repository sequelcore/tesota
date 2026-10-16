import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentialStore } from "../src/credentials.ts";

/** The engine's credentials file (#443), always in a temporary folder. */
const fileIn = (): string => join(mkdtempSync(join(tmpdir(), "tesota-core-credentials-")), "auth.json");
const oauth = (access: string) => ({ type: "oauth" as const, access, refresh: "refresh", expires: 1 });

describe("the credentials file", () => {
  test("a credential written is read back, by this store and a new one, and logging out removes only it", async () => {
    const path = fileIn();
    const store = fileCredentialStore(path);
    expect(await store.read("anthropic")).toBeUndefined();
    await store.modify("anthropic", () => Promise.resolve(oauth("a")));
    await store.modify("openai", () => Promise.resolve({ type: "api_key", key: "sk-secret" }));
    expect(await fileCredentialStore(path).read("anthropic")).toEqual(oauth("a"));
    await store.delete("anthropic");
    expect(await store.read("anthropic")).toBeUndefined();
    expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-secret" });
  });

  test("a change that returns nothing leaves the credential as it was", async () => {
    const store = fileCredentialStore(fileIn());
    await store.modify("anthropic", () => Promise.resolve(oauth("a")));
    expect(await store.modify("anthropic", () => Promise.resolve(undefined))).toEqual(oauth("a"));
    expect(await store.read("anthropic")).toEqual(oauth("a"));
  });

  test("listing names each provider and its kind, and no secret", async () => {
    const store = fileCredentialStore(fileIn());
    await store.modify("openai", () => Promise.resolve({ type: "api_key", key: "sk-secret" }));
    const listed = await store.list();
    expect(listed).toEqual([{ providerId: "openai", type: "api_key" }]);
    expect(JSON.stringify(listed)).not.toContain("sk-secret");
  });

  test("a change that fails leaves the file as it was", async () => {
    const path = fileIn();
    const store = fileCredentialStore(path);
    await store.modify("anthropic", () => Promise.resolve(oauth("a")));
    const before = readFileSync(path, "utf8");
    await expect(store.modify("anthropic", () => Promise.reject(new Error("refresh failed")))).rejects.toThrow("refresh failed");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("changes from two stores at once both land: each reads what the other wrote", async () => {
    const path = fileIn();
    const [first, second] = [fileCredentialStore(path), fileCredentialStore(path)];
    const slow = (access: string) => async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return oauth(access); };
    await Promise.all([first.modify("anthropic", slow("a")), second.modify("openai", slow("b")),
      first.modify("google", slow("c"))]);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object).sort()).toEqual(["anthropic", "google", "openai"]);
  });

  test("a file that holds no credentials is a failure, never read as empty", async () => {
    const path = fileIn();
    writeFileSync(path, "not json");
    await expect(fileCredentialStore(path).read("anthropic")).rejects.toThrow();
  });

  test.if(process.platform !== "win32")("only its owner can read the file", async () => {
    const path = fileIn();
    await fileCredentialStore(path).modify("anthropic", () => Promise.resolve(oauth("a")));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
