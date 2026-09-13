import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall,
  type FauxResponseStep } from "@earendil-works/pi-ai";
import { discoverConversationTurn, formatConversationTurn } from "../src/conversation-turn.js";
import { openRepositoryDiscovery } from "../src/repository-discovery.js";
import { formatTaskProposal, type ProposedTask } from "../src/task-proposal.js";
import { runPiDiscovery } from "../src/integrations/pi-discovery.js";
import { admitTaskProposal } from "../src/proposal-admission.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error !== undefined) throw new Error(result.stderr || "Fixture Git failed");
  return result.stdout;
}

async function fixture(): Promise<{ readonly root: string; readonly source: string; readonly proposals: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-proposal-test-"));
  roots.push(root);
  const source = join(root, "source with spaces");
  await mkdir(join(source, "docs"), { recursive: true });
  await mkdir(join(source, "src", "integrations"), { recursive: true });
  await mkdir(join(source, "tests"), { recursive: true });
  await writeFile(join(source, "README.md"), "# Fixture\n\nOld task wording.\n");
  await writeFile(join(source, "docs", "identity.md"), "# Identity\n\nA bounded coding agent.\n");
  await writeFile(join(source, "package.json"), '{"name":"tesota","scripts":{"check":"bounded"}}\n');
  await writeFile(join(source, "bun.lock"), "fixture lock\n");
  await writeFile(join(source, "tests", "contract.test.ts"), "export const obligation = true;\n");
  await writeFile(join(source, "src", "integrations", "pi-task.ts"), "export const result = true;\n");
  await writeFile(join(source, "src", "code-task-check.ts"), "export const oracle = true;\n");
  await writeFile(join(source, "src", "candidate-task-definition.ts"), "export const definition = true;\n");
  await writeFile(join(source, "src", "command-isolation.ts"), "export const boundary = true;\n");
  await writeFile(join(source, "tests", "pi-task-evidence.test.ts"), "// Existing focused checks.\n");
  await writeFile(join(source, ".env"), "SYNTHETIC_PRIVATE=never-disclose\n");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "."]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  return { root, source, proposals: join(root, "proposals") };
}

function fakeModel(steps: FauxResponseStep[]) {
  const fake = fauxProvider({ models: [{ id: "proposal-test", name: "Proposal test" }], tokensPerSecond: 1_000_000 });
  fake.setResponses(steps);
  return { model: fake.getModel(), stream: vi.fn(fake.provider.streamSimple) };
}

async function proposeThroughConversation(options: {
  readonly sourceDirectory: string;
  readonly proposalsRoot: string;
  readonly request: string;
  readonly model: ReturnType<typeof fakeModel>["model"];
  readonly stream: ReturnType<typeof fakeModel>["stream"];
  readonly signal: AbortSignal;
}): Promise<ProposedTask> {
  const { request, ...dependencies } = options;
  const turn = await discoverConversationTurn({ ...dependencies, input: { request }, allowedOutcome: "task_proposal" });
  if (turn.kind !== "task_proposal") throw new Error("Expected a task proposal");
  return turn.proposedTask;
}

function proposalSteps(): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall("tesota_list", { prefix: "" })),
    fauxAssistantMessage(fauxToolCall("tesota_search", { query: "task", prefix: "" })),
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "README.md" })),
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "docs/identity.md" })),
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", { kind: "task_proposal", proposal: {
      objective: "Clarify the natural-language task experience.",
      completionConditions: ["README and identity describe the same operator flow."],
      readFiles: ["README.md", "docs/identity.md"],
      writeFiles: ["README.md", "docs/identity.md"],
      checks: ["repository-check"],
      uncertainties: [],
    } })),
    fauxAssistantMessage("Proposal ready."),
  ];
}

function documentationProposalSteps(): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "docs/identity.md" })),
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", { kind: "task_proposal", proposal: {
      objective: "Clarify the documented operator experience.",
      completionConditions: ["The explanation uses plain language."],
      readFiles: ["docs/identity.md"], writeFiles: ["docs/identity.md"],
      checks: ["repository-check"], uncertainties: [],
    } })),
    fauxAssistantMessage("Proposal ready."),
  ];
}

