import { access, readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { runGentleReviewHost } from "../src/gentle-review-host.js";
import type { GentleProcessRequest } from "../src/integrations/gentle-process.js";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const tree = "a".repeat(40);
const candidate = "C:\\candidates\\one\\repo";
const executable = "C:\\tools\\gentle-ai.exe";
const lineage = "review-test-1";

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
    action: "finalize",
    authority: { lineage_id: lineage, revision: hash("1") },
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
    if (calls.length === 1 || calls.length === 3) return json(status());
    if (calls.length === 2) return Buffer.from("provider prompt\r\n");
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
    inspect: async () => ({ checkout: candidate }), process, reviewer,
  });

  expect(result).toStrictEqual({ status: "submitted", provider: { admission_decision: "completed" } });
  expect(calls).toHaveLength(4);
  expect(calls.every((call) => call.cwd === candidate && call.executable === executable)).toBe(true);
  expect(calls[1]?.arguments).toStrictEqual(["review", "capture-result", ...materializeTokens()]);
  const inputToken = calls[3]?.arguments.find((value) => value.startsWith("--input="));
  expect(inputToken).not.toContain("{{value}}");
  await expect(access(inputToken?.slice("--input=".length) ?? "")).rejects.toThrow();
});

it("does not invoke the model when Gentle offers no collection", async () => {
  const stopped = { ...status(), action: "stop", next_transition: undefined };
  const reviewer = vi.fn();
  const result = await runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process: async () => json(stopped), reviewer,
  });
  expect(result).toMatchObject({ status: "provider_transition_required", provider: { action: "stop" } });
  expect(reviewer).not.toHaveBeenCalled();
});

it("fails closed before submission when the provider binding changes", async () => {
  let call = 0;
  const process = vi.fn(async (): Promise<Buffer> => {
    call += 1;
    if (call === 1) return json(status());
    if (call === 2) return Buffer.from("provider prompt");
    return json(status(reviewerSlot(hash("5"))));
  });
  const reviewer = vi.fn(async () => ({ stdout: Buffer.from("result"), promptByteLength: 15, stdoutByteLength: 6 }));
  await expect(runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process, reviewer,
  })).rejects.toThrow("binding changed");
  expect(process).toHaveBeenCalledTimes(3);
});

it("rejects a subject that does not match current Gentle authority", async () => {
  const mismatched = status();
  mismatched["authority"] = { lineage_id: "review-other", revision: hash("1") };
  const reviewer = vi.fn();
  await expect(runGentleReviewHost({ candidate: "one", executable, lineage }, {
    inspect: async () => ({ checkout: candidate }), process: async () => json(mismatched), reviewer,
  })).rejects.toThrow("subject does not match");
  expect(reviewer).not.toHaveBeenCalled();
});
