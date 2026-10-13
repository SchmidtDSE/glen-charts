/**
 * Percentile strip: where one area sits among all areas of its kind, one row
 * per variable. Each row plots every area's raw value on that variable's own
 * scale (light ticks), marks this area (a dot), and prints the raw value and
 * the area's percentile rank.
 *
 * The other areas' values come from engine.distribution(): the query's
 * precomputed "all" results, or `precompute distributions`. Without either
 * (e.g. a param value that was not precomputed) the row shows the raw value
 * and says the rank is unavailable.
 *
 * spec (theme.json):
 *   type          "percentile-strip"
 *   query         query name; its rows are one per variable
 *   key           column identifying the variable (matched across areas)
 *   label         column holding the variable's display name   (default: key)
 *   value         raw value column (plotted)
 *   format        value format, or format_field: a column holding it per row
 *   rank_field    column holding the displayed rank, 0–100 (× rank_scale; e.g.
 *                 rank_scale 100 for a 0–1 PERCENT_RANK). Else the mid-rank
 *                 (share below + half the ties) over the distribution, flipped
 *                 where direction_field < 0.
 *   scale         "log" for a log axis, or scale_field: a column holding it per row
 *   peer_label    e.g. "coastal ecoregions"   (default: the area type's peer_label)
 *   note          text under the chart, e.g. "Provisional scores"
 */

import { fmt, escapeHtml, isMissing, ordinal } from '../core/format.js';
import { hover, el } from '../core/charts.js';

