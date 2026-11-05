/**
 * createExplorer: the app controller. Area (the whole region, an area type's
 * feature, or an app area source such as a drawn polygon) → params →
 * sections → report + map. State is mirrored to the URL hash
 * (#county/06001?themes=a,b&map=a&width=10), so a view is a shareable link.
 *
 *   import { createExplorer } from '.../glen-charts@v0.1.0/core/explorer.js';
 *   createExplorer({ extensions });
 *
 * The page supplies its own header and stylesheet; the explorer renders the
 * map and sidebar into `root` (default: <main id="glen">, created if absent).
 * Everything about the app is in config/app.json and config/themes/; the
 * extensions object adds what config cannot express:
 *
 *   tokens     { NAME: (aoi, app, params) → string }   extra SQL template tokens
 *   charts     { type: { load?, render, css? } }       chart types (see report.js)
 *   overlays   [{ id, url, source_layer, type?, paint, popup?(props) → html,
 *                 legend?: html, toggle?: 'Show …' }]  map layers under the boundaries
 *   sources    [areaSource]                            extra area modes (sources/polygon-source.js)
 *   reportHead (aoi, ctx) → html                       shown under the report title
 *   shortName  (label) → short label                  for chart rows
 *
 * app.json fields used here (beyond the engine's): title, intro (HTML),
 * labels { area, sections, place_hint, map_chips }, statewide { label, kind_label,
 * description, selectable (false: comparisons only, not an area to pick) }, reference
 * { values, label, chart_label, title, citation, url, note }, project_url,
 * live_note, engine ("mcp" | "wasm"), wasm, data_base, format, id, default_area, overlays (as the
 * extension overlays, with a declared popup; see installOverlays), leaderboard
 * (core/leaderboard.js: a second tab ranking every area of one type), pages
 * ([{ id, label, file, full?, sources? }]: tabs showing an HTML file, e.g. an About page;
 * sources: true appends the dataset citations from data/sources.json), chat (core/chat.js:
 * an optional assistant, loaded only when this block is present; without it no LLM code loads).
 * Extensions may add views: [{ id, label, full?, render(el, ctx) }], tabs of their own.
 * A view with full: true hides the map and gives the panel the whole width.
 * A param with "control": "slider" is drawn as a slider over its options. A slider param with
 * "relative": { theme, query, field, format?, note?, offset_format? } holds offsets from a value
 * that depends on the area (e.g. a species' measured threshold): once an area is chosen, the query
 * is run and each stop is labelled base + offset; note ("Default: the team's value, {}") shows the
 * base, and offset_format ("{} °C from the team's value") labels the offset elsewhere.
 * A param with "control": "number" is drawn as a box for a typed number. The value is held to
 * the nearest option, so it stays one of the options; with "relative" the box shows and takes
 * base + offset, as a relative slider's stops do.
 * An area type with "picker": "map" is chosen by clicking the map only: the
 * search box gives way to labels.place_hint.
 * A param with "multiple": true is drawn as toggle pills (any number may be on; "any" names an
 * exclusive option, see engine.js). An area type with "multiple": true takes several areas at
 * once: each pick adds one, shown as a removable tag, a map click toggles one, and the profile is
 * of their union.
 */

import { loadConfig, Engine, jurisdictionAoi, statewideAoi, resolveParams, paramActive, optionValue, optionLabel, nearestOption, paramKey, paramTokens, paramDefault, paramValues, paramValueLabel, toggleMulti } from './engine.js';
import { MapView, renderLegend, quantileBreaks, mapQueries } from './map.js';
import { Leaderboard, leaderboardCss } from './leaderboard.js';
import { renderThemeCard, builtinCharts, shortErr } from './report.js';
import { wireExportButton } from './export.js';
import { escapeHtml, setFormatOptions, fmt } from './format.js';

const SHELL = `
    <section id="map-wrap">
        <div id="map"></div>
        <div id="map-chips" class="map-overlay" hidden></div>
        <div class="map-legends map-overlay">
            <div id="map-legend" hidden></div>
            <div id="overlay-legend" hidden></div>
        </div>
        <div id="map-hint" class="map-overlay" hidden></div>
    </section>
    <aside id="sidebar">
        <div class="sidebar-resize" title="Drag to resize"></div>
        <section id="controls">
            <div class="step" id="step-jur">
                <div class="step-label"><span class="step-num">1</span> <span data-label="area">Area</span></div>
                <div class="seg" id="jur-buttons" role="radiogroup" aria-label="Area type"></div>
            </div>
            <div class="step" id="step-place" hidden>
                <div class="step-label"><span class="step-num">2</span> <span id="place-label">Place</span></div>
                <div class="search">
                    <input id="place-input" type="search" autocomplete="off" spellcheck="false"
                        placeholder="Choose an area type first" disabled
                        aria-autocomplete="list" aria-controls="place-results" aria-label="Search places">
                    <ul id="place-results" role="listbox" hidden></ul>
                </div>
                <div class="area-tags" id="area-tags" role="list" aria-label="Chosen areas" hidden></div>
            </div>
            <div id="source-steps"></div>
            <div class="step" id="step-params" hidden></div>
            <div class="step" id="step-themes">
                <div class="step-label" data-label="sections">Sections</div>
                <div class="chips" id="theme-buttons" role="group" aria-label="Sections"></div>
            </div>
        </section>
        <section id="report" aria-live="polite"></section>
    </aside>`;

export async function createExplorer({ root = null, base = '.', extensions = {} } = {}) {
    const ext = { tokens: {}, charts: {}, overlays: [], sources: [], views: [], ...extensions };
    let el = typeof root === 'string' ? document.querySelector(root) : root;
    if (!el) el = document.getElementById('glen');
    if (!el) { el = document.createElement('main'); el.id = 'glen'; document.body.appendChild(el); }
    el.id ||= 'glen';
    el.classList.add('glen-layout');
    el.innerHTML = SHELL;
    if (!document.getElementById('tooltip')) {
        const t = document.createElement('div');
        t.id = 'tooltip'; t.setAttribute('role', 'tooltip'); t.hidden = true;
        document.body.appendChild(t);
    }
    const $ = sel => el.querySelector(sel);
    const ex = new Explorer({ el, $, base, ext });
    try {
        await ex.boot();
    } catch (err) {
        console.error(err);
        $('#report').innerHTML = `<div class="err">Failed to start: ${escapeHtml(err.message)}</div>`;
    }
    return ex;
}

class Explorer {
    constructor({ el, $, base, ext }) {
        Object.assign(this, { el, $, base, ext });
        this.state = {
            mode: null,         // 'state' | jurisdiction id | source id
            jur: null,
            themes: new Set(),
            feature: null,
            picked: [],         // the chosen areas of an area type with "multiple": true
            aoi: null,
            features: [],
            params: {},
            mapTheme: null,
            token: 0,
            view: 'profile',    // 'profile' | 'leaderboard' | a page or extension view id
        };
        this.lb = null;
        this.charts = { ...builtinCharts, ...ext.charts };
    }

