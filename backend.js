'use strict';
/**
 * The Whiteboard backend: the tools an agent works the board with. The
 * boards live in the app's store, which the view keeps as the person
 * draws (`ui/src/boards.ts` names the keys); the tools work on the board
 * opened last. `contents` reads it from the store. `draw` adds its shapes
 * to the store, then asks the views to show them; the person can move,
 * change or undo them like their own. `look` asks a view for the board's
 * picture, which only a view can draw. A view answers through the
 * `answer` tool, which only the app's views may call.
 */

let ctx = null;

/** The requests the views answer, by id. */
const waiting = new Map();

/** How long a drawing waits for a view to show it. */
const SHOW_MS = 3000;
/** How long `look` waits for a view to draw the board's picture. */
const LOOK_MS = 15000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new id, as the view makes its own. */
function newId() {
  let id = '';
  for (let i = 0; i < 12; i++) id += Math.floor(Math.random() * 36).toString(36);
  return id;
}

/** A whole number for Excalidraw's seeds and version nonces. */
const randomInteger = () => Math.floor(Math.random() * 2 ** 31);

/** Sends the views a request and answers the first view's answer, or null
 *  when no view answers in time. */
async function ask(name, data, ms, signal) {
  const request = newId();
  const answered = new Promise((resolve) => waiting.set(request, resolve));
  const stopped = new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );
  try {
    await ctx.events.emit({ name, data: { request, ...data }, durable: false });
    return await Promise.race([answered, wait(ms).then(() => null), stopped]);
  } finally {
    waiting.delete(request);
  }
}

// ---------- The boards in the store ----------

/** The board opened last, or null before the first board. */
async function openBoard() {
  const boards = (await ctx.store.get('boards')) ?? [];
  const open = await ctx.store.get('open');
  return boards.find((b) => b.id === open) ?? boards[0] ?? null;
}

/** The board an agent draws on: the board opened last, or a first one. */
async function boardToDrawOn() {
  const open = await openBoard();
  if (open) return open;
  const board = { id: newId(), name: 'Board 1' };
  await ctx.store.set('boards', [board]);
  await ctx.store.set('open', board.id);
  return board;
}

/** A board's elements, deleted ones included. */
async function elementsOf(board) {
  return (await ctx.store.get(`board:${board.id}`))?.elements ?? [];
}

// ---------- Shapes into elements ----------

const KINDS = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'arrow']);
const BOXES = new Set(['rectangle', 'ellipse', 'diamond']);
/** How much wider than its words a shape is, for its words to fit inside. */
const ROOM = { diamond: 2, ellipse: Math.SQRT2 };
const INK = '#1e1e1e';
const FONT = 20;
/** Excalidraw's own hand-drawn face. */
const FACE = 5;
const LINE_HEIGHT = 1.25;
const GAP = 80;
/** The room between a drawing and what the board holds. */
const MARGIN = 120;

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

/** An element with the fields Excalidraw gives every element. The view
 *  measures its words again when it shows it. */
function element(fields) {
  return {
    angle: 0,
    strokeColor: INK,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: randomInteger(),
    version: 1,
    versionNonce: randomInteger(),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    ...fields,
  };
}

