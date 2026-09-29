import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRecoverCommand } from "../src/recover-command.js";
import { Workspace } from "../src/workspace.js";
import { applyWorkspace, ApplyConflictError, ApplyRecoveryError, ApplyRolledBackError, recoverApplication,
  unfinishedApplications } from "../src/workspace-apply.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(link).mockImplementation(actual.link);
  vi.mocked(rename).mockImplementation(actual.rename);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false",
    "-c", "user.name=Tesota test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Test Git failed");
  return result.stdout;
}

/** A repository whose workspace deletes `src/old.ts`, modifies `src/price.ts` and adds `src/tax.ts`, in that order. */
async function fixture(): Promise<{ source: string; workspace: Workspace; applications: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-apply-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  git(source, ["init", "--quiet"]);
  await writeFile(join(source, "src/price.ts"), "export const price = 1;\n");
  await writeFile(join(source, "src/old.ts"), "export const old = true;\n");
  await writeFile(join(source, "notes.md"), "notes\n");
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  const workspace = await Workspace.create(source, join(root, "workspaces"), { sourcesRoot: join(dirname(join(root, "workspaces")), "sources") });
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  await writeFile(join(workspace.checkout, "src/tax.ts"), "export const tax = 0.2;\n");
  await rm(join(workspace.checkout, "src/old.ts"));
  return { source, workspace, applications: join(root, "applications") };
}

const read = async (path: string): Promise<string> => readFile(path, "utf8");
const ending = (path: unknown, name: string): boolean => String(path).endsWith(join("src", name));
const failure = (code: string): Error => Object.assign(new Error(code), { code });

async function expectOriginal(source: string): Promise<void> {
  expect(await read(join(source, "src/price.ts"))).toBe("export const price = 1;\n");
  expect(await read(join(source, "src/old.ts"))).toBe("export const old = true;\n");
}

async function journalStates(applications: string): Promise<string[]> {
  const [id] = await readdir(applications);
  const text = await read(join(applications, id ?? "", "journal.jsonl"));
  return text.split("\n").filter((line) => line.length > 0).flatMap((line) => {
    const entry = JSON.parse(line) as { state?: string };
    return entry.state === undefined ? [] : [entry.state];
  });
}

async function leftovers(source: string): Promise<string[]> {
  return (await readdir(join(source, "src"))).filter((name) => name.startsWith(".tesota-"));
}

it("keeps every original and reviewed file before writing, and journals the application", async () => {
  const { source, workspace, applications } = await fixture();
  const snapshot = workspace.snapshot();
  await expect(applyWorkspace(workspace, snapshot)).resolves.toEqual({ changes: snapshot.changes, alsoChanged: [] });
  const [id] = await readdir(applications);
  const stored = join(applications, id ?? "");
  const manifest = JSON.parse(await read(join(stored, "application.json"))) as { paths: { path: string }[] };
  expect(manifest.paths.map((path) => path.path)).toEqual(["src/old.ts", "src/price.ts", "src/tax.ts"]);
  expect(await read(join(stored, "before", "0"))).toBe("export const old = true;\n");
  expect(await read(join(stored, "before", "1"))).toBe("export const price = 1;\n");
  expect(await read(join(stored, "after", "2"))).toBe("export const tax = 0.2;\n");
  expect(await journalStates(applications)).toEqual(["prepared", "applied"]);
  expect(await leftovers(source)).toEqual([]);
  await expect(workspace.update()).resolves.toEqual({ status: "current" });
});

it.each([
  ["an edit to a file the result does not touch", "notes.md"],
  ["a new file", "draft.md"],
])("refuses after %s in the repository, and writes nothing", async (_, path) => {
  const { source, workspace, applications } = await fixture();
  const snapshot = workspace.snapshot();
  await writeFile(join(source, path), "the operator's edit\n");
  const attempt = applyWorkspace(workspace, snapshot);
  await expect(attempt).rejects.toBeInstanceOf(ApplyConflictError);
  await expect(attempt).rejects.toMatchObject({ paths: [path], message: expect.stringContaining("checked again") });
  await expectOriginal(source);
  expect(existsSync(join(source, "src/tax.ts"))).toBe(false);
  expect(existsSync(applications)).toBe(false);
  expect(workspace.base).toBe(snapshot.base);
  await expect(workspace.update()).resolves.toMatchObject({ status: "updated" });
  await applyWorkspace(workspace, workspace.snapshot());
  expect(await read(join(source, path))).toBe("the operator's edit\n");
  expect(await read(join(source, "src/tax.ts"))).toBe("export const tax = 0.2;\n");
});

