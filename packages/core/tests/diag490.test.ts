import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../../src/process.ts";
import { shellHost } from "../src/shell/surface.ts";

/** DIAGNOSTIC for #490, on a draft pull request never merged: the whole tree a check makes through Git's bash on Windows. */
interface Row { pid: number; parent: number; name: string; command: string }
function table(): Map<number, Row> {
  const listed = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)\" }"], { encoding: "utf8" }).stdout;
  return new Map(listed.trim().split(/\r?\n/u).map((line) => {
    const [pid, parent, name, ...command] = line.trim().split("|");
    return [Number(pid), { pid: Number(pid), parent: Number(parent), name: name ?? "", command: command.join("|").slice(0, 160) }];
  }));
}
function descendants(rows: Map<number, Row>, root: number, depth = 0): string[] {
  return [...rows.values()].filter((row) => row.parent === root && row.pid !== root)
    .flatMap((row) => [`${"  ".repeat(depth)}${row.pid} ${row.name} [${row.command}]`, ...descendants(rows, row.pid, depth + 1)]);
}
function chain(rows: Map<number, Row>, pid: number): string {
  const links: string[] = [];
  for (let at = pid, steps = 0; steps < 12; steps++) {
    const found = rows.get(at);
    links.push(found === undefined ? `${at} (gone)` : `${at} ${found.name}`);
    if (found === undefined || found.parent <= 0 || at === process.pid) break;
    at = found.parent;
  }
  return links.join(" <- ");
}

test.skipIf(process.platform !== "win32")("DIAGNOSTIC #490: the tree of a check run through Git's bash, before and after a stop", async () => {
  const shell = shellHost().shellConfig();
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-diag490-"));
  const ready = join(cwd, "ready.txt");
  writeFileSync(join(cwd, "long.cjs"), "const child = require(\"node:child_process\").spawn(process.execPath, " +
    "[\"-e\", \"setTimeout(() => {}, 60000)\"], { stdio: \"ignore\" });\n" +
    `require("node:fs").writeFileSync(${JSON.stringify(ready)}, process.pid + " " + child.pid);\nsetTimeout(() => {}, 60000);\n`);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "diag490", scripts: { test: "node long.cjs" } }));
  const controller = new AbortController();
  const began = performance.now();
  const running = runProcess(shell.shell, [...shell.args, "npm run test"], cwd, controller.signal, undefined);
  let ended: number | undefined;
  void running.then(() => { ended = performance.now(); });
  while (!existsSync(ready) || !readFileSync(ready, "utf8").includes(" ")) await new Promise((resolve) => setTimeout(resolve, 50));
  const [node] = readFileSync(ready, "utf8").split(" ").map(Number);
  const before = table();
  console.log(`DIAG shell: ${shell.shell} ${shell.args.join(" ")}; test process ${process.pid}; ready after ${Math.round(performance.now() - began)} ms; runProcess ended before the stop: ${ended !== undefined}`);
  console.log(`DIAG tree under the test process before the stop:\n${descendants(before, process.pid).join("\n")}`);
  console.log(`DIAG chain from the check's node before the stop: ${chain(before, node ?? 0)}`);
  controller.abort();
  const run = await running;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = table();
  console.log(`DIAG runProcess reported ${run.ended} (code ${run.exitCode})`);
  console.log(`DIAG tree under the test process after the stop:\n${descendants(after, process.pid).join("\n")}`);
  console.log(`DIAG chain from the check's node after the stop: ${chain(after, node ?? 0)}`);
  for (const pid of readFileSync(ready, "utf8").split(" ").map(Number)) spawnSync("taskkill.exe", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  expect(run.ended).toBe("cancelled");
}, 120_000);
