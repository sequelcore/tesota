import { expect, it } from "vitest";
import { deniesByDefault } from "../src/docker-sandboxes-environment.js";

// Answers of `sbx policy check network example.com` (sbx v0.45.1); the denied one as observed on 2026-09-26.
const denied = "Denied: example.com:443\nGovernance: Local policy only\nContext: global\nReason: no matching allow rule (default deny)\n";

it("recognizes a global policy that denies what no rule allows, by what it decides rather than how it is listed", () => {
  expect(deniesByDefault({ status: 1, stdout: denied, stderr: "" })).toBe(true);
  expect(deniesByDefault({ status: 0, stdout: "Allowed: example.com:443\nContext: global\nReason: default allow\n", stderr: "" }))
    .toBe(false);
  // Denied by a rule that names the host is not a default: other destinations may still be allowed.
  expect(deniesByDefault({ status: 1, stdout: "Denied: example.com:443\nReason: matched deny rule\n", stderr: "" })).toBe(false);
  expect(deniesByDefault({ status: 1, stdout: "", stderr: "error: global network policy is not initialized" })).toBe(false);
  expect(deniesByDefault({ status: null, stdout: "", stderr: "spawn sbx ENOENT" })).toBe(false);
});
