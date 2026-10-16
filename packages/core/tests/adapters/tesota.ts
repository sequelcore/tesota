import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Session } from "../../src/contract.ts";
import { createSession, type EngineSession, openSession } from "../../src/session.ts";
import type { SessionOptions, TestEngine } from "../engine.ts";
import { scriptedReply } from "../scripted.ts";

/** Pi's scripted model playing `options.script`. */
function scripted(options: SessionOptions) {
  if (options.extensions.length > 0) throw new Error("@tesota/core has no extension API yet (slice 5 of #432).");
  const faux = fauxProvider(options.slow === true ? { tokensPerSecond: 20 } : {});
  faux.setResponses(options.script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() };
}

/**
 * `@tesota/core` on Pi's scripted model, with its sessions in the test's
 * own home folder (#437). It has no extensions and no settlement yet, so
 * tests that need them are skipped, and this adapter refuses extensions
 * instead of faking them.
 */
export const tesotaEngine: TestEngine = {
  name: "@tesota/core",
  lacks: new Set(),
  pending: new Map([["extensions", "slice 5 of #432"]]),
  shell: process.platform === "win32" ? "powershell" : "bash",
  createSession(options: SessionOptions): Promise<Session> {
    return Promise.resolve(createSession({ cwd: options.cwd, ...scripted(options) }));
  },
  async resume(session: Session, options: SessionOptions): Promise<Session> {
    await session.dispose();
    return openSession((session as EngineSession).file, scripted(options));
  },
};
