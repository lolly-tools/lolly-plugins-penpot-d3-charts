// SPDX-License-Identifier: MPL-2.0
/**
 * The Styling section — where the file's own library meets the chart.
 *
 * Two modes, and the difference between them is not cosmetic:
 *
 *   Library — the panel emits the file's colours as `color.spectrum.*` tokens
 *     and the tool's hook adopts them as its categorical palette. The tool's own
 *     palette/background/text controls are hidden, because with a spectrum
 *     present the hook ignores the palette select entirely and leaving a dead
 *     control on screen is worse than not showing it.
 *   Manual — no spectrum is emitted, so the hook falls back to its shipped
 *     palettes and every one of those controls does what it says.
 *
 * Library mode is the default whenever the file has any solid colour in a
 * library, which is the "don't force it on me" half of the brief: an on-brand
 * chart with nothing to configure, and one radio away from full manual control.
 */
import type { LibraryColorInfo, LibraryTypographyInfo } from '../messages.ts';

export interface StylingState {
  mode: 'library' | 'manual';
  /** Library colour ids nominated as the chart's paper and ink. */
  surfaceId: string | null;
  textId: string | null;
  /** Library colour ids kept out of the series palette. */
  excluded: Set<string>;
  /** Family name for chart text, or null to leave the chart's own default. */
  fontFamily: string | null;
}

export interface StylingContext {
  colors: LibraryColorInfo[];
  typographies: LibraryTypographyInfo[];
  /** Families Penpot can resolve, for the manual picker. */
  fonts: string[];
}

/** Starting state for a freshly opened panel. Library mode only if there's a
 *  library to follow; a file with no swatches would otherwise open in a mode
 *  whose controls are all hidden and whose effect is invisible. */
export function initialStyling(ctx: StylingContext): StylingState {
  return {
    mode: ctx.colors.length ? 'library' : 'manual',
    surfaceId: null,
    textId: null,
    excluded: new Set(),
    fontFamily: ctx.typographies[0]?.fontFamily ?? null,
  };
}

/**
 * Reconcile state against a library that changed under the panel.
 *
 * A colour the user nominated as paper can be deleted from the library while the
 * panel is open; left dangling, the token doc would silently fall back to the
 * theme colour with the picker still showing the old choice.
 */
export function reconcile(state: StylingState, ctx: StylingContext): StylingState {
  const ids = new Set(ctx.colors.map((c) => c.id));
  return {
    ...state,
    surfaceId: state.surfaceId && ids.has(state.surfaceId) ? state.surfaceId : null,
    textId: state.textId && ids.has(state.textId) ? state.textId : null,
    excluded: new Set([...state.excluded].filter((id) => ids.has(id))),
    // A font the user picked stays picked even if its typography token is gone —
    // the family may well still exist in Penpot's font list.
    fontFamily: state.fontFamily,
  };
}

/** The label a swatch shows: its Penpot folder path, when it has one. */
function swatchLabel(c: LibraryColorInfo): string {
  return c.path ? `${c.path} / ${c.name}` : c.name;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const el = document.createElement('label');
  el.className = 'row';
  const name = document.createElement('span');
  name.className = 'row-label';
  name.textContent = text;
  el.append(name, control);
  return el;
}

