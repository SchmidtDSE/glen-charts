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
 * (core/leaderboard.js: a second tab ranking every area of one type).
 * A param with "control": "slider" is drawn as a slider over its options.
 * An area type with "picker": "map" is chosen by clicking the map only: the
 * search box gives way to labels.place_hint.
 */

import { loadConfig, Engine, jurisdictionAoi, statewideAoi, resolveParams, optionValue, optionLabel, paramKey, paramTokens } from './engine.js';
import { MapView, renderLegend, quantileBreaks } from './map.js';
import { Leaderboard, leaderboardCss } from './leaderboard.js';
import { renderThemeCard, builtinCharts, shortErr } from './report.js';
import { wireExportButton } from './export.js';
import { escapeHtml, setFormatOptions } from './format.js';

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
    const ext = { tokens: {}, charts: {}, overlays: [], sources: [], ...extensions };
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
            aoi: null,
            features: [],
            params: {},
            mapTheme: null,
            token: 0,
            view: 'profile',    // 'profile' | 'leaderboard'
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
        this.reference = app.reference ? { ...app.reference, values: refValues } : null;
        let client = null;
        if (app.engine === 'wasm') {
            const { WasmQueryClient } = await import('./wasm.js');
            client = new WasmQueryClient(app.wasm);
        }
        this.engine = new Engine(config, { mcpUrl: rt?.mcp_server_url || app.mcp_url, statewide, client, dataBase, tokens: this.ext.tokens });
        this.mapView = new MapView('map', app);
        this.mapView.onPick = id => this.pickById(id);
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
        step.innerHTML = app.params.map(p => `
            <div class="step-label">${escapeHtml(p.label || p.id)}</div>
            ${p.control === 'slider' ? `
            <div class="param-slider" data-param="${escapeHtml(p.id)}" style="--n:${p.options.length}">
                <input type="range" min="0" max="${p.options.length - 1}" step="1" value="0" aria-label="${escapeHtml(p.label || p.id)}">
                <div class="param-stops">${p.options.map((o, i) => `<button type="button" data-i="${i}" data-value="${escapeHtml(optionValue(o))}" aria-pressed="false">${escapeHtml(optionLabel(p, o))}</button>`).join('')}</div>
            </div>` : `
            <div class="seg" role="radiogroup" data-param="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.label || p.id)}">
                ${p.options.map(o => `<button type="button" role="radio" data-value="${escapeHtml(optionValue(o))}" aria-checked="false">${escapeHtml(optionLabel(p, o))}</button>`).join('')}
            </div>`}
            ${p.help ? `<div class="step-help">${escapeHtml(p.help)}</div>` : ''}`).join('');
        step.querySelectorAll('.seg[data-param] button').forEach(b => {
            b.onclick = () => this.setParam(b.parentElement.dataset.param, b.dataset.value);
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
        this.markParams();
    }

    markParams() {
        this.$('#step-params').querySelectorAll('[data-param]').forEach(g => {
            const v = String(this.state.params[g.dataset.param]);
            if (g.classList.contains('param-slider')) this.markSlider(g, v, true);
            else g.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === v)));
        });
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
            } catch (err) { console.error(err); }
        }
        if (s.view === 'leaderboard' && this.lb) this.lb.load(s.params, this.paramNote());
        const a = this.state.aoi;
        if (!a) { this.writeHash(); return; }
        if (a.kind === 'state') this.setAoi(statewideAoi(this.config.app, this.state.params));
        else if (this.state.jur && this.state.feature) this.setAoi(jurisdictionAoi(this.state.jur, this.state.feature, this.config.app, this.state.params));
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
            s.mode = 'state'; s.jur = null; s.feature = null;
            this.markMode('state');
            this.hideHint();
            this.mapView.clearJurisdiction();
            this.mapView.fit(this.config.app.view);
            this.setAoi(statewideAoi(this.config.app, s.params));
            return;
        }
        const source = this.ext.sources.find(x => x.id === id);
        if (source) {
            s.mode = id; s.jur = null; s.feature = null;
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
        const close = () => { list.hidden = true; active = -1; };
        const render = () => {
            const q = input.value.trim().toLowerCase();
            matches = (q ? this.state.features.filter(f => String(f.name).toLowerCase().includes(q)) : this.state.features).slice(0, 60);
            list.innerHTML = matches.map((f, i) =>
                `<li role="option" data-i="${i}" aria-selected="${i === active}">${escapeHtml(f.name)}${f.detail ? `<small>${escapeHtml(f.detail)}</small>` : ''}</li>`).join('');
            list.hidden = !matches.length;
        };
        input.addEventListener('input', () => { active = -1; render(); });
        input.addEventListener('focus', render);
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

    pickById(id) {
        const s = this.state;
        if (!s.jur) return;
        // ids match by value: a numeric id in the tiles (e.g. 20001.0) finds "20001" in the list
        const f = s.features.find(x => String(x.id) === String(id) || (Number.isFinite(Number(id)) && Number(x.id) === Number(id)));
        this.pick(f || { id, name: `${s.jur.singular || s.jur.label} ${id}` });
    }

    pick(feature) {
        const s = this.state;
        if (!feature || !s.jur) return;
        if (s.view === 'leaderboard' && this.lb) {
            // a map click on the leaderboard finds the row; the profile opens from the row
            this.lb.focus(feature.id);
            this.mapView.select(feature.id);
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

    /* ------------------------------------------------------------- report */

    setAoi(aoi) {
        this.state.aoi = aoi;
        this.state.token++;
        this.writeHash();
        if (this.state.view === 'leaderboard') return;
        if (aoi) this.renderReport();
        else this.renderIntro();
    }

    syncPickHint() {
        const h = this.$('#step-place .pick-hint');
        if (!h) return;
        const f = this.state.feature;
        const text = this.config.app.labels?.place_hint || 'Click the map to choose an area';
        h.innerHTML = f ? `<b>${escapeHtml(f.name)}</b> · ${escapeHtml(text)} to choose another` : escapeHtml(text);
    }

    /* ---------------------------------------------------------- leaderboard */

    renderViewTabs() {
        const spec = this.config.app.leaderboard;
        if (!spec) return;
        const nav = document.createElement('nav');
        nav.className = 'view-tabs';
        nav.setAttribute('role', 'tablist');
        nav.innerHTML = `<button type="button" role="tab" data-view="profile">${escapeHtml(spec.profile_tab || 'Profile')}</button>` +
            `<button type="button" role="tab" data-view="leaderboard">${escapeHtml(spec.tab || 'Leaderboard')}</button>`;
        nav.querySelectorAll('button').forEach(b => { b.onclick = () => this.setView(b.dataset.view); });
        this.$('#controls').before(nav);
        this.markView();
    }

    markView() {
        const v = this.state.view;
        this.el.querySelectorAll('.view-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
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

    leaderboardJur() {
        const spec = this.config.app.leaderboard;
        return this.config.app.jurisdictions.find(j => j.id === spec.jurisdiction) || this.config.app.jurisdictions[0];
    }

    async setView(view, { lbState = null } = {}) {
        const spec = this.config.app.leaderboard;
        if (!spec || (view !== 'profile' && view !== 'leaderboard')) view = 'profile';
        const s = this.state;
        s.view = view;
        this.markView();
        if (view === 'leaderboard') {
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
                    onOpen: f => { this.setView('profile').then(() => this.pick(f)); },
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
            if (s.feature) this.mapView.select(s.feature.id); else this.mapView.clearSelection();
            if (s.aoi) this.renderReport(); else this.renderIntro();
        }
        this.writeHash();
    }

    paramNote() {
        const app = this.config.app;
        return app.params.map(p => {
            const o = p.options.find(x => String(optionValue(x)) === String(this.state.params[p.id]));
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
        if (s.jur) return s.jur.singular || s.jur.label;
        return s.aoi?.kindLabel || this.ext.sources.find(x => x.id === s.mode)?.kindLabel || 'Area';
    }

    renderIntro() {
        const app = this.config.app;
        const r = this.$('#report');
        const what = (this.state.jur?.singular || 'place').toLowerCase();
        r.innerHTML = app.intro
            ? `<div class="intro">${app.intro}</div>`
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
        const paramNote = app.params.map(p => {
            const o = p.options.find(x => String(optionValue(x)) === String(s.params[p.id]));
            return o === undefined ? '' : `${p.label || p.id}: ${optionLabel(p, o)}`;
        }).filter(Boolean).join(' · ');
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
            ${this.ext.reportHead ? this.ext.reportHead(aoi, { engine: this.engine, reference: this.reference, isRegion }) || '' : ''}`;
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
            legend.hidden = true;
            return;
        }
        const token = s.token;
        const want = theme.id;
        legend.hidden = false;
        legend.innerHTML = `<div class="title">${escapeHtml(theme.map.label)}</div><div class="tile-note">Loading…</div>`;
        try {
            const rows = await this.engine.run(theme, theme.map.query, s.aoi);
            if (token !== s.token || s.mapTheme !== want) return;
            const info = await this.mapView.setChoropleth(theme.map, rows);
            renderLegend(legend, theme.map, info);
        } catch (err) {
            if (token !== s.token) return;
            legend.innerHTML = `<div class="err">Map query failed: ${escapeHtml(shortErr(err))}</div>`;
            console.error(err, err.sql);
        }
    }

    showHint(text) { const h = this.$('#map-hint'); h.textContent = text; h.hidden = false; }
    hideHint() { this.$('#map-hint').hidden = true; }

    /* ---------------------------------------------------------------- hash */

    writeHash() {
        const s = this.state;
        const app = this.config.app;
        const parts = [];
        if (s.mode && s.mode !== 'state') parts.push(s.mode);
        if (s.jur && s.feature) parts.push(encodeURIComponent(s.feature.id));
        const q = new URLSearchParams();
        if (s.themes.size !== this.config.themes.length) q.set('themes', this.orderedThemes().map(t => t.id).join(','));
        if (s.mapTheme && this.config.themes.some(t => t.map)) q.set('map', s.mapTheme);
        for (const p of app.params) if (String(s.params[p.id]) !== String(p.default ?? optionValue(p.options[0]))) q.set(p.id, s.params[p.id]);
        if (s.view === 'leaderboard') q.set('view', 'leaderboard');
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
        const source = this.ext.sources.find(x => x.id === modeId);
        if (!modeId && q.get('view') === 'leaderboard' && this.config.app.leaderboard) { await this.setView('leaderboard', { lbState: q.get('score') || '' }); return true; }
        if (!modeId || (source && source.hashable === false)) { await this.landing(); return true; }
        if (!this.modes().some(m => m.id === modeId)) { await this.setMode(this.defaultMode()); return true; }
        await this.setMode(modeId, { keepFeature: !!featId });
        if (featId) this.pickById(decodeURIComponent(featId));
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

const naturalCompare = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
