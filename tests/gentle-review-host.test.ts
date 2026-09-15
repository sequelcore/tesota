import { access, readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { runGentleReviewHost } from "../src/gentle-review-host.js";
import type { GentleProcessRequest } from "../src/integrations/gentle-process.js";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const tree = "a".repeat(40);
const candidate = "C:\\candidates\\one\\repo";
const executable = "C:\\tools\\gentle-ai.exe";
const lineage = "review-test-1";
const executableDigest = hash("9");

const requiredFeatures = [
  "compact_v2_authority", "immutable_snapshot", "repository_independent_capabilities",
  "restart_safe_projection", "target_scoped_status", "uniform_failure_envelope",
  "base_ref_workspace_overlay", "bounded_process_waits", "classified_authority_repair",
  "native_frozen_candidate_context", "native_low_risk_verification", "native_next_transition",
  "opaque_repository_context", "provider_artifact_admission", "provider_targeted_validation_request",
  "recovered_correction_evidence", "risk_reasons", "scope_change_diagnostics",
  "validating_result_reopen", "provider_bound_native_git_context", "provider_submission_descriptors",
] as const;

function capabilities(version = "2.8.0", digest = executableDigest): Record<string, unknown> {
  return {
    schema: "gentle-ai.review-integration.capabilities/v2.5",
    contract: "gentle-ai.review-integration/v2",
    protocol: { major: 2, minor: 5 },
    package: { name: "gentle-ai", version, release_channel: "stable" },
    executable: { sha256: digest, evidence: "self-reported", verification: "compare-with-published-manifest" },
    operations: ["review.capabilities", "review.repair", "review.start", "review.status", "review.validate"],
    schemas: ["gentle-ai.review-integration.status/v7"],
    features: {
      mandatory: requiredFeatures.slice(0, 6).map((name) => ({ name, supported: true, requires: [] })),
      optional: requiredFeatures.slice(6).map((name) => ({ name, supported: true, requires: [] })),
    },
  };
}

function reviewerSlot(subjectHash = hash("4")): Record<string, unknown> {
  const binding = [
    `--lineage=${lineage}`,
    `--expected-revision=${hash("1")}`,
    `--target=${hash("2")}`,
    "--repository-context=rctx1_test",
    "--lens=review-risk",
    "--order=0",
    `--subject-hash=${subjectHash}`,
  ];
  return {
    name: "reviewer_result",
    schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
    capture_operation: "review.capture-result",
    arguments: [...binding.map((value) => ({ token: value })), { token: "--agent=pi" }, { token: "--materialize=true" }],
    submission: {
      operation_token: "capture-result",
      argument_tokens: [...binding, "--input={{value}}"],
      value: { slot: "reviewer_result", domain: "artifact_path_or_stdin",
        schema: "https://gentle-ai.dev/schema/review/reviewer/v1", substitution_location: binding.length },
    },
    artifact_subject: {
      schema: "gentle-ai.review-artifact-subject/v2",
      subject_hash: subjectHash,
      lineage_id: lineage,
      authority_revision: hash("1"),
      target_identity: hash("2"),
      base_tree: tree,
      candidate_tree: tree,
      changed_path_manifest_sha256: hash("3"),
      lens: "review-risk",
      selected_order: 0,
    },
  };
}

function status(input = reviewerSlot()): Record<string, unknown> {
  return {
    schema: "gentle-ai.review-integration.status/v7",
    contract: "gentle-ai.review-integration/v2",
    operation: "review.status",
    action: "collect",
    authority: { version: "compact-v2", lineage_id: lineage, revision: hash("1"), state: "reviewing" },
    target_identity: hash("2"),
    next_transition: { kind: "collect", collect: { inputs: [input] } },
  };
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function materializeTokens(): string[] {
  const value = reviewerSlot()["arguments"];
  if (!Array.isArray(value)) throw new Error("missing fixture arguments");
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("token" in entry) || typeof entry.token !== "string") {
      throw new Error("invalid fixture argument");
    }
    return entry.token;
  });
}

