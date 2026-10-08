/**
 * The operator's own home folder, for a live suite that uses their sign-ins
 * and settings. Imported first in such a suite, before any module reads a
 * default path; every other test runs in the home `isolated-home.ts` gives it.
 */
const saved: unknown = JSON.parse(process.env["TESOTA_TEST_OPERATOR_HOME"] ?? "{}");
for (const name of ["HOME", "USERPROFILE"] as const) {
  const value = typeof saved === "object" && saved !== null ? Reflect.get(saved, name) : undefined;
  if (typeof value === "string") process.env[name] = value; else delete process.env[name];
}
