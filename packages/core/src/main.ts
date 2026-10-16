import manifest from "../package.json" with { type: "json" };

/**
 * The engine's command. It answers `--version` before loading anything
 * else, so startup stays within its budget as the engine grows; sessions
 * arrive with later slices (#432).
 */
const [command] = process.argv.slice(2);
if (command === "--version") console.log(manifest.version);
else {
  console.error("@tesota/core has no commands yet besides --version.");
  process.exitCode = 2;
}
