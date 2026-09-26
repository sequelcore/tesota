import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MISE_RELEASE, type ToolchainPlan } from "./toolchain.js";

/**
 * A Sandbox Kit Spec v3 workload: Docker's shell template with the runtimes a
 * repository pins under /opt/tesota. Docker Sandboxes builds local kits on the
 * host and reuses the result while the source is unchanged, so one build per
 * set of runtime versions serves every later sandbox. Build-phase arguments
 * are baked into the descriptor, so the versions are the arguments' defaults.
 *
 * Writing node_modules through the workspace mount is about twenty times
 * slower than the sandbox's own disk, so the kit also declares a volume and a
 * startup hook that bind-mounts it over the workspace's node_modules on every
 * start. The path arrives as a create-phase environment variable, never
 * spliced into the command.
 */
export const KIT_RUNTIMES = ["node", "bun", "python"] as const;
export type KitRuntime = typeof KIT_RUNTIMES[number];

const DEFAULT_KITS_ROOT: string = join(homedir(), ".tesota", "kits");

/** The create-time argument naming the in-sandbox path of the workspace's node_modules. */
export const DEPENDENCIES_ARGUMENT = "dependenciesPath";
const dependenciesVolume = "/home/agent/.tesota-dependencies";

const versionPattern = "^([0-9]+(\\.[0-9]+){0,2})?$";

export function kitDescriptor(tools: Readonly<Partial<Record<KitRuntime, string>>>): string {
  const args = KIT_RUNTIMES.flatMap((tool) => [
    `  ${tool}Version:`,
    `    default: "${tools[tool] ?? ""}"`,
    `    pattern: '${versionPattern}'`,
    `    description: ${tool} release to install, or empty for none`,
    `    buildArg: ${tool.toUpperCase()}_VERSION`,
  ]);
  return [
    "# syntax=docker/sandbox-kit:3",
    'schemaVersion: "3"',
    "displayName: Tesota shell",
    "description: Docker's shell template with the runtimes a repository pins under /opt/tesota.",
    "kind: workload",
    'version: "1.0.0"',
    "args:",
    ...args,
    `  ${DEPENDENCIES_ARGUMENT}:`,
    '    default: ""',
    "    pattern: '^(/.*/node_modules)?$'",
    "    description: Path of the workspace's node_modules, kept on the sandbox's own disk",
    "    env: TESOTA_DEPENDENCIES_PATH",
    "capabilities:",
    "  - type: com.docker.sandbox/sbx@1",
    "  - type: com.docker.sandbox/volume@1",
    "    config:",
    `      path: ${dependenciesVolume}`,
    "      size: 20g",
    "  - type: com.docker.sandbox/lifecycle@1",
    "    config:",
    "      startup:",
    "        - command:",
    "            - sh",
    "            - -c",
    `            - '[ -z "$TESOTA_DEPENDENCIES_PATH" ] || { mkdir -p ${dependenciesVolume}/node_modules && ` +
      `chown 1000:1000 ${dependenciesVolume}/node_modules && ` +
      `mount --bind ${dependenciesVolume}/node_modules "$TESOTA_DEPENDENCIES_PATH"; }'`,
    '          user: "0"',
    "          background: false",
    "          description: Keep installed dependencies on the sandbox's own disk",
    "",
  ].join("\n");
}

export function kitDockerfile(): string {
  return [
    "# syntax=docker/dockerfile:1",
    "# A hash-checked mise downloads each runtime in a build stage; only the",
    "# runtimes are copied onto Docker's shell template.",
    "FROM debian:trixie-slim AS build",
    "ARG TARGETARCH",
    ...KIT_RUNTIMES.map((tool) => `ARG ${tool.toUpperCase()}_VERSION`),
    "RUN apt-get update \\",
    " && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \\",
    " && rm -rf /var/lib/apt/lists/*",
    "RUN set -eu; \\",
    `    case "$TARGETARCH" in amd64) arch=x64; sum=${MISE_RELEASE.sha256.x64} ;; arm64) arch=arm64; sum=${MISE_RELEASE.sha256.arm64} ;; *) exit 1 ;; esac; \\`,
    `    curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/${MISE_RELEASE.version}/mise-${MISE_RELEASE.version}-linux-$arch"; \\`,
    '    echo "$sum  /usr/local/bin/mise" | sha256sum -c -; \\',
    "    chmod +x /usr/local/bin/mise",
    "ENV MISE_DATA_DIR=/mise MISE_CACHE_DIR=/tmp/mise-cache MISE_CONFIG_DIR=/tmp/mise-config MISE_YES=1",
    "RUN set -eu; \\",
    "    mkdir -p /out/opt/tesota; \\",
    '    install_tool() { [ -n "$2" ] || return 0; mise install "$1@$2"; cp -a "$(mise where "$1@$2")" "/out/opt/tesota/$1"; }; \\',
    ...KIT_RUNTIMES.map((tool) => `    install_tool ${tool} "$${tool.toUpperCase()}_VERSION"; \\`),
    "    chown -R 0:0 /out",
    "FROM docker/sandbox-templates:shell-docker",
    "COPY --from=build /out/opt/tesota /opt/tesota",
    'ENTRYPOINT ["bash"]',
    'CMD ["-l"]',
    "",
  ].join("\n");
}

/** The runtimes of a plan that the kit bakes in; others stay with mise inside the sandbox. */
export function kitRuntimes(plan: ToolchainPlan): Partial<Record<KitRuntime, string>> {
  const tools: Partial<Record<KitRuntime, string>> = {};
  for (const tool of KIT_RUNTIMES) {
    const version = plan.tools[tool];
    if (version !== undefined) tools[tool] = version;
  }
  return tools;
}

/**
 * Write the kit for these runtimes into a directory named by its content, so
 * identical toolchains share one directory and one cached build.
 */
export async function writeToolchainKit(tools: Readonly<Partial<Record<KitRuntime, string>>>,
  root: string = DEFAULT_KITS_ROOT): Promise<{ readonly directory: string; readonly id: string }> {
  const descriptor = kitDescriptor(tools);
  const dockerfile = kitDockerfile();
  const id = createHash("sha256").update(descriptor).update("\0").update(dockerfile).digest("hex").slice(0, 16);
  // sbx names the kit after its directory, and a name starting with a digit is taken for an unknown agent.
  const directory = join(root, `tesota-shell-${id}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "tesota-shell.yaml"), descriptor);
  await writeFile(join(directory, "tesota-shell.dockerfile"), dockerfile);
  return { directory, id };
}
