/** Verification roles choose a nonempty flag, then a setting, then the session model.
 * Empty strings mean no selection; `off` is an explicit selection interpreted by the open-cases caller.
 */
//@ ensures flag !== "" ==> \result === flag
//@ ensures flag === "" && setting !== "" ==> \result === setting
//@ ensures flag === "" && setting === "" ==> \result === session
export function roleModel(flag: string, setting: string, session: string): string {
  if (flag !== "") return flag;
  if (setting !== "") return setting;
  return session;
}

/** Where `roleModel`'s selection comes from, by the same precedence: `flag`, `setting` or `session`. */
//@ ensures flag !== "" ==> \result === "flag"
//@ ensures flag === "" && setting !== "" ==> \result === "setting"
//@ ensures flag === "" && setting === "" ==> \result === "session"
export function roleSource(flag: string, setting: string): string {
  if (flag !== "") return "flag";
  if (setting !== "") return "setting";
  return "session";
}
