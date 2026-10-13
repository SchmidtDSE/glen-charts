/**
 * Map: basemap, app overlays (vector PMTiles layers registered by the app,
 * e.g. conserved areas), area-type boundaries (PMTiles), the selected outline,
 * a tract or hexagon choropleth driven by query results, isochrones and
 * drawn/uploaded shapes.
 *
 * Boundary style (optional), app.boundary_style overridden per area type by boundary.style:
 *   { fill, opacity, hover_opacity, line, line_opacity, selected, selected_width, selected_opacity }
 */

import { fmt, escapeHtml } from './format.js';
import { hover } from './charts.js';

const BASE_STYLE = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
        base: {
            type: 'raster', tileSize: 256, maxzoom: 16,
            tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
            attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
        },
        ref: {
            type: 'raster', tileSize: 256, maxzoom: 16,
            tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
        },
    },
    layers: [
        { id: 'base', type: 'raster', source: 'base' },
        // data layers are inserted below 'ref' so place labels stay on top
        { id: 'ref', type: 'raster', source: 'ref' },
    ],
};

export class MapView {
    constructor(containerId, app) {
        this.app = app;
        const protocol = new pmtiles.Protocol();
        maplibregl.addProtocol('pmtiles', protocol.tile);
        this.map = new maplibregl.Map({
            container: containerId,
            style: BASE_STYLE,
            center: app.view.center,
            zoom: app.view.zoom,
            attributionControl: { compact: true },
        });
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        this.ready = new Promise(r => this.map.on('load', r));
        this.jur = null;
        this.onPick = () => {};
        this._hoverId = null;
        this._popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
        this._choro = null;
    }

    /**
     * A vector overlay below the boundaries and labels:
     *   { id, url, source_layer, type = 'fill', paint, popup?(properties) → html }
     * Its popup is suppressed where a boundary is under the pointer, so the
     * boundary's own popup wins.
     */
    async addOverlay(o) {
        await this.ready;
        const m = this.map;
        const src = `ov-${o.id}`, layer = `ov-${o.id}-${o.type || 'fill'}`;
        if (!m.getSource(src)) m.addSource(src, { type: 'vector', url: `pmtiles://${o.url}` });
        m.addLayer({ id: layer, type: o.type || 'fill', source: src, 'source-layer': o.source_layer, paint: o.paint || {} }, 'ref');
        (this._overlays ??= new Map()).set(o.id, layer);
        if (!o.popup) return;
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
        m.on('mousemove', layer, e => {
            if (this._drawing || (this.jur && m.getLayer('jur-fill') && m.queryRenderedFeatures(e.point, { layers: ['jur-fill'] }).length)) return;
            const p = e.features[0]?.properties;
            if (p) popup.setLngLat(e.lngLat).setHTML(o.popup(p)).addTo(m);
        });
        m.on('mouseleave', layer, () => popup.remove());
    }

    setOverlayVisible(id, on) {
        const layer = this._overlays?.get(id);
        if (layer && this.map.getLayer(layer)) this.map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
    }

