import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { CANDIDATE_SOURCE, CANDIDATE_EXPECTED_SOURCE, CANDIDATE_LIMITS, candidateSatisfiesTask, VerificationCandidate } from "../src/verification/candidate.js";
import { configuredOxlint } from "../src/verification/oxlint.js";
import { DurableVerificationEvidenceStore } from "../src/verification/evidence.js";
import { runPiSession, type PiSessionResult } from "../src/integrations/pi.js";
import { candidateProbePasses, serializeCandidateProbe, verificationSourceIdentity } from "../src/integrations/pi-verification-evidence.js";

const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8", windowsHide: true, timeout: 5_000,
}).trim();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-candidate-test-"));
  roots.push(root);
  const check = configuredOxlint(process.cwd(), bun);
  return { root, check, candidate: await VerificationCandidate.create(root, check) };
}

it.each([CANDIDATE_EXPECTED_SOURCE, CANDIDATE_EXPECTED_SOURCE.slice(0, -1)])("corrects the candidate and invalidates earlier evidence with optional final LF: %j", async (corrected) => {
  const { root, check, candidate } = await fixture();
  const original = candidate.hash;
  const faux = fauxProvider({ models: [{ id: "offline", name: "Offline" }], tokensPerSecond: 100_000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tesota_verify", { input: "candidate.ts" })),
    fauxAssistantMessage(fauxToolCall("tesota_edit_candidate", { expectedSha256: original, content: corrected })),
    fauxAssistantMessage(fauxToolCall("tesota_verify", { input: "candidate.ts" })),
    fauxAssistantMessage("TESOTA_CANDIDATE_OK"),
  ]);
  const result = await runPiSession({ scenario: "candidate_correction", candidate, input: "candidate.ts", check,
    model: faux.getModel(), stream: (model, context, options) => {
      expect(getCurrentTools(context.messages)[0]?.parameters).toMatchObject({ properties: { input: { const: "candidate.ts" } } });
      return faux.provider.streamSimple(model, context, options);
    } });
  const [before, after] = candidate.checks;
  if (before === undefined || after === undefined) throw new Error("Missing check evidence");
  const assessment = { prior: await candidate.applicability(before), current: await candidate.applicability(after) };
  expect(candidateProbePasses(result, candidate, assessment)).toBe(true);
  expect(result).toMatchObject({ modelInvocationCount: 4, verificationInvocationCount: 2, toolExecutionStartCount: 3,
    verificationResultsSupplied: 2 });
  expect(await readFile(candidate.file, "utf8")).toBe(corrected);
  expect(before.status).toBe("check_failed");
  expect(after.status).toBe("passed");
  expect(before.binding?.source.sha256).not.toBe(after.binding?.source.sha256);
  for (const [index, issued] of candidate.checks.entries()) {
    const store = new DurableVerificationEvidenceStore(join(root, `check-${index}.json`));
    await store.save(issued);
    expect((await store.load()).status).toBe("recovered");
  }
  const identity = verificationSourceIdentity("candidate");
  const record = JSON.parse(serializeCandidateProbe(result, candidate, assessment, identity, "", true));
  expect(record).toMatchObject({ disposition: "passed", applicability: { prior: "stale", current: "applicable" }, taskAcceptance: "not_evaluated" });
  expect(serializeCandidateProbe({ ...result, response: "SYNTHETIC_PRIVATE" }, candidate, assessment, identity, "", true)).not.toContain("SYNTHETIC_PRIVATE");
  expect(JSON.parse(serializeCandidateProbe(result, candidate, assessment, identity, "", false)).disposition).toBe("failed");
  for (const mutation of [
    { verificationResultsSupplied: 1 }, { modelInvocationCount: 3 }, { toolExecutionStartCount: 4 },
    { deadlineExpired: true }, { response: "" }, { budgetExceeded: true }, { status: "unsettled" },
  ] satisfies Partial<PiSessionResult>[]) {
    expect(candidateProbePasses({ ...result, ...mutation }, candidate, assessment)).toBe(false);
  }
  await expect(candidate.edit(candidate.hash, "")).rejects.toThrow("unavailable");
  await writeFile(candidate.file, CANDIDATE_SOURCE);
  await expect(candidate.applicability(after)).rejects.toThrow("changed");
});