    async boot() {
        const config = this.config = await loadConfig(this.base);
        const app = config.app;
        setFormatOptions(app.format || {});
        if (app.labels?.area) this.$('[data-label=area]').textContent = app.labels.area;
        if (app.labels?.sections) this.$('[data-label=sections]').textContent = app.labels.sections;

        const dataBase = app.data_base ? `${this.base}/${app.data_base}` : this.base;
        const [statewide, rt, refValues] = await Promise.all([
            app.statewide ? fetchJson(`${dataBase}/data/statewide.json`) : null,
            fetchJson(`${this.base}/config.json`),          // optional runtime override (k8s writes the MCP URL)
            app.reference?.values ? fetchJson(`${this.base}/${app.reference.values}`) : null,
        ]);
        this.runtime = rt || {};
        this.reference = app.reference ? { ...app.reference, values: refValues } : null;
        let client = null;
        if (app.engine === 'wasm') {
            const { WasmQueryClient } = await import('./wasm.js');
            client = new WasmQueryClient(app.wasm);
        }
        this.engine = new Engine(config, { mcpUrl: rt?.mcp_server_url || app.mcp_url, statewide, client, dataBase, tokens: this.ext.tokens });
        this.mapView = new MapView('map', app);
        this.mapView.onPick = id => this.pickById(id, { toggle: true });
        this.installCss();
        this.installOverlays();

        this.state.params = resolveParams(app);
        for (const t of config.themes) this.state.themes.add(t.id);
        this.state.mapTheme = config.themes.find(t => t.map)?.id ?? null;
        this.mountSources();
        this.renderModeButtons();
        this.renderParams();
        this.renderThemeButtons();
        this.renderViewTabs();
        this.wireSearch();
        this.wireResize();
        if (app.chat) this.mountChat();
        if (!(await this.restoreFromHash())) await this.landing();
        // a link pasted into an open tab (writeHash uses replaceState, which fires no event)
        window.addEventListener('hashchange', () => this.restoreFromHash());
    }

    /** The view with no link: the leaderboard when app.leaderboard.default, else app.default_area's profile, else the default mode's. */
    async landing() {
        const app = this.config.app;
        // app.default_area { jurisdiction, id }: open on that area's profile rather than an empty picker
        const def = app.default_area;
        const mode = def && app.jurisdictions.some(j => j.id === def.jurisdiction) ? def.jurisdiction : this.defaultMode();
        await this.setMode(mode);
        if (app.leaderboard?.default) await this.setView('leaderboard');
        else if (def && mode === def.jurisdiction) this.pickById(String(def.id));
    }

    defaultMode() {
        const app = this.config.app;
        if (app.default_mode) return app.default_mode;
        if (app.statewide && app.statewide.selectable !== false) return 'state';
        if (app.jurisdictions.length === 1 && !this.ext.sources.length) return app.jurisdictions[0].id;
        if (!app.jurisdictions.length && this.ext.sources.length === 1) return this.ext.sources[0].id;
        return null;
    }

    installCss() {
        const css = Object.values(this.charts).map(c => c.css || '').join('\n') + (this.config.app.leaderboard ? leaderboardCss : '');
        if (!css.trim()) return;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    }

    installOverlays() {
        const box = this.$('#overlay-legend');
        const parts = [];
        // app.json "overlays" take the same fields as extension overlays, except that
        // the popup is declared: popup_title (a property) and popup_fields ([property]
        // or [[property, label]]). "visible": false starts the layer switched off.
        const fromConfig = o => ({
            ...o,
            popup: o.popup_title || o.popup_fields ? p => [
                o.popup_title ? `<b>${escapeHtml(p[o.popup_title] ?? '')}</b>` : '',
                ...(o.popup_fields || []).map(f => {
                    const [k, label] = Array.isArray(f) ? f : [f, f];
                    return p[k] === undefined || p[k] === null || p[k] === '' ? '' : `${escapeHtml(label)}: ${escapeHtml(p[k])}`;
                }),
            ].filter(Boolean).join('<br>') : undefined,
        });
        for (const o of [...(this.config.app.overlays || []).map(fromConfig), ...this.ext.overlays]) {
            this.mapView.addOverlay(o).then(() => { if (o.visible === false) this.mapView.setOverlayVisible(o.id, false); });
            if (o.legend || o.toggle) {
                parts.push(`<div class="ov" data-ov="${escapeHtml(o.id)}">${o.legend || ''}${o.toggle ? `<label class="lg-toggle"><input type="checkbox"${o.visible === false ? '' : ' checked'}> ${escapeHtml(o.toggle)}</label>` : ''}</div>`);
            }
        }
        if (!parts.length) return;
        box.innerHTML = parts.join('');
        box.hidden = false;
        box.querySelectorAll('.ov').forEach(d => {
            const cb = d.querySelector('input');
            if (cb) cb.onchange = () => this.mapView.setOverlayVisible(d.dataset.ov, cb.checked);
        });
    }

    /* -------------------------------------------------------------- steps */

    modes() {
        const app = this.config.app;
        return [
            ...(app.statewide && app.statewide.selectable !== false ? [{ id: 'state', label: app.statewide.label, description: app.statewide.description || `All of ${app.statewide.label}` }] : []),
            ...app.jurisdictions,
            ...this.ext.sources.map(s => ({ id: s.id, label: s.label, description: s.description })),
        ];
    }

    renderModeButtons() {
        const wrap = this.$('#jur-buttons');
        const modes = this.modes();
        this.$('#step-jur').hidden = modes.length <= 1;
        wrap.innerHTML = '';
        for (const m of modes) {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', 'false');
            b.dataset.id = m.id;
            b.textContent = m.label;
            b.title = m.description || m.label;
            b.onclick = () => this.setMode(m.id);
            wrap.appendChild(b);
        }
        // number the steps that are shown
        if (modes.length <= 1) this.el.querySelectorAll('#step-place .step-num').forEach(n => { n.textContent = '1'; });
    }

    mountSources() {
        const wrap = this.$('#source-steps');
        for (const s of this.ext.sources) {
            const step = document.createElement('div');
            step.className = 'step';
            step.dataset.source = s.id;
            step.hidden = true;
            wrap.appendChild(step);
            s.mount(step, {
                mapView: this.mapView,
                engine: this.engine,
                setAoi: aoi => { aoi.params = this.state.params; this.setAoi(aoi); },
                select: () => { if (this.state.mode !== s.id) this.setMode(s.id, { restoring: true }); },
                showHint: t => this.showHint(t),
                hideHint: () => this.hideHint(),
                showMessage: html => { if (this.state.mode === s.id) this.$('#report').innerHTML = html; },
                writeHash: () => this.writeHash(),
                app: this.config.app,
            });
        }
    }

