/**
 * The model a print run starts on; "" stands for none. An explicit
 * `--model` wins; otherwise a continued session keeps the model it last ran
 * on, account included; otherwise the setting's default.
 */
//@ ensures explicit !== "" ==> \result === explicit
//@ ensures explicit === "" && last !== "" ==> \result === last
//@ ensures explicit === "" && last === "" ==> \result === setting
export function startingModel(explicit: string, last: string, setting: string): string {
  if (explicit !== "") return explicit;
  if (last !== "") return last;
  return setting;
}
