import { readdirSync } from "node:fs";

/**
 * The languages a sandbox recognizes from files their projects already have
 * (decision 049), so a repository that declares nothing still gets its
 * language, as it would on the operator's own machine. Each entry says which
 * files at the repository's root show the language, how those files state a
 * version, which release to install when none does, and which registries its
 * packages come from. A new language is one more entry.
 *
 * Fallbacks are fixed where new releases break older builds (Java's build
 * tools lag its releases, Python's packages lag theirs, and Ruby 4.0 is a
 * major release) and follow the latest release where the language keeps
 * compatibility (Go, Rust's stable channel).
 */

/** Where an environment keeps the repository's installed tools, writable only in setup, and the home its commands write to. */
export interface ToolPlaces {
  readonly toolchains: string;
  readonly home: string;
}

/** Reads a file at the repository's root, or null when it is absent. */
export type ReadFile = (path: string) => string | null;

/** A version a language's files state, with the file it came from. */
export interface StatedVersion {
  readonly version: string;
  readonly source: string;
}

export interface Language {
  /** mise's name for the tool. */
  readonly tool: string;
  /** Files at the root whose presence shows the language; a name starting with `*` matches that ending. */
  readonly markers: readonly string[];
  /** The version the repository's files state, if any. */
  readonly stated: (read: ReadFile, root: readonly string[]) => StatedVersion | null;
  /** The release installed when no file states one. */
  readonly fallback: string;
  /** Registries its packages download from, over HTTPS, while setup runs and for the agent's commands. */
  readonly registries: readonly string[];
  /** Build tools to install beside it when the repository has no wrapper of its own. */
  readonly buildTools?: (root: readonly string[]) => Readonly<Record<string, string>>;
  /** Variables its tools need, given where things are: while setup installs them, and for every command after. */
  readonly variables?: (places: ToolPlaces) => Readonly<{ setup: Readonly<Record<string, string>>;
    commands: Readonly<Record<string, string>> }>;
}

/** A version safe to pass to mise in a script: digits and dots, or a release channel. */
const SAFE_VERSION = /^(?:\d+(?:\.\d+){0,2}|latest|stable|lts)$/u;

export function safeVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return SAFE_VERSION.test(trimmed) ? trimmed : null;
}

/** The first of these patterns' first group found in a file, as a safe version. */
function firstMatch(read: ReadFile, file: string, patterns: readonly RegExp[]): StatedVersion | null {
  const text = read(file);
  if (text === null) return null;
  for (const pattern of patterns) {
    const version = safeVersion(pattern.exec(text)?.[1]);
    if (version !== null) return { version, source: file };
  }
  return null;
}

function firstStated(...found: (StatedVersion | null)[]): StatedVersion | null {
  return found.find((entry) => entry !== null) ?? null;
}

/** Java's old `1.8` style names release 8. */
function javaRelease(found: StatedVersion | null): StatedVersion | null {
  return found === null ? null : { ...found, version: found.version.replace(/^1\.(\d+)$/u, "$1") };
}

