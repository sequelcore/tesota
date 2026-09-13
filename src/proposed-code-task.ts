import { createHash } from "node:crypto";
import { candidateTaskDefinition, type CandidateTaskDefinition,
  type CandidateTaskOracleResult } from "./candidate-task-definition.js";
import { CODE_TASK_FILE } from "./code-task-check.js";

export const CODE_PROPOSAL_TASK_ID = "pi-result-consistency";
export const CODE_PROPOSAL_TEST_FILE = "tests/candidate-task.test.ts";
const regressionPolicy = "The admitted existing regression test must change; candidate-authored tests supplement the immutable behavior oracle.";

function proposedCodeExpected(files: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return files;
}

function checkProposedCodeTask(files: Readonly<Record<string, string>>,
  initial: Readonly<Record<string, string>>): CandidateTaskOracleResult {
  const behavior = candidateTaskDefinition(CODE_PROPOSAL_TASK_ID).check(files, initial);
  if (behavior.status === "check_failed") return behavior;
  const changedTest = files[CODE_PROPOSAL_TEST_FILE] !== undefined &&
    initial[CODE_PROPOSAL_TEST_FILE] !== undefined && files[CODE_PROPOSAL_TEST_FILE] !== initial[CODE_PROPOSAL_TEST_FILE];
  if (changedTest) return behavior;
  return { ...behavior, status: "check_failed", diagnostics: [
    ...(behavior.diagnostics ?? []), "The admitted regression test must change",
  ] };
}

/** Application-owned executable definition selected after a matching model proposal. */
export function proposedCodeTaskDefinition(): CandidateTaskDefinition {
  const registered = candidateTaskDefinition(CODE_PROPOSAL_TASK_ID);
  const objective = registered.objective + " Add focused rejection cases to the admitted existing test file.";
  const oracle = registered.oracle + " The admitted test file must also change, but does not replace this behavior oracle.";
  const oracleSha256 = createHash("sha256").update(JSON.stringify({
    registered: registered.oracleSha256,
    regressionPolicy,
    expected: proposedCodeExpected.toString(),
    check: checkProposedCodeTask.toString(),
  })).digest("hex");
  return {
    ...registered,
    objective,
    oracle,
    oracleSha256,
    instructions: "Read the admitted source and test, run the fixed check before editing, then strengthen only piTaskPasses. " +
      "Add focused rejection cases to the admitted test file; they supplement the immutable behavior oracle. " +
      "Run the fixed check after each edit; do not add imports or declarations to the source file.",
    readFiles: [CODE_TASK_FILE, CODE_PROPOSAL_TEST_FILE],
    writeFiles: [CODE_TASK_FILE, CODE_PROPOSAL_TEST_FILE],
    expected: proposedCodeExpected,
    check: checkProposedCodeTask,
  };
}
