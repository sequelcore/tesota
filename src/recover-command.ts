import { type ApplicationPathState, DEFAULT_APPLICATIONS_ROOT, recoverApplication, unfinishedApplications,
  type UnfinishedApplication } from "./workspace-apply.js";

const actions = ["undo", "finish", "resolved"] as const;
type RecoverAction = typeof actions[number];

const stateWords: Readonly<Record<ApplicationPathState["state"], string>> = {
  original: "original", applied: "applied", changed: "changed by someone else", unknown: "not known",
};

function describePaths(paths: readonly ApplicationPathState[]): string {
  return paths.map((path) => `    ${path.path}: ${stateWords[path.state]}\n`).join("");
}

function describe(application: UnfinishedApplication): string {
  return `  ${application.id}, started ${application.startedAt}\n${describePaths(application.paths)}` +
    `    Originals and reviewed files: ${application.directory}\n`;
}

const guidance = "tesota recover undo [<id>]      put every original back where Tesota's file is still in place\n" +
  "tesota recover finish [<id>]    write the reviewed file where the original is still in place\n" +
  "tesota recover resolved [<id>]  record that you settled it yourself; nothing is checked or written\n" +
  "A path changed by someone else is never touched. A .tesota-*.hold file beside one holds what was\n" +
  "there when Tesota stopped.\n";

/**
 * `tesota recover`: list the applications to this repository that did not
 * finish, and undo, finish or mark one resolved (decision 042).
 */
export async function runRecoverCommand(args: readonly string[], source: string, write: (text: string) => void,
  root: string = DEFAULT_APPLICATIONS_ROOT): Promise<number> {
  const unfinished = await unfinishedApplications(source, root);
  const action = args[0];
  if (action === undefined) {
    if (unfinished.length === 0) { write("No application to this repository is unfinished.\n"); return 0; }
    write(`Unfinished applications to this repository:\n${unfinished.map(describe).join("")}\n${guidance}`);
    return 1;
  }
  if (!actions.includes(action as RecoverAction) || args.length > 2) {
    write("Use tesota recover [undo|finish|resolved [<id>]].\n");
    return 2;
  }
  const id = args[1] ?? (unfinished.length === 1 ? unfinished[0]?.id : undefined);
  if (id === undefined) {
    write(unfinished.length === 0 ? "No application to this repository is unfinished.\n"
      : "Several applications are unfinished; name one:\n" + unfinished.map(describe).join(""));
    return unfinished.length === 0 ? 0 : 2;
  }
  const result = await recoverApplication(source, id, action as RecoverAction, root);
  if (action === "resolved") {
    write(`Recorded as settled by you; Tesota checked nothing:\n${describePaths(result.paths)}`);
    return 0;
  }
  if (result.settled) {
    write(`${action === "undo" ? "Undone" : "Finished"}:\n${describePaths(result.paths)}`);
    return 0;
  }
  write(`Not every path could be ${action === "undo" ? "undone" : "finished"}; the application stays unfinished:\n` +
    `${describePaths(result.paths)}Settle the changed files yourself, then run tesota recover resolved ${id}.\n`);
  return 1;
}
