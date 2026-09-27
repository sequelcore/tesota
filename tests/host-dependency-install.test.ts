import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostInstall, installOnHost, installVariables } from "../src/host-dependency-install.js";

/**
 * The native sandbox's preparation (decision 037): the lockfile's install on
 * this computer, with no package's scripts, through the sandbox's proxy, and
 * skipped when nothing it installs from changed.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-install-"));
  roots.push(root);
  return root;
}

it("installs exactly what the lockfile names, with no package's scripts", () => {
  const repo = checkout();
  expect(hostInstall(repo)).toBeUndefined();
  writeFileSync(join(repo, "package.json"), "{}");
  writeFileSync(join(repo, "package-lock.json"), "{}");
  expect(hostInstall(repo)).toMatchObject({ manager: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] });
  writeFileSync(join(repo, "bun.lock"), "{}");
  const bun = hostInstall(repo);
  expect(bun).toMatchObject({ manager: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"] });
  // A changed lockfile or manifest is a different install.
  writeFileSync(join(repo, "bun.lock"), "{ \"changed\": true }");
  expect(hostInstall(repo)?.fingerprint).not.toBe(bun?.fingerprint);
});

it("reaches registries only through the sandbox's proxy, and fills the repository's own caches", () => {
  const variables = installVariables({ PATH: "C:\\bin", NPM_TOKEN: "kept", https_proxy: "http://corp:1", NO_PROXY: "*", no_proxy: "*" },
    "http://127.0.0.1:5123", "C:\\cache\\repo");
  expect(variables).toMatchObject({ PATH: "C:\\bin", HTTP_PROXY: "http://127.0.0.1:5123", HTTPS_PROXY: "http://127.0.0.1:5123",
    npm_config_cache: join("C:\\cache\\repo", "npm"), BUN_INSTALL_CACHE_DIR: join("C:\\cache\\repo", "bun") });
  // Another proxy, or a bypass of it, never applies; the operator's registry configuration, such as a token, still does.
  expect(variables).not.toHaveProperty("https_proxy");
  expect(variables).not.toHaveProperty("NO_PROXY");
  expect(variables).not.toHaveProperty("no_proxy");
  expect(variables["NPM_TOKEN"]).toBe("kept");
});

it("installs a lockfile once, and again only when it changes", async () => {
  const repo = checkout();
  // A dependency in the checkout itself installs without reaching any registry.
  mkdirSync(join(repo, "local"));
  writeFileSync(join(repo, "local", "package.json"), JSON.stringify({ name: "local", version: "1.0.0",
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('../postinstall-ran', '')\"" } }));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "probe", private: true, dependencies: { local: "file:./local" },
    trustedDependencies: ["local"] }));
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: repo, stdio: "ignore" });
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  const marker = join(repo, ".install-marker");
  const options = { marker, proxy: "http://127.0.0.1:9", cache: join(repo, ".cache") };
  const first = await installOnHost(repo, options);
  expect(first).toEqual([{ description: "bun install --frozen-lockfile --ignore-scripts (on this computer; no package's scripts run)",
    outcome: "done", output: "" }]);
  expect(existsSync(join(repo, "node_modules", "local", "package.json"))).toBe(true);
  // Even a package the repository trusts runs no script on this computer.
  expect(existsSync(join(repo, "postinstall-ran"))).toBe(false);
  expect(readFileSync(marker, "utf8")).toBe(hostInstall(repo)?.fingerprint);
  expect(await installOnHost(repo, options)).toEqual([]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "probe", private: true, dependencies: { "is-number": "7.0.0" } }));
  // The lockfile no longer matches the manifest, so a frozen install fails rather than change it.
  const changed = await installOnHost(repo, options);
  expect(changed[0]?.outcome).toBe("failed");
}, 60_000);
