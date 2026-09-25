import { expect, it } from "vitest";
import { sandboxPath } from "../src/docker-sandboxes-environment.js";
import { allowsAutonomy, type EnvironmentGuarantees, type ExecutionProvider,
  type ProviderReadiness } from "../src/execution-environment.js";
import { chooseSessionMode, formatSetup } from "../src/execution-providers.js";
import { hostProvider } from "../src/host-environment.js";

const confined: EnvironmentGuarantees = { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "bounded" };

function provider(name: string, readiness: ProviderReadiness | Error, guarantees: EnvironmentGuarantees = confined): ExecutionProvider {
  return { name, guarantees,
    readiness: async () => { if (readiness instanceof Error) throw readiness; return readiness; },
    prepare: async () => { throw new Error("unused"); }, release: async () => {} };
}

it("allows autonomy only where files and network are both confined", () => {
  expect(allowsAutonomy(confined)).toBe(true);
  expect(allowsAutonomy(hostProvider.guarantees)).toBe(false);
  expect(allowsAutonomy({ ...confined, network: "open" })).toBe(false);
  expect(allowsAutonomy({ ...confined, filesystem: "host" })).toBe(false);
});

it("chooses the first ready isolating provider", async () => {
  const ready = provider("ready", { ready: true });
  const mode = await chooseSessionMode([provider("missing", { ready: false, steps: [] }), ready]);
  expect(mode).toEqual({ mode: "autonomous", provider: ready });
});

it("falls back to supervised host mode and lists what is missing", async () => {
  const mode = await chooseSessionMode([
    provider("vm", { ready: false, steps: [{ description: "Turn on the hypervisor", command: "enable it", elevated: true, restart: true }] }),
    provider("broken", new Error("boom")),
    provider("open", { ready: true }, { ...confined, network: "open" }),
  ]);
  expect(mode.mode).toBe("supervised");
  expect(mode.provider).toBe(hostProvider);
  const text = formatSetup(mode);
  expect(text).toContain("sessions ask before each command");
  expect(text).toContain("vm:\n  - Turn on the hypervisor (administrator PowerShell, then restart)\n      enable it");
  expect(text).toContain("broken:\n  - The provider could not report whether it is ready");
  expect(text).not.toContain("open:\n  -");
});

it.each([
  ["C:\\Users\\me\\.tesota\\workspaces\\a\\repo", "/c/Users/me/.tesota/workspaces/a/repo"],
  ["D:\\work", "/d/work"],
  ["/home/me/repo", "/home/me/repo"],
])("maps %s into the sandbox as %s", (host, inside) => {
  expect(sandboxPath(host)).toBe(inside);
});
