/**
 * A set of named polygons the reader draws or uploads, for compare mode.
 * Unlike polygon-source.js, which merges every shape into one area, each
 * shape or GeoJSON feature stays its own unit.
 *
 *   const set = new UnitSetEditor(mapView, { role, color, prefix: 'f', onChange });
 *   set.mount(containerEl);          // buttons, file input, list of units
 *   set.units                        // [{ id: 'f1', name, geometry, ha }]
 *   set.renderExamples()             // after the list from `examples` changes
 *
 * Drawing keeps going after each shape is finished (double-click or click the
 * first point) until the reader presses Done or Escape. `examples` returns
 * [{ label, url }] GeoJSON files offered as one-click sets, for demonstrations;
 * loading one again replaces its shapes. Ids are generated, so
 * they are safe in SQL; names are only ever shown, never sent as SQL.
 */

import { DrawTool } from './draw.js';
import { escapeHtml } from '../core/format.js';

export const MAX_VERTICES = 20000;
const HINT = 'Click to add points; double-click or click the first point to finish a shape. Press Done when you have drawn them all.';

export class UnitSetEditor {
    constructor(mapView, { role, label = 'unit', color = '#c2410c', prefix = 'u', examples = () => [], onChange = () => {}, showHint = () => {}, hideHint = () => {} }) {
        Object.assign(this, { mv: mapView, role, label, color, prefix, examples, onChange, showHint, hideHint });
        this.units = [];
        this.n = 0;
        this.drawing = false;
        this.draw = new DrawTool(mapView, {
            onDone: geom => {
                this.add([{ name: `${capitalize(label)} ${this.n + 1}`, geometry: geom }]);
                if (this.drawing) this.draw.start();
            },
        });
        this._key = e => { if (e.key === 'Escape' && this.drawing) this.stopDrawing(); };
    }

    mount(el) {
        this.el = el;
        el.innerHTML = `
            <div class="draw-row">
                <button class="ghost-btn" data-act="draw" type="button">Draw</button>
                <label class="ghost-btn upload">Upload GeoJSON<input type="file" accept=".geojson,.json,application/geo+json,application/json" hidden></label>
                <button class="ghost-btn" data-act="clear" type="button" disabled>Clear</button>
            </div>
            <div class="draw-row examples" hidden></div>
            <div class="step-help unit-msg"></div>
            <ul class="unit-list"></ul>`;
        this.msg = el.querySelector('.unit-msg');
        el.querySelector('[data-act=draw]').onclick = () => (this.drawing ? this.stopDrawing() : this.startDrawing());
        el.querySelector('[data-act=clear]').onclick = () => { this.stopDrawing(); this.units = []; this.changed(); };
        el.querySelector('input[type=file]').onchange = async e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
                const feats = await readGeoJsonFeatures(file, this.label);
                this.add(feats);
                this.message(`Read ${feats.length} ${feats.length === 1 ? 'shape' : 'shapes'} from ${file.name}.`);
                this.mv.fitTo?.(this.units.map(u => u.geometry));
            } catch (err) {
                this.message(err.message, true);
            }
        };
        this.renderExamples();
        this.render();
    }

    renderExamples() {
        const row = this.el?.querySelector('.examples');
        if (!row) return;
        const list = this.examples();
        row.hidden = !list.length;
        row.innerHTML = list.map((x, i) => `<button class="ghost-btn" type="button" data-i="${i}">${escapeHtml(x.label)}</button>`).join('');
        row.onclick = async e => {
            const b = e.target.closest('button');
            if (!b) return;
            const x = list[+b.dataset.i];
            try {
                const res = await fetch(x.url);
                if (!res.ok) throw new Error(`Could not load ${x.label} (${res.status}).`);
                const feats = geoJsonFeatures(await res.json(), this.label);
                this.units = this.units.filter(u => u.example !== x.url);
                this.add(feats, x.url);
                this.message(`Loaded ${feats.length} ${feats.length === 1 ? 'shape' : 'shapes'} from ${x.label}.`);
                this.mv.fitTo?.(this.units.map(u => u.geometry));
            } catch (err) {
                this.message(err.message, true);
            }
        };
    }

    startDrawing() {
        this.drawing = true;
        this.el.querySelector('[data-act=draw]').textContent = 'Done';
        this.el.querySelector('[data-act=draw]').classList.add('active');
        window.addEventListener('keydown', this._key);
        this.showHint(HINT);
        this.draw.start();
    }

    stopDrawing() {
        if (!this.drawing) return;
        this.drawing = false;
        this.draw.cancel();
        window.removeEventListener('keydown', this._key);
        this.hideHint();
        const b = this.el?.querySelector('[data-act=draw]');
        if (b) { b.textContent = 'Draw'; b.classList.remove('active'); }
    }

    add(feats, example = null) {
        const total = [...this.units, ...feats].reduce((n, f) => n + vertexCount(f.geometry), 0);
        if (total > MAX_VERTICES) {
            this.message(`These shapes have ${total.toLocaleString()} vertices in all; please simplify them to under ${MAX_VERTICES.toLocaleString()}.`, true);
            return;
        }
        for (const f of feats) {
            this.n += 1;
            this.units.push({ id: `${this.prefix}${this.n}`, name: f.name, geometry: f.geometry, ha: areaHa(f.geometry), ...(example && { example }) });
        }
        this.changed();
    }

    remove(id) {
        this.units = this.units.filter(u => u.id !== id);
        this.changed();
    }

    changed() {
        this.render();
        this.onChange(this.units);
    }

    message(text, isErr = false) {
        if (!this.msg) return;
        this.msg.textContent = text;
        this.msg.classList.toggle('err', isErr);
    }

    render() {
        if (!this.el) return;
        const ul = this.el.querySelector('.unit-list');
        this.el.querySelector('[data-act=clear]').disabled = !this.units.length;
        ul.innerHTML = this.units.map(u => `
            <li data-id="${u.id}">
                <span class="swatch" style="--c:${this.color}"></span>
                <input class="unit-name" value="${escapeHtml(u.name)}" aria-label="Name of ${escapeHtml(u.name)}" spellcheck="false">
                <span class="unit-area">${fmtHa(u.ha)}</span>
                <button class="unit-del" type="button" title="Remove" aria-label="Remove ${escapeHtml(u.name)}">×</button>
            </li>`).join('');
        ul.querySelectorAll('li').forEach(li => {
            const u = this.units.find(x => x.id === li.dataset.id);
            li.querySelector('.unit-name').onchange = e => { u.name = e.target.value.trim() || u.id; this.onChange(this.units); };
            li.querySelector('.unit-del').onclick = () => this.remove(u.id);
            li.querySelector('.unit-name').onfocus = () => this.mv.fitTo?.([u.geometry]);
        });
    }
}

