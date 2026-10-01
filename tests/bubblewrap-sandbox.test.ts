import { expect, it } from "vitest";
import { bubblewrapArguments, commandPath, guardedPaths, commandVariables, installedToolFolders, releaseRepository, type SandboxLayout, settingsWritten, interopServed,
  toolFolders, windowsDrives, windowsMounts } from "../src/bubblewrap-sandbox.js";
import { distributionSetupScript, listedDistributions } from "../src/wsl-environment.js";

/**
 * What the WSL sandbox (decision 043) builds for each command, without
 * running bubblewrap: which folders a command sees, which variables it gets,
 * and how Tesota reads WSL and sets up its distribution. The live suite,
 * `TESOTA_LIVE_WSL=1`, holds the result to the execution controls.
 */

const layout: SandboxLayout = { workspace: "/mnt/c/Users/op/.tesota/workspaces/abc/repo", home: "/home/tesota/.local/state/s/home",
  account: "/home/tesota",
  temp: "/home/tesota/.local/state/s/tmp", cache: "/mnt/c/Users/op/.tesota/cache/k",
  toolchains: "/home/tesota/.local/state/tesota/toolchains/k", modules: "/home/tesota/.local/state/s/node_modules",
  relay: "/home/tesota/.local/state/s/relay.cjs", socket: "/home/tesota/.local/state/s/proxy.sock",
  mask: "/home/tesota/.local/state/s/hidden", runtime: "/usr/local/bin/node",
  system: [{ path: "/usr" }, { path: "/bin", link: "usr/bin" }, { path: "/etc" }], tools: ["/opt/node"] };

// WSL 2's own mount table: drives as 9p shares of drvfs, and GPU drivers shared from Windows too.
const mountinfo = [
  "22 1 8:32 / / rw,relatime - ext4 /dev/sdc rw",
  "85 22 0:65 / /mnt/c rw,noatime - 9p C:\\134 rw,dirsync,aname=drvfs;path=C:\\134;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,trans=fd",
  "86 22 0:66 / /mnt/d rw,noatime - 9p D:\\134 rw,dirsync,aname=drvfs;path=D:\\;uid=1000;gid=1000,mmap,trans=fd",
  "87 22 0:67 / /usr/lib/wsl/drivers ro,nosuid,nodev,noatime - 9p drivers ro,dirsync,aname=drivers;fmask=222;dmask=222,mmap",
  "88 22 0:68 / /mnt/share rw,noatime - 9p drvfs rw,aname=drvfs;path=C:\\134Users\\134op;uid=0,mmap",
  "89 22 0:69 / /mnt/e rw,noatime - virtiofs drvfsaE rw",
  "90 22 0:70 / /mnt/wsl rw,relatime - tmpfs none rw",
].join("\n");

it("tells every filesystem WSL shares from Windows, and among them the drives themselves", () => {
  expect(windowsMounts(mountinfo)).toEqual(["/mnt/c", "/mnt/d", "/usr/lib/wsl/drivers", "/mnt/share", "/mnt/e"]);
  // Only drives hold workspaces, so only their owner matters; the drivers stay root's.
  expect(windowsDrives(mountinfo)).toEqual(["/mnt/c", "/mnt/d"]);
  expect(windowsDrives("91 22 0:71 / /mnt/f rw - drvfs F: rw,uid=1000")).toEqual(["/mnt/f"]);
});

it("reads whether WSL's configuration asks for interop off and drives owned by this user", () => {
  const written = '[automount]\noptions = "uid=1000,gid=1000"\n[user]\ndefault=tesota\n[interop]\nenabled=false\nappendWindowsPath=false\n';
  expect(settingsWritten(written, 1000, 1000)).toBe(true);
  expect(settingsWritten(written.replaceAll("\n", "\r\n"), 1000, 1000)).toBe(true);
  expect(settingsWritten(written, 1001, 1000)).toBe(false);
  expect(settingsWritten(written.replace("enabled=false", "enabled=true"), 1000, 1000)).toBe(false);
  expect(settingsWritten("[interop]\nenabled=false\n", 1000, 1000)).toBe(false);
  expect(settingsWritten("# [interop]\n[automount]\noptions=uid=1000,gid=1000 # mine\n[interop]\nEnabled = false", 1000, 1000)).toBe(true);
  expect(settingsWritten("", 1000, 1000)).toBe(false);
});

it("takes interop as still on only while WSL serves this session, whatever the VM-wide binfmt entry", () => {
  // As WSL names a session's interop server when the distribution has interop on, and names none when it is off.
  expect(interopServed({ WSL_INTEROP: "/run/WSL/290_interop" })).toBe(true);
  expect(interopServed({})).toBe(false);
  expect(interopServed({ WSL_INTEROP: "" })).toBe(false);
});

