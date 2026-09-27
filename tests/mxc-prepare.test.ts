import { beforeEach, expect, it, vi } from "vitest";
import type { InstallOptions } from "../src/host-dependency-install.js";

/**
 * Preparing the native sandbox (decisions 030 and 037) acquires a proxy and a
 * drive before installing dependencies. Whatever fails or stops a later step,
 * what was acquired is released, in reverse order; once prepared, `dispose`
 * releases the same. Windows' `subst`, the file system, the proxy and the
 * install are replaced here; `mxc.live.test.ts` exercises the real ones.
 */

const mocks = vi.hoisted(() => ({
  drives: new Map<string, string>(),
  closeProxy: vi.fn(async () => {}),
  install: vi.fn(),
  removed: [] as string[],
}));

vi.mock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => "C:\\Users\\Ana" }));
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), existsSync: () => false }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>(),
  mkdir: vi.fn(async () => undefined), readdir: vi.fn(async () => []), writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => { throw new Error("no lease"); }),
  rm: vi.fn(async (path: string) => { mocks.removed.push(path); }) }));
// `subst` with no arguments lists the drives, `X: <folder>` maps one and `X: /d` removes it.
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: (_file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    const letter = (args[0] ?? "").charAt(0);
    if (args.length === 0) done(null, [...mocks.drives].map(([drive, target]) => `${drive}:\\: => ${target}`).join("\r\n"));
    else if (args[1] === "/d") done(mocks.drives.delete(letter) ? null : new Error("Invalid parameter"), "");
    else { mocks.drives.set(letter, args[1] ?? ""); done(null, ""); }
  } }));
vi.mock("@microsoft/mxc-sdk", () => ({ getAvailableToolsPolicy: () => ({ readonlyPaths: [] }), createConfigFromPolicy: vi.fn(),
  getPlatformSupport: vi.fn(), spawnSandboxFromConfig: vi.fn() }));
vi.mock("../src/egress-proxy.js", () => ({ EgressProxy: { start: async () => ({ url: "http://127.0.0.1:5123", close: mocks.closeProxy,
  allow: async () => {}, blockedSince: async () => [] }) } }));
vi.mock("../src/host-dependency-install.js", () => ({ installOnHost: mocks.install }));

const { mxcProvider } = await import("../src/mxc-environment.js");

const workspace = "C:\\ws\\a\\repo";
const lease = "C:\\Users\\Ana\\.tesota\\drives\\Z.json";

beforeEach(() => {
  mocks.drives.clear();
  mocks.removed.length = 0;
  vi.clearAllMocks();
});

it("releases the drive and the proxy when installing the dependencies fails", async () => {
  mocks.install.mockRejectedValue(new Error("the install marker could not be written"));
  await expect(mxcProvider.prepare(workspace)).rejects.toThrow("the install marker could not be written");
  expect(mocks.drives.size).toBe(0);
  expect(mocks.removed).toContain(lease);
  expect(mocks.closeProxy).toHaveBeenCalledTimes(1);
});

it("stops preparing when asked, releasing what it had acquired", async () => {
  mocks.install.mockImplementation((_checkout: string, options: InstallOptions) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => { reject(options.signal?.reason); }, { once: true });
  }));
  const stop = new AbortController();
  const preparing = mxcProvider.prepare(workspace, { signal: stop.signal });
  await vi.waitFor(() => { expect(mocks.install).toHaveBeenCalled(); });
  expect(mocks.drives.get("Z")).toBe("C:\\ws\\a");
  stop.abort();
  await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.drives.size).toBe(0);
  expect(mocks.closeProxy).toHaveBeenCalledTimes(1);
});

it("acquires nothing when stopped before it starts", async () => {
  const stop = new AbortController();
  stop.abort();
  await expect(mxcProvider.prepare(workspace, { signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.drives.size).toBe(0);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("releases the drive and the proxy once prepared, and only once", async () => {
  mocks.install.mockResolvedValue([]);
  const environment = await mxcProvider.prepare(workspace);
  expect(environment.commandRoot).toBe("Z:\\repo");
  await environment.dispose();
  await environment.dispose();
  expect(mocks.drives.size).toBe(0);
  expect(mocks.removed.filter((path) => path === lease)).toHaveLength(1);
  expect(mocks.closeProxy).toHaveBeenCalledTimes(1);
});
