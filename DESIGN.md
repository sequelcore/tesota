---
name: Tesota
description: A coding agent that checks its code, challenges its specs, and flags where they may miss your request.
colors:
  ledger-black: '#0f0f10'
  ledger-paper: '#fafafa'
  ink-dark: '#ededed'
  ink-light: '#18181b'
  muted-dark: '#a1a1a8'
  muted-light: '#52525b'
  dim-dark: '#808088'
  dim-light: '#6b6b73'
  signal-dark: '#919cf0'
  signal-light: '#4a55c0'
  pass-dark: '#7fb685'
  pass-light: '#2f6f3e'
  heed-dark: '#e0a84f'
  heed-light: '#8f5a0a'
  fail-dark: '#e5847d'
  fail-light: '#b3372f'
  band-dark: '#18181a'
  band-light: '#f0f0f2'
  selection-dark: '#27272b'
  selection-light: '#e4e4e7'
  rule-dark: '#42424a'
  rule-light: '#c8c8ce'
typography:
  emphasis:
    fontFamily: "the terminal's own monospace"
    fontWeight: 700
  body:
    fontFamily: "the terminal's own monospace"
    fontWeight: 400
components:
  input-band-dark:
    backgroundColor: '{colors.band-dark}'
    textColor: '{colors.ink-dark}'
  input-band-light:
    backgroundColor: '{colors.band-light}'
    textColor: '{colors.ink-light}'
  selected-row-dark:
    backgroundColor: '{colors.selection-dark}'
    textColor: '{colors.ink-dark}'
  selected-row-light:
    backgroundColor: '{colors.selection-light}'
    textColor: '{colors.ink-light}'
---

# Design System: Tesota

This page owns how Tesota's terminal looks and why. The values live in
[`themes`](themes) and [`terminal-schemes`](terminal-schemes); the frontmatter
above mirrors them for tools that read this format. When the two differ, the
theme files are what ships, and this page needs updating.

## Overview

**Creative North Star: "The Notary's Ledger"**

Every run ends in a record you can trust. The screen is a ledger: quiet,
exact, kept in neutral ink, and marked only where something departs from
normal, the way a notary marks the one line that needs attention. Nothing
on it is decoration. Color, motion and weight each mean something, and
mean the same thing everywhere.

Tesota is a tool that asks people to trust its receipt, so it looks calm
rather than playful. It borrows its restraint from Linear and T3 Code:
neutral grays, one accent used rarely, hierarchy through weight and space
instead of color, and few borders. Its soul is in a few chosen places: the
wordmark, the working orb, and the plain, honest words of the receipt.

**Key Characteristics:**

- Neutral ink on a near-black or near-white canvas.
- One accent, Signal, for what you act on and what a model thinks.
- Green, amber and red only for how a check ended.
- The input is the only filled surface.
- Evidence behind a solid rule, opinion behind a dotted one.

## Colors

Neutral ink with one indigo voice; status colors are words, not decoration.

### Primary