it("lets a command read tool installations from PATH, never the operator's home, the root or Windows' programs", () => {
  const path = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/node/bin", "/opt/node/lib", "/home/op/.bun/bin", "/home/op", "/home",
    "/mnt/c/Windows/system32", "/mnt/c/Program Files/nodejs", "/", "relative/bin", "/snap/bin/"].join(":");
  expect(toolFolders(path, "/home/op", ["/mnt/c"])).toEqual(["/home/op/.bun", "/opt/node", "/snap"]);
});

it("gives a command only the PATH entries it can reach", () => {
  expect(commandPath("/usr/local/bin:/opt/node/bin:/home/op/bin:/mnt/c/Windows:/bin:bin", ["/opt/node"]))
    .toBe("/usr/local/bin:/opt/node/bin:/bin");
});

it("gives a command its own home, temporary folder, caches and proxy, and what it was given, nothing of the host's", () => {
  const variables = commandVariables(layout, "/usr/bin", { CI: "1", HOME: "/elsewhere" });
  // The session's home is mounted at the account's own, so HOME and what the system says agree.
  expect(commandVariables(layout, "/usr/bin", {})["HOME"]).toBe("/home/tesota");
  expect(variables).toEqual({ PATH: "/usr/bin", HOME: "/elsewhere", TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "1",
    HTTP_PROXY: "http://127.0.0.1:3128", HTTPS_PROXY: "http://127.0.0.1:3128", http_proxy: "http://127.0.0.1:3128",
    https_proxy: "http://127.0.0.1:3128", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
    npm_config_cache: `${layout.cache}/npm`, BUN_INSTALL_CACHE_DIR: `${layout.cache}/bun` });
});

it("builds a sandbox of new namespaces that mounts only the system, tools, workspace and the session's own folders", () => {
  const args = bubblewrapArguments(layout, `${layout.workspace}/src`, "npm test", "agent");
  expect(args.slice(0, 3)).toEqual(["--unshare-all", "--die-with-parent", "--new-session"]);
  expect(args).not.toContain("--share-net");
  const mounts = args.flatMap((arg, index) => ["--bind", "--ro-bind", "--ro-bind-try", "--symlink"].includes(arg)
    ? [`${arg} ${args[index + 1] ?? ""} ${args[index + 2] ?? ""}`] : []);
  expect(mounts).toEqual([
    "--ro-bind /usr /usr", "--symlink usr/bin /bin", "--ro-bind /etc /etc", `--bind ${layout.home} /home/tesota`,
    "--ro-bind-try /opt/node /opt/node", `--bind ${layout.temp} /tmp`, `--bind ${layout.cache} ${layout.cache}`,
    `--ro-bind ${layout.toolchains} ${layout.toolchains}`, `--bind ${layout.workspace} ${layout.workspace}`, `--bind ${layout.modules ?? ""} ${layout.workspace}/node_modules`,
    `--ro-bind ${layout.relay} ${layout.relay}`, `--bind ${layout.socket} ${layout.socket}`]);
  expect(args.slice(-10)).toEqual(["--chdir", `${layout.workspace}/src`, "--info-fd", "3", "--",
    "/usr/local/bin/node", layout.relay, layout.socket, "3128", "npm test"]);
});

it("mounts the workspace's Git data read-only and an empty file over each hidden file, after the workspace", () => {
  const git = `${layout.workspace}/.git`;
  const secret = `${layout.workspace}/api/.env`;
  const args = bubblewrapArguments(layout, layout.workspace, "true", "agent", { readOnly: [".git"], hidden: ["api/.env"] });
  expect(args.slice(args.indexOf(git) - 1, args.indexOf(git) + 2)).toEqual(["--ro-bind", git, git]);
  expect(args.slice(args.indexOf(secret) - 2, args.indexOf(secret) + 1)).toEqual(["--ro-bind", layout.mask, secret]);
  // A later mount covers an earlier one, so the guards follow the workspace and its node_modules.
  expect(args.indexOf(git)).toBeGreaterThan(args.indexOf(`${layout.workspace}/node_modules`));
});

