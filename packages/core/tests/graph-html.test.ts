import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApp } from "../src/shell/app.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("/graph then o writes beside the selected capture, prints its path and only calls the browser seam", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-html-shell-"));
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials }); models.setProvider(fauxProvider().provider);
  const terminal = new VirtualTerminal(160, 35);
  const opened: string[] = [];
  const running = runApp({ cwd: root, sessions, terminal, models, credentials, settingsPath: join(root, "settings.json"),
    openGraphFile: async path => { opened.push(path); } });
  const send = (text: string): void => { terminal.type(text); terminal.type("\r"); };
  try {
    await terminal.until("Tesota v");
    const fixture = join(import.meta.dir, "fixtures", "model-viewer");
    const manifest = join(root, "lights-complete.manifest.json");
    const data = JSON.parse(readFileSync(join(fixture, "lights-complete.manifest.json"), "utf8"));
    writeFileSync(manifest, JSON.stringify(data));
    copyFileSync(join(fixture, data.artifacts.dot.file), join(root, data.artifacts.dot.file));
    const at = new Date(0).toISOString();
    writeFileSync(join(sessions, "graphs.jsonl"), [
      { type: "session", format: "tesota-session", version: 6, id: "graphs", cwd: root, checkout: root, createdAt: at },
      { type: "request", run: 1, text: "HTML graph request", origin: "interactive", at, base: { units: [] } },
      { type: "custom_message", run: 1, customType: "tesota-receipt-graphs", content: "HTML receipt", display: true,
        details: { receipt: {}, graphs: [{ subject: "Lights.tla", capture: { status: "captured", manifest } }] } },
    ].map(v => JSON.stringify(v)).join("\n") + "\n");
    send("/resume"); await terminal.until("HTML graph request"); terminal.type("\r"); await terminal.until("HTML receipt");
    send("/graph --open lights-complete");
    await terminal.until("Use: /graph [--plain] [name]");
    expect(opened).toEqual([]);
    send("/graph lights-complete");
    await terminal.until("⚠ breaks DarkWhenLocked");
    terminal.type("o");
    const path = join(root, "lights-complete.html");
    await terminal.until("lights-complete.html");
    expect(existsSync(path)).toBe(true);
    // The opener only records the path; it never launches a browser.
    expect(opened).toEqual([path]);
    expect(readFileSync(path, "utf8")).toContain("Content-Security-Policy");
    expect(Object.keys(require.cache).filter(path => /[/\\]cytoscape[/\\]/u.test(path))).toEqual([]);
  } finally {
    terminal.type("\x1b"); send("/quit"); await running;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
