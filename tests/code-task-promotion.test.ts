import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/code-task-check.js", () => ({
  CODE_TASK_FILE: "src/integrations/pi-task.ts",
  CODE_TASK_OBJECTIVE: "Synthetic promotion fixture",
  codeTaskVerifierSha256: () => "0".repeat(64),
  checkCodeTask: (content: string) => ({
    status: content === "corrected\n" ? "passed" : "check_failed",
    diagnostics: content === "corrected\n" ? [] : ["correction required"],
    verifierSha256: "0".repeat(64),
  }),
}));

import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask } from "../src/candidate-task.js";
import { promoteTask } from "../src/task-promotion.js";
import { decideTask, reviewTask } from "../src/task-review.js";

const roots: string[] = [];
const codeFile = "src/integrations/pi-task.ts";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (result.status !== 0) throw new Error("Fixture Git failed");
}

it("promotes an accepted code task without changing refs, index or unrelated source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-code-promotion-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(dirname(join(source, codeFile)), { recursive: true });
  await writeFile(join(source, codeFile), "defective\n");
  await writeFile(join(source, "README.md"), "baseline\n");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "."]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--no-gpg-sign", "--quiet", "-m", "Task baseline"]);
  const candidate = await createCandidateCheckout(source, join(root, "candidates"));
  const task = await CandidateTask.prepare(candidate.directory, "pi-result-consistency");
  const input = await task.read({ path: codeFile });
  expect((await task.check()).status).toBe("check_failed");
  await task.replace({ path: codeFile, expectedSha256: input.sha256, content: "corrected\n" });
  expect((await task.check()).status).toBe("passed");
  task.close();
  const review = await reviewTask(candidate.directory);
  await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  const index = await readFile(join(source, ".git/index"));
  const head = await readFile(join(source, ".git/HEAD"));
  await writeFile(join(source, "README.md"), "unrelated edit\n");

  const result = await promoteTask(candidate.directory, source, review.reviewSha256);

  expect(result).toMatchObject({ status: "applied", files: [{ path: codeFile }] });
  expect(await readFile(join(source, codeFile), "utf8")).toBe("corrected\n");
  expect(await readFile(join(source, "README.md"), "utf8")).toBe("unrelated edit\n");
  expect(await readFile(join(source, ".git/index"))).toEqual(index);
  expect(await readFile(join(source, ".git/HEAD"))).toEqual(head);
  expect(await readFile(join(candidate.directory, "promotion.jsonl"), "utf8")).toContain(`"path":"${codeFile}"`);
}, 30_000);