it("shows another folder at the workspace's path, with the same node_modules and its own Git data read-only", () => {
  const base = "/mnt/c/Users/op/.tesota/source-sessions/s/base";
  const args = bubblewrapArguments(layout, layout.workspace, "true", "agent", { readOnly: [".git"], hidden: [] }, base);
  const mounts = args.flatMap((arg, index) => ["--bind", "--ro-bind"].includes(arg) ? [`${arg} ${args[index + 1] ?? ""} ${args[index + 2] ?? ""}`] : []);
  expect(mounts).toContain(`--bind ${base} ${layout.workspace}`);
  expect(mounts).not.toContain(`--bind ${layout.workspace} ${layout.workspace}`);
  expect(mounts).toContain(`--bind ${layout.modules ?? ""} ${layout.workspace}/node_modules`);
  expect(mounts).toContain(`--ro-bind ${base}/.git ${layout.workspace}/.git`);
});

it.runIf(process.platform !== "win32")("guards only plain files inside the workspace, and its Git data when present", async () => {
  const { mkdtemp, mkdir, symlink, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const workspace = await mkdtemp(`${tmpdir()}/tesota-guard-`);
  try {
    await mkdir(`${workspace}/.git`);
    await writeFile(`${workspace}/.env`, "x");
    await symlink("/etc/passwd", `${workspace}/.npmrc`);
    expect(await guardedPaths(workspace, [".env", ".npmrc", "missing.key", "../outside.key", ""]))
      .toEqual({ readOnly: [".git"], hidden: [".env"] });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

it("keeps node_modules in the workspace when the workspace is no JavaScript package", () => {
  const { modules: _modules, ...plain } = layout;
  expect(bubblewrapArguments(plain, layout.workspace, "true", "agent").join(" ")).not.toContain("node_modules");
});

it("lets only setup write the repository's toolchain folder; every other command reads it", () => {
  const mount = (phase: "setup" | "agent"): string | undefined => {
    const args = bubblewrapArguments(layout, layout.workspace, "true", phase);
    const index = args.indexOf(layout.toolchains);
    return args[index - 1];
  };
  expect(mount("setup")).toBe("--bind");
  expect(mount("agent")).toBe("--ro-bind");
});

it("puts on PATH only the installed tools' folders inside the repository's toolchain folder", () => {
  const printed = [`${layout.toolchains}/installs/node/20/bin`, `${layout.toolchains}/installs/jq/1.7.1/`, "",
    `${layout.toolchains}/installs/node/20/bin`, `${layout.toolchains}/../escape/bin`, layout.toolchains,
    "/usr/local/bin", `${layout.workspace}/bin`, "relative/bin", "  mise WARN something"].join("\n");
  expect(installedToolFolders(printed, layout.toolchains)).toEqual([`${layout.toolchains}/installs/node/20/bin`,
    `${layout.toolchains}/installs/jq/1.7.1`]);
});

it("reads the distributions wsl.exe lists in UTF-16", () => {
  expect(listedDistributions(Buffer.from("\uFEFFUbuntu\r\ntesota\r\n\r\n", "utf16le"))).toEqual(["Ubuntu", "tesota"]);
  expect(listedDistributions(Buffer.alloc(0))).toEqual([]);
});

it("sets up Tesota's distribution with its pinned runtimes through the hash-checked mise, its own user, and its settings", () => {
  const script = distributionSetupScript();
  expect(script).toMatch(/^set -eu\n/u);
  expect(script).toContain("apt-get install -y -q --no-install-recommends bubblewrap git curl");
  expect(script).toContain("sha256sum -c -");
  // The checked mise stays in the distribution, where setup installs each repository's tools with it.
  expect(script.indexOf('install -m 0755 "$HOME/.local/bin/mise" /opt/tesota/mise/bin/mise')).toBeGreaterThan(script.indexOf("sha256sum -c -"));
  expect(script).toMatch(/mise" install node@\d+\.\d+\.\d+\n.*\ncp -a "\$\(.*mise" where node@\d+\.\d+\.\d+\)" \/opt\/tesota\/node\n/u);
  expect(script).toMatch(/mise" install bun@\d+\.\d+\.\d+\n/u);
  expect(script).toContain("useradd --create-home --shell /bin/bash tesota");
  // Windows' drives are owned by Tesota's user, whom Git trusts and who may change permissions there.
  expect(script).toContain(`'[automount]\\noptions = "uid=%s,gid=%s"\\n[user]\\ndefault=%s\\n[interop]\\nenabled=false\\nappendWindowsPath=false\\n' ` +
    `"$(id -u tesota)" "$(id -g tesota)" tesota > /etc/wsl.conf`);
});

it("refuses a repository's key that could name a folder outside the repositories' own", async () => {
  for (const key of ["..", "../sandboxes", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}/..`]) {
    await expect(releaseRepository(key)).rejects.toThrow("A repository's key must be a SHA-256 in hexadecimal");
  }
});
