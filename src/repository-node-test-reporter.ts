/** A bounded machine report for one explicitly selected Node test entry. */
interface TestEvent {
  readonly type: string;
  readonly data: {
    readonly entryFile?: string;
    readonly file?: string;
    readonly name?: string;
    readonly type?: string;
    readonly counts?: {
      readonly cancelled: number;
      readonly failed: number;
      readonly passed: number;
      readonly skipped: number;
      readonly suites: number;
      readonly tests: number;
      readonly todo: number;
      readonly topLevel: number;
    };
    readonly success?: boolean;
  };
}

/** Test stdout is intentionally excluded so it cannot imitate verifier output. */
export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const entries = new Set<string>();
  let summary: TestEvent["data"] | null = null;
  let summaries = 0;
  let passed = 0;
  let failed = 0;
  for await (const event of source) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      if (event.data.type !== "suite") {
        if (event.type === "test:pass") passed += 1;
        else failed += 1;
        const entry = event.data.entryFile ?? event.data.file;
        if (entry !== undefined) entries.add(entry);
      }
    } else if (event.type === "test:summary" && event.data.file === undefined) {
      summary = event.data;
      summaries += 1;
    }
  }
  yield JSON.stringify({ format: "tesota-node-test-report", version: 1,
    summaries, summary: summary === null ? null : { success: summary.success, counts: summary.counts },
    observed: { passed, failed, entries: [...entries].sort() } }) + "\n";
}
