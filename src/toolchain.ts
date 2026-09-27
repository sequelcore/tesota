import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a repository needs inside an isolated environment before the agent
 * starts: runtimes pinned by files it already commits, tools declared in
 * mise's own files, an optional `.tesota/setup.sh`, and its dependency install.
 */
export interface ToolchainPlan {
  /** Runtime versions Tesota found, such as `{ node: "24.15.0", bun: "1.4.2" }`. */
  readonly tools: Readonly<Record<string, string>>;
  /** Files the runtime versions were read from, for the operator and the agent. */
  readonly sources: readonly string[];
  /** `mise.toml` or `.tool-versions` files that mise installs itself inside the environment. */
  readonly miseFiles: readonly string[];
  readonly setupScript: string | null;
  /** The lockfile-based install, when no setup script takes over project setup. */
  readonly dependencies: string | null;
  /** Changes whenever anything that affects setup changes. */
  readonly fingerprint: string;
}

/** Hosts toolchain downloads come from; open only while an environment is set up. */
export const TOOLCHAIN_HOSTS: readonly string[] = Object.freeze([
  "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com",
  "release-assets.githubusercontent.com", "nodejs.org", "mise-versions.jdx.dev",
  "go.dev", "dl.google.com", "static.rust-lang.org",
]);

/** mise v2026.9.13 release binaries, checked against these hashes before use. */
export const MISE_RELEASE: Readonly<{ version: string; sha256: Readonly<{ x64: string; arm64: string }> }> = Object.freeze({
  version: "v2026.9.13",
  sha256: Object.freeze({
    x64: "a72f49916b33ba952ba398046c5cc91a58238f0b718fee1d938206ef2af21c6d",
    arm64: "dbfdfe99fe56cffda0b1c91ccbbe81e75e8475d2680bee2a7248fd779cdacde8",
  }),
});

const versionPattern = /^v?(\d+(?:\.\d+){0,2})$/u;

function readText(checkout: string, path: string): string | null {
  const full = join(checkout, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

/** An exact or lower-bound version such as `24.15.0`, `v24`, `^24.1` or `>=24`; ranges with upper bounds are skipped. */
function pinnedVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^(?:>=|\^|~|=)\s*/u, "");
  return versionPattern.exec(cleaned)?.[1] ?? null;
}

function packageManifest(checkout: string): Record<string, unknown> {
  const text = readText(checkout, "package.json");
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
  } catch { return {}; }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function runtimeVersions(checkout: string, sources: string[]): Record<string, string> {
  const tools: Record<string, string> = {};
  const take = (tool: string, version: string | null, source: string): void => {
    if (version === null || tool in tools) return;
    tools[tool] = version;
    sources.push(source);
  };
  for (const file of [".node-version", ".nvmrc"]) take("node", pinnedVersion(readText(checkout, file)), file);
  take("bun", pinnedVersion(readText(checkout, ".bun-version")), ".bun-version");
  take("python", pinnedVersion(readText(checkout, ".python-version")), ".python-version");
  const manifest = packageManifest(checkout);
  take("node", pinnedVersion(field(field(manifest, "engines"), "node")), "package.json engines.node");
  const manager = /^(bun)@(.+)$/u.exec(typeof manifest["packageManager"] === "string" ? manifest["packageManager"] : "");
  if (manager !== null) take(manager[1] ?? "bun", pinnedVersion(manager[2]), "package.json packageManager");
  take("bun", pinnedVersion(field(field(manifest, "engines"), "bun")), "package.json engines.bun");
  return tools;
}

/** Whether the checkout's root is a JavaScript package, whose installs land in its node_modules. */
export function hasNodeModules(checkout: string): boolean {
  return existsSync(join(checkout, "package.json"));
}

function dependencyInstall(checkout: string): string | null {
  if (existsSync(join(checkout, "bun.lock")) || existsSync(join(checkout, "bun.lockb"))) return "bun install --frozen-lockfile";
  if (existsSync(join(checkout, "package-lock.json"))) return "npm ci";
  return null;
}

export function planToolchain(checkout: string): ToolchainPlan {
  const sources: string[] = [];
  const tools = runtimeVersions(checkout, sources);
  const miseFiles = ["mise.toml", ".mise.toml", ".tool-versions"].filter((file) => existsSync(join(checkout, file)));
  const setupScript = existsSync(join(checkout, ".tesota", "setup.sh")) ? ".tesota/setup.sh" : null;
  const dependencies = setupScript === null ? dependencyInstall(checkout) : null;
  const fingerprint = createHash("sha256").update(JSON.stringify({ mise: MISE_RELEASE.version, tools,
    miseFiles: Object.fromEntries(miseFiles.map((file) => [file, readText(checkout, file)])),
    setup: setupScript === null ? null : readText(checkout, setupScript), dependencies })).digest("hex");
  return { tools, sources, miseFiles, setupScript, dependencies, fingerprint };
}

/** Whether anything must run inside the environment after its runtimes are in place. */
export function needsSetup(plan: ToolchainPlan): boolean {
  return plan.miseFiles.length > 0 || plan.setupScript !== null || plan.dependencies !== null;
}

/** Whether setup must reach hosts beyond package registries, such as toolchain downloads. */
export function needsDownloadHosts(plan: ToolchainPlan): boolean {
  return plan.miseFiles.length > 0 || plan.setupScript !== null;
}

/** POSIX shell that installs the pinned mise binary into ~/.local/bin after checking its hash. */
export function miseInstallScript(): string {
  return [
    "set -eu",
    'case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported architecture"; exit 1 ;; esac',
    `case "$arch" in x64) sum=${MISE_RELEASE.sha256.x64} ;; arm64) sum=${MISE_RELEASE.sha256.arm64} ;; esac`,
    'mkdir -p "$HOME/.local/bin"',
    `curl -fsSL -o "$HOME/.local/bin/mise.download" "https://github.com/jdx/mise/releases/download/${MISE_RELEASE.version}/mise-${MISE_RELEASE.version}-linux-$arch"`,
    'echo "$sum  $HOME/.local/bin/mise.download" | sha256sum -c -',
    'chmod +x "$HOME/.local/bin/mise.download"',
    'mv "$HOME/.local/bin/mise.download" "$HOME/.local/bin/mise"',
    '"$HOME/.local/bin/mise" --version',
  ].join("\n");
}

/** Shell that installs the tools the repository's own mise files declare. */
export function miseFilesInstallScript(): string {
  return "set -eu\nmise install";
}
