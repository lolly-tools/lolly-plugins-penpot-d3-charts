// SPDX-License-Identifier: MPL-2.0
/**
 * A minimal HostV1 capability bridge, scoped to what the D3 chart tool actually
 * reaches for.
 *
 * The web shell's bridge is a ~90 KB affair backed by IndexedDB, a render
 * pipeline and a network layer. None of that applies inside a Penpot panel: the
 * chart has no assets, no profile and no saved sessions, and export never runs —
 * the panel reads the drawn SVG out of its own preview and posts it to the
 * sandbox.
 *
 * Grepping `host.<something>` across tools/d3/hooks.js yields exactly two:
 * `host.tokens` (colors + resolve) and `host.color`. Everything else here exists
 * only because HostV1 declares it non-optional.
 *
 * `tokens` is the interesting one and the reason this plugin can be on-brand
 * without a single extra control — see ./tokens.ts.
 */
import { makeColorApi } from '@engine/color-tools.ts';
import type {
  HostV1, AssetQuery, AssetPickerOpts, Profile, TokenSet,
} from '@lolly-tools/core/host-v1';
import { buildTokenSet, PENPOT_SURFACE, type TokenSources } from './tokens.ts';

export interface ChartHost extends HostV1 {
  /** Rebuild the token set — the file's library changed, the user nominated a
   *  different paper colour, or Penpot switched theme. */
  setTokens(sources: TokenSources): void;
}

const unsupported = (what: string) => () =>
  Promise.reject(new Error(`${what} isn't available inside the Penpot panel.`));

export const EMPTY_SOURCES: TokenSources = {
  theme: 'light',
  includeSpectrum: false,
  colors: [],
  surfaceId: null,
  textId: null,
  excluded: new Set(),
};

export function createHost(initial: TokenSources = EMPTY_SOURCES): ChartHost {
  let tokens: TokenSet = buildTokenSet(initial);

  const host: ChartHost = {
    version: '1',
    shell: 'web',

    setTokens(sources) {
      tokens = buildTokenSet(sources);
    },

    log(level, msg, ctx) {
      // Tool logs are diagnostics, not user-facing. Keep them in the console so a
      // misbehaving chart is debuggable from the panel's devtools.
      const line = `[lolly-charts] ${msg}`;
      if (level === 'error') console.error(line, ctx ?? '');
      else if (level === 'warn') console.warn(line, ctx ?? '');
      else console.debug(line, ctx ?? '');
    },

    // Pure maths, identical across every shell — the engine's own implementation
    // is what the web shell attaches too. The hook uses distinct() + deltaE() to
    // top up a short brand spectrum.
    color: makeColorApi(),

    tokens: {
      get: () => Promise.resolve(tokens),
      colors: () => Promise.resolve(tokens.colors()),
      resolve: (ref: string) => Promise.resolve(tokens.resolve(ref)),
      themes: () => Promise.resolve(tokens.themes()),
    },

    profile: {
      // No profile inside Penpot; the chart never reads one.
      get: () => Promise.resolve({} as Profile),
      subscribe: () => () => {},
    },

    assets: {
      // A chart has no image inputs at all — every one of these is contract-only.
      get: (id: string) => Promise.reject(new Error(`Unknown asset "${id}".`)),
      query: (_filter: AssetQuery) => Promise.resolve([]),
      pick: (_opts: AssetPickerOpts) => Promise.resolve(null),
      isAvailable: () => Promise.resolve(false),
    },

    // `media` is optional on HostV1 and a chart has no camera path — left off
    // entirely rather than stubbed, so a tool that feature-detects it gets an
    // honest answer.

    compose: {
      // Composition means "render another Lolly tool as my image", which needs
      // lolly.tools. A panel that phoned home would break the plugin's promise
      // that nothing leaves the browser.
      renderUrl: () => Promise.resolve(null),
      render: unsupported('Composing another tool') as never,
    },

    state: {
      save: () => Promise.resolve(),
      load: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
    },

    clipboard: {
      writeText: (text: string) => navigator.clipboard.writeText(text),
      writeImage: unsupported('Copying images') as never,
    },

    export: {
      // Never called: the panel reads the drawn SVG out of the preview stage and
      // posts it to the sandbox, which is the whole delivery path.
      render: unsupported('Rendering') as never,
      download: unsupported('Downloading') as never,
      file: unsupported('Downloading') as never,
      imprint: unsupported('Imprinting') as never,
    },
  };

  return host;
}

export { PENPOT_SURFACE };
