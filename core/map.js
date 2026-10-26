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

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';

/**
 * Basemaps (app.json "basemap"): a name below, or { tiles, attribution, ref_tiles? }.
 * `ref_tiles` is a label overlay drawn above the data layers; without one,
 * labels are part of the base tiles and the data layers sit on top of them.
 */
const BASEMAPS = {
    'light-gray': {
        tiles: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
        ref_tiles: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
        attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    },
    'dark-gray': {
        tiles: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
        ref_tiles: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
        attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    },
    natgeo: {
        tiles: `${ESRI}/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}`,
        attribution: 'Tiles &copy; Esri &mdash; National Geographic, Esri, DeLorme, NAVTEQ, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA',
    },
};

function baseStyle(basemap = 'light-gray') {
    const b = typeof basemap === 'object' ? basemap : (BASEMAPS[basemap] || BASEMAPS['light-gray']);
    const sources = { base: { type: 'raster', tileSize: 256, maxzoom: 16, tiles: [b.tiles], attribution: b.attribution || '' } };
    if (b.ref_tiles) sources.ref = { type: 'raster', tileSize: 256, maxzoom: 16, tiles: [b.ref_tiles] };
    return {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources,
        layers: [
            { id: 'base', type: 'raster', source: 'base' },
            // data layers are inserted below 'ref' so place labels stay on top;
            // with no label overlay, 'ref' is an invisible anchor
            b.ref_tiles ? { id: 'ref', type: 'raster', source: 'ref' }
                : { id: 'ref', type: 'background', paint: { 'background-opacity': 0 } },
        ],
    };
}

export class MapView {
    constructor(containerId, app) {
        this.app = app;
        const protocol = new pmtiles.Protocol();
        maplibregl.addProtocol('pmtiles', protocol.tile);
        this.map = new maplibregl.Map({
            container: containerId,
            style: baseStyle(app.basemap),
            center: app.view.center,
            zoom: app.view.zoom,
            attributionControl: { compact: true },
        });
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        this.ready = new Promise(r => this.map.on('load', r));
        this.jur = null;
        this.onPick = () => {};
        this.popupExtra = null;      // (id) → extra popup HTML for a boundary
        this._hoverId = null;
        this._popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
        this._choro = null;
    }

