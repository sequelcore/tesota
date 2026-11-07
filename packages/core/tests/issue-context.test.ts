import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueRead, issueReferences } from "../src/issue-context.ts";
import { shellTool, platformShell } from "../src/tools/shell.ts";
import { toolResult } from "../src/loop.ts";
import { issueCli } from "./issue-cli.ts";
import { referenceDigest, referenceType } from "../../../src/request-references.ts";

test("issue identity follows GH_REPO and the CLI's selected default instead of assuming origin (#637)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-issue-default-"));
  const env = await issueCli(cwd, "body: requirement");
  expect((await issueRead("gh issue view 637", cwd, new AbortController().signal, { ...env, GH_REPO: "other/project" }))?.source)
    .toBe("https://github.com/other/project/issues/637");
  expect((await issueRead("gh issue view 637", cwd, new AbortController().signal, { ...env, FIXTURE_GH_REPOSITORY: "github.com/upstream/project" }))?.source)
    .toBe("https://github.com/upstream/project/issues/637");
});

test("a child naming its inherited issue does not invent a contradictory missing-reference record (#637)", () => {
  const reference = { status: "read" as const, source: "https://github.com/fixture/project/issues/637", text: "requirement",
    callId: "parent-read", digest: referenceDigest("requirement") };
  expect(issueReferences([{ type: "custom", run: 1, customType: referenceType, data: [reference] }], 1,
    ["Review fixture/project#637."])).toEqual([reference]);
});

test("issue reads retain repository identity and refuse partial JSON, templates, scripts and foreign unqualified numbers (#637)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-issue-context-"));
  const env = await issueCli(cwd, "title: Full issue\nbody: Original text");
  const signal = new AbortController().signal;
  for (const command of ["gh issue view 637 --json title", "gh issue view 637 --template body", "gh issue view 637 | cat", "gh issue view 637; echo replacement"]) {
    expect(await issueRead(command, cwd, signal, env)).toBeUndefined();
  }
  const tool = shellTool(cwd, platformShell(), () => cwd, env);
  const output = await tool.execute({ command: "gh issue view 637 --repo other/project" }, signal, "read");
  const entries = [{ type: "tool_result" as const, run: 1, message: toolResult({ id: "read", name: tool.name }, output, 0) }];
  expect(issueReferences(entries, 1, ["Fix #637."])).toMatchObject([{ status: "unavailable" }]);
  expect(issueReferences(entries, 1, ["Fix other/project#637."])).toMatchObject([{ status: "read", source: "https://github.com/other/project/issues/637" }]);
  const json = await tool.execute({ command: "gh issue view 637 --json body,title" }, signal, "json");
  expect(issueReferences([{ type: "tool_result", run: 1, message: toolResult({ id: "json", name: tool.name }, json, 0) }], 1,
    ["Fix project#637."])).toMatchObject([{ status: "unavailable" }]);
});

test("truncated shell output is an explicit issue-context gap and never a partial requirement (#637)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-issue-truncated-"));
  const env = await issueCli(cwd, "body: " + "large line\n".repeat(10_000));
  const spool = join(cwd, "spool"); mkdirSync(spool);
  const tool = shellTool(cwd, platformShell(), () => spool, env);
  const output = await tool.execute({ command: "gh issue view 637" }, new AbortController().signal, "read");
  const context = issueReferences([{ type: "tool_result", run: 1, message: toolResult({ id: "read", name: tool.name }, output, 0) }], 1,
    ["Fix project#637."]);
  expect(context).toMatchObject([{ status: "unavailable", reason: expect.stringContaining("complete text") }]);
});
