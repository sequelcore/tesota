import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every test run gets a home folder of its own, so no test reads or writes
 * the operator's Pi state (`~/.pi`) or Git configuration. Set before any
 * test module loads, since modules read default paths when imported.
 */
const home = mkdtempSync(join(tmpdir(), "tesota-core-home-"));
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
afterAll(() => { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); });
