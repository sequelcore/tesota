import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import * as z from "zod";
import { runPiProposalDiscovery, type PiProposalDiscoveryResult } from "./integrations/pi-proposal.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { assertNoRepositoryGitPrograms, isGitObjectId, runRepositoryGit, runRepositoryGitBytes } from "./repository-git.js";
import { PROPOSAL_CHECKS, PROPOSAL_LIMITS, proposalListSchema, proposalReadSchema, proposalSearchSchema,
  taskProposalSchema, validProposalPath, type TaskProposal } from "./task-proposal-contract.js";

export interface TaskProposalRecord {
  readonly format: "tesota-task-proposal";
  readonly version: 1;
  readonly id: string;
  readonly recordedAt: string;
  readonly source: string;
  readonly baseline: string;
  readonly request: string;
  readonly authority: "none";
  readonly provenance: "model_proposed";
  readonly status: "ready" | "blocked_dirty";
  readonly proposal: TaskProposal;
  readonly dirtyPaths: readonly string[];
  readonly dirtyConflicts: readonly string[];
  readonly checks: readonly { readonly id: typeof PROPOSAL_CHECKS[number];
    readonly definition: "application_owned_declarative_only"; readonly executable: false }[];
  readonly discovery: {
    readonly provider: string; readonly model: string; readonly inferenceTransport: "configured_provider";
    readonly modelControlledNetwork: false; readonly modelInvocations: number; readonly toolCalls: number;
    readonly operations: number; readonly exposedBytes: number; readonly limits: typeof PROPOSAL_LIMITS;
  };
}

const proposalRecordSchema: z.ZodType<TaskProposalRecord> = z.strictObject({
  format: z.literal("tesota-task-proposal"), version: z.literal(1), id: z.uuid(), recordedAt: z.iso.datetime(),
  source: z.string().refine(isAbsolute), baseline: z.string().refine(isGitObjectId), request: z.string().min(1).max(8_000),
  authority: z.literal("none"), provenance: z.literal("model_proposed"), status: z.enum(["ready", "blocked_dirty"]),
  proposal: taskProposalSchema, dirtyPaths: z.array(z.string().refine(validProposalPath)),
  dirtyConflicts: z.array(z.string().refine(validProposalPath)),
  checks: z.array(z.strictObject({ id: z.enum(PROPOSAL_CHECKS),
    definition: z.literal("application_owned_declarative_only"), executable: z.literal(false) })),
  discovery: z.strictObject({ provider: z.string().min(1), model: z.string().min(1), inferenceTransport: z.literal("configured_provider"),
    modelControlledNetwork: z.literal(false), modelInvocations: z.number().int().positive(),
    toolCalls: z.number().int().positive(), operations: z.number().int().nonnegative(),
    exposedBytes: z.number().int().nonnegative(), limits: z.strictObject({
      operations: z.number().int().positive(), listedFiles: z.number().int().positive(), searchMatches: z.number().int().positive(),
      fileBytes: z.number().int().positive(), scannedBytes: z.number().int().positive(), exposedBytes: z.number().int().positive(),
    }),
  }),
});

interface BlobEntry { readonly oid: string; readonly size: number; }
export interface ProposalDiscoveryDescription {
  readonly source: string;
  readonly baseline: string;
  readonly dirtyPaths: readonly string[];
  readonly checks: typeof PROPOSAL_CHECKS;
  readonly limits: typeof PROPOSAL_LIMITS;
}

export interface ProposalDiscovery {
  describe(): ProposalDiscoveryDescription;
  list(input: unknown): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
  search(input: unknown): Promise<{ readonly matches: readonly { readonly path: string; readonly line: number; readonly text: string }[];
    readonly truncated: boolean }>;
  read(input: unknown): Promise<{ readonly path: string; readonly content: string }>;
  submit(input: unknown): TaskProposal;
  metrics(): { readonly operations: number; readonly exposedBytes: number };
  close(): void;
}

function sensitivePath(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return name === ".env" || name.startsWith(".env.") || name === "credentials.json" || name === "secrets.json" ||
    name === "auth.json" || name === ".npmrc" || name === ".pypirc" || name === ".netrc" ||
    name === "id_rsa" || name === "id_ed25519" || /\.(?:pem|key|p12|pfx|secret)$/u.test(name);
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((path) => path.length > 0);
}

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

async function plainDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  const actual = await realpath(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(absolute, actual) !== "") {
    throw new Error("Proposal directory redirected");
  }
  return actual;
}

