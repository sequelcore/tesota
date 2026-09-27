# General work landscape (September 2026)

How agents built for coding are used, and extended, for everyday work that is
not code: documents, spreadsheets, presentations, research, and actions on
live systems. It prepares a design pass on Tesota's direction as a
general-purpose harness (decisions 012 and 013). Researched on 2026-09-26
from first-party product pages and documentation, the published source of
Anthropic's document skills, two studies of AI citations, OWASP's and W3C's
specifications, NIST's publication page, and the text of Mexico's general
law on personal data held by public bodies. OpenAI's and Axios's pages refuse
automated readers, so Codex's usage figures below come from secondary reports
and are marked so.

## Where the question comes from

The operator and a first real user described what they use agents for.
She works in public administration, in planning,
budgets, events and archive management, with web portals, Excel files, PDFs,
presentations, research and documents. He uses Codex for code, and also to
manage and monitor a VPS, drive Blender through MCP, audit a PC, transcribe
audio and research a match. Their work falls into three kinds, which this
record uses throughout:

| Kind | What the person gets | Examples |
| --- | --- | --- |
| **A change** to files | New or edited files to accept or reject | Code, a budget spreadsheet, a presentation, an organized archive |
| **An answer** | Information, with where it came from | Research, reading a set of PDFs, a PC audit |
| **An action** on a live system | Something done outside the workspace | Managing a server, driving an application, transcribing audio |

Tesota today delivers only the first, for code in a Git repository.

## What other agents do

