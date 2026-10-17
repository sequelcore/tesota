import { provideHost } from "../src/host.js";
import { piHost } from "../src/pi-host.js";

/**
 * The root tests run Tesota as Pi does, with Pi's editor, key names, version
 * and shell (#446), without loading the rest of Tesota before a test mocks it.
 */
provideHost(piHost);