function codeProposalSteps(): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/integrations/pi-task.ts" })),
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "tests/pi-task-evidence.test.ts" })),
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/code-task-check.ts" })),
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", { kind: "task_proposal", proposal: {
      objective: "Strengthen task-result consistency checks.",
      completionConditions: ["Inconsistent evidence is rejected by the trusted behavior check."],
      readFiles: ["src/integrations/pi-task.ts", "tests/pi-task-evidence.test.ts", "src/code-task-check.ts"],
      writeFiles: ["src/integrations/pi-task.ts", "tests/pi-task-evidence.test.ts"],
      checks: ["pi-result-consistency"], uncertainties: [],
    } })),
    fauxAssistantMessage("Proposal ready."),
  ];
}

it("reads only committed regular blobs and reports source changes without modifying them", async () => {
  const { source } = await fixture();
  await writeFile(join(source, "binary.dat"), Buffer.from([0xff, 0x00, 0xfe]));
  await writeFile(join(source, "control.bin"), Buffer.from([0x61, 0x01, 0x02, 0x03, 0x62]));
  git(source, ["add", "binary.dat", "control.bin"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Binary fixture"]);
  await writeFile(join(source, "README.md"), "operator work\n");
  await writeFile(join(source, "untracked.md"), "untracked operator work\n");
  const before = git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const discovery = await openRepositoryDiscovery(source);
  expect(discovery.describe()).toMatchObject({
    baseline: expect.stringMatching(/^[a-f0-9]{40}$/),
    dirtyPaths: ["README.md", "untracked.md"],
  });
  expect((await discovery.list({ prefix: "" })).files).toEqual([
    "README.md", "binary.dat", "bun.lock", "control.bin", "docs/identity.md", "package.json",
    "src/candidate-task-definition.ts", "src/code-task-check.ts", "src/command-isolation.ts",
    "src/integrations/pi-task.ts", "tests/contract.test.ts", "tests/pi-task-evidence.test.ts",
  ]);
  expect((await discovery.read({ path: "README.md" })).content).toContain("Old task wording");
  await expect(discovery.read({ path: ".env" })).rejects.toThrow("denied");
  await expect(discovery.read({ path: "binary.dat" })).rejects.toThrow();
  await expect(discovery.read({ path: "control.bin" })).rejects.toThrow("denied");
  await expect(discovery.search({ query: "task", prefix: "" })).resolves.toMatchObject({
    matches: [{ path: "README.md", line: 3, text: "Old task wording." }],
  });
  await expect(discovery.read({ path: "../outside" })).rejects.toThrow("denied");
  expect(git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(before);
  discovery.close();
  await expect(discovery.read({ path: "README.md" })).rejects.toThrow("closed");
});

it.runIf(process.platform === "win32")("does not execute a repository-root git.exe", async () => {
  const { source } = await fixture();
  await writeFile(join(source, "git.exe"), "repository-owned executable must not run");
  const discovery = await openRepositoryDiscovery(source);
  expect(discovery.describe().baseline).toMatch(/^[a-f0-9]{40}$/u);
  discovery.close();
});

it("fails closed without running a worktree-configured Git clean filter", async () => {
  const { source } = await fixture();
  await writeFile(join(source, ".gitattributes"), "README.md filter=probe\n");
  git(source, ["add", ".gitattributes"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Filter attributes"]);
  git(source, ["config", "extensions.worktreeConfig", "true"]);
  git(source, ["config", "--worktree", "filter.probe.clean", "tee filter-marker.txt"]);
  await writeFile(join(source, "README.md"), "changed after filter configuration\n");
  await expect(openRepositoryDiscovery(source)).rejects.toThrow("Git programs");
  await expect(readFile(join(source, "filter-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("produces and privately retains a non-authoritative proposal from bounded read-only tools", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel(proposalSteps());
  const created = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals,
    request: "Improve the task experience wording without requiring me to name files.",
    model: fake.model, stream: fake.stream, signal: new AbortController().signal });
  expect(created.record).toMatchObject({
    format: "tesota-task-proposal", version: 1, authority: "none", status: "ready",
    request: "Improve the task experience wording without requiring me to name files.",
    proposal: { writeFiles: ["README.md", "docs/identity.md"], checks: ["repository-check"] },
    discovery: { modelInvocations: 6, toolCalls: 5, modelControlledNetwork: false },
  });
  expect(JSON.parse(await readFile(join(created.directory, "proposal.json"), "utf8"))).toEqual(created.record);
  if (process.platform === "win32") {
    const powershell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const acl = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      `$directory=[System.IO.DirectoryInfo]::new('${proposals.replaceAll("'", "''")}'); ` +
      `$directory.GetAccessControl().Access | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}`],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 5_000 });
    expect(acl.status).toBe(0);
    const identities = acl.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const current = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 5_000 }).stdout.trim();
    expect(identities).toEqual([current]);
  }
  expect(await readFile(join(source, "README.md"), "utf8")).toContain("Old task wording");
  expect(formatTaskProposal(created)).toContain(
    "Status: ready for review\nObjective: Clarify the natural-language task experience.\n" +
    "Write: README.md, docs/identity.md\n",
  );
  expect(formatTaskProposal(created)).toContain("Authority: none; no candidate was created and nothing can execute this proposal.\n");
  expect(fake.stream).toHaveBeenCalledTimes(6);
  for (const call of fake.stream.mock.calls) {
    expect(call[1].tools?.map((tool) => tool.name)).toEqual([
      "tesota_list", "tesota_search", "tesota_read", "tesota_submit_result",
    ]);
  }
});

it("admits one current single-file documentation proposal without trusting it as authority", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel(documentationProposalSteps());
  const created = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals,
    request: "Clarify the operator experience.", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal });
  await expect(admitTaskProposal({ proposalsRoot: proposals, reference: created.record.id, sourceDirectory: source }))
    .resolves.toMatchObject({
      kind: "proposal-documentation", proposalId: created.record.id, baseline: created.record.baseline,
      objective: "Clarify the documented operator experience.", readFiles: ["docs/identity.md"],
      writeFiles: ["docs/identity.md"],
      verification: { scopeIntegrity: "application_owned", repositoryCheck: "not_executed_in_first_slice" },
    });
});

