import manifest from "../package.json" with { type: "json" };

/**
 * The engine's command. It answers `--version` before loading anything
 * else, so startup stays within its budget as the engine grows. The loop
 * and sessions load only for `--measure-loop` and `--measure-resume`, which
 * the budget check runs; the commands for operators arrive with later
 * slices (#432).
 */
const [command] = process.argv.slice(2);
if (command === "--version") console.log(manifest.version);
else if (command === "--measure-loop" || command === "--measure-resume") {
  import("./measure.ts").then((measure) => command === "--measure-loop" ? measure.measureLoop() : measure.measureResume())
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
else {
  console.error("@tesota/core has no commands yet besides --version and its measurements.");
  process.exitCode = 2;
}
