import type { ModelHeader } from "./model-check.js";
import { posix } from "node:path";

/** Whether a model input stays in its project after normalization. */
export function inProject(path: string): boolean {
  const normal = posix.normalize(path.replaceAll("\\", "/"));
  return !posix.isAbsolute(normal) && !/^[A-Za-z]:/u.test(normal) && normal !== ".." && !normal.startsWith("../");
}

/** A TLA+ specification's configuration beside it. */
export function configOf(spec: string): string {
  return spec.replace(/\.tla$/u, ".cfg");
}

/** The model, its configuration, and each declared fault with its configuration; never the covered code. */
export function modelOwnFiles(path: string, header: ModelHeader): string[] {
  const withConfig = (file: string): string[] => file.endsWith(".tla") ? [file, configOf(file)] : [file];
  return [...new Set([...withConfig(path), ...header.faults.flatMap((fault) => withConfig(fault.path))])];
}