    clearJurisdiction() {
        const m = this.map;
        if (!m.getStyle()) return;
        for (const id of ['jur-fill', 'jur-line', 'jur-hover', 'jur-selected']) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource('jur')) m.removeSource('jur');
        this.jur = null;
        this._popup.remove();
    }

    fit(view) {
        this.map.easeTo({ center: view.center, zoom: view.zoom, duration: 700 });
    }

    /** Drawn or uploaded polygons: outline and fit. */
    async showShape(geoms) {
        await this.ready;
        const m = this.map;
        const fc = { type: 'FeatureCollection', features: geoms.map(g => ({ type: 'Feature', properties: {}, geometry: g })) };
        if (m.getSource('shape')) m.getSource('shape').setData(fc);
        else {
            m.addSource('shape', { type: 'geojson', data: fc });
            m.addLayer({ id: 'shape-fill', type: 'fill', source: 'shape', paint: { 'fill-color': '#111', 'fill-opacity': 0.06 } });
            m.addLayer({ id: 'shape-line', type: 'line', source: 'shape', paint: { 'line-color': '#111', 'line-width': 2.5 } });
        }
        const b = new maplibregl.LngLatBounds();
        const walk = c => (typeof c[0] === 'number' ? b.extend(c) : c.forEach(walk));
        geoms.forEach(g => walk(g.coordinates));
        if (!b.isEmpty()) m.fitBounds(b, { padding: 50, duration: 700, maxZoom: 13 });
    }

    clearShape() {
        if (this.map.getSource('shape')) this.map.getSource('shape').setData({ type: 'FeatureCollection', features: [] });
    }

    /**
     * jur.boundary.filter may hold param tokens ("{{WIDTH}}") anywhere in its
     * MapLibre expression; `tokens` ({ WIDTH: '10' }) fills them, as numbers
     * when numeric. setBoundaryTokens() re-applies it when a param changes.
     */
    async showJurisdiction(jur, tokens = {}) {
        await this.ready;
        const m = this.map;
        for (const id of ['jur-fill', 'jur-line', 'jur-hover', 'jur-selected']) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource('jur')) m.removeSource('jur');
        this.jur = jur;
        const b = jur.boundary;
        m.addSource('jur', { type: 'vector', url: `pmtiles://${b.url}`, promoteId: b.id_prop });
        this._tokens = tokens;
        const filter = this._boundaryFilter();
        const st = { fill: '#22201f', opacity: 0, hover_opacity: 0.10, line: '#2f4a2c', line_opacity: 0.55, selected: '#111', selected_width: 2.5, selected_opacity: 1, ...this.app.boundary_style, ...b.style };
        m.addLayer({
            id: 'jur-fill', type: 'fill', source: 'jur', 'source-layer': b.source_layer, filter,
            paint: {
                'fill-color': st.fill,
                'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], st.hover_opacity, st.opacity],
            },
        }, 'ref');
        m.addLayer({
            id: 'jur-line', type: 'line', source: 'jur', 'source-layer': b.source_layer, filter,
            paint: { 'line-color': st.line, 'line-opacity': st.line_opacity, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1.2] },
        }, 'ref');
        m.addLayer({
            id: 'jur-selected', type: 'line', source: 'jur', 'source-layer': b.source_layer,
            filter: ['==', ['get', b.id_prop], '__none__'],
            paint: { 'line-color': st.selected, 'line-width': st.selected_width, 'line-opacity': st.selected_opacity },
        });
        this._wire();
    }

    _wire() {
        if (this._wired) return;
        this._wired = true;
        const m = this.map;
        m.on('mousemove', 'jur-fill', e => {
            const f = e.features[0];
            if (!f || this._drawing) return;
            m.getCanvas().style.cursor = 'pointer';
            if (this._hoverId !== null && this._hoverId !== f.id) {
                m.setFeatureState({ source: 'jur', sourceLayer: this.jur.boundary.source_layer, id: this._hoverId }, { hover: false });
            }
            this._hoverId = f.id;
            m.setFeatureState({ source: 'jur', sourceLayer: this.jur.boundary.source_layer, id: f.id }, { hover: true });
            const name = f.properties[this.jur.boundary.name_prop] ?? f.id;
            let html = `<b>${escapeHtml(name)}</b>`;
            const t = this._tractAt(e.point);
            if (t) html += `<br>${escapeHtml(this._choro.label)}: ${fmt(t.value, this._choro.format)}`;
            this._popup.setLngLat(e.lngLat).setHTML(html).addTo(m);
        });
        m.on('mouseleave', 'jur-fill', () => {
            m.getCanvas().style.cursor = '';
            if (this._hoverId !== null) {
                m.setFeatureState({ source: 'jur', sourceLayer: this.jur.boundary.source_layer, id: this._hoverId }, { hover: false });
            }
            this._hoverId = null;
            this._popup.remove();
        });
        m.on('click', 'jur-fill', e => {
            if (this._drawing) return;
            const f = e.features[0];
            if (f) this.onPick(String(f.properties[this.jur.boundary.id_prop] ?? f.id));
        });
    }

    _tractAt(point) {
        if (!this._choro || !this.map.getLayer('tract-fill')) return null;
        const f = this.map.queryRenderedFeatures(point, { layers: ['tract-fill'] })[0];
        if (!f) return null;
        const id = String(f.properties[this.app.tracts.id_prop]);
        return this._choro.values.has(id) ? { id, value: this._choro.values.get(id) } : null;
    }

    async select(id, bbox) {
        await this.ready;
        const b = this.jur.boundary;
        this._selectedId = String(id);
        this.map.setFilter('jur-selected', this._selectedFilter());
        if (bbox && bbox.every(Number.isFinite)) {
            // xmin > xmax: the area crosses the antimeridian; fit across it
            const xmax = bbox[2] < bbox[0] ? bbox[2] + 360 : bbox[2];
            const narrow = window.matchMedia('(max-width: 820px)').matches;
            this.map.fitBounds([[bbox[0], bbox[1]], [xmax, bbox[3]]], { padding: narrow ? 20 : 50, duration: 800 });
        }
    }

    _boundaryFilter() {
        const f = this.jur?.boundary.filter;
        if (!f) return true;
        const fill = v => Array.isArray(v) ? v.map(fill)
            : typeof v === 'string' && /^\{\{\w+\}\}$/.test(v) ? num(this._tokens?.[v.slice(2, -2)] ?? v)
            : typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (m, k) => this._tokens?.[k] ?? m)
            : v;
        return fill(f);
    }

    _selectedFilter() {
        const b = this.jur.boundary;
        const byId = ['==', ['to-string', ['get', b.id_prop]], this._selectedId ?? '__none__'];
        return b.filter ? ['all', this._boundaryFilter(), byId] : byId;
    }

    /** New param tokens: re-filter the boundaries and the selected outline. */
    setBoundaryTokens(tokens) {
        this._tokens = tokens;
        if (!this.jur?.boundary.filter) return;
        for (const id of ['jur-fill', 'jur-line']) if (this.map.getLayer(id)) this.map.setFilter(id, this._boundaryFilter());
        if (this.map.getLayer('jur-selected')) this.map.setFilter('jur-selected', this._selectedFilter());
    }

    clearSelection() {
        this._selectedId = null;
        if (this.map.getLayer('jur-selected')) this.map.setFilter('jur-selected', this._selectedFilter());
        this.clearChoropleth();
    }

    /**
     * rows: [{ [idField]: GEOID, [valueField]: number }]
     * spec: theme.map  { id_field, value_field, label, format, ramp, breaks? }
     */
    async setChoropleth(spec, rows) {
        await this.ready;
        const m = this.map;
        const t = this.app.tracts;
        if (!m.getSource('tracts')) {
            m.addSource('tracts', { type: 'vector', url: `pmtiles://${t.url}` });
        }
        for (const id of ['tract-fill', 'tract-line']) if (m.getLayer(id)) m.removeLayer(id);

        const values = new Map();
        for (const r of rows) {
            const v = Number(r[spec.value_field]);
            if (Number.isFinite(v)) values.set(String(r[spec.id_field]), v);
        }
        if (!values.size) { this.clearChoropleth(); return null; }
        const breaks = spec.breaks || quantileBreaks([...values.values()], spec.ramp.length);
        const colorOf = v => spec.ramp[Math.min(spec.ramp.length - 1, breaks.filter(b => v >= b).length)];

        const match = ['match', ['to-string', ['get', t.id_prop]]];
        for (const [id, v] of values) match.push(id, colorOf(v));
        match.push('rgba(0,0,0,0)');

        m.addLayer({
            id: 'tract-fill', type: 'fill', source: 'tracts', 'source-layer': t.source_layer,
            filter: ['in', ['to-string', ['get', t.id_prop]], ['literal', [...values.keys()]]],
            paint: { 'fill-color': match, 'fill-opacity': 0.78 },
        }, 'jur-fill');
        m.addLayer({
            id: 'tract-line', type: 'line', source: 'tracts', 'source-layer': t.source_layer,
            filter: ['in', ['to-string', ['get', t.id_prop]], ['literal', [...values.keys()]]],
            paint: { 'line-color': '#fff', 'line-width': 0.4, 'line-opacity': 0.8 },
        }, 'jur-fill');
        this._choro = { ...spec, values };
        return { breaks, ramp: spec.ramp, n: values.size };
    }

    clearChoropleth() {
        for (const id of ['tract-fill', 'tract-line']) if (this.map.getLayer(id)) this.map.removeLayer(id);
        this._choro = null;
    }
}

