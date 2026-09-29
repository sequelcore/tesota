import { expect, it } from "vitest";
import { allowedByRules, canSaveRule, commandParts, offeredRule, programName } from "../src/command-rules.js";

/**
 * Rules for commands on this computer (decision 049): a command is read only
 * in a plain form, a rule may never start with a program that runs whatever
 * it is given, and every part of a command must be covered.
 */

it("reads plain commands as parts of words, quotes included", () => {
  expect(commandParts("gh pr list --limit 5")).toEqual([["gh", "pr", "list", "--limit", "5"]]);
  expect(commandParts("git status && gh pr list|wc -l; echo done")).toEqual([["git", "status"], ["gh", "pr", "list"], ["wc", "-l"],
    ["echo", "done"]]);
  expect(commandParts("gh pr create --title 'Fix it; now' --body \"all | good\"")).toEqual([["gh", "pr", "create", "--title", "Fix it; now",
    "--body", "all | good"]]);
  expect(commandParts("git log a'b'\"c\"")).toEqual([["git", "log", "abc"]]);
  expect(commandParts("git -c core.pager=cat log")).toEqual([["git", "-c", "core.pager=cat", "log"]]);
});

it("refuses to read anything a shell would expand, redirect or hide", () => {
  for (const command of ["gh pr list > out.txt", "gh pr list < in", "echo $HOME", "echo \"$HOME\"", "echo `id`", "echo $(id)",
    "ls *.ts", "ls ~", "FOO=1 gh pr list", "gh pr list &", "gh pr list\nrm -rf /", "echo a\\;b", "(gh pr list)", "echo 'open",
    "gh pr list &&", "; gh pr list", "gh pr list # note", "echo {a,b}", "echo \"a\\\"b\"", "echo \"!1\"", "gh pr list ; ; ls", ""]) {
    expect(commandParts(command), command).toBeUndefined();
  }
});

it("never saves a rule of one word, or one that starts with a shell, interpreter, runner, wrapper or deleting command", () => {
  expect(canSaveRule(["gh", "pr"])).toBe(true);
  expect(canSaveRule(["npm", "run", "test"])).toBe(true);
  expect(canSaveRule(["gh"])).toBe(false);
  for (const program of ["bash", "python3", "python3.12.exe", "C:\\Python\\python.exe", "/usr/bin/node", "npx", "sudo", "env", "xargs",
    "ssh", "rm", "RM", "find", "pwsh", "cmd.exe"]) {
    expect(canSaveRule([program, "x"]), program).toBe(false);
  }
  expect(programName("C:\\Tools\\Python312\\python3.12.exe")).toBe("python");
});

it("lets a command run without asking only when some saved rule begins every part", () => {
  const rules = [["gh", "pr"], ["git", "status"]];
  expect(allowedByRules("gh pr list", rules)).toBe(true);
  expect(allowedByRules("gh pr view 12 && git status --short", rules)).toBe(true);
  expect(allowedByRules("gh pr list | sh", rules)).toBe(false);
  expect(allowedByRules("gh prune", rules)).toBe(false);
  expect(allowedByRules("gh", rules)).toBe(false);
  expect(allowedByRules("gh pr list > out", rules)).toBe(false);
  expect(allowedByRules("gh pr list", [])).toBe(false);
});

it("offers the agent's rule when it begins the command and may be saved, and otherwise the command's leading names", () => {
  expect(offeredRule("gh pr view 12 --web", ["gh", "pr"])).toEqual(["gh", "pr"]);
  expect(offeredRule("gh pr view 12 --web", ["gh", "repo"])).toEqual(["gh", "pr", "view"]);
  expect(offeredRule("terraform plan -out plan.bin")).toEqual(["terraform", "plan"]);
  expect(offeredRule("aws s3 ls s3://bucket")).toEqual(["aws", "s3", "ls"]);
  expect(offeredRule("ls -la")).toBeUndefined();
  expect(offeredRule("python -m pytest", ["python", "-m"])).toBeUndefined();
  expect(offeredRule("gh pr list > out")).toBeUndefined();
});
