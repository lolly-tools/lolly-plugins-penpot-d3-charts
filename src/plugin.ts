// SPDX-License-Identifier: MPL-2.0
/**
 * Sandbox side of the plugin. Runs inside Penpot's plugin sandbox: no DOM, no
 * canvas — so this file stays a thin proxy. All the real work (parse the table →
 * run D3 → hydrate an SVG) happens in the panel iframe.
 *
 * The one thing only this side can do is read the file's libraries. Those
 * colours and text styles are what make a chart come out on-brand without the
 * user dialling anything in, so they're pushed to the panel on open and again
 * whenever the board changes underneath it.
 */
import type {
  PluginToUi,
  UiToPlugin,
  LibraryColorInfo,
  LibraryTypographyInfo,
  SelectionInfo,
} from './messages.ts';

penpot.ui.open('Lolly Charts', `?theme=${penpot.theme}`, {
  width: 460,
  height: 780,
});

function send(message: PluginToUi): void {
  penpot.ui.sendMessage(message);
}

// ── reading the file's libraries ───────────────────────────────────────────────

/** Penpot hands colours back in whatever form the swatch was authored — a solid
 *  `#rrggbb`, a gradient, or an image fill. Only solids can become a chart
 *  colour, so the rest are dropped rather than guessed at. */
function isSolidHex(value: string | undefined): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function readLibraries(): {
  colors: LibraryColorInfo[];
  typographies: LibraryTypographyInfo[];
} {
  const colors: LibraryColorInfo[] = [];
  const typographies: LibraryTypographyInfo[] = [];

  // Local first, then connected: the file's own swatches should lead the
  // categorical palette, with a shared design-system library filling in behind.
  const libraries = [penpot.library.local, ...penpot.library.connected];

  for (const lib of libraries) {
    for (const c of lib.colors) {
      if (!isSolidHex(c.color)) continue;
      colors.push({
        id: c.id,
        name: c.name,
        path: c.path ?? '',
        color: c.color.toLowerCase(),
        library: lib.name,
      });
    }
    for (const t of lib.typographies) {
      typographies.push({
        id: t.id,
        name: t.name,
        path: t.path ?? '',
        fontFamily: t.fontFamily,
        fontWeight: t.fontWeight,
        fontStyle: t.fontStyle === 'italic' ? 'italic' : 'normal',
        library: lib.name,
      });
    }
  }

  return { colors, typographies };
}

/** Distinct family names Penpot can resolve, for the manual font picker. The
 *  panel can't render most of them (their faces live in Penpot, not here), but
 *  a name Penpot knows is a name it will honour on the placed shape. */
function fontFamilies(): string[] {
  const seen = new Set<string>();
  for (const f of penpot.fonts.all) {
    if (f.fontFamily) seen.add(f.fontFamily);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function summarizeSelection(): SelectionInfo[] {
  return penpot.selection.map((s) => ({
    id: s.id,
    name: s.name,
    width: s.width,
    height: s.height,
  }));
}

// ── panel messages ─────────────────────────────────────────────────────────────

penpot.ui.onMessage<UiToPlugin>(async (msg) => {
  if (msg.type === 'ready') {
    const { colors, typographies } = readLibraries();
    send({
      type: 'init',
      theme: penpot.theme,
      colors,
      typographies,
      fonts: fontFamilies(),
      selection: summarizeSelection(),
    });
    return;
  }

  if (msg.type === 'refresh-library') {
    const { colors, typographies } = readLibraries();
    send({ type: 'library', colors, typographies });
    return;
  }

  if (msg.type === 'place-svg') {
    const { requestId, svg, name } = msg;
    try {
      // WithImages, not the sync variant: a chart is pure vector today, but the
      // async call handles both and costs nothing here — one await on a path the
      // user already waited for.
      const group = await penpot.createShapeFromSvgWithImages(svg);
      if (!group) throw new Error('Penpot rejected the SVG.');
      group.name = name;

      // Beside the selection with a one-gutter gap when there is one, otherwise
      // centred in the viewport — never dropped on top of the user's work.
      const anchor = penpot.selection[0] ?? null;
      if (anchor) {
        group.x = anchor.x + anchor.width + 24;
        group.y = anchor.y;
      } else {
        const { center } = penpot.viewport;
        group.x = center.x - group.width / 2;
        group.y = center.y - group.height / 2;
      }
      penpot.selection = [group];
      send({ type: 'placed', requestId, name: group.name });
    } catch (e) {
      send({ type: 'error', requestId, message: String((e as Error)?.message ?? e) });
    }
  }
});

penpot.on('selectionchange', () => {
  send({ type: 'selection', selection: summarizeSelection() });
});

penpot.on('themechange', (theme) => {
  send({ type: 'theme', theme: theme as 'light' | 'dark' });
});
