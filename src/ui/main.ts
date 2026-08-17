// SPDX-License-Identifier: MPL-2.0
/**
 * Panel side of the plugin — everything with a DOM.
 *
 * The shape of it: mount the Lolly D3 chart tool through the engine's own loader
 * and runtime, feed it design tokens built from the Penpot file's library, let
 * it draw live into the preview stage, and on "Add to canvas" post the drawn SVG
 * to the sandbox to become a real Penpot shape.
 *
 * The engine does all the interesting work. This file is wiring: library →
 * tokens, controls → runtime input, runtime state → preview, button →
 * postMessage.
 */
import { loadTool } from '@engine/loader.ts';
import { createRuntime } from '@engine/runtime.ts';
import type { Runtime } from '@engine/runtime.ts';
import type { InputModelItem, InputValue } from '@engine/inputs.ts';

import type {
  PluginToUi, UiToPlugin, Theme, LibraryColorInfo, LibraryTypographyInfo, SelectionInfo,
} from '../messages.ts';
import { createHost, type ChartHost } from './host.ts';
import { ensureD3, fetchToolFile, paintTemplate, serializeChart } from './preview.ts';
import { renderControls, renderOne, OPEN_BY_DEFAULT, PANEL_OWNED } from './controls.ts';
import {
  initialStyling, reconcile, renderStyling, type StylingContext, type StylingState,
} from './styling.ts';

/** The tool id, and the directory it was copied into — see vite.config.ts. */
const TOOL_ID = 'd3';

/** Ids main.ts renders itself, above the preview, rather than in a section. */
const LEAD_INPUTS = new Set(['chartType', 'data']);

// ── plugin channel ────────────────────────────────────────────────────────────

let nextRequestId = 1;
const pending = new Map<number, (m: PluginToUi) => void>();

function post(msg: UiToPlugin): void {
  parent.postMessage(msg, '*');
}

/** Send a request and wait for the sandbox's matching reply. */
function request(build: (requestId: number) => UiToPlugin): Promise<PluginToUi> {
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    post(build(requestId));
  });
}

// ── panel state ───────────────────────────────────────────────────────────────

let theme: Theme = 'light';
let colors: LibraryColorInfo[] = [];
let typographies: LibraryTypographyInfo[] = [];
let fonts: string[] = [];
let selection: SelectionInfo[] = [];

let runtime: Runtime | null = null;
let unsubscribe: (() => void) | null = null;
let model: InputModelItem[] = [];
let hydrated = '';
/** Generation counter so a slow mount the user has already moved on from can't
 *  install itself over the newer one. */
let mountSeq = 0;

let styling: StylingState = initialStyling({ colors: [], typographies: [], fonts: [] });
const openSections = new Set<string>(OPEN_BY_DEFAULT);
let stylingOpen = true;

const host: ChartHost = createHost();

function stylingContext(): StylingContext {
  return { colors, typographies, fonts };
}

/** Everything ./tokens.ts needs, assembled from the current panel state. */
function tokenSources() {
  return {
    theme,
    // The one line that decides whether the file's library or the tool's own
    // palette select is in charge — see TokenSources.includeSpectrum.
    includeSpectrum: styling.mode === 'library',
    colors,
    surfaceId: styling.surfaceId,
    textId: styling.textId,
    excluded: styling.excluded,
  };
}

// ── DOM ───────────────────────────────────────────────────────────────────────

const app = document.getElementById('app') as HTMLDivElement;
app.innerHTML = `
  <section class="lead"></section>
  <section class="preview">
    <div class="stage" aria-live="polite"></div>
    <button type="button" class="stage-pill expand" data-act="expand" aria-pressed="false" title="Expand the preview to fill the panel" hidden>Expand</button>
  </section>
  <p class="error" hidden></p>
  <section class="panel"></section>
  <footer class="actions">
    <div class="size"></div>
    <button type="button" class="primary" data-act="place" disabled>Add to canvas</button>
    <p class="note muted"></p>
  </footer>
`;

