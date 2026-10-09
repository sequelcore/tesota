import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, type Theme } from "@earendil-works/pi-coding-agent";
import type { TerminalColorMode } from "@earendil-works/pi-tui";
import { expect } from "vitest";

export const packageRoot: string =dirname(dirname(fileURLToPath(import.meta.url)));

/** The themes Pi loads from the package, as the launcher loads Tesota: the package's root passed to Pi as an extension. */
export async function loadThemes(): Promise<Map<string, Theme>> {
  const loader = new DefaultResourceLoader({ cwd: mkdtempSync(join(tmpdir(), "tesota-themes-")),
    agentDir: mkdtempSync(join(tmpdir(), "tesota-agent-")), additionalExtensionPaths: [packageRoot] });
  await loader.reload();
  const { themes: loaded, diagnostics } = loader.getThemes();
  expect(diagnostics).toEqual([]);
  return new Map(loaded.flatMap((theme) => theme.name === undefined ? [] : [[theme.name, theme] as const]));
}

/** A theme Pi loaded, in a color mode the test sets rather than the one Pi detected on this machine. */
export function themeIn(themes: ReadonlyMap<string, Theme>, name: string, mode: TerminalColorMode = "truecolor"): Theme {
  const found = themes.get(name);
  if (found === undefined) throw new Error(`Pi did not load the theme ${name}`);
  return new Proxy(found, { get: (target, key) => {
    if (key === "getColorMode") return () => mode;
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
