# Lolly Charts — a Penpot plugin

Paste a table, get a vector chart on your board. 28 chart types drawn by D3,
coloured from your own library rather than someone else's brand.

Everything runs in your browser. No account, no upload, no network call — the
data you paste never leaves the tab.

Install from:

```
https://lolly-tools.github.io/lolly-plugins-penpot-d3-charts/manifest.json
```

Penpot → **Plugins** → **Plugin manager** → paste the URL → Install.

---

## What it does

Copy cells straight out of Excel, Google Sheets or Numbers — they arrive as a
clean table, no fiddling with commas — or type CSV, TSV, semicolons, pipes.
The first row is headers, the first text column becomes the labels, and every
numeric column becomes a series. Pick a chart type. Press **Add to canvas**.

The chart lands as real Penpot shapes: paths, rects and text you can move,
recolour and export like anything else you drew.

**Chart types.** Bar (vertical and horizontal), line, area, scatter, pie, donut,
radial bar, radar, treemap, pack, heatmap, histogram, lollipop, dumbbell, slope,
bump, stream, waterfall, marimekko, parallel, polar, funnel, gauge, waffle,
sunburst, icicle, chord.

## Styling: your library, or your call

This is the part worth explaining, because it's the reason the plugin exists.

### Project library (the default)

If your file has library colours, the chart uses them — no configuration. The
panel reads `penpot.library.local` plus any connected libraries and hands them
to the chart as design tokens, and the chart adopts them as its series palette.
Add a swatch to your library and press **Reload library**; the chart follows.

You can also nominate one swatch as the **background** and another as **text &
axes**, and click any swatch to keep it out of the series (a border grey rarely
makes a good bar). Both default to following Penpot's own light/dark theme, so
the panel looks like the editor around it out of the box.

**A short library still works.** The chart wants at least four colours before it
trusts a palette. With fewer, the plugin extends yours with perceptually
distinct hues anchored on your first colour, so a two-colour brand still charts
in its own family instead of silently reverting to the shipped green.

**Your colour may shift slightly.** The chart keeps marks legible against the
paper: a fill that doesn't clear a WCAG 3:1 contrast floor gets nudged until it
does. A bright yellow on white typically lands a shade or two deeper. That's the
chart's own guard, applied identically on [lolly.tools][lolly] — not something
this plugin adds. If you need the exact hex, switch to Manual and set it there.

### Manual

Switch to **Manual** and the library steps out of the way: the chart's own
palette picker and colour wells come back and do exactly what they say. It's a
real mode switch, not a cosmetic one — the plugin stops emitting the library
palette entirely, which is what puts the built-in palettes back in charge.

### Typography

Pick a typeface from your library's text styles (or, in Manual, from every font
Penpot knows). The placed chart carries that family name, so Penpot resolves the
real face.

The **preview** substitutes a system font. The panel is a sandboxed iframe with
no access to Penpot's font files, so it can't render your brand face — only name
it. The shape on the board is the one that counts, and it gets the real thing.

---

## How it fits together

The chart isn't reimplemented here. It's the **D3 Chart Studio** tool from
[lolly.tools][lolly], copied into this bundle byte-for-byte and run through the
Lolly engine's own loader and runtime. A chart behaves identically in this panel
and on the website, and it stays that way because nothing in this repo patches
the tool.

```
src/
  plugin.ts          sandbox side — reads the file's libraries, places the SVG
  messages.ts        the typed protocol between the two halves
  ui/
    main.ts          wiring: library → tokens → runtime → preview → canvas
    tokens.ts        Penpot library → DTCG design tokens
    host.ts          the HostV1 capability bridge (tokens + colour maths)
    preview.ts       D3 preload, template-script execution, SVG read-back
    styling.ts       the library/manual section
    controls.ts      the tool's inputs as panel controls
```

Two pieces are worth reading before changing anything:

**`ui/tokens.ts` — the coupling that makes this work.** The chart's hook already
walks `host.tokens.colors()` and prefers any swatch under `color.spectrum.*`
over its shipped palette, and two of its colour inputs default to
`{color.semantic.surface}` / `{color.semantic.text}` aliases. So "use the
project's colours" needs no patch to the tool — just a token document with those
paths filled in. That's an undeclared contract between two repos: nothing in
either would fail to compile if the hook stopped looking, so the smoke test
asserts it directly.

**`ui/preview.ts` — why the preview isn't just `innerHTML`.** A Lolly filter's
template is finished markup; this one is an empty SVG shell plus an inline
`<script>` that runs D3. Scripts inserted via `innerHTML` are inert by spec, so
they're cloned into executable nodes after insertion — the same thing the Lolly
web shell does for these templates. The payoff beyond a working preview: the
drawn chart is real DOM, so **Add to canvas** serialises exactly what you're
looking at.

The same file also explains why D3 is preloaded rather than left to the
template's own loader (short version: the template hardcodes an absolute path
that's correct on lolly.tools and 404s under a GitHub Pages project subpath;
preloading makes its loader short-circuit before it gets there).

---

## Building it

Needs a sibling checkout of [`lolly-tools/lolly`][lollyrepo] — the engine is
imported from source and the tool is copied out of `tools/d3`. There's no
published package for either yet.

```
../
  lolly/                             ← sibling checkout
  lolly-plugins-penpot-d3-charts/    ← this repo
```

```sh
npm install
npm run dev        # panel at localhost:5173, tool served from the lolly tree
npm run build      # → dist/
npm run preview    # build + serve dist/ on :4404
npm run typecheck
npm run smoke      # build + headless mount test
```

Point `LOLLY_DIR` elsewhere if your checkout isn't a sibling.

### Testing it in Penpot locally

```sh
npm run preview
```

then install `http://localhost:4404/manifest.json` in the plugin manager. The
preview server sends `Access-Control-Allow-Origin: *`, which is what Penpot's
loader needs.

### The smoke test

`npm run smoke` mounts the tool through the real loader and runtime and checks
the seams between this repo and lolly — that every input the panel names still
exists, that every input still carries the `section` the panel groups by, and
that the token contract above holds in both directions (library colours reach
the chart in library mode, and are withheld in manual mode).

It can't check the chart itself: all 28 types are drawn by D3 in a browser the
test doesn't have. A green run means "the two repos still agree", not "the chart
looks right".

## Deploying

Push to `main`. The workflow clones lolly beside this repo, builds, typechecks,
smoke-tests, and publishes `dist/` to GitHub Pages. One-time repo setting:
Settings → Pages → Source: **GitHub Actions**.

## Licence

MPL-2.0. The bundled D3 Chart Studio tool and the Lolly engine are covered by
the [lolly][lollyrepo] repository's own licence; D3 itself is ISC.

[lolly]: https://lolly.tools
[lollyrepo]: https://github.com/lolly-tools/lolly
