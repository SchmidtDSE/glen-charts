/**
 * Leaderboard: every area of one type in rank order by a combined score that
 * the reader can re-weight. It reads only precomputed all-areas results
 * (`precompute results`) and runs nothing live.
 *
 * Scoring happens here, from each variable's raw value and direction, so it
 * can change without a query:
 *   variable percentile  mid-rank of dir × value among the areas in view,
 *                        0–100 (ties share the midpoint of their rank range).
 *                        Reversing a variable negates dir. With every area in
 *                        view and nothing changed this equals the SQL's `pct`.
 *   pillar score         weighted mean of its variables' percentiles
 *   overall              weighted mean of the pillar scores
 * Each pillar's query must return one row per (area, variable) with the
 * columns variable, label, value, dir (+1 or −1), and optionally fmt, unit.
 *
 * app.json:
 *   "leaderboard": {
 *     "jurisdiction": "ecoregion",                 area type (default: the first)
 *     "tab": "Leaderboard", "profile_tab": "Profile", "default": true to land on it,
 *     "title", "intro" (HTML),
 *     "pillars": [{ "theme": "carbon", "query": "carbon", "weight": 1,
 *                   "variables": { "<variable>": { "weight": 0 to switch off by default, "reverse": true } } }],
 *     "overall": { "label": "Overall", "note": "…" },
 *     "scope": { "theme": "priority", "query": "priority", "field": "priority_share", "min": 0.5,
 *                "detail_field"?, "label": "Priority countries", "global_label": "Global", "column"?: "Priority", "note"? },
 *     "map": { "label": "Overall score", "ramp": [colours] }
 *   }
 *
 * Reader changes are kept as a compact string (see stateString) that the
 * explorer puts in the URL, so a re-weighted view is a shareable link.
 */

import { fmt, escapeHtml, isMissing } from './format.js';
import { hover } from './charts.js';

const MAX_W = 3;

export class Leaderboard {
    /**
     * ctx: { engine, spec, jur, onShow(feature), onOpen(feature), onHover(id|null),
     *        onScores({ rows, inScope }), onChange() }
     */
    constructor(el, ctx) {
        Object.assign(this, { el, ctx });
        this.spec = ctx.spec;
        this.jur = ctx.jur;
        this.data = null;
        this.sort = { key: 'rank', dir: 1 };
        this.q = '';
        this.focusId = null;
        this.state = defaultState(this.spec);
        this.token = 0;
    }

    /* ------------------------------------------------------------ state */

    /** Non-default settings as "scope=priority;carbon=2;carbon.irrecoverable_mt=-1;…" ('' when default). */
    stateString() {
        const d = defaultState(this.spec);
        const s = this.state;
        const parts = [];
        if (s.scope !== d.scope) parts.push(`scope=${s.scope}`);
        for (const [t, w] of Object.entries(s.pillars)) if (w !== d.pillars[t]) parts.push(`${t}=${w}`);
        for (const [k, v] of Object.entries(s.vars)) {
            const dv = d.vars[k] || { w: 1, rev: false };
            if (v.w !== dv.w || v.rev !== dv.rev) parts.push(`${k}=${v.rev ? '-' : ''}${v.w}`);
        }
        return parts.join(';');
    }

    setStateString(str) {
        this.state = defaultState(this.spec);
        for (const part of String(str || '').split(';').filter(Boolean)) {
            const [k, v] = part.split('=');
            if (k === 'scope') { if (v === 'priority' || v === 'global') this.state.scope = v; continue; }
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            if (k.includes('.')) this.state.vars[k] = { w: clampW(Math.abs(n)), rev: v.startsWith('-') };
            else this.state.pillars[k] = clampW(n);
        }
        if (this.data) for (const [k, v] of Object.entries(fillVars(this.data, this.spec))) this.state.vars[k] ??= v;
    }

    /* ------------------------------------------------------------- data */

    async load(params, paramNote = '') {
        const token = ++this.token;
        this.params = params;
        this.paramNote = paramNote;
        this.renderShell();
        try {
            const data = await loadData(this.ctx.engine, this.spec, this.jur, params);
            if (token !== this.token) return;
            this.data = data;
            // variables seen for the first time get their default settings
            for (const p of data.pillars) for (const v of p.variables) {
                this.state.vars[v.key] ??= { ...defaultVar(this.spec, p.theme.id, v.variable) };
            }
            this.renderBody();
        } catch (err) {
            if (token !== this.token) return;
            this.el.querySelector('.lb-card').innerHTML = `<div class="err">Could not build the leaderboard: ${escapeHtml(err.message)}</div>`;
            console.error(err);
        }
    }

