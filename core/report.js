/**
 * Theme card renderer: headline tiles, charts and the "Method & SQL"
 * disclosure for one theme over one area.
 *
 * Chart types come from a registry. A type is
 *   { load?(ctx) → Promise<data>, render(el, chart, data, ctx), css? }
 * with ctx = { engine, theme, chart, aoi, isRegion, opts }. "bar" (the
 * default, also used for charts with no type) and "percentile-strip" are
 * built in; an app registers more through createExplorer({ charts }).
 *
 * Comparisons:
 *   - the whole region (app.statewide), when the app has one: a tile's
 *     "California: …" line and a bar chart's tick per row;
 *   - reference values (app.reference: { url, label, values }) published
 *     elsewhere, shown on the region's own view: a tile's `reference` path
 *     and a chart's `reference_row` path into the values file.
 */

import { renderBarChart } from './charts.js';
import { percentileStrip } from '../charts/percentile-strip.js';
import { fmt, escapeHtml } from './format.js';

export const barChart = {
    load({ engine, theme, chart: c, aoi, isRegion, params }) {
        if (c.pivot) return pivotRows(engine, theme, c, aoi).then(rows => [rows, null]);
        const wantRegion = !isRegion && (c.compare || c.statewide_row);
        return Promise.all([engine.run(theme, c.query, aoi), wantRegion ? engine.runStatewide(theme, c.query, params).catch(() => null) : null]);
    },
    render(plot, c, [rows, st], { aoi, isRegion, opts }) {
        if (c.statewide_row) {
            // one-row result → compare this place and the region side by side
            // (on the region's own view: the region beside a reference value)
            rows = [{ ...rows?.[0], __label: opts.shortName(aoi.label) }];
            if (st?.[0]) rows.push({ ...st[0], __label: opts.compareLabel });
            st = null;
            const rr = isRegion && c.reference_row ? pick(opts.reference?.values, c.reference_row) : null;
            if (rr) rows.push({ ...rr, __label: opts.reference.chart_label || opts.reference.label });
        }
        renderBarChart(plot, { ...c, compare: c.compare && { label: opts.compareLabel, ...c.compare } }, rows, st);
    },
};

export const builtinCharts = { bar: barChart, 'percentile-strip': percentileStrip };

/**
 * opts:
 *   overview      the overview card (no dot, no blurb)
 *   isCurrent()   false once the area changed; late results are dropped
 *   onMapToggle   (themeId) → void, for themes with a map
 *   charts        chart-type registry
 *   compareLabel  the region's name ("California")
 *   reference     { label, values } or null
 *   shortName     label → short label for chart rows
 *   params        current param values
 */
