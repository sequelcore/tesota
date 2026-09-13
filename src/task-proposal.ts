import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as z from "zod";
import type { TaskProposalTurn } from "./conversation-turn-contract.js";
import type { PiDiscoveryResult } from "./integrations/pi-discovery.js";
import type { RepositoryDiscoveryDescription } from "./repository-discovery.js";
import { isGitObjectId } from "./repository-git.js";
import { PROPOSAL_CHECKS, PROPOSAL_LIMITS, taskProposalSchema, validProposalPath,
  type TaskProposal } from "./task-proposal-contract.js";

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

function checkInputConflict(path: string, check: typeof PROPOSAL_CHECKS[number]): boolean {
  if (check === "pi-result-consistency") {
    return path === "src/code-task-check.ts" || path === "src/candidate-task-definition.ts" ||
      path === "src/command-isolation.ts" || path === "package.json" || path === "bun.lock";
  }
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

export interface LoadedTaskProposal extends ProposedTask {
  readonly sha256: string;
}

const proposalIdSchema = z.uuid();

/** Read retained proposal evidence without treating its contents as authority. */
export async function loadTaskProposal(proposalsRoot: string, reference: string): Promise<LoadedTaskProposal> {
  const id = proposalIdSchema.parse(reference);
  const root = await plainDirectory(proposalsRoot);
  const directory = resolve(root, id);
  if (!contains(root, directory) || await plainDirectory(directory) !== directory) throw new Error("Proposal unavailable");
  const path = resolve(directory, "proposal.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 128 * 1024 ||
      await realpath(path) !== path) throw new Error("Proposal unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(128 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > 128 * 1024) throw new Error("Proposal exceeds bound");
    const content = bytes.subarray(0, length);
    const record = proposalRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
    if (record.id !== id) throw new Error("Proposal identity changed");
    await validateStoreLocation(root, record.source);
    return { directory, record, sha256: createHash("sha256").update(content).digest("hex") };
  } finally { await file.close(); }
}

export async function retainTaskProposal(options: {
  readonly proposalsRoot: string;
  readonly request: string;
  readonly description: RepositoryDiscoveryDescription;
  readonly result: PiDiscoveryResult & { readonly outcome: TaskProposalTurn };
  readonly model: Model<Api>;
}): Promise<ProposedTask> {
  const { description, result } = options;
  const proposal = result.outcome.proposal;
  const dirtyConflicts = proposalConflicts(proposal, description.dirtyPaths);
  const id = randomUUID();
  const record = proposalRecordSchema.parse({
    format: "tesota-task-proposal", version: 1, id, recordedAt: new Date().toISOString(),
    source: description.source, baseline: description.baseline, request: options.request, authority: "none",
    provenance: "model_proposed", status: dirtyConflicts.length === 0 ? "ready" : "blocked_dirty", proposal,
    dirtyPaths: description.dirtyPaths, dirtyConflicts,
    checks: proposal.checks.map((check) => ({ id: check, definition: "application_owned_declarative_only", executable: false })),
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
