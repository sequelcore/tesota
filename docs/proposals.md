# Task proposals

Repository discovery gives the model a bounded, read-only view of one committed
baseline. It can answer a question, ask one necessary clarification or submit a
non-authoritative proposal. Discovery cannot edit files, run repository code,
approve work or create execution authority.

## Use

After [authentication](authentication.md), build Tesota and run:

```sh
bun start
bun start task propose "Change the task result without altering its public contract"
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

When an interactive discovery tool fails, the shell stops that request and shows
only an allowlisted tool name and failure category. It does not print the model's
arguments, repository paths, Git stderr or raw exception text. The category
helps distinguish invalid arguments, denied reads, missing evidence and
unavailable backends; it is not a retry permission or evidence that a proposed
change was checked. Failed discovery creates no proposal record.

## Retained evidence

Only a completed proposal result creates
`~/.tesota/proposals/<uuid>/proposal.json`. The private versioned record binds:

- the operator request and committed baseline;
- model and configured transport identity;
- observed operations and limits;
- proposed objective, completion conditions and read/write set, plus the fixed
  check pair Tesota selected from the proposed file scope; and
- working-tree conflicts known at proposal time.

Its authority is `none` and its provenance is `model_proposed`. Editing retained
JSON cannot grant access, execution, acceptance or promotion. Admission reparses
the record and rechecks its source, status, baseline, paths and supported policy.
Retention now labels a proposal with an unsupported source/check combination
`blocked_scope` before the shell offers approval. This is a structural preview,
not an execution grant: admission independently rechecks the current policy.
Older retained `ready` records are not rewritten and still fail admission when
their proposed scope is unsupported.

## Supported admission

The model proposes files and completion conditions; it does not select a check.
Tesota derives the fixed pair from the proposed file scope, records and shows it
before approval, and independently rechecks the pair during admission.

The original policy accepts one or two existing non-test, non-declaration
TypeScript writes below `src/`, up to eight allowed reads and exactly
`scope-integrity` followed by `typescript-no-emit/v1`. A separate variant
accepts one existing TypeScript source file plus one existing
`tests/**/*.test.ts` regression file, with the exact pair approved and
`scope-integrity` followed by `node-test-targeted/v1`. Its source file may live
outside `src/`, but scripts and check configuration remain excluded. Every
write file must also be readable. Dependency declarations, general test edits,
create/delete/rename effects, stale baselines, dirty admitted paths, sensitive
paths and all other write shapes fail before candidate creation.

```sh
bun start task start <proposal-id>
```

The shell invokes this seam directly for a ready supported proposal, so normal
interactive use does not require copying an identifier. The operator sees the
objective, files, baseline and evidence limitation before deciding whether to
start. A start journal is created before that decision so the declined outcome
is retained. Declining records `scope_declined` and creates no candidate or
execution authority.

Once approved, the [task contract](tasks.md) owns execution, review and guarded
promotion. A proposal that is structurally ready is not necessarily correct,
accepted or guaranteed executable after the later baseline and policy checks.
