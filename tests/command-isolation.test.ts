import { describe, expect, it, vi } from "vitest";
import {
  CONTAINER_IMAGE,
  assessIsolationProbe,
  buildCodexSandboxInvocation,
  buildContainerInvocation,
  buildTypecheckContainerInvocation,
  buildVitestContainerInvocation,
  containerRunPolicySha256,
  typecheckContainerPolicySha256,
  vitestContainerPolicySha256,
  type IsolationPaths,
  type IsolationProbeReport,
} from "../src/command-isolation.js";
import {
  CleanupUnconfirmedError,
  collectUnconfirmedResources,
  networkControlIsUsable,
  runIsolationQualificationCommand,
  type IsolationQualification,
} from "../src/isolation-qualification.js";

const paths: IsolationPaths = {
  candidate: "C:\\fixture\\candidate",
  writableSource: "C:\\fixture\\candidate\\source\\allowed.txt",
  buildOutput: "C:\\fixture\\build",
  verifierScratch: "C:\\fixture\\scratch",
  outside: "C:\\fixture\\outside\\sentinel.txt",
};

describe("command isolation qualification", () => {
  it("gives the shared container restrictions a stable evidence identity", () => {
    expect(containerRunPolicySha256()).toMatch(/^[a-f\d]{64}$/u);
    expect(containerRunPolicySha256()).toBe(containerRunPolicySha256());
  });

  it("isolates the repository typecheck from writes, network and host credentials", () => {
    const invocation = buildTypecheckContainerInvocation({
      candidate: "C:\\fixture\\candidate",
      nodeModules: "C:\\fixture\\source\\node_modules",
    }, "C:\\Program Files\\Docker\\docker.exe", "tesota-typecheck-fixed");
    const serialized = invocation.args.join("\n");

    expect(invocation.command).toBe("C:\\Program Files\\Docker\\docker.exe");
    expect(serialized).toContain("--network=none");
    expect(serialized).toContain("target=/workspace/repository,readonly");
    expect(serialized).toContain("target=/workspace/node_modules,readonly");
    expect(serialized).toContain("/workspace/node_modules/typescript/bin/tsc");
    expect(serialized).toContain("NODE_OPTIONS=--max-old-space-size=384");
    expect(serialized).toContain("--noEmit\n--incremental\nfalse\n--pretty\nfalse\n-p\ntsconfig.json");
    expect(serialized).not.toContain("TESOTA_QUALIFICATION_SECRET");
    expect(typecheckContainerPolicySha256()).toMatch(/^[a-f\d]{64}$/u);
    expect(typecheckContainerPolicySha256()).toBe(typecheckContainerPolicySha256());
  });

  it("isolates the fixed Vitest runner from writes, network and ambient credentials", () => {
    const invocation = buildVitestContainerInvocation({ candidate: "C:\\fixture\\candidate",
      linuxX64NodeModules: "C:\\fixture\\linux-x64-node_modules", selectedTests: ["tests/repository-vitest.test.ts"] },
    "C:\\Program Files\\Docker\\docker.exe", "tesota-vitest-fixed");
    const serialized = invocation.args.join("\n");

    expect(invocation.command).toBe("C:\\Program Files\\Docker\\docker.exe");
    expect(serialized).toContain("--network=none");
    expect(serialized).toContain("target=/workspace/repository,readonly");
    expect(serialized).toContain("target=/workspace/node_modules,readonly");
    expect(serialized).not.toContain("/workspace/node_modules/.vite");
    expect(serialized).toContain("/workspace/node_modules/vitest/vitest.mjs");
    expect(serialized).toContain("--reporter\njson");
    expect(serialized).toContain("--configLoader\nrunner");
    expect(serialized).toContain("--cache=false");
    expect(serialized).toContain("tests/repository-vitest.test.ts");
    expect(serialized).not.toContain("TESOTA_QUALIFICATION_SECRET");
    expect(invocation.env["TESOTA_QUALIFICATION_SECRET"]).toBeUndefined();
    expect(vitestContainerPolicySha256()).toMatch(/^[a-f\d]{64}$/u);
    expect(vitestContainerPolicySha256()).toBe(vitestContainerPolicySha256());
  });

  it("rejects a reachable network control when its client cleanup is unconfirmed", () => {
    expect(networkControlIsUsable({ reachable: true, pending: ["positive-control-client"] })).toBe(false);
    expect(networkControlIsUsable({ reachable: true, pending: [] })).toBe(true);
  });

  it("attempts every cleanup and reports each resource whose absence is unconfirmed", () => {
    const attempted: string[] = [];

    const pending = collectUnconfirmedResources([
      { name: "client", remove: () => { attempted.push("client"); return false; } },
      { name: "server", remove: () => { attempted.push("server"); throw new Error("engine unavailable"); } },
      { name: "network", remove: () => { attempted.push("network"); return true; } },
    ]);

    expect(attempted).toEqual(["client", "server", "network"]);
    expect(pending).toEqual(["client", "server"]);
  });

  it("mounts candidate input read-only and grants source, build and scratch separately", () => {
    const invocation = buildContainerInvocation(paths, "tesota-isolation-fixed");

    expect(invocation.command).toBe("docker");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=32",
      "--memory=128m",
      "--memory-swap=128m",
      "--cpus=1",
      CONTAINER_IMAGE,
    ]));
    expect(invocation.args.join("\n")).toContain("target=/workspace,readonly");
    expect(invocation.args.join("\n")).toContain("target=/workspace/source/allowed.txt");
    expect(invocation.args.join("\n")).toContain("target=/workspace-build");
    expect(invocation.args.join("\n")).toContain("target=/verifier-scratch");
    expect(invocation.args.join("\n")).not.toContain(paths.outside);
    expect(invocation.args.join("\n")).not.toContain("TESOTA_QUALIFICATION_SECRET");
    expect(invocation.env["TESOTA_QUALIFICATION_SECRET"]).toBe("synthetic-private");
  });

  it("gives the native comparison only the declared filesystem capabilities", () => {
    const invocation = buildCodexSandboxInvocation(paths);
    const serialized = invocation.args.join("\n");

    expect(invocation.command).toBe("codex");
    expect(serialized).toContain("permissions.tesota-qualification.filesystem");
    expect(serialized).toContain("candidate/source/allowed.txt");
    expect(serialized).toContain("fixture/build");
    expect(serialized).toContain("fixture/scratch");
    expect(serialized).not.toContain("fixture/outside");
    expect(serialized).toContain("permissions.tesota-qualification.network.enabled=false");
    expect(serialized).not.toContain("APPDATA");
    expect(serialized).not.toContain("USERPROFILE");
    expect(invocation.env["TESOTA_QUALIFICATION_SECRET"]).toBe("synthetic-private");
  });

  it("requires every observed boundary and cancellation settlement", () => {
    const passing: IsolationProbeReport = {
      sourceWrite: true,
      siblingWriteDenied: true,
      buildWrite: true,
      scratchWrite: true,
      outsideReadDenied: true,
      credentialAbsent: true,
      networkDenied: true,
      descendantStarted: true,
    };

    expect(assessIsolationProbe(passing, { canceled: true, descendantSettled: true })).toEqual({
      status: "passed",
      failedControls: [],
    });
    expect(assessIsolationProbe({ ...passing, networkDenied: false }, {
      canceled: true,
      descendantSettled: false,
    })).toEqual({
      status: "failed",
      failedControls: ["networkDenied", "descendantSettled"],
    });
  });

  it("maps Ctrl+C to owned cancellation and restores the process listener", async () => {
    const listeners = process.listenerCount("SIGINT");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const running = runIsolationQualificationCommand(async (signal) => await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("synthetic cancellation", "AbortError")), { once: true });
    }));

    process.emit("SIGINT", "SIGINT");

    await expect(running).resolves.toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(output).not.toHaveBeenCalled();
    output.mockRestore();
  });

  it("does not publish a result that resolves after Ctrl+C", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let resolveQualification: ((value: IsolationQualification) => void) | undefined;
    const running = runIsolationQualificationCommand(async () => await new Promise((resolve) => {
      resolveQualification = resolve;
    }));

    process.emit("SIGINT", "SIGINT");
    resolveQualification?.({ command: "node isolation-probe.mjs", image: CONTAINER_IMAGE, selected: "docker-container", results: [] });

    await expect(running).resolves.toBe(130);
    expect(output).not.toHaveBeenCalled();
    output.mockRestore();
  });

  it("reports cleanup failure even when Ctrl+C was requested", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const running = runIsolationQualificationCommand(async (signal) => await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new CleanupUnconfirmedError(["tesota-test-resource"])), { once: true });
    }));

    process.emit("SIGINT", "SIGINT");

    await expect(running).resolves.toBe(2);
    expect(output).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith("Command isolation qualification failed closed. Cleanup was not confirmed: tesota-test-resource\n");
    output.mockRestore();
    diagnostic.mockRestore();
  });
});
