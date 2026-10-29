/**
 * One basket layer at a time on the compare-mode map, as hexagons.
 *
 * A hexagon's value comes from the layer's own theme SQL with each hexagon
 * treated as a unit, so the map shows exactly what a unit of that size would
 * score in a comparison. Two sources feed it:
 *   overview  data/maps/<country>/<theme>.json, written by `precompute maps`:
 *             every resolution-6 hexagon (about 36 km²) of the country, used
 *             below DETAIL_ZOOM
 *   detail    a live query over the hexagons in view, finer as the map zooms
 *             in (resolution 7, 8, then 9)
 * Colour classes are quantiles of the overview values, so the colours mean
 * the same at every zoom.
 *
 *   const lm = new LayerMap(mapView, { query, base, variables, themes });
 *   lm.setCountry(country);
 *   lm.show(variableId);   // null hides the layer
 */

import { expand } from './engine.js';
import { fmt, escapeHtml } from './format.js';
import { countryTokens } from '../sources/units.js';

export const OVERVIEW_RES = 6;
export const DETAIL_ZOOM = 8;
/** Sequential blue, light to dark (the dataviz reference ramp, steps 100 to 700). */
export const LAYER_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
/** Hexagons in view above which a live query is not run. */
const MAX_CELLS = 40000;
const AREA_KM2 = { 5: 252.9, 6: 36.13, 7: 5.161, 8: 0.7373, 9: 0.1053 };

/**
 * The hexagon resolution drawn at a zoom: the overview below DETAIL_ZOOM, then
 * one resolution finer every two zoom levels, which keeps a hexagon's edge at
 * roughly 5 to 25 pixels on MapLibre's 512-pixel tiles.
 */
export const resAtZoom = z => (z < DETAIL_ZOOM ? OVERVIEW_RES : z < 10 ? 7 : z < 12 ? 8 : 9);

/**
 * {{UNITS}} with one unit per hexagon: cells is SQL returning one resolution-8
 * cell per row as `h8`, grouped to their resolution-`res` parent.
 */
export const overviewUnitsSql = (cellsSql, res = OVERVIEW_RES) =>
    `SELECT 'map' AS grp, h3_h3_to_string(h3_cell_to_parent(h8, ${res})) AS id, 0 AS stratum, h8 AS cell FROM (${cellsSql.trim()})`;

/** {{UNITS}} for the hexagons of resolution `res` (7 to 9) whose centres fall in a bounding box. */
export function viewUnitsSql([x0, y0, x1, y1], res) {
    if (![x0, y0, x1, y1].every(Number.isFinite) || ![7, 8, 9].includes(res)) throw new Error('Invalid map view');
    const c = v => v.toFixed(5);
    const wkt = `POLYGON((${c(x0)} ${c(y0)}, ${c(x1)} ${c(y0)}, ${c(x1)} ${c(y1)}, ${c(x0)} ${c(y1)}, ${c(x0)} ${c(y0)}))`;
    const v = `SELECT unnest(h3_polygon_wkt_to_cells('${wkt}', ${res})) AS c`;
    // theme queries take cells of resolution 8 to 10; a resolution-7 hexagon is its seven children
    return res === 7
        ? `SELECT 'map' AS grp, h3_h3_to_string(c) AS id, 0 AS stratum, unnest(h3_cell_to_children(c, 8)) AS cell FROM (${v})`
        : `SELECT 'map' AS grp, h3_h3_to_string(c) AS id, 0 AS stratum, c AS cell FROM (${v})`;
}

/** One variable's (id, value) rows from a theme's units SQL over map units. */
export const layerSql = (themeSql, tokens, units, variable) => {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(variable)) throw new Error(`Invalid variable: ${variable}`);
    return `SELECT id, value FROM (${expand(themeSql, { ...tokens, UNITS: units }).trim()}) WHERE variable = '${variable}' AND value IS NOT NULL`;
};

/**
 * Interior quantile cut points of `vals` for k classes, deduplicated. A value
 * equal to a cut point falls in the class below it (classOf), so a layer with
 * many ties, such as a share that is mostly 0, keeps its ties in one class.
 */
export function quantileCuts(vals, k = LAYER_RAMP.length) {
    const s = vals.filter(Number.isFinite).sort((a, b) => a - b);
    const out = [];
    if (!s.length) return out;
    for (let i = 1; i < k; i++) {
        const q = s[Math.min(s.length - 1, Math.floor((i / k) * s.length))];
        // a cut at the maximum would leave the class above it empty
        if ((!out.length || q > out[out.length - 1]) && q < s[s.length - 1]) out.push(q);
    }
    return out;
}

/** The class of x: how many cut points lie below it. */
export const classOf = (x, cuts) => cuts.filter(c => x > c).length;

