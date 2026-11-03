import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { contentHash, currentContent } from "./evidence.js";
import { headerProblems, modelHeader } from "./model-check.js";
import { inProject, modelOwnFiles } from "./model-files.js";
import { modelSelectionState, type ModelSelectionState } from "./verification/model-rule.js";

/** Model inputs selected by the operator at request admission; covered implementation files may change. */
export interface ModelSelection {
  readonly folder: string;
  readonly path: string;
  readonly files: readonly string[];
  readonly contentHash: string;
}

export interface ModelSelectionResult {
  readonly selection: ModelSelection;
  readonly state: ModelSelectionState;
}

/** Capture the existing model and its declared fault inputs, before any agent tool can replace them. */
export async function selectModel(root: string, input: string, folder = ""): Promise<ModelSelection> {
  const path = relative(root, resolve(root, input)).replaceAll("\\", "/");
  if (!inProject(path) || !/\.(?:tla|qnt)$/u.test(path)) throw new Error("--require-model must name a .tla or .qnt model inside the project");
  const actualRoot = await realpath(root);
  const read = async (file: string): Promise<string> => {
    const actual = await realpath(join(root, file));
    if (!inProject(relative(actualRoot, actual))) throw new Error(`${file} resolves outside the project`);
    return readFile(actual, "utf8");
  };
  const source = await read(path);
  const header = modelHeader(source);
  if (header === undefined) throw new Error(`${path} has no tesota-model header`);
  const problems = headerProblems(path, header, source, path.endsWith(".qnt") ? "quint" : "tla");
  if (problems.length > 0) throw new Error(`${path} cannot be selected: ${problems.join("; ")}`);
  const files = modelOwnFiles(path, header);
  const contents = await Promise.all(files.map(async (file) => ({ path: file, content: file === path ? source : await read(file) })));
  const selection = { folder, path, files, contentHash: contentHash(contents) };
  if (!await currentContent(root, selection)) throw new Error(`${path} inputs changed while selecting them; retry with stable model inputs`);
  return selection;
}

/** Whether the operator's selection still names exactly the content admitted for this request. */
export async function selectedModelResult(root: string, selection: ModelSelection, checked: boolean): Promise<ModelSelectionResult> {
  return { selection, state: modelSelectionState(await currentContent(root, selection), checked) };
}