it("relays exact provider tokens and opaque bytes through the current binding", async () => {
  const calls: GentleProcessRequest[] = [];
  const resultBytes = Buffer.from('{"subject_hash":"opaque"}\n');
  const process = vi.fn(async (request: GentleProcessRequest): Promise<Buffer> => {
    calls.push(request);
    if (request.arguments[1] === "capabilities") return json(capabilities());
    if (calls.length === 2 || calls.length === 4) return json(status());
    if (calls.length === 3) return Buffer.from("provider prompt\r\n");
    const inputToken = request.arguments.find((value) => value.startsWith("--input="));
    if (inputToken === undefined) throw new Error("missing input token");
    const path = inputToken.slice("--input=".length);
    expect(await readFile(path)).toStrictEqual(resultBytes);
    return json({ admission_decision: "completed" });
  });
  const reviewer = vi.fn(async (prompt: Buffer) => {
    expect(prompt).toStrictEqual(Buffer.from("provider prompt\r\n"));
    return { stdout: resultBytes, promptByteLength: prompt.length, stdoutByteLength: resultBytes.length };
  });

  const result = await runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process, reviewer, digestExecutable: async () => executableDigest,
  });

  expect(result).toStrictEqual({ status: "submitted", provider: { admission_decision: "completed" } });
  expect(calls).toHaveLength(5);
  expect(calls.every((call) => call.cwd === candidate && call.executable === executable)).toBe(true);
  expect(calls[0]?.arguments).toStrictEqual(["review", "capabilities", "--contract", "gentle-ai.review-integration/v2"]);
  expect(calls[2]?.arguments).toStrictEqual(["review", "capture-result", ...materializeTokens()]);
  const inputToken = calls[4]?.arguments.find((value) => value.startsWith("--input="));
  expect(inputToken).not.toContain("{{value}}");
  await expect(access(inputToken?.slice("--input=".length) ?? "")).rejects.toThrow();
});

it("does not invoke the model when Gentle offers no collection", async () => {
  const stopped = { ...status(), action: "stop", next_transition: undefined };
  const reviewer = vi.fn();
  const result = await runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }),
    process: async (request) => json(request.arguments[1] === "capabilities" ? capabilities() : stopped),
    reviewer, digestExecutable: async () => executableDigest,
  });
  expect(result).toMatchObject({ status: "provider_transition_required", provider: { action: "stop" } });
  expect(reviewer).not.toHaveBeenCalled();
});

it("does not recheck or submit when the reviewer transport fails", async () => {
  const process = vi.fn(async (request: GentleProcessRequest): Promise<Buffer> =>
    request.arguments[1] === "capabilities" ? json(capabilities()) :
      request.arguments.includes("--materialize=true") ? Buffer.from("provider prompt") : json(status()));
  const reviewer = vi.fn(async (): Promise<never> => { throw new Error("provider unavailable"); });

  await expect(runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process, reviewer, digestExecutable: async () => executableDigest,
  })).rejects.toThrow("provider unavailable");

  expect(process).toHaveBeenCalledTimes(3);
  expect(process.mock.calls.map(([request]) => request.effect)).toStrictEqual(["read", "read", "read"]);
});

it("fails closed before submission when the provider binding changes", async () => {
  let call = 0;
  const process = vi.fn(async (): Promise<Buffer> => {
    call += 1;
    if (call === 1) return json(capabilities());
    if (call === 2) return json(status());
    if (call === 3) return Buffer.from("provider prompt");
    return json(status(reviewerSlot(hash("5"))));
  });
  const reviewer = vi.fn(async () => ({ stdout: Buffer.from("result"), promptByteLength: 15, stdoutByteLength: 6 }));
  await expect(runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process, reviewer, digestExecutable: async () => executableDigest,
  })).rejects.toThrow("binding changed");
  expect(process).toHaveBeenCalledTimes(4);
});

