// SPDX-License-Identifier: MPL-2.0
/**
 * Typed message protocol between the sandboxed plugin (plugin.ts, no DOM) and
 * the panel UI iframe (src/ui/, full DOM).
 *
 * Everything crossing the boundary is structured-clone friendly — plain objects
 * and primitives. The sandbox is the only side that can read the file's library,
 * so the project's colours and typographies are pushed across as plain data and
 * turned into design tokens on the panel side (see ui/tokens.ts).
 */

export type Theme = 'light' | 'dark';

/** One colour from the file's own library or a connected one. */
export interface LibraryColorInfo {
  /** Library element id — stable, and what the panel keys its token paths on. */
  id: string;
  name: string;
  /** Penpot's folder path for the swatch ("Brand/Primary"), or ''. */
  path: string;
  /** Solid colour as `#rrggbb`. Gradient and image fills are dropped upstream. */
  color: string;
  /** Which library it came from — the local one is listed first. */
  library: string;
}

/** One text style from the file's own library or a connected one. */
export interface LibraryTypographyInfo {
  id: string;
  name: string;
  path: string;
  fontFamily: string;
  fontWeight: string;
  fontStyle: 'normal' | 'italic';
  library: string;
}

/** What the panel needs to know about the board's current selection — used only
 *  to decide where a placed chart lands. */
export interface SelectionInfo {
  id: string;
  name: string;
  width: number;
  height: number;
}

export type PluginToUi =
  | {
      type: 'init';
      theme: Theme;
      colors: LibraryColorInfo[];
      typographies: LibraryTypographyInfo[];
      /** Font families Penpot can actually resolve, for the manual font picker. */
      fonts: string[];
      selection: SelectionInfo[];
    }
  | { type: 'theme'; theme: Theme }
  | { type: 'selection'; selection: SelectionInfo[] }
  | {
      type: 'library';
      colors: LibraryColorInfo[];
      typographies: LibraryTypographyInfo[];
    }
  | { type: 'placed'; requestId: number; name: string }
  | { type: 'error'; requestId: number; message: string };

export type UiToPlugin =
  | { type: 'ready' }
  /** Re-read the file's libraries — the user edited them while the panel was open. */
  | { type: 'refresh-library' }
  /** Drop a finished chart onto the board. */
  | {
      type: 'place-svg';
      requestId: number;
      svg: string;
      name: string;
    };
