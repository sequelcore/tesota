import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateDiff, createCandidateCheckout } from "./candidate-checkout.js";
import { CandidateTask, checkCandidateTask, type CandidateTaskCheck } from "./candidate-task.js";
import { DEFAULT_CANDIDATE_TASK_ID, parseCandidateTaskId } from "./candidate-task-definition.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { PI_TASK_LIMITS, piTaskPasses, runPiTask, type PiTaskResult } from "./integrations/pi-task.js";

/** A new invocation creates its own candidate and authority; stored attempts cannot be resumed. */
export async function runTaskCommand(requestedTaskId: string = DEFAULT_CANDIDATE_TASK_ID): Promise<number> {
  const taskId = parseCandidateTaskId(requestedTaskId);
  if (taskId === null) {
    process.stderr.write("Unknown task id.\n");
    return 2;
  }
  if (process.platform !== "win32") {
    process.stderr.write("Live repository tasks are currently supported on Windows.\n");
    return 2;
  }
  const cancellation = new AbortController();
  const interrupt = (): void => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const watchdog = setTimeout(() => {
    cancellation.abort();
    process.stderr.write("Task settlement unconfirmed; inspect the retained attempt.\n");
    process.exit(1);
  }, 360_000);
  try {
    const candidate = await createCandidateCheckout(process.cwd());
    process.stdout.write("Task candidate: " + candidate.directory + "\n");
    const record = await open(join(candidate.directory, "attempt.jsonl"), "wx", 0o600);
    let task: CandidateTask | undefined;
    let session: PiTaskResult | null = null;
    let current: CandidateTaskCheck | null = null;
    let reviewSaved = false;
    let passed = false;
    try {
      const executor: Record<string, string> = {};
      for (const path of ["task-run.js", "candidate-checkout.js", "candidate-task.js", "candidate-task-definition.js",
        "code-task-check.js", "formal-task-check.js", "candidate-source-task-check.js",
        "verification/invocation-admission.js",
        "integrations/pi-task.js", "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock"]) {
        executor[path] = createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex");
      }
      await record.writeFile(JSON.stringify({ format: "tesota-task-attempt", version: 1, state: "started",
        timestamp: new Date().toISOString(), baseline: candidate.baseline, sourceDirty: candidate.sourceDirty,
        executor, model: LIVE_CODEX_MODEL_ID, limits: PI_TASK_LIMITS, taskAcceptance: "not_evaluated" }) + "\n");
      await record.sync();
      if (cancellation.signal.aborted) throw new Error("Task interrupted");
      task = await CandidateTask.prepare(candidate.directory, taskId);
      const models = await storedCodexModels(new CodexCredentials(), cancellation.signal);
      const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model?.api !== "openai-codex-responses") throw new Error("Task model unavailable");
      session = await runPiTask(task, model, (requested, context, options) =>
        models.streamSimple(requested, context, options), cancellation.signal);
    } catch {
      process.stderr.write("Task attempt did not complete successfully; retained state is available for inspection.\n");
    } finally {
      task?.close();
      try {
        await writeFile(join(candidate.directory, "candidate.diff"), await candidateDiff(candidate.directory), { flag: "wx", mode: 0o600 });
        reviewSaved = true;
        current = await checkCandidateTask(candidate.directory);
        passed = session !== null && !cancellation.signal.aborted && piTaskPasses(session, current);
      } catch {
        passed = false;
      }
      try {
        await record.writeFile(JSON.stringify({ state: "finished", timestamp: new Date().toISOString(),
          outcome: passed && reviewSaved ? "passed" : "failed", session, current, reviewSaved,
          taskAcceptance: "not_evaluated" }) + "\n");
        await record.sync();
      } finally { await record.close(); }
    }
    process.stdout.write(passed && reviewSaved ? "Task checks passed; diff retained for human review.\n" : "Task unaccepted; inspect the retained checks and diff.\n");
    return passed && reviewSaved ? 0 : 1;
  } catch {
    process.stderr.write("Task preparation or evidence persistence failed. No promotion occurred.\n");
    return 1;
  } finally {
    cancellation.abort();
    clearTimeout(watchdog);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
