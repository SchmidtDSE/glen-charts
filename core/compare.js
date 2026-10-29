/**
 * createCompare: compare mode. The reader picks a country, supplies focal
 * units (drawn or uploaded polygons), chooses comparison sets for each other
 * role (catalog presets, drawn or uploaded polygons, or none) and a basket of
 * metrics; every focal unit is then scored against the comparison sets, metric
 * by metric (core/score.js), on the page.
 *
 *   import { createCompare } from '.../glen-charts@vX/core/compare.js';
 *   createCompare();
 *
 * app.json "compare":
 *   countries        path of the country list ({ id, iso3, name, bbox, h0s }[]),
 *                    which sets {{ISO2}}, {{ISO3}} and {{H0S}} in every query
 *   default_country  ISO 3166 alpha-2 code
 *   strata           { label, plural, sql } — sql returns (h0, h8, stratum, name);
 *                    the default landscape is the strata the focal units touch
 *   landscapes       [{ id: 'strata' | 'country', label, default? }]
 *   roles            [{ id: 'focal' | 'floor' | 'ceiling', label, singular, color,
 *                       help, default?, presets?: [{ id, label, unit, description,
 *                       countries?, sql, map? }] }] — a preset's sql returns
 *                    (id, name, cell); map is { pmtiles, source_layer, id_prop }
 *                    for units drawn from a tile set, else single-cell units are
 *                    drawn as hexagons from their ids; the focal role may list
 *                    examples: [{ label, file, countries? }], GeoJSON files (relative
 *                    to the app) that load into the editor with one click
 *   precompute       { countries } for `precompute baselines`
 * Each theme has one query, `units`, over {{UNITS}} (sources/units.js), and a
 * `variables` list: { id, label, dir, format, unit?, default?, source?,
 * resolution?, licence? }; a theme with "scored": false holds covariates.
 *
 * Catalog presets are read from data/baselines/<country>/<preset>.json when
 * precomputed; drawn and uploaded sets, and presets without a file, run live.
 */

import { loadConfig, expand } from './engine.js';
import { McpQueryClient } from './mcp.js';
import { MapView } from './map.js';
import { fmt, escapeHtml, setFormatOptions } from './format.js';
import { countryTokens, presetsFor, polygonUnitsSql, presetUnitsSql, withStrata, strataNamesSql, inlineUnitsSql, resolvedUnitsSql } from '../sources/units.js';
import { UnitSetEditor, fmtHa } from '../sources/multi-draw.js';
import { combineStrata, scoreUnits, focalStrata, rankOf, basket } from './score.js';
import { renderCompareStrip, compareStripCss } from '../charts/compare-strip.js';
import { hover } from './charts.js';

const SHELL = `
    <section id="map-wrap">
        <div id="map"></div>
        <div class="map-legends map-overlay"><div id="map-legend" hidden></div></div>
        <div id="map-hint" class="map-overlay" hidden></div>
    </section>
    <aside id="sidebar">
        <div class="sidebar-resize" title="Drag to resize"></div>
        <section id="controls" class="compare-controls"></section>
        <section id="report" aria-live="polite"></section>
    </aside>`;

export async function createCompare({ root = null, base = '.' } = {}) {
    let el = typeof root === 'string' ? document.querySelector(root) : root;
    if (!el) el = document.getElementById('glen');
    if (!el) { el = document.createElement('main'); el.id = 'glen'; document.body.appendChild(el); }
    el.classList.add('glen-layout');
    el.innerHTML = SHELL;
    if (!document.getElementById('tooltip')) {
        const t = document.createElement('div');
        t.id = 'tooltip'; t.setAttribute('role', 'tooltip'); t.hidden = true;
        document.body.appendChild(t);
    }
    const app = new Compare(el, base);
    try {
        await app.boot();
    } catch (err) {
        console.error(err);
        el.querySelector('#report').innerHTML = `<div class="err">Failed to start: ${escapeHtml(err.message)}</div>`;
    }
    return app;
}

class Compare {
    constructor(el, base) {
        this.el = el;
        this.base = base;
        this.$ = sel => el.querySelector(sel);
        this.sets = {};          // role id → { mode: preset id | 'custom' | 'none', editor }
        this.data = null;        // { rows, strataNames, live, presets } from the last run
        this.result = null;
        this.highlight = null;
        this.token = 0;
        this.cache = new Map();
    }

    async boot() {
        const config = this.config = await loadConfig(this.base);
        const app = this.app = config.app;
        const cmp = this.cmp = app.compare;
        if (!cmp) throw new Error('app.json has no "compare" block');
        setFormatOptions(app.format || {});
        const rt = await fetchJson(`${this.base}/config.json`);
        this.client = new McpQueryClient(rt?.mcp_server_url || app.mcp_url);
        this.countries = await fetchJson(`${this.base}/${cmp.countries}`);
        if (!this.countries?.length) throw new Error(`No country list at ${cmp.countries}`);
        this.themes = config.themes;
        this.variables = this.themes.flatMap(t => (t.variables || []).map(v => ({ ...v, theme: t.id, group: t.id, scored: t.scored !== false, color: t.color })));
        this.selected = new Set(this.variables.filter(v => v.default !== false).map(v => v.id));
        this.landscape = (cmp.landscapes || []).find(l => l.default)?.id || 'strata';
        this.roles = cmp.roles;
        this.focalRole = this.roles.find(r => r.id === 'focal');
        this.compRoles = this.roles.filter(r => r.id !== 'focal');

        const style = document.createElement('style');
        style.textContent = compareCss + compareStripCss;
        document.head.appendChild(style);

        this.mv = new MapView('map', app);
        this.mv.fitTo = geoms => fitGeoms(this.mv.map, geoms);
        this.renderControls();
        this.wireResize();
        this.renderIntro();
        await this.setCountry(cmp.default_country || this.countries[0].id);
        this.mv.ready.then(() => this.installMapLayers());
    }

    /* ------------------------------------------------------------ controls */

