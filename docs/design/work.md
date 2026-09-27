# Work and results

**Planned; nothing here is built yet** (decision 032). This page describes
how Tesota is to carry work beyond code, for review before any of it is
built. Evidence is in the
[general work landscape](../research/general-work-landscape.md); what is
built today is in the other design pages.

Tesota's loop today delivers one kind of result: a change to a Git
repository, checked, reviewed and applied or rejected. A first real user
works in public administration, with planning, budgets, events and an
archive of Excel files, PDFs, presentations and documents, and the operator
also uses agents for research and for acting on live systems. Other agents
reach that work with the same loop and a different frame around it; Tesota
keeps its principles and extends what a result can be.

## Kinds of result

| Kind | What the person gets | Bound to | Evidence | The person's decision |
| --- | --- | --- | --- | --- |
| **Change** | Files changed in a copy | The snapshot's tree id, as today | Gates on that tree, review, refutation | Apply or reject |
| **Answer** | Claims, each pointing to its source | The saved copy of every source it used | Each claim checked against its source; unsupported and unchecked claims shown as such | Use it, knowing what held |
| **Action** | An effect outside the workspace | Its record: what, where, with whose approval, and what it returned | Approval before; a record and, where one exists, a check of the outcome after | Approve it before it happens |

- **The kind comes from what happened, not from a mode.** Files that changed
  make a change; facts the agent states from sources make an answer; a
  command that acts outside the workspace makes an action. One request can
  produce several, such as research that ends in an edited spreadsheet.
  There is no research, document or chat mode (decision 025 rejected modes).
- **The principles hold for every kind.** Evidence is bound to exact content
  and does not carry over when it changes; failures stay distinct from
  passes; gates, review, the person's decision and application are separate
  facts; model output never grants authority.
- **Records use W3C PROV's vocabulary.** A change and an answer are
  entities, derived from the workspace or from their sources; an action is an
  activity; each is attributed to the agent and to whoever approved it.

## Where the work happens

| Workspace | What it is | Results |
| --- | --- | --- |
| A repository | A Git repository, as today | Changes, answers, actions |
| A folder | Any folder. Tesota keeps a private Git store beside it, never inside it, so the copy, snapshots bound to a tree id and the guarded apply work unchanged, and the folder never becomes a repository | Changes, answers, actions |
| None | A session without a folder | Answers and actions |

A session without a folder is a conversation whose answers still carry their
sources and checks; it is not a separate product.

## Gates

A **gate** is how a result is verified, for any kind of work: a claim, what
it applies to, and how it is decided. Tesota's verifiers become its built-in
gates; people add their own per folder, and packaged tasks can carry theirs.

| Strength | Decided by | Example | Shown as |
| --- | --- | --- | --- |
| **Executable** | A command or a built-in check that observes the content | The tests pass; the spreadsheet recalculates with zero formula errors | What was observed, on which content |
| **Source-checked** | Each claim compared with the saved source it cites | Every total matches the invoice PDFs | Which claims held, which did not, which were not checked |
| **Judged** | A model's reading against a stated criterion, then refuted as findings are | The event plan names a date, a place, a budget and who is responsible | Advice, never proof |

Tesota's built-in gates stay on by default wherever they apply, as the code
verifiers are today, since they run only when relevant content changes
(operator's decision, 2026-09-26). A gate always says its strength, and a
weaker gate is never reported as a stronger one: a recalculation that passes shows that formulas evaluate, not
that they are right, and a judged gate is a reading.

## Documents

A changed document is reviewed in the form its readers know, and checked with
the same discipline as code, following the approach of Anthropic's document
skills:

- **Word:** the change as tracked changes (a redline), checked so that no
  edit escapes tracking.
- **Excel:** the cells that changed, and a recalculation with zero formula
  errors as an executable gate; edits keep existing formulas and formatting.
- **PDF and presentations:** their text, and pages rendered to images for a
  visual check.

Reviewers, the refuter and the correction loop work on these readable forms
as they do on a diff.

## Personal data

A folder can be marked as holding personal data. A route whose provider may
keep and train on what it receives then brings a **warning and a
suggestion**: the models the person can already reach whose terms do not
allow that, within what they can pay. Tesota never refuses: the choice of
model stays with the person and their budget (operator's decision,
2026-09-26). Tesota cannot certify that a provider meets a law, such as
Mexico's rules for public bodies' personal data; it shows the route's stated
terms.

## Actions

Built last. The rule is fixed now: anything that acts outside the workspace
needs approval before it happens, and leaves a record of what it did. Tools
beyond commands, such as MCP servers, come later.

## Order

1. **Folders and documents:** a folder as a workspace, readable review of
   Word, Excel, PDF and presentation changes, document gates, and gates
   people define. This serves reviewing documents and organizing files.
2. **Answers:** claims tied to their sources and checked, and sessions
   without a folder.
3. **Actions:** approval and a record for effects outside the workspace.

The first user's real tasks decide the order within each step. She uses the
terminal at first, helped with the installation; another surface comes only
if real use shows the terminal is the obstacle.

## Open questions

- How people write their gates, and how a packaged task carries them.
- The document tools' dependencies, such as LibreOffice for recalculation
  and rendering, and how Tesota provides them in the sandbox.
- How an answer is recorded in the journal, and how its sources are saved
  and bound.
