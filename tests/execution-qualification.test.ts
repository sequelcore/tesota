import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ControlResult } from "../src/execution-controls.js";
import type { EnvironmentGuarantees, ExecutionProvider } from "../src/execution-environment.js";
import { QualificationStore, qualifiedGuarantees, qualifyProvider } from "../src/execution-qualification.js";
import { hostProvider } from "../src/host-environment.js";

/**
 * Qualification on the operator's machine (decision 030): a provider keeps a
 * guarantee only while the controls behind it pass there. The host provider,
 * dressed as a sandbox, is the counterexample every claim must lose.
 */
let root = "";
let server: Server;
let urls = { refusedUrl: "", registryUrl: "" };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tesota-qualification-"));
  server = createServer((_request, response) => { response.end("reachable"); });
  await new Promise<void>((listening) => { server.listen(0, "127.0.0.1", listening); });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  urls = { refusedUrl: `http://127.0.0.1:${port}/refused`, registryUrl: `http://127.0.0.1:${port}/registry` };
});
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const sandbox: EnvironmentGuarantees = { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" };
const result = (control: ControlResult["control"], passed: boolean): ControlResult => ({ control, passed, detail: "" });
const processes = ["workspace_read_write", "cancel_children", "time_limit"] as const;

it("keeps a claim only when the controls behind it, and every environment's own, passed", () => {
  const all = [...processes, "outside_read", "outside_write", "host_variables", "network_refused", "registry_reachable"] as const;
  expect(qualifiedGuarantees(sandbox, all.map((control) => result(control, true)))).toEqual(sandbox);
  expect(qualifiedGuarantees(sandbox, all.map((control) => result(control, control !== "outside_read"))))
    .toEqual({ ...sandbox, filesystem: "host" });
  expect(qualifiedGuarantees(sandbox, all.map((control) => result(control, control !== "registry_reachable"))))
    .toEqual({ ...sandbox, network: "open" });
  expect(qualifiedGuarantees(sandbox, all.map((control) => result(control, control !== "time_limit"))))
    .toEqual({ ...sandbox, filesystem: "host", network: "open" });
  // A control that never ran is not a pass.
  expect(qualifiedGuarantees(sandbox, processes.map((control) => result(control, true)))).toEqual({ ...sandbox, filesystem: "host", network: "open" });
});

it("withdraws every claim from a provider that confines nothing, on this machine", async () => {
  const pretender: ExecutionProvider = { ...hostProvider, name: "pretender", guarantees: sandbox };
  const record = await qualifyProvider(pretender, { root: join(root, "runs"), signal: new AbortController().signal, ...urls,
    fingerprint: "test" });
  expect(record).toMatchObject({ provider: "pretender", fingerprint: "test", guarantees: { filesystem: "host", network: "open" } });
  expect(record.results.find((entry) => entry.control === "outside_read")?.passed).toBe(false);
  expect(record.results.find((entry) => entry.control === "workspace_read_write")?.passed).toBe(true);
}, 120_000);

it("keeps a result while the machine is unchanged, and tries a failed one again after a day", () => {
  let now = Date.parse("2026-09-26T10:00:00Z");
  const store = new QualificationStore(join(root, "qualification.json"), () => now);
  const passed = { provider: "mxc", fingerprint: "build 26200", at: new Date(now).toISOString(), guarantees: sandbox,
    results: [result("workspace_read_write", true)] };
  store.write(passed);
  expect(store.read("mxc", "build 26200")).toEqual(passed);
  expect(store.read("mxc", "build 26300")).toBeUndefined();
  store.write({ ...passed, provider: "other", guarantees: { ...sandbox, network: "open" }, results: [result("registry_reachable", false)] });
  // A result where no control ran proves nothing, so it is tried again too.
  store.write({ ...passed, provider: "empty", results: [] });
  expect(store.read("other", "build 26200")?.guarantees.network).toBe("open");
  now += 25 * 60 * 60 * 1_000;
  expect(store.read("other", "build 26200")).toBeUndefined();
  expect(store.read("empty", "build 26200")).toBeUndefined();
  expect(store.read("mxc", "build 26200")).toEqual(passed);
  expect(new QualificationStore(join(root, "qualification.json"), () => now).read("mxc", "build 26200")).toEqual(passed);
});
