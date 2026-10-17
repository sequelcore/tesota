import { provideHost } from "./host.js";
import { piHost } from "./pi-host.js";
import tesota from "./tesota.js";

/**
 * Tesota's Pi extension, as Pi's manifest names it: Tesota itself
 * (`tesota.ts`), given Pi's editor, key names, version and shell (#446).
 * The engine's shell gives its own and loads `tesota.ts` directly. Temporary
 * until slice 11 of #432 removes Pi.
 */
provideHost(piHost);

export default tesota;
