import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrint } from "../src/print.ts";
import { sessionsFolder } from "../src/session.ts";
import { readSessionFile } from "../src/session-file.ts";
import { writeSettings } from "../src/settings.ts";
import { scriptedReply } from "./scripted.ts";

/** Which model `tesota -p -c` and `--resume` continue on (#651). */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

function repository(): string {
  const cwd = folder("tesota-resume-model-");
  const git = (...args: string[]): void => {
    const ran = spawnSync("git", ["-c", "user.name=Tesota", "-c", "user.email=tesota@example.test", ...args], { cwd, encoding: "utf8" });
    if (ran.status !== 0) throw new Error(ran.stderr);
  };
  git("init", "-q");
  writeFileSync(join(cwd, "README.md"), "project\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  return cwd;
}

/** Two accounts of one scripted provider family, `main` the settings' default and `side@b` another account. */
function setup(): { run: (args: string[], cwd: string) => Promise<{ code: number; error: string }>; replies: (count: number) => void } {
  const main = fauxProvider({ provider: "main", models: [{ id: "m-1" }] });
  const side = fauxProvider({ provider: "side@b", models: [{ id: "s-1" }] });
  const models = createModels();
  models.setProvider(main.provider);
  models.setProvider(side.provider);
  const settingsPath = join(folder("tesota-resume-model-settings-"), "settings.json");
  writeSettings({ model: "main/m-1", permissionMode: "full" }, settingsPath);
  return {
    replies: (count) => {
      for (const each of [main, side]) each.setResponses(Array.from({ length: count }, () => scriptedReply("Done.")));
    },
    run: async (args, cwd) => {
      let error = "";
      const code = await runPrint(args, cwd, { out: () => undefined, error: (text) => { error += text; } },
        { "open-cases-model": "off" }, settingsPath, models);
      return { code, error };
    },
  };
}

const sessionOf = (cwd: string): string => {
  const [name] = readdirSync(sessionsFolder(cwd)).filter((each) => each.endsWith(".jsonl"));
  if (name === undefined) throw new Error("No session was written");
  return join(sessionsFolder(cwd), name);
};

/** The `provider/model` of each assistant message in the session, in order. */
const ranOn = (file: string): string[] =>
  readSessionFile(file).entries.flatMap((entry) => entry.type === "assistant" ? [`${entry.message.provider}/${entry.message.model}`] : []);

describe("the model a resumed print run continues on", () => {
  for (const how of ["-c", "--resume"] as const) {
    test(`${how} without --model keeps the session's model and account`, async () => {
      const { run, replies } = setup();
      replies(2);
      const cwd = repository();
      expect((await run(["Say done", "--model", "side@b/s-1"], cwd)).code).toBe(0);
      const file = sessionOf(cwd);
      const id = file.slice(file.lastIndexOf("\\") + 1).replace(/\.jsonl$/, "");
      const second = await run(how === "-c" ? ["-c", "Again"] : ["--resume", id, "Again"], cwd);
      expect(second.code).toBe(0);
      expect(second.error).not.toContain("Continuing on");
      expect(ranOn(file)).toEqual(["side@b/s-1", "side@b/s-1"]);
    });
  }

  test("--model overrides it and says so", async () => {
    const { run, replies } = setup();
    replies(2);
    const cwd = repository();
    await run(["Say done", "--model", "side@b/s-1"], cwd);
    const second = await run(["-c", "Again", "--model", "main/m-1"], cwd);
    expect(second.code).toBe(0);
    expect(second.error).toContain("Continuing on main/m-1; the session last ran on side@b/s-1.");
    expect(ranOn(sessionOf(cwd))).toEqual(["side@b/s-1", "main/m-1"]);
  });

  test("a model that can no longer run is refused, naming it and --model", async () => {
    const { run, replies } = setup();
    replies(1);
    const cwd = repository();
    await run(["Say done", "--model", "side@b/s-1"], cwd);
    // The account is gone: only the default's provider is left.
    const gone = fauxProvider({ provider: "main", models: [{ id: "m-1" }] });
    const models = createModels();
    models.setProvider(gone.provider);
    const settingsPath = join(folder("tesota-resume-model-settings-"), "settings.json");
    writeSettings({ model: "main/m-1", permissionMode: "full" }, settingsPath);
    let error = "";
    const code = await runPrint(["-c", "Again"], cwd, { out: () => undefined, error: (text) => { error += text; } },
      { "open-cases-model": "off" }, settingsPath, models);
    expect(code).toBe(1);
    expect(error).toContain("side@b/s-1");
    expect(error).toContain("--model");
    expect(ranOn(sessionOf(cwd))).toEqual(["side@b/s-1"]);
  });

  test("a session with no reply yet uses the default", async () => {
    const { run, replies } = setup();
    replies(1);
    const cwd = repository();
    // A session that failed before replying: only its header and request.
    const first = await run(["Say done"], cwd);
    expect(first.code).toBe(0);
    const file = sessionOf(cwd);
    const lines = (await Bun.file(file).text()).split("\n");
    const kept = lines.filter((line) => line !== "" && !line.includes("\"type\":\"assistant\"") && !line.includes("\"type\":\"run_end\""));
    writeFileSync(file, `${kept.join("\n")}\n`);
    expect(ranOn(file)).toEqual([]);
    const second = await run(["-c", "Again"], cwd);
    expect(second.error).not.toContain("Continuing on");
    expect(ranOn(file)).toEqual(["main/m-1"]);
  });
});
