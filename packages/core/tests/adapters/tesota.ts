import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Session } from "../../src/contract.ts";
import { createLoop } from "../../src/loop.ts";
import type { SessionOptions, TestEngine } from "../engine.ts";
import { scriptedReply } from "../scripted.ts";

/**
 * `@tesota/core` on Pi's scripted model. In slice 2 (#435) it is the loop
 * alone: no extensions and no settlement, so tests that need them are
 * skipped, and this adapter refuses extensions instead of faking them.
 */
export const tesotaEngine: TestEngine = {
  name: "@tesota/core",
  lacks: new Set(),
  pending: new Map([["extensions", "slice 5 of #432"]]),
  shell: process.platform === "win32" ? "powershell" : "bash",
  createSession(options: SessionOptions): Promise<Session> {
    if (options.extensions.length > 0) throw new Error("@tesota/core has no extension API yet (slice 5 of #432).");
    const faux = fauxProvider(options.slow === true ? { tokensPerSecond: 20 } : {});
    faux.setResponses(options.script.map(scriptedReply));
    const models = createModels();
    models.setProvider(faux.provider);
    return Promise.resolve(createLoop({ cwd: options.cwd, models, model: faux.getModel() }));
  },
};
