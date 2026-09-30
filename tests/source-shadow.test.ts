import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, expect, it } from "vitest";
import { describeFolder, folderQuestion, isGitRepository, largeUntrackedFiles, largeUntrackedWarning, openShadow, shadowDirectory,
  sourceRoot } from "../src/source-shadow.js";
import { Workspace } from "../src/workspace.js";
import { applyWorkspace } from "../src/workspace-apply.js";

/**
 * One shadow repository per source: a plain folder and a Git repository alike
 * are recorded in a bare repository beside them whose work tree is the
 * source, never inside it and never the operator's own `.git`, so the copy,
 * snapshots bound to a tree and the guarded apply work the same for both.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; folder: string; sources: string; workspaces: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-folder-"));
  roots.push(root);
  const folder = join(root, "Presupuesto 2026");
  await mkdir(join(folder, "Eventos"), { recursive: true });
  await writeFile(join(folder, "Eventos", "carrera.csv"), "concepto,costo\nplayeras,1200\nagua,300\n");
  await writeFile(join(folder, "resumen.txt"), "Total: 1500\n");
  // Binary content, as in an Excel or PDF file, and the lock files Office and LibreOffice leave while one is open.
  await writeFile(join(folder, "presupuesto.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x00]));
  await writeFile(join(folder, "~$presupuesto.xlsx"), "lock");
  await writeFile(join(folder, ".~lock.resumen.odt#"), "lock");
  return { root, folder, sources: join(root, "sources"), workspaces: join(root, "workspaces") };
}

it("tells a folder from a repository, and never takes a home directory that is a repository for the project", async () => {
  const { root, folder } = await fixture();
  expect(isGitRepository(process.cwd())).toBe(true);
  // A home directory kept in Git, as many keep their dotfiles: a folder inside it is still a folder, not the whole home.
  const git = (args: string[]): void => { spawnSync("git", ["-C", root, ...args], { windowsHide: true }); };
  git(["init", "--quiet"]);
  expect(isGitRepository(folder, root)).toBe(false);
  expect(isGitRepository(folder, join(root, "elsewhere"))).toBe(true);
});

it("works on a folder through a private copy, and applies back without ever putting Git inside it", async () => {
  const { folder, sources, workspaces } = await fixture();
  // CI keeps temporary files inside the repository checkout, so the test says what the source is.
  const workspace = await Workspace.create(folder, workspaces, { sourcesRoot: sources, kind: "folder" });
  expect(existsSync(join(folder, ".git"))).toBe(false);
  expect(await readdir(sources)).toHaveLength(1);
  // Office's lock files are not the person's work, so the copy leaves them out.
  expect(existsSync(join(workspace.checkout, "presupuesto.xlsx"))).toBe(true);
  expect(existsSync(join(workspace.checkout, "~$presupuesto.xlsx"))).toBe(false);
  expect(existsSync(join(workspace.checkout, ".~lock.resumen.odt#"))).toBe(false);
  await writeFile(join(workspace.checkout, "resumen.txt"), "Total: 1500\nEvento más caro: carrera\n");
  await writeFile(join(workspace.checkout, "Eventos", "natacion.csv"), "concepto,costo\nalberca,5000\n");
  const snapshot = workspace.snapshot();
  expect(snapshot.changes).toEqual([{ status: "added", path: "Eventos/natacion.csv" }, { status: "modified", path: "resumen.txt" }]);
  await applyWorkspace(workspace, snapshot);
  expect(await readFile(join(folder, "resumen.txt"), "utf8")).toBe("Total: 1500\nEvento más caro: carrera\n");
  expect(await readFile(join(folder, "Eventos", "natacion.csv"), "utf8")).toBe("concepto,costo\nalberca,5000\n");
  expect(existsSync(join(folder, ".git"))).toBe(false);
});

it("brings the person's own later edits into the copy, large files included, and reopens a saved workspace", async () => {
  const { folder, sources, workspaces } = await fixture();
  // CI keeps temporary files inside the repository checkout, so the test says what the source is.
  const workspace = await Workspace.create(folder, workspaces, { sourcesRoot: sources, kind: "folder" });
  // A scanned PDF or a large spreadsheet is often past Git's default output buffers.
  const large = Buffer.alloc(12 * 1024 * 1024, 7);
  await writeFile(join(folder, "escaneo.pdf"), large);
  await writeFile(join(folder, "resumen.txt"), "Total: 1800\n");
  expect(await workspace.update()).toMatchObject({ status: "updated" });
  expect(await readFile(join(workspace.checkout, "resumen.txt"), "utf8")).toBe("Total: 1800\n");
  expect((await readFile(join(workspace.checkout, "escaneo.pdf"))).equals(large)).toBe(true);
  expect(workspace.snapshot().changes).toEqual([]);
  const reopened = await Workspace.open(workspace.directory);
  expect(reopened.source).toBe(workspace.source);
  expect(await reopened.update()).toMatchObject({ status: "current" });
});

it("describes a folder before Tesota works on it, and refuses the home directory and a drive or file system root", async () => {
  const { folder, sources } = await fixture();
  expect(await describeFolder(folder)).toEqual({ files: 3, bytes: 38 + 12 + 8 });
  await expect(openShadow(await sourceRoot(homedir(), "folder"), "folder", sources))
    .rejects.toThrow("Choose a folder inside your home directory, not the whole of it");
  await expect(openShadow(parse(folder).root, "folder", sources)).rejects.toThrow("Choose a folder, not the root of a drive");
});

it("asks before working on a folder, saying what it holds and that nothing in it changes until a result is applied", async () => {
  const { folder } = await fixture();
  expect(await folderQuestion(folder)).toBe(`${folder} is not a Git repository. Tesota can work on it as a folder: ` +
    "3 files, 58 bytes. It keeps a private record of the folder in ~/.tesota/sources and a copy for the agent; " +
    "nothing in this folder changes until you apply a reviewed result. Work on this folder? [y/N] ");
});

async function repository(): Promise<{ root: string; source: string; sources: string; workspaces: string;
  git: (...args: string[]) => string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-shadow-"));
  roots.push(root);
  const source = join(root, "project");
  await mkdir(source);
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "user.name=Tesota test",
      "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: source, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || "Test Git failed");
    return result.stdout;
  };
  git("init", "--quiet");
  return { root, source, sources: join(root, "sources"), workspaces: join(root, "workspaces"), git };
}

it("records a repository in a shadow beside it, as the operator's Git ignores files, and takes its later commits", async () => {
  const { source, sources, workspaces, git } = await repository();
  await writeFile(join(source, "price.ts"), "export const price = 1;\n");
  await writeFile(join(source, ".gitignore"), "*.env\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "Fixture");
  await writeFile(join(source, ".git", "info", "exclude"), "local.txt\n");
  await writeFile(join(source, "secret.env"), "TOKEN=1\n");
  await writeFile(join(source, "local.txt"), "mine\n");
  await writeFile(join(source, "~$notes.docx"), "lock");
  const workspace = await Workspace.create(source, workspaces, { sourcesRoot: sources, kind: "repository" });
  const [shadow] = await readdir(sources);
  if (shadow === undefined) throw new Error("Missing shadow repository");
  // The shadow is a bare repository beside the source; the operator's repository keeps one commit and no Tesota ref.
  expect(spawnSync("git", ["-C", join(sources, shadow), "rev-parse", "--is-bare-repository"], { encoding: "utf8" }).stdout.trim())
    .toBe("true");
  expect(git("for-each-ref", "--format=%(refname)").trim()).toBe("refs/heads/" + git("branch", "--show-current").trim());
  for (const name of ["secret.env", "local.txt", "~$notes.docx"]) expect(existsSync(join(workspace.checkout, name))).toBe(false);
  expect(workspace.included).toEqual([]);
  expect(workspace.base).toBe(git("rev-parse", "HEAD").trim());
  await writeFile(join(source, "tax.ts"), "export const tax = 0.2;\n");
  git("add", "tax.ts");
  git("commit", "--quiet", "-m", "Tax");
  expect(await workspace.update()).toEqual({ status: "updated", changes: [{ status: "added", path: "tax.ts" }] });
  expect(spawnSync("git", ["-C", join(sources, shadow), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim())
    .toBe(git("rev-parse", "HEAD").trim());
  await writeFile(join(workspace.checkout, "price.ts"), "export const price = 2;\n");
  await applyWorkspace(workspace, workspace.snapshot());
  expect(await readFile(join(source, "price.ts"), "utf8")).toBe("export const price = 2;\n");
});

it("works on a repository that has no commit yet, from the state Tesota first found", async () => {
  const { source, sources, workspaces } = await repository();
  await writeFile(join(source, "draft.md"), "first draft\n");
  const workspace = await Workspace.create(source, workspaces, { sourcesRoot: sources, kind: "repository" });
  expect(await readFile(join(workspace.checkout, "draft.md"), "utf8")).toBe("first draft\n");
  expect(workspace.snapshot().changes).toEqual([]);
});

it("warns of a repository's large untracked files instead of asking, leaving out ignored ones", async () => {
  const { source } = await repository();
  await writeFile(join(source, ".gitignore"), "data/\n");
  await mkdir(join(source, "data"));
  await writeFile(join(source, "data", "ignored.bin"), Buffer.alloc(3 * 1024 * 1024));
  await writeFile(join(source, "dump.sql"), Buffer.alloc(3 * 1024 * 1024));
  await writeFile(join(source, "index.ts"), "export {};\n");
  const large = await largeUntrackedFiles(source);
  expect(large).toEqual([{ path: "dump.sql", bytes: 3 * 1024 * 1024 }]);
  expect(largeUntrackedWarning(large)).toBe("1 untracked file is over 2.0 MB: dump.sql (3.0 MB). Tesota records it and " +
    "reads it before every request; add to .gitignore what is not part of the work.");
  expect(largeUntrackedWarning([])).toBeUndefined();
});

it("names shadows by path as the file system compares paths", () => {
  const insensitive = process.platform === "win32" || process.platform === "darwin";
  expect(shadowDirectory(join(tmpdir(), "App"), "sources") === shadowDirectory(join(tmpdir(), "app"), "sources")).toBe(insensitive);
});

it("keeps a superseded HEAD for seven days and cleans the shadow at most once a day", async () => {
  const { source, sources, git } = await repository();
  await writeFile(join(source, "a.txt"), "a\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
  const first = git("rev-parse", "HEAD").trim();
  const { shadow } = await openShadow(source, "repository", sources);
  const shadowGit = (...args: string[]): string => spawnSync("git", ["-C", shadow, ...args], { encoding: "utf8" }).stdout.trim();
  expect(["gc.auto", "core.longpaths", "gc.reflogExpire", "gc.reflogExpireUnreachable", "gc.pruneExpire"].map((name) => shadowGit("config", name)))
    .toEqual(["0", "true", "7.days", "7.days", "7.days.ago"]);
  expect(existsSync(join(shadow, "tesota-cleaned"))).toBe(true);
  await writeFile(join(source, "a.txt"), "b\n");
  git("commit", "--quiet", "-am", "Second");
  await openShadow(source, "repository", sources);
  expect(shadowGit("rev-parse", "HEAD")).toBe(git("rev-parse", "HEAD").trim());
  // The superseded HEAD stays reachable through the reflog until the retention period passes.
  expect(shadowGit("log", "-g", "--format=%H", "refs/heads/tesota").split("\n")).toContain(first);
});