export const percentileStrip = {
    async load({ engine, theme, chart, aoi }) {
        const [rows, dist] = await Promise.all([
            engine.run(theme, chart.query, aoi),
            engine.distribution(theme, chart.query, aoi).catch(() => null),
        ]);
        return { rows, dist };
    },

    render(container, spec, { rows, dist }, { engine, aoi }) {
        container.innerHTML = '';
        if (!rows || !rows.length) {
            container.innerHTML = '<div class="sub">No data in this area.</div>';
            return;
        }
        const key = spec.key, valueCol = spec.value, labelCol = spec.label || key;
        const byKey = new Map();
        const ids = new Set();
        for (const r of dist || []) {
            ids.add(r.__id);
            if (!byKey.has(String(r[key]))) byKey.set(String(r[key]), []);
            byKey.get(String(r[key])).push(r);
        }
        const jur = engine.config.app.jurisdictions.find(j => j.id === aoi.kind);
        const peers = spec.peer_label || jur?.peer_label || jur?.label?.toLowerCase() || 'areas';

        const W = Math.max(320, Math.round(container.clientWidth || 480));
        const labelW = Math.min(spec.label_width || 170, Math.round(W * 0.34));
        const textW = Math.min(150, Math.round(W * 0.28));
        const stripX0 = labelW + 6, stripX1 = W - textW - 10;
        const rowH = 30, top = 2;
        const H = top + rows.length * rowH + 4;
        const maxChars = Math.max(8, Math.floor((labelW - 10) / 6.4));
        const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': spec.title || '', class: 'pstrip' });

        rows.forEach((r, i) => {
            const y = top + i * rowH, cy = y + rowH / 2;
            const name = String(r[labelCol] ?? r[key]);
            const format = (spec.format_field && r[spec.format_field]) || spec.format;
            const log = ((spec.scale_field && r[spec.scale_field]) || spec.scale) === 'log';
            const lab = el('text', { x: labelW - 8, y: cy + 4, 'text-anchor': 'end' });
            lab.textContent = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
            if (name.length > maxChars) { const t = el('title'); t.textContent = name; lab.appendChild(t); }
            svg.appendChild(lab);

            const v = isMissing(r[valueCol]) ? null : Number(r[valueCol]);
            const peersRows = byKey.get(String(r[key])) || [];
            const vals = peersRows.map(p => p[valueCol]).filter(x => !isMissing(x)).map(Number);
            const rank = rankOf(spec, r, v, vals);

            // track
            svg.appendChild(el('line', { x1: stripX0, x2: stripX1, y1: cy, y2: cy, class: 'pstrip-track' }));
            if (vals.length) {
                const sc = scale(vals.concat(v ?? []), log, stripX0, stripX1);
                for (const x of vals) svg.appendChild(el('line', { x1: sc(x), x2: sc(x), y1: cy - 6, y2: cy + 6, class: 'pstrip-peer' }));
                if (v !== null) {
                    const dot = el('circle', { cx: sc(v), cy, r: 5.5, class: 'pstrip-me' });
                    const clamped = log && v <= 0 ? '<br><i>≤ 0: drawn at the axis minimum</i>' : '';
                    hover(dot, `<b>${escapeHtml(name)}</b><br>${escapeHtml(aoi.label)}: ${fmt(v, format)}` +
                        (rank !== null ? `<br>${ordinal(rank)} percentile of ${vals.length} ${escapeHtml(peers)}` : '') + clamped);
                    svg.appendChild(dot);
                }
                const lo = el('title'); lo.textContent = `range ${fmt(Math.min(...vals), format)} – ${fmt(Math.max(...vals), format)}${log ? ' (log scale)' : ''}`;
                svg.lastChild.appendChild(lo);
            }

            const vt = el('text', { x: W - textW, y: cy - 1, class: 'val' });
            vt.textContent = fmt(v, format);
            svg.appendChild(vt);
            const rt = el('text', { x: W - textW, y: cy + 11, class: 'pstrip-rank' });
            rt.textContent = rank !== null ? `${ordinal(rank)} percentile` : (v === null ? '' : 'rank not available');
            svg.appendChild(rt);
        });
        container.appendChild(svg);

        const foot = document.createElement('div');
        foot.className = 'tile-note';
        foot.textContent = (ids.size ? `Ticks: all ${ids.size} ${peers}; dot: ${aoi.label}.` : 'Ranks need precomputed results for every area at this setting.') +
            (spec.note ? ' ' + spec.note : '');
        container.appendChild(foot);
    },

    css: `
.pstrip .pstrip-track { stroke: var(--grid, rgba(0,0,0,.08)); stroke-width: 1; }
.pstrip .pstrip-peer { stroke: var(--text-3, #77706b); stroke-opacity: .35; stroke-width: 1; }
.pstrip .pstrip-me { fill: var(--c, var(--primary, #006837)); stroke: #fff; stroke-width: 2; }
.pstrip .pstrip-rank { font-size: 10.5px; fill: var(--text-3, #77706b); }
`,
};

/** Displayed rank (0–100) or null: the row's rank_field, else the mid-rank among `vals`. */
export function rankOf(spec, row, v, vals) {
    if (spec.rank_field) {
        const r = row[spec.rank_field];
        return isMissing(r) ? null : Math.round(Number(r) * (spec.rank_scale ?? 1));
    }
    if (v === null || !vals.length) return null;
    const below = vals.filter(x => x < v).length, ties = vals.filter(x => x === v).length;
    let p = 100 * (below + 0.5 * ties) / vals.length;
    if (spec.direction_field && Number(row[spec.direction_field]) < 0) p = 100 - p;
    return Math.round(p);
}

/** Linear or log x-scale over the values, onto [x0, x1]. */
function scale(vals, log, x0, x1) {
    const f = log ? (x => Math.log10(x)) : (x => x);
    const pos = log ? vals.filter(x => x > 0) : vals;
    if (!pos.length) return () => (x0 + x1) / 2;
    let lo = Math.min(...pos.map(f)), hi = Math.max(...pos.map(f));
    if (hi === lo) { lo -= 1; hi += 1; }
    return x => {
        const t = log && x <= 0 ? lo : f(x);
        return x0 + ((t - lo) / (hi - lo)) * (x1 - x0);
    };
}