/** The fields of a text element. */
function words(text, align, container) {
  return {
    text,
    originalText: text,
    fontSize: FONT,
    fontFamily: FACE,
    textAlign: align,
    verticalAlign: container ? 'middle' : 'top',
    containerId: container ? container.id : null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
}

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
function labelFor(container, label, color) {
  const text = String(label);
  const width = wordsWide(text);
  const height = text.split('\n').length * FONT * LINE_HEIGHT;
  return element({
    type: 'text',
    id: newId(),
    x: container.x + container.width / 2 - width / 2,
    y: container.y + container.height / 2 - height / 2,
    width,
    height,
    strokeColor: color,
    ...words(text, 'center', container),
  });
}

/** Excalidraw elements for the shapes a call names, laid out from the
 *  origin. */
function drawingOf(shapes) {
  if (!Array.isArray(shapes) || shapes.length === 0)
    throw new Error('shapes names nothing to draw');
  const elements = [];
  const byKey = new Map();
  let row = 0;
  shapes.forEach((shape, i) => {
    if (!KINDS.has(shape.kind)) throw new Error(`shape ${i + 1} has no kind the board draws`);
    if (shape.kind === 'arrow') return;
    const color = colour(shape.color, INK);
    const label = typeof shape.label === 'string' && shape.label.trim() ? shape.label : undefined;
    if (shape.kind === 'text' && !label) throw new Error(`text ${i + 1} has no words`);
    // A diamond holds its words in the middle half of its box, an ellipse
    // in the box inside its curve.
    const room = ROOM[shape.kind] ?? 1;
    const width = size(
      shape.width,
      shape.kind === 'text'
        ? wordsWide(label)
        : Math.max(160, label ? wordsWide(label) * room + 48 : 0),
    );
    const height = size(
      shape.height,
      shape.kind === 'text'
        ? label.split('\n').length * FONT * LINE_HEIGHT
        : 80 * (shape.kind === 'diamond' ? 1.25 : 1),
    );
    const placed = typeof shape.x === 'number' && typeof shape.y === 'number';
    const at = { x: placed ? shape.x : row, y: placed ? shape.y : 0 };
    if (!placed) row += width + GAP;
    let made;
    if (shape.kind === 'text') {
      made = element({
        type: 'text',
        id: newId(),
        ...at,
        width,
        height,
        strokeColor: color,
        ...words(label, 'left', null),
      });
      elements.push(made);
    } else {
      made = element({
        type: shape.kind,
        id: newId(),
        ...at,
        width,
        height,
        strokeColor: color,
        backgroundColor: colour(shape.fill, 'transparent'),
        roundness: shape.kind === 'rectangle' ? { type: 3 } : { type: 2 },
      });
      elements.push(made);
      if (label) {
        const text = labelFor(made, label, color);
        made.boundElements.push({ type: 'text', id: text.id });
        elements.push(text);
      }
    }
    if (typeof shape.key === 'string' && shape.key) byKey.set(shape.key, made);
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
    const color = colour(shape.color, INK);
    const centre = (s) => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
    const start = edge(from, centre(to));
    const end = edge(to, centre(from));
    const arrow = element({
      type: 'arrow',
      id: newId(),
      x: start.x,
      y: start.y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      strokeColor: color,
      roundness: { type: 2 },
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap: 4 },
      endBinding: { elementId: to.id, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
    });
    from.boundElements.push({ type: 'arrow', id: arrow.id });
    to.boundElements.push({ type: 'arrow', id: arrow.id });
    elements.push(arrow);
    if (typeof shape.label === 'string' && shape.label.trim()) {
      const text = labelFor(arrow, shape.label, color);
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
  return elements;
}

// ---------- The board as text ----------

/** What a board shows: each shape, arrow and free text, with a shape's
 *  label read from the text it holds. */
function itemsOf(elements) {
  const all = elements.filter((e) => !e.isDeleted);
  const byId = new Map(all.map((e) => [e.id, e]));
  const labelOf = (e) => {
    if (e.type === 'text') return e.originalText ?? e.text;
    if (e.type === 'frame') return e.name ?? undefined;
    const bound = (e.boundElements ?? []).find((b) => b.type === 'text');
    const text = bound && byId.get(bound.id);
    return text ? (text.originalText ?? text.text) : undefined;
  };
  return all
    .filter((e) => !(e.type === 'text' && e.containerId))
    .map((e) => ({
      id: e.id,
      kind: e.type,
      label: labelOf(e),
      x: Math.round(e.x),
      y: Math.round(e.y),
      width: Math.round(e.width),
      height: Math.round(e.height),
      fill:
        e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : undefined,
      from: e.startBinding?.elementId,
      to: e.endBinding?.elementId,
    }));
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
  activate(context) {
    ctx = context;
  },
  tools: {
    async contents() {
      const board = await openBoard();
      if (!board) return 'The whiteboard is empty.';
      const items = itemsOf(await elementsOf(board));
      if (items.length === 0) return `The whiteboard "${board.name}" is empty.`;
      const byId = new Map(items.map((i) => [i.id, i]));
      const names = (id) =>
        byId.get(id)?.label ? `${id} "${byId.get(id).label.replace(/\s+/g, ' ')}"` : id;
      return `The whiteboard "${board.name}" holds ${items.length} item${items.length === 1 ? '' : 's'}:\n${items
        .map((i) => line(i, names))
        .join('\n')}`;
    },
    async draw({ shapes }, run) {
      const drawing = drawingOf(shapes);
      const board = await boardToDrawOn();
      const elements = await elementsOf(board);
      const held = elements.filter((e) => !e.isDeleted);
      const left = held.length ? Math.max(...held.map((e) => e.x + e.width)) + MARGIN : 0;
      const top = held.length ? Math.min(...held.map((e) => e.y)) : 0;
      for (const e of drawing) {
        e.x += left;
        e.y += top;
      }
      await ctx.store.set(`board:${board.id}`, { elements: [...elements, ...drawing] });
      const shown = await ask('drawn', { board: board.id, elements: drawing }, SHOW_MS, run.signal);
      const drew = `Drew ${shapes.length} shape${shapes.length === 1 ? '' : 's'} on the whiteboard "${board.name}", to the right of what it held`;
      return shown
        ? `${drew}, and showed them to the person.`
        : `${drew}. Whiteboard is not open, so the person sees them when they open it.`;
    },
    async look(_input, run) {
      const board = await openBoard();
      if (!board) return 'The whiteboard is empty.';
      const answer = await ask('look', { board: board.id }, LOOK_MS, run.signal);
      if (!answer) {
        throw new Error(
          'Whiteboard is not open, so no picture of the board can be drawn. Ask the person to open Whiteboard, then look again.',
        );
      }
      if (answer.error) throw new Error(`the board's picture was not drawn: ${answer.error}`);
      if (!answer.asset) return `The whiteboard "${board.name}" is empty.`;
      const last = await ctx.store.get('looked');
      if (last && last !== answer.asset) await ctx.assets.release(last);
      await ctx.store.set('looked', answer.asset);
      return {
        content: [
          { kind: 'asset', asset: answer.asset, mediaType: 'image/png', name: 'whiteboard.png' },
          { kind: 'text', text: `The whiteboard "${board.name}" as the person sees it.` },
        ],
      };
    },
    async answer(input) {
      const answered = waiting.get(input.request);
      if (!answered) return 'No request waits for this answer.';
      answered(input);
      return 'Taken.';
    },
  },
};
