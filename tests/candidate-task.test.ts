import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall,
  type Context, type FauxResponseStep } from "@earendil-works/pi-ai";
import { PI_TASK_LIMITS, piTaskPasses, runPiTask } from "../src/integrations/pi-task.js";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask, PI_DECISION_TASK_STATUS } from "../src/candidate-task.js";
import { reviewTask, decideTask } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";

const editedFile = "docs/decisions/002-use-pi.md";
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
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
  for (const path of [editedFile, "docs/roadmap.md", "experiments/codex/history.md", "src/cli.ts", "src/integrations/pi-task.ts", "src/verification/invocation-admission.ts"]) {
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

it("prepares code scope independently of the documentation task and denies other files", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory, "pi-result-consistency");
  expect(task.describe()).toMatchObject({ task: "pi-result-consistency", writeFiles: ["src/integrations/pi-task.ts"] });
  expect((await task.read({ path: "src/integrations/pi-task.ts" })).content).toContain("piTaskPasses");
  await expect(task.read({ path: editedFile })).rejects.toThrow("denied");
});

it("returns LemmaScript diagnostics and accepts the corrected formal task", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory, "formal-invocation-admission");
  const seeded = await task.read({ path: "src/verification/invocation-admission.ts" });
  expect((await task.check()).status).toBe("check_failed");
  const corrected = await readFile(new URL("../src/verification/invocation-admission.ts", import.meta.url), "utf8");
  await task.replace({ path: "src/verification/invocation-admission.ts", expectedSha256: seeded.sha256, content: corrected });
  expect((await task.check()).status).toBe("passed");
  task.close();
}, 30_000);

async function acceptedCandidate() {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) });
  task.close();
  const review = await reviewTask(candidate.directory);
  await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  return { ...candidate, review, original: input.content };
}

it("promotes through the CLI while preserving unrelated source edits, index and refs", async () => {
  const candidate = await acceptedCandidate();
  await writeFile(join(candidate.source, "src/cli.ts"), "unrelated edit");
  const index = await readFile(join(candidate.source, ".git/index"));
  const head = await readFile(join(candidate.source, ".git/HEAD"));
  const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = spawnSync("bun", ["--no-env-file", entry, "task", "promote", candidate.directory, candidate.review.reviewSha256], {
    cwd: candidate.source, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("applied");
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(correction(candidate.original));
  expect(await readFile(join(candidate.source, "src/cli.ts"), "utf8")).toBe("unrelated edit");
  expect(await readFile(join(candidate.source, ".git/index"))).toEqual(index);
  expect(await readFile(join(candidate.source, ".git/HEAD"))).toEqual(head);
  expect(await readFile(join(candidate.directory, "promotion.jsonl"), "utf8")).toContain('"state":"applied"');
  await expect(promoteTask(candidate.directory, candidate.source, candidate.review.reviewSha256)).rejects.toThrow();
}, 60_000);

it.each(["working", "index", "revision", "candidate", "wrong_source", "journal"] as const)(
  "refuses promotion after %s changes without overwriting source", async (change) => {
    const candidate = await acceptedCandidate();
    const target = join(candidate.source, editedFile);
    if (change === "working") await writeFile(target, "newer work");
    if (change === "index" || change === "revision") {
      await writeFile(target, "staged work");
      git(candidate.source, ["add", editedFile]);
      if (change === "revision") git(candidate.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "--no-gpg-sign", "--quiet", "-m", "Newer source"]);
      await writeFile(target, candidate.original);
    }
    if (change === "candidate") await writeFile(join(candidate.checkout, editedFile), "changed candidate");
    if (change === "journal") await writeFile(join(candidate.directory, "promotion.jsonl"), '{"state":"started"}\n');
    const before = await readFile(target);
    await expect(promoteTask(candidate.directory, change === "wrong_source" ? candidate.checkout : candidate.source,
      candidate.review.reviewSha256)).rejects.toThrow();
    expect(await readFile(target)).toEqual(before);
  }, 60_000);

it("does not promote a passing candidate without explicit acceptance", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory)).close();
  const original = await readFile(join(candidate.source, editedFile), "utf8");
  await writeFile(join(candidate.checkout, editedFile), correction(original));
  const review = await reviewTask(candidate.directory);
  await expect(promoteTask(candidate.directory, candidate.source, review.reviewSha256)).rejects.toThrow("accepted");
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(original);
}, 30_000);

