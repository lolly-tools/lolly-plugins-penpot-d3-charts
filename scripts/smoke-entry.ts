// SPDX-License-Identifier: MPL-2.0
/**
 * Headless smoke test for the tool-mounting path: load the chart tool through
 * the engine's own loader, mount a runtime against the panel's host bridge, and
 * assert it hydrates.
 *
 * What this CAN'T cover: the chart. Every one of the 28 types is drawn by D3 in
 * the template's inline <script>, which needs a DOM and never runs here — so a
 * pass means "loader, manifest validation, hook compilation, host bridge and
 * hydration all agree", not "the chart looks right". The latter needs the panel
 * in a browser.
 *
 * What it DOES cover that matters most: the token contract. The panel's whole
 * on-brand story rests on the tool's hook reading `color.spectrum.*` out of
 * host.tokens and preferring it over its shipped palette. That's an undeclared
 * coupling between two repos — nothing in either would fail to compile if the
 * hook stopped looking — so it is asserted directly, by mounting with a known
 * spectrum and checking the colours reach the hydrated output.
 *
 * Bundled by scripts/smoke.sh (esbuild) and run under Node.
 */
import { loadTool } from '@engine/loader.ts';
import { createRuntime } from '@engine/runtime.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createHost } from '../src/ui/host.ts';
import { LEAD_INPUTS, PANEL_OWNED, PINNED_INPUTS } from '../src/ui/controls.ts';
import type { LibraryColorInfo } from '../src/messages.ts';

// From the runner, not import.meta.url — the bundle lands in node_modules/.cache,
// nowhere near dist/.
const TOOLS = resolve(process.env.TOOLS_DIR ?? 'dist/tools');
const TOOL_ID = 'chart';

const readToolFile = (path: string): Promise<string> =>
  Promise.resolve(readFileSync(resolve(TOOLS, path), 'utf8'));

/** A library the panel would build a spectrum from — four distinct hues, so the
 *  hook's own minimum is met without the top-up path muddying the assertion. */
const LIBRARY: LibraryColorInfo[] = [
  { id: '1', name: 'Ink', path: 'Brand', color: '#123456', library: 'Test' },
  { id: '2', name: 'Coral', path: 'Brand', color: '#ee5566', library: 'Test' },
  { id: '3', name: 'Moss', path: 'Brand', color: '#33aa77', library: 'Test' },
  { id: '4', name: 'Sun', path: 'Brand', color: '#ffbb22', library: 'Test' },
];

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const tool = await loadTool(TOOL_ID, readToolFile);

// Every id the panel drives by name must actually exist in the manifest — a
// renamed input would otherwise vanish from the panel silently. The lists come
// from the panel's own constants, so this cannot drift from what it renders.
const inputs = tool.manifest.inputs ?? [];
const declared = new Set(inputs.map((i) => i.id));
const placed = new Set([...LEAD_INPUTS, ...PANEL_OWNED, ...Object.keys(PINNED_INPUTS)]);
const named = [...placed, 'heading', 'palette', 'background', 'textColor'];
const missing = named.filter((id) => !declared.has(id));
check(`manifest declares every input the panel names (${declared.size} inputs)`, missing.length === 0, missing.join(', '));

/** Would the panel's pinned values hide this input outright? */
function hiddenByPin(showIf: Record<string, unknown> | undefined): boolean {
  if (!showIf) return false;
  return Object.entries(PINNED_INPUTS).some(([key, pinned]) => {
    if (!(key in showIf)) return false;
    const want = showIf[key];
    return Array.isArray(want) ? !want.includes(pinned) : want !== pinned;
  });
}

// The panel builds its sections straight off `section`, so an input without one
// renders nowhere unless the panel places it by hand. Two ways to be legitimate:
// the panel places or pins it, or the panel's pinned renderer hides it through
// its own showIf. Anything else the tool adds unsectioned is a control the user
// can never reach, which is exactly what this catches.
const stranded = inputs
  .filter((i) => !i.section && !placed.has(i.id) && !hiddenByPin(i.showIf))
  .map((i) => i.id);
check(
  'every input carries a section, or the panel places, pins or hides it',
  stranded.length === 0,
  stranded.join(', '),
);

// ── mounts at all ─────────────────────────────────────────────────────────────

const bare = createHost();
const bareRuntime = await createRuntime(tool, bare, { ...PINNED_INPUTS });
const bareOut = bareRuntime.getHydrated();
check('hydrates to an <svg>', bareOut.includes('<svg'));
check('template carries its render script', bareOut.includes('<script'));

// ── the token contract ────────────────────────────────────────────────────────

const branded = createHost();
branded.setTokens({
  theme: 'light',
  includeSpectrum: true,
  colors: LIBRARY,
  surfaceId: null,
  textId: null,
  excluded: new Set(),
});
const brandedRuntime = await createRuntime(tool, branded, { ...PINNED_INPUTS });
const brandedOut = brandedRuntime.getHydrated();

// The hook folds the resolved spectrum into cfg.brandPalette, which rides into
// the template as the JSON `_state` blob — so the library's hexes appear in the
// hydrated output verbatim when, and only when, the hook picked them up.
const carried = LIBRARY.filter((c) => brandedOut.toLowerCase().includes(c.color));
check(
  `library colours reach the chart (${carried.length}/${LIBRARY.length})`,
  carried.length === LIBRARY.length,
  'the tool\'s hook may have stopped reading color.spectrum.* — see src/ui/tokens.ts',
);

// The mirror image: manual styling withholds the spectrum so the tool's own
// palette select is live again. If the hexes still showed up here, the mode
// toggle would be decorative.
const manual = createHost();
manual.setTokens({
  theme: 'light',
  includeSpectrum: false,
  colors: LIBRARY,
  surfaceId: null,
  textId: null,
  excluded: new Set(),
});
const manualOut = (await createRuntime(tool, manual, { ...PINNED_INPUTS })).getHydrated();
check(
  'manual styling withholds the library palette',
  !LIBRARY.some((c) => manualOut.toLowerCase().includes(c.color)),
);

// Nominating a background swatch must reach the chart's paper, which is the
// `{color.semantic.surface}` alias resolving through our token set.
const papered = createHost();
papered.setTokens({
  theme: 'light',
  includeSpectrum: true,
  colors: LIBRARY,
  surfaceId: '1',
  textId: null,
  excluded: new Set(),
});
const paperedOut = (await createRuntime(tool, papered, { ...PINNED_INPUTS })).getHydrated();
check('a nominated background colour reaches the chart', paperedOut.toLowerCase().includes('#123456'));

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nChart tool mounts cleanly and the token contract holds.');
