import { createHash } from "node:crypto";
import { lstat, open, mkdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runOxlint, assessApplicability, type OxlintCheck, type Applicability } from "./oxlint.js";
import type { OxlintResult } from "./oxlint-result.js";

export const CANDIDATE_SOURCE = "export const value = 1;\ndebugger;\n";
export const CANDIDATE_EXPECTED_SOURCE = "export const value = 1;\n";
export const CANDIDATE_LIMITS: Readonly<{ edits: number; sourceBytes: number }> = Object.freeze({ edits: 1, sourceBytes: 8 * 1024 });

/** This fixed task preserves the exact declaration; a final LF is optional. */
export function candidateSatisfiesTask(source: string): boolean {
  return source === CANDIDATE_EXPECTED_SOURCE || source === CANDIDATE_EXPECTED_SOURCE.slice(0, -1);
}

function sha256(source: string): string { return createHash("sha256").update(source).digest("hex"); }

/** Private, single-writer exercise workspace. No model-selected filesystem paths. */
export class VerificationCandidate {
  readonly file: string;
  readonly #directory: string;
  readonly #check: OxlintCheck;
  #source = CANDIDATE_SOURCE;
  #busy = false;
  #closed = false;
  #edits = 0;
  #checks: OxlintResult[] = [];

  private constructor(directory: string, check: OxlintCheck) {
    this.#directory = directory;
    this.file = join(directory, "candidate.ts");
    this.#check = { ...check };
  }

  static async create(parent: string, check: OxlintCheck): Promise<VerificationCandidate> {
    const directory = join(resolve(parent), "candidate");
    await mkdir(directory, { mode: 0o700 });
    const candidate = new VerificationCandidate(directory, check);
    const file = await open(candidate.file, "wx", 0o600);
    try { await file.writeFile(CANDIDATE_SOURCE, "utf8"); } finally { await file.close(); }
    return candidate;
  }

  get source(): string { return this.#source; }
  get hash(): string { return sha256(this.#source); }
  get edits(): number { return this.#edits; }
  get checks(): readonly OxlintResult[] { return [...this.#checks]; }
  close(): void { this.#closed = true; }

  async #observe(): Promise<void> {
    const directory = await lstat(this.#directory);
    const metadata = await lstat(this.file);
    if (directory.isSymbolicLink() || !directory.isDirectory() || metadata.isSymbolicLink() ||
        !metadata.isFile() || metadata.nlink !== 1 || metadata.size > CANDIDATE_LIMITS.sourceBytes) throw new Error("Candidate changed");
    const file = await open(this.file, "r");
    try {
      const buffer = Buffer.alloc(CANDIDATE_LIMITS.sourceBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > CANDIDATE_LIMITS.sourceBytes || !buffer.subarray(0, length).equals(Buffer.from(this.#source))) throw new Error("Candidate changed");
    } finally { await file.close(); }
  }

  async #exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#busy) throw new Error("Candidate unavailable");
    this.#busy = true;
    try {
      await this.#observe();
      if (this.#closed) throw new Error("Candidate unavailable");
      return await action();
    } finally { this.#busy = false; }
  }

  async edit(expectedSha256: string, content: string): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#closed || this.#edits >= CANDIDATE_LIMITS.edits || this.#checks.length !== 1 || this.#checks[0]?.status !== "check_failed" ||
          expectedSha256 !== this.hash || typeof content !== "string" || Buffer.byteLength(content, "utf8") > CANDIDATE_LIMITS.sourceBytes ||
          content.includes("\0") || Buffer.from(content).toString("utf8") !== content) throw new Error("Candidate edit denied");
      const temporary = join(this.#directory, "replacement.tmp");
      let created = false;
      try {
        const file = await open(temporary, "wx", 0o600);
        created = true;
        try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
        await this.#observe();
        if (this.#closed) throw new Error("Candidate closed");
        await rename(temporary, this.file);
        this.#source = content;
        this.#edits += 1;
      } finally { if (created) await unlink(temporary).catch(() => {}); }
    });
  }

  async verify(): Promise<OxlintResult> {
    return this.#exclusive(async () => {
      if (this.#checks.length >= 2 || this.#checks.length === 1 && this.#edits !== 1) throw new Error("Candidate verification denied");
      const result = await runOxlint(this.#check, this.file);
      this.#checks.push(result);
      if (result.binding?.source.sha256 !== this.hash) throw new Error("Candidate check binding mismatch");
      return result;
    });
  }

  async applicability(result: OxlintResult): Promise<Applicability> {
    await this.#observe();
    return assessApplicability(result, this.#check);
  }
}
