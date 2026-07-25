// SPDX-License-Identifier: MPL-2.0
/**
 * Turns the Penpot file's own library into the design tokens the chart tool
 * already knows how to read.
 *
 * This is the whole "on-brand without asking" story, and it works because the
 * tool meets us halfway. `tools/d3/hooks.js` (resolveBrandSpectrum) walks
 * `host.tokens.colors()` and takes every swatch under `color.spectrum.*` as its
 * categorical palette, falling back to its own shipped hues when there isn't
 * one. And two of its inputs default to `{color.semantic.surface}` /
 * `{color.semantic.text}` aliases rather than hardcoded hexes. So a token doc
 * with those paths filled in from the user's library is all it takes — no patch
 * to the tool, and it still behaves identically on lolly.tools.
 *
 * The hook needs at least FOUR spectrum swatches before it will trust one (a
 * two-colour library is more likely an accident than a palette). A real library
 * that falls short is topped up with perceptually distinct colours anchored on
 * its first swatch, so a brand with one or two colours still charts in its own
 * hues instead of silently reverting to SUSE green.
 */
import { createTokenSet } from '@engine/tokens.ts';
import { makeColorApi } from '@engine/color-tools.ts';
import type { TokenSet } from '@lolly-tools/core/host-v1';
import type { LibraryColorInfo } from '../messages.ts';

const color = makeColorApi();

/** Below this the hook ignores the spectrum entirely (hooks.js:394). */
const MIN_SPECTRUM = 4;
/** Past this the hook stops reading, so there's nothing to gain by sending more. */
const MAX_SPECTRUM = 10;

/** Penpot's own panel colours, used as the surface/text fallback when the file's
 *  library doesn't nominate any. Matches the filters plugin so a chart opens
 *  looking like the editor around it. */
export const PENPOT_SURFACE: Record<'light' | 'dark', { surface: string; text: string }> = {
  light: { surface: '#ffffff', text: '#0a0a0a' },
  dark: { surface: '#18181a', text: '#ffffff' },
};

export interface TokenSources {
  theme: 'light' | 'dark';
  /**
   * Whether to emit `color.spectrum.*` at all.
   *
   * False is what makes manual styling work rather than merely look like it
   * does: with a spectrum present the hook ALWAYS prefers it, so the tool's own
   * `palette` select would be a dead control. Withholding the spectrum drops the
   * hook back to its shipped palettes, which is exactly what that select picks
   * between.
   */
  includeSpectrum: boolean;
  /** Library colours, in library order, already filtered to solid hexes. */
  colors: LibraryColorInfo[];
  /** Library colour ids the user picked for the chart's paper and ink. Null =
   *  follow the Penpot theme. */
  surfaceId: string | null;
  textId: string | null;
  /** Library colour ids the user excluded from the series palette. */
  excluded: ReadonlySet<string>;
}

/** A DTCG path segment: lowercase, dot-free, and unique within the document. */
function slugify(raw: string, taken: Set<string>): string {
  const base =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'color';
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

/**
 * The ordered series palette: the library's own colours first, deduplicated by
 * value, then top-ups only if the library is too short for the hook to accept.
 *
 * Deduplication is by hex, not by id — a library routinely carries the same
 * black under several names (Text, Ink, Border), and three identical series in a
 * chart is worse than three fewer colours.
 */
export function spectrumFor(sources: TokenSources): string[] {
  if (!sources.includeSpectrum) return [];

  const seen = new Set<string>();
  const spectrum: string[] = [];

  for (const c of sources.colors) {
    if (sources.excluded.has(c.id)) continue;
    // Paper and ink are structural, not series colours — a bar the colour of the
    // background is invisible, and one the colour of the axis text reads as chrome.
    if (c.id === sources.surfaceId || c.id === sources.textId) continue;
    const hex = c.color.toLowerCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    spectrum.push(hex);
    if (spectrum.length >= MAX_SPECTRUM) return spectrum;
  }

  if (spectrum.length === 0 || spectrum.length >= MIN_SPECTRUM) return spectrum;

  // Short but real: extend it rather than lose it. `distinct` walks outward from
  // the anchor in OKLab, and the ΔE floor keeps a top-up from landing on a hue
  // the library already uses.
  for (const g of color.distinct(20, { anchorHex: spectrum[0] })) {
    if (spectrum.length >= MIN_SPECTRUM) break;
    if (spectrum.every((v) => color.deltaE(v, g) >= 0.05)) spectrum.push(g);
  }
  return spectrum;
}

/** Which library colour (if any) the user nominated for a semantic slot. */
function pick(sources: TokenSources, id: string | null): string | null {
  if (!id) return null;
  return sources.colors.find((c) => c.id === id)?.color ?? null;
}

/**
 * Build the DTCG document.
 *
 * `color.spectrum.*` names each entry after its library swatch so a designer
 * inspecting the tokens sees their own vocabulary. The hook only reads values
 * and path prefixes, so the names are for humans.
 */
export function buildTokenDoc(sources: TokenSources): unknown {
  const swatch = (hex: string) => ({ $type: 'color', $value: hex });

  const taken = new Set<string>();
  const byValue = new Map<string, LibraryColorInfo>();
  for (const c of sources.colors) {
    const hex = c.color.toLowerCase();
    if (!byValue.has(hex)) byValue.set(hex, c);
  }

  const spectrum: Record<string, unknown> = {};
  for (const hex of spectrumFor(sources)) {
    const from = byValue.get(hex);
    // Top-ups have no library swatch behind them; name them by position so they
    // read as generated rather than as something the user can go and edit.
    const label = from ? `${from.path} ${from.name}`.trim() : `extended-${Object.keys(spectrum).length + 1}`;
    spectrum[slugify(label, taken)] = swatch(hex);
  }

  const fallback = PENPOT_SURFACE[sources.theme];
  const surface = pick(sources, sources.surfaceId) ?? fallback.surface;
  const text = pick(sources, sources.textId) ?? fallback.text;
  // The tool has no `{color.semantic.primary}` input, but the hook resolves it as
  // the anchor when it tops a short spectrum up itself. Give it the real lead
  // colour so that path agrees with ours.
  const primary = Object.values(spectrum)[0] ?? null;

  return {
    color: {
      spectrum,
      semantic: {
        surface: swatch(surface),
        text: swatch(text),
        ...(primary ? { primary } : {}),
      },
    },
  };
}

export function buildTokenSet(sources: TokenSources): TokenSet {
  return createTokenSet(buildTokenDoc(sources));
}

export { color as colorApi };