| Agent | How it reaches work beyond code |
| --- | --- |
| Claude Cowork (Anthropic, January 2026) | Claude's agent in the desktop app, for macOS, Windows and Linux: the person points it at folders, "give it a goal, and it works across your files and tools. You come back to polished work for your review." Connectors (Microsoft 365, Google Drive, Slack), plugins that bundle skills, connectors and agents by role or company, a separate browser, and scheduled tasks. "Claude shows each step: the files it opens, tools it uses, and choices it makes" ([product page](https://claude.com/product/cowork)) |
| Codex (OpenAI, 2026) | Repositioned as "for everyone, for any task done with a computer", with role-based onboarding, app connections, and work across documents, slides, spreadsheets, research and planning. Secondary reports put knowledge workers at about a fifth of Codex users by June 2026, growing faster than developers ([Latent Space](https://www.latent.space/p/ainews-agents-for-everything-else), [Axios](https://www.axios.com/2026/06/02/openai-codex-knowledge-workers)); not verified at the source |
| ChatGPT agent (OpenAI, July 2025) | Research and action in one agent: it "requests permission before taking actions of consequence", and in sensitive contexts, such as a signed-in email or bank, a "watch mode" pauses when the user stops watching ([announcement](https://openai.com/index/introducing-chatgpt-agent/), [system card](https://openai.com/index/chatgpt-agent-system-card/)) |
| Goose (Block) | A general agent from the start, extended through MCP. **Recipes**, "reusable workflows that package extensions, prompts, and settings together", are shared and launched with one click ([recipes](https://goose-docs.ai/docs/guides/recipes/)); a report attributes its spread to about 60% of Block to them ([report](https://the-agent-report.com/2026/05/block-goose-ai-agent-recipe-runner-scaled-60-percent/)) |
| OpenClaw, Hermes Agent | Personal assistants reached through chat apps (WhatsApp, Telegram and others), not a terminal or a repository (their READMEs at `866012f5be1` and `2a0d0bc69`) |

The common pattern: **the agent loop stays the same.** What changes around it
is the workspace (folders, not repositories), the surface (a desktop app or a
chat, not a terminal), formats and connectors (Office files, Drive, email),
and packaged tasks (plugins, recipes) that spare non-developers from writing
prompts.

## Changes to documents

Anthropic publishes the skills behind Claude's file creation, for Word, PDF,
PowerPoint and Excel: "source-available, not open source", shared "as a
reference" ([anthropics/skills](https://github.com/anthropics/skills)). They
apply the same discipline Tesota applies to code:

- **Word edits are tracked changes.** Every edit is wrapped in Word's own
  revision marks, with author and date, and a validator checks the result
  against the original so no change escapes tracking; the person reviews in
  Word, as a redline, or accepts all into a clean copy
  ([docx skill](https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md)).
- **Spreadsheets are recalculated before delivery.** Formulas written by a
  library have no computed values until LibreOffice recalculates them, and
  the rule is "Zero formula errors. Never ship while `recalc.py` reports
  `errors_found`." Its own caveat is Tesota's first principle: "A green recalc
  proves your formulas *evaluate*, not that they are *right*." Edits go only
  to the file's input cells, and existing formulas stay untouched
  ([xlsx skill](https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md)).
- **Output is looked at.** Documents are rendered to PDF and page images for
  a visual check.

A document's review therefore has a native form, the redline; its checks are
executable (recalculation, validation, rendering); and like code, a passing
check is not the conclusion.

## Answers with evidence

An answer's risk is its sources. The Tow Center gave eight AI search tools
1,600 queries in February 2025, each with an excerpt of a real article, and
asked for its headline, publisher, date and URL: collectively they "provided
incorrect answers to more than 60 percent of queries", from 37% for
Perplexity to 94% for Grok 3; ChatGPT misidentified 134 articles and
signalled doubt 15 times in 200; more than half of Gemini's and Grok 3's
answers cited fabricated or broken URLs ([CJR](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php)).
DeepTRACE, auditing deep-research modes statement by statement, found them
"highly one-sided on debate queries", with "large fractions of unsupported
statements" and citation accuracy "ranging from 40--80% across systems"
([arXiv 2509.04499](https://arxiv.org/abs/2509.04499)).

For an answer, evidence means that each claim is checked against the source
it cites, and that a claim no source supports is shown as such. That is the
check an operator most needs and the one these systems most often fail.

## Actions on live systems

OWASP's LLM06:2025, **Excessive Agency**, names the causes of harm from
agents that act: excessive functionality, permissions and autonomy. Its
mitigations are minimal and granular tools rather than open-ended ones,
least privilege, acting in the user's context, "human-in-the-loop controls
for significant actions", complete mediation, and logging and monitoring of
what tools do ([OWASP](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)).
ChatGPT agent's confirmations and watch mode are one product's form of the
same rules. NIST's Generative AI Profile (AI 600-1, 2024-07-26) is the US
reference for managing generative AI risk
([NIST](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence));
its full text was not reviewed here.

An action cannot be tried in a copy and applied later: its evidence is what
was done, to what, with whose approval, and what changed as a result.

## A shared vocabulary for evidence

W3C PROV (Recommendation, 2013-04-30) defines provenance as "information
about entities, activities, and people involved in producing a piece of data
or thing, which can be used to form assessments about its quality,
reliability or trustworthiness", with **entities**, **activities** and
**agents**, related by `used`, `wasGeneratedBy`, `wasDerivedFrom` and
`wasAttributedTo` ([PROV overview](https://www.w3.org/TR/prov-overview/)).
The three kinds of work map onto it: a change is an entity derived from the
workspace; an answer is an entity derived from its sources; an action is an
activity, attributed to the agent and to the person who approved it. Tesota's
assurance journal already records some of this for changes to code.

## Public-sector data in Mexico

The Ley General de Protección de Datos Personales en Posesión de Sujetos
Obligados was replaced on 2025-03-20 (last reform 2025-11-14;
[text](https://www.diputados.gob.mx/LeyesBiblio/pdf/LGPDPPSO.pdf)). It binds
"cualquier autoridad, entidad, órgano y organismo de los poderes ejecutivo,
legislativo y judicial … del ámbito federal, estatal y municipal" (Art. 3,
XXVII), so the staff of a state public body handle personal data under it.

- A provider that processes personal data for the body is a **persona
  encargada**, formalized by contract or legal instrument, bound among
  other things to process only as instructed, not for other purposes, to
  keep confidentiality, and to delete or return the data at the end
  (Art. 52 to 53).
- A cloud service accepted on standard terms may be used only if the
  provider, among other things, applies equivalent protection policies,
  discloses its subcontracting, does not claim ownership of the data, keeps
  it confidential, lets the body limit its processing, and guarantees its
  deletion; the body "no podrá adherirse a servicios que no garanticen la
  debida protección" (Art. 57 to 58).

A model whose provider may keep what it receives and train on it fails these
conditions. Whether a given paid provider meets them, and what the
body's own rules on external services require, are questions for the body,
not for Tesota; this record is not legal advice. State data protection laws
and their guarantors were not reviewed.

## What it implies for Tesota

1. **The gap is not the agent loop but what surrounds it.** Every general
   agent above runs the same loop Tesota runs; what they add is a workspace
   that is a folder, formats, connectors, a friendlier surface and packaged
   tasks.
2. **Tesota's thesis fits this work better than most.** Tracked changes,
   recalculation and claim-by-claim source checks are evidence of the kind
   Tesota already treats as first class, and the citation studies show that
   answers without them are unreliable.
3. **The three kinds of work need three kinds of result.** A change can keep
   Tesota's copy, checks, review and apply, with a document's native review
   form (a redline, a recalculated sheet, a rendered page). An answer needs
   its claims tied to sources and checked. An action needs approval before
   it happens and a record of what it did, since there is nothing to apply.
   How far one lifecycle can hold all three is the design question.
4. **Packaged tasks are how non-developers adopt agents.** Plugins and
   recipes carry instructions, tools and expected results; for Tesota they
   could also carry the checks that decide whether a result holds.
5. **Data rules decide the route before any feature.** For public-sector
   personal data, free models are excluded, and a route whose provider
   commits to processor terms is required; Tesota can show a route's data
   terms, as it does for free models, but cannot certify compliance.
6. **The surface matters for adoption but is the largest change.** Every
   product aimed at non-developers is an app or a chat. A terminal remains
   usable for a first user with help; the order of the rest should follow
   what real use shows.

## Open questions

- Whether one result lifecycle, extended with PROV's vocabulary, can serve
  changes, answers and actions, or each needs its own.
- How a folder without Git keeps Tesota's guarantees: a separate copy,
  review of exact content, and a guarded apply.
- Which document checks Tesota should own, and which belong to packaged tasks.
- What the first real tasks show, which should decide the order of work.
