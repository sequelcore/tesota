import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { languageVariables, miseSpec, safeVersion } from "../src/languages.js";
import { planToolchain, setupStages } from "../src/toolchain.js";

/**
 * Languages found from files their projects already have (decision 049): the
 * version each file states, or a fallback, the build tools a repository
 * without a wrapper needs, their registries, and what their tools need set.
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tesota-languages-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

it("reads Java's release from Maven and Gradle files, adds the build tool a repository without a wrapper needs, and its registries", async () => {
  const maven = planToolchain(await repository({ "pom.xml": "<project><properties><java.version>17</java.version></properties></project>" }));
  expect(maven.tools).toEqual({ java: "17", maven: "latest" });
  expect(maven.sources).toEqual(["pom.xml"]);
  expect(maven.registries).toContain("repo.maven.apache.org");
  const wrapped = planToolchain(await repository({ "pom.xml": "<project><maven.compiler.release>21</maven.compiler.release></project>",
    mvnw: "#!/bin/sh\n" }));
  expect(wrapped.tools).toEqual({ java: "21" });
  expect(planToolchain(await repository({ "build.gradle.kts": "kotlin { jvmToolchain(17) }", gradlew: "" })).tools).toEqual({ java: "17" });
  expect(planToolchain(await repository({ "build.gradle": "sourceCompatibility = '1.8'" })).tools).toEqual({ java: "8", gradle: "latest" });
  expect(planToolchain(await repository({ ".sdkmanrc": "java=21.0.4-tem\n" })).tools).toEqual({ java: "21.0.4" });
  const fallback = planToolchain(await repository({ "settings.gradle": "rootProject.name = 'p'", gradlew: "" }));
  expect(fallback.tools).toEqual({ java: "21" });
  expect(fallback.sources).toEqual(["java found, 21 by default"]);
});

it("reads Go, Rust, Python, Ruby and .NET from their own files, or falls back", async () => {
  expect(planToolchain(await repository({ "go.mod": "module m\n\ngo 1.22\n\ntoolchain go1.24.3\n" })).tools).toEqual({ go: "1.24.3" });
  expect(planToolchain(await repository({ "go.mod": "module m\n\ngo 1.23\n" })).tools).toEqual({ go: "1.23" });
  expect(planToolchain(await repository({ "Cargo.toml": "[package]\nrust-version = \"1.70\"\n" })).tools).toEqual({ rust: "stable" });
  expect(planToolchain(await repository({ "Cargo.toml": "", "rust-toolchain.toml": "[toolchain]\nchannel = \"1.80.1\"\n" })).tools)
    .toEqual({ rust: "1.80.1" });
  expect(planToolchain(await repository({ "pyproject.toml": "requires-python = \">=3.11\"\n" })).tools).toEqual({ python: "3.11" });
  expect(planToolchain(await repository({ "requirements.txt": "six\n" })).tools).toEqual({ python: "3.13" });
  expect(planToolchain(await repository({ ".python-version": "3.12.4\n", "pyproject.toml": "requires-python = \">=3.9\"" })).tools)
    .toEqual({ python: "3.12.4" });
  expect(planToolchain(await repository({ Gemfile: "source 'https://rubygems.org'\nruby '3.3.5'\n" })).tools).toEqual({ ruby: "3.3.5" });
  expect(planToolchain(await repository({ ".ruby-version": "ruby-3.2.2\n" })).tools).toEqual({ ruby: "3.2.2" });
  expect(planToolchain(await repository({ "App.csproj": "<TargetFrameworks>net6.0;net8.0</TargetFrameworks>" })).tools)
    .toEqual({ dotnet: "8" });
  expect(planToolchain(await repository({ "global.json": "{ \"sdk\": { \"version\": \"9.0.100\" } }", "App.csproj": "net8.0" })).tools)
    .toEqual({ dotnet: "9.0.100" });
  expect(planToolchain(await repository({ "README.md": "hi" })).tools).toEqual({});
});

it("never puts a file's text into a script unless it is a plain version or a release channel", async () => {
  expect(safeVersion("21")).toBe("21");
  expect(safeVersion("stable")).toBe("stable");
  for (const unsafe of ["21; rm -rf /", "$(id)", "nightly-2024-01-01", "1.2.3.4", "", "latest\nrm"]) expect(safeVersion(unsafe)).toBeNull();
  const injected = planToolchain(await repository({ "Cargo.toml": "", "rust-toolchain.toml": "channel = \"$(curl evil)\"\n",
    ".java-version": "21;rm -rf /\n" }));
  expect(injected.tools).toEqual({ java: "21", rust: "stable" });
});

it("installs Java from Temurin, and gives each language's tools what they need in setup and in commands", async () => {
  expect(miseSpec("java", "21")).toBe("java@temurin-21");
  expect(miseSpec("go", "1.23")).toBe("go@1.23");
  const places = { toolchains: "/t", home: "/home/tesota" };
  expect(languageVariables({ rust: "stable", ruby: "3.4" }, places, "setup")).toEqual({ RUSTUP_HOME: "/t/rustup",
    CARGO_HOME: "/t/cargo", GEM_HOME: "/home/tesota/.gem" });
  expect(languageVariables({ rust: "stable" }, places, "commands")).toEqual({ RUSTUP_HOME: "/t/rustup" });
  expect(languageVariables({ dotnet: "8" }, places, "commands")).toMatchObject({ NUGET_CERT_REVOCATION_MODE: "offline" });
  const java = planToolchain(await repository({ "pom.xml": "<java.version>21</java.version>", mvnw: "" }));
  const stages = setupStages(java, { install: false, runtimes: java.tools, reach: "folders" }, { host: "127.0.0.1", port: 3128 });
  expect(stages.map((stage) => stage.description)).toEqual(["Install java 21", "Find the installed tools",
    "Point Maven and Gradle at the sandbox's proxy"]);
  expect(stages[0]?.script).toContain("mise use --global java@temurin-21");
  // Maven's proxy protocol is the proxy's own, HTTP, for every destination.
  expect(stages[2]?.script).toContain("<protocol>http</protocol><host>127.0.0.1</host><port>3128</port>");
  expect(stages[2]?.script).toContain("systemProp.https.proxyPort=3128");
});