it("maps the exact proposed TypeScript scope to an application-owned code grant", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel(codeProposalSteps());
  const created = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals,
    request: "Strengthen the task-result consistency checks.", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal });

  await expect(admitTaskProposal({ proposalsRoot: proposals, reference: created.record.id, sourceDirectory: source }))
    .resolves.toMatchObject({
      kind: "proposal-code", task: "pi-result-consistency", proposalId: created.record.id,
      readFiles: ["src/integrations/pi-task.ts", "tests/pi-task-evidence.test.ts"],
      writeFiles: ["src/integrations/pi-task.ts", "tests/pi-task-evidence.test.ts"],
      declaredChecks: ["pi-result-consistency"],
      verification: { scopeIntegrity: "application_owned", behaviorCheck: "pinned_container" },
    });
});

it("blocks a code proposal when its application-owned check input is dirty", async () => {
  const { source, proposals } = await fixture();
  await writeFile(join(source, "src", "code-task-check.ts"), "export const oracle = false;\n");
  const fake = fakeModel(codeProposalSteps());
  const created = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals,
    request: "Strengthen the task-result consistency checks.", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal });

  expect(created.record).toMatchObject({ status: "blocked_dirty", dirtyConflicts: ["src/code-task-check.ts"] });
  await expect(admitTaskProposal({ proposalsRoot: proposals, reference: created.record.id, sourceDirectory: source }))
    .rejects.toThrow("not admissible");
});