/* ------------------------------------------------ isochrones & hexagons */

const BAND_COLORS = ['#0f5132', '#2f8f5b', '#7cc59a', '#b9e3c6'];

Object.assign(MapView.prototype, {
    /** Generic click on empty map (used by point-based variants). */
    onMapClick(cb) {
        this.ready.then(() => this.map.on('click', e => cb(e.lngLat)));
    },

    async setOrigin(lngLat) {
        await this.ready;
        if (!this._origin) {
            const el = document.createElement('div');
            el.className = 'origin-marker';
            this._origin = new maplibregl.Marker({ element: el });
        }
        this._origin.setLngLat(lngLat).addTo(this.map);
    },

    /**
     * bands: [{ minutes, geometry }] ascending; `selected` minutes is emphasised.
     * Drawn largest-first so smaller bands sit on top.
     */
    async showIsochrones(bands, selected, { fit = true } = {}) {
        await this.ready;
        const m = this.map;
        const fc = {
            type: 'FeatureCollection',
            features: bands.map((b, i) => ({ type: 'Feature', geometry: b.geometry, properties: { minutes: b.minutes, rank: i, selected: b.minutes === selected } })).reverse(),
        };
        if (m.getSource('iso')) m.getSource('iso').setData(fc);
        else {
            m.addSource('iso', { type: 'geojson', data: fc });
            const color = ['match', ['get', 'rank'], 0, BAND_COLORS[0], 1, BAND_COLORS[1], 2, BAND_COLORS[2], BAND_COLORS[3]];
            m.addLayer({ id: 'iso-fill', type: 'fill', source: 'iso', paint: { 'fill-color': color, 'fill-opacity': ['case', ['get', 'selected'], 0.10, 0.03] } }, 'ref');
            m.addLayer({ id: 'iso-line', type: 'line', source: 'iso', paint: {
                'line-color': color,
                'line-width': ['case', ['get', 'selected'], 2.6, 1.2],
                'line-dasharray': ['case', ['get', 'selected'], ['literal', [1, 0]], ['literal', [2, 1.5]]],
            } });
        }
        if (fit) {
            const b = new maplibregl.LngLatBounds();
            const walk = c => (typeof c[0] === 'number' ? b.extend(c) : c.forEach(walk));
            bands.forEach(x => walk(x.geometry.coordinates));
            const narrow = window.matchMedia('(max-width: 820px)').matches;
            m.fitBounds(b, { padding: narrow ? 20 : 60, duration: 700, maxZoom: 15 });
        }
    },

    clearIsochrones() {
        if (this.map.getSource('iso')) this.map.getSource('iso').setData({ type: 'FeatureCollection', features: [] });
    },

    /**
     * Hexagon choropleth from rows [{ [id_field]: '89283082803ffff', [value_field]: n }].
     * Cell ids must be H3 *strings* (use h3_h3_to_string in SQL; UBIGINTs lose
     * precision as JSON numbers).
     */
    async setHexChoropleth(spec, rows) {
        await this.ready;
        const m = this.map;
        const values = new Map();
        for (const r of rows) {
            const v = Number(r[spec.value_field]);
            if (Number.isFinite(v) && r[spec.id_field]) values.set(String(r[spec.id_field]), v);
        }
        if (!values.size) { this.clearHexChoropleth(); return null; }
        const breaks = spec.breaks || quantileBreaks([...values.values()], spec.ramp.length);
        const colorOf = v => spec.ramp[Math.min(spec.ramp.length - 1, breaks.filter(b => v >= b).length)];
        const fc = { type: 'FeatureCollection', features: [] };
        for (const [id, v] of values) {
            const ring = h3.cellToBoundary(id, true);
            fc.features.push({ type: 'Feature', properties: { id, value: v, color: colorOf(v) }, geometry: { type: 'Polygon', coordinates: [ring] } });
        }
        if (m.getSource('hex')) m.getSource('hex').setData(fc);
        else {
            m.addSource('hex', { type: 'geojson', data: fc });
            m.addLayer({ id: 'hex-fill', type: 'fill', source: 'hex', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.72, 'fill-outline-color': 'rgba(255,255,255,0.6)' } }, m.getLayer('iso-fill') ? 'iso-fill' : 'ref');
            m.on('mousemove', 'hex-fill', e => {
                const f = e.features[0];
                if (!f || !this._hexSpec) return;
                this._popup.setLngLat(e.lngLat).setHTML(`${escapeHtml(this._hexSpec.label)}: <b>${fmt(f.properties.value, this._hexSpec.format)}</b>`).addTo(m);
            });
            m.on('mouseleave', 'hex-fill', () => this._popup.remove());
        }
        this._hexSpec = spec;
        return { breaks, ramp: spec.ramp, n: values.size };
    },

    clearHexChoropleth() {
        if (this.map.getSource('hex')) this.map.getSource('hex').setData({ type: 'FeatureCollection', features: [] });
        this._hexSpec = null;
    },
});

