import manifest from "../package.json" with { type: "json" };

/**
 * The engine's command. It answers `--version` before loading anything
 * else, so startup stays within its budget as the engine grows. The loop
 * and sessions load only for `--measure-loop` and `--measure-resume`, which
 * the budget check runs. With no argument it opens the shell in the current
 * folder (#444).
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
else if (command === undefined) {
  import("./shell/app.ts").then(({ runApp }) => runApp({ cwd: process.cwd() })).then(() => { process.exit(0); }, (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
else {
  console.error(`Unknown argument ${command}. tesota-core opens the shell in this folder; --version prints its version.`);
  process.exitCode = 2;
}
