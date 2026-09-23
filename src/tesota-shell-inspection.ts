import type { CompletedConversationTurn } from "./conversation-turn.js";
import type { TaskReview } from "./task-review.js";
import { SOURCE_TEST_TASK_KIND } from "./task-contract.js";
import type { ShellInspection } from "./tesota-shell-terminal.js";

export function inspectConversationTurn(turn: CompletedConversationTurn): ShellInspection {
  if (turn.kind === "answer") return {
    title: "Answer",
    summary: "Answer ready. Sources and limits are in the result panel.",
    detail: `Sources\n${turn.answer.evidenceFiles.map((file) => `  ${file}`).join("\n") || "  None recorded"}` +
      `\n\nStill uncertain\n${turn.answer.uncertainties.map((item) => `  ${item}`).join("\n") || "  None listed"}` +
      `\n\nRepository baseline\n${turn.baseline}`,
  };
  if (turn.kind === "clarification") return {
    title: "Clarification",
    summary: "Tesota needs your answer before continuing.",
    detail: `${turn.clarification.question}\n\nWhy\n${turn.clarification.reason}`,
  };
  const record = turn.proposedTask.record;
  return {
    title: "Proposed work",
    summary: "Proposal ready. Review the scope before approving execution.",
    detail: `Objective\n${record.proposal.objective}\n\nMay read\n${record.proposal.readFiles.join("\n")}` +
      `\n\nMay change\n${record.proposal.writeFiles.join("\n")}` +
      `\n\nChecks\n${record.proposal.checks.join("\n")}` +
      "\n\nApproval permits only this scope. It does not establish correctness.",
  };
}

export function inspectTaskReview(review: TaskReview): ShellInspection {
  const selected = review.check.task === SOURCE_TEST_TASK_KIND ? review.check.nodeTest : review.check.typecheck;
  const check = selected === null || selected === undefined ? "Unavailable" :
    `${selected.status}: ${selected.profile}`;
  return {
    title: "Candidate result",
    summary: `Changed ${review.changedFiles.join(", ")}. Check: ${check}. Review the diff before deciding.`,
    detail: `Changed files\n${review.changedFiles.join("\n")}\n\nChecks\n` +
      `Scope integrity: ${review.check.status}\n${check}\n\nNot established\n` +
      "Whether the behavior meets your request.\n\nExact diff\n" + review.diff,
  };
}