async function validateStoreLocation(path: string, source: string): Promise<string> {
  const root = resolve(path);
  if (contains(source, root) || contains(root, source)) throw new Error("Proposal storage must be separate from source");
  let ancestor = root;
  for (;;) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  await plainDirectory(ancestor);
  return root;
}

async function prepareStore(path: string, source: string): Promise<string> {
  const root = await validateStoreLocation(path, source);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actual = await plainDirectory(root);
  const info = await lstat(actual);
  if (process.platform === "win32") {
    const systemRoot = process.env["SystemRoot"];
    if (systemRoot === undefined || !isAbsolute(systemRoot)) throw new Error("Cannot locate Windows system tools");
    const powershell = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const executable = await lstat(powershell);
    const executablePath = await realpath(powershell);
    if (!executable.isFile() || executable.isSymbolicLink() || relative(powershell, executablePath) !== "" ||
        contains(source, executablePath) || contains(actual, executablePath)) {
      throw new Error("Windows system tool is not trusted");
    }
    const escaped = actual.replaceAll("'", "''");
    execFileSync(executablePath, ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; $directory=[System.IO.DirectoryInfo]::new('${escaped}'); ` +
      `$owner=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner); ` +
      `$acl=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); ` +
      `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
      `if($owner.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected owner'}; ` +
      `$acl.SetAccessRuleProtection($true,$false); ` +
      `foreach($entry in @($acl.Access)){$acl.RemoveAccessRuleSpecific($entry)}; ` +
      `$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); ` +
      `$acl.AddAccessRule($rule); $directory.SetAccessControl($acl)`],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 });
  } else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error("Proposal storage must be owned by this user with mode 0700");
  }
  return actual;
}

function containsBinaryControls(content: string): boolean {
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code >= 127 && code <= 159) return true;
  }
  return false;
}

function parseTree(value: string): Map<string, BlobEntry> {
  const entries = new Map<string, BlobEntry>();
  for (const line of splitNull(value)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+)\t([\s\S]+)$/u.exec(line);
    if (match === null) throw new Error("Proposal discovery requires regular tracked files");
    const [, , oid, sizeText, path] = match;
    if (oid === undefined || sizeText === undefined || path === undefined || !validProposalPath(path)) {
      throw new Error("Proposal discovery tree invalid");
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Proposal discovery tree invalid");
    if (!sensitivePath(path)) entries.set(path, { oid, size });
  }
  return entries;
}

class GitProposalDiscovery implements ProposalDiscovery {
  readonly #source: string;
  readonly #baseline: string;
  readonly #files: Map<string, BlobEntry>;
  readonly #dirtyPaths: readonly string[];
  readonly #observed = new Set<string>();
  readonly #fullyRead = new Set<string>();
  #operations = 0;
  #exposedBytes = 0;
  #closed = false;

  constructor(source: string, baseline: string, files: Map<string, BlobEntry>, dirtyPaths: readonly string[]) {
    this.#source = source;
    this.#baseline = baseline;
    this.#files = files;
    this.#dirtyPaths = dirtyPaths;
  }

  describe(): ProposalDiscoveryDescription {
    return { source: this.#source, baseline: this.#baseline, dirtyPaths: this.#dirtyPaths,
      checks: PROPOSAL_CHECKS, limits: PROPOSAL_LIMITS };
  }

  #admit(): void {
    if (this.#closed) throw new Error("Proposal discovery closed");
    this.#operations += 1;
    if (this.#operations > PROPOSAL_LIMITS.operations) { this.close(); throw new Error("Proposal discovery denied"); }
  }

  #expose(text: string): void {
    this.#exposedBytes += Buffer.byteLength(text);
    if (this.#exposedBytes > PROPOSAL_LIMITS.exposedBytes) { this.close(); throw new Error("Proposal discovery denied"); }
  }

  #blobBytes(path: string): Buffer {
    const entry = this.#files.get(path);
    if (entry === undefined || entry.size > PROPOSAL_LIMITS.fileBytes) throw new Error("Proposal read denied");
    const bytes = runRepositoryGitBytes(this.#source, ["cat-file", "blob", entry.oid]);
    if (bytes.length !== entry.size) throw new Error("Proposal baseline blob changed");
    return bytes;
  }

  #blob(path: string): string {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(this.#blobBytes(path));
    if (containsBinaryControls(content)) throw new Error("Proposal read denied");
    return content;
  }

  #searchableBlob(path: string): string | null {
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(this.#blobBytes(path));
      return containsBinaryControls(content) ? null : content;
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  }