it("requires an observed failed check and rejects stale, oversized and invalid Unicode edits", async () => {
  const { candidate } = await fixture();
  await expect(candidate.edit(candidate.hash, CANDIDATE_EXPECTED_SOURCE)).rejects.toThrow("denied");
  await candidate.verify();
  for (const [hash, source] of [["stale", CANDIDATE_EXPECTED_SOURCE], [candidate.hash, "x".repeat(CANDIDATE_LIMITS.sourceBytes + 1)],
    [candidate.hash, "\ud800"], [candidate.hash, "\0"]]) {
    if (hash === undefined || source === undefined) throw new Error("Missing test case");
    await expect(candidate.edit(hash, source)).rejects.toThrow("denied");
  }
  expect(await readFile(candidate.file, "utf8")).toBe(CANDIDATE_SOURCE);
  await expect(candidate.verify()).rejects.toThrow("denied");
});

it("does not count a lint-clean deletion of required behavior as a successful correction", async () => {
  const { candidate } = await fixture();
  await candidate.verify();
  await candidate.edit(candidate.hash, "");
  await candidate.verify();
  expect(candidate.source).not.toBe(CANDIDATE_EXPECTED_SOURCE);
  expect(candidateSatisfiesTask(candidate.source)).toBe(false);
  expect(candidate.edits).toBe(1);
  await expect(candidate.edit(candidate.hash, CANDIDATE_EXPECTED_SOURCE)).rejects.toThrow("denied");
  await expect(candidate.verify()).rejects.toThrow("denied");
});

it.each(["", "export const value = 2;\n", "const value = 1;\n", CANDIDATE_SOURCE,
  "export const value = 1;\nexport const extra = 2;\n"])("rejects missing, changed or additional behavior: %j", (source) => {
  expect(candidateSatisfiesTask(source)).toBe(false);
});

it("rejects concurrent operations and external file changes", async () => {
  const { candidate } = await fixture();
  const verification = candidate.verify();
  await expect(candidate.verify()).rejects.toThrow("unavailable");
  await verification;
  await writeFile(candidate.file, "external");
  await expect(candidate.edit(candidate.hash, CANDIDATE_EXPECTED_SOURCE)).rejects.toThrow("changed");
  expect(await readFile(candidate.file, "utf8")).toBe("external");
});

it("rejects a hard-linked replacement without touching the outside file", async () => {
  const { root, candidate } = await fixture();
  const outside = join(root, "outside.ts");
  await writeFile(outside, CANDIDATE_SOURCE);
  await unlink(candidate.file);
  await link(outside, candidate.file);
  await expect(candidate.verify()).rejects.toThrow("changed");
  expect(await readFile(outside, "utf8")).toBe(CANDIDATE_SOURCE);
});

it("preserves an existing replacement reservation and permits no late edit after close", async () => {
  const { root, candidate } = await fixture();
  await candidate.verify();
  const reserved = join(root, "candidate/replacement.tmp");
  await writeFile(reserved, "existing");
  await expect(candidate.edit(candidate.hash, CANDIDATE_EXPECTED_SOURCE)).rejects.toThrow();
  expect(await readFile(reserved, "utf8")).toBe("existing");
  expect(await readFile(candidate.file, "utf8")).toBe(CANDIDATE_SOURCE);
  candidate.close();
  await expect(candidate.verify()).rejects.toThrow("unavailable");
});

it("keeps compiled help offline and accepts no model-selected paths at entry", () => {
  for (const args of [["--help"], ["--stored", "../outside.ts"]]) {
    const result = spawnSync(bun, ["--no-env-file", "dist/live-candidate.js", ...args], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    });
    expect(result.status).toBe(args.length === 1 ? 0 : 2);
    expect(result.stdout + result.stderr).not.toContain("Evidence and candidate diff:");
  }
});
