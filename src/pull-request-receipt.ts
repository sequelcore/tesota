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

/** The facts `tesota receipt` adds to a receipt in the project at `root`, or why it cannot. */
export async function subjectOf(root: string, receipt: Receipt, sessionId: string): Promise<Subject | string> {
  const commit = await headCommit(root);
  if (commit === null) return "tesota receipt describes a commit, and this project has none.";
  const owner = (await git(root, ["config", "user.email"]))?.trim() || (await git(root, ["config", "user.name"]))?.trim();
  if (owner === undefined || owner === "") return "tesota receipt names who is accountable from Git's user.email; set it first.";
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const repository = remote === undefined ? undefined : httpsRepository(remote);
  const checked = [...receipt.proofs.map(({ path, evidence }) => ({ name: path, evidence })),
    ...receipt.tests.map(({ command, evidence }) => ({ name: command, evidence }))];
  const stale: string[] = [];
  for (const { name, evidence } of checked) if (!await current(root, evidence)) stale.push(name);
  return { commit, ...repository === undefined ? {} : { repository }, owner, sessionId, stale };
}

/** Whether a session entry's details hold a receipt this Tesota reads. */
export function isReceipt(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1 &&
    Reflect.get(value, "repository") === true;
}

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
    predicateType: `https://github.com/sequelcore/tesota/receipt/v${receipt.version}`,
    predicate: {
      providers: [{ harness: { name: "pi", version: receipt.pi },
        ...models.length === 0 ? {} : { languageModels: models.map((model) => ({ inferenceProvider: model })) } }],
      traceId: subject.sessionId,
      custom: { ...receipt.base === null ? {} : { baseCommit: commitDescriptor(receipt.base, subject.repository) },
        receipt, stale: subject.stale },
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
 * evidence the commit no longer holds, and the receipt as the operator read
 * it, fenced so no Markdown in it renders.
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
    `${fence}text`,
    text,
    fence,
    "",
    "This is check evidence, not a reviewer's acceptance.",
  ].join("\n");
}

/**
 * `tesota receipt [--json]` in `cwd`: writes the last receipt as Markdown, or
 * as the in-toto Statement with `--json`, and returns the exit code.
 */
export async function receiptCommand(args: readonly string[], cwd: string, sessions: PiSessions,
  write: { out: (text: string) => void; error: (text: string) => void }): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    write.error(`tesota receipt takes only --json, not ${unknown.join(" ")}.\n`);
    return 2;
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
  const subject = await subjectOf(cwd, found.receipt, found.sessionId);
  if (typeof subject === "string") {
    write.error(`${subject}\n`);
    return 1;
  }
  write.out(args.includes("--json") ? `${JSON.stringify(receiptStatement(found.receipt, subject, new Date().toISOString()), null, 2)}\n`
    : `${receiptMarkdown(found.receipt, subject)}\n`);
  return 0;
}
