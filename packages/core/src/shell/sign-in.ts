import { decodeKittyPrintable, getCapabilities, hyperlink, isKeyRelease, parseKey, type Terminal } from "@earendil-works/pi-tui";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { PassThrough, type Readable, Writable } from "node:stream";
import { createInterface, type Interface } from "node:readline/promises";
import { copyToClipboard } from "./clipboard.ts";

/** A browser sign-in uses the normal terminal: pi-tui truncates or rejects over-width rows. */
export async function terminalSignIn<T>(work: (interaction: AuthInteraction, show: (url: string, instructions?: string) => void, signal: AbortSignal) => Promise<T>,
  options: { terminal?: Terminal; input?: Readable; output?: Writable & { readonly isTTY?: boolean }; write?: (text: string) => void; open?: (url: string) => Promise<void>;
    copy?: (text: string) => Promise<boolean> } = {}): Promise<T> {
  const terminal = options.terminal;
  const input = options.input ?? (terminal === undefined ? process.stdin : new PassThrough());
  const output = options.output ?? (terminal === undefined ? process.stderr : Object.assign(new Writable({
    write(chunk, _encoding, done) { terminal.write(chunk.toString().replace(/(?<!\r)\n/gu, "\r\n")); done(); },
  }), { isTTY: true }));
  const write = options.write ?? ((text: string) => { output.write(text); });
  const copy = options.copy ?? ((text: string) => copyToClipboard(text, write));
  const launch = options.open ?? (async (url: string) => { await (await import("../../../../src/model-view-process.ts")).openBrowser(url); });
  const forwarded = new PassThrough();
  let lines: Interface | undefined;
  const controller = new AbortController();
  let url: string | undefined;
  let opening = Promise.resolve();
  let copying = Promise.resolve();
  let inPaste = false;
  const data = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    if (text === "c" && !inPaste && url !== undefined && (lines?.line ?? "") === "") {
      const page = url;
      copying = copying.then(async () => {
        try {
          const checked = await copy(page);
          write(checked ? "\nCopied sign-in link.\n" : "\nSign-in link sent to the terminal clipboard (unconfirmed).\n");
        } catch { write("\nCouldn't copy the sign-in link. Select the URL above instead.\n"); }
        lines?.prompt(true);
      });
    } else {
      if (text.includes("\x1b[200~")) inPaste = true;
      if (text.includes("\x1b[201~")) inPaste = false;
      forwarded.write(chunk);
    }
  };
  const raw = input === process.stdin && process.stdin.isTTY && output.isTTY === true;
  const wasRaw = process.stdin.isRaw;
  const connect = (): Interface => {
    if (lines !== undefined) return lines;
    lines = createInterface({ input: forwarded, output, terminal: output.isTTY === true });
    lines.on("SIGINT", () => { controller.abort(new Error("Login cancelled")); });
    lines.on("close", () => { controller.abort(new Error("Login cancelled")); });
    if (raw) process.stdin.setRawMode(true);
    input.on("data", data);
    if (terminal !== undefined && input instanceof PassThrough) terminal.start((text) => {
      // ProcessTerminal negotiates Kitty/modifyOtherKeys; readline expects legacy key bytes.
      if (isKeyRelease(text)) return;
      const controls: Readonly<Record<string, string>> = { "ctrl+c": "\x03", "ctrl+d": "\x04", enter: "\r", backspace: "\x7f",
        up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F", delete: "\x1b[3~" };
      input.write(controls[parseKey(text) ?? ""] ?? decodeKittyPrintable(text) ?? text);
    }, () => undefined);
    input.resume();
    return lines;
  };
  const show = (page: string, instructions?: string): void => {
    connect();
    url = page;
    opening = opening.then(async () => {
      let status: string;
      try {
        // MCP authorization endpoints are remote input, not permission to launch arbitrary OS handlers.
        const parsed = new URL(page);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Not a web sign-in URL");
        await launch(page);
        status = "Opened your browser…";
      }
      catch { status = "Couldn't open a browser"; }
      write(`${status}\n${getCapabilities().hyperlinks ? hyperlink(page, page) : page}\nIf it didn't open, Ctrl+click the link or press c to copy it (empty field only).\n`);
      const extra = (instructions ?? "").replace(/A browser window should open\.?\s*/giu, "").trim();
      if (extra !== "") write(`${extra}\n`);
    });
  };
  const interaction: AuthInteraction = {
    signal: controller.signal,
    notify: (event) => {
      if (event.type === "auth_url") show(event.url, event.instructions);
      else if (event.type === "device_code") show(event.verificationUri, `Enter ${event.userCode}`);
      else write(`${event.message}\n`);
    },
    prompt: async (prompt) => {
      await opening;
      const choices = prompt.type === "select" ? prompt.options : [];
      write(`${[prompt.message, ...choices.map(({ label }, at) => `${at + 1}. ${label}`)].join("\n")}\n`);
      const answer = await connect().question("> ",
        { signal: prompt.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, prompt.signal]) });
      return choices[Number(answer) - 1]?.id ?? answer.trim();
    },
  };
  try { return await work(interaction, show, controller.signal); }
  finally {
    await opening;
    await copying;
    input.removeListener("data", data);
    lines?.close();
    forwarded.destroy();
    if (terminal !== undefined && lines !== undefined) terminal.stop();
    if (raw && lines !== undefined) process.stdin.setRawMode(wasRaw);
    if (input.listenerCount("data") === 0) input.pause();
  }
}
