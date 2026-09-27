import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as z from "zod";
import { type ControlResult, controlsFor, FILESYSTEM_CONTROLS, NETWORK_CONTROLS, PROCESS_CONTROLS,
  runControls } from "./execution-controls.js";
import type { EnvironmentGuarantees, ExecutionProvider } from "./execution-environment.js";
import { qualifiedFilesystem, qualifiedNetwork } from "./verification/sandbox-qualification.js";

/**
 * Qualification on the operator's machine (decision 030): before Tesota runs
 * commands without asking in a provider, the controls behind its claimed
 * guarantees run there, in a scratch workspace, and a claim whose controls did
 * not all pass is withdrawn (`qualifiedFilesystem` and `qualifiedNetwork`,
 * proved). The result is kept per machine and repeated when the provider's
 * fingerprint, such as the Windows build, changes; a failed one is tried again
 * after a day, since a missing network can fail it once.
 */

/** Raised when a control changes, so every machine qualifies again. */
export const CONTROLS_VERSION = 1;
const FAILED_RETRY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_QUALIFICATION_FILE: string = join(homedir(), ".tesota", "qualification.json");

export interface QualificationRecord {
  readonly provider: string;
  /** What the result depends on on this machine, such as the operating system build and the provider's version. */
  readonly fingerprint: string;
  readonly at: string;
  /** The guarantees the controls upheld here. */
  readonly guarantees: EnvironmentGuarantees;
  readonly results: readonly ControlResult[];
}

const passedAll = (results: readonly ControlResult[], names: readonly string[]): boolean =>
  names.every((name) => results.some((result) => result.control === name && result.passed));

/** The claimed guarantees the controls upheld; a control that did not run counts as failed. */
export function qualifiedGuarantees(claimed: EnvironmentGuarantees, results: readonly ControlResult[]): EnvironmentGuarantees {
  const processPassed = passedAll(results, PROCESS_CONTROLS);
  return { ...claimed,
    filesystem: qualifiedFilesystem(claimed.filesystem, processPassed, passedAll(results, FILESYSTEM_CONTROLS)),
    network: qualifiedNetwork(claimed.network, processPassed, passedAll(results, NETWORK_CONTROLS)) };
}

export interface QualifyOptions {
  /** Where scratch workspaces are made and removed. */
  readonly root: string;
  readonly signal: AbortSignal;
  readonly fingerprint: string;
  readonly refusedUrl?: string;
  readonly registryUrl?: string;
}

/** Run the provider's controls in a scratch workspace on this machine. */
export async function qualifyProvider(provider: ExecutionProvider, options: QualifyOptions): Promise<QualificationRecord> {
  const run = join(options.root, randomUUID());
  const workspace = join(run, "workspace");
  const outside = join(run, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    const environment = await provider.prepare(workspace);
    try {
      const results = await runControls(environment, controlsFor(provider.guarantees), { workspace, outside,
        runtime: environment.javascriptRuntime ?? "node", refusedUrl: options.refusedUrl ?? "https://example.com/",
        registryUrl: options.registryUrl ?? "https://registry.npmjs.org/" }, options.signal);
      return { provider: provider.name, fingerprint: options.fingerprint, at: new Date().toISOString(),
        guarantees: qualifiedGuarantees(provider.guarantees, results), results };
    } finally { await environment.dispose(); }
  } finally {
    await provider.release(workspace).catch(() => undefined);
    await rm(run, { recursive: true, force: true, maxRetries: 3 });
  }
}

const guaranteesSchema = z.strictObject({ filesystem: z.enum(["host", "workspace"]), network: z.enum(["open", "allowlist"]),
  secrets: z.enum(["none", "placeholder"]), resources: z.enum(["unbounded", "bounded"]) });
const recordSchema = z.strictObject({ provider: z.string().min(1), fingerprint: z.string(), at: z.iso.datetime(),
  guarantees: guaranteesSchema, results: z.array(z.strictObject({ control: z.string(), passed: z.boolean(), detail: z.string() })) });
const fileSchema = z.strictObject({ version: z.literal(CONTROLS_VERSION), records: z.array(recordSchema) });

/** Qualification results on this machine, one per provider, in Tesota's own directory. */
export class QualificationStore {
  readonly #path: string;
  readonly #now: () => number;

  constructor(path: string = DEFAULT_QUALIFICATION_FILE, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  #records(): QualificationRecord[] {
    if (!existsSync(this.#path)) return [];
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.#path, "utf8")));
    // Results from other controls, or a file Tesota cannot read, are not trusted: the provider qualifies again.
    return parsed.success ? parsed.data.records as QualificationRecord[] : [];
  }

  /** The provider's result for this fingerprint, unless it withdrew a claim and a day has passed. */
  read(provider: string, fingerprint: string): QualificationRecord | undefined {
    const record = this.#records().find((entry) => entry.provider === provider && entry.fingerprint === fingerprint);
    if (record === undefined) return undefined;
    const complete = record.results.length > 0 && record.results.every((result) => result.passed);
    return complete || this.#now() - Date.parse(record.at) < FAILED_RETRY_MS ? record : undefined;
  }

  /** Keep a result, replacing the provider's earlier one; the file is replaced whole. */
  write(record: QualificationRecord): void {
    const records = [...this.#records().filter((entry) => entry.provider !== record.provider), record];
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: CONTROLS_VERSION, records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.#path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
