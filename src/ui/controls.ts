// SPDX-License-Identifier: MPL-2.0
/**
 * Renders the chart tool's input model as panel controls.
 *
 * A deliberately small subset of the web shell's input renderer (2 400 lines
 * covering every control the whole catalog uses). This tool needs five: select,
 * number (as slider or box), boolean, colour, and text — the last in two shapes,
 * since the pasted table is a `longtext` and everything else is a one-liner.
 *
 * Unlike the filters plugin, nothing here is hand-listed. Every one of the
 * tool's ~95 inputs already carries a `section` in tool.json ("Data", "Chart",
 * "Axes & scale", …), so the panel groups straight off the manifest. A future
 * version of the tool that adds an input gets it rendered, in the right place,
 * with no change on this side — an unknown section renders too, appended after
 * the curated order below.
 *
 * Controls are rebuilt from scratch on every model change rather than diffed.
 * The tool's hooks rewrite their own inputs (picking a chart type re-derives
 * which column controls apply), so "the DOM is a function of the model" is the
 * only version of this that stays correct. The one concession: the control the
 * user is on keeps focus across the rebuild.
 */
import type { InputModelItem, InputValue } from '@engine/inputs.ts';

export type OnChange = (id: string, value: InputValue) => void;

/**
 * Inputs the panel drives itself rather than exposing as a control.
 *
 * `width`/`height` are set from the size box in the footer. The three colour
 * inputs are the interesting case: they default to `{color.semantic.*}` token
 * aliases, so while the panel is in library-styling mode they already follow the
 * file's own colours and a duplicate colour well would just be a way to
 * accidentally break that. Manual mode adds them back (see MANUAL_ONLY).
 */
export const PANEL_OWNED = new Set(['width', 'height']);

/** Shown only when the user has taken styling off the library. */
export const MANUAL_ONLY = new Set(['palette', 'background', 'textColor']);

/** Section order for the panel. Anything the manifest introduces that isn't
 *  listed here still renders — appended, in first-seen order — so a new section
 *  in the tool can't silently vanish from the panel. */
const SECTION_ORDER = [
  'Data',
  'Columns',
  'Chart',
  'Animation',
  'Labels & bar size',
  'Axes & scale',
  'Colour & style',
  'Custom palette',
  'Titles & labels',
  'Annotations',
  'Legend',
];

/** Sections that start expanded. The rest are one click away. */
const OPEN_BY_DEFAULT = new Set(['Chart', 'Colour & style']);

/** Colour values arrive either as a plain hex or as a resolved token
 *  ({ ref, value }) — `<input type=color>` only speaks the former. */
function hexOf(v: InputValue): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'value' in v && typeof v.value === 'string') return v.value;
  return '';
}

function visible(item: InputModelItem, values: Record<string, InputValue>): boolean {
  if (!item.showIf) return true;
  // A showIf value may be a single value or an array of accepted ones.
  return Object.entries(item.showIf).every(([k, v]) =>
    Array.isArray(v) ? v.includes(values[k] as InputValue) : values[k] === v,
  );
}

function row(item: InputModelItem, control: HTMLElement, stacked = false, extra = ''): HTMLElement {
  const el = document.createElement('label');
  el.className = `${stacked ? 'row row-stacked' : 'row'}${extra ? ` ${extra}` : ''}`;
  const name = document.createElement('span');
  name.className = 'row-label';
  name.textContent = item.label ?? item.id;
  if (item.help) name.title = item.help;
  el.append(name, control);
  return el;
}

function slider(item: InputModelItem, onChange: OnChange): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'slider';

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(item.min ?? 0);
  input.max = String(item.max ?? 100);
  input.step = String(item.step ?? 1);
  input.value = String(item.value ?? item.default ?? 0);
  input.dataset.inputId = item.id;

  const out = document.createElement('output');
  out.textContent = input.value;

  // `input` (not `change`) so a drag redraws live; main.ts coalesces the flood.
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onChange(item.id, Number(input.value));
  });

  wrap.append(input, out);
  return wrap;
}

function numberBox(item: InputModelItem, onChange: OnChange): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  if (item.min != null) input.min = String(item.min);
  if (item.max != null) input.max = String(item.max);
  if (item.step != null) input.step = String(item.step);
  input.value = String(item.value ?? item.default ?? 0);
  input.dataset.inputId = item.id;
  input.addEventListener('change', () => onChange(item.id, Number(input.value)));
  return input;
}

function checkbox(item: InputModelItem, onChange: OnChange): HTMLElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(item.value);
  input.dataset.inputId = item.id;
  input.addEventListener('change', () => onChange(item.id, input.checked));
  return input;
}

function select(item: InputModelItem, onChange: OnChange): HTMLElement {
  const el = document.createElement('select');
  el.dataset.inputId = item.id;
  for (const opt of item.options ?? []) {
    const o = document.createElement('option');
    o.value = String(opt.value);
    o.textContent = opt.label ?? String(opt.value);
    el.append(o);
  }
  el.value = String(item.value ?? item.default ?? '');
  el.addEventListener('change', () => onChange(item.id, el.value));
  return el;
}

