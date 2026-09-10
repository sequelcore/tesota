import { configuredOxlint, runOxlint } from "./verification/oxlint.js";

const help = `Tesota
Usage: tesota [--help | -h | help]
       tesota verify <file.ts|file.js>
       tesota auth <login|status|logout>
       tesota candidate create
       tesota candidate inspect <candidate-directory>
       tesota task prepare <candidate-directory>
       tesota task check <candidate-directory>
       tesota task run
       tesota task review <candidate-directory>
       tesota task decide <candidate-directory> <accept|reject> <review-sha256>

Runs bounded verification and one scoped documentation task.
`;

const args = process.argv.slice(2);
if (
  args.length === 0 ||
  (args.length === 1 && ["--help", "-h", "help"].includes(args[0] ?? ""))
) {
  process.stdout.write(help);
} else if (args.length === 2 && args[0] === "auth" && args[1] !== undefined) {
  const { runAuthCommand } = await import("./auth.js");
  process.exit(await runAuthCommand(args[1]));
} else if (args[0] === "task" && (args.length === 3 && args[1] === "review" && args[2] !== undefined ||
    args.length === 5 && args[1] === "decide" && args[2] !== undefined && args[3] !== undefined && args[4] !== undefined)) {
  const { reviewTask, decideTask } = await import("./task-review.js");
  try {
    const result = args[1] === "review" ? await reviewTask(args[2] ?? "") :
      await decideTask(args[2] ?? "", { decision: args[3], reviewSha256: args[4] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = args[1] === "decide" && result.operatorDecision?.applicability !== "current" ? 1 : 0;
  } catch {
    process.stderr.write("Review or decision unavailable: check scope, fingerprint and existing decision.\n");
    process.exitCode = 2;
  }
} else if (args.length === 2 && args[0] === "task" && args[1] === "run") {
  const { runTaskCommand } = await import("./task-run.js");
  process.exit(await runTaskCommand());
} else if (args.length === 3 && args[0] === "task" && (args[1] === "prepare" || args[1] === "check") && args[2] !== undefined) {
  const { PiDecisionTask, checkCandidateTask } = await import("./candidate-task.js");
  try {
    if (args[1] === "prepare") {
      const task = await PiDecisionTask.prepare(args[2]);
      try { process.stdout.write(JSON.stringify(task.describe(), null, 2) + "\n"); }
      finally { task.close(); }
    } else {
      const result = await checkCandidateTask(args[2]);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exitCode = result.status === "passed" ? 0 : 1;
    }
  } catch {
    process.stderr.write("Task unavailable, outside scope, or already prepared.\n");
    process.exitCode = 2;
  }
} else if (args[0] === "candidate" && (args.length === 2 && args[1] === "create" ||
    args.length === 3 && args[1] === "inspect" && args[2] !== undefined)) {
  const { createCandidateCheckout, inspectCandidateCheckout } = await import("./candidate-checkout.js");
  try {
    const result = args[1] === "create" ? await createCandidateCheckout(process.cwd()) : await inspectCandidateCheckout(args[2] ?? "");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(error instanceof Error && error.message.startsWith("Candidate ") ? `${error.message}\n` : "Candidate operation failed.\n");
    process.exitCode = 1;
  }
} else if (args.length === 2 && args[0] === "verify" && args[1] !== undefined) {
  const result = await runOxlint(configuredOxlint(process.cwd(), process.execPath), args[1]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "passed" ? 0 : result.status === "check_failed" ? 1 : 2;
} else {
  process.stderr.write("Invalid arguments. Use tesota --help.\n");
  process.exitCode = 2;
}