    /** Scores for the current state, and for the default state in the same scope (for rank changes). */
    compute() {
        const cur = score(this.data, this.state, this.spec);
        const def = score(this.data, { ...defaultState(this.spec), scope: this.state.scope, vars: fillVars(this.data, this.spec) }, this.spec);
        const defRank = new Map(def.rows.map(r => [r.id, r.rank]));
        for (const r of cur.rows) {
            const d = defRank.get(r.id);
            r.delta = r.rank && d ? d - r.rank : 0;
        }
        return cur;
    }

    /* ----------------------------------------------------------- render */

    renderShell() {
        const { spec, jur } = this;
        const peers = jur.peer_label || jur.label.toLowerCase();
        this.el.innerHTML = `
            <div class="report-head">
                <div>
                    <div class="kind">${escapeHtml(jur.label)}${this.paramNote ? ` · ${escapeHtml(this.paramNote)}` : ''}</div>
                    <h2>${escapeHtml(spec.title || `All ${peers}, ranked`)}</h2>
                </div>
                <div class="head-actions">
                    <button class="ghost-btn" id="lb-csv" type="button" title="Download the table as CSV" disabled>CSV</button>
                    <button class="ghost-btn" id="copy-link" type="button" title="Copy a link to this view, scoring included">Copy link</button>
                </div>
            </div>
            ${spec.intro ? `<div class="lb-intro">${spec.intro}</div>` : ''}
            <div class="lb-scope"></div>
            <details class="card lb-scoring" open><summary>Scoring</summary><div class="lb-scoring-body"></div></details>
            <div class="card lb-card"><div class="skeleton" style="height:240px"></div></div>`;
        this.el.querySelector('#copy-link').onclick = async () => {
            try { await navigator.clipboard.writeText(location.href); this.el.querySelector('#copy-link').textContent = 'Copied'; } catch { /* ignore */ }
        };
    }

    renderBody() {
        this.renderScope();
        this.renderScoring();
        this.renderTable();
    }

    renderScope() {
        const sc = this.spec.scope;
        const box = this.el.querySelector('.lb-scope');
        if (!sc) { box.hidden = true; return; }
        const nIn = this.data.rows.filter(r => r.inScope).length;
        box.innerHTML = `
            <div class="seg" role="radiogroup" aria-label="Scope">
                <button type="button" role="radio" data-scope="global" aria-checked="${this.state.scope === 'global'}">${escapeHtml(sc.global_label || 'Global')} <small>${this.data.rows.length}</small></button>
                <button type="button" role="radio" data-scope="priority" aria-checked="${this.state.scope === 'priority'}" ${this.data.scopeMissing ? 'disabled title="Not precomputed at this setting"' : ''}>${escapeHtml(sc.label || 'Priority')} <small>${nIn}</small></button>
            </div>
            ${this.state.scope === 'priority' && sc.note ? `<p class="tile-note">${escapeHtml(sc.note)}</p>` : ''}`;
        box.querySelectorAll('button').forEach(b => {
            b.onclick = () => { this.state.scope = b.dataset.scope; this.changed(); this.renderScope(); };
        });
    }