  async list(input: unknown): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> {
    this.#admit();
    const parsed = proposalListSchema.safeParse(input);
    if (!parsed.success) throw new Error("Proposal list denied");
    const { prefix } = parsed.data;
    const matching = [...this.#files.keys()].filter((path) => path.startsWith(prefix));
    const files = matching.slice(0, PROPOSAL_LIMITS.listedFiles);
    this.#expose(files.join("\n"));
    return { files, truncated: matching.length > files.length };
  }

  async search(input: unknown): Promise<{ readonly matches: readonly { readonly path: string; readonly line: number; readonly text: string }[];
    readonly truncated: boolean }> {
    this.#admit();
    const parsed = proposalSearchSchema.safeParse(input);
    if (!parsed.success) throw new Error("Proposal search denied");
    const { query, prefix } = parsed.data;
    const needle = query.toLocaleLowerCase("en-US");
    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0;
    let truncated = false;
    for (const [path, entry] of this.#files) {
      if (!path.startsWith(prefix) || entry.size > PROPOSAL_LIMITS.fileBytes) continue;
      scanned += entry.size;
      if (scanned > PROPOSAL_LIMITS.scannedBytes) { truncated = true; break; }
      const content = this.#searchableBlob(path);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#closed) throw new Error("Proposal discovery closed");
      if (content === null) continue;
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] ?? "";
        if (!text.toLocaleLowerCase("en-US").includes(needle)) continue;
        matches.push({ path, line: index + 1, text: text.slice(0, 400) });
        this.#observed.add(path);
        if (matches.length === PROPOSAL_LIMITS.searchMatches) { truncated = true; break; }
      }
      if (truncated) break;
    }
    this.#expose(JSON.stringify(matches));
    return { matches, truncated };
  }

  async read(input: unknown): Promise<{ readonly path: string; readonly content: string }> {
    this.#admit();
    const parsed = proposalReadSchema.safeParse(input);
    if (!parsed.success) throw new Error("Proposal read denied");
    const { path } = parsed.data;
    const content = this.#blob(path);
    this.#observed.add(path);
    this.#fullyRead.add(path);
    this.#expose(content);
    return { path, content };
  }

  submit(input: unknown): TaskProposal {
    this.#admit();
    const parsed = taskProposalSchema.safeParse(input);
    if (!parsed.success) throw new Error("Proposal submission denied");
    const proposal = parsed.data;
    if (proposal.readFiles.some((path) => !this.#observed.has(path)) ||
        proposal.writeFiles.some((path) => !this.#fullyRead.has(path))) {
      this.close();
      throw new Error("Proposal paths were not observed");
    }
    return proposal;
  }

  metrics(): { readonly operations: number; readonly exposedBytes: number } {
    return { operations: this.#operations, exposedBytes: this.#exposedBytes };
  }

  close(): void { this.#closed = true; }
}

/** Observe only committed blobs; dirty source bytes are named but never read into discovery. */
export async function openProposalDiscovery(sourceDirectory: string): Promise<ProposalDiscovery> {
  const source = await realpath(runRepositoryGit(resolve(sourceDirectory), ["rev-parse", "--show-toplevel"]).trim());
  assertNoRepositoryGitPrograms(source);
  const baseline = runRepositoryGit(source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!isGitObjectId(baseline)) throw new Error("Proposal baseline invalid");
  const files = parseTree(runRepositoryGit(source, ["ls-tree", "-r", "-l", "-z", "--full-tree", baseline]));
  const dirty = new Set([
    ...splitNull(runRepositoryGit(source, ["diff", "--no-renames", "--name-only", "-z", baseline, "--"])),
    ...splitNull(runRepositoryGit(source, ["diff", "--cached", "--no-renames", "--name-only", "-z", baseline, "--"])),
    ...splitNull(runRepositoryGit(source, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ].filter((path) => validProposalPath(path) && !sensitivePath(path)));
  return new GitProposalDiscovery(source, baseline, files, [...dirty].sort());
}

function checkInputConflict(path: string, check: typeof PROPOSAL_CHECKS[number]): boolean {
  if (check !== "repository-check") return false;
  return path === "package.json" || path === "bun.lock" || path === ".oxlintrc.json" ||
    /^tsconfig(?:\.[^/]+)?\.json$/u.test(path) || path.startsWith("tests/");
}

function proposalConflicts(proposal: TaskProposal, dirtyPaths: readonly string[]): string[] {
  const paths = new Set([...proposal.readFiles, ...proposal.writeFiles]);
  return dirtyPaths.filter((path) => paths.has(path) || proposal.checks.some((check) => checkInputConflict(path, check)));
}

export interface ProposedTask {
  readonly directory: string;
  readonly record: TaskProposalRecord;
}

/** Compact operator surface; retained JSON remains the machine-readable evidence. */
export function formatTaskProposal(created: ProposedTask): string {
  const { record } = created;
  const lines = [
    `Task proposal ${record.id}`,
    `Status: ${record.status === "ready" ? "ready for review" : "blocked by excluded working changes"}`,
    `Objective: ${record.proposal.objective}`,
    `Write: ${record.proposal.writeFiles.join(", ")}`,
    `Read: ${record.proposal.readFiles.join(", ") || "none"}`,
    `Checks: ${record.proposal.checks.join(", ")} (declarative only; not executed)`,
    "Completion:",
    ...record.proposal.completionConditions.map((condition) => `- ${condition}`),
  ];
  if (record.proposal.uncertainties.length > 0) {
    lines.push("Uncertainty:", ...record.proposal.uncertainties.map((uncertainty) => `- ${uncertainty}`));
  }
  if (record.dirtyConflicts.length > 0) lines.push(`Dirty conflicts: ${record.dirtyConflicts.join(", ")}`);
  lines.push(`Baseline: ${record.baseline}`, "Authority: none; no candidate was created and nothing can execute this proposal.",
    `Saved: ${created.directory}`);
  return lines.join("\n") + "\n";
}

export async function proposeTask(options: {
  readonly sourceDirectory: string;
  readonly proposalsRoot: string;
  readonly request: string;
  readonly model: Model<Api>;
  readonly stream: StreamFn;
  readonly signal: AbortSignal;
}): Promise<ProposedTask> {
  const request = z.string().trim().min(1).max(8_000).parse(options.request);
  await validateStoreLocation(options.proposalsRoot, await realpath(runRepositoryGit(resolve(options.sourceDirectory),
    ["rev-parse", "--show-toplevel"]).trim()));
  const discovery = await openProposalDiscovery(options.sourceDirectory);
  const description = discovery.describe();
  let result: PiProposalDiscoveryResult;
  try { result = await runPiProposalDiscovery(discovery, request, options.model, options.stream, options.signal); }
  finally { discovery.close(); }
  if (result.status !== "completed" || result.proposal === null) throw new Error("Proposal discovery failed");
  const dirtyConflicts = proposalConflicts(result.proposal, description.dirtyPaths);
  const id = randomUUID();
  const record = proposalRecordSchema.parse({
    format: "tesota-task-proposal", version: 1, id, recordedAt: new Date().toISOString(),
    source: description.source, baseline: description.baseline, request, authority: "none", provenance: "model_proposed",
    status: dirtyConflicts.length === 0 ? "ready" : "blocked_dirty", proposal: result.proposal,
    dirtyPaths: description.dirtyPaths, dirtyConflicts,
    checks: result.proposal.checks.map((check) => ({ id: check, definition: "application_owned_declarative_only", executable: false })),
    discovery: { provider: options.model.provider, model: options.model.id, inferenceTransport: "configured_provider",
      modelControlledNetwork: false, modelInvocations: result.modelInvocations, toolCalls: result.toolCalls,
      ...result.metrics, limits: PROPOSAL_LIMITS },
  });
  const root = await prepareStore(options.proposalsRoot, description.source);
  const directory = resolve(root, id);
  await mkdir(directory, { mode: 0o700 });
  const file = await open(resolve(directory, "proposal.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  return { directory, record };
}

/** Live command for Tesota's own repository; proposal persistence grants no execution authority. */
export async function runTaskProposalCommand(rawRequest: string): Promise<number> {
  if (process.platform !== "win32") {
    process.stderr.write("Live task proposal is currently supported on Windows.\n");
    return 2;
  }
  try {
    const source = await realpath(runRepositoryGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
    const packageRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    if (relative(packageRoot, source) !== "") {
      process.stderr.write("Live task proposal currently supports only the Tesota repository root.\n");
      return 2;
    }
    const cancellation = new AbortController();
    const interrupt = (): void => cancellation.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      const models = await storedCodexModels(new CodexCredentials(), cancellation.signal);
      const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model?.api !== "openai-codex-responses") throw new Error("model unavailable");
      const created = await proposeTask({ sourceDirectory: source, proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
        request: rawRequest, model, stream: (requested, context, streamOptions) =>
          models.streamSimple(requested, context, streamOptions), signal: cancellation.signal });
      process.stdout.write(formatTaskProposal(created));
      return created.record.status === "ready" ? 0 : 1;
    } finally {
      cancellation.abort();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  } catch {
    process.stderr.write("Task proposal unavailable or failed; no candidate or execution authority was created.\n");
    return 1;
  }
}
