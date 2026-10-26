import { expect, it } from "vitest";
import { markBlooms } from "../src/verification/mark-bloom-rule.js";
import { receiptStanding } from "../src/receipt.js";
import { WelcomeHeader } from "../src/welcome-header.js";
import { shellTheme } from "../src/theme.js";
import { renderMark } from "../src/welcome-mark.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Receipt } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";

it.each(["verified", "incomplete", "unverified", "unchanged", "failed", "none"] as const)("blooms iff standing is verified: %s", (standing) => {
  expect(markBlooms(standing)).toBe(standing === "verified");
});

it("reads the receipt standing in the header and resets on the next request", () => {
  // Passing proof, no gaps or decisions: unambiguously verified, even after #668.
  const receipt: Receipt = { ...emptyReceipt, proofs: [{ path: "src/range.ts", verdict: "proved", evidence: {
    verifier: "lemmascript", claim: "", limits: "", outcome: "passed", output: "Dafny program verifier finished with 1 verified, 0 errors",
    durationMs: 2, files: ["src/range.ts"], contentHash: "h" } }] };
  expect(receiptStanding(receipt)).toBe("verified");
  let standing: ReturnType<typeof receiptStanding> | "none" = "none";
  const view = new WelcomeHeader("shop", shellTheme("dark", "truecolor"), {
    requestRender: () => undefined, terminalRows: () => 40, stageShare: 0.5,
    standing: () => standing, now: () => 0, setTimer: () => () => undefined,
  });
  const mark = () => view.render(100).map((row) => stripTerminalSequences(row).slice(0, 11));
  const expected = (bloom: boolean) => renderMark(bloom ? "small-bloom" : "small").map((row) => row.map((cell) => cell.glyph).join(""));
  expect(mark()).toEqual(expected(false));
  standing = receiptStanding(receipt); expect(mark()).toEqual(expected(true));
  for (const other of ["incomplete", "unverified", "unchanged", "failed", "none"] as const) { standing = other; expect(mark()).toEqual(expected(false)); }
});
