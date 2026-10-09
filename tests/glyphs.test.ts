import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { packageRoot } from "./pi-themes.js";

/** The modules that draw the footer, the receipt and send-back cards, and `prove`'s results, with the words they show. */
const drawn = ["src/footer.ts", "src/messages.ts", "src/prove-tool.ts", "src/receipt.ts"];

it("draws only symbols one cell wide, with no emoji presentation", () => {
  for (const file of drawn) {
    const symbols = new Set([...readFileSync(join(packageRoot, file), "utf8")].filter((char) => char.codePointAt(0)! > 0x7f));
    for (const symbol of symbols) {
      // A pictograph such as ⚠ is one cell to Pi but a two-cell color emoji in Windows Terminal, covering what follows it.
      expect(/\p{Extended_Pictographic}/u.test(symbol), `${file} draws ${symbol}, a pictograph`).toBe(false);
      expect(visibleWidth(symbol), `${file} draws ${symbol}`).toBe(1);
    }
  }
});

it("rejects the pictographs a terminal may draw as emoji", () => {
  for (const pictograph of ["⚠", "✔", "❗", "⭐"]) expect(/\p{Extended_Pictographic}/u.test(pictograph)).toBe(true);
  for (const glyph of ["✓", "✗", "!", "○", "◐", "●", "↺", "◇", "…", "—", "·", "→"]) {
    expect(/\p{Extended_Pictographic}/u.test(glyph)).toBe(false);
  }
});
