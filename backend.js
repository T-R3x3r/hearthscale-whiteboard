'use strict';
/**
 * The Whiteboard backend: the tools an agent works the board with. The
 * board is Excalidraw's page in the app's `web` surface, which keeps the
 * board in its own storage; each tool sends the page one script through
 * the surface. A drawing goes in as a paste of Excalidraw's clipboard
 * format, as if the person pasted it, so the person can move, change or
 * undo it like their own.
 */

let held = null;

/** Runs `fn` in the page with one argument and answers what it answers.
 *  `fn` stands alone: it reaches nothing of this file. */
async function inPage(fn, arg) {
  const out = await held.surface.command('evaluate', {
    js: `(${fn})(${JSON.stringify(arg)})`,
  });
  let value;
  try {
    value = JSON.parse(out.result);
  } catch {
    throw new Error('the board answered with more than the surface carries');
  }
  if (value && value.error) throw new Error(value.error);
  return value;
}

// ---------- In the page ----------

/** The board as the page keeps it: every shape, arrow and free text, with
 *  a shape's label read from the text it holds. */
async function boardInPage() {
  // The page writes the board to its storage a moment after each change.
  await new Promise((r) => setTimeout(r, 400));
  const all = JSON.parse(localStorage.getItem('excalidraw') || '[]').filter((e) => !e.isDeleted);
  const byId = new Map(all.map((e) => [e.id, e]));
  const labelOf = (e) => {
    const bound = (e.boundElements || []).find((b) => b.type === 'text');
    const text = bound && byId.get(bound.id);
    return text ? (text.originalText ?? text.text) : undefined;
  };
  return {
    items: all
      .filter((e) => !(e.type === 'text' && e.containerId))
      .map((e) => ({
        id: e.id,
        kind: e.type,
        label: e.type === 'text' ? (e.originalText ?? e.text) : labelOf(e),
        x: Math.round(e.x),
        y: Math.round(e.y),
        width: Math.round(e.width),
        height: Math.round(e.height),
        color: e.strokeColor,
        fill: e.backgroundColor === 'transparent' ? undefined : e.backgroundColor,
        from: e.startBinding?.elementId,
        to: e.endBinding?.elementId,
      })),
  };
}

/** Pastes elements to the right of what the board holds and zooms to
 *  them. Excalidraw takes a paste only while the pointer lies over its
 *  canvas, and centres what it pastes on the pointer: the board pans
 *  under a point where its canvas is on top until that point shows the
 *  place, and the pointer moves there. A page that just opened loads its
 *  saved board after its first paint, over anything pasted before, so the
 *  paste waits for a page some seconds old and goes again when the board
 *  did not keep it. */
async function drawInPage({ elements, width, height }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, ms) => {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) return false;
      await wait(100);
    }
    return true;
  };
  const board = () => document.querySelector('.excalidraw-container');
  if (!(await until(board, 15000))) return { error: 'the board did not load' };
  await wait(Math.max(0, 2500 - performance.now()));
  const kept = () =>
    JSON.parse(localStorage.getItem('excalidraw') || '[]').filter((e) => !e.isDeleted);
  const before = new Set(kept().map((e) => e.id));
  const added = () => kept().filter((e) => !before.has(e.id));
  const held = kept();
  const want = {
    x: (held.length ? Math.max(...held.map((e) => e.x + e.width)) + 120 : 0) + width / 2,
    y: (held.length ? Math.min(...held.map((e) => e.y)) : 0) + height / 2,
  };
  /** The point nearest the board's middle where its canvas is on top. */
  const free = () => {
    const box = board().getBoundingClientRect();
    let best = null;
    for (let i = 1; i < 16; i++) {
      for (let k = 1; k < 16; k++) {
        const x = box.left + (box.width * i) / 16;
        const y = box.top + (box.height * k) / 16;
        if (!(document.elementFromPoint(x, y) instanceof HTMLCanvasElement)) continue;
        const far = Math.hypot(x - (box.left + box.width / 2), y - (box.top + box.height / 2));
        if (!best || far < best.far) best = { x, y, far };
      }
    }
    return best;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const spot = free();
    if (!spot) return { error: 'the board shows no free place to draw on' };
    const state = JSON.parse(localStorage.getItem('excalidraw-state') || '{}');
    const zoom = state.zoom?.value ?? 1;
    const box = board().getBoundingClientRect();
    const shown = {
      x: (want.x + (state.scrollX ?? 0)) * zoom + box.left,
      y: (want.y + (state.scrollY ?? 0)) * zoom + box.top,
    };
    const canvas = document.elementFromPoint(spot.x, spot.y);
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: shown.x - spot.x,
        deltaY: shown.y - spot.y,
        clientX: spot.x,
        clientY: spot.y,
        bubbles: true,
        cancelable: true,
      }),
    );
    await wait(150);
    board().focus();
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: spot.x,
        clientY: spot.y,
        bubbles: true,
      }),
    );
    const data = new DataTransfer();
    data.setData(
      'text/plain',
      JSON.stringify({ type: 'excalidraw/clipboard', elements, files: {} }),
    );
    document.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    await wait(200);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '@',
        code: 'Digit2',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    if (await until(() => added().length >= elements.length, 3000)) break;
  }
  return { added: added().length };
}

