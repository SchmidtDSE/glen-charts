/**
 * Area source: the area reachable from a point in a given travel time.
 * The reader picks a starting point (map click or address search), a travel
 * mode and a time; the source fetches nested isochrones from a Valhalla
 * router and hands the explorer the selected band as an area (isochrone.js).
 * The bands add {{BANDS10}}, {{ORIGIN_LAT}} and {{ORIGIN_LON}} to the theme
 * SQL. The point, mode and time are kept in the link (#@lat,lon?mode=walk&t=15).
 *
 *   createExplorer({ extensions: { sources: [isochroneSource()] } })
 *
 * app.json:
 *   "routing":    { "url": "https://valhalla1.openstreetmap.de" }
 *   "isochrones": { "modes": ["walk", "bike", "drive"], "minutes": [5, 10, 15],
 *                   "default_mode": "walk", "default_minutes": 15,
 *                   "geocode_bbox": [west, south, east, north],   // optional
 *                   "hint": "Click anywhere to start" }            // optional
 */

import { MODES, fetchIsochrones, bandsAoi, geocode, reverseGeocode } from './isochrone.js';
import { escapeHtml, fmt } from '../core/format.js';

const BAND_COLORS = ['#0f5132', '#2f8f5b', '#7cc59a', '#b9e3c6'];   // as the map's isochrone layers