/**
 * Polygon features of a GeoJSON file, each with a display name taken from a
 * name-like property when there is one: [{ name, geometry }].
 */
export async function readGeoJsonFeatures(file, label = 'unit') {
    if (file.size > 50e6) throw new Error('File is larger than 50 MB; simplify it first.');
    let gj;
    try { gj = JSON.parse(await file.text()); } catch { throw new Error('Not a GeoJSON file.'); }
    return geoJsonFeatures(gj, label);
}

/** Polygon features of a parsed GeoJSON object: [{ name, geometry }]. */
export function geoJsonFeatures(gj, label = 'unit') {
    const out = [];
    const nameOf = (p, i) => {
        const k = p && Object.keys(p).find(k => /^(name|nombre|nom|farm|farm_name|id|code|codigo)$/i.test(k));
        return k && p[k] != null && String(p[k]).trim() ? String(p[k]).trim().slice(0, 80) : `${capitalize(label)} ${i + 1}`;
    };
    const visit = (o, props) => {
        if (!o) return;
        if (o.type === 'FeatureCollection') o.features.forEach(f => visit(f));
        else if (o.type === 'Feature') visit(o.geometry, o.properties || {});
        else if (o.type === 'GeometryCollection') o.geometries.forEach(g => visit(g, props));
        else if (o.type === 'Polygon' || o.type === 'MultiPolygon') out.push({ name: nameOf(props, out.length), geometry: o });
    };
    visit(gj);
    if (!out.length) throw new Error('No polygons found in this file.');
    const lonlat = c => (typeof c[0] === 'number' ? Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90 : c.every(lonlat));
    if (!out.every(f => lonlat(f.geometry.coordinates))) throw new Error('Coordinates must be longitude and latitude (EPSG:4326).');
    return out;
}

function vertexCount(g) {
    let n = 0;
    const walk = c => (typeof c[0] === 'number' ? n++ : c.forEach(walk));
    walk(g.coordinates);
    return n;
}

/** Spherical polygon area in hectares (outer rings minus holes). */
export function areaHa(g) {
    const R = 6371008.8, rad = Math.PI / 180;
    const ring = r => {
        let s = 0;
        for (let i = 0; i < r.length - 1; i++) {
            const [x1, y1] = r[i], [x2, y2] = r[i + 1];
            s += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
        }
        return Math.abs(s * R * R / 2);
    };
    const poly = p => ring(p[0]) - p.slice(1).reduce((a, h) => a + ring(h), 0);
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    return polys.reduce((a, p) => a + poly(p), 0) / 1e4;
}

export const fmtHa = ha => (ha >= 100 ? `${Math.round(ha).toLocaleString()} ha` : `${ha.toFixed(ha >= 10 ? 0 : 1)} ha`);
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
