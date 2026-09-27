import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, expect, it } from "vitest";
import { describeFolder, folderQuestion, isGitRepository, openFolder } from "../src/folder-source.js";
import { Workspace } from "../src/workspace.js";
import { applyWorkspace } from "../src/workspace-apply.js";

/**
 * Decision 032, step 1: a plain folder is a workspace's source. Tesota keeps a
 * private Git view of it beside it, never inside it, so the copy, snapshots
 * bound to a tree and the guarded apply work as they do for a repository.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; folder: string; folders: string; workspaces: string }> {
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
  return { root, folder, folders: join(root, "folders"), workspaces: join(root, "workspaces") };
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
  const { folder, folders, workspaces } = await fixture();
  const workspace = await Workspace.create(folder, workspaces, folders);
  expect(existsSync(join(folder, ".git"))).toBe(false);
  expect(await readdir(folders)).toHaveLength(1);
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
  const { folder, folders, workspaces } = await fixture();
  const workspace = await Workspace.create(folder, workspaces, folders);
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
  const { folder, folders } = await fixture();
  expect(await describeFolder(folder)).toEqual({ files: 3, bytes: 38 + 12 + 8 });
  await expect(openFolder(homedir(), folders)).rejects.toThrow("Choose a folder inside your home directory, not the whole of it");
  await expect(openFolder(parse(folder).root, folders)).rejects.toThrow("Choose a folder, not the root of a drive");
});

it("asks before working on a folder, saying what it holds and that nothing in it changes until a result is applied", async () => {
  const { folder } = await fixture();
  expect(await folderQuestion(folder)).toBe(`${folder} is not a Git repository. Tesota can work on it as a folder: ` +
    "3 files, 58 bytes. It keeps a private record of the folder in ~/.tesota/folders and a copy for the agent; " +
    "nothing in this folder changes until you apply a reviewed result. Work on this folder? [y/N] ");
});