it("rejects stale and unsupported proposal evidence before issuing a run grant", async () => {
  const { source, proposals } = await fixture();
  const supported = fakeModel(documentationProposalSteps());
  const created = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals,
    request: "Clarify the operator experience.", model: supported.model, stream: supported.stream,
    signal: new AbortController().signal });
  await writeFile(join(source, "README.md"), "# Changed baseline\n");
  git(source, ["add", "README.md"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Advance baseline"]);
  await expect(admitTaskProposal({ proposalsRoot: proposals, reference: created.record.id, sourceDirectory: source }))
    .rejects.toThrow("stale");

  const unsupported = fakeModel(proposalSteps());
  const multi = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals,
    request: "Change two files.", model: unsupported.model, stream: unsupported.stream,
    signal: new AbortController().signal });
  await expect(admitTaskProposal({ proposalsRoot: proposals, reference: multi.record.id, sourceDirectory: source }))
    .rejects.toThrow("unsupported");
});

it("reapplies discovery exclusions when retained proposal evidence is coherently rewritten", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel(documentationProposalSteps());
  const created = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals,
    request: "Clarify the operator experience.", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal });
  const rewritten = { ...created.record, proposal: { ...created.record.proposal,
    readFiles: [...created.record.proposal.readFiles, ".env"] } };
  await writeFile(join(created.directory, "proposal.json"), JSON.stringify(rewritten, null, 2) + "\n");
  await expect(admitTaskProposal({ proposalsRoot: proposals, reference: created.record.id, sourceDirectory: source }))
    .rejects.toThrow("unsupported");
});

it("answers a repository question from observed baseline evidence without retaining a proposal", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "docs/identity.md" })),
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", {
      kind: "answer",
      message: "Tesota is a bounded coding agent.",
      evidenceFiles: ["docs/identity.md"],
      uncertainties: [],
    })),
    fauxAssistantMessage("Answered."),
  ]);

  const turn = await discoverConversationTurn({ sourceDirectory: source, proposalsRoot: proposals,
    input: { request: "What is Tesota?" }, allowedOutcome: "conversation", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal });

  expect(turn).toMatchObject({ kind: "answer", answer: {
    message: "Tesota is a bounded coding agent.", evidenceFiles: ["docs/identity.md"], uncertainties: [],
  } });
  expect(formatConversationTurn(turn)).toContain("Authority: none; nothing changed.\n");
  await expect(readdir(proposals)).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns one clarification without inventing a proposal or repository evidence", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", {
      kind: "clarification",
      question: "Which behavior should change?",
      reason: "The requested improvement does not identify an observable outcome.",
    })),
    fauxAssistantMessage("Clarification requested."),
  ]);

  const turn = await discoverConversationTurn({ sourceDirectory: source, proposalsRoot: proposals,
    input: { request: "Make it better" }, allowedOutcome: "conversation", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal });

  expect(turn).toMatchObject({ kind: "clarification", clarification: {
    question: "Which behavior should change?",
  } });
  expect(formatConversationTurn(turn)).toContain("Authority: none; nothing changed.\n");
  await expect(readdir(proposals)).rejects.toMatchObject({ code: "ENOENT" });
});

it("binds one clarification answer to a continued proposal and disallows another question", async () => {
  const { source, proposals } = await fixture();
  const baseline = git(source, ["rev-parse", "HEAD"]).trim();
  const clarified = { request: "Update the guide", clarification: {
    question: "Which guide should change?", answer: "Use the identity guide.", baseline } };
  const proposed = await discoverConversationTurn({ sourceDirectory: source, proposalsRoot: proposals,
    input: clarified, allowedOutcome: "conversation", ...fakeModel(proposalSteps()),
    signal: new AbortController().signal });
  if (proposed.kind !== "task_proposal") throw new Error("Expected a continued proposal");
  expect(proposed.proposedTask.record.request).toBe(
    "Update the guide\n\nClarification: Which guide should change?\nOperator answer: Use the identity guide.",
  );

  const repeated = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", { kind: "clarification",
      question: "Which section?", reason: "The answer remains broad." })),
  ]);
  await expect(discoverConversationTurn({ sourceDirectory: source, proposalsRoot: proposals,
    input: clarified, allowedOutcome: "conversation", model: repeated.model, stream: repeated.stream,
    signal: new AbortController().signal })).rejects.toThrow("failed");
});