const num = v => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : v);

/** Interior quantile cut points (ramp.length − 1 of them), deduplicated. */
function quantileBreaks(vals, k) {
    const s = [...vals].sort((a, b) => a - b);
    const out = [];
    for (let i = 1; i < k; i++) {
        const q = s[Math.min(s.length - 1, Math.floor((i / k) * s.length))];
        if (!out.length || q > out[out.length - 1]) out.push(q);
    }
    return out;
}

export function renderLegend(el, spec, info) {
    if (!info) { el.hidden = true; return; }
    const { breaks, ramp } = info;
    const used = ramp.slice(0, breaks.length + 1);
    el.innerHTML = `
        <div class="title">${escapeHtml(spec.label)}</div>
        <div class="ramp">${used.map(c => `<span style="background:${c}"></span>`).join('')}</div>
        <div class="ends"><span>${breaks.length ? '< ' + fmt(breaks[0], spec.format) : ''}</span><span>${breaks.length ? '≥ ' + fmt(breaks[breaks.length - 1], spec.format) : ''}</span></div>
        <div class="tile-note">${escapeHtml(spec.note || 'Census tracts, quantile classes within this area')}</div>`;
    el.hidden = false;
    // per-class hover readout
    el.querySelectorAll('.ramp span').forEach((s, i) => {
        const a = i === 0 ? null : breaks[i - 1];
        const b = i < breaks.length ? breaks[i] : null;
        const txt = a === null ? `< ${fmt(b, spec.format)}` : b === null ? `≥ ${fmt(a, spec.format)}` : `${fmt(a, spec.format)} – ${fmt(b, spec.format)}`;
        hover(s, txt);
    });
}