    renderParams() {
        const app = this.config.app;
        const step = this.$('#step-params');
        if (!app.params.length) return;
        step.hidden = false;
        // "control": "slider" draws the options as stops on a range input
        // (ordered options such as a resolution); the default is buttons.
        // a param with `when` sits in its own block, hidden at settings it does not apply to
        step.innerHTML = app.params.map(p => `<div class="param" data-pid="${escapeHtml(p.id)}">
            <div class="step-label">${escapeHtml(p.label || p.id)}</div>
            ${p.control === 'number' ? `
            <div class="param-number" data-param="${escapeHtml(p.id)}">
                <input type="number" inputmode="decimal" step="any" aria-label="${escapeHtml(p.label || p.id)}">
                <div class="step-help param-range"></div>
            </div>` : p.control === 'slider' ? `
            <div class="param-slider" data-param="${escapeHtml(p.id)}" style="--n:${p.options.length}">
                <input type="range" min="0" max="${p.options.length - 1}" step="1" value="0" aria-label="${escapeHtml(p.label || p.id)}">
                <div class="param-stops">${p.options.map((o, i) => `<button type="button" data-i="${i}" data-value="${escapeHtml(optionValue(o))}" aria-pressed="false">${escapeHtml(optionLabel(p, o))}</button>`).join('')}</div>
            </div>` : p.multiple ? `
            <div class="chips param-multi" role="group" data-param="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.label || p.id)}">
                ${p.options.map(o => `<button type="button" data-value="${escapeHtml(optionValue(o))}" aria-pressed="false">${escapeHtml(optionLabel(p, o))}</button>`).join('')}
            </div>` : `
            <div class="seg" role="radiogroup" data-param="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.label || p.id)}">
                ${p.options.map(o => `<button type="button" role="radio" data-value="${escapeHtml(optionValue(o))}" aria-checked="false">${escapeHtml(optionLabel(p, o))}</button>`).join('')}
            </div>`}
            ${p.relative ? `<div class="step-help param-base" data-base="${escapeHtml(p.id)}" hidden></div>` : ''}
            ${p.help ? `<div class="step-help">${escapeHtml(p.help)}</div>` : ''}</div>`).join('');
        step.querySelectorAll('.seg[data-param] button').forEach(b => {
            b.onclick = () => this.setParam(b.parentElement.dataset.param, b.dataset.value);
        });
        step.querySelectorAll('.param-multi button').forEach(b => {
            const p = app.params.find(x => x.id === b.parentElement.dataset.param);
            b.onclick = () => this.setParam(p.id, toggleMulti(p, this.state.params[p.id], b.dataset.value));
        });
        step.querySelectorAll('.param-slider').forEach(g => {
            const p = app.params.find(x => x.id === g.dataset.param);
            const input = g.querySelector('input');
            const at = i => optionValue(p.options[Number(i)]);
            // 'input' only moves the highlighted stop; the param changes on release
            input.oninput = () => this.markSlider(g, String(at(input.value)));
            input.onchange = () => this.setParam(p.id, at(input.value));
            g.querySelectorAll('.param-stops button').forEach(b => {
                b.onclick = () => this.setParam(p.id, b.dataset.value);
            });
        });
        step.querySelectorAll('.param-number').forEach(g => {
            const p = app.params.find(x => x.id === g.dataset.param);
            const input = g.querySelector('input');
            input.onchange = () => {
                const typed = Number(input.value);
                if (input.value.trim() === '' || !Number.isFinite(typed)) { this.markParams(); return; }
                const v = nearestOption(p, typed - numberBase(g));
                if (String(v) === String(this.state.params[p.id])) this.markParams();
                else this.setParam(p.id, v);
            };
            input.onkeydown = e => { if (e.key === 'Enter') input.onchange(); };
        });
        this.markParams();
        this.relabelRelative();
    }

    /**
     * Relative slider params: label each stop as base + offset, the base read from the chosen
     * area (param.relative.query in param.relative.theme, first row, .field). With no area, or
     * before the base is known, stops show the signed offset.
     */
    async relabelRelative() {
        const app = this.config.app, s = this.state, token = s.token;
        for (const p of app.params.filter(x => x.relative && (x.control === 'slider' || x.control === 'number'))) {
            const g = this.$(`#step-params [data-param="${p.id}"]`);
            const note = this.$(`#step-params [data-base="${p.id}"]`);
            if (!g) continue;
            const r = p.relative;
            let base = null;
            if (s.aoi) {
                const theme = this.config.themeById?.[r.theme] || this.config.themes.find(t => t.id === r.theme) || this.config.overview;
                try {
                    const rows = await this.engine.run(theme, r.query, s.aoi);
                    base = Number(rows?.[0]?.[r.field]);
                } catch (err) { console.error(err); }
                if (token !== s.token) return;      // the area or a setting changed meanwhile
            }
            const known = Number.isFinite(base);
            if (p.control === 'number') {
                g.dataset.base = known ? String(base) : '';
                this.markNumber(g, p);
            }
            g.querySelectorAll('.param-stops button').forEach(b => {
                const d = Number(b.dataset.value);
                b.textContent = known ? fmt(base + d, r.format || 'num1') : optionLabel({ relative: {} }, b.dataset.value);
            });
            if (note) {
                note.hidden = !(known && r.note);
                if (known && r.note) note.textContent = r.note.replace('{}', fmt(base, r.format || 'num1'));
            }
        }
    }