it("rejects an oversized retained clarification request before inference", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel(proposalSteps());
  await expect(discoverConversationTurn({ sourceDirectory: source, proposalsRoot: proposals,
    input: { request: "x".repeat(7_998), clarification: {
      question: "q", answer: "a", baseline: git(source, ["rev-parse", "HEAD"]).trim() } },
    allowedOutcome: "conversation", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal })).rejects.toThrow();
  expect(fake.stream).not.toHaveBeenCalled();
  await expect(readdir(proposals)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a changed clarification baseline before inference or proposal retention", async () => {
  const { source, proposals } = await fixture();
  const expectedBaseline = git(source, ["rev-parse", "HEAD"]).trim();
  await writeFile(join(source, "README.md"), "# New committed baseline\n");
  git(source, ["add", "README.md"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Advance during clarification"]);
  const fake = fakeModel(proposalSteps());

  await expect(discoverConversationTurn({ sourceDirectory: source, proposalsRoot: proposals,
    input: { request: "Update the guide", clarification: {
      question: "Which guide?", answer: "The identity guide.", baseline: expectedBaseline } },
    allowedOutcome: "conversation", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal })).rejects.toThrow("baseline changed");
  expect(fake.stream).not.toHaveBeenCalled();
  await expect(readdir(proposals)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects an answer that cites a baseline file it did not observe", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", {
      kind: "answer", message: "Tesota is documented.", evidenceFiles: ["docs/identity.md"], uncertainties: [],
    })),
  ]);

  await expect(discoverConversationTurn({ sourceDirectory: source, proposalsRoot: proposals,
    input: { request: "What is Tesota?" }, allowedOutcome: "conversation", model: fake.model, stream: fake.stream,
    signal: new AbortController().signal })).rejects.toThrow("failed");
  await expect(readdir(proposals)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects an answer from the explicit proposal-only command contract", async () => {
  const { source, proposals } = await fixture();
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", {
      kind: "answer", message: "No change is needed.", evidenceFiles: ["README.md"], uncertainties: [],
    })),
  ]);

  await expect(proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals, request: "Explain the README",
    model: fake.model, stream: fake.stream, signal: new AbortController().signal })).rejects.toThrow("failed");
  await expect(readdir(proposals)).rejects.toMatchObject({ code: "ENOENT" });
});

it("blocks a proposal whose paths or immutable check inputs have excluded working changes", async () => {
  const { source, proposals } = await fixture();
  await writeFile(join(source, "README.md"), "operator draft\n");
  await writeFile(join(source, "tests", "contract.test.ts"), "export const obligation = false;\n");
  const fake = fakeModel(proposalSteps());
  const created = await proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals, request: "Clarify task wording",
    model: fake.model, stream: fake.stream, signal: new AbortController().signal });
  expect(created.record).toMatchObject({ status: "blocked_dirty",
    dirtyConflicts: ["README.md", "tests/contract.test.ts"] });
  expect(created.record.proposal.writeFiles).toEqual(["README.md", "docs/identity.md"]);
});

it("reports both sides of a staged rename so a deleted proposal input cannot look clean", async () => {
  const { source } = await fixture();
  await rename(join(source, "README.md"), join(source, "RENAMED.md"));
  git(source, ["add", "-A"]);
  const discovery = await openRepositoryDiscovery(source);
  expect(discovery.describe().dirtyPaths).toContain("README.md");
  expect(discovery.describe().dirtyPaths).toContain("RENAMED.md");
  discovery.close();
});

it("rejects unobserved paths, malformed or mutating tools without retaining proposal authority", async () => {
  const { source, proposals } = await fixture();
  const unobserved = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "README.md" })),
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", { kind: "task_proposal", proposal: {
      objective: "Change identity.", completionConditions: ["Identity changes."],
      readFiles: ["README.md", "docs/identity.md"], writeFiles: ["docs/identity.md"],
      checks: ["repository-check"], uncertainties: [],
    } })),
  ]);
  await expect(proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals, request: "Change identity",
    model: unobserved.model, stream: unobserved.stream, signal: new AbortController().signal })).rejects.toThrow("failed");

  const mutating = fakeModel([fauxAssistantMessage(fauxToolCall("tesota_replace", {
    path: "README.md", content: "SYNTHETIC_PRIVATE",
  }))]);
  await expect(proposeThroughConversation({ sourceDirectory: source, proposalsRoot: proposals, request: "Change README",
    model: mutating.model, stream: mutating.stream, signal: new AbortController().signal })).rejects.toThrow("failed");
  await expect(readFile(join(source, "README.md"), "utf8")).resolves.toContain("Old task wording");
  await expect(readdir(proposals)).rejects.toMatchObject({ code: "ENOENT" });
});