const lead = app.querySelector('.lead') as HTMLElement;
const stage = app.querySelector('.stage') as HTMLElement;
const panel = app.querySelector('.panel') as HTMLElement;
const sizeEl = app.querySelector('.size') as HTMLElement;
const errorEl = app.querySelector('.error') as HTMLParagraphElement;
const placeBtn = app.querySelector('[data-act="place"]') as HTMLButtonElement;
const expandBtn = app.querySelector('[data-act="expand"]') as HTMLButtonElement;
const noteEl = app.querySelector('.actions .note') as HTMLElement;

/** Preview maximised — the stage fills the panel with the lead and settings
 *  folded away, so a chart can be judged full-size before it's committed. A pure
 *  view preference; it survives every mount and never touches the runtime. */
let previewMax = false;

/** Maximise or restore the preview. Toggling `.preview-max` on #app is the whole
 *  mechanism — CSS grows the stage and hides the lead + controls. */
function setPreviewMax(on: boolean): void {
  previewMax = on;
  app.classList.toggle('preview-max', on);
  expandBtn.classList.toggle('active', on);
  expandBtn.setAttribute('aria-pressed', String(on));
  expandBtn.textContent = on ? 'Collapse' : 'Expand';
  expandBtn.title = on
    ? 'Shrink the preview and bring the controls back'
    : 'Expand the preview to fill the panel';
}

expandBtn.addEventListener('click', () => setPreviewMax(!previewMax));

// Esc restores the controls — they're hidden while the preview is maximised, so
// this is the fast way back without hunting for the pill.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewMax) setPreviewMax(false);
});

function showError(message: string | null): void {
  errorEl.hidden = !message;
  errorEl.textContent = message ?? '';
}

function setNote(text: string): void {
  noteEl.textContent = text;
}

// ── mounting the tool ─────────────────────────────────────────────────────────

/**
 * Mount (or remount) the chart.
 *
 * A remount is not a nicety: the tool resolves the brand spectrum ONCE, in
 * `onInit` (tools/d3/hooks.js:457), and caches it for every subsequent
 * `onInput`. So a change to the token document — the user nominating a
 * background swatch, switching to manual, or the file's library changing
 * underneath — cannot reach the chart through setInput. It has to run onInit
 * again, which means a fresh runtime.
 *
 * `keepValues` carries the current inputs across so a remount is invisible: the
 * pasted table, chart type and every dialled-in setting survive.
 */
async function mount({ keepValues = true } = {}): Promise<void> {
  const seq = ++mountSeq;

  const carried: Record<string, InputValue> = {};
  if (keepValues) for (const item of model) carried[item.id] = item.value;

  unsubscribe?.();
  unsubscribe = null;
  runtime = null;
  // Values still queued belong to the runtime we're leaving.
  queued.clear();

  stage.classList.add('busy');
  host.setTokens(tokenSources());

  try {
    // d3 first: the template's script runs the moment the markup is painted, and
    // its own loader points at a path that only exists on lolly.tools.
    await ensureD3();
    const tool = await loadTool(TOOL_ID, fetchToolFile);
    if (seq !== mountSeq) return;

    const rt = await createRuntime(tool, host, carried);
    if (seq !== mountSeq) return;
    runtime = rt;

    if (rt.hookErrors.length) {
      showError(rt.hookErrors.map((e) => e.message).join('; '));
    } else {
      showError(null);
    }

    unsubscribe = rt.subscribe((state) => {
      model = state.model;
      hydrated = state.hydrated;
      paint();
    });
    model = rt.getModel();
    hydrated = rt.getHydrated();
    paint();
  } catch (e) {
    if (seq !== mountSeq) return;
    showError(`Couldn't load the chart tool: ${String((e as Error)?.message ?? e)}`);
  } finally {
    if (seq === mountSeq) stage.classList.remove('busy');
  }
}

// ── keeping controls usable while they're being used ─────────────────────────

/** True from pointerdown on a control until the pointer is released anywhere. */
let dragging = false;
/** A control rebuild deferred because the user was mid-drag. */
let rebuildPending = false;

panel.addEventListener('pointerdown', () => {
  dragging = true;
});
// On window, not the panel: a slider drag routinely ends with the pointer well
// outside the panel, and a pointerup we never saw would wedge `dragging` on.
window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  if (rebuildPending) paint();
});

