import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateDiff, createCandidateCheckout } from "./candidate-checkout.js";
import { CandidateTask, checkCandidateTask } from "./candidate-task.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { runPiCodingAgent } from "./integrations/pi-coding-agent.js";

const prompt = "Use the edit tool now. Complete the bounded Tesota task by editing only docs/decisions/002-use-pi.md. Replace its existing Status paragraph with the required status text below, preserve every other byte, then stop. Do not only describe the change and do not run shell commands.";

/** Runs one real Pi Coding Agent session in an isolated candidate. */
export async function runCodingAgentTaskCommand(): Promise<number> {
  if (process.platform !== "win32") {
    process.stderr.write("Live repository tasks are currently supported on Windows.\n");
    return 2;
  }
  const candidate = await createCandidateCheckout(process.cwd());
  const attempt = await open(join(candidate.directory, "coding-agent-attempt.json"), "wx", 0o600);
  const task = await CandidateTask.prepare(candidate.directory);
  try {
    const description = task.describe();
    const result = await runPiCodingAgent({ cwd: candidate.checkout,
      prompt: `${prompt}\n\nTask objective: ${description.objective}\nPermitted read files: ${description.readFiles.join(", ")}\nPermitted write files: ${description.writeFiles.join(", ")}\nRequired status text:\n${description.requiredStatus}`,
      credentials: new CodexCredentials() });
    const current = await checkCandidateTask(candidate.directory);
    const diff = await candidateDiff(candidate.directory);
    await writeFile(join(candidate.directory, "candidate.diff"), diff, { flag: "wx", mode: 0o600 });
    const record = { format: "tesota-coding-agent-attempt", version: 1, baseline: candidate.baseline,
      status: result.status, messages: result.messages, toolNames: result.toolNames, error: result.error ?? null,
      current, taskAcceptance: "not_evaluated" as const, diffSha256: createHash("sha256").update(diff).digest("hex") };
    await attempt.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
    await attempt.sync();
    process.stdout.write(JSON.stringify(record, null, 2) + "\n");
    return result.status === "completed" && current.status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("Pi Coding Agent task failed; the isolated candidate remains available for inspection.\n");
    return 1;
  } finally {
    task.close();
    await attempt.close();
  }
}
