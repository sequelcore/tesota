// Evaluator-only oracle. Never pass this file to the task model.
// Usage: node --experimental-transform-types http-limit-oracle.mjs <absolute-path-to-src/http.ts>
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[2] === undefined) throw new Error("A subject file is required");
const { readBoundedText, HttpBodyLimitError } = await import(pathToFileURL(resolve(process.argv[2])).href);
const results = [];
async function check(name, run) {
  let timer;
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Case deadline exceeded")), 2000);
    })]);
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error instanceof Error ? error.message : "Unknown failure" });
  } finally { clearTimeout(timer); }
}
function stream(chunks) {
  return new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
    controller.close();
  } });
}
for (const limit of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  await check(`invalid ${String(limit)} with null body`, async () => {
    await assert.rejects(readBoundedText({ body: null }, limit), RangeError);
  });
  await check(`invalid ${String(limit)} before body access`, async () => {
    let accessed = false;
    await assert.rejects(readBoundedText({ get body() { accessed = true; return null; } }, limit), RangeError);
    assert.equal(accessed, false);
  });
}
await check("zero accepts null and empty bodies", async () => {
  assert.equal(await readBoundedText({ body: null }, 0), "");
  assert.equal(await readBoundedText({ body: stream([]) }, 0), "");
});
await check("exact byte limit decodes split UTF-8", async () => {
  assert.equal(await readBoundedText({ body: stream([[0xc3], [0xa9]]) }, 2), "\u00e9");
});
await check("zero rejects nonempty body and cancels", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([65])); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBoundedText({ body }, 0), HttpBodyLimitError);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
await check("overflow counts bytes and cancels", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([0xc3, 0xa9])); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBoundedText({ body }, 1), HttpBodyLimitError);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
await check("pre-aborted valid read preserves reason", async () => {
  const reason = new Error("oracle abort");
  await assert.rejects(readBoundedText({ body: null }, 1, AbortSignal.abort(reason)), (error) => error === reason);
});
await check("in-flight abort settles despite a pending cancellation callback", async () => {
  const controller = new AbortController();
  const reason = new Error("oracle pending abort");
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const pending = readBoundedText({ body }, 1, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
console.log(JSON.stringify({ format: "tesota-http-limit-oracle", version: 1, runtime: process.version, results }, null, 2));
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
