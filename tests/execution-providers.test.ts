import { expect, it } from "vitest";
import { sandboxPath } from "../src/docker-sandboxes-environment.js";
import { allowsAutonomy, type EnvironmentGuarantees, type ExecutionProvider, type ProviderReadiness,
  type SetupAction, type SetupStep } from "../src/execution-environment.js";
import { chooseSessionMode, formatSetup, runSetup, type SessionMode, type SetupRunner } from "../src/execution-providers.js";
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

function missing(...steps: SetupStep[]): SessionMode {
  return { mode: "supervised", provider: hostProvider, missing: [{ provider: "vm", readiness: { ready: false, steps } }] };
}

function setup(modes: SessionMode[], answers: boolean[] | null, codes: (number | null)[] = []):
{ runner: SetupRunner; output: () => string; ran: SetupAction[] } {
  let output = "";
  const ran: SetupAction[] = [];
  return { output: () => output, ran, runner: {
    write: (text) => { output += text; },
    confirm: answers === null ? null : async () => answers.shift() ?? false,
    run: async (action) => { ran.push(action); return codes.shift() ?? 0; },
    check: async () => modes.shift() ?? { mode: "autonomous", provider: provider("vm", { ready: true }) },
  } };
}

const login: SetupStep = { description: "Sign in", command: "sbx login", action: { kind: "process", program: "sbx", args: ["login"] } };
const policy: SetupStep = { description: "Deny by default", command: "sbx policy init deny-all",
  action: { kind: "process", program: "sbx", args: ["policy", "init", "deny-all"] } };

it("runs each confirmed step and checks again until autonomous sessions are ready", async () => {
  const { runner, output, ran } = setup([missing(login), missing(policy)], [true, true]);
  expect(await runSetup(runner)).toBe(0);
  expect(ran).toEqual([login.action, policy.action]);
  expect(output()).toContain("Next: Sign in.\n  sbx login\n");
  expect(output()).toContain("Autonomous sessions are ready (vm).");
});

it("stops after a step that needs a restart", async () => {
  const hypervisor: SetupStep = { description: "Turn on the hypervisor", elevated: true, restart: true, command: "enable",
    action: { kind: "elevated-powershell", script: "enable" } };
  const { runner, output, ran } = setup([missing(hypervisor)], [true]);
  expect(await runSetup(runner)).toBe(1);
  expect(ran).toHaveLength(1);
  expect(output()).toContain("It opens an administrator prompt.");
  expect(output()).toContain("Restart Windows, then run tesota setup again");
});

it("runs nothing the operator declines, and stops on a failure or a step that did not take", async () => {
  const declined = setup([missing(login)], [false]);
  expect(await runSetup(declined.runner)).toBe(1);
  expect(declined.ran).toEqual([]);
  const failed = setup([missing(login)], [true], [1]);
  expect(await runSetup(failed.runner)).toBe(1);
  expect(failed.output()).toContain("exit code 1");
  const repeated = setup([missing(login), missing(login)], [true, true]);
  expect(await runSetup(repeated.runner)).toBe(1);
  expect(repeated.ran).toHaveLength(1);
  expect(repeated.output()).toContain('"Sign in" is still missing after running it.');
});

it("only lists the steps when no one can confirm or the step has no action", async () => {
  const unattended = setup([missing(login)], null);
  expect(await runSetup(unattended.runner)).toBe(1);
  expect(unattended.ran).toEqual([]);
  expect(unattended.output()).toContain("vm:\n  - Sign in\n      sbx login");
  const manual = setup([missing({ description: "Start the daemon", command: "sbx daemon start" })], [true]);
  expect(await runSetup(manual.runner)).toBe(1);
  expect(manual.ran).toEqual([]);
});
