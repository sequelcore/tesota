import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const FORMAL_TASK_FILE = "src/verification/invocation-admission.ts";
export const FORMAL_TASK_OBJECTIVE =
  "Repair the invocation-admission function so its LemmaScript contract verifies. Preserve the contract and all surrounding bytes.";
export const FORMAL_TASK_MARKER = "export function canAdmitInvocation(";

export interface FormalTaskCheck {
  readonly status: "passed" | "check_failed";
  readonly diagnostics: readonly string[];
  readonly verifierSha256: string;
}

export function seedFormalTask(source: string): string {
  const defective = 'return used < limit ? "allow" : "deny";';
  const seeded = 'return "allow";';
  if (!source.includes(FORMAL_TASK_MARKER) || source.split(defective).length !== 2) {
    throw new Error("Formal task source is not seedable");
  }
  return source.replace(defective, seeded);
}

export function checkFormalTask(source: string): FormalTaskCheck {
  const executable = resolve(process.cwd(), "node_modules/.bin/lsc.exe");
  const verifierSha256 = existsSync(executable)
    ? createHash("sha256").update(readFileSync(executable)).digest("hex")
    : createHash("sha256").update("lsc-missing").digest("hex");
  if (!existsSync(executable)) return { status: "check_failed", diagnostics: ["LemmaScript executable is unavailable"], verifierSha256 };
  const root = mkdtempSync(join(tmpdir(), "tesota-formal-task-"));
  const sourcePath = join(root, "invocation-admission.ts");
  try {
    writeFileSync(sourcePath, source, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(executable, ["check", "--backend=dafny", sourcePath], {
      cwd: dirname(resolve(process.cwd(), "package.json")),
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const diagnostics = output.length === 0 ? ["LemmaScript produced no diagnostic"] : output.split(/\r?\n/u).slice(-32);
    return {
      status: result.status === 0 && result.error === undefined ? "passed" : "check_failed",
      diagnostics,
      verifierSha256,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
