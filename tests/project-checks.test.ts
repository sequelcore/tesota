import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { declarationLimits, readDeclaredChecks } from "../src/project-checks.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function declaration(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-declarations-"));
  roots.push(root);
  mkdirSync(join(root, ".tesota"));
  writeFileSync(join(root, ".tesota/checks.json"), JSON.stringify(value));
  return root;
}

it("reads bounded commands without granting them trust, keeping duplicate invocations distinct (#753)", () => {
  const root = declaration({ checks: [
    { command: "python -m unittest", folder: "", timeoutSeconds: 1, report: "reports/unit.xml" },
    { command: "python -m unittest", folder: "", timeoutSeconds: 900, report: "reports/integration.xml" },
  ] });
  expect(readDeclaredChecks(root)).toMatchObject({ status: "read", hash: expect.stringMatching(/^[a-f0-9]{64}$/u), checks: [
    { command: "python -m unittest", folder: "", timeoutMs: 1000, reports: ["reports/unit.xml"] },
    { command: "python -m unittest", folder: "", timeoutMs: 900000, reports: ["reports/integration.xml"] },
  ] });
});

it.each([
  { checks: [] }, { checks: Array.from({ length: 33 }, () => ({ command: "check", folder: "" })) },
  { checks: [{ command: "", folder: "" }] }, { checks: [{ command: "x".repeat(declarationLimits.commandBytes + 1), folder: "" }] },
  { checks: [{ command: "check", folder: "../other" }] }, { checks: [{ command: "check", folder: ".git" }] },
  { checks: [{ command: "check", folder: "C:/outside" }] }, { checks: [{ command: "check", folder: "/outside" }] },
  { checks: [{ command: "check", folder: ".git." }] }, { checks: [{ command: "check", folder: "tooling " }] },
  { checks: [{ command: "check", folder: "", report: "result.xml:stream.xml" }] },
  { checks: [{ command: "check", folder: "", timeoutSeconds: 0 }] }, { checks: [{ command: "check", folder: "", timeoutSeconds: 901 }] },
  { checks: [{ command: "check", folder: "", timeoutSeconds: 1.5 }] },
  { checks: [{ command: "check", folder: "", report: "../report.xml" }] }, { checks: [{ command: "check", folder: "", report: "report.json" }] },
  { checks: [{ command: "check", folder: "", typo: true }] }, { checks: [{ command: "check", folder: "" }], typo: true },
])("refuses malformed or escaping declarations: %j (#753)", (value) => {
  expect(readDeclaredChecks(declaration(value)).status).toBe("invalid");
});

it("refuses a linked or oversized declaration file (#753)", () => {
  const root = declaration({ checks: [{ command: "check", folder: "" }] });
  const target = join(root, "saved.json");
  writeFileSync(target, '{"checks":[{"command":"check","folder":""}]}');
  rmSync(join(root, ".tesota/checks.json"));
  symlinkSync(target, join(root, ".tesota/checks.json"), "file");
  expect(readDeclaredChecks(root).status).toBe("invalid");
  rmSync(join(root, ".tesota/checks.json"));
  symlinkSync(join(root, "missing.json"), join(root, ".tesota/checks.json"), "file");
  expect(readDeclaredChecks(root).status).toBe("invalid");
  rmSync(join(root, ".tesota/checks.json"));
  writeFileSync(join(root, ".tesota/checks.json"), " ".repeat(declarationLimits.bytes + 1));
  expect(readDeclaredChecks(root).status).toBe("invalid");
});
