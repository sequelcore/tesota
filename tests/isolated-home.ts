import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Every test file runs in a home folder of its own, so no test reads or
 * writes the operator's Tesota state (`~/.tesota`), Claude Code sign-ins or
 * Git configuration, and a suite passes the same on a developer's computer as
 * on a fresh CI runner. Set before any test module loads, since modules read
 * their default paths from the home folder when imported. A live suite, which
 * needs the operator's own sign-ins, imports `operator-home.ts` first.
 */
const operator = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
process.env["TESOTA_TEST_OPERATOR_HOME"] = JSON.stringify(operator);
const home = mkdtempSync(join(tmpdir(), "tesota-home-"));
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
afterAll(() => { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); });
