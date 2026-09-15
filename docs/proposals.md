# Task proposals

Repository discovery gives the model a bounded, read-only view of one committed
baseline. It can answer a question, ask one necessary clarification or submit a
non-authoritative proposal. Discovery cannot edit files, run repository code,
approve work or create execution authority.

## Use

After [authentication](authentication.md), build Tesota and run:

```sh
bun start
bun start task propose "Clarify the installation guide"
```

The interactive shell chooses among an answer, one clarification or a proposal.
The explicit subcommand requires a proposal result. File names are optional
hints; the model must inspect every file it proposes to change.

The current live discovery boundary uses the current Git repository and the
configured Codex route. Execution remains limited by the supported admission
policy below.

## Discovery boundary

Tesota reads the named Git `HEAD` through fixed local Git operations. Model tools
can list allowed paths, search literal text, read allowed regular UTF-8 blobs and
submit one parsed result. Application-owned schemas bound file shapes, file and
scan sizes, exposed bytes, operations, model continuations and settlement.

Credential-like paths, redirects, binaries, oversized files and unsupported
path shapes are denied. Git configuration capable of executing clean filters,
external diffs or text conversions is rejected before discovery. The working
tree is observed only to identify conflicts with proposed read and write paths;
its bytes are not imported as model context.

## Retained evidence

Only a completed proposal result creates
`~/.tesota/proposals/<uuid>/proposal.json`. The private versioned record binds:

- the operator request and committed baseline;
- model and configured transport identity;
- observed operations and limits;
- proposed objective, completion conditions, read/write set and check; and
- working-tree conflicts known at proposal time.

Its authority is `none` and its provenance is `model_proposed`. Editing retained
JSON cannot grant access, execution, acceptance or promotion. Admission reparses
the record and rechecks its source, status, baseline, paths and supported policy.

## Supported admission

The current policy accepts one or two existing Markdown writes below `docs/`, up
to eight allowed reads and exactly the `scope-integrity` check. Every write file
must also be readable. Stale baselines, dirty admitted paths, sensitive paths and
all other write shapes fail before candidate creation.

```sh
bun start task start <proposal-id>
```

The shell invokes this seam directly for a ready supported proposal, so normal
interactive use does not require copying an identifier. The operator sees the
objective, files, baseline and evidence limitation before deciding whether to
start. Declining creates neither candidate nor start journal.

Once approved, the [task contract](tasks.md) owns execution, review and guarded
promotion. A proposal that is structurally ready is not necessarily correct,
accepted or executable.