/** Colours for n classes, spread over the ramp so that few classes still contrast. */
export const rampFor = n => (n <= 1 ? [LAYER_RAMP[LAYER_RAMP.length - 1]]
    : Array.from({ length: n }, (_, i) => LAYER_RAMP[Math.round((i * (LAYER_RAMP.length - 1)) / (n - 1))]));

export class LayerMap {
    /**
     * mv        the MapView
     * query     (sql) → Promise<rows>, cached by the caller
     * base      the app folder, for data/maps
     * variables [{ id, label, theme, format, unit }]
     * themes    the loaded themes ({ id, sql: { units } })
     * legend    the legend element
     * aboutUrl  (variable id) → URL of the layer's documentation, or null
     * below     () → id of the map layer to draw beneath (e.g. the units)
     */
    constructor(mv, { query, base, variables, themes, legend, aboutUrl = () => null, below = () => 'ref', onChange = () => {} }) {
        Object.assign(this, { mv, query, base, variables, themes, legend, aboutUrl, below, onChange });
        this.current = null;
        this.overviews = new Map();
        this.token = 0;
        this._popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    }

    setCountry(country) {
        this.country = country;
        if (this.current) this.show(this.current);
    }

    /** Show one variable on the map, or hide the layer with null. */
    async show(id) {
        this.current = id || null;
        this.onChange(this.current);
        await this.mv.ready;
        this._install();
        if (!this.current) { this._setData([]); this.legend.hidden = true; return; }
        this._legend({ loading: true });
        await this.refresh();
    }

    _install() {
        const m = this.mv.map;
        if (m.getSource('lyr')) return;
        m.addSource('lyr', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'lyr-fill', type: 'fill', source: 'lyr', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.78 } }, this.below());
        m.on('moveend', () => { if (this.current) this.refresh(); });
        m.on('mousemove', 'lyr-fill', e => {
            const p = e.features[0]?.properties, v = this._var();
            if (!p || !v || this.mv._drawing) return;
            this._popup.setLngLat(e.lngLat).setHTML(`${escapeHtml(v.label)}: <b>${valueText(p.value, v)}</b><br><span class="lyr-pop-note">Hexagon of ${areaText(p.res)}</span>`).addTo(m);
        });
        m.on('mouseleave', 'lyr-fill', () => this._popup.remove());
    }

    _var() { return this.variables.find(v => v.id === this.current); }

    overview(themeId) {
        const key = `${this.country.id}/${themeId}`;
        if (!this.overviews.has(key)) this.overviews.set(key, fetch(`${this.base}/data/maps/${key}.json`, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null));
        return this.overviews.get(key);
    }

    /** Redraw for the current view: the overview when zoomed out, live hexagons when zoomed in. */
    async refresh() {
        const v = this._var();
        if (!v) return;
        const token = ++this.token;
        const m = this.mv.map;
        const theme = this.themes.find(t => t.id === v.theme);
        const ov = await this.overview(v.theme);
        if (token !== this.token) return;
        const ovVals = ov?.values?.[v.id];
        const cuts = ovVals ? quantileCuts(ovVals) : this._liveCuts?.[v.id] || null;
        const res = resAtZoom(m.getZoom());
        let rows;
        if (res === OVERVIEW_RES) {
            if (!ovVals) {
                this._setData([]);
                this._legend({ note: `Zoom in to see this layer. ${this.country ? `It has no overview for ${this.country.name}.` : ''}` });
                return;
            }
            rows = ov.ids.map((id, i) => ({ id, value: ovVals[i] }));
        } else {
            const b = m.getBounds(), pad = 0.15;
            const dx = (b.getEast() - b.getWest()) * pad, dy = (b.getNorth() - b.getSouth()) * pad;
            const box = [b.getWest() - dx, Math.max(-85, b.getSouth() - dy), b.getEast() + dx, Math.min(85, b.getNorth() + dy)];
            const snap = s => Math.max(1e-3, s / 8);
            const sx = snap(box[2] - box[0]), sy = snap(box[3] - box[1]);
            const grid = [Math.floor(box[0] / sx) * sx, Math.floor(box[1] / sy) * sy, Math.ceil(box[2] / sx) * sx, Math.ceil(box[3] / sy) * sy];
            const n = bboxKm2(grid) / AREA_KM2[res];
            if (n > MAX_CELLS) { this._legend({ note: 'Zoom in further to see this layer in detail.' }); return; }
            this._legend({ cuts, loading: true, res });
            try {
                rows = await this.query(layerSql(theme.sql.units, countryTokens(this.country), viewUnitsSql(grid, res), v.id));
            } catch (err) {
                if (token === this.token) this._legend({ cuts, res, note: `The layer failed to load: ${String(err.message).split('\n')[0].slice(0, 160)}` });
                return;
            }
            if (token !== this.token) return;
        }
        const useCuts = cuts || ((this._liveCuts ??= {})[v.id] = quantileCuts(rows.map(r => Number(r.value))));
        this._setData(rows, useCuts, res);
        this._legend({ cuts: useCuts, res, empty: !rows.length });
    }

    _setData(rows, cuts = [], res = OVERVIEW_RES) {
        const src = this.mv.map.getSource('lyr');
        if (!src) return;
        const ramp = rampFor(cuts.length + 1);
        const colorOf = x => ramp[classOf(x, cuts)];
        const features = [];
        for (const r of rows) {
            const x = Number(r.value);
            if (!Number.isFinite(x)) continue;
            const ring = h3.cellToBoundary(r.id, true);
            // a hexagon across the antimeridian would wrap the whole map
            if (Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) > 180) continue;
            features.push({ type: 'Feature', properties: { value: x, color: colorOf(x), res }, geometry: { type: 'Polygon', coordinates: [ring] } });
        }
        src.setData({ type: 'FeatureCollection', features });
    }

    _legend({ cuts = null, res = null, loading = false, note = '', empty = false } = {}) {
        const v = this._var(), el = this.legend;
        if (!v) { el.hidden = true; return; }
        const about = this.aboutUrl(v.id);
        const used = cuts ? rampFor(cuts.length + 1) : [];
        el.innerHTML = `
            <div class="lyr-head"><span class="title">${escapeHtml(v.label)}</span><button type="button" class="lyr-close" aria-label="Hide layer" title="Hide layer">×</button></div>
            ${used.length ? `<div class="ramp">${used.map(c => `<span style="background:${c}"></span>`).join('')}</div>
            <div class="ends"><span>${cuts.length ? `${valueText(cuts[0], v)} or less` : ''}</span><span>${cuts.length ? `over ${valueText(cuts[cuts.length - 1], v)}` : ''}</span></div>` : ''}
            <div class="tile-note">${loading ? 'Loading…' : empty ? 'No data in view.' : note || (res ? `Hexagons of ${areaText(res)}. Colour classes hold about equal numbers of ${escapeHtml(this.country?.name || '')} hexagons.` : '')}</div>
            ${about ? `<a class="lyr-about" href="${escapeHtml(about)}" target="_blank" rel="noopener">About this layer</a>` : ''}`;
        el.hidden = false;
        el.querySelector('.lyr-close').onclick = () => this.show(null);
    }
}