function byId(id: string): InputModelItem | undefined {
  return model.find((i) => i.id === id);
}

function paint(): void {
  // The chart's own <style> block resolves text against --font-brand, so setting
  // it here is what makes the preview follow the chosen typeface — as far as the
  // panel can, anyway: Penpot's font files aren't reachable from this iframe, so
  // an unavailable family falls through to the system stack. The placed shape
  // carries the real family name (see serializeChart).
  if (styling.fontFamily) stage.style.setProperty('--font-brand', styling.fontFamily);
  else stage.style.removeProperty('--font-brand');

  paintTemplate(stage, hydrated);

  // Mid-drag, replacing the controls would destroy the very element the pointer
  // is captured on — the drag dies on the first frame and the slider becomes
  // almost impossible to move. Defer the rebuild to pointerup; the preview keeps
  // updating live throughout, which is the part the user is watching.
  if (dragging) {
    rebuildPending = true;
  } else {
    rebuildPending = false;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.inputId;
    const caret = selectionOf(document.activeElement);

    renderLead();
    renderPanel();
    renderSize();

    if (focused) {
      const next = app.querySelector<HTMLElement>(`[data-input-id="${CSS.escape(focused)}"]`);
      next?.focus();
      restoreSelection(next, caret);
    }
  }

  placeBtn.disabled = !hydrated.trim();
  expandBtn.hidden = !hydrated.trim();
}

/** Caret position in a text field, so a rebuild mid-typing doesn't jump the
 *  cursor to the end of the pasted table. */
function selectionOf(el: Element | null): [number, number] | null {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.selectionStart == null || el.selectionEnd == null) return null;
    return [el.selectionStart, el.selectionEnd];
  }
  return null;
}

function restoreSelection(el: HTMLElement | null | undefined, caret: [number, number] | null): void {
  if (!caret) return;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    try {
      el.setSelectionRange(caret[0], caret[1]);
    } catch {
      // A number/colour input rejects setSelectionRange; nothing to restore.
    }
  }
}

/**
 * Chart type and the pasted table, above the preview — the two controls the
 * user touches on every single chart.
 *
 * Chart type gets the hero treatment: full width, label above, a tall target.
 * It's the first decision anyone makes here and there are 32 options behind it,
 * so sizing it like a peer of "Bar spacing" buried it.
 */
function renderLead(): void {
  const rows: HTMLElement[] = [];
  for (const id of LEAD_INPUTS) {
    const item = byId(id);
    if (!item) continue;
    const built = renderOne(
      item,
      setInput,
      id === 'chartType' ? { stacked: true, className: 'row-hero' } : {},
    );
    if (built) rows.push(built);
  }
  lead.replaceChildren(...rows);
}

function renderPanel(): void {
  const styleSection = renderStyling(
    styling,
    stylingContext(),
    {
      onChange: (next) => {
        styling = next;
        // Tokens are read in onInit only — a fresh runtime is the only way this
        // reaches the chart. See mount().
        void mount();
      },
      onRefresh: () => post({ type: 'refresh-library' }),
    },
    stylingOpen,
    (open) => {
      stylingOpen = open;
    },
  );

  const controls = renderControls(model, setInput, {
    openSections,
    manualStyling: styling.mode === 'manual',
    skip: LEAD_INPUTS,
  });

  panel.replaceChildren(styleSection, controls);
}

/** Output size lives in the footer next to the button, not buried in a section —
 *  it's the last thing you set before committing. */
function renderSize(): void {
  const rows: HTMLElement[] = [];
  for (const id of ['width', 'height']) {
    const item = byId(id);
    if (!item || !PANEL_OWNED.has(id)) continue;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(item.min ?? 1);
    if (item.max != null) input.max = String(item.max);
    input.value = String(item.value ?? item.default ?? 0);
    input.dataset.inputId = item.id;
    input.title = item.label ?? item.id;
    input.addEventListener('change', () => setInput(item.id, Number(input.value)));
    rows.push(input);
  }
  const times = document.createElement('span');
  times.className = 'muted';
  times.textContent = '×';
  sizeEl.replaceChildren(rows[0] ?? document.createTextNode(''), times, rows[1] ?? document.createTextNode(''));
}