    renderScoring() {
        const body = this.el.querySelector('.lb-scoring-body');
        const s = this.state;
        body.innerHTML = `
            <p class="tile-note">Weights run from 0 (left out) to ${MAX_W}×. Open a pillar to switch its variables on or off, weight them, or reverse which direction counts as better.</p>
            ${this.data.pillars.map(p => `
                <div class="lb-pillar" style="--c:${p.color}">
                    <div class="lb-prow">
                        <button type="button" class="lb-expand" aria-expanded="false" title="Show this pillar's variables"><span class="caret">▸</span><span class="dot"></span>${escapeHtml(p.label)}</button>
                        ${slider(`p:${p.theme.id}`, s.pillars[p.theme.id])}
                    </div>
                    <div class="lb-vars" hidden>
                        ${p.variables.map(v => {
                            const vs = s.vars[v.key];
                            return `<div class="lb-vrow${vs.w === 0 ? ' off' : ''}">
                                <label><input type="checkbox" data-on="${escapeHtml(v.key)}" ${vs.w > 0 ? 'checked' : ''}> ${escapeHtml(v.label)}</label>
                                ${slider(`v:${v.key}`, vs.w)}
                                <button type="button" class="lb-rev" data-rev="${escapeHtml(v.key)}" aria-pressed="${vs.rev}" title="${escapeHtml(dirText(v, !vs.rev))}. Click to reverse.">${vs.rev ? '⇅ reversed' : '⇅'}</button>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`).join('')}
            <div class="lb-scoring-foot"><button type="button" class="ghost-btn" id="lb-reset" ${this.stateString().replace(/(^|;)scope=\w+/, '') ? '' : 'disabled'}>Reset scoring</button></div>`;
        body.querySelectorAll('.lb-expand').forEach(b => {
            b.onclick = () => {
                const open = b.getAttribute('aria-expanded') !== 'true';
                b.setAttribute('aria-expanded', String(open));
                b.closest('.lb-pillar').querySelector('.lb-vars').hidden = !open;
            };
        });
        body.querySelectorAll('input[type=range]').forEach(inp => {
            const out = inp.nextElementSibling;
            inp.oninput = () => {
                const w = Number(inp.value);
                out.textContent = wText(w);
                const [kind, key] = splitKey(inp.dataset.key);
                if (kind === 'p') s.pillars[key] = w;
                else {
                    s.vars[key].w = w;
                    const row = inp.closest('.lb-vrow');
                    row.classList.toggle('off', w === 0);
                    row.querySelector('input[type=checkbox]').checked = w > 0;
                }
                this.changed();
            };
        });
        body.querySelectorAll('input[data-on]').forEach(cb => {
            cb.onchange = () => {
                const v = s.vars[cb.dataset.on];
                v.w = cb.checked ? (v.lastW || 1) : 0;
                if (!cb.checked) v.lastW = Number(cb.closest('.lb-vrow').querySelector('input[type=range]').value) || 1;
                this.changed();
                this.rerenderScoringKeepOpen();
            };
        });
        body.querySelectorAll('[data-rev]').forEach(b => {
            b.onclick = () => { const v = s.vars[b.dataset.rev]; v.rev = !v.rev; this.changed(); this.rerenderScoringKeepOpen(); };
        });
        body.querySelector('#lb-reset').onclick = () => {
            const scope = s.scope;
            this.state = defaultState(this.spec);
            this.state.scope = scope;
            this.state.vars = fillVars(this.data, this.spec);
            this.changed();
            this.renderScoring();
        };
    }

    rerenderScoringKeepOpen() {
        const open = [...this.el.querySelectorAll('.lb-expand')].map(b => b.getAttribute('aria-expanded') === 'true');
        this.renderScoring();
        this.el.querySelectorAll('.lb-expand').forEach((b, i) => { if (open[i]) b.click(); });
    }

    changed() {
        this.renderTable();
        const reset = this.el.querySelector('#lb-reset');
        if (reset) reset.disabled = !this.stateString().replace(/(^|;)scope=\w+/, '');
        this.ctx.onChange?.();
    }

    renderTable() {
        const card = this.el.querySelector('.lb-card');
        const { spec, jur } = this;
        const res = this.result = this.compute();
        const rows = res.rows;
        const pillars = this.data.pillars;
        const sc = spec.scope;
        const overallLabel = spec.overall?.label || 'Overall';
        const peers = jur.peer_label || jur.label.toLowerCase();
        this.ctx.onScores?.(res);
        const hadSearch = card.querySelector('.lb-search');
        if (!hadSearch) {
            card.innerHTML = `
                ${this.data.missing.length ? `<p class="err">Not precomputed at this setting: ${escapeHtml(this.data.missing.join(', '))}.</p>` : ''}
                <div class="lb-tools">
                    <input type="search" class="lb-search" placeholder="Filter by name…" aria-label="Filter by name">
                    <span class="lb-count"></span>
                </div>
                <div class="lb-scroll"><table class="lb-table">
                    <thead><tr>
                        <th data-sort="rank" class="num">#</th>
                        <th data-sort="delta" class="num" title="Change in rank from the default scoring">±</th>
                        <th data-sort="name">${escapeHtml(jur.singular || 'Name')}</th>
                        <th data-sort="overall" class="num">${escapeHtml(overallLabel)}</th>
                        ${pillars.map(p => `<th data-sort="p:${escapeHtml(p.theme.id)}" class="num" style="--c:${p.color}"><span class="dot"></span>${escapeHtml(p.label)}</th>`).join('')}
                        ${sc ? `<th data-sort="share" class="num" title="${escapeHtml(sc.note || '')}">${escapeHtml(sc.column || sc.label || 'Scope')}</th>` : ''}
                        <th aria-label="Profile"></th>
                    </tr></thead>
                    <tbody></tbody>
                </table></div>
                <p class="tile-note lb-note"></p>`;
            card.querySelectorAll('th[data-sort]').forEach(th => {
                th.onclick = () => {
                    const k = th.dataset.sort;
                    if (this.sort.key === k) this.sort.dir = -this.sort.dir;
                    else this.sort = { key: k, dir: k === 'rank' || k === 'name' ? 1 : -1 };
                    this.drawRows();
                };
            });
            card.querySelector('.lb-search').oninput = e => { this.q = e.target.value; this.drawRows(); };
            const tbody = card.querySelector('tbody');
            tbody.addEventListener('click', e => {
                const tr = e.target.closest('tr');
                const r = tr && this.byId.get(tr.dataset.id);
                if (!r) return;
                if (e.target.closest('.lb-open')) this.ctx.onOpen?.(r.feature);
                else { this.focus(r.id, { scroll: false }); this.ctx.onShow?.(r.feature); }
            });
            tbody.addEventListener('keydown', e => {
                const tr = e.target.closest('tr');
                const r = tr && this.byId.get(tr.dataset.id);
                if (r && e.key === 'Enter') { this.focus(r.id, { scroll: false }); this.ctx.onShow?.(r.feature); }
            });
            tbody.addEventListener('mouseover', e => { const tr = e.target.closest('tr'); if (tr) this.ctx.onHover?.(tr.dataset.id); });
            tbody.addEventListener('mouseleave', () => this.ctx.onHover?.(null));
            const csv = this.el.querySelector('#lb-csv');
            csv.disabled = false;
            csv.onclick = () => downloadCsv(this);
        }
        card.querySelector('.lb-search').placeholder = `Filter ${res.inView} ${peers}…`;
        card.querySelector('.lb-note').textContent =
            `${spec.overall?.note || `${overallLabel}: weighted mean of the pillar scores.`}` +
            `${rows.some(r => r.partial && r.inView) ? ' * Some pillars have no data here; the overall score uses those present.' : ''}` +
            ` Click a name to see it on the map; › opens its ${(spec.profile_tab || 'profile').toLowerCase()}.`;
        this.byId = new Map(rows.map(r => [r.id, r]));
        this.drawRows();
    }

    drawRows() {
        const card = this.el.querySelector('.lb-card');
        const tbody = card.querySelector('tbody');
        const { rows } = this.result;
        const pillars = this.data.pillars;
        const sc = this.spec.scope;
        const q = this.q.trim().toLowerCase();
        const shown = rows.filter(r => r.inView && (!q || String(r.name).toLowerCase().includes(q)));
        const val = (r, k) => k === 'rank' ? (r.rank ?? Infinity) : k === 'name' ? r.name : k === 'overall' ? r.overall
            : k === 'delta' ? r.delta : k === 'share' ? r.share : r.pillars[k.slice(2)];
        const { key, dir } = this.sort;
        shown.sort((a, b) => {
            const va = val(a, key), vb = val(b, key);
            if (va === vb) return (a.rank ?? Infinity) - (b.rank ?? Infinity);
            if (va === null || va === undefined) return 1;
            if (vb === null || vb === undefined) return -1;
            return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
        });
        tbody.innerHTML = shown.map(r => `
            <tr data-id="${escapeHtml(r.id)}" tabindex="0" class="${r.id === this.focusId ? 'focus' : ''}">
                <td class="num rank">${r.rank ?? ''}</td>
                <td class="num delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}">${r.delta > 0 ? '↑' + r.delta : r.delta < 0 ? '↓' + -r.delta : ''}</td>
                <td class="name"><button type="button" class="lb-name" title="Show on the map">${escapeHtml(r.name)}</button></td>
                <td class="num overall"><b>${fmt(r.overall, 'num1')}</b>${r.partial && r.overall !== null ? '*' : ''}</td>
                ${pillars.map(p => bar(r.pillars[p.theme.id], p.color)).join('')}
                ${sc ? shareCell(r, sc) : ''}
                <td class="open"><button type="button" class="lb-open" title="Open ${escapeHtml((this.spec.profile_tab || 'profile').toLowerCase())}">›</button></td>
            </tr>`).join('');
        card.querySelector('.lb-count').textContent = shown.length === this.result.inView ? '' : `${shown.length} of ${this.result.inView}`;
        card.querySelectorAll('th').forEach(th => {
            th.removeAttribute('aria-sort');
            if (th.dataset.sort === key) th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
        });
        tbody.querySelectorAll('[data-tip]').forEach(n => hover(n, n.dataset.tip));
    }

    /** Mark an area's row (e.g. after a map click) and scroll it into view. */
    focus(id, { scroll = true } = {}) {
        this.focusId = id == null ? null : String(Number.isFinite(Number(id)) ? Number(id) : id);
        const tbody = this.el.querySelector('.lb-card tbody');
        if (!tbody) return;
        tbody.querySelectorAll('tr.focus').forEach(tr => tr.classList.remove('focus'));
        const tr = this.focusId && tbody.querySelector(`tr[data-id="${CSS.escape(this.focusId)}"]`);
        if (!tr) {
            const r = this.byId?.get(this.focusId);
            if (r && !r.inView) this.flashNote(`${r.name} is not in the ${this.spec.scope?.label || 'current'} list.`);
            else if (r && this.q) { this.q = ''; this.el.querySelector('.lb-search').value = ''; this.drawRows(); return this.focus(id, { scroll }); }
            return;
        }
        tr.classList.add('focus');
        if (scroll) tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    flashNote(text) {
        const c = this.el.querySelector('.lb-count');
        if (c) { c.textContent = text; setTimeout(() => this.drawRows(), 2500); }
    }

    /** One-line popup text for the map: "Overall 61.2 · #23 of 219". */
    popupFor(id) {
        const r = this.byId?.get(String(Number.isFinite(Number(id)) ? Number(id) : id));
        if (!r) return '';
        if (!r.inView) return `<br><span style="opacity:.7">Not in the ${escapeHtml(this.spec.scope?.label || 'current')} list</span>`;
        return `<br>${escapeHtml(this.spec.overall?.label || 'Overall')} ${fmt(r.overall, 'num1')} · #${r.rank} of ${this.result.ranked}`;
    }
}

/* ------------------------------------------------------------- scoring */

function defaultState(spec) {
    const pillars = {}, vars = {};
    for (const p of spec.pillars || []) {
        pillars[p.theme] = clampW(p.weight ?? 1);
        for (const [v, o] of Object.entries(p.variables || {})) vars[`${p.theme}.${v}`] = { w: clampW(o.weight ?? 1), rev: !!o.reverse };
    }
    return { scope: 'global', pillars, vars };
}

function defaultVar(spec, theme, variable) {
    const o = spec.pillars?.find(p => p.theme === theme)?.variables?.[variable] || {};
    return { w: clampW(o.weight ?? 1), rev: !!o.reverse };
}

function fillVars(data, spec) {
    const vars = {};
    for (const p of data.pillars) for (const v of p.variables) vars[v.key] = defaultVar(spec, p.theme.id, v.variable);
    return vars;
}

async function loadData(engine, spec, jur, params) {
    const themes = engine.config.themeById;
    const aoi = { kind: jur.id, params };
    const pillarSpecs = (spec.pillars || []).map(p => {
        const theme = themes[p.theme];
        if (!theme) throw new Error(`Leaderboard: unknown theme "${p.theme}"`);
        return { ...p, theme, query: p.query || Object.keys(theme.queries)[0] };
    });
    const sc = spec.scope;
    const scTheme = sc && themes[sc.theme];
    const [list, scopeRes, ...results] = await Promise.all([
        engine.listFeatures(jur, params),
        scTheme ? engine.allResults(scTheme, sc.query || Object.keys(scTheme.queries)[0], aoi) : null,
        ...pillarSpecs.map(p => engine.allResults(p.theme, p.query, aoi)),
    ]);
    const missing = pillarSpecs.filter((p, i) => !results[i]).map(p => p.label || p.theme.label);
    const get = (byId, id) => byId?.[id] ?? byId?.[String(Number(id))] ?? null;

    const pillars = pillarSpecs.map((p, i) => {
        const vars = new Map();
        for (const rows of Object.values(results[i] || {})) for (const r of rows) {
            if (!vars.has(r.variable)) vars.set(r.variable, { variable: r.variable, key: `${p.theme.id}.${r.variable}`, label: r.label || r.variable, unit: r.unit, fmt: r.fmt, dir: Number(r.dir) || 0 });
        }
        for (const v of vars.values()) if (!v.dir) throw new Error(`Leaderboard: ${p.theme.id} rows need a dir column (+1 or −1)`);
        return { theme: p.theme, query: p.query, label: p.label || p.theme.label, color: p.color || p.theme.color || 'var(--primary)', variables: [...vars.values()], byId: results[i] || {} };
    });

    const rows = list.map(f => {
        const id = String(f.id);
        const vals = {};
        for (const p of pillars) for (const r of get(p.byId, id) || []) vals[`${p.theme.id}.${r.variable}`] = isMissing(r.value) ? null : Number(r.value);
        const s = sc ? get(scopeRes, id)?.[0] : null;
        const share = s && !isMissing(s[sc.field]) ? Number(s[sc.field]) : null;
        return { id, name: f.name, feature: f, vals, share, detail: s && sc.detail_field ? s[sc.detail_field] : null, inScope: share !== null && share >= (sc?.min ?? 0.5) };
    }).filter(r => Object.values(r.vals).some(v => v !== null));
    return { pillars, rows, missing, scopeMissing: !!sc && !scopeRes };
}

/** Score every row under `state`; returns { rows, inView, ranked } with rows carrying pillars, overall, rank. */
export function score(data, state, spec) {
    const inView = r => state.scope !== 'priority' || r.inScope;
    const view = data.rows.filter(inView);
    const out = data.rows.map(r => ({ ...r, inView: inView(r), pillars: {}, pct: {}, overall: null, rank: null, partial: false }));
    const byId = new Map(out.map(r => [r.id, r]));
    for (const p of data.pillars) {
        for (const v of p.variables) {
            const vs = state.vars[v.key] || { w: 1, rev: false };
            const d = vs.rev ? -v.dir : v.dir;
            const pts = view.map(r => ({ id: r.id, x: r.vals[v.key] })).filter(o => o.x !== null && o.x !== undefined).map(o => ({ id: o.id, x: d * o.x }));
            for (const [id, pct] of midRank(pts)) byId.get(id).pct[v.key] = pct;
        }
    }
    for (const r of out) {
        if (!r.inView) continue;
        let sum = 0, w = 0, want = 0, have = 0;
        for (const p of data.pillars) {
            let ps = 0, pw = 0;
            for (const v of p.variables) {
                const vw = state.vars[v.key]?.w ?? 1;
                const x = r.pct[v.key];
                if (!vw || x === undefined) continue;
                ps += x * vw; pw += vw;
            }
            const score = pw ? ps / pw : null;
            r.pillars[p.theme.id] = score;
            const W = state.pillars[p.theme.id] ?? 1;
            if (!W) continue;
            want++;
            if (score === null) continue;
            sum += score * W; w += W; have++;
        }
        r.overall = w ? sum / w : null;
        r.partial = have < want;
    }
    const ranked = out.filter(r => r.inView && r.overall !== null).sort((a, b) => b.overall - a.overall);
    ranked.forEach((r, i) => { r.rank = i && r.overall === ranked[i - 1].overall ? ranked[i - 1].rank : i + 1; });
    return { rows: out, inView: view.length, ranked: ranked.length };
}

/** Mid-rank percentiles, 0–100, rounded to 0.1 like the SQL: Map id → pct. */
export function midRank(pts) {
    const out = new Map();
    const n = pts.length;
    if (!n) return out;
    pts.sort((a, b) => a.x - b.x);
    for (let i = 0; i < n;) {
        let j = i;
        while (j + 1 < n && pts[j + 1].x === pts[i].x) j++;
        const pct = n > 1 ? Math.round(1000 * (i + j) / 2 / (n - 1)) / 10 : null;
        for (let k = i; k <= j; k++) out.set(pts[k].id, pct);
        i = j + 1;
    }
    return out;
}

/* ------------------------------------------------------------- helpers */

const clampW = w => Math.max(0, Math.min(MAX_W, Math.round(Number(w) * 4) / 4)) || 0;
const wText = w => (w === 0 ? 'off' : `${w}×`);
const splitKey = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };
const dirText = (v, normal) => ((normal ? v.dir : -v.dir) > 0 ? 'Higher values score higher' : 'Lower values score higher');

