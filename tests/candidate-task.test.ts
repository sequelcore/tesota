import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { PiDecisionTask, checkCandidateTask, PI_DECISION_TASK_STATUS } from "../src/candidate-task.js";

const editedFile = "docs/decisions/002-use-pi.md";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (result.status !== 0) throw new Error("Fixture Git failed");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-task-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  git(source, ["init", "--quiet"]);
  for (const path of [editedFile, "docs/roadmap.md", "experiments/codex/history.md", "src/cli.ts"]) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), await readFile(new URL("../" + path, import.meta.url)));
  }
  git(source, ["add", "."]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "--quiet", "-m", "Task baseline"]);
  const candidate = await createCandidateCheckout(source, join(root, "candidates"));
  return { source, ...candidate };
}

function correction(content: string): string {
  return content.replace(/Status:[\s\S]*?(?=\n\n## Decision and rationale)/, PI_DECISION_TASK_STATUS);
}

it("permits the exact documentation correction, binds its checks to bytes and preserves the source", async () => {
  const candidate = await fixture();
  const task = await PiDecisionTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  const before = await task.check();
  expect(before).toMatchObject({ status: "check_failed", provenance: "issued", taskAcceptance: "not_evaluated" });
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) });
  const after = await task.check();
  expect(after.status).toBe("passed");
  expect(after.sourceSha256).not.toBe(before.sourceSha256);
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(input.content);
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(correction(input.content));
  task.close();
  expect(await checkCandidateTask(candidate.directory)).toMatchObject({ status: "passed", provenance: "recorded_untrusted" });
  await expect(task.replace({ path: editedFile, expectedSha256: after.sourceSha256, content: input.content })).rejects.toThrow("closed");
  await writeFile(join(candidate.checkout, editedFile), input.content);
  expect((await checkCandidateTask(candidate.directory)).status).toBe("check_failed");
});

it.each(["../source/docs/decisions/002-use-pi.md", ".git/config", "docs\\decisions\\002-use-pi.md", "src/cli.ts"])(
  "rejects a write to %s before any file mutation", async (path) => {
    const candidate = await fixture();
    const task = await PiDecisionTask.prepare(candidate.directory);
    const input = await task.read({ path: editedFile });
    await task.check();
    await expect(task.replace({ path, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
    expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(input.content);
    await expect(task.read({ path: editedFile })).rejects.toThrow("closed");
  });

it("requires an initial check and rejects stale hashes without overwriting source", async () => {
  const candidate = await fixture();
  const task = await PiDecisionTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await expect(task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(input.content);
  // Fresh explicit task authority uses a fresh candidate; a saved plan cannot reset a budget.
  const second = await fixture();
  const next = await PiDecisionTask.prepare(second.directory);
  const content = await next.read({ path: editedFile });
  await next.check();
  await expect(next.replace({ path: editedFile, expectedSha256: "0".repeat(64), content: correction(content.content) })).rejects.toThrow("denied");
  expect(await readFile(join(second.checkout, editedFile), "utf8")).toBe(content.content);
});

it("detects out-of-scope changes and refuses to read unlisted files", async () => {
  const candidate = await fixture();
  const task = await PiDecisionTask.prepare(candidate.directory);
  await writeFile(join(candidate.checkout, "src/cli.ts"), "external change");
  await expect(task.read({ path: editedFile })).rejects.toThrow("denied");
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("scope changed");
  expect(await readFile(join(candidate.checkout, "src/cli.ts"), "utf8")).toBe("external change");
});

it("detects external modification of the writable file and preserves it", async () => {
  const candidate = await fixture();
  const task = await PiDecisionTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await writeFile(join(candidate.checkout, editedFile), "external");
  await expect(task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe("external");
});

it("does not pass a corrected status if unrelated document text changes, and bounds correction attempts", async () => {
  const candidate = await fixture();
  const task = await PiDecisionTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) + "\nUnrequested text\n" });
  expect((await task.check()).status).toBe("check_failed");
  const current = await task.read({ path: editedFile });
  await task.replace({ path: editedFile, expectedSha256: current.sha256, content: correction(input.content) });
  expect((await task.check()).status).toBe("passed");
  await expect(task.check()).rejects.toThrow("denied");
});

it("rejects additional payload fields and refuses forged persisted scope", async () => {
  const candidate = await fixture();
  const task = await PiDecisionTask.prepare(candidate.directory);
  await expect(task.read({ path: editedFile, command: "SYNTHETIC_PRIVATE" })).rejects.toThrow("denied");
  const path = join(candidate.directory, "task.json");
  const original = await readFile(path, "utf8");
  await expect(PiDecisionTask.prepare(candidate.directory)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), writeFiles: ["src/cli.ts"] }));
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("invalid");
});

it("prepares and checks through the compiled CLI without authorizing editing or invoking a model", async () => {
  const candidate = await fixture();
  const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const prepare = spawnSync("bun", ["--no-env-file", entry, "task", "prepare", candidate.directory], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(prepare.status).toBe(0);
  expect(JSON.parse(prepare.stdout)).toMatchObject({ task: "pi-decision-status", writeFiles: [editedFile] });
  const check = spawnSync("bun", ["--no-env-file", entry, "task", "check", candidate.directory], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(check.status).toBe(1);
  expect(JSON.parse(check.stdout)).toMatchObject({ status: "check_failed", provenance: "recorded_untrusted" });
});
