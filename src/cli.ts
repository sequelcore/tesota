const help = `Tesota (provisional)
Usage: tesota [--help | -h | help]

M1 development scaffold. Agent execution is not implemented.
`;

const args = process.argv.slice(2);
if (
  args.length === 0 ||
  (args.length === 1 && ["--help", "-h", "help"].includes(args[0] ?? ""))
) {
  process.stdout.write(help);
} else {
  process.stderr.write("Invalid arguments. Use tesota --help.\n");
  process.exitCode = 2;
}