// ---------- Shapes into elements ----------

const KINDS = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'arrow']);
const BOXES = new Set(['rectangle', 'ellipse', 'diamond']);
const INK = '#1e1e1e';
const FONT = 20;
/** Excalidraw's own hand-drawn face. */
const FACE = 5;
const GAP = 80;

const colour = (value, fallback) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const size = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
/** The width words take at the board's font size. */
const wordsWide = (text) =>
  Math.max(
    ...String(text)
      .split('\n')
      .map((line) => line.length),
  ) *
  FONT *
  0.6;

/** Where the line from a shape's centre towards a point leaves the shape. */
function edge(shape, toward) {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  let t;
  if (shape.type === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (shape.type === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: cx + dx * t, y: cy + dy * t };
}

/** The text element a shape or an arrow holds. */
function labelFor(id, container, label, color) {
  const lines = String(label).split('\n');
  const width = wordsWide(label);
  const height = lines.length * FONT * 1.25;
  return {
    type: 'text',
    id,
    x: container.x + container.width / 2 - width / 2,
    y: container.y + container.height / 2 - height / 2,
    width,
    height,
    text: String(label),
    originalText: String(label),
    fontSize: FONT,
    fontFamily: FACE,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: container.id,
    strokeColor: color,
  };
}

/** Excalidraw elements for the shapes a call names, laid out from the
 *  origin, and the size of the whole. */
function elementsOf(shapes) {
  if (!Array.isArray(shapes) || shapes.length === 0)
    throw new Error('shapes names nothing to draw');
  const elements = [];
  const byKey = new Map();
  let row = 0;
  shapes.forEach((shape, i) => {
    if (!KINDS.has(shape.kind)) throw new Error(`shape ${i + 1} has no kind the board draws`);
    if (shape.kind === 'arrow') return;
    const color = colour(shape.color, INK);
    const id = `shape-${i}`;
    const label = typeof shape.label === 'string' && shape.label.trim() ? shape.label : undefined;
    if (shape.kind === 'text' && !label) throw new Error(`text ${i + 1} has no words`);
    // A diamond holds its words in the middle half of its box.
    const room = shape.kind === 'diamond' ? 2 : 1;
    const width = size(
      shape.width,
      shape.kind === 'text'
        ? wordsWide(label)
        : Math.max(160, label ? wordsWide(label) * room + 48 : 0),
    );
    const height = size(
      shape.height,
      shape.kind === 'text' ? label.split('\n').length * FONT * 1.25 : 80 * (room === 2 ? 1.25 : 1),
    );
    const placed = typeof shape.x === 'number' && typeof shape.y === 'number';
    const element = {
      type: shape.kind,
      id,
      x: placed ? shape.x : row,
      y: placed ? shape.y : 0,
      width,
      height,
      strokeColor: color,
      backgroundColor: colour(shape.fill, 'transparent'),
      fillStyle: 'solid',
      ...(shape.kind === 'rectangle' && { roundness: { type: 3 } }),
      boundElements: [],
    };
    if (!placed) row += width + GAP;
    if (shape.kind === 'text') {
      Object.assign(element, {
        text: label,
        originalText: label,
        fontSize: FONT,
        fontFamily: FACE,
        textAlign: 'left',
        verticalAlign: 'top',
      });
      delete element.boundElements;
      delete element.backgroundColor;
      delete element.fillStyle;
    } else if (label) {
      const text = labelFor(`${id}-label`, element, label, color);
      element.boundElements.push({ type: 'text', id: text.id });
      elements.push(element, text);
    }
    if (shape.kind === 'text' || !label) elements.push(element);
    if (typeof shape.key === 'string' && shape.key) byKey.set(shape.key, element);
  });
  shapes.forEach((shape, i) => {
    if (shape.kind !== 'arrow') return;
    const from = byKey.get(shape.from);
    const to = byKey.get(shape.to);
    if (!from || !to) {
      throw new Error(`arrow ${i + 1} joins shapes by keys this call does not name`);
    }
    if (!BOXES.has(from.type) || !BOXES.has(to.type)) {
      throw new Error(`arrow ${i + 1} joins a text; an arrow joins shapes`);
    }
    const id = `arrow-${i}`;
    const color = colour(shape.color, INK);
    const centre = (s) => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
    const start = edge(from, centre(to));
    const end = edge(to, centre(from));
    const arrow = {
      type: 'arrow',
      id,
      x: start.x,
      y: start.y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      strokeColor: color,
      startBinding: { elementId: from.id, focus: 0, gap: 4 },
      endBinding: { elementId: to.id, focus: 0, gap: 4 },
      endArrowhead: 'arrow',
      boundElements: [],
    };
    from.boundElements.push({ type: 'arrow', id });
    to.boundElements.push({ type: 'arrow', id });
    elements.push(arrow);
    if (typeof shape.label === 'string' && shape.label.trim()) {
      const text = labelFor(`${id}-label`, arrow, shape.label, color);
      arrow.boundElements.push({ type: 'text', id: text.id });
      elements.push(text);
    }
  });
  const minX = Math.min(...elements.map((e) => e.x));
  const minY = Math.min(...elements.map((e) => e.y));
  for (const e of elements) {
    e.x -= minX;
    e.y -= minY;
  }
  return {
    elements,
    width: Math.max(...elements.map((e) => e.x + e.width)),
    height: Math.max(...elements.map((e) => e.y + e.height)),
  };
}

/** One line of the board's text for one item. */
function line(item, names) {
  const words = item.label ? ` "${item.label.replace(/\s+/g, ' ')}"` : '';
  if (item.kind === 'arrow') {
    const ends = item.from && item.to ? ` from ${names(item.from)} to ${names(item.to)}` : '';
    return `- arrow ${item.id}${words}${ends}`;
  }
  const fill = item.fill ? `, fill ${item.fill}` : '';
  return `- ${item.kind} ${item.id}${words} at (${item.x}, ${item.y}), ${item.width}×${item.height}${fill}`;
}

module.exports = {
  activate(ctx) {
    held = ctx;
  },
  tools: {
    async contents() {
      const { items } = await inPage(boardInPage);
      if (items.length === 0) return 'The whiteboard is empty.';
      const byId = new Map(items.map((i) => [i.id, i]));
      const names = (id) =>
        byId.get(id)?.label ? `${id} "${byId.get(id).label.replace(/\s+/g, ' ')}"` : id;
      return `The whiteboard holds ${items.length} item${items.length === 1 ? '' : 's'}:\n${items
        .map((i) => line(i, names))
        .join('\n')}`;
    },
    async draw({ shapes }) {
      const drawing = elementsOf(shapes);
      const { added } = await inPage(drawInPage, drawing);
      if (added === 0) throw new Error('the board took none of the shapes');
      await held.surface.command('show', {});
      return `Drew ${shapes.length} shape${shapes.length === 1 ? '' : 's'} on the whiteboard, to the right of what it held, and showed them to the person.`;
    },
    async look() {
      const out = await held.surface.command('screenshot', {});
      if (!out.asset) throw new Error('the surface returned no picture');
      return {
        content: [
          {
            kind: 'asset',
            asset: out.asset,
            mediaType: 'image/png',
            name: 'whiteboard.png',
          },
          { kind: 'text', text: 'The whiteboard as the person sees it.' },
        ],
      };
    },
  },
};