const valueText = (x, v) => (x == null || x === '' ? '—' : `${fmt(Number(x), v.format)}${v.unit ? ` ${escapeHtml(v.unit)}` : ''}`);
const areaText = res => {
    const a = AREA_KM2[res];
    return a == null ? 'varying size' : a >= 1 ? `about ${Math.round(a)} km²` : `about ${Math.round(a * 100)} ha`;
};

/** Area of a lon/lat box in km². */
function bboxKm2([x0, y0, x1, y1]) {
    const R = 6371.0088, rad = Math.PI / 180;
    return R * R * Math.abs((x1 - x0) * rad) * Math.abs(Math.sin(y1 * rad) - Math.sin(y0 * rad));
}

export const layerMapCss = `
#layer-picker { top: 10px; left: 10px; padding: 6px 8px; display: flex; align-items: center; gap: 6px; font-size: 12.5px; max-width: calc(100% - 70px); }
#layer-picker label { color: var(--text-2); white-space: nowrap; }
#layer-picker select { max-width: 260px; padding: 3px 6px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--card-bg); font-size: 12.5px; }
#layer-legend .lyr-head { display: flex; align-items: flex-start; gap: 8px; }
#layer-legend .title { font-weight: 600; flex: 1 1 auto; }
#layer-legend .lyr-close { border: none; background: none; cursor: pointer; color: var(--text-3); font-size: 16px; line-height: 1; padding: 0 2px; }
#layer-legend .ramp { display: flex; height: 10px; border-radius: 2px; overflow: hidden; margin: 5px 0 3px; }
#layer-legend .ramp span { flex: 1; }
#layer-legend .ends { display: flex; justify-content: space-between; gap: 8px; color: var(--text-3); font-variant-numeric: tabular-nums; }
#layer-legend .tile-note { color: var(--text-3); margin-top: 4px; }
#layer-legend .lyr-about { display: inline-block; margin-top: 4px; font-size: 12px; }
.lyr-pop-note { color: var(--text-3); font-size: 11.5px; }
.metric .about { margin-left: auto; font-size: 11.5px; color: var(--text-3); text-decoration: none; }
.metric .about:hover { color: var(--primary); text-decoration: underline; }
@media (max-width: 820px) { #layer-picker select { max-width: 150px; } }
`;
