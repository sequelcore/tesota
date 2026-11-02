import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let executable: Promise<string> | undefined;
function binary(): Promise<string> {
  return executable ??= (async () => {
    const bin = mkdtempSync(join(tmpdir(), "tesota-issue-binary-"));
    const script = join(bin, "issue.cjs");
    writeFileSync(script, `process.stdout.write(process.argv.slice(2).join(' ') === 'repo set-default --view'
      ? (process.env.FIXTURE_GH_REPOSITORY || 'github.com/fixture/project') : require('fs').readFileSync(process.env.FIXTURE_GH_OUTPUT,'utf8'));\n`);
    const built = await Bun.build({ entrypoints: [script], compile: { outfile: join(bin, process.platform === "win32" ? "gh.exe" : "gh") } });
    if (!built.success) throw new Error(`Could not compile fake GitHub CLI: ${built.logs.join("\n")}`);
    return bin;
  })();
}

/** A native fake CLI serves both the real shell and the local repository query, without sign-in or network. */
export async function issueCli(root: string, text: string): Promise<Readonly<Record<string, string>>> {
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "pipe" }); };
  git("init", "--quiet");
  git("remote", "add", "origin", "https://github.com/fixture/project.git");
  const output = join(mkdtempSync(join(tmpdir(), "tesota-issue-output-")), "issue.txt");
  writeFileSync(output, text);
  return { PATH: `${await binary()}${delimiter}${process.env["PATH"] ?? ""}`, FIXTURE_GH_OUTPUT: output };
}
