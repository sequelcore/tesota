import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isKnownDiagnosticRule, isKnownProfileConfiguration, type InputBinding } from "./oxlint-input.js";
import { isIssuedOxlintResult } from "./oxlint.js";
import {
  type CompletedOxlintResult,
  type OxlintResult,
  type RecoveredOxlintEvidence,
} from "./oxlint-result.js";

const recordFormat = "tesota-verification-evidence" as const;
const recordVersion = 1 as const;
const maxRecordBytes = 512 * 1024;
const hash = /^[a-f0-9]{64}$/u;
const recovered = new WeakSet<object>();

export function isRecoveredOxlintEvidence(value: unknown): value is RecoveredOxlintEvidence {
  return typeof value === "object" && value !== null && recovered.has(value);
}

export type EvidenceRecovery =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: "malformed_or_truncated" | "unsupported_version" | "invalid_shape" | "too_large" }
  | { readonly status: "unavailable"; readonly reason: "read_failed" }
  | { readonly status: "recovered"; readonly evidence: RecoveredOxlintEvidence };

interface DurableRecord {
  readonly format: typeof recordFormat;
  readonly version: typeof recordVersion;
  readonly result: CompletedOxlintResult;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSource(value: unknown): boolean {
  if (!exact(value, ["file", "sha256"])) return false;
  return string(value["file"]) && isAbsolute(value["file"]) &&
    string(value["sha256"]) && hash.test(value["sha256"]);
}

function validLimits(value: unknown): boolean {
  if (!exact(value, ["timeoutMs", "maxOutputBytes", "terminationWaitMs"])) return false;
  return positiveInteger(value["timeoutMs"]) && positiveInteger(value["maxOutputBytes"]) &&
    positiveInteger(value["terminationWaitMs"]);
}

function validCheck(value: unknown): boolean {
  if (!exact(value, ["profile", "configuration", "arguments", "limits"])) return false;
  return isKnownProfileConfiguration(value["profile"], value["configuration"]) &&
    Array.isArray(value["arguments"]) && value["arguments"].every(string) && validLimits(value["limits"]);
}

function validVerifier(value: unknown): boolean {
  if (!exact(value, ["packageVersion", "executable", "executableSha256", "entry", "installationSha256"])) return false;
  const executableHash = value["executableSha256"];
  return string(value["packageVersion"]) && string(value["executable"]) && isAbsolute(value["executable"]) &&
    string(value["entry"]) && isAbsolute(value["entry"]) &&
    (executableHash === null || (string(executableHash) && hash.test(executableHash))) &&
    string(value["installationSha256"]) && hash.test(value["installationSha256"]);
}

function validBinding(value: unknown): value is InputBinding {
  if (!exact(value, ["source", "check", "verifier"])) return false;
  return validSource(value["source"]) && validCheck(value["check"]) && validVerifier(value["verifier"]);
}

function validDiagnostic(value: unknown, binding: InputBinding): boolean {
  if (!exact(value, ["rule", "message", "line", "column"])) return false;
  return isKnownDiagnosticRule(binding.check.profile, value["rule"]) && string(value["message"]) &&
    value["message"].length > 0 && positiveInteger(value["line"]) && positiveInteger(value["column"]);
}

function validResult(value: unknown): value is CompletedOxlintResult {
  if (!exact(value, ["status", "file", "profile", "diagnostics", "process", "binding"]) ||
      (value["status"] !== "passed" && value["status"] !== "check_failed") ||
      !string(value["file"]) || !isAbsolute(value["file"]) ||
      value["process"] !== "exited" || !Array.isArray(value["diagnostics"])) return false;
  const binding = value["binding"];
  if (!validBinding(binding)) return false;
  if (value["profile"] !== binding.check.profile) return false;
  if (value["status"] === "passed" && value["diagnostics"].length !== 0) return false;
  if (value["status"] === "check_failed" && value["diagnostics"].length === 0) return false;
  if (value["file"] !== binding.source.file) return false;
  return value["diagnostics"].every((diagnostic) => validDiagnostic(diagnostic, binding));
}

function validDurableRecord(value: unknown): value is DurableRecord {
  return exact(value, ["format", "version", "result"]) && value["format"] === recordFormat &&
    value["version"] === recordVersion && validResult(value["result"]);
}

function freezeResult(result: CompletedOxlintResult): CompletedOxlintResult {
  for (const diagnostic of result.diagnostics) Object.freeze(diagnostic);
  Object.freeze(result.diagnostics);
  Object.freeze(result.binding.source);
  Object.freeze(result.binding.check.arguments);
  Object.freeze(result.binding.check.limits);
  Object.freeze(result.binding.check);
  Object.freeze(result.binding.verifier);
  Object.freeze(result.binding);
  return Object.freeze(result);
}

async function boundedRead(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
    const bytes = Buffer.alloc(maxRecordBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export class DurableVerificationEvidenceStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async save(result: OxlintResult): Promise<void> {
    if (!isIssuedOxlintResult(result) || (result.status !== "passed" && result.status !== "check_failed")) {
      throw new Error("Only issued completed verification results can be persisted");
    }
    const durable: DurableRecord = {
      format: recordFormat,
      version: recordVersion,
      result,
    };
    const serialized = JSON.stringify(durable);
    if (Buffer.byteLength(serialized, "utf8") > maxRecordBytes) {
      throw new Error("Durable evidence exceeds 512 KiB");
    }
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, this.#path);
      committed = true;
    } finally {
      if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async load(): Promise<EvidenceRecovery> {
    let bytes: Buffer;
    try {
      bytes = await boundedRead(this.#path);
    } catch (error: unknown) {
      if (record(error) && error["code"] === "ENOENT") return { status: "missing" };
      return { status: "unavailable", reason: "read_failed" };
    }
    if (bytes.length > maxRecordBytes) return { status: "invalid", reason: "too_large" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      return { status: "invalid", reason: "malformed_or_truncated" };
    }
    if (record(parsed) && parsed["version"] !== recordVersion) {
      return { status: "invalid", reason: "unsupported_version" };
    }
    if (!validDurableRecord(parsed)) return { status: "invalid", reason: "invalid_shape" };
    const evidence: RecoveredOxlintEvidence = Object.freeze({
      kind: "recovered",
      structuralValidity: "valid",
      provenance: "recovered_untrusted",
      historical: freezeResult(parsed.result),
    });
    recovered.add(evidence);
    return { status: "recovered", evidence };
  }
}