function slider(key, w) {
    return `<span class="lb-w"><input type="range" min="0" max="${MAX_W}" step="0.25" value="${w}" data-key="${escapeHtml(key)}" aria-label="Weight"><output>${wText(w)}</output></span>`;
}

function bar(v, color) {
    const w = v === null || v === undefined ? 0 : Math.max(0, Math.min(1, v / 100));
    return `<td class="num bar" style="--c:${color}"><span class="track"><i style="width:${(w * 100).toFixed(1)}%"></i></span><span class="v">${fmt(v, 'num1')}</span></td>`;
}

function shareCell(r, sc) {
    const tip = r.detail ? `data-tip="${escapeHtml(escapeHtml(r.detail))}"` : '';
    return `<td class="num share${r.inScope ? ' on' : ''}" ${tip}>${r.inScope ? '<span class="badge">●</span>' : ''}${r.share === null ? '' : fmt(r.share, 'pct')}</td>`;
}

function downloadCsv(lb) {
    const { rows } = lb.result;
    const pillars = lb.data.pillars;
    const sc = lb.spec.scope;
    const q = s => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
    const head = ['rank', 'rank_change', 'id', 'name', lb.spec.overall?.label || 'overall', ...pillars.map(p => p.label),
        ...(sc ? [sc.label || 'scope_share', `${sc.label || 'scope'} (detail)`] : [])];
    const sorted = rows.filter(r => r.inView).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    const lines = [head, ...sorted.map(r => [r.rank ?? '', r.delta || 0, r.id, r.name, round1(r.overall),
        ...pillars.map(p => round1(r.pillars[p.theme.id])), ...(sc ? [r.share ?? '', r.detail ?? ''] : [])])];
    const st = lb.stateString();
    const meta = `# ${lb.paramNote || ''}${st ? ` · scoring: ${st}` : ' · default scoring'}`;
    const blob = new Blob([meta + '\n' + lines.map(l => l.map(q).join(',')).join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leaderboard-${lb.jur.id}${lb.paramNote ? '-' + lb.paramNote.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() : ''}${lb.state.scope === 'priority' ? '-priority' : ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const round1 = v => (v === null || v === undefined ? '' : Math.round(v * 10) / 10);

export const leaderboardCss = `
.view-tabs { display: flex; gap: 2px; padding: 6px 16px 0; background: var(--chrome-bg); border-bottom: 1px solid var(--line); flex: 0 0 auto; }
.view-tabs button {
    border: 0; background: none; padding: 7px 12px 8px; cursor: pointer; font-size: 13.5px; font-weight: 600;
    color: var(--text-3); border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.view-tabs button:hover { color: var(--text); }
.view-tabs button[aria-selected="true"] { color: var(--primary); border-bottom-color: var(--primary); }
.pick-hint { font-size: 14px; color: var(--text-2); padding: 2px 0; }
.pick-hint b { color: var(--text); }
.lb-intro { color: var(--text-2); font-size: 13px; margin: -2px 0 10px; }
.lb-intro p { margin: 0 0 6px; }
.lb-scope { margin: 0 0 10px; }
.lb-scope small { opacity: .7; font-variant-numeric: tabular-nums; margin-left: 3px; }
.lb-scope .tile-note { margin-top: 6px; }
.lb-scoring { padding: 8px 14px; }
.lb-scoring > summary { cursor: pointer; font-weight: 600; font-size: 14px; }
.lb-scoring-body > .tile-note { margin: 4px 0 8px; }
.lb-pillar { border-top: 1px solid var(--line); padding: 5px 0; }
.lb-prow, .lb-vrow { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.lb-expand { border: 0; background: none; cursor: pointer; font: inherit; font-size: 13.5px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; padding: 3px 0; color: var(--text); }
.lb-expand .caret { color: var(--text-3); width: 10px; transition: transform 120ms; }
.lb-expand[aria-expanded="true"] .caret { transform: rotate(90deg); }
.lb-expand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
.lb-vars { padding: 2px 0 4px 22px; }
.lb-vrow { font-size: 12.5px; padding: 2px 0; }
.lb-vrow label { flex: 1 1 auto; display: flex; gap: 6px; align-items: center; cursor: pointer; min-width: 0; }
.lb-vrow.off label { color: var(--text-3); }
.lb-vrow.off .lb-w { opacity: .45; }
.lb-w { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.lb-w input { width: 110px; accent-color: var(--c, var(--primary)); }
.lb-w output { font-size: 12px; color: var(--text-2); width: 3.2em; font-variant-numeric: tabular-nums; }
.lb-rev { border: 1px solid var(--line-strong); background: var(--card-bg); border-radius: 999px; font-size: 11.5px; padding: 1px 6px; cursor: pointer; flex: 0 0 auto; width: 7.2em; text-align: center; white-space: nowrap; }
.lb-rev[aria-pressed="true"] { background: color-mix(in srgb, #d97706 14%, var(--mix-base, white)); border-color: #d97706; color: var(--rev-fg, #92400e); }
.lb-scoring-foot { border-top: 1px solid var(--line); padding-top: 6px; display: flex; justify-content: flex-end; }
.lb-card { padding: 10px 0 8px; }
.lb-card > .err, .lb-card > .lb-note { margin: 4px 14px; }
.lb-tools { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; padding: 0 14px 8px; }
.lb-search { flex: 1 1 180px; padding: 6px 9px; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--card-bg); font: inherit; font-size: 13px; }
.lb-count { font-size: 12px; color: var(--text-3); }
.lb-scroll { overflow-x: auto; }
.lb-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.lb-table th {
    position: sticky; top: 0; background: var(--card-bg); z-index: 1;
    text-align: left; font-weight: 600; font-size: 11.5px; color: var(--text-2);
    padding: 6px 5px; border-bottom: 1px solid var(--line-strong); cursor: pointer; user-select: none; vertical-align: bottom; line-height: 1.25;
}
.lb-table th.num { text-align: right; }
.lb-table th .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--c); margin-right: 4px; }
.lb-table th[aria-sort]::after { content: ' ▾'; color: var(--text-3); }
.lb-table th[aria-sort="ascending"]::after { content: ' ▴'; }
.lb-table th:first-child, .lb-table td:first-child { padding-left: 14px; }
.lb-table th:last-child, .lb-table td:last-child { padding-right: 10px; }
.lb-table td { padding: 4px 5px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.lb-table tbody tr:hover { background: var(--primary-wash); }
.lb-table tbody tr.focus { background: color-mix(in srgb, #c2410c 16%, var(--mix-base, white)); box-shadow: inset 3px 0 0 #c2410c; }
.lb-table .num { text-align: right; }
.lb-table td.rank { color: var(--text-3); width: 1%; }
.lb-table td.delta { width: 1%; font-size: 11px; white-space: nowrap; }
.lb-table td.delta.up { color: #15803d; }
.lb-table td.delta.down { color: #b91c1c; }
.lb-name { border: 0; background: none; padding: 0; font: inherit; color: var(--text); cursor: pointer; text-align: left; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 2px; }
.lb-name:hover { color: var(--primary); text-decoration-color: currentColor; }
.lb-table td.name { min-width: 130px; }
.lb-table td.overall { white-space: nowrap; }
.lb-table td.bar { white-space: nowrap; }
.lb-table td.bar .track { display: inline-block; width: 30px; height: 6px; border-radius: 3px; background: var(--line); vertical-align: middle; margin-right: 5px; overflow: hidden; }
.lb-table td.bar .track i { display: block; height: 100%; background: var(--c); }
.lb-table td.bar .v { display: inline-block; min-width: 2.2em; }
.lb-table td.share { white-space: nowrap; color: var(--text-3); }
.lb-table td.share.on { color: var(--text); }
.lb-table td.share .badge { color: var(--badge, #1f5f8b); font-size: 9px; margin-right: 4px; vertical-align: 1px; }
.lb-open { border: 1px solid var(--line-strong); background: var(--card-bg); border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 7px; color: var(--text-2); }
.lb-open:hover { background: var(--primary); color: var(--on-primary, #fff); border-color: var(--primary); }
`;