    renderControls() {
        const c = this.$('#controls');
        const roleStep = (r, n) => `
            <div class="step" id="step-${r.id}">
                <div class="step-label"><span class="step-num">${n}</span> ${escapeHtml(r.label)}</div>
                <div class="seg set-mode" role="radiogroup" aria-label="${escapeHtml(r.label)}"></div>
                <div class="step-help set-help">${escapeHtml(r.help || '')}</div>
                <div class="set-editor" hidden></div>
            </div>`;
        c.innerHTML = `
            <div class="controls-summary" hidden>
                <span class="summary-text"></span>
                <button type="button" class="ghost-btn" data-act="expand">Change settings</button>
            </div>
            <div class="step" id="step-country">
                <div class="step-label"><span class="step-num">1</span> Country</div>
                <select id="country-select" aria-label="Country">${this.countries.map(k => `<option value="${k.id}">${escapeHtml(k.name)}</option>`).join('')}</select>
                <div class="step-help">Every comparison set and query is limited to this country.</div>
            </div>
            <div class="step" id="step-focal">
                <div class="step-label"><span class="step-num">2</span> ${escapeHtml(this.focalRole.label)}</div>
                <div class="step-help">${escapeHtml(this.focalRole.help || '')}</div>
                <div class="set-editor"></div>
            </div>
            ${this.compRoles.map((r, i) => roleStep(r, i + 3)).join('')}
            <div class="step" id="step-landscape">
                <div class="step-label"><span class="step-num">${this.compRoles.length + 3}</span> Landscape</div>
                <div class="seg" role="radiogroup" aria-label="Landscape">${(this.cmp.landscapes || []).map(l => `<button type="button" role="radio" data-id="${l.id}">${escapeHtml(l.label)}</button>`).join('')}</div>
                <div class="step-help" id="landscape-help"></div>
            </div>
            <div class="step" id="step-metrics">
                <div class="step-label"><span class="step-num">${this.compRoles.length + 4}</span> Metrics</div>
                <div id="metric-groups"></div>
            </div>
            <div class="step run-row">
                <button type="button" id="run-btn" class="run-btn">Compare</button>
                <span id="run-status" class="step-help"></span>
            </div>`;

        const hint = { showHint: t => this.showHint(t), hideHint: () => this.hideHint() };
        const focalEd = new UnitSetEditor(this.mv, { role: 'focal', label: (this.focalRole.singular || 'unit').toLowerCase(), color: this.focalRole.color, prefix: 'f', examples: () => this.examplesFor(this.focalRole), onChange: () => this.setsChanged(), ...hint });
        focalEd.mount(this.$('#step-focal .set-editor'));
        this.sets.focal = { mode: 'custom', editor: focalEd };
        this.compRoles.forEach((r, i) => {
            const ed = new UnitSetEditor(this.mv, { role: r.id, label: (r.singular || 'unit').toLowerCase(), color: r.color, prefix: `${r.id[0]}${i}_`, onChange: () => this.setsChanged(), ...hint });
            ed.mount(this.$(`#step-${r.id} .set-editor`));
            this.sets[r.id] = { mode: r.default || 'none', editor: ed };
        });

        this.$('#country-select').onchange = e => this.setCountry(e.target.value);
        this.$('#step-landscape .seg').onclick = e => {
            const b = e.target.closest('button');
            if (!b) return;
            this.landscape = b.dataset.id;
            this.markLandscape();
            this.rescore();
        };
        this.markLandscape();
        this.renderMetrics();
        this.$('#run-btn').onclick = () => this.run();
        this.$('#controls [data-act=expand]').onclick = () => this.collapseControls(false);
    }

    /** After a run the settings fold to one line, so the results get the panel. */
    collapseControls(on) {
        const c = this.$('#controls');
        c.classList.toggle('collapsed', on);
        c.querySelector('.controls-summary').hidden = !on;
        if (on) {
            const n = this.sets.focal.editor.units.length;
            c.querySelector('.summary-text').textContent = `${this.country.name}: ${n} ${n === 1 ? (this.focalRole.singular || 'unit').toLowerCase() : this.focalRole.label.toLowerCase()} against ${this.compRoles.map(r => this.setLabel(r)).join(' and ')}`;
        }
    }

    renderSetModes() {
        for (const r of this.compRoles) {
            const set = this.sets[r.id];
            const presets = presetsFor(r, this.country.id);
            if (set.mode !== 'custom' && set.mode !== 'none' && !presets.some(p => p.id === set.mode)) set.mode = presets[0]?.id || 'custom';
            const opts = [...presets.map(p => ({ id: p.id, label: p.label })), { id: 'custom', label: 'Draw or upload' }, { id: 'none', label: 'None' }];
            const seg = this.$(`#step-${r.id} .set-mode`);
            seg.innerHTML = opts.map(o => `<button type="button" role="radio" data-id="${o.id}" aria-checked="${o.id === set.mode}">${escapeHtml(o.label)}</button>`).join('');
            seg.onclick = e => {
                const b = e.target.closest('button');
                if (!b) return;
                set.mode = b.dataset.id;
                if (set.mode !== 'custom') set.editor.stopDrawing();
                this.renderSetModes();
                this.setsChanged();
            };
            const p = presets.find(x => x.id === set.mode);
            this.$(`#step-${r.id} .set-help`).textContent = p ? p.description || '' : set.mode === 'none' ? `No ${r.label.toLowerCase()}: the scores that need it are left blank.` : r.help || '';
            this.$(`#step-${r.id} .set-editor`).hidden = set.mode !== 'custom';
        }
    }

