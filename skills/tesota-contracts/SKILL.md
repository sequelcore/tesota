---
name: tesota-contracts
description: Write or change a LemmaScript //@ contract in a TypeScript project checked by Tesota, and answer what Tesota sends back about it. Use when a request asks to prove code or add a contract, when a file has //@ requires or //@ ensures lines, or when Tesota reports a failed proof, a contract that does not rule out changes to its code, or a weakened contract.
---

# Contracts in a project Tesota checks

Tesota proves every changed TypeScript file with `//@` contracts, using
LemmaScript and Dafny, before your work settles. It sends back what does not
hold, and lists anything that weakens the evidence in a receipt the operator
reads. This skill covers what Tesota adds; for LemmaScript itself (its
grammar, which functions are worth verifying, `lsc`), load the `lemmascript`
skill if it is available.

## Write the contract from the request

- Take each `//@ requires` and `//@ ensures` from what the request says the
  function must do, not from the code as it is: code you are fixing has the
  bug in it.
- Say what happens for every input the request covers. A contract that
  bounds the result without saying which result is right proves while the
  bug stays.
- When the request leaves a case open, such as a boundary value, ask the
  operator with a concrete case: this input, this expected result. Do not
  pick one silently; a contract that encodes a wrong rule still proves.
- Once a file has a contract, the `prove` tool is available. Run it after
  each change and work until it passes.

## What Tesota sends back, and what to do

- **The file does not prove yet.** Read the obligation that failed. Fix the
  code, or add the `//@ invariant` or assertion the proof needs.
- **The proof verified nothing.** The contract is not where LemmaScript reads
  it. Move it directly above the function, or before the first statement of
  an arrow function's block body.
- **The contract proves, but changes to its code prove too.** Each listed
  change is behavior the contract allows. If the request rules that behavior
  out, strengthen the `ensures` until the change fails the proof, and keep it
  provable. A change that behaves the same as the code needs nothing.
- **A command fails.** The project's own checks still apply: fix the cause.

## Never weaken the evidence to finish

Each of these is listed in the receipt as weakening the evidence, and the
operator decides whether it was justified:

- removing or changing a `//@ requires` or `//@ ensures`, or adding a
  `//@ requires` to a function that already existed;
- adding `//@ assume` or `//@ extern`, which take something on trust;
- adding `//@ skip`, or a `//@ verify` that leaves other functions out:
  once any function in a file has `//@ verify`, LemmaScript proves only
  those, and the rest are not proved at all;
- deleting a test, or editing one so that it checks less.

Change a contract only when the request asks for different behavior, and say
so in your summary. If a proof will not pass, say which obligation still
fails instead of weakening the contract.