it("closes discovery when its product-owned operation budget is exhausted", async () => {
  const { source } = await fixture();
  const discovery = await openRepositoryDiscovery(source);
  for (let index = 0; index < 32; index += 1) await discovery.list({ prefix: "" });
  await expect(discovery.list({ prefix: "" })).rejects.toThrow("denied");
  await expect(discovery.read({ path: "README.md" })).rejects.toThrow("closed");
});

it("settles an aborted discovery without accepting a late proposal", async () => {
  const { source } = await fixture();
  const discovery = await openRepositoryDiscovery(source);
  const fake = fakeModel([]);
  const stream = createAssistantMessageEventStream();
  fake.stream.mockImplementation(() => stream);
  const cancellation = new AbortController();
  vi.useFakeTimers();
  const running = runPiDiscovery(discovery, { request: "Inspect the repository" }, "task_proposal",
    fake.model, fake.stream, cancellation.signal);
  await vi.advanceTimersByTimeAsync(0);
  cancellation.abort();
  await vi.advanceTimersByTimeAsync(2_000);
  const result = await running;
  expect(result).toMatchObject({ status: "unsettled", outcome: null });
  const late = fauxAssistantMessage(fauxToolCall("tesota_submit_result", { kind: "task_proposal", proposal: {
    objective: "Late", completionConditions: ["Late"], readFiles: [], writeFiles: ["README.md"],
    checks: ["repository-check"], uncertainties: [],
  } }));
  stream.push({ type: "done", reason: "toolUse", message: late });
  stream.end(late);
  await vi.advanceTimersByTimeAsync(1);
  expect(result.outcome).toBeNull();
});

it("does not accept a terminal stop that arrives after the session deadline", async () => {
  const { source } = await fixture();
  const discovery = await openRepositoryDiscovery(source);
  const fake = fakeModel([]);
  const held = createAssistantMessageEventStream();
  const messages = [
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "README.md" })),
    fauxAssistantMessage(fauxToolCall("tesota_submit_result", { kind: "task_proposal", proposal: {
      objective: "Clarify README.", completionConditions: ["README is clear."],
      readFiles: ["README.md"], writeFiles: ["README.md"], checks: ["repository-check"], uncertainties: [],
    } })),
  ];
  let invocation = 0;
  fake.stream.mockImplementation(() => {
    const message = messages[invocation++];
    if (message === undefined) return held;
    const response = createAssistantMessageEventStream();
    response.push({ type: "done", reason: "toolUse", message });
    response.end(message);
    return response;
  });
  vi.useFakeTimers();
  const running = runPiDiscovery(discovery, { request: "Clarify README" }, "task_proposal", fake.model, fake.stream,
    new AbortController().signal);
  for (let index = 0; index < 10 && invocation < 3; index += 1) await vi.advanceTimersByTimeAsync(0);
  expect(invocation).toBe(3);
  await vi.advanceTimersByTimeAsync(120_000);
  const stopped = fauxAssistantMessage("Done.");
  held.push({ type: "done", reason: "stop", message: stopped });
  held.end(stopped);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(running).resolves.toMatchObject({ status: "aborted", outcome: null });
});

it("rejects an overlapping proposal store before creating state", async () => {
  const { source } = await fixture();
  const fake = fakeModel(proposalSteps());
  await expect(proposeThroughConversation({ sourceDirectory: source, proposalsRoot: join(source, ".tesota"), request: "Clarify task wording",
    model: fake.model, stream: fake.stream, signal: new AbortController().signal })).rejects.toThrow("separate");
});
