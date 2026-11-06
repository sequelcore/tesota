// Temporary diagnostic for #799: compiles the Claude Code test fake as scripts/isolated.ts does, then times its first
// and second start, each limited to 20 s, in fresh folders. Prints one line per round and a summary.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] ?? 30);
const fake = join(import.meta.dir, "../../packages/core/tests/fixtures/claude-code/forbidden.ts");

async function start(program: string, args: string[]): Promise<{ ms: number; result: string }> {
  const begun = performance.now();
  const child = Bun.spawn([program, ...args], { stdout: "pipe", stderr: "pipe" });
  const limit = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
  const code = await child.exited;
  clearTimeout(limit);
  const out = (await new Response(child.stdout).text()).trim();
  return { ms: Math.round(performance.now() - begun), result: child.signalCode === "SIGKILL" ? "HUNG (killed at 20 s)" : `exit ${code} ${out}` };
}

const firsts: number[] = [];
let hung = 0;
for (let round = 1; round <= rounds; round++) {
  const folder = mkdtempSync(join(tmpdir(), "fake-start-"));
  const program = join(folder, "claude");
  const built = performance.now();
  const build = await Bun.build({ entrypoints: [fake], compile: { outfile: program } });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const buildMs = Math.round(performance.now() - built);
  const first = await start(program, ["auth", "status", "--json"]);
  const second = await start(program, ["auth", "status", "--json"]);
  firsts.push(first.ms);
  if (first.result.startsWith("HUNG") || second.result.startsWith("HUNG")) hung++;
  console.log(`round ${round}: build ${buildMs} ms; first ${first.ms} ms (${first.result}); second ${second.ms} ms (${second.result})`);
}
firsts.sort((a, b) => a - b);
console.log(`summary: ${rounds} rounds, ${hung} hung; first start median ${firsts[Math.floor(rounds / 2)]} ms, max ${firsts.at(-1)} ms`);
