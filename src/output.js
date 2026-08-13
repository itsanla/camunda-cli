// Output layer. Two hard rules, both driven by the fact that the main consumer is an
// AI agent reading piped stdout, not a human staring at a terminal:
//   1. No box-drawing characters, ever. Columns are aligned with plain spaces.
//   2. No ANSI colour unless stdout is a TTY (and --no-color can still turn it off).
// Every command also honours --json, which prints the raw API payload and nothing else.

import chalk from 'chalk';

let jsonMode = false;

export function configureOutput({ json = false, color } = {}) {
  jsonMode = json;
  // chalk auto-detects TTY; only override when explicitly asked.
  if (color === false) chalk.level = 0;
}

export function isJsonMode() {
  return jsonMode;
}

export function json(data) {
  console.log(JSON.stringify(data, null, 2));
}

export function line(text = '') {
  console.log(text);
}

export function heading(text) {
  console.log(chalk.bold(text));
}

export function note(text) {
  console.log(chalk.gray(text));
}

export function warn(text) {
  console.log(chalk.yellow(text));
}

export function problem(text) {
  console.log(chalk.red(text));
}

// Key/value block, keys right-padded to align values.
export function kv(pairs, indent = '  ') {
  const width = Math.max(0, ...pairs.map(([k]) => String(k).length));
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '') continue;
    console.log(`${indent}${String(k).padEnd(width)}  ${v}`);
  }
}

// Plain aligned table. `rows` are arrays of strings; `head` is optional.
// Column widths are computed on the visible (ANSI-stripped) length so colour
// never breaks alignment.
const ANSI = /\[[0-9;]*m/g;
const visibleLength = (s) => String(s ?? '').replace(ANSI, '').length;

export function table(head, rows, { indent = '  ' } = {}) {
  if (rows.length === 0) return;
  const cols = head ? head.length : Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(head ? visibleLength(head[c]) : 0, ...rows.map((r) => visibleLength(r[c])));
  }
  const render = (cells, styler) =>
    cells
      .map((cell, c) => {
        const s = String(cell ?? '');
        const pad = ' '.repeat(Math.max(0, widths[c] - visibleLength(s)));
        // Don't pad the last column, avoids trailing whitespace.
        return c === cols - 1 ? s : s + pad;
      })
      .join('  ')
      .trimEnd();

  if (head) console.log(indent + chalk.dim(render(head)));
  for (const row of rows) console.log(indent + render(row));
}

// Wraps prose at a word boundary. Long explanations are the point of several commands,
// and a 300-character single line is unreadable in a terminal and in a transcript alike.
export function wrap(text, width = 92) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    if (current && current.length + 1 + w.length > width) {
      lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function truncate(str, length) {
  const s = String(str ?? '');
  return s.length > length ? s.slice(0, length - 1) + '~' : s;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  return String(iso).replace('T', ' ').slice(0, 19);
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function stateLabel(state) {
  switch (state) {
    case 'ACTIVE':
      return chalk.green(state);
    case 'COMPLETED':
      return chalk.blue(state);
    case 'EXTERNALLY_TERMINATED':
    case 'INTERNALLY_TERMINATED':
      return chalk.yellow(state);
    case 'SUSPENDED':
      return chalk.gray(state);
    default:
      return state ?? '';
  }
}
