import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

export const CODE_TASK_FILE = "src/integrations/pi-task.ts";
export const CODE_TASK_MARKER = "export function piTaskPasses(result: PiTaskResult, current: CandidateTaskCheck): boolean {";
export const CODE_CHECK_IMAGE = "node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f";
export const CODE_TASK_OBJECTIVE = "Strengthen piTaskPasses to reject inconsistent session evidence. Preserve every byte before its export declaration. Require completed/stop, no denial/deadline, positive bounded integer invocation/tool/edit counts (8/13/2), 2-3 issued checks for the same task and baseline, initial check_failed then final passed with changed source hashes, all checks supplied to the model, and a matching current passed check. Allow a correction attempt with an intermediate failed check. Do not require exact counts when valid runs can differ. Use only this pure function, JavaScript syntax inside its existing TypeScript signature, no imports or additional declarations outside the function.";

export interface CodeCheck {
  readonly status: "passed" | "check_failed";
  readonly diagnostics: readonly string[];
  readonly verifierSha256: string;
}

// Kept in the executor, outside the candidate's edit authority.
const oracle = String.raw`
const before = {task:"pi-result-consistency",status:"check_failed",provenance:"issued",baseline:"a".repeat(40),sourceSha256:"1".repeat(64),taskAcceptance:"not_evaluated"};
const after = {...before,status:"passed",sourceSha256:"2".repeat(64)};
const valid = {status:"completed",modelInvocations:5,toolCalls:4,edits:1,checks:[before,after],checksSuppliedToModel:2,finalCheckSuppliedToModel:true,deadlineExpired:false,denied:false,terminalStopReason:"stop",taskAcceptance:"not_evaluated"};
const current = {...after,provenance:"recorded_untrusted"};
const cases = [["valid",valid,current,true],
 ["correction",{...valid,modelInvocations:7,toolCalls:6,edits:2,checks:[before,{...before,sourceSha256:"3".repeat(64)},after],checksSuppliedToModel:3},current,true]];
for(const [key,value] of [["status","failed"],["terminalStopReason","error"],["denied",true],["deadlineExpired",true],["modelInvocations",0],["modelInvocations",9],["toolCalls",0],["toolCalls",14],["edits",0],["edits",3],["edits",1.5],["modelInvocations",2.5],["toolCalls",4.5],["finalCheckSuppliedToModel",false],["checksSuppliedToModel",1]])
 cases.push([key+"="+value,{...valid,[key]:value},current,false]);
cases.push(["missing checks",{...valid,checks:[]},current,false],
 ["unissued",{...valid,checks:[{...before,provenance:"recorded_untrusted"},after]},current,false],
 ["baseline mismatch",{...valid,checks:[{...before,baseline:"b".repeat(40)},after]},current,false],
 ["task mismatch",{...valid,checks:[{...before,task:"other"},after]},current,false],
 ["current task",valid,{...current,task:"other"},false],
 ["unchanged hash",{...valid,checks:[after,after]},current,false],
 ["no changed bytes",{...valid,checks:[{...before,sourceSha256:after.sourceSha256},after]},current,false],
 ["stale",valid,{...current,sourceSha256:"4".repeat(64)},false],
 ["failed current",valid,{...current,status:"check_failed"},false]);
let failures = [];
for (const [name,result,now,expected] of cases) {
 try { if (piTaskPasses(structuredClone(result),structuredClone(now)) !== expected) failures.push(name); }
 catch { failures.push(name); }
}
process.stdout.write(JSON.stringify({failures}));
`;

/** No host mounts or network. Candidate code executes only inside the fixed Linux container. */
export function checkCodeTask(content: string, baseline: string): CodeCheck {
  const position = baseline.indexOf(CODE_TASK_MARKER);
  const prefix = baseline.slice(0, position);
  const verifierSha256 = createHash("sha256").update(CODE_CHECK_IMAGE + CODE_TASK_MARKER + oracle + checkCodeTask.toString()).digest("hex");
  const failed = (diagnostic: string): CodeCheck => ({ status: "check_failed", diagnostics: [diagnostic], verifierSha256 });
  if (position < 0 || baseline.indexOf(CODE_TASK_MARKER, position + 1) !== -1 ||
      !content.startsWith(prefix + CODE_TASK_MARKER)) return failed("Only piTaskPasses may change");
  const functionSource = content.slice(position).replace(CODE_TASK_MARKER, "function piTaskPasses(result, current) {")
    .replace(/:\s*(?:unknown|boolean)\b/g, "")
    .replace(/\s+as\s+\{\s*task\?\s*(?::\s*unknown)?\s*\}/g, "");
  // The VM separates test inputs and oracle state; the container is the host isolation boundary.
  const script = "import { runInNewContext } from 'node:vm';\nconst candidate = " + JSON.stringify(functionSource) +
    ";\nfunction piTaskPasses(result,current) { return runInNewContext('(' + candidate + ')(' + JSON.stringify(result) + ',' + JSON.stringify(current) + ')', Object.create(null), {timeout:100, contextCodeGeneration:{strings:false,wasm:false}}); }\n" + oracle;
  const name = "tesota-code-check-" + randomUUID();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const args = ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine"];
  if (process.platform !== "win32") throw new Error("Code checks currently require Windows Docker Desktop");
  const execute = (): CodeCheck => {
    const result = spawnSync("docker", [...args, "run", "--name", name, "--pull=never", "--network=none",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534",
      "--pids-limit=32", "--memory=128m", "--memory-swap=128m", "--cpus=1", "--log-driver=none",
      "--entrypoint=node", "-i", CODE_CHECK_IMAGE, "--input-type=module", "--max-old-space-size=64", "-"], {
      env, input: script, encoding: "utf8", shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
    });
    if (result.error !== undefined || result.status !== 0 || result.signal !== null) return failed("Behavior check did not complete");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { return failed("Invalid behavior check output"); }
    if (typeof parsed !== "object" || parsed === null || !("failures" in parsed) || !Array.isArray(parsed.failures) ||
        parsed.failures.length > 64 || parsed.failures.some((item: unknown) => typeof item !== "string" || item.length > 100)) {
      return failed("Invalid behavior check output");
    }
    return { status: parsed.failures.length === 0 ? "passed" : "check_failed", diagnostics: parsed.failures, verifierSha256 };
  };
  let result: CodeCheck;
  let cleaned = false;
  try { result = execute(); } finally {
    const cleanup = spawnSync("docker", [...args, "rm", "--force", name], {
      env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4096,
    });
    cleaned = cleanup.error === undefined && cleanup.status === 0;
  }
  if (!cleaned) throw new Error("Code check container cleanup unconfirmed");
  return result;
}