it("never replaces a file that appears at an added path, and undoes what it wrote", async () => {
  const { source, workspace, applications } = await fixture();
  vi.mocked(link).mockImplementation(async (from, to) => {
    if (ending(to, "tax.ts")) {
      await writeFile(to, "someone else's\n");
      throw failure("EEXIST");
    }
    await actual.link(from, to);
  });
  const attempt = applyWorkspace(workspace, workspace.snapshot());
  await expect(attempt).rejects.toBeInstanceOf(ApplyRolledBackError);
  await expect(attempt).rejects.toMatchObject({ paths: ["src/tax.ts"] });
  await expectOriginal(source);
  expect(await read(join(source, "src/tax.ts"))).toBe("someone else's\n");
  expect(await journalStates(applications)).toEqual(["prepared", "rolled_back"]);
  expect(await leftovers(source)).toEqual([]);
});

it("leaves a file someone else created with the reviewed content at an added path, and undoes only its own writes", async () => {
  const { source, workspace, applications } = await fixture();
  vi.mocked(link).mockImplementation(async (from, to) => {
    if (ending(to, "tax.ts")) {
      await writeFile(to, "export const tax = 0.2;\n");
      throw failure("EEXIST");
    }
    await actual.link(from, to);
  });
  const attempt = applyWorkspace(workspace, workspace.snapshot());
  await expect(attempt).rejects.toBeInstanceOf(ApplyRolledBackError);
  await expect(attempt).rejects.toMatchObject({ paths: ["src/tax.ts"] });
  await expectOriginal(source);
  expect(await read(join(source, "src/tax.ts"))).toBe("export const tax = 0.2;\n");
  expect(await journalStates(applications)).toEqual(["prepared", "rolled_back"]);
});

it("stops at a file another program holds open, and undoes what it wrote", async () => {
  const { source, workspace } = await fixture();
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (ending(from, "price.ts")) throw failure("EBUSY");
    await actual.rename(from, to);
  });
  await expect(applyWorkspace(workspace, workspace.snapshot())).rejects.toMatchObject({ paths: ["src/price.ts"] });
  await expectOriginal(source);
  expect(existsSync(join(source, "src/tax.ts"))).toBe(false);
});

it("puts back an edit made while applying, untouched, and undoes what it wrote", async () => {
  const { source, workspace } = await fixture();
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (ending(from, "price.ts") && String(to).endsWith(".hold")) await actual.writeFile(from, "the operator's edit\n");
    await actual.rename(from, to);
  });
  await expect(applyWorkspace(workspace, workspace.snapshot())).rejects.toBeInstanceOf(ApplyRolledBackError);
  expect(await read(join(source, "src/price.ts"))).toBe("the operator's edit\n");
  expect(await read(join(source, "src/old.ts"))).toBe("export const old = true;\n");
  expect(await leftovers(source)).toEqual([]);
});

it("works on a volume without hard links, still never replacing a file", async () => {
  const { source, workspace } = await fixture();
  vi.mocked(link).mockRejectedValue(failure("EPERM"));
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (ending(from, "price.ts") && String(to).endsWith(".hold")) await actual.writeFile(from, "the operator's edit\n");
    await actual.rename(from, to);
  });
  await expect(applyWorkspace(workspace, workspace.snapshot())).rejects.toBeInstanceOf(ApplyRolledBackError);
  expect(await read(join(source, "src/price.ts"))).toBe("the operator's edit\n");
  expect(await read(join(source, "src/old.ts"))).toBe("export const old = true;\n");
  vi.mocked(rename).mockImplementation(actual.rename);
  await writeFile(join(source, "src/price.ts"), "export const price = 1;\n");
  await applyWorkspace(workspace, workspace.snapshot());
  expect(await read(join(source, "src/price.ts"))).toBe("export const price = 2;\n");
  expect(await read(join(source, "src/tax.ts"))).toBe("export const tax = 0.2;\n");
  expect(await leftovers(source)).toEqual([]);
});

