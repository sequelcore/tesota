import { grammarCommentLines } from "../../../src/grammar-source.ts";
import { commentOnlyLines } from "../../../src/typescript-source.ts";
import { proveFile } from "../../../src/verification/lemmascript-verifier.ts";
import { runLsc } from "../src/lsc.ts";

/**
 * What `binary.test.ts` compiles beside the engine (#472): the verifier's
 * readers that load a file or a package at the gate, run from inside a
 * binary. With a folder it proves `clamp.ts` there and prints, as JSON, the
 * lines each parser reads as comments and the proof's outcome; as
 * `__lsc`, it is LemmaScript, as the engine's binary is.
 */
const [command, ...rest] = process.argv.slice(2);
if (command === "__lsc") await runLsc(rest);
else if (command !== undefined) {
  const proof = await proveFile(command, "clamp.ts", new AbortController().signal);
  console.log(JSON.stringify({
    typescript: [...commentOnlyLines("a.ts", "// note\nconst a = 1;\n")],
    python: [...await grammarCommentLines("a.py", "# note\na = 1\n")],
    go: [...await grammarCommentLines("a.go", "// note\npackage a\n")],
    proof: { outcome: proof.outcome, files: proof.files },
  }));
}
