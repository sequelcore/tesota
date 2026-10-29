import type { ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge } from "../src/permissions.ts";
import { parsePowerShell } from "../src/powershell-parser.ts";
import { platformShell } from "../src/tools/shell.ts";

/**
 * The floor with PowerShell's own parser (#697): the commands #697 lists, as
 * the platform's PowerShell reads them. The decision for each is recorded on
 * the issue: what destroys a disk, the root or a home is refused, whatever
 * spelling; what names no guarded folder is not the floor's to refuse.
 */
describe.if(process.platform === "win32")("PowerShell's parser and the floor (#697)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-parser-"));
  const { executable } = platformShell();
  const floor = async (command: string) => {
    const call: ToolCall = { type: "toolCall", id: "c", name: "powershell", arguments: { command } };
    return judge(call, "run", cwd, "full", [], true, undefined, await parsePowerShell(executable, command));
  };

  test.each([
    "Remove-Item -Recurse -Force `\n  $env:USERPROFILE",
    "Remove-Item -Recurse -Path:$HOME",
    "ri -Recurse $env:USERPROFILE",
    "rd -Recurse ~",
    "del -Recurse ~",
    "Microsoft.PowerShell.Management\\Remove-Item -Recurse ~",
    "Remove-Item -Recurse $env:USERPROFILE\\*",
    "Remove-Item -Recurse C:\\*",
    "Remove-Item -Recurse C:\\Users",
    "Remove-Item -Recurse (\"$env:USERPROFILE\")",
    "Remove-Item -Recurse $($env:USERPROFILE)",
    "Remove-Item -Recurse ${env:USERPROFILE}",
    "Remove-Item -r ~",
    "Remove-Item -Recurse $env:HOMEDRIVE\\",
    "Remove-Item -Recurse $env:windir",
    "Remove-Item -Recurse $env:SystemDrive\\",
    "Remove-Item -Recurse \\\\?\\C:\\",
    "rmdir -Recurse ~",
    "rm -R ~",
    "cmd /c \"rg x & rd /s /q C:\\\"",
    "$rg = 'rm'; & $rg -rf ~",
    "Get-ChildItem | ForEach-Object { Remove-Item -Recurse -LiteralPath $HOME }",
    // From the cross-family review.
    "ri -r \"${env:USERPROFILE}\"",
    "ri -r \"$($env:USERPROFILE)\"",
    "ri -r @($HOME)",
    "ri -r @($HOME, \"build\")",
    "ri -r FileSystem::C:\\",
    "ri -r Microsoft.PowerShell.Core\\FileSystem::C:\\",
    "$x = 'rm'; & $x -r -Path:$HOME",
    "Remove-Item -Recurse -PSPath $HOME",
    "Remove-Item -Recurse:$true $HOME",
    "Remove-Item -Recurse \\\\localhost\\C$\\",
    "Remove-Item -Recurse $ENV:userprofile",
    "Remove-Item -Recurse C:\\*.*",
    // From the second review, against about_Parsing, about_Quoting_Rules and Remove-Item's reference.
    "ri --% -Recurse ~",
    "cmd /c --% rd /s /q %USERPROFILE%",
    "cmd /c \"rd /s /q %USERPROFILE%\"",
    "cmd /c rd /s /q %USERPROFILE%",
    "cmd /c \"del /s /q %USERPROFILE%\\*\"",
    "Remove-Item \u2013Recurse ~",
    "Remove-Item \u2014Recurse \u201c$HOME\u201d",
    "$p = @{ Path = $HOME; Recurse = $true }; Remove-Item @p",
    "powershell -c \"ri -r ~\"",
    "pwsh -NoProfile -Command 'ri -r $HOME'",
    `powershell -EncodedCommand ${Buffer.from("ri -r ~", "utf16le").toString("base64")}`,
  ])("refused: %s", async (command) => {
    expect(await floor(command)).toMatchObject({ decision: "deny", by: "floor" });
  }, 30_000);

  test.each([
    "Remove-Item -Recurse ./build",
    "Remove-Item -Recurse ~/project",
    "Get-ChildItem -Recurse ~",
    "Select-String \"x\" | Remove-Item -Recurse",
    "Select-String \"x\" | iex",
    "rg --pre rm \"x\" ~",
    "rg \"x\" --pre=sh",
    "git status",
    "ri -r ~/project*",
    "ri -r '$HOME'",
    "ri -r '$env:USERPROFILE'",
    "Remove-Item -Recurse:$false build",
    "Remove-Item -Recurse ./~",
    "cmd /c \"rd /s /q %USERPROFILE%\\project\"",
    "$p = @{ Path = './build'; Recurse = $true }; Remove-Item @p",
    "powershell -c \"Get-ChildItem -Recurse ~\"",
  ])("not the floor's: %s", async (command) => {
    expect(await floor(command)).toMatchObject({ decision: "allow", by: "mode" });
  }, 30_000);

  test("reading a command never runs it: an escape that hides a subexpression leaves the value unstated", async () => {
    const marker = join(cwd, "evaluated.txt").replaceAll("\\", "/");
    const parsed = await parsePowerShell(executable, `ri -r "$HOME\`$(Set-Content -Path '${marker}' -Value x)"`);
    expect(parsed?.[0]?.parameters["Path"]).toEqual(["?"]);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test("a command PowerShell can't parse is left to the net", async () => {
    expect(await parsePowerShell(executable, "Remove-Item -Recurse (")).toBeUndefined();
  }, 30_000);
});