    markLandscape() {
        this.$('#step-landscape .seg').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.id === this.landscape)));
        const s = this.cmp.strata;
        this.$('#landscape-help').textContent = this.landscape === 'strata' && s
            ? `Comparison units are clipped to the ${s.plural || 'strata'} that the focal units fall in, so that they come from the same region.`
            : 'Comparison units anywhere in the country count.';
    }

    renderMetrics() {
        const box = this.$('#metric-groups');
        box.innerHTML = this.themes.map(t => `
            <fieldset class="metric-group" style="--c:${t.color || 'var(--primary)'}">
                <legend>${escapeHtml(t.label)}</legend>
                ${t.blurb ? `<div class="step-help">${escapeHtml(t.blurb)}</div>` : ''}
                ${(t.variables || []).map(v => `
                    <label class="metric">
                        <input type="checkbox" value="${v.id}" ${this.selected.has(v.id) ? 'checked' : ''}>
                        <span>${escapeHtml(v.label)}</span>
                        ${v.licence ? `<span class="licence" title="${escapeHtml(v.licence)}">${/proprietary/i.test(v.licence) ? 'proprietary' : 'non-commercial'}</span>` : ''}
                    </label>`).join('')}
            </fieldset>`).join('');
        box.onchange = e => {
            if (e.target.type !== 'checkbox') return;
            e.target.checked ? this.selected.add(e.target.value) : this.selected.delete(e.target.value);
            this.rescore();
        };
    }

    /** A role's example files for the current country, as [{ label, url }]. */
    examplesFor(role) {
        return (role.examples || []).filter(x => !x.countries || x.countries.includes(this.country?.id))
            .map(x => ({ label: x.label, url: new URL(x.file, new URL(`${this.base}/`, location.href)).href }));
    }

    async setCountry(id) {
        const c = this.countries.find(k => k.id === id);
        if (!c) return;
        this.country = c;
        this.$('#country-select').value = id;
        this.renderSetModes();
        this.sets.focal?.editor.renderExamples();
        const [x0, y0, x1, y1] = c.bbox;
        await this.mv.ready;
        this.mv.map.fitBounds([[x0, y0], [x1, y1]], { padding: 30, duration: 700 });
        this.setsChanged();
    }

    setsChanged() {
        this.drawUnits();
        this.drawPresets();
        if (this.data) this.markStale();
    }

    markStale() {
        const n = this.$('#report .stale-note');
        if (n) n.hidden = false;
    }

    /* ---------------------------------------------------------------- run */

    async run() {
        const focal = this.sets.focal.editor.units;
        const status = this.$('#run-status');
        if (!focal.length) { status.textContent = `Add at least one ${(this.focalRole.singular || 'unit').toLowerCase()} first.`; return; }
        const token = ++this.token;
        const btn = this.$('#run-btn');
        btn.disabled = true;
        const ctok = countryTokens(this.country);
        const liveParts = [polygonUnitsSql(focal, 'focal')];
        const presets = [];
        for (const r of this.compRoles) {
            const set = this.sets[r.id];
            if (set.mode === 'custom' && set.editor.units.length) liveParts.push(polygonUnitsSql(set.editor.units, r.id));
            const p = presetsFor(r, this.country.id).find(x => x.id === set.mode);
            if (p) presets.push({ role: r, preset: p });
        }
        try {
            status.textContent = 'Reading comparison sets…';
            const files = await Promise.all(presets.map(({ preset }) => this.baselineFile(preset)));
            presets.forEach((p, i) => {
                p.file = files[i];
                if (!p.file) liveParts.push(presetUnitsSql(p.preset, p.role.id, ctok));
            });
            const slow = presets.filter(p => !p.file).map(p => p.preset.label);
            status.textContent = `Querying ${this.countryThemes().length} themes${slow.length ? ` (live: ${slow.join(', ')}; this can take several minutes)` : ''}…`;
            // resolve the live units to cells and strata once, then inline them in every theme query
            const UNITS = withStrata(liveParts, this.cmp.strata);
            const [resolved, strataRows] = await Promise.all([
                this.query(resolvedUnitsSql(UNITS)),
                this.cmp.strata ? this.query(strataNamesSql(liveParts, this.cmp.strata)) : [],
            ]);
            if (token !== this.token) return;
            const inline = inlineUnitsSql(resolved);
            const themeRows = await Promise.all(this.countryThemes().map(t => this.query(expand(t.sql.units, { ...ctok, UNITS: inline }, `${t.id}/units`))));
            if (token !== this.token) return;
            const rows = themeRows.flat();
            const strataNames = new Map(strataRows.map(r => [String(r.stratum), r.name]));
            for (const p of presets) {
                if (!p.file) continue;
                for (const s of p.file.strata || []) strataNames.set(String(s.stratum), s.name);
                for (const t of this.countryThemes()) for (const [id, stratum, variable, value, w] of p.file.results?.[t.id] || []) rows.push({ grp: p.role.id, id, stratum, variable, value, w });
            }
            this.data = { rows, strataNames, presets, sql: { UNITS, themes: this.countryThemes().map(t => ({ id: t.id, label: t.label, sql: expand(t.sql.units, { ...ctok, UNITS: '{{UNITS}}' }) })) } };
            status.textContent = '';
            this.rescore();
            this.collapseControls(true);
        } catch (err) {
            console.error(err);
            if (token === this.token) {
                status.textContent = '';
                this.$('#report').innerHTML = `<div class="card"><div class="err">The comparison failed: ${escapeHtml(String(err.message).split('\n')[0].slice(0, 300))}</div></div>`;
            }
        } finally {
            if (token === this.token) btn.disabled = false;
        }
    }

    /** A cached query, retried once after a transient failure on the server or the network. */
    /** Themes that cover the chosen country (a theme's "countries" list; none means every country). */
    countryThemes() {
        return this.themes.filter(t => !t.countries || t.countries.includes(this.country.id));
    }

    query(sql) {
        if (!this.cache.has(sql)) {
            const transient = err => /IO Error|Could not resolve|HTTP 5\d\d|Failed to fetch|NetworkError|aborted/i.test(String(err?.message));
            const p = this.client.query(sql)
                .catch(err => (transient(err) ? new Promise(r => setTimeout(r, 2000)).then(() => this.client.query(sql)) : Promise.reject(err)))
                .catch(err => { this.cache.delete(sql); throw err; });
            this.cache.set(sql, p);
        }
        return this.cache.get(sql);
    }

    baselineFile(preset) {
        const key = `baseline|${this.country.id}|${preset.id}`;
        if (!this.cache.has(key)) this.cache.set(key, fetchJson(`${this.base}/data/baselines/${this.country.id}/${preset.id}.json`));
        return this.cache.get(key);
    }

    rescore() {
        if (!this.data) return;
        const { rows } = this.data;
        const landscape = this.landscape === 'strata' && this.cmp.strata ? focalStrata(rows, 'focal') : null;
        const units = combineStrata(rows, landscape);
        const vars = this.variables.filter(v => this.selected.has(v.id));
        const result = scoreUnits(units, vars, { focal: 'focal', floor: 'floor', ceiling: 'ceiling' });
        const inView = role => new Set([...units.values()].filter(u => u.grp === role).map(u => u.id));
        this.result = { ...result, vars, landscape, inView: Object.fromEntries(this.compRoles.map(r => [r.id, inView(r.id)])) };
        this.renderResults();
        this.drawUnits();
        this.drawPresets();
    }

    /* ------------------------------------------------------------- report */

    renderIntro() {
        this.$('#report').innerHTML = `<div class="intro">${this.app.intro || `<h2>${escapeHtml(this.app.title || 'Compare')}</h2>`}</div>`;
    }

    focalName(id) { return this.sets.focal.editor.units.find(u => u.id === id)?.name || id; }
    roleLabel(id) { return this.roles.find(r => r.id === id)?.label || id; }
    setLabel(role) {
        const set = this.sets[role.id];
        if (set.mode === 'none') return 'none';
        if (set.mode === 'custom') return `${set.editor.units.length} drawn or uploaded ${set.editor.units.length === 1 ? 'unit' : 'units'}`;
        return presetsFor(role, this.country.id).find(p => p.id === set.mode)?.label || set.mode;
    }

    /**
     * The rating scale: five bands from the floor's median (rank 1) to the
     * ceiling's (rank 5), with app.json compare.rating { colors, labels } or
     * these defaults. Labels name the roles' anchors ("typical cocoa farms").
     */
    rating() {
        const floorRole = this.compRoles.find(x => x.id === 'floor'), ceilRole = this.compRoles.find(x => x.id === 'ceiling');
        const floorA = floorRole?.anchor || floorRole?.label.toLowerCase() || 'the floor';
        const ceilA = ceilRole?.anchor || ceilRole?.label.toLowerCase() || 'the ceiling';
        const cfg = this.cmp.rating || {};
        const colors = cfg.colors || RATING_COLORS;
        const fill = t => t.replace('{floor}', floorA).replace('{ceiling}', ceilA);
        const labels = (cfg.labels || RATING_LABELS).map(fill);
        const label = (rank, p) => (rank == null ? 'Not rated'
            : p < 0 ? fill(cfg.below || 'Below {floor}') : p > 1 ? fill(cfg.beyond || 'Beyond {ceiling}') : labels[rank - 1]);
        const ink = rank => (rank === 1 || rank === 5 ? '#fff' : '#22201f');
        // compare.rating.basis: the theme ids the headline rating is taken over (default: every scored theme)
        const basis = cfg.basis || null;
        return { floorA, ceilA, colors, labels, label, ink, basis, color: rank => (rank ? colors[rank - 1] : '#bdbab3') };
    }

    /** A scored unit's headline: the median position over the rating basis, and its rank. */
    headline(u) {
        const R = this.rating(), r = this.result;
        const vars = r.vars.filter(v => v.scored && r.stats[v.id]?.separates && (!R.basis || R.basis.includes(v.group)));
        const b = basket(vars.map(v => u.metrics[v.id]?.position));
        return { ...b, rank: rankOf(b.median) };
    }

    renderResults() {
        const r = this.result, rep = this.$('#report');
        const R = this.rating();
        const scored = r.vars.filter(v => v.scored);
        const covs = r.vars.filter(v => !v.scored);
        const nIn = role => r.inView[role]?.size || 0;
        const strataText = r.landscape
            ? [...r.landscape].map(s => this.data.strataNames.get(s) || (s === '-1' ? 'outside any mapped ecoregion' : s)).join('; ')
            : `all of ${this.country.name}`;
        const order = new Map(this.sets.focal.editor.units.map((u, i) => [u.id, i]));
        const units = [...r.units].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
        const pctTxt = v => (v == null ? '—' : Math.round(v).toString());
        const contrastTxt = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) >= 10 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}%`);
        const retTxt = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
        const lic = v => (v.licence ? ` <span class="licence" title="${escapeHtml(v.licence)}">${/proprietary/i.test(v.licence) ? 'proprietary' : 'NC'}</span>` : '');
        const vfmt = (x, v) => (x == null ? '—' : `${fmt(x, v.format)}${v.unit ? ` ${escapeHtml(v.unit)}` : ''}`);
        const floorRole = this.compRoles.find(x => x.id === 'floor'), ceilRole = this.compRoles.find(x => x.id === 'ceiling');
        const posTxt = p => (p == null ? '—' : p < 0 ? 'below 0%' : p > 1 ? 'beyond 100%' : `${Math.round(p * 100)}%`);
        const posChip = p => (p == null ? '—' : `<span class="pos-chip" style="background:${R.color(rankOf(p))};color:${R.ink(rankOf(p))}">${posTxt(p)}</span>`);
        const dropped = scored.filter(v => !r.stats[v.id].separates);
        const rated = scored.filter(v => r.stats[v.id].separates);
        const groups = [...new Set(rated.map(v => v.group))].map(g => this.themes.find(t => t.id === g)).filter(Boolean);
        const ratingRow = u => {
            const h = this.headline(u), p = h.median, rank = h.rank;
            const at = Math.min(1, Math.max(0, p ?? 0)) * 100;
            const subs = groups.map(t => `<div class="sq-group"><span class="sq-label">${escapeHtml(t.label)}${R.basis && !R.basis.includes(t.id) ? `: ${escapeHtml(R.label(u.byGroup[t.id]?.rank, u.byGroup[t.id]?.median).toLowerCase())}` : ''}</span>${rated.filter(v => v.group === t.id).map(v => {
                const m = u.metrics[v.id] || {};
                return `<span class="sq" data-v="${v.id}" style="background:${R.color(m.rank)}"></span>`;
            }).join('')}</div>`).join('');
            return `<div class="rating-row ${this.highlight === u.id ? 'on' : ''}" data-id="${u.id}">
                <div class="rating-head">
                    <span class="rank-badge" style="background:${R.color(rank)};color:${R.ink(rank)}">${rank ?? '–'}</span>
                    <span class="farm-name">${escapeHtml(this.focalName(u.id))}</span>
                    <span class="rating-label">${escapeHtml(R.label(rank, p))}</span>
                </div>
                <div class="rating-track" aria-hidden="true">${R.colors.map(c => `<span style="background:${c}"></span>`).join('')}${p == null ? '' : `<i class="marker${p < 0 ? ' below' : p > 1 ? ' beyond' : ''}" style="left:${at}%"></i>`}</div>
                <div class="track-ends"><span>${escapeHtml(R.floorA)}</span><span>${escapeHtml(R.ceilA)}</span></div>
                <div class="sq-row">${subs}</div>
            </div>`;
        };
        const counts = [0, 0, 0, 0, 0];
        let below = 0;
        units.forEach(u => { const h = this.headline(u); if (h.median < 0) below++; else if (h.rank) counts[h.rank - 1]++; });
        const nUnit = n => `${n} ${n === 1 ? (this.focalRole.singular || 'unit').toLowerCase() : this.focalRole.label.toLowerCase()}`;
        const parts = [
            counts[3] + counts[4] ? `${nUnit(counts[3] + counts[4])} close to or as good as ${R.ceilA}` : '',
            counts[2] ? `${nUnit(counts[2])} halfway to ${R.ceilA}` : '',
            counts[0] + counts[1] ? `${nUnit(counts[0] + counts[1])} like or a little better than ${R.floorA}` : '',
            below ? `${nUnit(below)} below ${R.floorA}` : '',
        ].filter(Boolean);
        const summary = parts.length ? `${parts.join('; ')}.`.replace(/^./, c => c.toUpperCase()) : 'No unit could be rated.';

        rep.innerHTML = `
            <div class="report-head">
                <div>
                    <div class="kind">${escapeHtml(this.country.name)}</div>
                    <h2>Comparison results</h2>
                </div>
                <div class="head-actions">
                    <button class="ghost-btn" data-act="csv" type="button">Download CSV</button>
                </div>
            </div>
            <div class="note-card stale-note" hidden>The sets have changed since these results were computed. Press Compare to update them.</div>
            <p class="lede">${units.length} ${units.length === 1 ? escapeHtml((this.focalRole.singular || 'unit').toLowerCase()) : escapeHtml(this.focalRole.label.toLowerCase())}
                compared with ${this.compRoles.map(x => `${nIn(x.id).toLocaleString()} ${escapeHtml(x.label.toLowerCase())} units (${escapeHtml(this.setLabel(x))})`).join(' and ')}
                in ${escapeHtml(strataText)}.</p>

            <div class="card theme-card" style="--c:${this.focalRole.color}">
                <div class="card-head"><h3>Ratings</h3></div>
                <p class="rating-summary">${escapeHtml(summary)}</p>
                <div class="rating-scale">${R.labels.map((l, i) => `<span><i style="background:${R.colors[i]}"></i>${escapeHtml(l)}</span>`).join('')}</div>
                <div class="rating-rows">${units.map(ratingRow).join('')}</div>
                <p class="card-blurb">Each ${escapeHtml((this.focalRole.singular || 'unit').toLowerCase())} is placed, metric by metric, between ${escapeHtml(R.floorA)} at the left of the bar and ${escapeHtml(R.ceilA)} at the right, both in the same ${escapeHtml(this.cmp.strata?.plural || 'region')}. The bar is split into five equal bands, the five ranks of the Wallacea Trust methodology, and the rating is the band of the median across ${R.basis ? `the ${escapeHtml(groups.filter(t => R.basis.includes(t.id)).map(t => t.label.toLowerCase()).join(' and '))} metrics` : 'the metrics'}. Each square is one metric. ${R.basis && groups.some(t => !R.basis.includes(t.id)) ? `${escapeHtml(groups.filter(t => !R.basis.includes(t.id)).map(t => t.label).join(' and '))} is rated separately and not counted in the headline: ${escapeHtml(this.themes.find(t => !R.basis.includes(t.id) && t.scored !== false)?.blurb || '')} ` : ''}${dropped.length ? `Not used in the ratings, because ${escapeHtml(R.floorA)} and ${escapeHtml(R.ceilA)} here score about the same on them: ${escapeHtml(dropped.map(v => v.label).join(', '))}.` : ''}</p>
                <p class="card-blurb">These are global remote-sensing and range-map layers, not the field surveys the methodology requires, and a protected area is not a reference site under it. A rating shows how a place compares; it does not show that its management caused the difference.</p>
            </div>

            ${covs.length ? `
            <div class="card theme-card" style="--c:#6b6b6b">
                <div class="card-head"><h3>Matching covariates</h3></div>
                <p class="card-blurb">These are not scored. A comparison is only as good as the match between the sets on them: where a focal unit falls outside a set's range, no unit in that set resembles it on that variable.</p>
                <div class="table-wrap"><table class="cmp-table">
                    <thead><tr><th>Covariate</th><th>Focal range</th><th>${escapeHtml(floorRole?.label || 'Floor')} range</th><th>${escapeHtml(ceilRole?.label || 'Ceiling')} range</th><th>Focal units outside the floor range</th></tr></thead>
                    <tbody>${covs.map(v => {
                        const s = r.stats[v.id], rng = x => (x.n ? `${vfmt(x.min, v)} to ${vfmt(x.max, v)}` : '—');
                        const n = v.range_check === false ? null : units.filter(u => u.metrics[v.id]?.outside?.floor).length;
                        return `<tr><td>${escapeHtml(v.label)}</td><td>${rng(s.focal)}</td><td>${rng(s.floor)}</td><td>${rng(s.ceiling)}</td><td>${n == null ? 'not checked' : `${n} of ${units.length}`}</td></tr>`;
                    }).join('')}</tbody>
                </table></div>
            </div>` : ''}

            <details class="card details-card">
                <summary><h3>Detailed scores</h3></summary>
                <p class="card-blurb">The values behind the ratings. The position is 0% at the ${escapeHtml(floorRole?.label.toLowerCase() || 'floor')} median and 100% at the ${escapeHtml(ceilRole?.label.toLowerCase() || 'ceiling')} median. The percentile is the share of a set's units below the focal value, so 50 is that set's median. The contrast is the percentage difference from the floor median, the arithmetic of the Wallacea Trust avoided-loss pathway, and the retention is the focal value as a share of the ceiling median. Figures for the focal set use the median of the focal units on each metric.</p>
                <div class="table-wrap"><table class="cmp-table">
                    <thead><tr><th>Metric</th><th>Focal median</th><th>${escapeHtml(floorRole?.label || 'Floor')} median</th><th>${escapeHtml(ceilRole?.label || 'Ceiling')} median</th><th>Position</th><th title="Percentile among floor units, direction-adjusted">Floor percentile</th><th title="Percentile among ceiling units, direction-adjusted">Ceiling percentile</th><th>Contrast</th><th>Retention</th></tr></thead>
                    <tbody>${scored.map(v => {
                        const s = r.stats[v.id], m = r.set.metrics[v.id] || {};
                        return `<tr class="${s.separates ? '' : 'muted'}"><td>${escapeHtml(v.label)}${v.dir === -1 ? ' <span class="dir" title="Lower is better">↓</span>' : ''}${lic(v)}</td>
                            <td>${vfmt(s.focal.median, v)}</td><td>${vfmt(s.floor.median, v)}</td><td>${vfmt(s.ceiling.median, v)}</td>
                            <td>${s.separates ? posChip(m.position) : 'not used'}</td>
                            <td>${pctTxt(m.floorPct)}</td><td>${pctTxt(m.ceilPct)}</td><td>${contrastTxt(m.contrast)}</td><td>${retTxt(m.retention)}</td></tr>`;
                    }).join('')}</tbody>
                </table></div>
                <div class="strip-legend">
                    <span><i style="background:${floorRole?.color}"></i>${escapeHtml(floorRole?.label || 'Floor')} units, above the axis</span>
                    <span><i style="background:${ceilRole?.color}"></i>${escapeHtml(ceilRole?.label || 'Ceiling')} units, below</span>
                    <span><i class="dm" style="background:${this.focalRole.color}"></i>${escapeHtml(this.focalRole.label)}</span>
                </div>
                <div id="strip-scored"></div>
                <div class="table-wrap"><table class="cmp-table units-table">
                    <thead><tr><th>Name</th><th>Area</th><th>Position</th><th>Floor percentile</th><th>Contrast</th><th>Retention</th>${covs.length ? '<th>Covariates outside the floor range</th>' : ''}</tr></thead>
                    <tbody>${units.map(u => {
                        const fe = this.sets.focal.editor.units.find(x => x.id === u.id);
                        const out = covs.filter(v => u.metrics[v.id]?.outside?.floor).map(v => v.label);
                        return `<tr data-id="${u.id}" class="${this.highlight === u.id ? 'on' : ''}"><td>${escapeHtml(this.focalName(u.id))}</td><td>${fe ? fmtHa(fe.ha) : '—'}</td>
                            <td>${posChip(this.headline(u).median)}${this.headline(u).loo ? `<span class="loo"> ${posTxt(this.headline(u).loo[0])} to ${posTxt(this.headline(u).loo[1])}</span>` : ''}</td>
                            <td>${pctTxt(u.basket.floorPct.median)}</td><td>${contrastTxt(u.basket.contrast.median)}</td>
                            <td>${retTxt(u.basket.retention.median)}</td>${covs.length ? `<td>${out.length ? escapeHtml(out.join(', ')) : 'none'}</td>` : ''}</tr>`;
                    }).join('')}</tbody>
                </table></div>
                <div id="strip-covs"></div>
            </details>

            <div class="card">
                <div class="card-head"><h3>Methods</h3></div>
                <div class="method">
                    <p>Each polygon is a unit, represented by the H3 cells it covers: drawn and uploaded polygons at resolution 10 (about 1.5 ha), with a polygon smaller than one cell represented by the cell under an interior point. A unit's value on a metric is the area-weighted mean of the metric over its cells. ${this.cmp.strata ? `Units are split by ${escapeHtml(this.cmp.strata.label.toLowerCase())}; with the landscape set to the same ${escapeHtml(this.cmp.strata.plural || 'strata')}, only the parts of comparison units inside the focal units' ${escapeHtml(this.cmp.strata.plural || 'strata')} count.` : ''}</p>
                    <p>Each focal unit is placed on every metric between the medians of the two comparison sets: 0% at the median of the ${escapeHtml(floorRole?.label.toLowerCase() || 'floor')} (${escapeHtml(R.floorA)}) and 100% at the median of the ${escapeHtml(ceilRole?.label.toLowerCase() || 'ceiling')} (${escapeHtml(R.ceilA)}). The span is divided into five equal bands, ranks 1 to 5. This follows the Wallacea Trust methodology's structural metrics, where the gap between the project site and its reference site is divided into five equal quintiles, with the project site at Rank 1 and the reference site at Rank 5; here the floor stands where the project's baseline would and the ceiling where the reference site would, an adaptation the methodology does not itself define. A unit's rating is the band of its median position across the selected ${R.basis ? escapeHtml(this.themes.filter(t => R.basis.includes(t.id)).map(t => t.label.toLowerCase()).join(' and ')) + ' ' : ''}metrics${R.basis ? '; the other scored themes are rated the same way and shown beside it' : ''}. A metric is left out of the ratings when its floor and ceiling medians differ by less than 5% of the spread of both sets or of the medians themselves, or when the ceiling is not the better of the two.</p>
                    <p>For each focal unit and metric, the floor percentile is the share of floor units with a lower value plus half of those with an equal one, flipped for metrics where lower is better; the ceiling percentile is the same among ceiling units. The contrast is 100 × (V − M) ÷ M against the floor median M, and the retention is V ÷ C against the ceiling median C (reversed for metrics where lower is better). The basket summary is the median of each across the selected metrics. The focal set's figures use the median value of the focal units on each metric.</p>
                    ${[...new Set(r.vars.map(v => v.theme))].map(id => this.themes.find(t => t.id === id)).filter(t => t?.method).map(t => `<p><b>${escapeHtml(t.label)}.</b> ${escapeHtml(t.method)}</p>`).join('')}
                    <details><summary>SQL for each theme</summary>
                        <p class="step-help">{{UNITS}} is the relation of (grp, id, stratum, cell) rows built from the sets above; the full query sent to the server is shown last.</p>
                        ${this.data.sql.themes.map(t => `<h4>${escapeHtml(t.label)}</h4><pre>${escapeHtml(t.sql)}</pre>`).join('')}
                        <h4>{{UNITS}}</h4><pre>${escapeHtml(this.data.sql.UNITS)}</pre>
                    </details>
                </div>
            </div>`;

        const focalVals = units.map(u => ({ id: u.id, name: this.focalName(u.id), values: Object.fromEntries(r.vars.map(v => [v.id, u.metrics[v.id]?.value])) }));
        const strip = (sel, vars) => {
            const node = rep.querySelector(sel);
            if (node) renderCompareStrip(node, {
                variables: vars, stats: r.stats, focal: focalVals, highlight: this.highlight,
                colors: { floor: floorRole?.color || '#8a6d3b', ceiling: ceilRole?.color || '#1d6b44', focal: this.focalRole.color },
                labels: { floor: floorRole?.label || 'Floor', ceiling: ceilRole?.label || 'Ceiling' },
            });
        };
        strip('#strip-scored', scored);
        strip('#strip-covs', covs);
        rep.querySelector('[data-act=csv]').onclick = () => this.downloadCsv();
        rep.querySelectorAll('.rating-row').forEach(row => {
            const u = units.find(x => x.id === row.dataset.id);
            row.querySelectorAll('.sq').forEach(sq => {
                const v = rated.find(x => x.id === sq.dataset.v), m = u.metrics[v.id] || {};
                hover(sq, `<b>${escapeHtml(v.label)}</b>: ${vfmt(m.value, v)}<br>${escapeHtml(R.label(m.rank, m.position))} (${posTxt(m.position)} of the way)`);
            });
        });
        rep.querySelectorAll('.units-table tbody tr, .rating-row').forEach(tr => {
            tr.onclick = () => {
                this.highlight = this.highlight === tr.dataset.id ? null : tr.dataset.id;
                this.renderResults();
                this.drawUnits();
                const u = this.sets.focal.editor.units.find(x => x.id === this.highlight);
                if (u) this.mv.fitTo([u.geometry]);
            };
        });
    }

    downloadCsv() {
        const r = this.result;
        const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        const lines = [
            `# ${this.app.title || 'Comparison'}: ${this.country.name}; landscape: ${this.landscape}; ${this.compRoles.map(x => `${x.label}: ${this.setLabel(x)}`).join('; ')}; generated ${new Date().toISOString()}`,
            ['unit_id', 'name', 'unit_rating', 'variable', 'label', 'value', 'position', 'rank', 'floor_percentile', 'ceiling_percentile', 'contrast_pct', 'retention', 'outside_floor_range'].join(','),
        ];
        for (const u of r.units) for (const v of r.vars) {
            const m = u.metrics[v.id] || {};
            lines.push([u.id, this.focalName(u.id), this.headline(u).rank, v.id, v.label, m.value, m.position, m.rank, m.floorPct, m.ceilPct, m.contrast, m.retention, m.outside?.floor ?? ''].map(q).join(','));
        }
        const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `comparison-${this.country.id}.csv` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    /* ---------------------------------------------------------------- map */

    installMapLayers() {
        const m = this.mv.map;
        const empty = { type: 'FeatureCollection', features: [] };
        m.addSource('cmp-cells', { type: 'geojson', data: empty });
        m.addSource('cmp-units', { type: 'geojson', data: empty });
        m.addLayer({ id: 'cmp-cells-pt', type: 'circle', source: 'cmp-cells', maxzoom: 11, paint: { 'circle-radius': 2.2, 'circle-color': ['get', 'color'], 'circle-opacity': ['case', ['get', 'in'], 0.75, 0.15] } }, 'ref');
        m.addLayer({ id: 'cmp-cells-hex', type: 'fill', source: 'cmp-cells', minzoom: 11, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'in'], 0.45, 0.1] } }, 'ref');
        m.addLayer({ id: 'cmp-units-fill', type: 'fill', source: 'cmp-units', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'rated'], 0.8, 0.22] } });
        m.addLayer({ id: 'cmp-units-line', type: 'line', source: 'cmp-units', paint: { 'line-color': ['case', ['get', 'rated'], '#22201f', ['get', 'color']], 'line-width': ['case', ['get', 'on'], 3.5, 1.5] } });
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
        m.on('mousemove', 'cmp-units-fill', e => {
            const p = e.features[0]?.properties;
            if (p && !this.mv._drawing) popup.setLngLat(e.lngLat).setHTML(`<b>${escapeHtml(p.name)}</b><br>${escapeHtml(p.role)}`).addTo(m);
        });
        m.on('mouseleave', 'cmp-units-fill', () => popup.remove());
        this.drawUnits();
        this.drawPresets();
    }

    drawUnits() {
        const src = this.mv.map?.getSource('cmp-units');
        if (!src) return;
        const feats = [];
        for (const r of this.roles) {
            const set = this.sets[r.id];
            if (!set || set.mode !== 'custom') continue;
            for (const u of set.editor.units) {
                // after a run, focal units take the colour of their rating
                const scoredU = r.id === 'focal' ? this.result?.units.find(x => x.id === u.id) : null;
                const R = scoredU ? this.rating() : null;
                feats.push({ type: 'Feature', geometry: u.geometry, properties: {
                    name: u.name, role: scoredU ? `${r.singular || r.label}: ${R.label(this.headline(scoredU).rank, this.headline(scoredU).median)}` : r.singular || r.label,
                    color: scoredU ? R.color(this.headline(scoredU).rank) : r.color, rated: !!scoredU, on: this.highlight === u.id,
                } });
            }
        }
        src.setData({ type: 'FeatureCollection', features: feats });
        const lg = this.$('#map-legend');
        if (this.result) {
            const R = this.rating();
            lg.innerHTML = `<div class="legend-title">Rating</div>${R.labels.map((l, i) => `<div class="legend-row"><i style="background:${R.colors[i]}"></i>${escapeHtml(l)}</div>`).join('')}`;
            lg.hidden = false;
        } else lg.hidden = true;
    }

    /** Catalog presets on the map: single-cell units from their ids, tile-set units through a filter. */
    async drawPresets() {
        const m = this.mv.map;
        if (!m?.getSource('cmp-cells')) return;
        const feats = [];
        const want = new Set();
        for (const r of this.compRoles) {
            const p = presetsFor(r, this.country.id).find(x => x.id === this.sets[r.id].mode);
            if (!p) continue;
            const file = await this.baselineFile(p);
            if (!file) continue;
            const inView = this.result?.inView?.[r.id];
            if (p.map?.pmtiles) {
                want.add(p.id);
                this.showTileUnits(r, p, Object.keys(file.units), inView);
                continue;
            }
            if (typeof h3 === 'undefined') continue;
            for (const id of Object.keys(file.units)) {
                const hex = BigInt(id).toString(16);
                const isIn = !inView || inView.has(id);
                const [lat, lng] = h3.cellToLatLng(hex);
                feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { color: r.color, in: isIn } });
                feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [h3.cellToBoundary(hex, true)] }, properties: { color: r.color, in: isIn } });
            }
        }
        m.getSource('cmp-cells').setData({ type: 'FeatureCollection', features: feats });
        for (const id of this._tileLayers || []) if (!want.has(id)) for (const l of [`cmp-tile-${id}-fill`, `cmp-tile-${id}-line`]) if (m.getLayer(l)) m.setLayoutProperty(l, 'visibility', 'none');
    }

    showTileUnits(role, p, ids, inView) {
        const m = this.mv.map;
        const src = `cmp-tile-${p.id}`;
        (this._tileLayers ??= new Set()).add(p.id);
        if (!m.getSource(src)) {
            m.addSource(src, { type: 'vector', url: `pmtiles://${p.map.pmtiles}` });
            m.addLayer({ id: `${src}-fill`, type: 'fill', source: src, 'source-layer': p.map.source_layer, paint: { 'fill-color': role.color, 'fill-opacity': 0.14 } }, 'ref');
            m.addLayer({ id: `${src}-line`, type: 'line', source: src, 'source-layer': p.map.source_layer, paint: { 'line-color': role.color, 'line-width': 1, 'line-opacity': 0.7 } }, 'ref');
            const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
            m.on('mousemove', `${src}-fill`, e => {
                const pr = e.features[0]?.properties;
                if (pr && !this.mv._drawing) popup.setLngLat(e.lngLat).setHTML(`<b>${escapeHtml(pr[p.map.name_prop || 'NAME_ENG'] || '')}</b><br>${escapeHtml(role.singular || role.label)}`).addTo(m);
            });
            m.on('mouseleave', `${src}-fill`, () => popup.remove());
        }
        const show = inView ? ids.filter(id => inView.has(id)) : ids;
        const num = show.map(Number).filter(Number.isFinite);
        const filter = ['in', ['to-number', ['get', p.map.id_prop]], ['literal', num]];
        for (const l of [`${src}-fill`, `${src}-line`]) { m.setFilter(l, filter); m.setLayoutProperty(l, 'visibility', 'visible'); }
    }

    showHint(text) { const h = this.$('#map-hint'); h.textContent = text; h.hidden = false; }
    hideHint() { this.$('#map-hint').hidden = true; }

    wireResize() {
        const side = this.$('#sidebar'), grip = this.$('.sidebar-resize');
        let x0 = 0, w0 = 0;
        const move = e => { side.style.width = `${Math.max(320, Math.min(window.innerWidth - 240, w0 + x0 - e.clientX))}px`; this.mv.map.resize(); };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        grip.addEventListener('pointerdown', e => { x0 = e.clientX; w0 = side.offsetWidth; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); });
    }
}