function textBox(item: InputModelItem, onChange: OnChange): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = typeof item.value === 'string' ? item.value : '';
  if (item.placeholder) input.placeholder = item.placeholder;
  input.dataset.inputId = item.id;
  // `change`, not `input`: a title redraws the whole chart, and doing that on
  // every keystroke makes typing feel like wading.
  input.addEventListener('change', () => onChange(item.id, input.value));
  return input;
}

/**
 * The pasted table. This is the input the whole tool turns on, so it gets the
 * one behaviour the others don't: it redraws as you type (debounced by main.ts),
 * because pasting a table and watching the chart appear IS the product.
 */
function textArea(item: InputModelItem, onChange: OnChange): HTMLElement {
  const area = document.createElement('textarea');
  area.rows = item.rows ?? 8;
  area.spellcheck = false;
  area.value = typeof item.value === 'string' ? item.value : '';
  if (item.placeholder) area.placeholder = item.placeholder;
  area.dataset.inputId = item.id;
  area.addEventListener('input', () => onChange(item.id, area.value));
  return area;
}

function colorPicker(item: InputModelItem, onChange: OnChange): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'color';

  const hex = hexOf(item.value);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000';
  input.dataset.inputId = item.id;
  input.addEventListener('input', () => onChange(item.id, input.value));

  // Several colour inputs treat empty as "none / inherit". A colour well can't
  // express that, so the clear button is the only way back to the default.
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'ghost';
  clear.textContent = '×';
  clear.title = 'Clear';
  clear.addEventListener('click', (e) => {
    e.preventDefault();
    onChange(item.id, '');
  });

  wrap.append(input);
  if (!hex) wrap.classList.add('is-empty');
  wrap.append(clear);
  return wrap;
}

function controlFor(item: InputModelItem, onChange: OnChange): HTMLElement | null {
  switch (item.type) {
    case 'number':
      return item.display === 'slider' ? slider(item, onChange) : numberBox(item, onChange);
    case 'boolean':
      return checkbox(item, onChange);
    case 'select':
      return select(item, onChange);
    case 'color':
      return colorPicker(item, onChange);
    case 'text':
      return textBox(item, onChange);
    case 'longtext':
      return textArea(item, onChange);
    default:
      return null;
  }
}

/** A `longtext` gets its label above rather than beside it — a nine-row textarea
 *  squeezed into the value column of a two-column row is unusable. */
function isStacked(item: InputModelItem): boolean {
  return item.type === 'longtext';
}

export interface RenderOneOptions {
  /** Force the label above the control rather than beside it. */
  stacked?: boolean;
  /** Extra class on the row, for callers that style a control specially. */
  className?: string;
}

/** Build one control, or null if the panel doesn't render this input's type. */
export function renderOne(
  item: InputModelItem,
  onChange: OnChange,
  { stacked, className }: RenderOneOptions = {},
): HTMLElement | null {
  const control = controlFor(item, onChange);
  return control ? row(item, control, stacked ?? isStacked(item), className) : null;
}

export interface ControlsOptions {
  /** Labels of sections the user has expanded — passed in and read back by the
   *  caller so a rebuild doesn't collapse everything. */
  openSections: Set<string>;
  /** False while the file's library is driving colour, which hides the manual
   *  palette and colour wells. */
  manualStyling: boolean;
  /** Ids to skip entirely — the lead controls main.ts renders itself. */
  skip?: ReadonlySet<string>;
}

/**
 * Build the sectioned control panel.
 *
 * Sections come from the manifest; an input with no `section` is skipped here,
 * because the only ones the tool leaves unsectioned are the two lead controls
 * (chart type, data) and the two panel-owned size inputs.
 */
export function renderControls(
  model: InputModelItem[],
  onChange: OnChange,
  { openSections, manualStyling, skip }: ControlsOptions,
): HTMLElement {
  const values: Record<string, InputValue> = Object.fromEntries(model.map((i) => [i.id, i.value]));

  const bySection = new Map<string, InputModelItem[]>();
  for (const label of SECTION_ORDER) bySection.set(label, []);

  for (const item of model) {
    if (!item.section) continue;
    if (PANEL_OWNED.has(item.id) || skip?.has(item.id)) continue;
    if (!manualStyling && MANUAL_ONLY.has(item.id)) continue;
    if (!visible(item, values)) continue;
    const list = bySection.get(item.section);
    if (list) list.push(item);
    else bySection.set(item.section, [item]);
  }

  const root = document.createElement('div');
  root.className = 'controls';

  for (const [label, items] of bySection) {
    if (!items.length) continue;

    const details = document.createElement('details');
    details.className = 'group';
    // openSections is seeded with OPEN_BY_DEFAULT on first paint, so this one
    // flag covers both the default state and everything the user has since
    // opened or shut.
    details.open = openSections.has(label);
    details.addEventListener('toggle', () => {
      if (details.open) openSections.add(label);
      else openSections.delete(label);
    });

    const summary = document.createElement('summary');
    summary.textContent = label;
    details.append(summary);

    for (const item of items) {
      const built = renderOne(item, onChange);
      if (built) details.append(built);
    }

    root.append(details);
  }

  return root;
}

export { OPEN_BY_DEFAULT };
