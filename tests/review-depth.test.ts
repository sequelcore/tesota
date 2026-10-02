import { expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { parseSensitivePaths, reviewDepth } from "../src/review-depth.js";
import type { CheckResult } from "../src/workspace-checks.js";

const passed: CheckResult = { verifier: "command", command: "npm test", claim: "exits 0", limits: "its tests", tree: "t".repeat(40),
  environment: "host", guarantees: hostProvider.guarantees, outcome: "passed", exitCode: 0, durationMs: 1, output: "" };
const diff = (path: string, ...lines: string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@", ...lines].join("\n");

it("reviews an ordinary change at standard depth, including one that only adds tests", () => {
  expect(reviewDepth({ changes: [{ status: "modified", path: "src/price.js" }, { status: "modified", path: "src/price.test.js" }],
    diff: [diff("src/price.js", "-  return amount;", "+  return amount * 0.9;"),
      diff("src/price.test.js", " test(\"small\")", "+test(\"large\")")].join("\n") },
  [{ path: "src/price.test.js", status: "modified", kind: "test" }], [passed])).toEqual({ depth: "standard", reasons: [] });
});

it("goes deep for sensitive files, changed tests, other flags, failed verifiers and large changes, saying why", () => {
  const decision = reviewDepth({
    changes: [{ status: "modified", path: "src/auth/posts.js" }, { status: "modified", path: "src/tax.test.js" },
      { status: "modified", path: ".oxlintrc.json" }, { status: "added", path: "Dockerfile" }],
    diff: [diff("src/tax.test.js", "-  assert.equal(tax(100), 16);", "+  assert.equal(tax(100), 15);"),
      diff("src/big.js", ...Array.from({ length: 401 }, (_, index) => `+line ${index}`))].join("\n") },
  [{ path: "src/tax.test.js", status: "modified", kind: "test" }, { path: ".oxlintrc.json", status: "modified", kind: "check configuration" }],
  [passed, { ...passed, command: "oxlint src/auth/posts.js", outcome: "failed" }]);
  expect(decision).toEqual({ depth: "deep", reasons: [
    "touches security- or authority-sensitive files (src/auth/posts.js, Dockerfile)",
    "changes existing tests (src/tax.test.js)",
    "changes what checks it (check configuration: .oxlintrc.json)",
    "a verifier did not pass (oxlint src/auth/posts.js)",
    "changes 403 lines",
  ] });
});

it("does not mistake ordinary names for sensitive ones", () => {
  expect(reviewDepth({ changes: [{ status: "modified", path: "src/authors.js" }, { status: "modified", path: "src/tokenizer.js" },
    { status: "modified", path: "src/accessibility.js" }], diff: "" }, [], []).depth).toBe("standard");
});

it("reads token, session and access as sensitive only as a whole folder or file name", () => {
  const depthOf = (path: string): string => reviewDepth({ changes: [{ status: "modified", path }], diff: "" }, [], []).depth;
  expect(["src/token-usage.ts", "src/session-title.ts", "src/integrations/session-namer.ts", "src/access-log.ts"].map(depthOf))
    .toEqual(["standard", "standard", "standard", "standard"]);
  expect(["src/tokens.ts", "src/session/store.ts", "lib/access/grant.go", "src/oauth-callback.ts"].map(depthOf))
    .toEqual(["deep", "deep", "deep", "deep"]);
});

it("leaves a test file to the changed-tests reason, however it is named", () => {
  const test = "tests/auth.test.ts";
  expect(reviewDepth({ changes: [{ status: "added", path: test }], diff: diff(test, "+it(\"signs in\")") },
    [{ path: test, status: "added", kind: "test" }], [])).toEqual({ depth: "standard", reasons: [] });
});

it("goes deep for any path the repository declares sensitive, a test included, and names it apart", () => {
  const declared = parseSensitivePaths("# authority\n\n./src/session-decisions.ts\nsrc/*sandbox*.ts\ntests/security/**\n");
  expect(declared).toEqual(["src/session-decisions.ts", "src/*sandbox*.ts", "tests/security/**"]);
  const decision = reviewDepth({ changes: [{ status: "modified", path: "src/session-decisions.ts" },
    { status: "modified", path: "src/bubblewrap-sandbox.ts" }, { status: "added", path: "tests/security/escape.test.ts" },
    { status: "modified", path: "src/auth.ts" }, { status: "modified", path: "src/price.ts" }], diff: "" },
  [{ path: "tests/security/escape.test.ts", status: "added", kind: "test" }], [], declared);
  expect(decision.reasons).toEqual([
    "touches paths this repository marks sensitive (src/session-decisions.ts, src/bubblewrap-sandbox.ts, tests/security/escape.test.ts)",
    "touches security- or authority-sensitive files (src/auth.ts)",
  ]);
  expect(parseSensitivePaths(undefined)).toEqual([]);
});
