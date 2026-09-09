import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { interpretOxlint, type OxlintResult } from "./oxlint-result.js";

/** Trusted application configuration, never CLI-supplied executable or argv. */
export interface OxlintCheck {
  readonly executable: string;
  readonly entry: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly terminationWaitMs: number;
}

export function configuredOxlint(cwd: string, executable: string): OxlintCheck {
  return {
    executable, cwd: resolve(cwd),
    entry: fileURLToPath(new URL("../../node_modules/oxlint/bin/oxlint", import.meta.url)),
    timeoutMs: 10_000, maxOutputBytes: 256 * 1024, terminationWaitMs: 2_000,
  };
}

const profile = JSON.stringify({
  plugins: [], categories: { correctness: "off" },
  rules: { "no-debugger": "error", "no-unused-vars": "error" },
});

export async function runOxlint(check: OxlintCheck, input: string): Promise<OxlintResult> {
  const file = resolve(check.cwd, input);
  let directory: string | undefined;
  let result: OxlintResult;
  try {
    if (![check.executable, check.entry, check.cwd].every(isAbsolute) ||
        ![check.timeoutMs, check.maxOutputBytes, check.terminationWaitMs]
          .every((value) => Number.isSafeInteger(value) && value > 0)) {
      return { status: "execution_failed", reason: "invalid_configuration", process: "not_started" };
    }
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024 || ![".ts", ".js"].includes(extname(file))) {
      return { status: "execution_failed", reason: "unsupported_input", process: "not_started" };
    }
    // Inline suppressions could silently weaken this fixed profile.
    if (/(?:oxlint|eslint)-disable/u.test(await readFile(file, "utf8"))) {
      return { status: "execution_failed", reason: "inline_suppression", process: "not_started" };
    }
    const metadata: unknown = JSON.parse(await readFile(join(dirname(check.entry), "../package.json"), "utf8"));
    if (typeof metadata !== "object" || metadata === null ||
        !("version" in metadata) || metadata.version !== "1.82.0") {
      return { status: "execution_failed", reason: "unsupported_oxlint_version", process: "not_started" };
    }
    directory = await mkdtemp(join(tmpdir(), "tesota-oxlint-"));
    const config = join(directory, "profile.json");
    await writeFile(config, profile, "utf8");
    result = await execute(check, directory, [
      "--no-env-file", check.entry, "--config", config, "--disable-nested-config",
      "--no-ignore", "--threads", "1", "--format", "json", "--deny-warnings", "--", file,
    ], file);
  } catch {
    result = { status: "execution_failed", reason: "input_or_installation_unavailable", process: "not_started" };
  }
  if (directory !== undefined) {
    if (result.status === "execution_failed" && result.process === "unconfirmed") {
      return { ...result, retainedDirectory: directory };
    }
    try { await rm(directory, { recursive: true }); } catch {
      return { status: "execution_failed", reason: "temporary_cleanup_failed", process: result.process,
        retainedDirectory: directory };
    }
  }
  return result;
}

function execute(check: OxlintCheck, cwd: string, args: readonly string[], file: string): Promise<OxlintResult> {
  return new Promise((settle) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const child = spawn(check.executable, [...args], {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let done = false;
    let exited = false;
    let failure: string | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: OxlintResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (deadline !== undefined) clearTimeout(deadline);
      settle(result);
    };
    const stop = (reason: string): void => {
      if (failure !== undefined || done) return;
      failure = reason;
      // The closed native-rule profile has one process, no external plugins or
      // executable source. Do not generalize this to arbitrary process trees.
      // A kill request is not settlement: wait for exit/close or report unknown.
      deadline = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({ status: "execution_failed", reason: failure ?? reason,
          process: exited ? "exited" : "unconfirmed", ...(child.pid === undefined ? {} : { pid: child.pid }) });
      }, check.terminationWaitMs);
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Failure to request termination does not settle the process either.
        try { child.kill("SIGKILL"); } catch { /* deadline retains unknown state */ }
      }
    };
    const timeout = setTimeout(() => stop("timeout"), check.timeoutMs);
    const capture = (chunk: Buffer, destination: Buffer[]): void => {
      if (done || failure !== undefined) return;
      bytes += chunk.length;
      if (bytes > check.maxOutputBytes) { stop("output_limit"); return; }
      destination.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, output));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, errors));
    child.once("exit", () => { exited = true; });
    child.once("error", () => {
      if (child.pid === undefined) finish({ status: "execution_failed", reason: "spawn_failed", process: "not_started" });
      else stop("process_error");
    });
    child.once("close", (code, signal) => {
      if (failure !== undefined || signal !== null) {
        finish({ status: "execution_failed", reason: failure ?? "signal", process: "exited" });
      } else {
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          finish(interpretOxlint(decoder.decode(Buffer.concat(output)), decoder.decode(Buffer.concat(errors)), code, file));
        } catch {
          finish({ status: "execution_failed", reason: "invalid_verifier_result", process: "exited" });
        }
      }
    });
  });
}
