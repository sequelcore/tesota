import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { ParsedCommand } from "./permissions.ts";

/**
 * PowerShell's own reading of a command (#697), as Codex and Claude Code read
 * one: its parser finds every command, nested ones included; aliases and
 * module-qualified names resolve to the command they run; and its parameter
 * binder names what each word binds to, whatever prefix (`-r`), colon
 * (`-Path:x`) or position spells it. A value reads as running would give it
 * where that only reads `$HOME` or an environment variable, through quotes,
 * `$()`, `@()` and parentheses; any other is `?`, and a single-quoted `$`
 * stays a character. A hashtable the command assigns and then splats is read
 * as parameters, and the PowerShell a command gives `powershell` or `pwsh`
 * to run (`-Command`, `-EncodedCommand`) is read too. It never runs any part
 * of a command, and loads no module beyond `Remove-Item`'s. One request per
 * line, answered in order with the request's id; it ends when its input
 * closes.
 */
const script = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$in = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
$out = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
function Get-Value($variable) {
  $path = $variable.VariablePath
  if ($path.DriveName -eq 'env') { $value = [Environment]::GetEnvironmentVariable($path.UnqualifiedPath); if ($null -eq $value) { return '' }; return $value }
  switch ($path.UserPath) { 'HOME' { return $HOME } 'true' { return 'True' } 'false' { return 'False' } }
  return $null
}
function Get-Expressions($ast) {
  $statements = if ($ast -is [System.Management.Automation.Language.ParenExpressionAst]) { @($ast.Pipeline) } else { @($ast.SubExpression.Statements) }
  $expressions = @()
  foreach ($statement in $statements) {
    if (-not ($statement -is [System.Management.Automation.Language.PipelineAst] -and $statement.PipelineElements.Count -eq 1 -and
        $statement.PipelineElements[0] -is [System.Management.Automation.Language.CommandExpressionAst])) { return $null }
    $expressions += $statement.PipelineElements[0].Expression
  }
  return ,$expressions
}
function Get-Read($ast) {
  if ($ast -is [System.Management.Automation.Language.VariableExpressionAst]) { return Get-Value $ast }
  if ($ast -is [System.Management.Automation.Language.SubExpressionAst]) {
    $expressions = Get-Expressions $ast
    if ($null -ne $expressions -and $expressions.Count -eq 1) { return Get-Read $expressions[0] }
  }
  return $null
}
# A double-quoted string rebuilt from its source, never evaluated: an escape can hide a subexpression from NestedExpressions,
# so a literal part with an escape ([char]96, the backtick) is not stated.
function Get-Expanded($ast) {
  # A bare word has no quotes around it; a here-string is not read.
  $quote = switch ($ast.StringConstantType) { 'DoubleQuoted' { 1 } 'BareWord' { 0 } default { -1 } }
  if ($quote -lt 0) { return '?' }
  $text = $ast.Extent.Text; $base = $ast.Extent.StartOffset; $at = $quote; $value = ''
  foreach ($nested in @($ast.NestedExpressions | Sort-Object { $_.Extent.StartOffset })) {
    $read = Get-Read $nested
    $literal = $text.Substring($at, $nested.Extent.StartOffset - $base - $at)
    if ($null -eq $read -or $literal.Contains([char]96)) { return '?' }
    $value += $literal + $read
    $at = $nested.Extent.EndOffset - $base
  }
  $literal = $text.Substring($at, $text.Length - $quote - $at)
  if ($literal.Contains([char]96)) { return '?' }
  return $value + $literal
}
function Get-Words($ast) {
  if ($null -eq $ast) { return ,@('True') }
  if ($ast -is [System.Management.Automation.Language.CommandParameterAst]) {
    if ($null -eq $ast.Argument) { return ,@('-' + $ast.ParameterName) }
    return ,@(@('-' + $ast.ParameterName) + @(Get-Words $ast.Argument))
  }
  if ($ast -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return ,@($ast.Value) }
  if ($ast -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) { return ,@(Get-Expanded $ast) }
  if ($ast -is [System.Management.Automation.Language.ConstantExpressionAst]) { return ,@([string]$ast.Value) }
  if ($ast -is [System.Management.Automation.Language.VariableExpressionAst]) { $value = Get-Value $ast; if ($null -eq $value) { return ,@('?') }; return ,@($value) }
  if ($ast -is [System.Management.Automation.Language.ArrayLiteralAst]) { return ,@($ast.Elements | ForEach-Object { Get-Words $_ } | ForEach-Object { $_ }) }
  if ($ast -is [System.Management.Automation.Language.ParenExpressionAst] -or $ast -is [System.Management.Automation.Language.SubExpressionAst] -or
      $ast -is [System.Management.Automation.Language.ArrayExpressionAst]) {
    $expressions = Get-Expressions $ast
    if ($null -ne $expressions) { return ,@($expressions | ForEach-Object { Get-Words $_ } | ForEach-Object { $_ }) }
  }
  return ,@('?')
}
# The parameter a splatted hashtable key binds on Remove-Item, by the prefixes and aliases PowerShell accepts.
function Get-SplatKey($key) {
  foreach ($name in @('Recurse', 'LiteralPath', 'Path')) { if ($key.Length -gt 0 -and $name.StartsWith($key, 'OrdinalIgnoreCase')) { return $name } }
  if ($key -eq 'PSPath' -or $key -eq 'LP') { return 'LiteralPath' }
  return $key
}
# Every command in $source, and in the PowerShell it gives powershell or pwsh to run, to three levels.
function Add-Commands($source, $depth, $commands) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { return $false }
  # Hashtables assigned in the command, which a splat (@name) passes as parameters.
  $tables = @{}
  foreach ($assignment in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
    $right = $assignment.Right
    if ($assignment.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
        $right -is [System.Management.Automation.Language.CommandExpressionAst] -and $right.Expression -is [System.Management.Automation.Language.HashtableAst]) {
      $tables[$assignment.Left.VariablePath.UserPath] = $right.Expression
    }
  }
  foreach ($command in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    $name = $command.GetCommandName()
    if ($null -ne $name) {
      $found = Get-Command -Name ([WildcardPattern]::Escape(($name -replace '^.*\\', ''))) -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($null -ne $found -and $found.CommandType -eq 'Alias') { $found = $found.ResolvedCommand }
      if ($null -ne $found) { $name = $found.Name }
    }
    $parameters = @{}
    try {
      $bound = [System.Management.Automation.Language.StaticParameterBinder]::BindCommand($command, $true)
      foreach ($key in $bound.BoundParameters.Keys) { $parameters[$key] = Get-Words $bound.BoundParameters[$key].Value }
    } catch { }
    foreach ($splat in @($command.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.VariableExpressionAst] -and $_.Splatted })) {
      $table = $tables[$splat.VariablePath.UserPath]
      if ($null -eq $table) { continue }
      foreach ($pair in $table.KeyValuePairs) {
        $value = $pair.Item2
        $words = if ($value -is [System.Management.Automation.Language.PipelineAst] -and $value.PipelineElements.Count -eq 1 -and
          $value.PipelineElements[0] -is [System.Management.Automation.Language.CommandExpressionAst]) { Get-Words $value.PipelineElements[0].Expression } else { ,@('?') }
        $parameters[(Get-SplatKey ((Get-Words $pair.Item1)[0]))] = $words
      }
    }
    $elements = @($command.CommandElements | Select-Object -Skip 1)
    $arguments = @($elements | ForEach-Object { Get-Words $_ } | ForEach-Object { $_ })
    $commands.Add([PSCustomObject]@{ name = $name; parameters = $parameters; arguments = $arguments }) | Out-Null
    if ($depth -lt 3 -and $null -ne $name -and $name -match '^(powershell|pwsh)(\.exe)?$') {
      for ($k = 0; $k -lt $elements.Count; $k++) {
        $element = $elements[$k]
        if (-not ($element -is [System.Management.Automation.Language.CommandParameterAst])) { continue }
        $given = if ($null -ne $element.Argument) { $element.Argument } elseif ($k + 1 -lt $elements.Count) { $elements[$k + 1] } else { $null }
        $text = if ($null -eq $given) { '?' } else { (Get-Words $given)[0] }
        if ($text -eq '?') { continue }
        if ('Command'.StartsWith($element.ParameterName, 'OrdinalIgnoreCase')) {
          if (-not (Add-Commands $text ($depth + 1) $commands)) { return $false }
        } elseif ($element.ParameterName.Length -gt 1 -and 'EncodedCommand'.StartsWith($element.ParameterName, 'OrdinalIgnoreCase')) {
          if (-not (Add-Commands ([System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($text))) ($depth + 1) $commands)) { return $false }
        }
      }
    }
  }
  return $true
}
# Reading a command loads no module beyond PowerShell's own two it uses, Remove-Item's among them: no module code runs to read a command.
Import-Module Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility
$PSModuleAutoLoadingPreference = 'None'
# Each request is its id and the command in base64; each answer echoes the id, so an answer can't be taken for another's.
while ($null -ne ($line = $in.ReadLine())) {
  $id, $payload = $line -split ' ', 2
  try {
    $commands = [System.Collections.ArrayList]::new()
    if (-not (Add-Commands $utf8.GetString([Convert]::FromBase64String($payload)) 0 $commands)) { $out.WriteLine('{"id":"' + $id + '","ok":false}'); continue }
    $out.WriteLine((ConvertTo-Json -Compress -Depth 6 @{ id = $id; ok = $true; commands = @($commands) }))
  } catch { $out.WriteLine('{"id":"' + $id + '","ok":false}') }
}
`;

/** How long an answer may take: the first waits for PowerShell to start, which takes seconds on a loaded machine. */
const firstLimitMs = 15_000;
const limitMs = 5_000;

interface Parser {
  readonly child: ChildProcessWithoutNullStreams;
  /** The requests sent and not answered yet, oldest first: answers come in order, each naming its request's id. */
  readonly waiting: { readonly id: number; readonly resolve: (answer: readonly ParsedCommand[] | undefined) => void }[];
  answered: boolean;
  next: number;
  /** Ends the parser, answering every waiting request with nothing; the next request starts another. */
  readonly end: () => void;
}

/** One parser for each PowerShell, kept while this process runs; a parser that fails or stalls is replaced on the next request. */
const parsers = new Map<string, Parser>();

function started(executable: string): Parser {
  const found = parsers.get(executable);
  if (found !== undefined) return found;
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const parser: Parser = { child, waiting: [], answered: false, next: 0, end: () => {
    if (parsers.get(executable) === parser) parsers.delete(executable);
    for (const { resolve } of parser.waiting.splice(0)) resolve(undefined);
    child.kill();
  } };
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      parser.answered = true;
      const answered = parser.waiting[0];
      // A line that isn't the oldest request's answer means the stream can no longer be trusted to pair answers with commands.
      if (answered === undefined || answerId(line) !== String(answered.id)) { parser.end(); return; }
      parser.waiting.shift();
      answered.resolve(commandsOf(line));
    }
  });
  child.stderr.resume();
  child.on("error", parser.end);
  child.on("exit", parser.end);
  // A parser that dies while a request is written ends here, not as an error nothing handles.
  child.stdin.on("error", parser.end);
  // Nothing waits on the parser to end: it ends with this process, when its input closes.
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
  parsers.set(executable, parser);
  return parser;
}

/** The request id an answer names, or nothing when the line is not an answer. */
function answerId(line: string): string | undefined {
  try {
    const { id } = JSON.parse(line) as { id?: unknown };
    return typeof id === "string" ? id : undefined;
  } catch { return undefined; }
}

/** The commands an answer gives, or nothing when PowerShell could not read the command or the answer is not one. */
function commandsOf(line: string): readonly ParsedCommand[] | undefined {
  try {
    const answer = JSON.parse(line) as { ok?: unknown; commands?: unknown };
    if (answer.ok !== true || !Array.isArray(answer.commands)) return undefined;
    const words = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((word) => word !== null).map(String);
    return answer.commands.map((command: { name?: unknown; parameters?: unknown; arguments?: unknown }) => ({
      name: typeof command.name === "string" ? command.name : null,
      parameters: Object.fromEntries(Object.entries(typeof command.parameters === "object" && command.parameters !== null ? command.parameters : {})
        .map(([key, value]) => [key, words(value)])),
      arguments: words(command.arguments ?? []),
    }));
  } catch { return undefined; }
}

/**
 * `command` as the PowerShell at `executable` reads it, or nothing when it
 * can't: the command doesn't parse, the parser can't start, or it doesn't
 * answer within its limit, which ends it. The floor then reads the command's
 * text as it did before (#697).
 */
export function parsePowerShell(executable: string, command: string): Promise<readonly ParsedCommand[] | undefined> {
  const parser = started(executable);
  const id = parser.next++;
  return new Promise((resolve) => {
    const timer = setTimeout(parser.end, parser.answered ? limitMs : firstLimitMs);
    parser.waiting.push({ id, resolve: (answer) => { clearTimeout(timer); resolve(answer); } });
    parser.child.stdin.write(`${id} ${Buffer.from(command, "utf8").toString("base64")}\n`, (error) => {
      if (error !== null && error !== undefined) parser.end();
    });
  });
}
