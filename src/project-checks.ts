import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseJson } from "./json.js";
import { host } from "./host.js";
import { confinedPath, normalizeReportPath } from "./test-report.js";
import { declaredCheckAllowed } from "./verification/project-rule.js";

export const checksFile = ".tesota/checks.json";
export const declarationLimits: Readonly<{ bytes: number; checks: number; commandBytes: number; seconds: number }> =
  { bytes: 64 * 1024, checks: 32, commandBytes: 8 * 1024, seconds: 900 };

/** A check declared by a project, before the command is placed in its folder. */
export interface DeclaredCheck {
  readonly command: string;
  readonly folder: string;
  readonly timeoutMs: number;
  readonly reports: readonly string[];
}

/** The checkout and exact declaration contents the operator approved, independent of the execution worktree. */
export interface CheckApproval {
  readonly root: string;
  readonly hash: string;
}

export type CheckDeclaration = { readonly status: "absent" }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "read"; readonly hash: string; readonly checks: readonly DeclaredCheck[] };

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural path parsing stays outside the prover's regex model; adversarial parser tests cover it. */
const portablePath = (path: string): boolean => normalizeReportPath(path) === path && !/:|[. ](?=\/|$)/u.test(path);

function declarationBytes(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(declarationLimits.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > declarationLimits.bytes) throw new Error(`the file exceeds ${declarationLimits.bytes} bytes`);
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/** Parse the one project-owned check file with fixed bounds; no command or network effect. */
export function readDeclaredChecks(root: string): CheckDeclaration {
  const file = join(root, checksFile);
  try {
    try {
      const info = lstatSync(file);
      if (!info.isFile()) throw new Error("the declaration must be a regular file");
      if (info.size > declarationLimits.bytes) throw new Error(`the file exceeds ${declarationLimits.bytes} bytes`);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { status: "absent" };
      throw error;
    }
    if (!confinedPath(root, checksFile)) throw new Error("the declaration path passes through a link");
    const bytes = declarationBytes(file);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = parseJson(text);
    if (!record(value) || Object.keys(value).some((key) => key !== "checks") || !Array.isArray(value["checks"]) ||
      value["checks"].length < 1 || value["checks"].length > declarationLimits.checks) {
      throw new Error(`expected checks with 1–${declarationLimits.checks} commands`);
    }
    const checks = (value["checks"] as unknown[]).map((item, index): DeclaredCheck => {
      if (!record(item) || Object.keys(item).some((key) => !["command", "folder", "timeoutSeconds", "report"].includes(key))) {
        throw new Error(`check ${index + 1} has unsupported fields`);
      }
      const { command, folder, timeoutSeconds = declarationLimits.seconds, report } = item;
      if (typeof command !== "string" || command.trim() === "" || command.includes("\0") || Buffer.byteLength(command) > declarationLimits.commandBytes) {
        throw new Error(`check ${index + 1} needs a command of at most ${declarationLimits.commandBytes} bytes`);
      }
      if (typeof folder !== "string" || (folder !== "" && !portablePath(folder))) {
        throw new Error(`check ${index + 1} needs a relative folder, or an empty string for the root`);
      }
      if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > declarationLimits.seconds) {
        throw new Error(`check ${index + 1} needs a timeout of 1–${declarationLimits.seconds} seconds`);
      }
      if (report !== undefined && (typeof report !== "string" || !portablePath(report) || !report.endsWith(".xml"))) {
        throw new Error(`check ${index + 1} needs a relative JUnit XML report path`);
      }
      return { command, folder, timeoutMs: timeoutSeconds * 1000, reports: typeof report === "string" ? [report] : [] };
    });
    return { status: "read", hash: createHash("sha256").update(bytes).digest("hex"), checks };
  } catch (error) {
    return { status: "invalid", reason: `${checksFile}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Recheck the approval origin immediately before every effect, including effects in a base worktree. */
export function checkApprovalProblem(approval: CheckApproval): string | undefined {
  const current = readDeclaredChecks(approval.root);
  const unchanged = current.status === "read" && current.hash === approval.hash;
  const trusted = host().checksTrusted(approval.root, approval.hash);
  return declaredCheckAllowed(unchanged, trusted) ? undefined
    : unchanged ? `${checksFile} is not trusted; trust its commands in the terminal first`
      : `${checksFile} changed or could not be read since these checks were selected`;
}

/** A declared execution folder is an existing directory without links below this execution root. */
export function checkFolderProblem(root: string, folder: string): string | undefined {
  try {
    if (!confinedPath(root, folder) || !statSync(join(root, folder)).isDirectory()) throw new Error("not a confined directory");
    return undefined;
  } catch { return `the declared folder ${folder || "."} is missing or passes through a link`; }
}
