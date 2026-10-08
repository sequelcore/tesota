import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Evidence, contentHash } from "./evidence.js";
import { git, headCommit } from "./git.js";
import { type Receipt, renderReceipt } from "./receipt.js";

/**
 * The receipt for a pull request (`tesota receipt`): the last receipt a Pi
 * session in the project settled with, as Markdown for the pull request's
 * description or a comment, or as JSON for CI. The JSON is an unsigned
 * in-toto Statement shaped as the agentic process evidence proposal
 * (in-toto/attestation#600, specified in jfrog/agentic-process-evidence)
 * names its fields; the receipt itself goes in the predicate's `custom`, the
 * place the proposal leaves for what one kind of process records.
 */

/** The part of Pi's session store `tesota receipt` reads: Pi's `SessionManager`. */
export interface PiSessions {
  list(cwd: string): Promise<readonly { readonly path: string; readonly modified: Date }[]>;
  open(path: string): {
    getSessionId(): string;
    getBranch(): readonly { readonly type: string; readonly customType?: string; readonly details?: unknown }[];
  };
}

/** The last receipt on the current branch of the most recently changed session in `cwd` that has one, and its session. */
export async function lastReceipt(sessions: PiSessions, cwd: string): Promise<{ receipt: unknown; sessionId: string } | undefined> {
  const listed = [...await sessions.list(cwd)].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  for (const { path } of listed) {
    const session = sessions.open(path);
    const entry = session.getBranch().findLast(({ type, customType }) =>
      type === "custom_message" && customType === "tesota-receipt");
    if (entry !== undefined) return { receipt: entry.details, sessionId: session.getSessionId() };
  }
  return undefined;
}

/** What the receipt is bound to beyond the session: the commit it describes, its repository, and who is accountable. */
export interface Subject {
  readonly commit: string;
  /** The repository as an HTTPS URL, when its `origin` remote has one. */
  readonly repository?: string;
  readonly owner: string;
  readonly sessionId: string;
  /**
   * The proofs, by path, and the commands whose checked content the commit
   * does not hold: changed or uncommitted since they ran.
   */
  readonly stale: readonly string[];
  /** The files whose content in the commit differs from what the run left (`changedAfter`), or `unreadable`. */
  readonly changedAfter: readonly string[] | "unreadable";
}

/** An `origin` remote as an HTTPS URL without `.git`: `git@host:owner/repo.git` and `ssh://git@host/owner/repo` included. */
export function httpsRepository(remote: string): string | undefined {
  const url = remote.trim().replace(/\.git$/u, "");
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/u.exec(url);
  if (scp !== null) return `https://${scp[1]}/${scp[2]}`;
  const parsed = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/u.exec(url);
  return parsed === null ? undefined : `https://${parsed[1]}/${parsed[2]}`;
}

/** Whether the commit holds the content `evidence` checked: the files hash as they did, and none differs from `HEAD`. */
async function current(root: string, evidence: Evidence): Promise<boolean> {
  const files = await Promise.all(evidence.files.map(async (path) => ({ path,
    content: await readFile(join(root, path), "utf8").catch(() => undefined) })));
  if (contentHash(files) !== evidence.contentHash) return false;
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...evidence.files]);
  return status === "";
}