it("marks a partial effect it cannot undo as recovery required, and blocks later applications until it is undone", async () => {
  const { source, workspace, applications } = await fixture();
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (ending(from, "price.ts")) throw failure("EBUSY");
    await actual.rename(from, to);
  });
  vi.mocked(link).mockImplementation(async (from, to) => {
    if (ending(to, "old.ts")) throw failure("EACCES");
    await actual.link(from, to);
  });
  const snapshot = workspace.snapshot();
  const attempt = applyWorkspace(workspace, snapshot);
  await expect(attempt).rejects.toBeInstanceOf(ApplyRecoveryError);
  await expect(attempt).rejects.toMatchObject({ paths: [{ path: "src/old.ts", state: "applied" },
    { path: "src/price.ts", state: "original" }, { path: "src/tax.ts", state: "original" }] });
  expect(await journalStates(applications)).toEqual(["prepared", "recovery_required"]);
  vi.mocked(link).mockImplementation(actual.link);
  vi.mocked(rename).mockImplementation(actual.rename);
  await expect(applyWorkspace(workspace, snapshot)).rejects.toThrow("did not finish; run tesota recover");

  const lines: string[] = [];
  await expect(runRecoverCommand([], source, (text) => { lines.push(text); }, applications)).resolves.toBe(1);
  expect(lines.join("")).toContain("    src/old.ts: applied\n    src/price.ts: original\n");
  await expect(runRecoverCommand(["undo"], source, (text) => { lines.push(text); }, applications)).resolves.toBe(0);
  await expectOriginal(source);
  await expect(unfinishedApplications(source, applications)).resolves.toEqual([]);
  await applyWorkspace(workspace, snapshot);
  expect(await read(join(source, "src/tax.ts"))).toBe("export const tax = 0.2;\n");
});

it("writes nothing when a recorded path leads outside the repository by the time it is recovered", async () => {
  const { source, workspace, applications } = await fixture();
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (ending(from, "price.ts")) throw failure("EBUSY");
    await actual.rename(from, to);
  });
  vi.mocked(link).mockImplementation(async (from, to) => {
    if (ending(to, "old.ts")) throw failure("EACCES");
    await actual.link(from, to);
  });
  await expect(applyWorkspace(workspace, workspace.snapshot())).rejects.toBeInstanceOf(ApplyRecoveryError);
  vi.mocked(link).mockImplementation(actual.link);
  vi.mocked(rename).mockImplementation(actual.rename);
  const outside = join(source, "..", "outside");
  await actual.rename(join(source, "src"), outside);
  await symlink(outside, join(source, "src"), "junction");
  const [unfinished] = await unfinishedApplications(source, applications);
  const attempt = recoverApplication(source, unfinished?.id ?? "", "undo", applications);
  await expect(attempt).rejects.toBeInstanceOf(ApplyConflictError);
  await expect(attempt).rejects.toMatchObject({ paths: ["src/old.ts", "src/price.ts", "src/tax.ts"] });
  expect((await readdir(outside)).toSorted()).toEqual(["price.ts"]);
  await expect(unfinishedApplications(source, applications)).resolves.toHaveLength(1);
  const lines: string[] = [];
  await expect(runRecoverCommand(["undo"], source, (text) => { lines.push(text); }, applications)).resolves.toBe(1);
  expect(lines.join("")).toContain("lead outside the repository");
  expect((await readdir(outside)).toSorted()).toEqual(["price.ts"]);
});

