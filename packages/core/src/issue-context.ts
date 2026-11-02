import { runProcess } from "../../../src/process.ts";
import { parseJson } from "../../../src/json.ts";
import { boundedReferences, readReferences, referenceDigest, referenceType, type RequestReference } from "../../../src/request-references.ts";
import type { SessionEntry } from "./session-file.ts";

/** Identity resolved during a native, already-authorized shell read; never source-authenticity evidence. */
export type IssueRead = {
  readonly source: string;
  readonly contextRepository?: string;
  readonly json: boolean;
};

function repository(text: string, host = "github.com"): string | undefined {
  const publicHost = /^(?:https:\/\/github\.com\/|git@github\.com:|github\.com\/)/u.test(text);
  if (!publicHost && host !== "github.com") return undefined;
  const match = /^(?:(?:https:\/\/github\.com\/|git@github\.com:|github\.com\/))?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(text.trim());
  return match?.[1] === undefined ? undefined : `https://github.com/${match[1]}`;
}

/** Resolve the already-parsed target without interpreting shell syntax. */
function issueSource(target: string, repo: string | undefined): string | undefined {
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/u.exec(target);
  if (url !== null) return `https://github.com/${url[1]}/issues/${url[2]}`;
  return /^[1-9]\d*$/u.test(target) && repo !== undefined ? `${repo}/issues/${target}` : undefined;
}

/** Plain full issue reads only. The local CLI metadata lookup adds no fetch or shell permission. */
export async function issueRead(command: string, cwd: string, signal: AbortSignal, env?: Readonly<Record<string, string>>): Promise<IssueRead | undefined> {
  if (!/^gh issue view [\w\s/:.,=-]+$/u.test(command.trim())) return undefined;
  const words = command.trim().split(/\s+/u).slice(3);
  const target = words.shift();
  if (target === undefined) return undefined;
  let repo: string | undefined;
  let json = false;
  const environment = { ...process.env, ...env };
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "--comments" || word === "-c") continue;
    if (word === "--repo" || word === "-R") { repo = repository(words[++index] ?? "", environment["GH_HOST"]); if (repo === undefined) return undefined; }
    else if (word === "--json") {
      if (!(words[++index] ?? "").split(",").includes("body")) return undefined;
      json = true;
    } else return undefined;
  }
  const contextRepository = await defaultRepository(cwd, signal, environment);
  const source = issueSource(target, repo ?? contextRepository);
  return source === undefined ? undefined : { source, json, ...contextRepository === undefined ? {} : { contextRepository } };
}

/** GitHub CLI owns its default selection. This query is local, read-only, and never falls back to guessing origin. */
async function defaultRepository(cwd: string, signal: AbortSignal, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  if (env["GH_REPO"] !== undefined) return repository(env["GH_REPO"], env["GH_HOST"]);
  const selected = await runProcess("gh", ["repo", "set-default", "--view"], cwd, signal, 5_000, undefined, { env });
  return selected.exitCode === 0 ? repository(selected.output.trim(), env["GH_HOST"]) : undefined;
}

/** Identity beside the exact text already stored once in the tool result. */
export function issueReadDetails(read: IssueRead, text: string, complete: boolean): { readonly issueRead: IssueRead & { readonly complete: boolean } } {
  if (read.json) {
    try {
      const value: unknown = parseJson(text);
      complete &&= typeof value === "object" && value !== null && "body" in value && typeof value.body === "string";
    } catch { complete = false; }
  }
  return { issueRead: { ...read, complete } };
}

function namesReference(name: string, source: string): boolean {
  if (name === source) return true;
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/u.exec(source);
  if (match === null) return false;
  return name === `#${match[3]}` || name === `${match[2]}#${match[3]}` || name === `${match[1]}/${match[2]}#${match[3]}`;
}

/** Replay recorded identities/results; no summaries, re-execution or privileged retrieval. */
export function issueReferences(entries: readonly SessionEntry[], run: number, texts: readonly string[]): RequestReference[] {
  const inherited = entries.flatMap((entry) => entry.type === "custom" && entry.run === run && entry.customType === referenceType
    ? readReferences(entry.data) ?? [{ status: "unavailable" as const, source: "Inherited issue references", reason: "the recorded reference data is malformed" }] : []);
  const named = [...new Set(texts.join("\n").match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*|(?:[\w.-]+\/)?[\w.-]+#[1-9]\d*|#[1-9]\d*/gu) ?? [])];
  if (named.length === 0) return boundedReferences(inherited);
  const reads = entries.flatMap((entry) => {
    if (entry.type !== "tool_result" || entry.run !== run || (entry.message.toolName !== "bash" && entry.message.toolName !== "powershell")) return [];
    const details: unknown = entry.message.details;
    if (typeof details !== "object" || details === null || !("issueRead" in details)) return [];
    const read = details.issueRead;
    if (typeof read !== "object" || read === null || !("source" in read) || typeof read.source !== "string") return [];
    const text = entry.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    const reference: RequestReference = entry.message.isError || !("complete" in read) || read.complete !== true
      ? { status: "unavailable", source: read.source, reason: "the issue read failed or its complete text was not returned" }
      : { status: "read", source: read.source, callId: entry.message.toolCallId, text, digest: referenceDigest(text) };
    return [{ reference, contextRepository: "contextRepository" in read ? read.contextRepository : undefined }];
  });
  const references = named.map((name): RequestReference => {
    const candidates = new Map(inherited.filter((reference) => namesReference(name, reference.source)).map((reference) => [reference.source, reference]));
    for (const { reference, contextRepository } of reads) {
      if (!namesReference(name, reference.source)) continue;
      if (name.startsWith("#") && reference.source.slice(0, reference.source.indexOf("/issues/")) !== contextRepository) continue;
      candidates.set(reference.source, reference);
    }
    const found = candidates.values().next().value;
    if (candidates.size === 1 && found !== undefined) return found;
    return { status: "unavailable", source: name, reason: candidates.size > 1 ? "the issue reference matches more than one recorded repository"
      : "no complete supported GitHub CLI issue read is recorded for this request" };
  });
  return boundedReferences([...new Map([...inherited, ...references].map((reference) => [reference.source, reference])).values()]);
}