/** Each of `paths`, relative to `root`, with its blob id in `commit`; a path the commit lacks is left out. */
async function commitBlobs(root: string, commit: string, paths: readonly string[]): Promise<Map<string, string> | undefined> {
  const blobs = new Map<string, string>();
  // In batches, to stay within the command line's length on Windows.
  for (let k = 0; k < paths.length; k += 200) {
    const listed = await git(root, ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", commit, "--", ...paths.slice(k, k + 200)]);
    if (listed === undefined) return undefined;
    for (const item of listed.split("\0")) {
      const match = /^\S+ blob (\S+)\t(.+)$/su.exec(item);
      if (match !== null) blobs.set(match[2] ?? "", match[1] ?? "");
    }
  }
  return blobs;
}

/**
 * The files whose content in `commit` differs from what the receipt's run
 * left: changed from the receipt's base with no record in the receipt,
 * edited since, or changed back. Compared by blob id, so line-ending
 * conversion on checkout changes nothing.
 */
async function changedAfter(root: string, receipt: Receipt, commit: string): Promise<string[] | "unreadable"> {
  if (receipt.changed === "unreadable") return "unreadable";
  // Before the first commit the base is the empty tree, which `hash-object` names for this repository's hash.
  const from = receipt.base ?? (await git(root, ["hash-object", "-t", "tree", "--stdin"]))?.trim();
  const diffed = from === undefined ? undefined
    : await git(root, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", "--relative", from, commit]);
  if (diffed === undefined) return "unreadable";
  const recorded = new Map<string, string | null>(receipt.changed.map(({ path, blob }) => [path, blob]));
  const paths = [...new Set([...diffed.split("\0").filter((path) => path !== ""), ...recorded.keys()])].sort();
  const held = await commitBlobs(root, commit, paths);
  if (held === undefined) return "unreadable";
  return paths.filter((path) => !recorded.has(path) || (held.get(path) ?? null) !== recorded.get(path));
}

/**
 * The facts `tesota receipt` adds to a receipt in the project at `root`, or
 * why it cannot; `owner` is who is accountable, Git's `user.email` unless given.
 */
export async function subjectOf(root: string, receipt: Receipt, sessionId: string, owner?: string): Promise<Subject | string> {
  const commit = await headCommit(root);
  if (commit === null) return "tesota receipt describes a commit, and this project has none.";
  owner ??= (await git(root, ["config", "user.email"]))?.trim();
  if (owner === undefined || owner === "") {
    return "tesota receipt names who is accountable: set Git's user.email, or pass --owner <login or email>.";
  }
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const repository = remote === undefined ? undefined : httpsRepository(remote);
  const checked = [...receipt.proofs.map(({ path, evidence }) => ({ name: path, evidence })),
    ...receipt.tests.map(({ command, evidence }) => ({ name: command, evidence }))];
  const stale: string[] = [];
  for (const { name, evidence } of checked) if (!await current(root, evidence)) stale.push(name);
  return { commit, ...repository === undefined ? {} : { repository }, owner, sessionId, stale,
    changedAfter: await changedAfter(root, receipt, commit) };
}

/** Whether a session entry's details hold a receipt this Tesota reads. */
export function isReceipt(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1 &&
    Reflect.get(value, "repository") === true;
}

/** The page that describes the receipt's format, the Statement's `predicateType`. */
const predicateType = "https://github.com/sequelcore/tesota/blob/main/docs/receipt-v1.md";

/** A commit as an in-toto resource descriptor, located in its repository when it has an HTTPS URL. */
function commitDescriptor(commit: string, repository: string | undefined): object {
  return { ...repository === undefined ? {} : { uri: `git+${repository}@${commit}` }, digest: { gitCommit: commit } };
}

/** The receipt as an in-toto Statement about the commit, with the agentic process evidence proposal's predicate fields. */
export function receiptStatement(receipt: Receipt, subject: Subject, createdAt: string): object {
  const models = [...new Set([receipt.model, ...receipt.claimcheck?.status === "judged"
    ? [receipt.claimcheck.restatedBy, receipt.claimcheck.comparedBy] : []].filter((model) => model !== undefined))];
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [commitDescriptor(subject.commit, subject.repository)],
    predicateType,
    predicate: {
      providers: [{ harness: { name: "pi", version: receipt.pi },
        ...models.length === 0 ? {} : { languageModels: models.map((model) => ({ inferenceProvider: model })) } }],
      traceId: subject.sessionId,
      custom: { ...receipt.base === null ? {} : { baseCommit: commitDescriptor(receipt.base, subject.repository) },
        receipt, stale: subject.stale, changedAfter: subject.changedAfter },
      result: "COMPLETED",
      owner: subject.owner,
      startTimestamp: receipt.startedAt,
      endTimestamp: receipt.settledAt,
    },
    createdAt,
    createdBy: "tesota",
  };
}

/**
 * The receipt as Markdown for a pull request: what it is bound to, the
 * evidence the commit no longer holds, the files changed after the receipt,
 * and the receipt as the operator read it, fenced so no Markdown in it renders.
 */
export function receiptMarkdown(receipt: Receipt, subject: Subject): string {
  const text = renderReceipt(receipt);
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(([run]) => run.length + 1)));
  const short = (commit: string): string => `\`${commit.slice(0, 12)}\``;
  const model = receipt.model === undefined ? "" : `, model \`${receipt.model}\``;
  return [
    "## Tesota receipt",
    "",
    `Commit ${short(subject.commit)}${receipt.base === null ? "" : `, changes from ${short(receipt.base)}`}; Pi ${receipt.pi}${model}; ` +
      `session \`${subject.sessionId}\`, ${receipt.startedAt} to ${receipt.settledAt}.`,
    "",
    ...subject.stale.length === 0 ? [] : [`**Not this commit's content:** what these checked has changed since they ran: ` +
      `${subject.stale.map((name) => `\`${name}\``).join(", ")}. Their results below describe the earlier content.`, ""],
    ...subject.changedAfter === "unreadable"
      ? ["**Not compared:** Git could not tell which files this commit changed after the receipt.", ""]
      : subject.changedAfter.length === 0 ? [] : [`**Changed after the receipt:** this commit's content of these files ` +
        `differs from what the run left, so nothing below covers it: ${subject.changedAfter.map((path) => `\`${path}\``).join(", ")}.`, ""],
    `${fence}text`,
    text,
    fence,
    "",
    "This is check evidence, not a reviewer's acceptance.",
  ].join("\n");
}

/**
 * `tesota receipt [--json] [--owner <login or email>]` in `cwd`: writes the
 * last receipt as Markdown, or as the in-toto Statement with `--json`, and
 * returns the exit code.
 */
export async function receiptCommand(args: readonly string[], cwd: string, sessions: PiSessions,
  write: { out: (text: string) => void; error: (text: string) => void }): Promise<number> {
  let json = false;
  let owner: string | undefined;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] ?? "";
    const next = args[k + 1] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--owner" && next.trim() !== "" && !next.startsWith("--")) { owner = next; k += 1; }
    else if (arg.startsWith("--owner=") && arg.slice(8).trim() !== "") owner = arg.slice(8);
    else {
      write.error(`tesota receipt takes --json and --owner <login or email>, not ${arg}.\n`);
      return 2;
    }
  }
  const found = await lastReceipt(sessions, cwd);
  if (found === undefined) {
    write.error("No Pi session in this folder settled with a Tesota receipt. Run tesota receipt where the session ran.\n");
    return 1;
  }
  if (!isReceipt(found.receipt)) {
    write.error("The last receipt here came from an earlier Tesota, or from a run outside Git; this Tesota cannot write it " +
      "for a pull request. Run the request again.\n");
    return 1;
  }
  const subject = await subjectOf(cwd, found.receipt, found.sessionId, owner);
  if (typeof subject === "string") {
    write.error(`${subject}\n`);
    return 1;
  }
  write.out(json ? `${JSON.stringify(receiptStatement(found.receipt, subject, new Date().toISOString()), null, 2)}\n`
    : `${receiptMarkdown(found.receipt, subject)}\n`);
  return 0;
}