- **Signal** (dark `signal-dark`, light `signal-light`): Tesota's one voice.
  It marks where you act (the selected choice, a question's bar, sessions
  waiting for you), what a model thinks (an opinion's `◇`, "1 opinion to
  read"), the receipt's title, and the working orb while Tesota verifies.

### Neutral

- **Ledger Black / Ledger Paper** (`ledger-black`, `ledger-paper`): the
  canvas the themes are drawn for. The terminal schemes set it.
- **Ink** (`ink-dark`, `ink-light`): what you read: replies, your messages,
  the receipt's summary.
- **Muted** (`muted-dark`, `muted-light`): what supports the ink: method
  rows' details, the footer, a passing check's glyph.
- **Dim** (`dim-dark`, `dim-light`): what you can skip: the acceptance line,
  a method that recorded nothing, Details.
- **Band** (`band-dark`, `band-light`): the input's fill, the only filled
  surface.
- **Rule** (`rule-dark`, `rule-light`): the receipt's left rule.

### Status

- **Pass** (`pass-dark`, `pass-light`): a verified receipt's head, once, in
  the footer. Never on every passing line.
- **Heed** (`heed-dark`, `heed-light`): something needs you: a flag, a
  limit, a gap, a run sent back.
- **Fail** (`fail-dark`, `fail-light`): a check that ran and failed.

### Named Rules

**The One Voice Rule.** Signal is the only accent. If a new element wants
color, it says either "act here", "a model thinks this" or "Tesota is
verifying"; otherwise it is neutral.

**The Words, Not Paint Rule.** Pass, Heed and Fail describe how a check
ended and nothing else. A passing line stays neutral; the summary and the
footer say it passed. Color marks only what departs from normal.

**The Readable Floor Rule.** Every text color reaches 4.5:1 on the canvas
and in the input band, in both appearances. `tests/welcome-header.test.ts`
enforces it.

## Typography

**Body Font:** the terminal's own monospace. Tesota never sets a font.

**Character:** weight carries hierarchy; size is not available, and color is
reserved for meaning.

### Hierarchy

- **Emphasis** (bold): what leads a block: the receipt's title and its
  departing counts, a method's name, an opinion's verdict, the wordmark.
- **Body** (regular, ink): what you read.
- **Support** (regular, muted): details beside what they support.
- **Aside** (regular, dim): what you can skip until you need it.

### Named Rules

**The Weight Before Color Rule.** To make something lead, make it bold or
move the rest to muted or dim. Reach for color only when it means something.

## Layout

The screen has two routes. On the **home** route, while a session is empty,
the welcome block (the `tesota` wordmark, its version and folder, and one
greeting) sits centered with the input directly under it, and the footer
stays at the bottom. On the **session** route, from the first message on,
the conversation fills the screen and the input sits above the footer.
Neither the welcome nor any live decoration enters scrollback.

There is no header row; the model and folder live in the footer. The footer
is one row: on the left the evidence, read as a sentence with `·` between
its parts; on the right the folder, the model, the context's use and the
statuses, as separate pieces of data three spaces apart. The proved rule in
`src/verification/footer-rule.ts` decides what a narrow terminal drops.

Blocks keep a one-column margin. A blank row separates a turn's request,
its tool calls, its answer and its receipt.

## Elevation & Depth

Flat by default. Depth comes from tone, not from fills or shadows: ink
leads, muted and dim recede. The only filled surface is the input band, so
the eye always finds where to type. The receipt has no panel; a one-column
rule at its left edge holds it together.

### Named Rules

**The One Fill Rule.** Only the input is filled. A new block is held by a
rule, a blank row or a heading, never by a background.

## Shapes

Square terminal cells, no radii. Rules are one column wide: `│` beside
evidence, `┆` beside a model's opinion. A question that needs an answer
takes a heavier bar (`▌`) in Signal, or in Heed when it asks for approval.

## Components

### Input band

- **Style:** a full-width band in Band, with a `›` prompt and the hint
  `/ for commands · @ for files`.
- **Without background colors:** a plain row with the prompt.

### Receipt

The signature component: the record each run ends with.

- **Structure:** the title `Tesota receipt` in bold Signal; the counts; the
  acceptance line in dim ("Evidence, not approval: accepting the change is
  yours."); one row per method; what needs review and the limits, grouped
  by reason; the models' opinions apart; then Details.
- **Counts:** only the parts that depart from normal take color (a failure
  in Fail, flags and limits in Heed); each "no …" part is muted. An opinion
  worth reading is named at the end in Signal (`1 opinion to read`) and is
  never counted as a flag or a limit.
- **Methods:** a passing method's `✓` is muted; a method that recorded
  nothing (`○`) is dim, still listed so what wasn't checked is said.
- **Opinions:** behind the dotted rule. Each leads with what the model
  said, in bold (`Covers only part of the request`), then who said it and
  about what in dim (`ClaimCheck · total · src/total.ts`), then its reason
  in muted.
- **While verifying:** the same rule holds the live ledger, `Verifying` in
  Signal and the title in dim.

### Working orb

- **Form:** a lit sphere in half blocks, four columns by two rows, so its
  pixels are square and it is round; its edge blends into the canvas.
- **Motion by phase:** every motion says what the run is doing.
  - The model working: it turns; the lit side sweeps left to right (2.4 s).
  - Tesota verifying: a bright band scans it top to bottom, in Signal
    (1.6 s, the fastest, so the wait feels shorter).
  - Compacting: it condenses and recovers (2.0 s).
  - Retrying: a slow, dim pulse; nothing moves (3.2 s).
- **Beside it:** the label on the first row, its detail on the second.
- **Without extended colors:** a still silhouette in the terminal's own
  color.
- **Owner:** `src/working-orb.ts`.

### Welcome

- **Wordmark:** `tesota` in lowercase block letters, ink, four rows; where
  it does not fit, `Tesota` in bold.
- **Under it:** the version in dim, then the folder in muted.
- **Greeting:** one per session, muted, calm, a question, without naming
  the folder: "What should we work on?", "What are we changing today?",
  "Where should we start?", "What needs fixing?", "What do you want
  checked?".
- **Owner:** `src/welcome-header.ts`.

### Footer

- **Left:** the evidence; only its first part (`✓ receipt`, `● ready`) takes
  a status color, the rest muted.
- **Right:** the folder and model in dim, the context's use in muted (Heed
  above 70%, Fail above 90%), the permission mode in muted, and sessions
  waiting for you in Signal.

## Do's and Don'ts

### Do:

- **Do** keep every new color to one of the meanings above: act, opinion,
  verifying, or how a check ended.
- **Do** say what wasn't checked, in dim, rather than hiding it.
- **Do** give each motion a meaning: a new phase gets its own motion, not a
  new color on the same one.
- **Do** check new text colors against the 4.5:1 floor in both appearances.
- **Do** regenerate the README images (`bun run --cwd packages/core
  screenshots`) when the screen changes.

### Don't:

- **Don't** tint surfaces. The canvas, the receipt and your messages stay
  unfilled; only the input is filled.
- **Don't** color passing lines green. One green per receipt, in the footer.
- **Don't** count an opinion as evidence, or color it like a check.
- **Don't** add a mark, mascot or header row without a decision recorded
  here first.
- **Don't** animate decoration. A motion that says nothing doesn't ship.
