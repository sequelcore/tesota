import { existsSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

/** Kept beside the work's state, where neither the agent's file tools nor a sandbox reach. */
const requestsFile = "requests.jsonl";
/** Present while the pending requests' answer check left gaps (decision 034). */
const openRequestsFile = "requests-open";
const requestSchema = z.strictObject({ text: z.string().max(1_000_000), at: z.iso.datetime() });

/**
 * The operator's requests behind the pending changes, verbatim (decision
 * 015), for a workspace or a session working in the source alike. Reviewers
 * see these requests, never the agent's own account of them.
 */
export class RequestRecord {
  readonly #directory: string;

  constructor(directory: string) { this.#directory = directory; }

  /**
   * Record a request; the record starts over when nothing is pending and no
   * request is held open. True when it started over, so what belonged to the
   * earlier requests, such as their tool calls, can start over with it.
   */
  async record(text: string, pending: boolean): Promise<boolean> {
    const line = `${JSON.stringify(requestSchema.parse({ text, at: new Date().toISOString() }))}\n`;
    const path = join(this.#directory, requestsFile);
    if (!pending && !existsSync(join(this.#directory, openRequestsFile))) {
      await writeFile(path, line, { encoding: "utf8", mode: 0o600 });
      return true;
    }
    await appendFile(path, line, "utf8");
    return false;
  }

  /**
   * Keep the requests pending across turns that change nothing while their
   * answer check left something not held or uncertain (decision 034), so
   * "add farewell()" followed by "continue" is still checked as one request.
   */
  keepOpen(open: boolean): void {
    const path = join(this.#directory, openRequestsFile);
    if (open) writeFileSync(path, "", { mode: 0o600 });
    else rmSync(path, { force: true });
  }

  /** The requests, in order. */
  async requests(): Promise<readonly string[]> {
    const path = join(this.#directory, requestsFile);
    if (!existsSync(path)) return [];
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0)
      .map((line) => requestSchema.parse(JSON.parse(line)).text);
  }
}
