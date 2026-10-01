import { expect, it } from "vitest";
import { recordSections, resultSections } from "../src/tesota-shell-result.js";

it("splits a record at its own headings, the Checks section apart for its tab", () => {
  const record = "Your requests\n  1. Fix it\n\nChecks\n  ✓ passed: npm test\n\nReview\n  advisor\n    Looks right";
  expect(recordSections(record).map((section) => section.split("\n", 1)[0])).toEqual(["Your requests", "Checks", "Review"]);
  expect(resultSections(record)).toEqual({ review: "Your requests\n  1. Fix it\n\nReview\n  advisor\n    Looks right",
    checks: "Checks\n  ✓ passed: npm test" });
  expect(recordSections("")).toEqual([]);
});

it("keeps a saved request's unindented lines with it, as records saved before they were kept under its number have them", () => {
  // As a record saved then holds a request of several paragraphs: its lines at the left edge, one after a blank line.
  const saved = "Your requests\n  1. Redesign the explorer.\nThe selected item fills its block.\n\nTarget design (monochrome):\n" +
    "  C:\\Proyectos  114.4 GB\n\nAcceptance\n- npm test passes\n\nFiles\n  modified src/render.ts\n\nReview\n  None";
  const sections = recordSections(saved);
  expect(sections.map((section) => section.split("\n", 1)[0])).toEqual(["Your requests", "Files", "Review"]);
  expect(sections[0]).toBe("Your requests\n  1. Redesign the explorer.\n     The selected item fills its block.\n\n" +
    "     Target design (monochrome):\n  C:\\Proyectos  114.4 GB\n\n     Acceptance\n     - npm test passes");
});