const java: Language = {
  tool: "java",
  markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", ".java-version", ".sdkmanrc"],
  stated: (read) => javaRelease(firstStated(
    firstMatch(read, ".java-version", [/^\s*(?:[a-z]+-)?(\d+(?:\.\d+){0,2})/mu]),
    firstMatch(read, ".sdkmanrc", [/^\s*java\s*=\s*(\d+(?:\.\d+){0,2})/mu]),
    firstMatch(read, "pom.xml", [/<maven\.compiler\.release>\s*([\d.]+)\s*</u, /<release>\s*([\d.]+)\s*</u,
      /<java\.version>\s*([\d.]+)\s*</u, /<maven\.compiler\.source>\s*([\d.]+)\s*</u]),
    ...["build.gradle.kts", "build.gradle"].map((file) => firstMatch(read, file, [/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/u,
      /jvmToolchain\(\s*(\d+)\s*\)/u, /JavaVersion\.VERSION_(?:1_)?(\d+)/u, /sourceCompatibility\s*=\s*['"]?([\d.]+)/u])))),
  fallback: "21",
  registries: ["repo.maven.apache.org", "repo1.maven.org", "services.gradle.org", "downloads.gradle.org",
    "plugins.gradle.org", "plugins-artifacts.gradle.org"],
  buildTools: (root) => ({
    ...root.includes("pom.xml") && !root.includes("mvnw") ? { maven: "latest" } : {},
    ...root.some((name) => name.startsWith("build.gradle") || name.startsWith("settings.gradle")) && !root.includes("gradlew")
      ? { gradle: "latest" } : {},
  }),
};

const go: Language = {
  tool: "go",
  markers: ["go.mod"],
  // A `toolchain` line names the release to build with; the `go` line only the minimum.
  stated: (read) => firstMatch(read, "go.mod", [/^toolchain\s+go(\d+(?:\.\d+){0,2})\s*$/mu, /^go\s+(\d+(?:\.\d+){0,2})\s*$/mu]),
  fallback: "latest",
  registries: [],
};

const rust: Language = {
  tool: "rust",
  markers: ["Cargo.toml", "rust-toolchain.toml", "rust-toolchain"],
  // A toolchain file names the channel; Cargo's `rust-version` is only a minimum, so stable builds it.
  stated: (read) => firstStated(
    firstMatch(read, "rust-toolchain.toml", [/^\s*channel\s*=\s*"([^"]+)"/mu]),
    firstMatch(read, "rust-toolchain", [/^\s*(\S+)\s*$/u])),
  fallback: "stable",
  registries: [],
  // rustup installs into these homes; commands find the toolchain through RUSTUP_HOME and keep crates in their own CARGO_HOME.
  variables: ({ toolchains }) => ({ setup: { RUSTUP_HOME: `${toolchains}/rustup`, CARGO_HOME: `${toolchains}/cargo` },
    commands: { RUSTUP_HOME: `${toolchains}/rustup` } }),
};

const python: Language = {
  tool: "python",
  markers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", ".python-version"],
  stated: (read) => firstStated(
    firstMatch(read, ".python-version", [/^\s*(\d+(?:\.\d+){0,2})/mu]),
    firstMatch(read, "pyproject.toml", [/requires-python\s*=\s*["']\s*(?:>=|~=|==|\^)?\s*(\d+(?:\.\d+){0,2})/u]),
    firstMatch(read, "Pipfile", [/python_(?:full_)?version\s*=\s*["'](\d+(?:\.\d+){0,2})["']/u])),
  fallback: "3.13",
  registries: [],
};

const ruby: Language = {
  tool: "ruby",
  markers: ["Gemfile", ".ruby-version"],
  stated: (read) => firstStated(
    firstMatch(read, ".ruby-version", [/^\s*(?:ruby-)?(\d+(?:\.\d+){0,2})/mu]),
    firstMatch(read, "Gemfile", [/^\s*ruby\s+["'](?:~>|>=)?\s*(\d+(?:\.\d+){0,2})["']/mu])),
  fallback: "3.4",
  registries: ["rubygems.org", "index.rubygems.org"],
  // Ruby's own gem folder is read-only to commands, so gems go to the home, where Ruby still finds its bundled ones.
  variables: ({ home }) => ({ setup: { GEM_HOME: `${home}/.gem` }, commands: { GEM_HOME: `${home}/.gem` } }),
};

/** The highest `netN.M` a project file targets, as .NET's release `N`. */
function dotnetTarget(read: ReadFile, root: readonly string[]): StatedVersion | null {
  let best: StatedVersion | null = null;
  for (const file of root.filter((name) => /\.(?:cs|fs|vb)proj$/u.test(name))) {
    for (const match of (read(file) ?? "").matchAll(/net(\d+)\.\d+/gu)) {
      const major = Number(match[1]);
      if (best === null || major > Number(best.version)) best = { version: String(major), source: file };
    }
  }
  return best;
}

const dotnet: Language = {
  tool: "dotnet",
  markers: ["global.json", "*.csproj", "*.fsproj", "*.vbproj", "*.sln", "*.slnx"],
  stated: (read, root) => firstStated(
    firstMatch(read, "global.json", [/"version"\s*:\s*"(\d+(?:\.\d+){0,2})"/u]),
    dotnetTarget(read, root)),
  fallback: "10",
  registries: ["api.nuget.org"],
  // NuGet checks certificate revocation over plain HTTP, which the sandbox refuses, and the CLI sends telemetry.
  variables: () => {
    const quiet = { NUGET_CERT_REVOCATION_MODE: "offline", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
    return { setup: quiet, commands: quiet };
  },
};

export const LANGUAGES: readonly Language[] = Object.freeze([java, go, rust, python, ruby, dotnet]);

/**
 * What mise installs for a tool at a version. Java's release comes from
 * Eclipse Temurin, which keeps publishing updates, where mise's default,
 * OpenJDK's own builds, stops at the first ones: `java@21` installed 21.0.2,
 * from January 2024.
 */
export function miseSpec(tool: string, version: string): string {
  return tool === "java" && /^\d/u.test(version) ? `java@temurin-${version}` : `${tool}@${version}`;
}

/** The variables the languages among these tools need, while setup runs or for commands. */
export function languageVariables(tools: Readonly<Record<string, string>>, places: ToolPlaces,
  phase: "setup" | "commands"): Record<string, string> {
  return Object.assign({}, ...LANGUAGES.filter((language) => language.tool in tools)
    .map((language) => language.variables?.(places)[phase] ?? {}));
}

/** The file names at a repository's root, for matching markers. */
export function rootEntries(checkout: string): string[] {
  try { return readdirSync(checkout); } catch { return []; }
}

/** Whether any of a language's markers is at the root. */
export function presentIn(language: Language, root: readonly string[]): boolean {
  return language.markers.some((marker) => marker.startsWith("*") ? root.some((name) => name.endsWith(marker.slice(1)))
    : root.includes(marker));
}
