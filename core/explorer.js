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
 * live_note, engine ("mcp" | "wasm"), wasm, data_base, format, id.
 */

import { loadConfig, Engine, jurisdictionAoi, statewideAoi, resolveParams, optionValue, optionLabel, paramKey, paramTokens } from './engine.js';
import { MapView, renderLegend } from './map.js';
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
        };
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
        this.wireSearch();
        this.wireResize();
        if (!(await this.restoreFromHash())) await this.setMode(this.defaultMode());
    }

    defaultMode() {
        const app = this.config.app;
        if (app.default_mode) return app.default_mode;
        if (app.statewide && app.statewide.selectable !== false) return 'state';
        if (app.jurisdictions.length === 1 && !this.ext.sources.length) return app.jurisdictions[0].id;
        return null;
    }

    installCss() {
        const css = Object.values(this.charts).map(c => c.css || '').join('\n');
        if (!css.trim()) return;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    }

    installOverlays() {
        const box = this.$('#overlay-legend');
        const parts = [];
        for (const o of this.ext.overlays) {
            this.mapView.addOverlay(o);
            if (o.legend || o.toggle) {
                parts.push(`<div class="ov" data-ov="${escapeHtml(o.id)}">${o.legend || ''}${o.toggle ? `<label class="lg-toggle"><input type="checkbox" checked> ${escapeHtml(o.toggle)}</label>` : ''}</div>`);
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
        step.innerHTML = app.params.map(p => `
            <div class="step-label">${escapeHtml(p.label || p.id)}</div>
            <div class="seg" role="radiogroup" data-param="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.label || p.id)}">
                ${p.options.map(o => `<button type="button" role="radio" data-value="${escapeHtml(optionValue(o))}" aria-checked="false">${escapeHtml(optionLabel(p, o))}</button>`).join('')}
            </div>
            ${p.help ? `<div class="step-help">${escapeHtml(p.help)}</div>` : ''}`).join('');
        step.querySelectorAll('[data-param] button').forEach(b => {
            b.onclick = () => this.setParam(b.parentElement.dataset.param, b.dataset.value);
        });
        this.markParams();
    }

    markParams() {
        this.$('#step-params').querySelectorAll('[data-param]').forEach(g => {
            const v = String(this.state.params[g.dataset.param]);
            g.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === v)));
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
        const isJur = this.config.app.jurisdictions.some(j => j.id === id);
        this.$('#step-place').hidden = !isJur;
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
        this.showHint(this.config.app.labels?.place_hint || `Click ${/^[aeiou]/i.test(sing) ? 'an' : 'a'} ${sing} on the map, or search by name`);
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
        s.feature = feature;
        this.$('#place-input').value = feature.name;
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
        if (aoi) this.renderReport();
        else this.renderIntro();
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
        const hash = '#' + parts.join('/') + (q.toString() ? '?' + q.toString().replace(/%2C/g, ',') : '');
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
        if (!modeId || (source && source.hashable === false)) { await this.setMode(this.defaultMode()); return true; }
        if (!this.modes().some(m => m.id === modeId)) { await this.setMode(this.defaultMode()); return true; }
        await this.setMode(modeId, { keepFeature: !!featId });
        if (featId) this.pickById(decodeURIComponent(featId));
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
