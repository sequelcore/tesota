import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES, miseSpec } from "./languages.js";
import { findProjects, inFolder, inProject, type Project } from "./projects.js";

/** A lockfile install, run from its project's folder. */
export interface DependencyInstall {
  readonly folder: string;
  readonly command: string;
}

/**
 * What a repository needs inside an isolated environment before the agent
 * starts: runtimes pinned by files it already commits, the languages its
 * projects' files show (decision 049), at the root or in folders below it
 * (#318), tools declared in mise's own files, an optional
 * `.tesota/setup.sh`, and each project's dependency install.
 */
export interface ToolchainPlan {
  /** Runtime versions Tesota found, such as `{ node: "24.15.0", java: "21" }`. */
  readonly tools: Readonly<Record<string, string>>;
  /** Files the runtime versions were read from, for the operator and the agent. */
  readonly sources: readonly string[];
  /** Registries the repository's languages download packages from, beyond every sandbox's own. */
  readonly registries: readonly string[];
  /** `mise.toml` or `.tool-versions` files that mise installs itself inside the environment. */
  readonly miseFiles: readonly string[];
  readonly setupScript: string | null;
  /** The projects' lockfile installs, when no setup script takes over project setup. */
  readonly installs: readonly DependencyInstall[];
  /**
   * Folders below the root that hold a `package.json`, whose `node_modules`,
   * like the root's, the environment keeps on its own disk so an install never
   * writes Linux packages into the operator's files.
   */
  readonly packages: readonly string[];
  /** Changes whenever anything that affects setup changes. */
  readonly fingerprint: string;
}

