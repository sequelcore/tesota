import { describe, expect, it } from "vitest";
import {
  CONTAINER_IMAGE,
  assessIsolationProbe,
  buildCodexSandboxInvocation,
  buildContainerInvocation,
  type IsolationPaths,
  type IsolationProbeReport,
} from "../src/command-isolation.js";

const paths: IsolationPaths = {
  candidate: "C:\\fixture\\candidate",
  writableSource: "C:\\fixture\\candidate\\source\\allowed.txt",
  buildOutput: "C:\\fixture\\build",
  verifierScratch: "C:\\fixture\\scratch",
  outside: "C:\\fixture\\outside\\sentinel.txt",
};

describe("command isolation qualification", () => {
  it("mounts candidate input read-only and grants source, build and scratch separately", () => {
    const invocation = buildContainerInvocation(paths, "tesota-isolation-fixed");

    expect(invocation.command).toBe("docker");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=16",
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
    expect(invocation.env["TESOTA_QUALIFICATION_SECRET"]).toBeUndefined();
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
    expect(invocation.env["TESOTA_QUALIFICATION_SECRET"]).toBeUndefined();
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
});
