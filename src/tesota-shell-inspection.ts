import type { CompletedConversationTurn } from "./conversation-turn.js";
import type { TaskReview } from "./task-review.js";
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
    summary: "Proposal saved. Check eligibility and scope before approving execution.",
    detail: `Objective\n${record.proposal.objective}\n\nMay read\n${record.proposal.readFiles.join("\n")}` +
      `\n\nMay change\n${record.proposal.writeFiles.join("\n")}` +
      `\n\nCheck choices; eligibility and selection follow\n${record.proposal.checks.join("\n")}` +
      "\n\nApproval permits only this scope. It does not establish correctness.",
  };
}

export function inspectTaskReview(review: TaskReview): ShellInspection {
  const checks = [review.check.nodeTest, review.check.typecheck].filter((check) => check != null);
  const check = checks.length === 0 ? "Unavailable" :
    checks.map((selected) => `${selected.status}: ${selected.profile}`).join("; ");
  const local = checks.some((selected) => selected.binding.isolation?.kind === "host-local");
  const environment = local ? "Local process: no sandbox; host files, network and credentials were accessible. Child processes after main-process exit were not tracked." :
    "Protected Docker container.";
  return {
    title: "Candidate result",
    summary: `Changed ${review.changedFiles.join(", ")}. Check: ${check}. ${local ? "Ran locally without a sandbox. " : ""}Review the diff before deciding.`,
    detail: `Changed files\n${review.changedFiles.join("\n")}\n\nChecks\n` +
      `Candidate scope: ${review.check.status}\n${check}\n${environment}\n\nNot established\n` +
      "Whether the behavior meets your request.\n\nExact diff\n" + review.diff,
  };
}