export function isochroneSource({ id = 'reach', label = 'Travel time', description = 'The area reachable from a point in a given travel time', kindLabel = 'Reachable area' } = {}) {
    let ctx = null, cfg = null, el = null, active = false;
    const st = { origin: null, mode: null, minutes: null, bands: null, aoi: null, token: 0 };

    const hint = () => cfg.hint || 'Click the map to choose a starting point';
    const modeLabel = () => MODES[st.mode].label.toLowerCase();
    const where = () => st.origin?.name || (st.origin ? `${st.origin.lat.toFixed(4)}, ${st.origin.lon.toFixed(4)}` : '');
    const title = () => `${st.minutes}-minute ${modeLabel()} from ${where()}`;

    function seg(wrap, items, current, onPick) {
        wrap.innerHTML = items.map(({ id: v, label: l }) =>
            `<button type="button" role="radio" data-v="${escapeHtml(v)}" aria-checked="${String(v) === String(current)}">${escapeHtml(l)}</button>`).join('');
        wrap.querySelectorAll('button').forEach(b => { b.onclick = () => onPick(b.dataset.v); });
    }

    function renderSegs() {
        seg(el.querySelector('[data-seg=mode]'), cfg.modes.map(m => ({ id: m, label: MODES[m].label })), st.mode, m => {
            if (m === st.mode) return;
            st.mode = m;
            renderSegs();
            if (st.origin) loadIsochrones();
            ctx.writeHash();
        });
        seg(el.querySelector('[data-seg=time]'), cfg.minutes.map(m => ({ id: m, label: `${m} min` })), st.minutes, v => {
            const m = Number(v);
            if (m === st.minutes) return;
            st.minutes = m;
            renderSegs();
            if (st.bands) { ctx.mapView.showIsochrones(st.bands, st.minutes, { fit: false }); useBands(); }
            ctx.writeHash();
        });
    }

    function wireSearch() {
        const input = el.querySelector('.search-input');
        const list = el.querySelector('.search-results');
        let matches = [], active_ = -1, timer = null, seq = 0;
        const close = () => { list.hidden = true; active_ = -1; };
        const render = () => {
            list.innerHTML = matches.map((f, i) =>
                `<li role="option" data-i="${i}" aria-selected="${i === active_}">${escapeHtml(f.name)}${f.detail ? `<small>${escapeHtml(f.detail)}</small>` : ''}</li>`).join('');
            list.hidden = !matches.length;
        };
        input.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (q.length < 3) { matches = []; render(); return; }
            timer = setTimeout(async () => {
                const my = ++seq;
                try {
                    const r = await geocode(q, { bbox: cfg.geocode_bbox || null });
                    if (my === seq) { matches = r; active_ = -1; render(); }
                } catch (e) { console.warn(e); }
            }, 300);
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { active_ = Math.min(matches.length - 1, active_ + 1); render(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { active_ = Math.max(0, active_ - 1); render(); e.preventDefault(); }
            else if (e.key === 'Enter') { const f = matches[active_ >= 0 ? active_ : 0]; if (f) { setOrigin(f); close(); input.blur(); } }
            else if (e.key === 'Escape') close();
        });
        list.addEventListener('mousedown', e => {
            const li = e.target.closest('li');
            if (li) { setOrigin(matches[Number(li.dataset.i)]); close(); }
        });
        input.addEventListener('blur', () => setTimeout(close, 150));
    }

    async function setOrigin(o) {
        ctx.select();
        st.origin = { lon: +o.lon, lat: +o.lat, name: o.name || null };
        ctx.hideHint();
        ctx.mapView.setOrigin([st.origin.lon, st.origin.lat]);
        const input = el.querySelector('.search-input');
        input.value = st.origin.name || `${st.origin.lat.toFixed(4)}, ${st.origin.lon.toFixed(4)}`;
        if (!st.origin.name) nameOrigin(st.origin);
        ctx.writeHash();
        await loadIsochrones();
    }

    /** Name a clicked point once the reverse lookup answers, without re-running anything. */
    async function nameOrigin(o) {
        try {
            const r = await reverseGeocode(o);
            if (!r || st.origin !== o) return;
            o.name = r.name;
            el.querySelector('.search-input').value = r.label;
            if (st.aoi) {
                st.aoi.label = title();
                const h = document.querySelector('#report .report-head h2');
                if (h) h.textContent = st.aoi.label;
            }
        } catch { /* keep the coordinates */ }
    }

    async function loadIsochrones() {
        const token = ++st.token;
        st.bands = null;
        ctx.mapView.clearHexChoropleth();
        ctx.showMessage(`<div class="intro"><p>Finding everywhere within ${cfg.minutes.join(', ')} minutes by ${escapeHtml(modeLabel())}…</p></div>`);
        try {
            const bands = await fetchIsochrones(cfg.routing, st.origin, st.mode, cfg.minutes);
            if (token !== st.token || !active) return;
            st.bands = bands;
            ctx.mapView.showIsochrones(bands, st.minutes);
            useBands();
        } catch (err) {
            if (token !== st.token) return;
            ctx.showMessage(`<div class="err">Could not compute travel times here: ${escapeHtml(String(err.message || err).split('\n')[0])}</div>`);
            console.error(err);
        }
    }

    function useBands() {
        st.aoi = bandsAoi(st.bands, st.minutes, title(), st.origin);
        st.aoi.kindLabel = kindLabel;
        ctx.setAoi(st.aoi);
    }

    return {
        id,
        label,
        description,
        kindLabel,

        mount(step, c) {
            ctx = c;
            const app = c.app || {};
            const iso = app.isochrones || {};
            cfg = {
                routing: app.routing || { url: 'https://valhalla1.openstreetmap.de' },
                modes: (iso.modes || ['walk', 'bike', 'drive']).filter(m => MODES[m]),
                minutes: (iso.minutes || [5, 10, 15]).map(Number),
                geocode_bbox: iso.geocode_bbox,
                hint: iso.hint,
                labels: { origin: 'Start from', mode: 'Travel by', time: 'Within', ...(iso.labels || {}) },
            };
            st.mode = cfg.modes.includes(iso.default_mode) ? iso.default_mode : cfg.modes[0];
            st.minutes = cfg.minutes.includes(Number(iso.default_minutes)) ? Number(iso.default_minutes) : cfg.minutes[cfg.minutes.length - 1];
            el = step;
            // several steps of its own: the wrapper only groups them
            step.classList.remove('step');
            step.innerHTML = `
                <div class="step">
                    <div class="step-label"><span class="step-num">1</span> ${escapeHtml(cfg.labels.origin)}</div>
                    <div class="search">
                        <input class="search-input" type="search" autocomplete="off" spellcheck="false"
                            placeholder="Search an address or place, or click the map" aria-label="Starting point">
                        <ul class="search-results" role="listbox" hidden></ul>
                    </div>
                </div>
                <div class="step-row">
                    <div class="step">
                        <div class="step-label"><span class="step-num">2</span> ${escapeHtml(cfg.labels.mode)}</div>
                        <div class="seg" data-seg="mode" role="radiogroup" aria-label="Travel mode"></div>
                    </div>
                    <div class="step">
                        <div class="step-label"><span class="step-num">3</span> ${escapeHtml(cfg.labels.time)}</div>
                        <div class="seg" data-seg="time" role="radiogroup" aria-label="Travel time"></div>
                    </div>
                </div>`;
            renderSegs();
            wireSearch();
            c.mapView.onMapClick(ll => { if (active) setOrigin({ lon: ll.lng, lat: ll.lat }); });
        },

        activate({ restoring = false } = {}) {
            active = true;
            if (!restoring && !st.origin) ctx.showHint(hint());
        },

        deactivate() {
            active = false;
            st.token++;
            st.origin = null; st.bands = null; st.aoi = null;
            el.querySelector('.search-input').value = '';
            ctx.mapView.clearIsochrones();
            ctx.mapView.clearOrigin();
        },

        /** The band legend under the report title. */
        reportHead() {
            return `<div class="band-legend">${cfg.minutes.map((m, i) =>
                `<span><i class="${m === st.minutes ? '' : 'dash'}" style="border-color:${BAND_COLORS[i] || BAND_COLORS[3]}"></i>${fmt(m, 'int')} min</span>`).join('')}</div>`;
        },

        hashState() {
            return {
                path: st.origin ? `@${st.origin.lat.toFixed(5)},${st.origin.lon.toFixed(5)}` : '',
                query: { mode: st.mode, t: st.minutes },
            };
        },

        async restore(path, q) {
            if (cfg.modes.includes(q.get('mode'))) st.mode = q.get('mode');
            const t = Number(q.get('t'));
            if (cfg.minutes.includes(t)) st.minutes = t;
            renderSegs();
            const m = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(path || '');
            if (m) await setOrigin({ lat: +m[1], lon: +m[2] });
            else ctx.showHint(hint());
        },
    };
}