export function renderThemeCard(engine, theme, aoi, opts = {}) {
    const { overview = false, isCurrent = () => true, onMapToggle = null, charts: registry = builtinCharts, params = aoi.params || {} } = opts;
    opts = { compareLabel: engine.config.app.statewide?.label || 'Region', reference: null, shortName: s => s, ...opts };
    const isRegion = aoi.kind === 'state';
    const hasRegion = !!engine.config.app.statewide;
    const card = document.createElement('section');
    card.className = 'card' + (overview ? '' : ' theme-card');
    card.dataset.theme = theme.id;
    card.style.setProperty('--c', theme.color || 'var(--primary)');
    card.innerHTML = `
        <div class="card-head">
            <h3>${overview ? '' : '<span class="dot"></span>'}${escapeHtml(theme.label)}</h3>
            ${!overview && theme.map ? `<button class="map-btn" type="button" data-theme="${theme.id}">Show on map</button>` : ''}
        </div>
        ${theme.blurb && !overview ? `<p class="card-blurb">${escapeHtml(theme.blurb)}</p>` : ''}
        <div class="tiles"></div>
        <div class="charts"></div>
        <details class="method"><summary>Method &amp; SQL</summary><div class="method-body"></div></details>`;

    const mapBtn = card.querySelector('.map-btn');
    if (mapBtn) {
        if (onMapToggle) mapBtn.onclick = () => onMapToggle(theme.id);
        else mapBtn.remove();
    }

    const tiles = card.querySelector('.tiles');
    tiles.dataset.n = (theme.headlines || []).length;
    for (const h of theme.headlines || []) {
        const t = document.createElement('div');
        t.className = 'tile skeleton';
        t.innerHTML = `<div class="tile-label">${escapeHtml(h.label)}</div><div class="tile-value">0000</div><div class="tile-compare">&nbsp;</div>`;
        tiles.appendChild(t);
        const wantRegion = hasRegion && h.compare !== false && !isRegion;
        Promise.all([engine.run(theme, h.query, aoi), wantRegion ? engine.runStatewide(theme, h.query, params).catch(() => null) : null])
            .then(([rows, st]) => {
                if (!isCurrent()) return;
                t.classList.remove('skeleton');
                const row = pickRow(rows, h.row);
                const v = row?.[h.field];
                const sv = pickRow(st, h.row)?.[h.compare_field || h.field];
                const rv = isRegion && h.reference ? pick(opts.reference?.values, h.reference) : null;
                t.innerHTML = `
                    <div class="tile-label">${escapeHtml(h.label)}</div>
                    <div class="tile-value">${fmt(v, h.format)}</div>
                    ${wantRegion && sv !== undefined && sv !== null ? `<div class="tile-compare">${escapeHtml(opts.compareLabel)}: ${fmt(sv, h.compare_format || h.format)}</div>` : ''}
                    ${rv != null ? `<div class="tile-compare" title="${escapeHtml(opts.reference.title || opts.reference.label)}">${escapeHtml(opts.reference.label)}: ${fmt(rv, h.format)}</div>` : ''}
                    ${h.detail_field && row?.[h.detail_field] != null ? `<div class="tile-note">${escapeHtml(h.detail_template.replace('{}', fmt(row[h.detail_field], h.detail_format)))}</div>` : ''}
                    ${h.note ? `<div class="tile-note">${escapeHtml(h.note)}</div>` : ''}`;
                if (h.rank) addRank(engine, theme, h, aoi, t, isCurrent);
            })
            .catch(err => failTile(t, h, err, isCurrent));
    }

    const charts = card.querySelector('.charts');
    for (const c of theme.charts || []) {
        const type = registry[c.type || 'bar'];
        const box = document.createElement('div');
        box.className = 'chart' + (c.wide ? ' wide' : '');
        box.innerHTML = `<h4>${escapeHtml(c.title || '')}</h4>${c.subtitle ? `<div class="sub">${escapeHtml(c.subtitle)}</div>` : ''}<div class="plot skeleton" style="height:120px"></div>`;
        charts.appendChild(box);
        const plot = box.querySelector('.plot');
        const ctx = { engine, theme, chart: c, aoi, isRegion, params, opts };
        const fail = err => {
            if (!isCurrent()) return;
            plot.classList.remove('skeleton');
            plot.style.height = '';
            plot.innerHTML = `<div class="err">Query failed: ${escapeHtml(shortErr(err))}</div>`;
            console.error(err, err.sql);
        };
        if (!type) { fail(new Error(`Unknown chart type "${c.type}"`)); continue; }
        Promise.resolve(type.load ? type.load(ctx) : engine.run(theme, c.query, aoi))
            .then(data => {
                if (!isCurrent()) return;
                plot.classList.remove('skeleton');
                plot.style.height = '';
                type.render(plot, c, data, ctx);
            })
            .catch(fail);
    }

    // method + exact SQL as run for this area
    const mb = card.querySelector('.method-body');
    card.querySelector('details').addEventListener('toggle', function once() {
        mb.innerHTML = (theme.method ? `<p>${escapeHtml(theme.method)}</p>` : '') +
            Object.keys(theme.queries)
                .map(q => `<div><b>${escapeHtml(q)}</b></div><pre>${escapeHtml(safeSql(engine, theme, q, aoi))}</pre>`).join('');
    }, { once: true });
    return card;
}

/** "#9 of 58 California counties" from the precomputed peer table. */
async function addRank(engine, theme, h, aoi, tile, isCurrent) {
    const jur = engine.config.app.jurisdictions?.find(j => j.id === aoi.kind);
    if (!jur || !aoi.id) return;
    const peers = await engine.peers(theme.id, jur.id);
    const field = h.rank.field || h.field;
    const vals = (peers || []).filter(r => r[field] != null);
    const me = vals.find(r => r.id === aoi.id);
    if (!me || !isCurrent()) return;
    const rank = 1 + vals.filter(r => r[field] > me[field]).length;
    const el = document.createElement('div');
    el.className = 'tile-rank';
    el.innerHTML = `<b>#${rank}</b> of ${vals.length} ${escapeHtml(jur.peer_label || jur.label.toLowerCase())}`;
    tile.querySelector('.tile-value').after(el);
}

function failTile(t, h, err, isCurrent) {
    if (!isCurrent()) return;
    t.classList.remove('skeleton');
    t.innerHTML = `<div class="tile-label">${escapeHtml(h.label)}</div><div class="tile-value">—</div><div class="err" title="${escapeHtml(err.message)}">Query failed</div>`;
    console.error(err, err.sql);
}

/**
 * Build chart rows from one-row results of several queries:
 *   pivot: [{ label, query, fields: { seriesField: resultColumn } }]
 */
async function pivotRows(engine, theme, c, aoi) {
    const queries = [...new Set(c.pivot.map(p => p.query))];
    const results = Object.fromEntries(await Promise.all(queries.map(async q => [q, (await engine.run(theme, q, aoi))?.[0] || {}])));
    return c.pivot.map(p => {
        const row = { __label: p.label };
        for (const [k, col] of Object.entries(p.fields)) row[k] = results[p.query][col];
        return row;
    });
}

/** First row, or the row whose fields match `where` (e.g. {"grp": "DAC tracts"}). */
export function pickRow(rows, where) {
    if (!rows) return null;
    if (!where) return rows[0];
    return rows.find(r => Object.entries(where).every(([k, v]) => r[k] === v)) || null;
}

/** A dotted path into an object ("network.burned_past_decade"). */
export const pick = (obj, path) => String(path).split('.').reduce((o, k) => o?.[k], obj) ?? null;

export const shortErr = err => (err.message || String(err)).split('\n')[0].slice(0, 160);

/** The SQL as it runs for this area, or the template error as text. */
export function safeSql(engine, theme, q, aoi) {
    try { return engine.sqlFor(theme, q, aoi); } catch (err) { return `-- ${err.message}`; }
}