    /**
     * A vector overlay below the boundaries and labels:
     *   { id, url, source_layer, type = 'fill', paint, popup?(properties) → html, above? }
     * `above: true` draws it on top of the boundaries instead, so it stays visible
     * over leaderboard colours. Its popup is suppressed where a boundary is under
     * the pointer either way, so the boundary's own popup wins.
     */
    async addOverlay(o) {
        await this.ready;
        const m = this.map;
        const src = `ov-${o.id}`, layer = `ov-${o.id}-${o.type || 'fill'}`;
        if (!m.getSource(src)) m.addSource(src, { type: 'vector', url: `pmtiles://${o.url}` });
        m.addLayer({ id: layer, type: o.type || 'fill', source: src, 'source-layer': o.source_layer, paint: o.paint || {} }, o.above ? undefined : 'ref');
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
     * when numeric. boundary.url and boundary.source_layer may hold tokens too,
     * for areas drawn from one tile set per param value (e.g. one PMTiles per
     * basin level). setBoundaryTokens() re-applies them when a param changes.
     */
    async showJurisdiction(jur, tokens = {}) {
        await this.ready;
        const m = this.map;
        for (const id of ['jur-fill', 'jur-line', 'jur-hover', 'jur-selected']) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource('jur')) m.removeSource('jur');
        this.jur = jur;
        const b = jur.boundary;
        this._tokens = tokens;
        this._url = this._fillTokens(b.url);
        this._srcLayer = this._fillTokens(b.source_layer);
        m.addSource('jur', { type: 'vector', url: `pmtiles://${this._url}`, promoteId: b.id_prop });
        const filter = this._boundaryFilter();
        const st = this._st = { fill: '#22201f', opacity: 0, hover_opacity: 0.10, line: '#2f4a2c', line_opacity: 0.55, selected: '#111', selected_width: 2.5, selected_opacity: 1, ...this.app.boundary_style, ...b.style };
        m.addLayer({
            id: 'jur-fill', type: 'fill', source: 'jur', 'source-layer': this._srcLayer, filter,
            paint: {
                'fill-color': st.fill,
                'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], st.hover_opacity, st.opacity],
            },
        }, 'ref');
        m.addLayer({
            id: 'jur-line', type: 'line', source: 'jur', 'source-layer': this._srcLayer, filter,
            paint: { 'line-color': st.line, 'line-opacity': st.line_opacity, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1.2] },
        }, 'ref');
        m.addLayer({
            id: 'jur-selected', type: 'line', source: 'jur', 'source-layer': this._srcLayer,
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
                m.setFeatureState({ source: 'jur', sourceLayer: this._srcLayer, id: this._hoverId }, { hover: false });
            }
            this._hoverId = f.id;
            m.setFeatureState({ source: 'jur', sourceLayer: this._srcLayer, id: f.id }, { hover: true });
            const name = f.properties[this.jur.boundary.name_prop] ?? f.id;
            let html = `<b>${escapeHtml(name)}</b>`;
            const t = this._tractAt(e.point);
            if (t) html += `<br>${escapeHtml(this._choro.label)}: ${fmt(t.value, this._choro.format)}`;
            if (this.popupExtra) html += this.popupExtra(String(f.properties[this.jur.boundary.id_prop] ?? f.id)) || '';
            this._popup.setLngLat(e.lngLat).setHTML(html).addTo(m);
        });
        m.on('mouseleave', 'jur-fill', () => {
            m.getCanvas().style.cursor = '';
            if (this._hoverId !== null) {
                m.setFeatureState({ source: 'jur', sourceLayer: this._srcLayer, id: this._hoverId }, { hover: false });
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
        if (!this._choro) return null;
        const layers = this._choro.levels.map(L => `tract-fill-${L.id}`).filter(id => this.map.getLayer(id));
        if (!layers.length) return null;
        const f = this.map.queryRenderedFeatures(point, { layers })[0];
        if (!f) return null;
        const L = this._choro.levels.find(x => `tract-fill-${x.id}` === f.layer.id);
        const id = String(f.properties[L.id_prop]);
        return L.values.has(id) ? { id, value: L.values.get(id) } : null;
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

    _fillTokens(s) {
        return typeof s === 'string' ? s.replace(/\{\{(\w+)\}\}/g, (m, k) => this._tokens?.[k] ?? m) : s;
    }

    /**
     * New param tokens: re-filter the boundaries and the selected outline, or,
     * when the tile set itself follows a param, reload it and re-apply the
     * selection and any colours.
     */
    async setBoundaryTokens(tokens) {
        this._tokens = tokens;
        if (!this.jur) return;
        const b = this.jur.boundary;
        if (this._fillTokens(b.url) !== this._url || this._fillTokens(b.source_layer) !== this._srcLayer) {
            this._hoverId = null;
            await this.showJurisdiction(this.jur, tokens);
            this.map.setFilter('jur-selected', this._selectedFilter());
            if (this._colors) await this.setJurisdictionColors(this._colors);
            return;
        }
        if (!b.filter) return;
        for (const id of ['jur-fill', 'jur-line']) if (this.map.getLayer(id)) this.map.setFilter(id, this._boundaryFilter());
        if (this.map.getLayer('jur-selected')) this.map.setFilter('jur-selected', this._selectedFilter());
    }

    /**
     * Colour the boundaries themselves: colors is a Map id → colour (ids as
     * strings, matched by value), or null to restore the plain style. Areas
     * not in the map are left clear but stay clickable.
     */
    async setJurisdictionColors(colors) {
        await this.ready;
        this._colors = colors;
        const m = this.map;
        if (!m.getLayer('jur-fill')) return;
        const st = this._st;
        if (!colors || !colors.size) {
            m.setPaintProperty('jur-fill', 'fill-color', st.fill);
            m.setPaintProperty('jur-fill', 'fill-opacity', ['case', ['boolean', ['feature-state', 'hover'], false], st.hover_opacity, st.opacity]);
            m.setPaintProperty('jur-line', 'line-color', st.line);
            m.setPaintProperty('jur-line', 'line-opacity', st.line_opacity);
            m.setPaintProperty('jur-line', 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1.2]);
            return;
        }
        const match = ['match', ['to-string', ['get', this.jur.boundary.id_prop]]];
        for (const [id, c] of colors) match.push(String(id), c);
        match.push('rgba(0,0,0,0)');
        m.setPaintProperty('jur-fill', 'fill-color', match);
        m.setPaintProperty('jur-fill', 'fill-opacity', ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.82]);
        // thin bands vanish at world zoom; a coloured outline keeps them visible
        const line = match.slice();
        line[line.length - 1] = st.line;
        m.setPaintProperty('jur-line', 'line-color', line);
        m.setPaintProperty('jur-line', 'line-opacity', 0.95);
        m.setPaintProperty('jur-line', 'line-width', ['interpolate', ['linear'], ['zoom'], 1, 1.6, 5, 1.2, 10, 1.2]);
    }

    /** Hover-highlight one area from outside the map (e.g. a table row); null clears. */
    highlight(id) {
        const m = this.map;
        if (!this.jur || !m.getSource('jur')) return;
        const src = { source: 'jur', sourceLayer: this._srcLayer };
        if (this._hoverId !== null) m.setFeatureState({ ...src, id: this._hoverId }, { hover: false });
        this._hoverId = null;
        if (id === null || id === undefined) return;
        const fid = Number.isFinite(Number(id)) ? Number(id) : id;
        this._hoverId = fid;
        m.setFeatureState({ ...src, id: fid }, { hover: true });
    }

    clearSelection() {
        this._selectedId = null;
        if (this.map.getLayer('jur-selected')) this.map.setFilter('jur-selected', this._selectedFilter());
        this.clearChoropleth();
    }

    /**
     * rows: [{ [idField]: GEOID, [valueField]: number }], or, when app.tracts lists several
     * grids, { <level id>: rows } with one set of rows per grid, each keyed by its grid's id_prop.
     * spec: theme.map  { id_field, value_field, label, format, ramp, breaks? }
     * Each grid is drawn only within its own minzoom/maxzoom, so a coarse grid can stand in
     * for a fine one at low zoom. Quantile breaks come from the first grid with values.
     */
    async setChoropleth(spec, rows) {
        await this.ready;
        const m = this.map;
        const levels = tractLevels(this.app);
        const byLevel = Array.isArray(rows) ? { [levels[0].id]: rows } : rows || {};
        this.clearChoropleth();

        // with several grids, each grid's rows carry that grid's id_prop column
        const idField = L => (levels.length > 1 ? L.id_prop : spec.id_field);
        const sets = levels.map(L => {
            const values = new Map();
            for (const r of byLevel[L.id] || []) {
                const v = Number(r[spec.value_field]);
                if (Number.isFinite(v)) values.set(String(r[idField(L)]), v);
            }
            return values;
        });
        const first = sets.find(v => v.size);
        if (!first) return null;
        const breaks = spec.breaks || quantileBreaks([...first.values()], spec.ramp.length);
        const colorOf = v => spec.ramp[Math.min(spec.ramp.length - 1, breaks.filter(b => v >= b).length)];

        levels.forEach((L, i) => {
            const values = sets[i];
            if (!values.size) return;
            const src = `tracts-${L.id}`;
            if (!m.getSource(src)) m.addSource(src, { type: 'vector', url: `pmtiles://${L.url}` });
            const zoom = { ...(L.minzoom != null && { minzoom: L.minzoom }), ...(L.maxzoom != null && { maxzoom: L.maxzoom }) };
            const match = ['match', ['to-string', ['get', L.id_prop]]];
            for (const [id, v] of values) match.push(id, colorOf(v));
            match.push('rgba(0,0,0,0)');
            const filter = ['in', ['to-string', ['get', L.id_prop]], ['literal', [...values.keys()]]];
            m.addLayer({
                id: `tract-fill-${L.id}`, type: 'fill', source: src, 'source-layer': L.source_layer, filter, ...zoom,
                paint: { 'fill-color': match, 'fill-opacity': 0.78 },
            }, 'jur-fill');
            m.addLayer({
                id: `tract-line-${L.id}`, type: 'line', source: src, 'source-layer': L.source_layer, filter, ...zoom,
                paint: { 'line-color': '#fff', 'line-width': L.line_width ?? 0.4, 'line-opacity': 0.8 },
            }, 'jur-fill');
        });
        this._choro = { ...spec, levels: levels.map((L, i) => ({ ...L, values: sets[i] })) };
        return { breaks, ramp: spec.ramp, n: first.size };
    }

    clearChoropleth() {
        const m = this.map;
        if (m.getStyle()) for (const l of m.getStyle().layers) if (/^tract-(fill|line)-/.test(l.id)) m.removeLayer(l.id);
        this._choro = null;
    }
}

/**
 * app.tracts as a list of grids, each with an id: a single object (the original form) is one grid.
 *   { id?, url, source_layer, id_prop, line_width?, minzoom?, maxzoom? }
 */
export const tractLevels = app => (Array.isArray(app.tracts) ? app.tracts : app.tracts ? [app.tracts] : [])
    .map((t, i) => ({ ...t, id: String(t.id ?? i) }));

/** The query a theme's map runs on each grid: map.levels[<grid id>], else map.query. */
export const mapQueries = (app, spec) => tractLevels(app).map(L => ({ level: L.id, query: spec.levels?.[L.id] ?? spec.query }));

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
export function quantileBreaks(vals, k) {
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