/**
 * Default rating scale: a diverging brown-to-green ramp with a grey midpoint,
 * checked for colour-blind separation of adjacent bands; every band also
 * carries its label, so colour is never the only cue.
 */
const RATING_COLORS = ['#8c4a12', '#d39a5c', '#dedad2', '#7cb87f', '#2f6f3e'];
const RATING_LABELS = ['Like {floor}', 'A little better than {floor}', 'Halfway to {ceiling}', 'Close to {ceiling}', 'As good as {ceiling}'];

function fitGeoms(map, geoms) {
    const b = new maplibregl.LngLatBounds();
    const walk = c => (typeof c[0] === 'number' ? b.extend(c) : c.forEach(walk));
    geoms.forEach(g => walk(g.coordinates));
    if (!b.isEmpty()) map.fitBounds(b, { padding: 60, duration: 700, maxZoom: 14 });
}

async function fetchJson(url) {
    try {
        const r = await fetch(url, { cache: 'no-cache' });
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

export const compareCss = `
.compare-controls { max-height: 55%; overflow-y: auto; }
.compare-controls.collapsed .step { display: none; }
.controls-summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--text-2); }
#country-select { width: 100%; padding: 7px 9px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--card-bg); }
.unit-list { list-style: none; margin: 6px 0 0; padding: 0; max-height: 180px; overflow-y: auto; }
.unit-list li { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.unit-list .swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--c); flex: none; }
.unit-list .unit-name { flex: 1 1 auto; min-width: 0; border: 1px solid transparent; border-radius: 4px; padding: 2px 4px; background: transparent; }
.unit-list .unit-name:hover, .unit-list .unit-name:focus { border-color: var(--line-strong); background: var(--card-bg); }
.unit-list .unit-area { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.unit-list .unit-del { border: none; background: none; cursor: pointer; color: var(--text-3); font-size: 16px; line-height: 1; padding: 0 4px; }
.unit-list .unit-del:hover { color: var(--danger); }
.ghost-btn.active { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
.set-mode { margin-bottom: 4px; }
.metric-group { border: 1px solid var(--line); border-left: 3px solid var(--c); border-radius: 8px; padding: 4px 10px 8px; margin: 0 0 8px; }
.metric-group legend { font-size: 12.5px; font-weight: 650; padding: 0 4px; }
.metric { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 1px 0; cursor: pointer; }
.licence { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #8a4b00; background: #fdf0dc; border-radius: 4px; padding: 0 4px; }
.run-row { display: flex; align-items: center; gap: 10px; }
.run-btn { background: var(--primary); color: var(--on-primary); border: none; border-radius: 8px; padding: 8px 18px; font-weight: 650; cursor: pointer; }
.run-btn:disabled { opacity: .55; cursor: progress; }
.lede { color: var(--text-2); margin: 0 0 12px; }
.note-card { background: #fff7e6; border: 1px solid #f1d29b; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 13px; }
.table-wrap { overflow-x: auto; margin-bottom: 10px; }
.cmp-table { border-collapse: collapse; width: 100%; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.cmp-table th { text-align: right; font-weight: 600; color: var(--text-2); border-bottom: 1px solid var(--line-strong); padding: 4px 6px; vertical-align: bottom; }
.cmp-table td { text-align: right; border-bottom: 1px solid var(--line); padding: 4px 6px; }
.cmp-table th:first-child, .cmp-table td:first-child { text-align: left; }
.cmp-table .dir { color: var(--text-3); }
.cmp-table .loo { display: block; font-size: 11px; color: var(--text-3); }
.units-table tbody tr { cursor: pointer; }
.units-table tbody tr:hover { background: var(--hover); }
.units-table tbody tr.on { background: var(--primary-wash); }
.strip-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--text-2); margin: 4px 0 2px; }
.strip-legend i { display: inline-block; width: 12px; height: 8px; margin-right: 5px; opacity: .6; }
.strip-legend i.dm { width: 8px; height: 8px; transform: rotate(45deg); opacity: 1; }
.method p { color: var(--text-2); font-size: 13px; margin: 0 0 8px; }
.rating-summary { font-size: 15px; margin: 2px 0 10px; }
.rating-scale { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11.5px; color: var(--text-2); margin-bottom: 10px; }
.rating-scale i, #map-legend i { display: inline-block; width: 11px; height: 11px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.rating-row { padding: 10px 8px; border-top: 1px solid var(--line); cursor: pointer; border-radius: 6px; }
.rating-row:hover { background: var(--hover); }
.rating-row.on { background: var(--primary-wash); }
.rating-head { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; }
.rank-badge { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; font-weight: 700; font-size: 16px; flex: none; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.farm-name { font-weight: 650; font-size: 14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rating-label { margin-left: auto; font-size: 13.5px; font-weight: 600; color: var(--text-2); text-align: right; }
.rating-track { position: relative; display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; height: 10px; }
.rating-track span { border-radius: 2px; opacity: .85; }
.rating-track .marker { position: absolute; top: -5px; width: 4px; height: 20px; margin-left: -2px; background: #22201f; border-radius: 2px; box-shadow: 0 0 0 2px #fff; }
.rating-track .marker.below::before, .rating-track .marker.beyond::before { position: absolute; top: 2px; font-size: 11px; font-style: normal; color: #22201f; }
.rating-track .marker.below::before { content: '◀'; left: -12px; }
.rating-track .marker.beyond::before { content: '▶'; left: 6px; }
.track-ends { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-3); margin-top: 3px; }
.sq-row { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 6px; }
.sq-group { display: flex; align-items: center; gap: 3px; }
.sq-label { font-size: 11px; color: var(--text-3); margin-right: 4px; }
.sq { width: 14px; height: 14px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); }
.pos-chip { display: inline-block; min-width: 46px; text-align: center; border-radius: 4px; padding: 0 5px; font-weight: 600; }
.cmp-table tr.muted td { color: var(--text-3); }
.details-card > summary { cursor: pointer; list-style: revert; }
.details-card > summary h3 { display: inline; font-size: 15px; margin: 0; }
#map-legend { font-size: 12px; padding: 6px 8px; }
#map-legend .legend-title { font-weight: 650; margin-bottom: 3px; }
#map-legend .legend-row { display: flex; align-items: center; gap: 2px; margin: 2px 0; white-space: nowrap; }
.method pre { background: var(--code-bg); padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 11.5px; max-height: 320px; }
.method h4 { margin: 10px 0 4px; font-size: 13px; }
`;
