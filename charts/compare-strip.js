/**
 * Compare strip: for each metric, the floor set's distribution as a histogram
 * above an axis, the ceiling set's mirrored below it, each set's median as a
 * tick, and every focal unit as a mark across both. A histogram rather than
 * one dot per unit, because a catalog floor can hold ten thousand units.
 *
 *   renderCompareStrip(container, {
 *     variables: [{ id, label, format, dir }],
 *     stats,                       // scoreUnits(...).stats
 *     focal: [{ id, name, values: { variable: value } }],
 *     colors: { floor, ceiling, focal },
 *     labels: { floor, ceiling },
 *     highlight: id | null,        // a focal unit drawn emphasised
 *   })
 */

import { el, hover, rowLabel } from '../core/charts.js';
import { fmt, escapeHtml } from '../core/format.js';

const W = 640, ROW = 64, LABEL = 190, PAD = 12, BINS = 36, HALF = 20;

export function renderCompareStrip(container, { variables, stats, focal, colors, labels, highlight = null }) {
    container.innerHTML = '';
    const rows = variables.filter(v => stats[v.id]);
    const svg = el('svg', { viewBox: `0 0 ${W} ${rows.length * ROW + 24}`, class: 'compare-strip', role: 'img' });
    const x0 = LABEL + PAD, x1 = W - PAD;
    rows.forEach((v, i) => {
        const s = stats[v.id];
        const y = i * ROW + ROW / 2 + 4;
        const fv = focal.map(u => u.values[v.id]).filter(Number.isFinite);
        const all = [...s.floor.values, ...s.ceiling.values, ...fv];
        const g = el('g');
        g.appendChild(rowLabel(v.label, LABEL, y, 30, 2));
        if (!all.length) {
            const t = el('text', { x: x0, y: y + 4, class: 'nodata' });
            t.textContent = 'No data';
            g.appendChild(t);
            svg.appendChild(g);
            return;
        }
        let lo = Math.min(...all), hi = Math.max(...all);
        if (lo === hi) { lo -= 0.5; hi += 0.5; }
        const sx = x => x0 + (x - lo) / (hi - lo) * (x1 - x0);
        g.appendChild(el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'axis' }));
        hist(g, s.floor.values, lo, hi, sx, y, -1, colors.floor);
        hist(g, s.ceiling.values, lo, hi, sx, y, 1, colors.ceiling);
        for (const [set, dirY, color, name] of [[s.floor, -1, colors.floor, labels.floor], [s.ceiling, 1, colors.ceiling, labels.ceiling]]) {
            if (set.median == null) continue;
            const m = el('line', { x1: sx(set.median), x2: sx(set.median), y1: y, y2: y + dirY * (HALF + 3), stroke: color, 'stroke-width': 2.5 });
            hover(m, `${escapeHtml(name)} median: <b>${fmt(set.median, v.format)}</b> of ${set.n.toLocaleString()} units`);
            g.appendChild(m);
        }
        for (const u of focal) {
            const val = u.values[v.id];
            if (!Number.isFinite(val)) continue;
            const on = highlight === u.id;
            const mk = el('path', {
                d: diamond(sx(val), y, on ? 6.5 : 5),
                fill: colors.focal, stroke: on ? '#111' : 'white', 'stroke-width': on ? 1.6 : 1, 'fill-opacity': highlight && !on ? 0.35 : 0.95,
            });
            hover(mk, `${escapeHtml(u.name)}: <b>${fmt(val, v.format)}</b>`);
            g.appendChild(mk);
        }
        const ends = [[lo, x0, 'start'], [hi, x1, 'end']];
        for (const [val, x, anchor] of ends) {
            const t = el('text', { x, y: y + HALF + 13, 'text-anchor': anchor, class: 'tick' });
            t.textContent = fmt(val, v.format);
            g.appendChild(t);
        }
        svg.appendChild(g);
    });
    container.appendChild(svg);
}

/** A histogram of vals on [lo, hi], bars growing away from y in direction dirY. */
function hist(g, vals, lo, hi, sx, y, dirY, color) {
    if (!vals.length) return;
    const counts = new Array(BINS).fill(0);
    for (const v of vals) counts[Math.min(BINS - 1, Math.floor((v - lo) / (hi - lo) * BINS))]++;
    const max = Math.max(...counts);
    const bw = (sx(hi) - sx(lo)) / BINS;
    counts.forEach((c, i) => {
        if (!c) return;
        const h = Math.max(1.5, c / max * HALF);
        g.appendChild(el('rect', {
            x: sx(lo) + i * bw + 0.5, width: Math.max(0.5, bw - 1),
            y: dirY < 0 ? y - h : y, height: h,
            fill: color, 'fill-opacity': 0.45,
        }));
    });
}

const diamond = (x, y, r) => `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`;

export const compareStripCss = `
.compare-strip { width: 100%; height: auto; display: block; }
.compare-strip text { font-size: 11.5px; fill: var(--text-2); }
.compare-strip text.tick { font-size: 10.5px; fill: var(--text-3); font-variant-numeric: tabular-nums; }
.compare-strip .axis { stroke: var(--line-strong); stroke-width: 1; }
`;
