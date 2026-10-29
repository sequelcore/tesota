# The floor

Exactly what the permission floor refuses, and how it reads a command.
[Permissions](../guides/permissions.md) explains where it sits.

## What it refuses

- Writing outside the session's folder and its scratch folder. The refusal
  names the scratch folder; for the rest of that request, writing there is
  asked like any other change.
- Touching a secret: `.env` files, `~/.ssh` keys, and Tesota's sign-ins
  (`~/.tesota/auth.json`, `~/.tesota/mcp-auth.json`), by path or named in a
  command.
- Destroying a disk, the root or a home folder: `rm -rf /`,
  `Remove-Item -Recurse C:\`, `format`, `mkfs`, `dd` onto a disk, a fork
  bomb.

## Data, not commands

Quoted arguments in simple `rg`, `grep`, `Select-String` and `echo`
commands are data: `echo "rm -rf /"` isn't refused as a deletion. Only when
the whole line uses those commands with literal arguments; unknown
consumers, `rg --pre`, interpolation, escapes and redirection leave the
text to the floor. Secret names are still checked, and modes and rules
still apply.

## Home subfolders

A home subfolder isn't home: `Remove-Item (Join-Path $env:USERPROFILE 'sub\folder') -Recurse`
isn't refused as a whole-home deletion. A subpath that ends back at home
(`.`, `x/..`) or climbs above it (`../x`) still is. Only flat, parent-first
`Join-Path` pairs with literal children count, with or without `-Path` and
`-ChildPath`; dynamic children, wildcards and nested or unrecognized forms
exempt nothing in that command. Trailing dots and spaces don't make a
child folder, and ambiguous leading `..` segments count as parent steps.
Nothing is evaluated, expanded or resolved.

## PowerShell on Windows

The floor also reads each PowerShell command with PowerShell's own parser,
one process per session, started at its first command. A recursive
`Remove-Item` is refused when its path is a disk's root, a share's root,
the system folder, home or a folder holding it, however it's spelled: an
alias (`ri`, `rd`, `del`, `rm`) or module-qualified name, a parameter
prefix (`-r`) or colon (`-Path:$HOME`), a line continuation, `~`, `$HOME`,
`$env:NAME`, `\\?\`, a `FileSystem::` prefix, a wildcard such as `C:\*`, or
a splatted hashtable (`Remove-Item @p`).

Also refused: a command named only at run time (`& $rg -rf ~`) passing
recursion flags and naming such a folder, the same after `--%`, and cmd's
`rd`, `rmdir`, `del` and `erase` with `/s`, with `%NAME%` read. Commands
given to `powershell` or `pwsh` are read to three levels; text given to
`cmd` or `bash` is held to the patterns. The parser never runs any part of
a command, loads no module, and only reads `$HOME` and `$env:`. When it
can't parse or doesn't answer in time, the patterns alone decide; it only
ever adds refusals.

## After a refusal

The floor is a net of patterns, not a sandbox: it judges what a call names,
so a later call can reach the same effect another way, through a script,
a one-liner, another tool or a subagent. So after it refuses:

- The model is told the refusal covers the effect, not the command, that no
  one can allow it, and to say so or ask you if the work needs it.
- For the rest of the request, every command and change the mode or a rule
  would allow is asked first, even in full access, and refused with no one
  to ask. Reading isn't asked.
- The request's end lists each refused call, what it named and why, and
  how many its subagents had. The receipt lists them without what they
  named, and they don't change its [standing](../receipt-v2.md#standing).

These make each attempt visible and put it to you; they don't contain it.
