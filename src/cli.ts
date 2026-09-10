import { configuredOxlint, runOxlint } from "./verification/oxlint.js";

const help = `Tesota
Usage: tesota [--help | -h | help]
       tesota verify <file.ts|file.js>
       tesota auth <login|status|logout>

Runs one fixed Oxlint check. Agent execution is not implemented.
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
} else if (args.length === 2 && args[0] === "verify" && args[1] !== undefined) {
  const result = await runOxlint(configuredOxlint(process.cwd(), process.execPath), args[1]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "passed" ? 0 : result.status === "check_failed" ? 1 : 2;
} else {
  process.stderr.write("Invalid arguments. Use tesota --help.\n");
  process.exitCode = 2;
}
