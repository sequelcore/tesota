// The isolated runner compiles this instead of allowing a real Claude Code.
if (process.argv[2] === "--version") {
  console.log("0.0.0 (isolated Claude Code fake)");
  process.exit(0);
}
if (process.argv.slice(2).join(" ") === "auth status --json") {
  console.log('{"loggedIn":false}');
  process.exit(0);
}
console.error("Real Claude Code is forbidden in tests (#680)");
process.exit(1);
