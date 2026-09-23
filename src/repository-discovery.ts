import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { conversationTurnSchema, type ConversationTurn } from "./conversation-turn-contract.js";
import { assertNoRepositoryGitPrograms, isGitObjectId, runRepositoryGit, runRepositoryGitBytes } from "./repository-git.js";
import { PROPOSAL_CHECKS, PROPOSAL_LIMITS, proposalListSchema, proposalReadSchema, proposalSearchSchema,
  validProposalPath } from "./task-proposal-contract.js";

interface BlobEntry { readonly oid: string; readonly size: number; }

export type RepositoryDiscoveryFailureCode = "invalid_arguments" | "read_denied" | "limit_exhausted" |
  "evidence_not_observed" | "baseline_changed" | "closed";

/** Stable, non-sensitive failure categories for the discovery host. Never include model arguments. */
export class RepositoryDiscoveryError extends Error {
  readonly code: RepositoryDiscoveryFailureCode;

  constructor(code: RepositoryDiscoveryFailureCode) {
    super(code === "closed" ? "Repository discovery closed" :
      code === "read_denied" ? "Repository read denied" :
      code === "baseline_changed" ? "Repository baseline blob changed" :
      code === "evidence_not_observed" ? "Discovery paths were not observed" :
      "Repository discovery denied");
    this.code = code;
  }
}

export interface RepositoryDiscoveryDescription {
  readonly source: string;
  readonly baseline: string;
  readonly dirtyPaths: readonly string[];
  readonly checks: typeof PROPOSAL_CHECKS;
  readonly limits: typeof PROPOSAL_LIMITS;
}

export interface RepositoryDiscovery {
  describe(): RepositoryDiscoveryDescription;
  list(input: unknown): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
  search(input: unknown): Promise<{ readonly matches: readonly { readonly path: string; readonly line: number; readonly text: string }[];
    readonly truncated: boolean }>;
  read(input: unknown): Promise<{ readonly path: string; readonly content: string }>;
  submit(input: unknown): ConversationTurn;
  metrics(): { readonly operations: number; readonly exposedBytes: number };
  close(): void;
}

function sensitivePath(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return name === ".env" || name.startsWith(".env.") || name === "credentials.json" || name === "secrets.json" ||
    name === "auth.json" || name === ".npmrc" || name === ".pypirc" || name === ".netrc" ||
    name === "id_rsa" || name === "id_ed25519" || /\.(?:pem|key|p12|pfx|secret)$/u.test(name);
}

export function isRepositoryDiscoveryPathAllowed(path: string): boolean {
  return validProposalPath(path) && !sensitivePath(path);
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((path) => path.length > 0);
}

function parseDirtyPaths(value: string): string[] {
  const paths: string[] = [];
  for (const entry of splitNull(value)) {
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Repository status invalid");
    paths.push(entry.slice(3));
  }
  return paths;
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
    if (match === null) throw new Error("Repository discovery requires regular tracked files");
    const [, , oid, sizeText, path] = match;
    if (oid === undefined || sizeText === undefined || path === undefined || !validProposalPath(path)) {
      throw new Error("Repository discovery tree invalid");
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Repository discovery tree invalid");
    if (isRepositoryDiscoveryPathAllowed(path)) entries.set(path, { oid, size });
  }
  return entries;
}

class GitRepositoryDiscovery implements RepositoryDiscovery {
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

  describe(): RepositoryDiscoveryDescription {
    return { source: this.#source, baseline: this.#baseline, dirtyPaths: this.#dirtyPaths,
      checks: PROPOSAL_CHECKS, limits: PROPOSAL_LIMITS };
  }

  #admit(): void {
    if (this.#closed) throw new RepositoryDiscoveryError("closed");
    this.#operations += 1;
    if (this.#operations > PROPOSAL_LIMITS.operations) {
      this.close();
      throw new RepositoryDiscoveryError("limit_exhausted");
    }
  }

  #expose(text: string): void {
    this.#exposedBytes += Buffer.byteLength(text);
    if (this.#exposedBytes > PROPOSAL_LIMITS.exposedBytes) {
      this.close();
      throw new RepositoryDiscoveryError("limit_exhausted");
    }
  }

  #blobBytes(path: string): Buffer {
    const entry = this.#files.get(path);
    if (entry === undefined || entry.size > PROPOSAL_LIMITS.fileBytes) throw new RepositoryDiscoveryError("read_denied");
    const bytes = runRepositoryGitBytes(this.#source, ["cat-file", "blob", entry.oid]);
    if (bytes.length !== entry.size) throw new RepositoryDiscoveryError("baseline_changed");
    return bytes;
  }

  #blob(path: string): string {
    const bytes = this.#blobBytes(path);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) {
      if (error instanceof TypeError) throw new RepositoryDiscoveryError("read_denied");
      throw error;
    }
    if (containsBinaryControls(content)) throw new RepositoryDiscoveryError("read_denied");
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
    if (!parsed.success) throw new RepositoryDiscoveryError("invalid_arguments");
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
    if (!parsed.success) throw new RepositoryDiscoveryError("invalid_arguments");
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
      await new Promise<void>((resolveSearch) => setImmediate(resolveSearch));
      if (this.#closed) throw new RepositoryDiscoveryError("closed");
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
    if (!parsed.success) throw new RepositoryDiscoveryError("invalid_arguments");
    const { path } = parsed.data;
    const content = this.#blob(path);
    this.#observed.add(path);
    this.#fullyRead.add(path);
    this.#expose(content);
    return { path, content };
  }

  submit(input: unknown): ConversationTurn {
    this.#admit();
    const parsed = conversationTurnSchema.safeParse(input);
    if (!parsed.success) throw new RepositoryDiscoveryError("invalid_arguments");
    const outcome = parsed.data;
    const evidenceFiles = outcome.kind === "answer" ? outcome.evidenceFiles :
      outcome.kind === "task_proposal" ? outcome.proposal.readFiles : [];
    const writeFiles = outcome.kind === "task_proposal" ? outcome.proposal.writeFiles : [];
    if (evidenceFiles.some((path) => !this.#observed.has(path)) ||
        writeFiles.some((path) => !this.#fullyRead.has(path))) {
      this.close();
      throw new RepositoryDiscoveryError("evidence_not_observed");
    }
    return outcome;
  }

  metrics(): { readonly operations: number; readonly exposedBytes: number } {
    return { operations: this.#operations, exposedBytes: this.#exposedBytes };
  }

  close(): void { this.#closed = true; }
}

/** Observe only committed blobs; dirty source bytes are named but never read into discovery. */
export async function openRepositoryDiscovery(sourceDirectory: string): Promise<RepositoryDiscovery> {
  const identity = runRepositoryGit(resolve(sourceDirectory), ["rev-parse", "--show-toplevel", "HEAD^{commit}"])
    .trimEnd().split(/\r?\n/u);
  const [topLevel, baseline] = identity;
  if (identity.length !== 2 || topLevel === undefined || baseline === undefined) {
    throw new Error("Repository identity invalid");
  }
  const source = await realpath(topLevel);
  assertNoRepositoryGitPrograms(source);
  if (!isGitObjectId(baseline)) throw new Error("Repository baseline invalid");
  const files = parseTree(runRepositoryGit(source, ["ls-tree", "-r", "-l", "-z", "--full-tree", baseline]));
  const status = runRepositoryGit(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  const dirty = new Set(parseDirtyPaths(status).filter((path) => validProposalPath(path) && !sensitivePath(path)));
  return new GitRepositoryDiscovery(source, baseline, files, [...dirty].sort());
}