it("records acceptance for reviewed bytes separately from check evidence and refuses to overwrite it", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) });
  task.close();
  const review = await reviewTask(candidate.directory);
  expect(review).toMatchObject({ operatorDecision: null, historicalAttempt: "not_evaluated" });
  expect(review.diff).toContain("+Coding Agent host task and an immutable four-lens Gentle review have also");
  const accepted = await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  expect(accepted.operatorDecision).toMatchObject({ provenance: "recorded_untrusted", applicability: "current",
    record: { decision: "accept", authority: "local_operator_assertion" } });
  expect(accepted.check.taskAcceptance).toBe("not_evaluated");
  await expect(decideTask(candidate.directory, { decision: "reject", reviewSha256: review.reviewSha256 })).rejects.toThrow("already exists");
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(input.content);
  await writeFile(join(candidate.checkout, editedFile), input.content);
  const stale = await reviewTask(candidate.directory);
  expect(stale.operatorDecision?.applicability).toBe("stale");
  expect(stale.check.status).toBe("check_failed");
}, 30_000);

it("rejects a stale review and refuses acceptance based on forged saved success or diff claims", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const original = await task.read({ path: editedFile });
  task.close();
  await writeFile(join(candidate.directory, "attempt.jsonl"), '{"outcome":"passed"}\n');
  await writeFile(join(candidate.directory, "candidate.diff"), "Forged successful diff");
  const before = await reviewTask(candidate.directory);
  expect(before.diff).toBe("");
  await expect(decideTask(candidate.directory, { decision: "accept", reviewSha256: before.reviewSha256 })).rejects.toThrow("passing current check");
  await writeFile(join(candidate.checkout, editedFile), correction(original.content));
  await expect(decideTask(candidate.directory, { decision: "accept", reviewSha256: before.reviewSha256 })).rejects.toThrow("stale");
  await expect(readFile(join(candidate.directory, "decision.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("allows rejecting a failed candidate through the compiled CLI without granting acceptance", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory)).close();
  const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const review = spawnSync("bun", ["--no-env-file", entry, "task", "review", candidate.directory], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  expect(review.status).toBe(0);
  const fingerprint: unknown = JSON.parse(review.stdout).reviewSha256;
  if (typeof fingerprint !== "string") throw new Error("Missing review fingerprint");
  const decision = spawnSync("bun", ["--no-env-file", entry, "task", "decide", candidate.directory, "reject", fingerprint], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  expect(decision.status).toBe(0);
  expect(JSON.parse(decision.stdout)).toMatchObject({
    check: { status: "check_failed", taskAcceptance: "not_evaluated" },
    operatorDecision: { record: { decision: "reject" }, applicability: "current" },
  });
}, 30_000);

it("rejects malformed decisions and scope changes instead of presenting a current acceptance", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory)).close();
  await expect(decideTask(candidate.directory, { decision: "accept", reviewSha256: "0".repeat(64), authority: "model" })).rejects.toThrow();
  await writeFile(join(candidate.directory, "decision.json"), '{"decision":"accept","authority":"human"}');
  await expect(reviewTask(candidate.directory)).rejects.toThrow();
  await writeFile(join(candidate.directory, "decision.json"), " ".repeat(4097));
  await expect(reviewTask(candidate.directory)).rejects.toThrow("unavailable");
  await writeFile(join(candidate.checkout, "src/cli.ts"), "out of scope");
  await expect(reviewTask(candidate.directory)).rejects.toThrow("scope");
}, 30_000);

function fakeModel(steps: FauxResponseStep[]) {
  const fake = fauxProvider({ models: [{ id: "task-test", name: "Task test" }], tokensPerSecond: 1_000_000 });
  fake.setResponses(steps);
  return { model: fake.getModel(), stream: vi.fn(fake.provider.streamSimple) };
}

function modelCorrection(context: Context) {
  const read = context.messages.find((message) => message.role === "toolResult" && message.toolName === "tesota_read");
  if (read?.role !== "toolResult") throw new Error("Missing tool result");
  const text = read?.content.find((block) => block.type === "text");
  if (text?.type !== "text") throw new Error("Missing model context");
  const input: unknown = JSON.parse(text.text);
  if (typeof input !== "object" || input === null || !("content" in input) || typeof input.content !== "string" ||
      !("sha256" in input) || typeof input.sha256 !== "string") throw new Error("Invalid model context");
  return fauxAssistantMessage(fauxToolCall("tesota_replace", {
    path: editedFile, expectedSha256: input.sha256, content: correction(input.content),
  }));
}

it("executes a Pi repository task and distinguishes model completion from applicable checks", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: editedFile })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    modelCorrection,
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage("Done."),
  ]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  const current = await checkCandidateTask(candidate.directory);
  expect(result).toMatchObject({ status: "completed", modelInvocations: 5, toolCalls: 4, edits: 1,
    checksSuppliedToModel: 2, finalCheckSuppliedToModel: true, denied: false, deadlineExpired: false });
  expect(piTaskPasses(result, current)).toBe(true);
  expect(piTaskPasses({ ...result, finalCheckSuppliedToModel: false }, current)).toBe(false);
  expect(piTaskPasses(result, { ...current, sourceSha256: "0".repeat(64) })).toBe(false);
  await expect(task.read({ path: editedFile })).rejects.toThrow("closed");
}, 30_000);