    markParams() {
        const app = this.config.app;
        this.$('#step-params').querySelectorAll('.param[data-pid]').forEach(el => {
            el.hidden = !paramActive(app.params.find(p => p.id === el.dataset.pid), app, this.state.params);
        });
        this.$('#step-params').querySelectorAll('[data-param]').forEach(g => {
            const v = String(this.state.params[g.dataset.param]);
            if (g.classList.contains('param-multi')) {
                const on = paramValues(null, this.state.params[g.dataset.param]).map(String);
                g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(on.includes(b.dataset.value))));
            } else if (g.classList.contains('param-slider')) this.markSlider(g, v, true);
            else if (g.classList.contains('param-number')) this.markNumber(g, this.config.app.params.find(x => x.id === g.dataset.param));
            else g.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === v)));
        });
    }

    /**
     * A "control": "number" param: the box shows the value, or base + offset for a relative
     * param whose base is known, and the line under it gives the range a typed value is held to.
     */
    markNumber(g, p) {
        const base = numberBase(g);
        const vals = p.options.map(o => Number(optionValue(o)));
        const shown = v => +(base + v).toFixed(6);
        const input = g.querySelector('input');
        input.value = String(shown(Number(this.state.params[p.id])));
        input.min = String(shown(Math.min(...vals)));
        input.max = String(shown(Math.max(...vals)));
        // the ends as the box holds them, so the range matches what a typed value snaps to
        const f = p.relative ? '{}' : (p.format || '{}');
        const end = v => f.replace('{}', String(shown(v)));
        g.querySelector('.param-range').textContent = p.relative && !g.dataset.base
            ? 'Choose an area to enter a value.'
            : `Enter a value from ${end(Math.min(...vals))} to ${end(Math.max(...vals))}.`;
        input.disabled = !!p.relative && !g.dataset.base;
    }

    markSlider(g, v, setInput = false) {
        g.querySelectorAll('.param-stops button').forEach(b => {
            const on = b.dataset.value === v;
            b.setAttribute('aria-pressed', String(on));
            if (on && setInput) g.querySelector('input').value = b.dataset.i;
        });
    }

    async setParam(id, value) {
        const s = this.state;
        s.params = resolveParams(this.config.app, { ...s.params, [id]: value });
        this.markParams();
        this.mapView.setBoundaryTokens(paramTokens(this.config.app, s.params));
        if (s.jur?.list_params) {
            // the pick list depends on the param: areas can appear or drop out
            try {
                s.features = (await this.engine.listFeatures(s.jur, s.params)).slice().sort((a, b) => naturalCompare(a.name, b.name));
                this.$('#place-input').placeholder = `Search ${s.features.length} ${s.jur.label.toLowerCase()}…`;
                this.renderTags();
            } catch (err) { console.error(err); }
        }
        if (s.view === 'leaderboard' && this.lb) this.lb.load(s.params, this.paramNote());
        const a = this.state.aoi;
        if (!a) { this.writeHash(); return; }
        if (a.kind === 'state') this.setAoi(statewideAoi(this.config.app, this.state.params));
        else if (this.state.jur && this.chosen().length) this.setAoi(this.areaAoi());
        else this.setAoi({ ...a, key: `${a.key.split('@')[0]}@${paramKey(this.config.app, this.state.params)}`, params: this.state.params });
    }

    renderThemeButtons() {
        const wrap = this.$('#theme-buttons');
        wrap.innerHTML = '';
        this.$('#step-themes').hidden = this.config.themes.length <= 1;
        for (const t of this.config.themes) {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.id = t.id;
            b.style.setProperty('--c', t.color);
            b.setAttribute('aria-pressed', String(this.state.themes.has(t.id)));
            b.innerHTML = `<span class="dot"></span>${escapeHtml(t.label)}`;
            b.title = t.blurb || t.label;
            b.onclick = () => this.toggleTheme(t.id);
            wrap.appendChild(b);
        }
    }

    markMode(id) {
        this.el.querySelectorAll('#jur-buttons button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.id === id)));
        const jur = this.config.app.jurisdictions.find(j => j.id === id);
        this.$('#step-place').hidden = !jur;
        const byMap = jur?.picker === 'map';
        this.$('#step-place .search').hidden = byMap;
        this.renderTags();
        let hint = this.$('#step-place .pick-hint');
        if (byMap && !hint) {
            hint = document.createElement('div');
            hint.className = 'pick-hint';
            this.$('#step-place .search').after(hint);
        }
        if (hint) { hint.hidden = !byMap; this.syncPickHint(); }
        if (this.state.view === 'leaderboard') this.$('#step-place').hidden = true;
        this.el.querySelectorAll('#source-steps [data-source]').forEach(s => { s.hidden = s.dataset.source !== id; });
    }

    async setMode(id, { keepFeature = false, restoring = false } = {}) {
        const s = this.state;
        const prevSource = this.ext.sources.find(x => x.id === s.mode);
        if (prevSource && prevSource.id !== id) prevSource.deactivate();
        if (id === null) { this.markMode(null); this.renderIntro(); return; }
        if (id === 'state') {
            s.mode = 'state'; s.jur = null; s.feature = null; s.picked = [];
            this.markMode('state');
            this.hideHint();
            this.mapView.clearJurisdiction();
            this.mapView.fit(this.config.app.view);
            this.setAoi(statewideAoi(this.config.app, s.params));
            return;
        }
        const source = this.ext.sources.find(x => x.id === id);
        if (source) {
            s.mode = id; s.jur = null; s.feature = null; s.picked = [];
            this.markMode(id);
            this.mapView.clearJurisdiction();
            source.activate({ restoring: restoring || keepFeature });
            if (!restoring) { s.aoi = null; s.token++; this.renderIntro(); }
            this.writeHash();
            return;
        }
        const jur = this.config.app.jurisdictions.find(j => j.id === id);
        if (!jur) return;
        s.mode = id;
        s.jur = jur;
        this.markMode(id);
        this.$('#place-label').textContent = jur.singular || jur.label;
        const input = this.$('#place-input');
        input.disabled = false;
        input.value = '';
        input.placeholder = `Loading ${jur.label.toLowerCase()}…`;
        if (!keepFeature) {
            s.feature = null;
            s.picked = [];
            this.renderTags();
            this.setAoi(null);
        }
        await this.mapView.showJurisdiction(jur, paramTokens(this.config.app, s.params));
        const sing = (jur.singular || jur.label).toLowerCase();
        if (this.state.view === 'leaderboard') this.hideHint();
        else this.showHint(this.config.app.labels?.place_hint || `Click ${/^[aeiou]/i.test(sing) ? 'an' : 'a'} ${sing} on the map, or search by name`);
        try {
            s.features = (await this.engine.listFeatures(jur, s.params)).slice();
            s.features.sort((a, b) => naturalCompare(a.name, b.name));
            input.placeholder = `Search ${s.features.length} ${jur.label.toLowerCase()}…`;
            this.renderTags();
        } catch (err) {
            input.placeholder = 'Could not load list — click the map instead';
            console.error(err);
        }
        this.writeHash();
    }

    toggleTheme(id) {
        const s = this.state;
        if (s.themes.has(id)) s.themes.delete(id); else s.themes.add(id);
        this.el.querySelectorAll('#theme-buttons button').forEach(b => b.setAttribute('aria-pressed', String(s.themes.has(b.dataset.id))));
        if (s.mapTheme && !s.themes.has(s.mapTheme)) s.mapTheme = null;
        if (!s.mapTheme) s.mapTheme = this.orderedThemes().find(t => t.map)?.id ?? null;
        this.writeHash();
        if (s.aoi) this.renderReport();
    }

    orderedThemes() {
        return this.config.themes.filter(t => this.state.themes.has(t.id));
    }

    /* ------------------------------------------------------------- search */

    wireSearch() {
        const input = this.$('#place-input');
        const list = this.$('#place-results');
        let matches = [];
        let active = -1;
        // true while the box still shows the chosen area's name: list every area, not just that one
        let browsing = false;
        const close = () => { list.hidden = true; active = -1; };
        const render = () => {
            const q = browsing ? '' : input.value.trim().toLowerCase();
            // several areas at once: the list offers the ones not yet chosen
            const taken = this.state.jur?.multiple ? new Set(this.state.picked.map(f => String(f.id))) : null;
            const pool = taken?.size ? this.state.features.filter(f => !taken.has(String(f.id))) : this.state.features;
            matches = (q ? pool.filter(f => String(f.name).toLowerCase().includes(q)) : pool).slice(0, 200);
            list.innerHTML = matches.map((f, i) =>
                `<li role="option" data-i="${i}" aria-selected="${i === active}">${escapeHtml(f.name)}${f.detail ? `<small>${escapeHtml(f.detail)}</small>` : ''}</li>`).join('');
            list.hidden = !matches.length;
            list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        };
        input.addEventListener('input', () => { browsing = false; active = -1; render(); });
        input.addEventListener('focus', () => {
            const f = this.state.feature;
            browsing = !!f && input.value === f.name;
            active = browsing ? this.state.features.slice(0, 200).findIndex(x => x === f || String(x.id) === String(f.id)) : -1;
            render();
            if (browsing) input.select();     // typing replaces the name and filters as usual
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { active = Math.min(matches.length - 1, active + 1); render(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
            else if (e.key === 'Enter') {
                const f = matches[active >= 0 ? active : 0];
                if (f) { this.pick(f); close(); input.blur(); }
            } else if (e.key === 'Escape') close();
        });
        list.addEventListener('mousedown', e => {
            const li = e.target.closest('li');
            if (!li) return;
            this.pick(matches[Number(li.dataset.i)]);
            close();
        });
        input.addEventListener('blur', () => setTimeout(close, 150));
    }

    /** The pick-list feature with this id (matched by value: a numeric id in the tiles, 20001.0, finds "20001"), or a stand-in. */
    featureById(id) {
        const s = this.state;
        const f = s.features.find(x => String(x.id) === String(id) || (Number.isFinite(Number(id)) && Number(x.id) === Number(id)));
        return f || { id, name: `${s.jur.singular || s.jur.label} ${id}` };
    }

    /** toggle (a map click): on an area type with "multiple", a chosen area is removed rather than chosen again. */
    pickById(id, { toggle = false } = {}) {
        const s = this.state;
        if (!s.jur) return;
        const f = this.featureById(id);
        if (toggle && s.jur.multiple && s.view === 'profile' && s.picked.some(x => sameId(x.id, f.id))) { this.unpick(f.id); return; }
        this.pick(f);
    }

    /**
     * The areas a link names (an area type with "multiple"): they replace the
     * chosen ones, so a link to one area chooses that area alone.
     */
    pickMany(ids) {
        const s = this.state;
        if (!s.jur) return;
        if (!s.jur.multiple) { if (ids.length) this.pickById(ids[0]); return; }
        s.picked = [];
        for (const id of ids) { const f = this.featureById(id); if (!s.picked.some(x => sameId(x.id, f.id))) s.picked.push(f); }
        this.applyPicked();
    }

    /**
     * Choose an area. On an area type with "multiple" it is added to those
     * already chosen, unless `replace` (a leaderboard row, the assistant).
     */
    pick(feature, { replace = false } = {}) {
        const s = this.state;
        if (!feature || !s.jur) return;
        if (s.view === 'leaderboard' && this.lb) {
            // a map click on the leaderboard finds the row; the profile opens from the row
            this.lb.focus(feature.id);
            this.mapView.select(feature.id);
            return;
        }
        if (this.customView()) this.setView('profile');
        if (s.jur.multiple) {
            if (replace) s.picked = [feature];
            else if (!s.picked.some(x => sameId(x.id, feature.id))) s.picked = [...s.picked, feature];
            this.applyPicked({ fitTo: feature });
            return;
        }
        s.feature = feature;
        this.$('#place-input').value = feature.name;
        this.syncPickHint();
        this.hideHint();
        const bbox = ['xmin', 'ymin', 'xmax', 'ymax'].map(k => Number(feature[k]));
        this.mapView.select(feature.id, bbox);
        this.setAoi(jurisdictionAoi(s.jur, feature, this.config.app, s.params));
    }

    /** Remove one of several chosen areas (its tag's ×, or a map click on it). */
    unpick(id) {
        const s = this.state;
        s.picked = s.picked.filter(x => !sameId(x.id, id));
        this.applyPicked();
    }

    /** The chosen areas: s.picked on an area type with "multiple", else the one feature. */
    chosen() {
        const s = this.state;
        return s.jur?.multiple ? s.picked : s.feature ? [s.feature] : [];
    }

    /** The AOI of the chosen area or areas. */
    areaAoi() {
        const s = this.state;
        return jurisdictionAoi(s.jur, s.jur.multiple ? s.picked : s.feature, this.config.app, s.params);
    }

    /** After the chosen areas of a "multiple" area type change: tags, outline, view and profile. */
    applyPicked({ fitTo = null } = {}) {
        const s = this.state;
        s.feature = s.picked.length === 1 ? s.picked[0] : null;
        this.$('#place-input').value = '';
        this.renderTags();
        this.syncPickHint();
        if (!s.picked.length) {
            this.mapView.clearSelection();
            this.setAoi(null);
            return;
        }
        this.hideHint();
        const boxes = (fitTo ? [fitTo] : s.picked).map(f => ['xmin', 'ymin', 'xmax', 'ymax'].map(k => Number(f[k])));
        this.mapView.select(s.picked.map(f => f.id), unionBbox(boxes));
        this.setAoi(this.areaAoi());
    }

    /** Removable tags for the chosen areas of an area type with "multiple". */
    renderTags() {
        const box = this.$('#area-tags');
        const s = this.state;
        const multi = !!s.jur?.multiple && s.mode === s.jur.id && s.view !== 'leaderboard';
        box.hidden = !multi || !s.picked.length;
        const input = this.$('#place-input');
        if (multi && s.features.length) {
            input.placeholder = s.picked.length ? `Add another ${(s.jur.singular || s.jur.label).toLowerCase()}…` : `Search ${s.features.length} ${s.jur.label.toLowerCase()}…`;
        }
        if (!multi) { box.innerHTML = ''; return; }
        box.innerHTML = s.picked.map(f => `<span class="area-tag" role="listitem">${escapeHtml(f.name)}<button type="button" data-id="${escapeHtml(f.id)}" aria-label="Remove ${escapeHtml(f.name)}" title="Remove">×</button></span>`).join('');
        box.querySelectorAll('button').forEach(b => { b.onclick = () => this.unpick(b.dataset.id); });
    }

    /* ------------------------------------------------------------- report */

    setAoi(aoi) {
        this.state.aoi = aoi;
        this.state.token++;
        this.writeHash();
        if (this.state.view !== 'profile') return;
        if (aoi) this.renderReport();
        else this.renderIntro();
        this.relabelRelative();
    }

    syncPickHint() {
        const h = this.$('#step-place .pick-hint');
        if (!h) return;
        const f = this.state.feature;
        const text = this.config.app.labels?.place_hint || 'Click the map to choose an area';
        // several areas: the tags name them; the hint says how to add or remove one
        if (this.state.jur?.multiple) { h.textContent = this.state.picked.length ? `${text} to add another, or click a chosen one to remove it` : text; return; }
        h.innerHTML = f ? `<b>${escapeHtml(f.name)}</b> · ${escapeHtml(text)} to choose another` : escapeHtml(text);
    }

    /* ---------------------------------------------------------- leaderboard */

    /** The tabs: the profile, the leaderboard, app pages and extension views. */
    views() {
        const app = this.config.app, lb = app.leaderboard;
        return [
            { id: 'profile', label: app.labels?.profile_tab || lb?.profile_tab || 'Profile' },
            ...(lb ? [{ id: 'leaderboard', label: lb.tab || 'Leaderboard' }] : []),
            ...(app.pages || []).map(p => ({ ...p, page: true })),
            ...this.ext.views,
        ];
    }

    /** The current view when it is a page or an extension view, else null. */
    customView() {
        const v = this.state.view;
        return v === 'profile' || v === 'leaderboard' ? null : this.views().find(x => x.id === v) || null;
    }

    renderViewTabs() {
        const views = this.views();
        if (views.length <= 1) return;
        const nav = document.createElement('nav');
        nav.className = 'view-tabs';
        nav.setAttribute('role', 'tablist');
        nav.innerHTML = views.map(v => `<button type="button" role="tab" data-view="${escapeHtml(v.id)}">${escapeHtml(v.label)}</button>`).join('');
        nav.querySelectorAll('button').forEach(b => { b.onclick = () => this.setView(b.dataset.view); });
        this.$('#controls').before(nav);
        this.markView();
    }

    markView() {
        const v = this.state.view;
        this.el.querySelectorAll('.view-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
        const custom = this.customView();
        this.$('#controls').hidden = !!custom;
        const full = !!custom?.full;
        if (this.el.classList.contains('glen-full') !== full) {
            this.el.classList.toggle('glen-full', full);
            requestAnimationFrame(() => this.mapView.map.resize());
        }
        if (custom) return;
        const lb = v === 'leaderboard';
        for (const sel of ['#step-jur', '#step-themes', '#source-steps']) {
            const n = this.$(sel);
            if (lb) { n.dataset.lbHidden = n.hidden ? '1' : ''; n.hidden = true; }
            else if (n.dataset.lbHidden !== undefined) { n.hidden = n.dataset.lbHidden === '1'; delete n.dataset.lbHidden; }
        }
        if (lb) this.$('#step-place').hidden = true;
        else this.markMode(this.state.mode);
        if (!lb) {
            // the mode step hides itself when there is a single mode
            this.$('#step-jur').hidden = this.modes().length <= 1;
            this.$('#step-themes').hidden = this.config.themes.length <= 1;
        }
    }

    /** Render a page (an HTML file, plus dataset citations with sources: true) or an extension view into the report panel. */
    async renderCustomView(v) {
        const r = this.$('#report');
        this.hideHint();
        if (!v.page) {
            r.innerHTML = '';
            await v.render(r, { engine: this.engine, app: this.config.app, explorer: this });
            return;
        }
        this.pageHtml ??= {};
        if (!(v.id in this.pageHtml)) {
            const [html, sources] = await Promise.all([
                fetch(`${this.base}/${v.file}`, { cache: 'no-cache' }).then(x => (x.ok ? x.text() : `<p class="err">Could not load ${escapeHtml(v.file)}</p>`)),
                v.sources ? fetchJson(`${this.engine.dataBase}/data/sources.json`) : null,
            ]);
            this.pageHtml[v.id] = `<div class="page">${html}${sources ? sourcesHtml(sources) : ''}</div>`;
        }
        if (this.state.view === v.id) r.innerHTML = this.pageHtml[v.id];
    }

    leaderboardJur() {
        const spec = this.config.app.leaderboard;
        return this.config.app.jurisdictions.find(j => j.id === spec.jurisdiction) || this.config.app.jurisdictions[0];
    }

    async setView(view, { lbState = null } = {}) {
        const spec = this.config.app.leaderboard;
        if (!this.views().some(v => v.id === view)) view = 'profile';
        const s = this.state;
        s.view = view;
        this.markView();
        const custom = this.customView();
        if (custom) {
            this.$('#map-chips').hidden = true;
            await this.renderCustomView(custom);
        } else if (view === 'leaderboard') {
            const jur = this.leaderboardJur();
            if (s.mode !== jur.id) await this.setMode(jur.id, { keepFeature: true });
            this.hideHint();
            this.mapView.clearChoropleth();
            this.$('#map-chips').hidden = true;
            if (!this.lb) {
                this.lb = new Leaderboard(this.$('#report'), {
                    engine: this.engine, spec, jur,
                    onShow: f => {
                        const bbox = ['xmin', 'ymin', 'xmax', 'ymax'].map(k => Number(f[k]));
                        this.mapView.select(f.id, bbox);
                    },
                    onOpen: f => { this.setView('profile').then(() => this.pick(f, { replace: true })); },
                    onHover: id => this.mapView.highlight(id),
                    onScores: res => this.colorByScore(res),
                    onChange: () => this.writeHash(),
                });
                this.mapView.popupExtra = id => (this.state.view === 'leaderboard' ? this.lb.popupFor(id) : '');
            }
            if (lbState === null && this.pendingScore != null) { lbState = this.pendingScore; this.pendingScore = null; }
            if (lbState !== null) this.lb.setStateString(lbState);
            this.lb.el = this.$('#report');
            this.mapView.clearSelection();
            await this.lb.load(s.params, this.paramNote());
        } else {
            this.mapView.setJurisdictionColors(null);
            this.$('#map-legend').hidden = true;
            const ids = this.chosen().map(f => f.id);
            if (ids.length) this.mapView.select(s.jur?.multiple ? ids : ids[0]); else this.mapView.clearSelection();
            this.renderTags();
            if (s.aoi) this.renderReport(); else this.renderIntro();
        }
        this.writeHash();
    }

    paramNote() {
        const app = this.config.app;
        return app.params.filter(p => paramActive(p, app, this.state.params)).map(p => {
            const v = this.state.params[p.id];
            if (p.multiple) return `${p.label || p.id}: ${paramValueLabel(p, v)}`;
            const o = p.options.find(x => String(optionValue(x)) === String(v));
            return o === undefined ? '' : `${p.label || p.id}: ${optionLabel(p, o)}`;
        }).filter(Boolean).join(' · ');
    }

    colorByScore(res) {
        const spec = this.config.app.leaderboard;
        const legend = this.$('#map-legend');
        if (!spec.map || this.state.view !== 'leaderboard') return;
        const ramp = spec.map.ramp || ['#f7fcb9', '#c2e699', '#78c679', '#31a354', '#006837'];
        const vals = res.rows.filter(r => r.inView && r.overall !== null);
        const breaks = quantileBreaks(vals.map(r => r.overall), ramp.length);
        const colorOf = v => ramp[Math.min(ramp.length - 1, breaks.filter(b => v >= b).length)];
        this.mapView.setJurisdictionColors(new Map(vals.map(r => [r.id, colorOf(r.overall)])));
        renderLegend(legend, { label: spec.map.label || 'Overall score', format: 'num1', note: spec.map.note || 'Quantile classes among the areas in view' }, { breaks, ramp });
    }

    kindLabel() {
        const s = this.state;
        if (s.mode === 'state') return this.config.app.statewide.kind_label || 'Whole region';
        if (s.jur) return s.jur.multiple && s.picked.length > 1 ? s.jur.label : s.jur.singular || s.jur.label;
        return s.aoi?.kindLabel || this.ext.sources.find(x => x.id === s.mode)?.kindLabel || 'Area';
    }

    renderIntro() {
        const app = this.config.app;
        const r = this.$('#report');
        const what = (this.state.jur?.singular || 'place').toLowerCase();
        r.innerHTML = app.intro
            ? `<div class="intro">${app.intro}</div>`
            : this.state.jur?.multiple
                ? `<div class="intro"><p>Choose one or more ${escapeHtml(this.state.jur.label.toLowerCase())} by name or on the map.</p></div>`
                : `<div class="intro"><p>Choose a ${escapeHtml(what)} by name or on the map.</p></div>`;
        this.syncMapChips();
    }

    renderReport() {
        const s = this.state;
        const token = s.token;
        const aoi = s.aoi;
        const app = this.config.app;
        const r = this.$('#report');
        const isRegion = aoi.kind === 'state';
        const paramNote = this.paramNote();
        r.innerHTML = `
            <div class="report-head">
                <div>
                    <div class="kind">${escapeHtml(this.kindLabel())}${paramNote ? ` · ${escapeHtml(paramNote)}` : ''}</div>
                    <h2>${escapeHtml(aoi.label)}</h2>
                </div>
                <div class="head-actions">
                    <button class="ghost-btn" id="export-btn" type="button" title="Download this view as a report: numbers, charts, code (SQL / R / Python) and data citations">Export</button>
                    <button class="ghost-btn" id="copy-link" type="button" title="Copy a link to this view">Copy link</button>
                </div>
            </div>
            ${this.ext.reportHead ? this.ext.reportHead(aoi, { engine: this.engine, reference: this.reference, isRegion }) || '' : ''}
            ${this.activeSource()?.reportHead?.(aoi) || ''}`;
        this.$('#copy-link').onclick = async () => {
            try { await navigator.clipboard.writeText(location.href); this.$('#copy-link').textContent = 'Copied'; } catch { /* ignore */ }
        };
        const themes = [this.config.overview, ...this.orderedThemes()].filter(Boolean);
        wireExportButton(this.$('#export-btn'), () => ({
            engine: this.engine, aoi, mapView: this.mapView, kind: this.kindLabel(), subtitle: paramNote,
            themes, reportEl: r, legendEl: this.el.querySelector('.map-legends'), siteTitle: app.title || document.title,
            base: this.engine.dataBase, projectUrl: app.project_url, compareLabel: app.statewide?.label,
            reference: this.reference?.citation ? this.reference : null,
            extraCss: Object.values(this.charts).map(c => c.css || '').join('\n') + (app.export_css || ''),
            storageKey: `${app.id || 'glen'}-export-code-lang`,
        }));

        const opts = {
            isCurrent: () => token === this.state.token,
            charts: this.charts,
            compareLabel: app.statewide?.label,
            reference: this.reference,
            shortName: this.ext.shortName || (x => x),
            params: s.params,
            onMapToggle: id => this.setMapTheme(this.state.mapTheme === id ? null : id),
        };
        if (this.config.overview) r.appendChild(renderThemeCard(this.engine, this.config.overview, aoi, { ...opts, overview: true }));
        if (!s.themes.size && this.config.themes.length > 1) {
            const n = document.createElement('div');
            n.className = 'card';
            n.innerHTML = '<p class="card-blurb" style="margin:0">Select one or more sections above to add panels.</p>';
            r.appendChild(n);
        }
        for (const t of this.orderedThemes()) r.appendChild(renderThemeCard(this.engine, t, aoi, opts));
        this.chat?.renderPinned(r, aoi, opts.isCurrent);
        if (!isRegion && app.live_note && aoi.id) {
            this.engine.areaFile(aoi).then(pre => {
                if (pre || token !== this.state.token) return;
                const n = document.createElement('p');
                n.className = 'tile-note live-note';
                n.textContent = app.live_note;
                r.querySelector('.report-head')?.after(n);
            });
        }
        this.syncMapChips();
        this.refreshChoropleth();
    }

    /* ----------------------------------------------------------------- map */

    syncMapChips() {
        const wrap = this.$('#map-chips');
        const themes = this.orderedThemes().filter(t => t.map);
        if (!this.state.aoi || !themes.length) { wrap.hidden = true; return; }
        wrap.hidden = false;
        wrap.innerHTML = `<span class="lbl">${escapeHtml(this.config.app.labels?.map_chips || 'Color tracts by')}</span>` + themes.map(t =>
            `<button class="map-btn" type="button" data-theme="${t.id}" style="--c:${t.color}" aria-pressed="${this.state.mapTheme === t.id}">${escapeHtml(t.label)}</button>`).join('');
        wrap.querySelectorAll('button').forEach(b => { b.onclick = () => this.setMapTheme(this.state.mapTheme === b.dataset.theme ? null : b.dataset.theme); });
        this.el.querySelectorAll('#report .map-btn').forEach(b => {
            b.setAttribute('aria-pressed', String(this.state.mapTheme === b.dataset.theme));
            b.textContent = this.state.mapTheme === b.dataset.theme ? 'On map' : 'Show on map';
        });
    }

    setMapTheme(id) {
        this.state.mapTheme = id;
        this.writeHash();
        this.syncMapChips();
        this.refreshChoropleth();
    }

    async refreshChoropleth() {
        const legend = this.$('#map-legend');
        const s = this.state;
        const theme = s.mapTheme && this.config.themes.find(t => t.id === s.mapTheme);
        if (!s.aoi || !theme || !theme.map || !s.themes.has(theme.id)) {
            this.mapView.clearChoropleth();
            this.mapView.clearHexChoropleth();
            legend.hidden = true;
            return;
        }
        const token = s.token;
        const want = theme.id;
        legend.hidden = false;
        legend.innerHTML = `<div class="title">${escapeHtml(theme.map.label)}</div><div class="tile-note">Loading…</div>`;
        try {
            // "type": "hex" draws H3 cells from the query's id strings; otherwise tracts,
            // one query per grid when app.tracts lists several (theme.map.levels), else theme.map.query
            const hex = theme.map.type === 'hex';
            const plan = hex ? [{ query: theme.map.query }] : mapQueries(this.config.app, theme.map);
            const results = await Promise.all(plan.map(p => this.engine.run(theme, p.query, s.aoi)));
            if (token !== s.token || s.mapTheme !== want) return;
            const rows = plan.length > 1 ? Object.fromEntries(plan.map((p, i) => [p.level, results[i]])) : results[0];
            if (hex) this.mapView.clearChoropleth(); else this.mapView.clearHexChoropleth();
            const info = hex ? await this.mapView.setHexChoropleth(theme.map, rows) : await this.mapView.setChoropleth(theme.map, rows);
            renderLegend(legend, theme.map, info);
        } catch (err) {
            if (token !== s.token) return;
            legend.innerHTML = `<div class="err">Map query failed: ${escapeHtml(shortErr(err))}</div>`;
            console.error(err, err.sql);
        }
    }

    /** The area source in use, if the current mode is one. */
    activeSource() { return this.ext.sources.find(x => x.id === this.state.mode) || null; }

    /** The source that is the app's only area mode, or null. */
    soleSource() {
        const modes = this.modes();
        return modes.length === 1 ? this.ext.sources.find(x => x.id === modes[0].id) || null : null;
    }

    /**
     * The optional assistant (app.chat). core/chat.js and the agent it uses
     * load only here, so an app without a chat block loads no LLM code.
     */
    async mountChat() {
        try {
            const { mountChat } = await import('./chat.js');
            this.chat = await mountChat(this);
            if (this.state.aoi && this.state.view === 'profile') this.chat.renderPinned(this.$('#report'), this.state.aoi, () => true);
        } catch (err) {
            console.error('Chat failed to load', err);
        }
    }

    showHint(text) { const h = this.$('#map-hint'); h.textContent = text; h.hidden = false; }
    hideHint() { this.$('#map-hint').hidden = true; }

    /* ---------------------------------------------------------------- hash */

    writeHash() {
        const s = this.state;
        const app = this.config.app;
        const parts = [];
        const source = this.activeSource();
        // an app's only area mode, when it is a source, is left out of the link
        if (s.mode && s.mode !== 'state' && !(source && source === this.soleSource())) parts.push(s.mode);
        // several areas: their ids, comma-separated (#county/06001,06013)
        if (s.jur && this.chosen().length) parts.push(this.chosen().map(f => encodeURIComponent(f.id)).join(','));
        const q = new URLSearchParams();
        const sh = source?.hashState?.();
        if (sh?.path) parts.push(sh.path);
        for (const [k, v] of Object.entries(sh?.query || {})) q.set(k, v);
        if (s.themes.size !== this.config.themes.length) q.set('themes', this.orderedThemes().map(t => t.id).join(','));
        if (s.mapTheme && this.config.themes.some(t => t.map)) q.set('map', s.mapTheme);
        // a "multiple" param's list is comma-separated (?ptype=Acquisition,Restoration)
        for (const p of app.params) if (String(s.params[p.id]) !== String(paramDefault(p))) q.set(p.id, paramValues(p, s.params[p.id]).join(','));
        if (s.view !== 'profile') q.set('view', s.view);
        const lbs = this.lb?.stateString();
        if (lbs) q.set('score', lbs);
        const hash = '#' + parts.join('/') + (q.toString() ? '?' + q.toString().replace(/%2C/g, ',').replace(/%3B/g, ';').replace(/%3D/g, '=') : '');
        history.replaceState(null, '', hash === '#' ? location.pathname + location.search : hash);
    }

    async restoreFromHash() {
        const h = location.hash.slice(1);
        if (!h) return false;
        const s = this.state;
        const [path, query] = h.split('?');
        const q = new URLSearchParams(query || '');
        if (q.has('themes')) {
            s.themes.clear();
            for (const id of q.get('themes').split(',').filter(Boolean)) {
                if (this.config.themes.some(t => t.id === id)) s.themes.add(id);
            }
            this.el.querySelectorAll('#theme-buttons button').forEach(b => b.setAttribute('aria-pressed', String(s.themes.has(b.dataset.id))));
        }
        const map = q.get('map');
        if (map && s.themes.has(map)) s.mapTheme = map;
        const given = {};
        for (const p of this.config.app.params) if (q.has(p.id)) given[p.id] = q.get(p.id);
        s.params = resolveParams(this.config.app, given);
        this.markParams();
        const [modeId, featId] = path.split('/');
        let source = this.ext.sources.find(x => x.id === modeId);
        // a source that keeps state in the link: the rest of the path and the query are its own
        let sourcePath = path.split('/').slice(1).join('/');
        const sole = this.soleSource();
        if (!source && sole?.restore) { source = sole; sourcePath = path; }
        if (source?.restore) {
            await this.setMode(source.id, { restoring: true });
            if (!s.aoi) this.renderIntro();
            await source.restore(sourcePath, q);
            return true;
        }
        if (!modeId && q.get('view') === 'leaderboard' && this.config.app.leaderboard) { await this.setView('leaderboard', { lbState: q.get('score') || '' }); return true; }
        const page = q.get('view') && q.get('view') !== 'leaderboard' && this.views().some(v => v.id === q.get('view')) ? q.get('view') : null;
        if (!modeId || (source && source.hashable === false)) { await this.landing(); if (page) await this.setView(page); return true; }
        if (!this.modes().some(m => m.id === modeId)) { await this.setMode(this.defaultMode()); return true; }
        await this.setMode(modeId, { keepFeature: !!featId });
        if (featId) {
            const jur = this.config.app.jurisdictions.find(j => j.id === modeId);
            if (jur?.multiple) this.pickMany(featId.split(',').filter(Boolean).map(decodeURIComponent));
            else this.pickById(decodeURIComponent(featId));
        }
        if (page) await this.setView(page);
        if (this.config.app.leaderboard && (q.get('view') === 'leaderboard' || q.has('score'))) {
            if (q.get('view') === 'leaderboard') await this.setView('leaderboard', { lbState: q.get('score') || '' });
            else { this.pendingScore = q.get('score'); }
        }
        return true;
    }

    /* -------------------------------------------------------------- resize */

    wireResize() {
        const handle = this.el.querySelector('.sidebar-resize');
        const sidebar = this.$('#sidebar');
        const key = `${this.config.app.id || 'glen'}-sidebar-frac`;
        try {
            const f = Number(localStorage.getItem(key));
            if (f > 0.2 && f < 0.85) document.documentElement.style.setProperty('--sidebar-width', (f * 100).toFixed(1) + 'vw');
        } catch { /* storage unavailable */ }
        handle.addEventListener('pointerdown', e => {
            handle.setPointerCapture(e.pointerId);
            const move = ev => {
                const w = Math.max(360, Math.min(window.innerWidth - 320, window.innerWidth - ev.clientX));
                document.documentElement.style.setProperty('--sidebar-width', w + 'px');
                this.mapView.map.resize();
            };
            const up = () => {
                handle.removeEventListener('pointermove', move);
                try { localStorage.setItem(key, parseInt(getComputedStyle(sidebar).width) / window.innerWidth); } catch { /* ignore */ }
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up, { once: true });
        });
    }
}

async function fetchJson(url) {
    try {
        const r = await fetch(url, { cache: 'no-cache' });
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

/** Dataset citations from data/sources.json (written by precompute sources), for a page with sources: true. */
function sourcesHtml(sources) {
    const items = (sources.datasets || []).map(d => {
        const st = d.stac || {};
        const link = (st.links || []).find(l => l.rel === 'self')?.href;
        const lic = (st.links || []).find(l => l.rel === 'license')?.href;
        const by = (st.providers || []).filter(p => (p.roles || []).some(r => r === 'producer' || r === 'licensor')).map(p => p.name);
        return `<li><b>${escapeHtml(st.title || d.id)}</b>${by.length ? `. ${escapeHtml([...new Set(by)].join(', '))}` : ''}${st['sci:citation'] ? `<div class="cite">${escapeHtml(st['sci:citation'])}</div>` : ''}<div class="meta">${st.license ? `Licence: ${lic ? `<a href="${escapeHtml(lic)}" target="_blank" rel="noopener">${escapeHtml(st.license)}</a>` : escapeHtml(st.license)}` : ''}${link ? ` · <a href="${escapeHtml(link)}" target="_blank" rel="noopener">STAC record</a>` : ''}</div></li>`;
    });
    return items.length ? `<h3>Datasets queried by this app</h3><ul class="sources">${items.join('')}</ul>` : '';
}

const naturalCompare = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/** Ids compared by value, as pickById matches them ("20001" and 20001.0). */
const sameId = (a, b) => String(a) === String(b) || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b));

/**
 * The box around several [xmin, ymin, xmax, ymax] boxes; one that crosses the
 * antimeridian (xmin > xmax) is returned alone, and an incomplete one is skipped.
 */
function unionBbox(boxes) {
    const ok = boxes.filter(b => b.every(Number.isFinite));
    if (!ok.length) return null;
    if (ok.length === 1 || ok.some(b => b[0] > b[2])) return ok[ok.length - 1];
    return [Math.min(...ok.map(b => b[0])), Math.min(...ok.map(b => b[1])), Math.max(...ok.map(b => b[2])), Math.max(...ok.map(b => b[3]))];
}

/** The base a number box's value is offset from: the area's value for a relative param, else 0. */
function numberBase(g) {
    const b = Number(g.dataset.base);
    return g.dataset.base && Number.isFinite(b) ? b : 0;
}

