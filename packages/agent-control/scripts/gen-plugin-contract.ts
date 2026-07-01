// SPDX-License-Identifier: Apache-2.0

/**
 * REQ-027 generator: serialize the TS source-of-truth {@link PLUGIN_CONTRACT}
 * to the committed, Go-embeddable JSON. Run via `pnpm run gen:plugin-contract`
 * (also folded into `gen:clients`). The TS drift test fails if the committed
 * JSON differs from a fresh serialization of the live object.
 *
 * The JSON lives INSIDE the Go package dir so `go:embed` can reach it (embed
 * cannot traverse `../`).
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_CONTRACT } from '../src/plugin-contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(
  HERE,
  '../../spellguard-cli/internal/plugin/plugin-contract.json',
);

// Strict JSON (no comment banner) so both `JSON.parse` and Go's `encoding/json`
// accept it. The DO-NOT-EDIT provenance lives in the .ts source + the drift test.
writeFileSync(OUT, `${JSON.stringify(PLUGIN_CONTRACT, null, 2)}\n`, 'utf-8');
process.stdout.write(`Wrote plugin contract → ${OUT}\n`);