function colorSelect(
  colors: LibraryColorInfo[],
  selected: string | null,
  placeholder: string,
  onPick: (id: string | null) => void,
): HTMLElement {
  const el = document.createElement('select');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = placeholder;
  el.append(none);
  for (const c of colors) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${swatchLabel(c)} — ${c.color}`;
    el.append(o);
  }
  el.value = selected ?? '';
  el.addEventListener('change', () => onPick(el.value || null));
  return el;
}

export interface StylingHandlers {
  /** A change that only affects the token document — the caller remounts. */
  onChange(next: StylingState): void;
  /** Ask the sandbox to re-read the file's libraries. */
  onRefresh(): void;
}

/**
 * Render the section.
 *
 * Returns a detached element; the caller owns placement and rebuild timing, the
 * same contract as renderControls.
 */
export function renderStyling(
  state: StylingState,
  ctx: StylingContext,
  handlers: StylingHandlers,
  open: boolean,
  onToggle: (open: boolean) => void,
): HTMLElement {
  const details = document.createElement('details');
  details.className = 'group styling';
  details.open = open;
  details.addEventListener('toggle', () => onToggle(details.open));

  const summary = document.createElement('summary');
  summary.textContent = 'Styling';
  details.append(summary);

  const change = (patch: Partial<StylingState>) => handlers.onChange({ ...state, ...patch });

  // ── source ──────────────────────────────────────────────────────────────────
  const modes = document.createElement('div');
  modes.className = 'segmented';
  for (const mode of ['library', 'manual'] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = mode === 'library' ? 'Project library' : 'Manual';
    btn.className = state.mode === mode ? 'active' : '';
    btn.disabled = mode === 'library' && ctx.colors.length === 0;
    if (btn.disabled) btn.title = 'This file has no library colours yet.';
    btn.addEventListener('click', () => {
      if (state.mode !== mode) change({ mode });
    });
    modes.append(btn);
  }
  details.append(labelled('Colours from', modes));

  if (state.mode === 'library') {
    const note = document.createElement('p');
    note.className = 'muted note';
    const usable = ctx.colors.filter(
      (c) => c.id !== state.surfaceId && c.id !== state.textId && !state.excluded.has(c.id),
    );
    const distinct = new Set(usable.map((c) => c.color)).size;
    note.textContent =
      distinct >= 4
        ? `${distinct} library colours drive the series palette.`
        : distinct > 0
          ? `${distinct} library colour${distinct === 1 ? '' : 's'} — the chart extends them to four so a short palette still reads as yours.`
          : 'No colours left for the series — the chart falls back to its own palette.';
    details.append(note);

    details.append(
      labelled(
        'Background',
        colorSelect(ctx.colors, state.surfaceId, 'Follow Penpot theme', (id) =>
          change({ surfaceId: id }),
        ),
      ),
    );
    details.append(
      labelled(
        'Text & axes',
        colorSelect(ctx.colors, state.textId, 'Follow Penpot theme', (id) =>
          change({ textId: id }),
        ),
      ),
    );

    // ── which swatches are in the series ──────────────────────────────────────
    if (ctx.colors.length) {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';
      for (const c of ctx.colors) {
        const structural = c.id === state.surfaceId || c.id === state.textId;
        const off = structural || state.excluded.has(c.id);

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `swatch${off ? ' is-off' : ''}`;
        chip.style.setProperty('--swatch', c.color);
        chip.title = structural
          ? `${swatchLabel(c)} — in use as background or text`
          : `${swatchLabel(c)}${off ? ' — click to include' : ' — click to exclude'}`;
        chip.disabled = structural;
        chip.addEventListener('click', () => {
          const excluded = new Set(state.excluded);
          if (excluded.has(c.id)) excluded.delete(c.id);
          else excluded.add(c.id);
          change({ excluded });
        });
        wrap.append(chip);
      }
      details.append(labelled('Series colours', wrap));
    }
  }

  // ── typography ──────────────────────────────────────────────────────────────
  const families = new Set<string>();
  for (const t of ctx.typographies) families.add(t.fontFamily);
  // In manual mode the whole of Penpot's font list is on offer; in library mode
  // only the families the file's own text styles actually use, which is the
  // point of following the library.
  if (state.mode === 'manual') for (const f of ctx.fonts) families.add(f);

  const font = document.createElement('select');
  const inherit = document.createElement('option');
  inherit.value = '';
  inherit.textContent = 'Chart default';
  font.append(inherit);
  for (const f of [...families].sort((a, b) => a.localeCompare(b))) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f;
    font.append(o);
  }
  font.value = state.fontFamily ?? '';
  font.addEventListener('change', () => change({ fontFamily: font.value || null }));
  details.append(labelled('Typeface', font));

  const fontNote = document.createElement('p');
  fontNote.className = 'muted note';
  // Worth saying plainly: the panel has no access to Penpot's font files, so the
  // preview substitutes. The placed shape is the one that matters and it gets
  // the real face.
  fontNote.textContent = state.fontFamily
    ? `Preview substitutes a system face; the chart lands on the board set in ${state.fontFamily}.`
    : 'The chart keeps its own typeface.';
  details.append(fontNote);

  // ── refresh ─────────────────────────────────────────────────────────────────
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'ghost wide';
  refresh.textContent = 'Reload library';
  refresh.title = 'Pick up colours or text styles added since the panel opened.';
  refresh.addEventListener('click', () => handlers.onRefresh());
  details.append(refresh);

  return details;
}
