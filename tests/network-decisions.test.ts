import { expect, it, vi } from "vitest";
import { blockedDestinations } from "../src/docker-sandboxes-environment.js";
import { type ExecutionEnvironment, isNetworkDestination, type NetworkControl } from "../src/execution-environment.js";
import { environmentBash, type NetworkDecision } from "../src/integrations/pi-coding-session.js";

it("accepts only host:port destinations as rules", () => {
  for (const value of ["example.com:443", "api.github.com:443", "10.0.0.1:80", "[2001:db8::1]:443"]) {
    expect(isNetworkDestination(value)).toBe(true);
  }
  for (const value of ["example.com", "**", "*.example.com:443", "example.com:443,evil.com:443", "a b:1", ""]) {
    expect(isNetworkDestination(value)).toBe(false);
  }
});

it("reads refused destinations for one sandbox since a time from the policy log", () => {
  const log = JSON.stringify({ blocked_hosts: [
    { host: "example.org:80", vm_name: "mine", last_seen: "2026-09-25T03:45:08.22-07:00", reason: "default deny" },
    { host: "example.org:80", vm_name: "mine", last_seen: "2026-09-25T03:45:09.00-07:00" },
    { host: "old.example:443", vm_name: "mine", last_seen: "2026-09-25T03:40:00-07:00" },
    { host: "other.example:443", vm_name: "theirs", last_seen: "2026-09-25T03:45:08-07:00" },
    { host: "*:443", vm_name: "mine", last_seen: "2026-09-25T03:45:08-07:00" },
  ] });
  expect(blockedDestinations(log, "mine", new Date("2026-09-25T10:45:00Z"))).toEqual(["example.org:80"]);
  expect(blockedDestinations(JSON.stringify({ blocked_hosts: null }), "mine", new Date(0))).toEqual([]);
});

function environment(refused: readonly string[]): { environment: ExecutionEnvironment; allow: NetworkControl["allow"] } {
  const allow = vi.fn(async () => {});
  return { allow, environment: {
    provider: "fake", preparation: [],
    guarantees: { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "bounded" },
    network: { allow },
    run: async () => ({ outcome: "exited", exitCode: 7, refused }),
    dispose: async () => {},
  } };
}

async function runCommand(target: ExecutionEnvironment, decide?: (destinations: readonly string[]) => Promise<NetworkDecision>):
Promise<{ exitCode: number | null; output: string }> {
  let output = "";
  const result = await environmentBash(target, undefined, decide).exec("curl https://example.com", "/w",
    { onData: (data) => { output += data.toString(); } });
  return { exitCode: result.exitCode, output };
}

it("opens a refused destination the operator allows and tells the agent to rerun", async () => {
  const { environment: target, allow } = environment(["example.com:443"]);
  const decide = vi.fn(async (): Promise<NetworkDecision> => "session");
  const result = await runCommand(target, decide);
  expect(decide).toHaveBeenCalledWith(["example.com:443"]);
  expect(allow).toHaveBeenCalledWith(["example.com:443"]);
  expect(result.exitCode).toBe(7);
  expect(result.output).toContain("user has now allowed it. Run the command again");
});

it("keeps a declined destination closed and tells the agent not to work around it", async () => {
  const { environment: target, allow } = environment(["example.com:443"]);
  const result = await runCommand(target, async () => "deny");
  expect(allow).not.toHaveBeenCalled();
  expect(result.output).toContain("Do not try to reach it another way");
});

it("asks nothing when the command reached only allowed hosts", async () => {
  const decide = vi.fn(async (): Promise<NetworkDecision> => "session");
  const result = await runCommand(environment([]).environment, decide);
  expect(decide).not.toHaveBeenCalled();
  expect(result.output).toBe("");
});