it("undoes an install a crash interrupted before it was journaled, as its own file", async () => {
  const { source, workspace, applications } = await fixture();
  let reached: () => void = () => {};
  const crashed = new Promise<void>((resolve) => { reached = resolve; });
  vi.mocked(link).mockImplementation(async (from, to) => {
    await actual.link(from, to);
    if (ending(to, "tax.ts")) { reached(); await new Promise(() => {}); }
  });
  void applyWorkspace(workspace, workspace.snapshot());
  await crashed;
  vi.mocked(link).mockImplementation(actual.link);
  const [unfinished] = await unfinishedApplications(source, applications);
  await expect(recoverApplication(source, unfinished?.id ?? "", "undo", applications)).resolves.toMatchObject({ settled: true });
  await expectOriginal(source);
  expect(existsSync(join(source, "src/tax.ts"))).toBe(false);
  expect(await leftovers(source)).toEqual([]);
});

it("keeps a file someone else created with the reviewed content while a crash interrupted its install", async () => {
  const { source, workspace, applications } = await fixture();
  let reached: () => void = () => {};
  const crashed = new Promise<void>((resolve) => { reached = resolve; });
  vi.mocked(link).mockImplementation(async (from, to) => {
    if (ending(to, "tax.ts")) {
      await writeFile(to, "export const tax = 0.2;\n");
      reached();
      await new Promise(() => {});
    }
    await actual.link(from, to);
  });
  void applyWorkspace(workspace, workspace.snapshot());
  await crashed;
  vi.mocked(link).mockImplementation(actual.link);
  const [unfinished] = await unfinishedApplications(source, applications);
  await expect(recoverApplication(source, unfinished?.id ?? "", "undo", applications)).resolves.toMatchObject({ settled: false });
  await expectOriginal(source);
  expect(await read(join(source, "src/tax.ts"))).toBe("export const tax = 0.2;\n");
  await expect(unfinishedApplications(source, applications)).resolves.toHaveLength(1);
});

it("finishes an application a crash interrupted, putting back the file it had moved aside", async () => {
  const { source, workspace, applications } = await fixture();
  let reached: () => void = () => {};
  const crashed = new Promise<void>((resolve) => { reached = resolve; });
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    if (ending(from, "price.ts")) { reached(); await new Promise(() => {}); }
  });
  void applyWorkspace(workspace, workspace.snapshot());
  await crashed;
  vi.mocked(rename).mockImplementation(actual.rename);
  const [unfinished] = await unfinishedApplications(source, applications);
  expect(unfinished?.paths).toEqual([{ path: "src/old.ts", state: "applied" }, { path: "src/price.ts", state: "changed" },
    { path: "src/tax.ts", state: "original" }]);
  await expect(recoverApplication(source, unfinished?.id ?? "", "finish", applications)).resolves.toMatchObject({ settled: true });
  expect(await read(join(source, "src/price.ts"))).toBe("export const price = 2;\n");
  expect(await read(join(source, "src/tax.ts"))).toBe("export const tax = 0.2;\n");
  expect(existsSync(join(source, "src/old.ts"))).toBe(false);
  expect(await leftovers(source)).toEqual([]);
  await expect(unfinishedApplications(source, applications)).resolves.toEqual([]);
});

it("names files outside the result that changed while it was applied", async () => {
  const { source, workspace } = await fixture();
  vi.mocked(link).mockImplementationOnce(async (from, to) => {
    await writeFile(join(source, "notes.md"), "edited meanwhile\n");
    await actual.link(from, to);
  });
  await expect(applyWorkspace(workspace, workspace.snapshot())).resolves.toMatchObject({ alsoChanged: ["notes.md"] });
  await expect(workspace.update()).resolves.toMatchObject({ status: "updated" });
});

it("removes finished applications after the retention period and keeps unfinished ones", async () => {
  const { workspace, applications } = await fixture();
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const stored = async (id: string, states: readonly string[]): Promise<void> => {
    await mkdir(join(applications, id), { recursive: true });
    await writeFile(join(applications, id, "application.json"), JSON.stringify({ id, source: "/elsewhere", base: "",
      tree: "", startedAt: old, paths: [], directories: [] }));
    await writeFile(join(applications, id, "journal.jsonl"), states.map((state) => `${JSON.stringify({ state })}\n`).join(""));
  };
  await stored("finished", ["prepared", "applied"]);
  await stored("unfinished", ["prepared"]);
  await applyWorkspace(workspace, workspace.snapshot());
  const kept = await readdir(applications);
  expect(kept).not.toContain("finished");
  expect(kept).toContain("unfinished");
});
