import { expect, it } from "vitest";
import { bubblewrapArguments, commandPath, commandVariables, type SandboxLayout, toolFolders, windowsMounts }
  from "../src/bubblewrap-sandbox.js";
import { distributionSetupScript, listedDistributions } from "../src/wsl-environment.js";

/**
 * What the WSL sandbox candidate (issue 163) builds for each command, without
 * running bubblewrap: which folders a command sees, which variables it gets,
 * and how Tesota reads WSL and sets up its distribution. The live suite,
 * `TESOTA_LIVE_WSL=1`, holds the result to the execution controls.
 */

const layout: SandboxLayout = { workspace: "/mnt/c/Users/op/.tesota/workspaces/abc/repo", home: "/home/tesota/.local/state/s/home",
  temp: "/home/tesota/.local/state/s/tmp", cache: "/mnt/c/Users/op/.tesota/cache/k", modules: "/home/tesota/.local/state/s/node_modules",
  relay: "/home/tesota/.local/state/s/relay.cjs", socket: "/home/tesota/.local/state/s/proxy.sock", runtime: "/usr/local/bin/node",
  system: [{ path: "/usr" }, { path: "/bin", link: "usr/bin" }, { path: "/etc" }], tools: ["/opt/node"] };

it("reads Windows' drives from the mount table", () => {
  const mountinfo = [
    "22 1 8:32 / / rw,relatime - ext4 /dev/sdc rw",
    "85 22 0:65 / /mnt/c rw,noatime - 9p drvfs rw,aname=drvfs;path=C:\\",
    "86 22 0:66 / /mnt/d rw,noatime - virtiofs drvfsD rw",
    "90 22 0:70 / /mnt/wsl rw,relatime - tmpfs none rw",
  ].join("\n");
  expect(windowsMounts(mountinfo)).toEqual(["/mnt/c", "/mnt/d"]);
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
  expect(variables).toEqual({ PATH: "/usr/bin", HOME: "/elsewhere", TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "1",
    HTTP_PROXY: "http://127.0.0.1:3128", HTTPS_PROXY: "http://127.0.0.1:3128", http_proxy: "http://127.0.0.1:3128",
    https_proxy: "http://127.0.0.1:3128", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
    npm_config_cache: `${layout.cache}/npm`, BUN_INSTALL_CACHE_DIR: `${layout.cache}/bun` });
});

it("builds a sandbox of new namespaces that mounts only the system, tools, workspace and the session's own folders", () => {
  const args = bubblewrapArguments(layout, `${layout.workspace}/src`, "npm test");
  expect(args.slice(0, 3)).toEqual(["--unshare-all", "--die-with-parent", "--new-session"]);
  expect(args).not.toContain("--share-net");
  const mounts = args.flatMap((arg, index) => ["--bind", "--ro-bind", "--ro-bind-try", "--symlink"].includes(arg)
    ? [`${arg} ${args[index + 1] ?? ""} ${args[index + 2] ?? ""}`] : []);
  expect(mounts).toEqual([
    "--ro-bind /usr /usr", "--symlink usr/bin /bin", "--ro-bind /etc /etc", "--ro-bind-try /opt/node /opt/node",
    `--bind ${layout.temp} /tmp`, `--bind ${layout.home} ${layout.home}`, `--bind ${layout.cache} ${layout.cache}`,
    `--bind ${layout.workspace} ${layout.workspace}`, `--bind ${layout.modules ?? ""} ${layout.workspace}/node_modules`,
    `--ro-bind ${layout.relay} ${layout.relay}`, `--bind ${layout.socket} ${layout.socket}`]);
  expect(args.slice(-10)).toEqual(["--chdir", `${layout.workspace}/src`, "--info-fd", "3", "--",
    "/usr/local/bin/node", layout.relay, layout.socket, "3128", "npm test"]);
});

it("keeps node_modules in the workspace when the workspace is no JavaScript package", () => {
  const { modules: _modules, ...plain } = layout;
  expect(bubblewrapArguments(plain, layout.workspace, "true").join(" ")).not.toContain("node_modules");
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
  expect(script).toMatch(/mise" install node@\d+\.\d+\.\d+\n.*\ncp -a "\$\(.*mise" where node@\d+\.\d+\.\d+\)" \/opt\/tesota\/node\n/u);
  expect(script).toMatch(/mise" install bun@\d+\.\d+\.\d+\n/u);
  expect(script).toContain("useradd --create-home --shell /bin/bash tesota");
  // Windows' drives are owned by Tesota's user, whom Git trusts and who may change permissions there.
  expect(script).toContain(`'[automount]\\noptions = "uid=%s,gid=%s"\\n[user]\\ndefault=%s\\n[interop]\\nenabled=false\\nappendWindowsPath=false\\n' ` +
    `"$(id -u tesota)" "$(id -g tesota)" tesota > /etc/wsl.conf`);
});