/** Hosts toolchain downloads come from; open only while an environment is set up. */
export const TOOLCHAIN_HOSTS: readonly string[] = Object.freeze([
  "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com",
  "release-assets.githubusercontent.com", "nodejs.org", "mise-versions.jdx.dev",
  "go.dev", "dl.google.com", "static.rust-lang.org", "sh.rustup.rs", "dot.net", "tuf-repo-cdn.sigstore.dev",
  "mise-java.jdx.dev", "archive.apache.org", "dlcdn.apache.org",
  "builds.dotnet.microsoft.com", "dotnetcli.azureedge.net", "dotnetcli.blob.core.windows.net",
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

function packageManifest(checkout: string, folder: string): Record<string, unknown> {
  const text = readText(checkout, inProject(folder, "package.json"));
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
  } catch { return {}; }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The folders whose JavaScript runtime pins and lockfile count: the root's, then each package's that no workspace around it holds. */
function packageFolders(projects: readonly Project[]): string[] {
  return ["", ...projects.filter((project) => project.folder !== "" && project.kinds.includes("node")).map((project) => project.folder)];
}

/** The runtimes the folders pin, the first pin of each runtime winning. */
function runtimeVersions(checkout: string, folders: readonly string[], sources: string[]): Record<string, string> {
  const tools: Record<string, string> = {};
  const take = (tool: string, version: string | null, source: string): void => {
    if (version === null || tool in tools) return;
    tools[tool] = version;
    sources.push(source);
  };
  for (const folder of folders) {
    for (const file of [".node-version", ".nvmrc"].map((name) => inProject(folder, name))) {
      take("node", pinnedVersion(readText(checkout, file)), file);
    }
    const bunFile = inProject(folder, ".bun-version");
    take("bun", pinnedVersion(readText(checkout, bunFile)), bunFile);
    const manifest = packageManifest(checkout, folder);
    const named = inProject(folder, "package.json");
    take("node", pinnedVersion(field(field(manifest, "engines"), "node")), `${named} engines.node`);
    const manager = /^(bun)@(.+)$/u.exec(typeof manifest["packageManager"] === "string" ? manifest["packageManager"] : "");
    if (manager !== null) take(manager[1] ?? "bun", pinnedVersion(manager[2]), `${named} packageManager`);
    take("bun", pinnedVersion(field(field(manifest, "engines"), "bun")), `${named} engines.bun`);
  }
  return tools;
}

/** The install of the package manager whose lockfile a folder commits, which installs exactly what that lockfile names. */
function dependencyInstall(directory: string): string | null {
  if (["bun.lock", "bun.lockb"].some((lockfile) => existsSync(join(directory, lockfile)))) return "bun install --frozen-lockfile";
  return existsSync(join(directory, "package-lock.json")) ? "npm ci" : null;
}

/**
 * Add each language the projects' files show, at the version the first
 * project to state one states, or its fallback, with the build tools each
 * project needs and the languages' registries.
 */
function languageTools(checkout: string, projects: readonly Project[], tools: Record<string, string>, sources: string[]): string[] {
  const registries: string[] = [];
  for (const project of projects) {
    for (const language of LANGUAGES.filter((candidate) => project.kinds.includes(candidate.tool))) {
      if (!(language.tool in tools)) {
        const stated = language.stated((path) => readText(checkout, inProject(project.folder, path)), project.entries);
        tools[language.tool] = stated?.version ?? language.fallback;
        sources.push(stated === null ? `${language.tool} found, ${language.fallback} by default`
          : inProject(project.folder, stated.source));
      }
      for (const [tool, version] of Object.entries(language.buildTools?.(project.entries) ?? {})) tools[tool] ??= version;
      registries.push(...language.registries);
    }
  }
  return [...new Set(registries)];
}

export function planToolchain(checkout: string): ToolchainPlan {
  const projects = findProjects(checkout);
  const sources: string[] = [];
  const folders = packageFolders(projects);
  const tools = runtimeVersions(checkout, folders, sources);
  const registries = languageTools(checkout, projects, tools, sources);
  const miseFiles = ["mise.toml", ".mise.toml", ".tool-versions"].filter((file) => existsSync(join(checkout, file)));
  const setupScript = existsSync(join(checkout, ".tesota", "setup.sh")) ? ".tesota/setup.sh" : null;
  const installs = setupScript !== null ? [] : folders.flatMap((folder) => {
    const command = dependencyInstall(join(checkout, folder));
    return command === null ? [] : [{ folder, command }];
  });
  const packages = projects.filter((project) => project.folder !== "" && project.entries.includes("package.json"))
    .map((project) => project.folder);
  const fingerprint = createHash("sha256").update(JSON.stringify({ mise: MISE_RELEASE.version, tools,
    miseFiles: Object.fromEntries(miseFiles.map((file) => [file, readText(checkout, file)])),
    setup: setupScript === null ? null : readText(checkout, setupScript), installs, registries })).digest("hex");
  return { tools, sources, registries, miseFiles, setupScript, installs, packages, fingerprint };
}

/** Whether anything must run inside the environment after its runtimes are in place. */
export function needsSetup(plan: ToolchainPlan): boolean {
  return plan.miseFiles.length > 0 || plan.setupScript !== null || plan.installs.length > 0;
}

/** How an environment runs mise during setup. */
export interface MiseUse {
  /** Whether setup installs the pinned mise first, or the environment already carries it on `PATH`. */
  readonly install: boolean;
  /** Runtimes the repository pins that the environment does not carry, which mise installs as the environment's own. */
  readonly runtimes: Readonly<Record<string, string>>;
  /** How commands reach what mise installed: its shims on `PATH`, or the tools' own folders, which a last mise stage prints. */
  readonly reach: "shims" | "folders";
}

/** One step of setting up an environment, run in its POSIX shell from the workspace's root. */
export interface SetupStage {
  readonly description: string;
  readonly script: string;
  /** Set on the stage whose output lines are the installed tools' folders, which go first on `PATH` from then on. */
  readonly toolFolders?: true;
}

/** Whether setup must reach hosts beyond package registries, such as toolchain downloads. */
export function needsDownloadHosts(plan: ToolchainPlan, mise: MiseUse): boolean {
  return plan.miseFiles.length > 0 || plan.setupScript !== null || Object.keys(mise.runtimes).length > 0;
}

/**
 * The pinned runtimes an environment must still install: those it does not
 * carry at the pinned version, or at a release of it, as `24.15.0` is of `24`.
 */
export function missingRuntimes(tools: Readonly<Record<string, string>>, carried: Readonly<Record<string, string>>):
  Record<string, string> {
  return Object.fromEntries(Object.entries(tools).filter(([tool, version]) => {
    const own = carried[tool];
    return own === undefined || own !== version && !own.startsWith(`${version}.`);
  }));
}

/** Where an environment's proxy listens for its commands, when they reach the network through one. */
export interface CommandProxy {
  readonly host: string;
  readonly port: number;
}

/**
 * Shell that points Maven and Gradle at the sandbox's proxy in the sandbox's
 * home: Java ignores proxy variables, so both would otherwise fail to reach
 * their registries (Claude Code issues 13372 and 16222). Maven also asks only
 * Central for its prefixes file: Maven Resolver 2 asks every repository a
 * POM declares, such as Apache's parent POM's snapshot repository, from
 * which a release build downloads nothing, and the proxy refuses each.
 */
function jvmProxyScript(proxy: CommandProxy): string {
  const schemes = ["https", "http"];
  // Maven's `protocol` is the proxy's own, which is HTTP for every destination, HTTPS ones tunnelled through it.
  const maven = "<settings><proxies><proxy><id>tesota</id><active>true</active><protocol>http</protocol>" +
    `<host>${proxy.host}</host><port>${proxy.port}</port><nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy></proxies>` +
    "<profiles><profile><id>tesota</id><properties>" +
    "<aether.remoteRepositoryFilter.prefixes.resolvePrefixFiles>false</aether.remoteRepositoryFilter.prefixes.resolvePrefixFiles>" +
    "<aether.remoteRepositoryFilter.prefixes.resolvePrefixFiles.central>true</aether.remoteRepositoryFilter.prefixes.resolvePrefixFiles.central>" +
    "</properties></profile></profiles><activeProfiles><activeProfile>tesota</activeProfile></activeProfiles></settings>";
  const gradle = [...schemes.flatMap((scheme) => [`systemProp.${scheme}.proxyHost=${proxy.host}`,
    `systemProp.${scheme}.proxyPort=${proxy.port}`]), "systemProp.http.nonProxyHosts=localhost|127.0.0.1"].join("\n");
  return ["set -eu", 'mkdir -p "$HOME/.m2" "$HOME/.gradle"',
    `cat > "$HOME/.m2/settings.xml" <<'TESOTA'\n${maven}\nTESOTA`,
    `cat > "$HOME/.gradle/gradle.properties" <<'TESOTA'\n${gradle}\nTESOTA`].join("\n");
}

/**
 * The stages that set up an environment, in order, each needing the ones
 * before it: mise and the tools it installs, the repository's setup script,
 * then each project's lockfile install. Versions hold only digits and dots
 * (`pinnedVersion`), so they are safe in a script.
 */
export function setupStages(plan: ToolchainPlan, mise: MiseUse, proxy?: CommandProxy): SetupStage[] {
  const stages: SetupStage[] = [];
  const runtimes = Object.entries(mise.runtimes);
  if (runtimes.length > 0 || plan.miseFiles.length > 0) {
    if (mise.install) stages.push({ description: "Install mise", script: miseInstallScript() });
    const installed = [...runtimes.map(([tool, version]) => `${tool} ${version}`),
      ...plan.miseFiles.length > 0 ? [`the tools in ${plan.miseFiles.join(" and ")}`] : []];
    // Pinned runtimes become the environment's own, in mise's global configuration; the repository's files add theirs.
    const script = ["set -eu",
      ...runtimes.length > 0 ? [`mise use --global ${runtimes.map(([tool, version]) => miseSpec(tool, version)).join(" ")}`] : [],
      ...plan.miseFiles.length > 0 ? ["mise install"] : []];
    stages.push({ description: `Install ${installed.join(" and ")}`, script: script.join("\n") });
    if (mise.reach === "folders") stages.push({ description: "Find the installed tools", script: "mise bin-paths", toolFolders: true });
  }
  if (proxy !== undefined && plan.tools["java"] !== undefined) {
    stages.push({ description: "Point Maven and Gradle at the sandbox's proxy", script: jvmProxyScript(proxy) });
  }
  if (plan.setupScript !== null) stages.push({ description: `Run ${plan.setupScript}`, script: `sh ${plan.setupScript}` });
  for (const { folder, command } of plan.installs) {
    stages.push({ description: `Install dependencies${folder === "" ? "" : ` in ${folder}`} (${command})`, script: inFolder(folder, command) });
  }
  return stages;
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
