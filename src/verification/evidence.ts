import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fixedConfiguration, type InputBinding } from "./oxlint-input.js";
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
const rules = new Set(["eslint(no-debugger)", "eslint(no-unused-vars)"]);
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

function validBinding(value: unknown): value is InputBinding {
  if (!exact(value, ["source", "check", "verifier"])) return false;
  const source = value["source"];
  const check = value["check"];
  const verifier = value["verifier"];
  if (!exact(source, ["file", "sha256"])) return false;
  const sourceFile = source["file"];
  const sourceHash = source["sha256"];
  if (!string(sourceFile) || !isAbsolute(sourceFile) || !string(sourceHash) || !hash.test(sourceHash)) return false;
  if (!exact(check, ["profile", "configuration", "arguments", "limits"]) ||
      check["profile"] !== "oxlint-basic/v1" || check["configuration"] !== fixedConfiguration ||
      !Array.isArray(check["arguments"]) || !check["arguments"].every(string)) return false;
  const limits = check["limits"];
  if (!exact(limits, ["timeoutMs", "maxOutputBytes", "terminationWaitMs"]) ||
      !positiveInteger(limits["timeoutMs"]) || !positiveInteger(limits["maxOutputBytes"]) ||
      !positiveInteger(limits["terminationWaitMs"])) return false;
  if (!exact(verifier, ["packageVersion", "executable", "executableSha256", "entry", "installationSha256"]) ||
      !string(verifier["packageVersion"]) || !string(verifier["executable"]) || !string(verifier["entry"]) ||
      !isAbsolute(verifier["executable"]) || !isAbsolute(verifier["entry"]) ||
      !(verifier["executableSha256"] === null ||
        (string(verifier["executableSha256"]) && hash.test(verifier["executableSha256"]))) ||
      !string(verifier["installationSha256"]) || !hash.test(verifier["installationSha256"])) return false;
  return true;
}

function validResult(value: unknown): value is CompletedOxlintResult {
  if (!exact(value, ["status", "file", "profile", "diagnostics", "process", "binding"]) ||
      (value["status"] !== "passed" && value["status"] !== "check_failed") ||
      !string(value["file"]) || !isAbsolute(value["file"]) || value["profile"] !== "oxlint-basic/v1" ||
      value["process"] !== "exited" || !Array.isArray(value["diagnostics"]) ||
      !validBinding(value["binding"])) return false;
  if (value["status"] === "passed" && value["diagnostics"].length !== 0) return false;
  if (value["status"] === "check_failed" && value["diagnostics"].length === 0) return false;
  if (value["file"] !== value["binding"]["source"]["file"]) return false;
  for (const diagnostic of value["diagnostics"]) {
    if (!exact(diagnostic, ["rule", "message", "line", "column"]) ||
        !string(diagnostic["rule"]) || !rules.has(diagnostic["rule"]) ||
        !string(diagnostic["message"]) || diagnostic["message"].length === 0 ||
        !positiveInteger(diagnostic["line"]) || !positiveInteger(diagnostic["column"])) return false;
  }
  return true;
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