/**
 * Feed a control's value to the runtime, at most one in flight at a time.
 *
 * A slider drag or a fast typist fires `input` far faster than 32 chart types'
 * worth of D3 can redraw, so letting every event start its own hook run would
 * pile up work the user has already scrolled past. The newest value per input
 * wins and the rest are dropped — the chart the user ends on is always the one
 * they released on.
 */
let inflight: Promise<void> | null = null;
const queued = new Map<string, InputValue>();

function setInput(id: string, value: InputValue): void {
  queued.set(id, value);
  if (inflight) return;
  const drain = async (): Promise<void> => {
    try {
      while (queued.size) {
        const [nextId, nextValue] = queued.entries().next().value as [string, InputValue];
        queued.delete(nextId);
        await runtime?.setInput(nextId, nextValue);
      }
    } finally {
      // Cleared in `finally`, not after the loop: one hook that throws must not
      // leave the queue permanently blocked, silently freezing every control.
      inflight = null;
    }
  };
  inflight = drain();
}

// ── committing to the canvas ──────────────────────────────────────────────────

/** What the placed shape is called on the board. The chart's own title when it
 *  has one, so a board of charts is readable in the layers panel. */
function shapeName(): string {
  const heading = byId('heading')?.value;
  const type = byId('chartType')?.value;
  const label =
    (typeof heading === 'string' && heading.trim()) ||
    (typeof type === 'string' && type) ||
    'chart';
  return `Chart — ${label}`;
}

placeBtn.addEventListener('click', async () => {
  const svg = serializeChart(stage, styling.fontFamily);
  if (!svg) {
    showError('Nothing to add yet — paste a table first.');
    return;
  }
  placeBtn.disabled = true;
  placeBtn.textContent = 'Adding…';
  try {
    const reply = await request((requestId) => ({
      type: 'place-svg',
      requestId,
      svg,
      name: shapeName(),
    }));
    if (reply.type === 'placed') setNote(`Added “${reply.name}” to the canvas.`);
  } finally {
    placeBtn.textContent = 'Add to canvas';
    placeBtn.disabled = false;
  }
});

// ── plugin messages ───────────────────────────────────────────────────────────

function applyTheme(next: Theme): void {
  theme = next;
  document.documentElement.dataset.theme = theme;
}

function describeTarget(): string {
  return selection.length
    ? `Lands beside “${selection[0].name}”.`
    : 'Lands in the middle of the viewport.';
}

window.addEventListener('message', (event: MessageEvent<PluginToUi>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    applyTheme(msg.theme);
    colors = msg.colors;
    typographies = msg.typographies;
    fonts = msg.fonts;
    selection = msg.selection;
    styling = initialStyling(stylingContext());
    setNote(describeTarget());
    void mount({ keepValues: false });
    return;
  }

  if (msg.type === 'theme') {
    applyTheme(msg.theme);
    // Theme feeds the semantic surface/text fallback, so it changes the tokens —
    // which only a remount can deliver.
    void mount();
    return;
  }

  if (msg.type === 'library') {
    colors = msg.colors;
    typographies = msg.typographies;
    styling = reconcile(styling, stylingContext());
    void mount();
    return;
  }

  if (msg.type === 'selection') {
    selection = msg.selection;
    setNote(describeTarget());
    return;
  }

  if (msg.type === 'error') showError(msg.message);

  const waiter = 'requestId' in msg ? pending.get(msg.requestId) : undefined;
  if (waiter && 'requestId' in msg) {
    pending.delete(msg.requestId);
    waiter(msg);
  }
});

// ── boot ──────────────────────────────────────────────────────────────────────

applyTheme((new URLSearchParams(location.search).get('theme') as Theme) ?? 'light');
// Mount before `init` arrives so the panel shows a chart immediately rather than
// an empty box for one message round-trip. The init handler remounts once the
// file's library is known.
void mount({ keepValues: false });
post({ type: 'ready' });