it.each([
  { name: "tesota_replace", args: { path: "../outside", expectedSha256: "0".repeat(64), content: "SYNTHETIC_PRIVATE" } },
  { name: "tesota_check", args: { command: "SYNTHETIC_PRIVATE" } },
  { name: "unknown", args: {} },
])("denies malformed or unknown model tools and closes further authority: $name", async ({ name, args }) => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel([fauxAssistantMessage(fauxToolCall(name, args)), fauxAssistantMessage("Done.")]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", edits: 0, checks: [], denied: true });
  expect(fake.stream).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
  expect(await readFile(join(candidate.checkout, editedFile))).toEqual(await readFile(join(candidate.source, editedFile)));
});

it("does not pass a model's unsupported completion claim", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel([fauxAssistantMessage("All checks passed. Accepted.")]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(piTaskPasses(result, await checkCandidateTask(candidate.directory))).toBe(false);
  expect(result.taskAcceptance).toBe("not_evaluated");
});

it("bounds model continuations independently of the permitted read budget", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel(Array.from({ length: 9 }, () => fauxAssistantMessage(fauxToolCall("tesota_read", { path: editedFile }))));
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", denied: true, modelInvocations: PI_TASK_LIMITS.modelInvocations });
  expect(fake.stream).toHaveBeenCalledTimes(PI_TASK_LIMITS.modelInvocations);
});

it.each(["deadline", "interrupt"] as const)("closes authority when a stream will not settle after %s", async (reason) => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const model = fakeModel([]).model;
  const cancellation = new AbortController();
  const stream = createAssistantMessageEventStream();
  vi.useFakeTimers();
  const running = runPiTask(task, model, () => stream, cancellation.signal);
  if (reason === "interrupt") {
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
  }
  await vi.advanceTimersByTimeAsync(reason === "deadline" ? PI_TASK_LIMITS.sessionMs + PI_TASK_LIMITS.settlementMs : PI_TASK_LIMITS.settlementMs);
  const result = await running;
  expect(result).toMatchObject({ status: "unsettled", deadlineExpired: reason === "deadline" });
  await expect(task.read({ path: editedFile })).rejects.toThrow("closed");
  const snapshot = JSON.stringify(result);
  const message = fauxAssistantMessage("Late completion");
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.stringify(result)).toBe(snapshot);
});

it("permits the exact documentation correction, binds its checks to bytes and preserves the source", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
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
    const task = await CandidateTask.prepare(candidate.directory);
    const input = await task.read({ path: editedFile });
    await task.check();
    await expect(task.replace({ path, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
    expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(input.content);
    await expect(task.read({ path: editedFile })).rejects.toThrow("closed");
  });

it("requires an initial check and rejects stale hashes without overwriting source", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await expect(task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(input.content);
  // Fresh explicit task authority uses a fresh candidate; a saved plan cannot reset a budget.
  const second = await fixture();
  const next = await CandidateTask.prepare(second.directory);
  const content = await next.read({ path: editedFile });
  await next.check();
  await expect(next.replace({ path: editedFile, expectedSha256: "0".repeat(64), content: correction(content.content) })).rejects.toThrow("denied");
  expect(await readFile(join(second.checkout, editedFile), "utf8")).toBe(content.content);
});

it("detects out-of-scope changes and refuses to read unlisted files", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  await writeFile(join(candidate.checkout, "src/cli.ts"), "external change");
  await expect(task.read({ path: editedFile })).rejects.toThrow("denied");
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("scope changed");
  expect(await readFile(join(candidate.checkout, "src/cli.ts"), "utf8")).toBe("external change");
});

it("detects external modification of the writable file and preserves it", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await writeFile(join(candidate.checkout, editedFile), "external");
  await expect(task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe("external");
});

it("does not pass a corrected status if unrelated document text changes, and bounds correction attempts", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) + "\nUnrequested text\n" });
  expect((await task.check()).status).toBe("check_failed");
  const current = await task.read({ path: editedFile });
  await task.replace({ path: editedFile, expectedSha256: current.sha256, content: correction(input.content) });
  expect((await task.check()).status).toBe("passed");
  await expect(task.check()).rejects.toThrow("denied");
}, 30_000);

it("rejects additional payload fields and refuses forged persisted scope", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  await expect(task.read({ path: editedFile, command: "SYNTHETIC_PRIVATE" })).rejects.toThrow("denied");
  const path = join(candidate.directory, "task.json");
  const original = await readFile(path, "utf8");
  await expect(CandidateTask.prepare(candidate.directory)).rejects.toThrow();
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