it("rejects a subject that does not match current Gentle authority", async () => {
  const mismatched = status();
  mismatched["authority"] = {
    version: "compact-v2", lineage_id: "review-other", revision: hash("1"), state: "reviewing",
  };
  const reviewer = vi.fn();
  await expect(runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }),
    process: async (request) => json(request.arguments[1] === "capabilities" ? capabilities() : mismatched),
    reviewer, digestExecutable: async () => executableDigest,
  })).rejects.toThrow("subject does not match");
  expect(reviewer).not.toHaveBeenCalled();
});

it("rejects stale Gentle versions, executable identity drift and missing v2.8 capabilities", async () => {
  for (const [name, advertised, digest, message] of [
    ["old version", capabilities("2.7.0"), executableDigest, "requires Gentle AI 2.8.0"],
    ["identity drift", capabilities(), hash("8"), "executable identity changed"],
    ["missing feature", { ...capabilities(), features: { mandatory: [], optional: [] } }, executableDigest, "required feature"],
  ] as const) {
    const reviewer = vi.fn();
    await expect(runGentleReviewHost({ candidate: "one", executable, lineage }, {
      inspect: async () => ({ checkout: candidate }), process: async () => json(advertised), reviewer,
      digestExecutable: async () => digest,
    }), name).rejects.toThrow(message);
    expect(reviewer).not.toHaveBeenCalled();
  }
});

it("rejects legacy status envelopes and exposes v2.8 escalation evidence", async () => {
  const escalation = {
    cause: "unresolved_severe_findings",
    finding_ids: ["R1"],
    refuter_outcomes: [{ finding_id: "R1", outcome: "corroborated", proof: "bound evidence" }],
  };
  const escalated = {
    ...status(), action: "stop", next_transition: undefined,
    authority: { version: "compact-v2", lineage_id: lineage, revision: hash("1"), state: "escalated" },
    escalation,
  };
  const processFor = (value: Record<string, unknown>) => async (request: GentleProcessRequest): Promise<Buffer> =>
    json(request.arguments[1] === "capabilities" ? capabilities() : value);

  const result = await runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process: processFor(escalated), reviewer: vi.fn(),
    digestExecutable: async () => executableDigest,
  });
  expect(result).toMatchObject({ status: "provider_transition_required", escalation });

  await expect(runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }),
    process: processFor({ ...escalated, schema: "gentle-ai.review-integration.status/v6" }), reviewer: vi.fn(),
    digestExecutable: async () => executableDigest,
  })).rejects.toThrow();
});

it("projects v2.8 terminal reviewer evidence without consuming acknowledgement authority", async () => {
  const closure = {
    schema: "gentle-ai.review-last-event-closure/v1",
    operation: "review/capture-result",
    lineage_id: lineage,
    state: "approved",
    action: "await acknowledgement",
    store_revision: hash("7"),
    acknowledgement: { operation: "review.acknowledge-approved", token: "provider-owned" },
    reviewer_results: [{
      lens: "review-risk",
      findings: [{
        id: "R1", lens: "review-risk", location: "src/example.ts:1", severity: "WARNING",
        claim: "review claim", proof_refs: ["src/example.ts:1"], evidence_class: "inferential",
        causal_disposition: "introduced",
      }],
      evidence: ["bounded evidence"], result_hash: hash("6"),
    }],
  };
  let statusCalls = 0;
  const process = async (request: GentleProcessRequest): Promise<Buffer> => {
    if (request.arguments[1] === "capabilities") return json(capabilities());
    if (request.arguments[1] === "status") {
      statusCalls += 1;
      return json(status());
    }
    if (request.arguments.includes("--materialize=true")) return Buffer.from("prompt");
    return json(closure);
  };
  const result = await runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process,
    reviewer: async () => ({ stdout: Buffer.from("result"), promptByteLength: 6, stdoutByteLength: 6 }),
    digestExecutable: async () => executableDigest,
  });

  expect(result).toMatchObject({
    status: "submitted",
    closure: { state: "approved", lineage_id: lineage, reviewer_results: closure.reviewer_results },
  });
  expect(statusCalls).toBe(2);
});
