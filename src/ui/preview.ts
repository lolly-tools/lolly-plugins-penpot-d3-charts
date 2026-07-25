// SPDX-License-Identifier: MPL-2.0
/**
 * Mounting the chart's hydrated template so it actually draws.
 *
 * This is the one place the chart plugin can't reuse the filters plugin's
 * approach. A filter's template.html is a single `{{{…Svg}}}` interpolation —
 * the hook has already produced finished markup, so `stage.innerHTML = hydrated`
 * is the whole preview. The chart's template is the opposite: an empty SVG shell
 * plus an inline `<script>` that runs D3 against a JSON `_state` blob. Assigning
 * innerHTML deliberately does NOT execute scripts, so mounted that way the panel
 * would show a blank rectangle forever.
 *
 * So the script nodes are cloned into fresh executable ones after insertion —
 * the same `runTemplateScripts` the web shell uses for exactly these templates
 * (shells/web/src/lib/render-lifecycle.ts). The payoff beyond a working preview:
 * the drawn chart is real DOM in this document, so "Add to canvas" can serialise
 * the actual SVG the user is looking at rather than re-deriving it.
 */

/** Where the tool files land — see vite.config.ts. */
const TOOLS_BASE = new URL('tools/', document.baseURI);

/**
 * Make sure `window.d3` exists before any paint.
 *
 * tools/d3/template.html hardcodes `var LIB = '/tools/d3/lib/d3.min.js'` — an
 * absolute path, correct on lolly.tools and wrong everywhere else. Under a
 * GitHub Pages project subpath (/lolly-plugins-penpot-d3-charts/) it 404s, and
 * the chart reports "Chart library failed to load."
 *
 * Patching the tool was the obvious fix and the wrong one: the tool is copied in
 * verbatim precisely so a chart behaves identically here and on lolly.tools.
 * Instead the panel loads d3 itself, from a relative URL that survives any base
 * path. The template's own loader short-circuits on `window.d3` before it ever
 * looks at LIB, so its broken constant is simply never reached.
 */
let d3Ready: Promise<void> | null = null;

export function ensureD3(): Promise<void> {
  if ((window as { d3?: unknown }).d3) return Promise.resolve();
  d3Ready ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('d3/lib/d3.min.js', TOOLS_BASE).href;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      d3Ready = null;
      reject(new Error('Could not load the D3 library.'));
    };
    document.head.appendChild(s);
  });
  return d3Ready;
}

/** Fetch one tool file as text, for the engine's loader. */
export async function fetchToolFile(path: string): Promise<string> {
  const res = await fetch(new URL(path, TOOLS_BASE));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.text();
}

/**
 * Re-run a container's `<script>` elements.
 *
 * Verbatim from the web shell's render lifecycle: a script inserted via
 * innerHTML is inert by spec, and cloning it into a freshly created element is
 * the only way to arm it. Attributes are carried over so `type="application/json"`
 * state blocks stay inert data rather than being executed as JS.
 */
function runTemplateScripts(container: ParentNode): void {
  container.querySelectorAll('script').forEach((old) => {
    const s = document.createElement('script');
    for (const a of [...old.attributes]) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  });
}

/**
 * Paint hydrated template markup into `stage` and run its scripts.
 *
 * Every paint replaces the stage's contents wholesale. That looks wasteful for a
 * slider drag, but the template is built for it: it opens by bumping a global
 * epoch counter and drops any callback from a previous paint, which is exactly
 * the re-entrancy contract this needs. Diffing would be both harder and wrong.
 */
export function paintTemplate(stage: HTMLElement, hydrated: string): void {
  stage.innerHTML = hydrated;
  runTemplateScripts(stage);
}

/**
 * The chart SVG currently drawn in the stage, serialised standalone.
 *
 * `font` replaces the template's `var(--font-brand, …)` rule with a literal
 * family. Penpot parses the markup on its own, with none of this document's
 * custom properties in scope, so an unresolved var() would drop every text run
 * back to the browser default — the chart would land in a typeface the user
 * never chose. Passing the concrete family lets Penpot match it against its own
 * font registry instead.
 */
export function serializeChart(stage: HTMLElement, font: string | null): string | null {
  const svg = stage.querySelector('svg');
  if (!svg) return null;

  const clone = svg.cloneNode(true) as SVGElement;
  // Penpot parses the markup standalone, so the namespace has to be explicit
  // even though the browser left it implicit on a document-parsed element.
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('xmlns:xlink')) {
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }

  if (font) {
    const stack = `${quoteFamily(font)}, system-ui, -apple-system, sans-serif`;
    for (const style of clone.querySelectorAll('style')) {
      style.textContent = (style.textContent ?? '').replace(
        /var\(--font-brand[^)]*\)/g,
        stack,
      );
    }
    // Belt and braces for any inline style attribute the chart set itself.
    for (const el of clone.querySelectorAll<SVGElement>('[style*="--font-brand"]')) {
      el.setAttribute(
        'style',
        (el.getAttribute('style') ?? '').replace(/var\(--font-brand[^)]*\)/g, stack),
      );
    }
  }

  return new XMLSerializer().serializeToString(clone);
}

/** A family name only needs quoting when it isn't a bare CSS identifier run. */
function quoteFamily(name: string): string {
  return /^[a-zA-Z][a-zA-Z0-9 _-]*$/.test(name) ? name : JSON.stringify(name);
}
