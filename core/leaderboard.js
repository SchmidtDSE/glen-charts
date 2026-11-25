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
 * columns variable, label, value, dir (+1 or −1), and optionally fmt, unit
 * and comparable (false for a total; see below).
 *
 * A drawn area (an area source with a comparison type, see explorer.js) is
 * scored as one more member of the type: its percentile on each variable is
 * the same mid-rank among the type's areas plus itself, and its implied rank
 * is its place among them all ("34th of 220"). Variables that do not compare
 * between areas of different sizes, such as totals, are left out of its
 * percentiles and scores: "comparable": false on the variable in the pillar's
 * `variables`, or a comparable column that is false in the query's rows.
 *
 * app.json:
 *   "leaderboard": {
 *     "jurisdiction": "ecoregion",                 area type (default: the first)
 *     "tab": "Leaderboard", "profile_tab": "Profile", "default": true to land on it,
 *     "title", "intro" (HTML),
 *     "pillars": [{ "theme": "carbon", "query": "carbon", "weight": 1,
 *                   "variables": { "<variable>": { "weight": 0 to switch off by default, "reverse": true,
                                                  "comparable": false to leave it out of a drawn area's scores } } }],
 *     "overall": { "label": "Overall", "note": "…" },
 *     "scope": { "theme": "priority", "query": "priority", "field": "priority_share", "min": 0.5,
 *                "detail_field"?, "label": "Priority countries", "global_label": "Global", "column"?: "Priority", "note"? },
 *     "map": { "label": "Overall score", "ramp": [colours] }
 *   }
 *
 * Reader changes are kept as a compact string (see stateString) that the
 * explorer puts in the URL, so a re-weighted view is a shareable link.
 */

import { fmt, escapeHtml, isMissing, ordinal } from './format.js';
import { hover } from './charts.js';

const MAX_W = 3;

export class Leaderboard {
    /**
     * ctx: { engine, spec, jur, onShow(feature), onOpen(feature), onHover(id|null),
     *        onScores({ rows, inScope }), onChange(),
     *        drawSources: [{ id, label, description }] ranked among this type, onDraw(id),
     *        onOpenDrawn() for the drawn area's row (see setDrawn) }
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
        this.drawnAoi = null;      // an area from a source, shown as one more row (setDrawn)
        this.drawn = null;         // its values once its queries have run
    }

    /**
     * An area from a source (a drawn polygon) to show in the table at the rank
     * it would take, scored as the profile's card scores it; null for none.
     * Takes effect at the next load().
     */
    setDrawn(aoi, label = null) {
        if (aoi?.key !== this.drawnAoi?.key) this.drawn = null;
        this.drawnAoi = aoi;
        this.drawnLabel = label || aoi?.label || 'Drawn area';
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
        this.state = parseState(this.spec, str);
        if (this.data) for (const [k, v] of Object.entries(fillVars(this.data, this.spec))) this.state.vars[k] ??= v;
    }

    /* ------------------------------------------------------------- data */

    /**
     * reveal: scroll the drawn area's row into view once it is placed (on opening
     * the leaderboard), unless the reader has scrolled or is editing the scoring
     * by then. A change of setting reloads without it, so the table does not jump.
     */
    async load(params, paramNote = '', { reveal = false } = {}) {
        const token = ++this.token;
        this.params = params;
        this.paramNote = paramNote;
        this.renderShell();
        this.reveal = reveal ? { top: this.el.scrollTop } : null;
        try {
            const data = await loadData(this.ctx.engine, this.spec, this.jur, params);
            if (token !== this.token) return;
            this.data = data;
            // variables seen for the first time get their default settings
            for (const p of data.pillars) for (const v of p.variables) {
                this.state.vars[v.key] ??= { ...defaultVar(this.spec, p.theme.id, v.variable) };
            }
            this.renderBody();
            this.loadDrawn(token);
        } catch (err) {
            if (token !== this.token) return;
            this.el.querySelector('.lb-card').innerHTML = `<div class="err">Could not build the leaderboard: ${escapeHtml(err.message)}</div>`;
            console.error(err);
        }
    }

    /** Run the drawn area's queries (cached by the engine, so shared with its profile), then add its row. */
    async loadDrawn(token) {
        const aoi = this.drawnAoi;
        if (!aoi) { this.drawn = null; return; }
        const note = this.el.querySelector('.lb-drawn-note');
        if (note) note.textContent = `Running the queries for ${this.drawnLabel}…`;
        try {
            const [v, sc] = await Promise.all([drawnValues(this.ctx.engine, this.data, aoi), drawnScope(this.ctx.engine, this.spec, aoi)]);
            if (token !== this.token || aoi !== this.drawnAoi) return;
            this.drawn = { ...v, ...sc };
            this.renderTable();
            const r = this.reveal;
            this.reveal = null;
            const busy = this.el.querySelector('.lb-scoring')?.contains(document.activeElement);
            if (r && !busy && Math.abs(this.el.scrollTop - r.top) < 40) this.showDrawnRow();
        } catch (err) {
            console.error(err);
            if (note && token === this.token) note.textContent = `Could not score ${this.drawnLabel}: ${err.message}`;
        }
    }

    /** Scroll the drawn area's row to the middle of the panel and focus it (its note's link, and on opening). */
    showDrawnRow() {
        const tr = this.el.querySelector('.lb-table tbody tr.drawn');
        if (!tr) return;
        tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        tr.focus({ preventScroll: true });
        tr.classList.remove('flash');
        void tr.offsetWidth;          // restart the highlight
        tr.classList.add('flash');
    }

    /** Scores for the current state, and for the default state in the same scope (for rank changes). */
    compute() {
        const cur = score(this.data, this.state, this.spec);
        // the drawn area at the rank it would take; the other areas' scores and ranks are without it
        if (this.drawn) {
            const d = scoreDrawn(this.data, this.drawn.vals, this.state, this.spec, { inScope: this.drawn.inScope });
            cur.drawn = {
                id: '__drawn__', drawn: true, name: this.drawnLabel, rank: d.rank, of: d.of, overall: d.overall, partial: d.partial,
                pillars: Object.fromEntries(Object.entries(d.pillars).map(([k, p]) => [k, p.score])),
                share: this.drawn.share, detail: this.drawn.detail, inScope: this.drawn.inScope,
                inView: this.state.scope !== 'priority' || !this.spec.scope || this.drawn.inScope,
            };
        }
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
                    ${(this.ctx.drawSources || []).map(s => `<button class="ghost-btn lb-draw" type="button" data-source="${escapeHtml(s.id)}" title="${escapeHtml(s.description || s.label)}, and see where it would rank here">${escapeHtml(this.ctx.drawSources.length > 1 ? s.label : spec.draw_label || 'Rank your own area')}</button>`).join('')}
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
        this.el.querySelectorAll('.lb-draw').forEach(b => { b.onclick = () => this.ctx.onDraw?.(b.dataset.source); });
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
                <p class="tile-note lb-note"></p>
                <p class="tile-note lb-drawn-note"></p>`;
            card.querySelectorAll('th[data-sort]').forEach(th => {
                th.onclick = () => {
                    const k = th.dataset.sort;
                    if (this.sort.key === k) this.sort.dir = -this.sort.dir;
                    else this.sort = { key: k, dir: k === 'rank' || k === 'name' ? 1 : -1 };
                    this.drawRows();
                };
            });
            card.querySelector('.lb-search').oninput = e => { this.q = e.target.value; this.drawRows(); };
            card.addEventListener('click', e => { if (e.target.closest('.lb-show-drawn')) this.showDrawnRow(); });
            const tbody = card.querySelector('tbody');
            tbody.addEventListener('click', e => {
                const tr = e.target.closest('tr');
                if (tr?.dataset.id === '__drawn__') { if (e.target.closest('button')) this.ctx.onOpenDrawn?.(); return; }
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
            tbody.addEventListener('mouseover', e => { const tr = e.target.closest('tr'); if (tr && tr.dataset.id !== '__drawn__') this.ctx.onHover?.(tr.dataset.id); });
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
        const dn = card.querySelector('.lb-drawn-note');
        const d = res.drawn;
        if (dn && this.drawnAoi) {
            const scopeLabel = escapeHtml(sc?.label || 'priority');
            dn.innerHTML = !d ? (this.drawn ? '' : dn.innerHTML)
                : !d.inView ? `<b>${escapeHtml(d.name)}</b> (your area) is outside the ${scopeLabel} list${d.share !== null ? ` (${fmt(d.share, 'pct')})` : ''}, so it is not in this view.`
                : d.rank ? `<b>${escapeHtml(d.name)}</b> (your area) would rank ${d.rank} of ${d.of} with itself counted; the other ranks are without it. <button type="button" class="lb-show-drawn">Show its row</button><br>Its percentiles count it as one more of the ${escapeHtml(peers)}, and leave out variables that do not compare with whole areas.`
                : `<b>${escapeHtml(d.name)}</b> (your area) has no comparable values to rank at these weights.`;
        }
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
        // the drawn area stays in view whatever the filter, just above the area holding its rank
        const drawn = this.result.drawn;
        if (drawn?.inView && drawn.rank) shown.push(drawn);
        const val = (r, k) => k === 'rank' ? (r.drawn ? r.rank - 0.5 : r.rank ?? Infinity) : r.drawn && k === 'delta' ? null : k === 'name' ? r.name : k === 'overall' ? r.overall
            : k === 'delta' ? r.delta : k === 'share' ? r.share : r.pillars[k.slice(2)];
        const { key, dir } = this.sort;
        shown.sort((a, b) => {
            const va = val(a, key), vb = val(b, key);
            if (va === vb) return (a.rank ?? Infinity) - (b.rank ?? Infinity);
            if (va === null || va === undefined) return 1;
            if (vb === null || vb === undefined) return -1;
            return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
        });
        tbody.innerHTML = shown.map(r => r.drawn ? drawnRow(r, pillars, sc, this.spec) : `
            <tr data-id="${escapeHtml(r.id)}" tabindex="0" class="${r.id === this.focusId ? 'focus' : ''}">
                <td class="num rank">${r.rank ?? ''}</td>
                <td class="num delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}">${r.delta > 0 ? '↑' + r.delta : r.delta < 0 ? '↓' + -r.delta : ''}</td>
                <td class="name"><button type="button" class="lb-name" title="Show on the map">${escapeHtml(r.name)}</button></td>
                <td class="num overall"><b>${fmt(r.overall, 'num1')}</b>${r.partial && r.overall !== null ? '*' : ''}</td>
                ${pillars.map(p => bar(r.pillars[p.theme.id], p.color)).join('')}
                ${sc ? shareCell(r, sc) : ''}
                <td class="open"><button type="button" class="lb-open" title="Open ${escapeHtml((this.spec.profile_tab || 'profile').toLowerCase())}">›</button></td>
            </tr>`).join('');
        const nShown = shown.length - (shown.includes(drawn) ? 1 : 0);
        card.querySelector('.lb-count').textContent = nShown === this.result.inView ? '' : `${nShown} of ${this.result.inView}`;
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

/** A scoring state from its link string (see stateString); unknown variables keep their defaults. */
export function parseState(spec, str) {
    const state = defaultState(spec);
    for (const part of String(str || '').split(';').filter(Boolean)) {
        const [k, v] = part.split('=');
        if (k === 'scope') { if (v === 'priority' || v === 'global') state.scope = v; continue; }
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (k.includes('.')) state.vars[k] = { w: clampW(Math.abs(n)), rev: v.startsWith('-') };
        else state.pillars[k] = clampW(n);
    }
    return state;
}

export function defaultState(spec) {
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

export async function loadData(engine, spec, jur, params) {
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
            if (!vars.has(r.variable)) vars.set(r.variable, { variable: r.variable, key: `${p.theme.id}.${r.variable}`, label: r.label || r.variable, unit: r.unit, fmt: r.fmt, dir: Number(r.dir) || 0, comparable: p.variables?.[r.variable]?.comparable !== false });
            if (isFalse(r.comparable)) vars.get(r.variable).comparable = false;
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

/* ---------------------------------------------------------- drawn area */

/** A comparable column or option that says no: false, 0, 'false', 'no'. */
export const isFalse = x => x === false || x === 0 || (typeof x === 'string' && /^(false|no|0)$/i.test(x.trim()));

/**
 * Whether a variable compares between a drawn area and whole areas of a type:
 * not when the leaderboard marks it "comparable": false for that theme, or its
 * row carries a comparable column that is false.
 */
export function isComparable(app, themeId, variable, row = null) {
    if (row && isFalse(row.comparable)) return false;
    const p = (app?.leaderboard?.pillars || []).find(x => x.theme === themeId);
    return p?.variables?.[variable]?.comparable !== false;
}

/**
 * Percentile (0–100, to 0.1) of `v` as one more member of `vals`, by the
 * leaderboard's mid-rank rule, with dir −1 when lower is better. Null without
 * a value or with nothing to compare against.
 */
export function percentileAmong(vals, v, dir = 1) {
    if (v === null || v === undefined || !Number.isFinite(Number(v)) || !vals.length) return null;
    const d = Number(dir) < 0 ? -1 : 1;
    const pts = vals.map((x, i) => ({ id: i, x: d * x }));
    pts.push({ id: 'me', x: d * Number(v) });
    return midRank(pts).get('me');
}

/**
 * A drawn area's values for the leaderboard's variables, from each pillar's
 * query run live over it: { vals, left (labels not comparable), failed (pillar labels) }.
 * onDone() is called as each query finishes.
 */
export async function drawnValues(engine, data, aoi, onDone = () => {}) {
    const results = await Promise.all(data.pillars.map(p => engine.run(p.theme, p.query, aoi)
        .then(rows => rows, err => { console.error(err, err.sql); return null; })
        .finally(onDone)));
    const vals = {}, left = [];
    data.pillars.forEach((p, i) => {
        const byVar = new Map((results[i] || []).map(r => [r.variable, r]));
        for (const v of p.variables) {
            const r = byVar.get(v.variable);
            if (!v.comparable || (r && isFalse(r.comparable))) { left.push(v.label); continue; }
            if (r && !isMissing(r.value)) vals[v.key] = Number(r.value);
        }
    });
    return { vals, left, failed: data.pillars.filter((p, i) => !results[i]).map(p => p.label) };
}

/** A drawn area's place in the leaderboard's scope, by the same rule as its areas: { share, detail, inScope }. */
export async function drawnScope(engine, spec, aoi) {
    const sc = spec.scope;
    const theme = sc && engine.config.themeById[sc.theme];
    if (!theme) return { share: null, detail: null, inScope: true };
    const row = (await engine.run(theme, sc.query || Object.keys(theme.queries)[0], aoi).catch(() => null))?.[0];
    const share = row && !isMissing(row[sc.field]) ? Number(row[sc.field]) : null;
    return { share, detail: row && sc.detail_field ? row[sc.detail_field] : null, inScope: share !== null && share >= (sc.min ?? 0.5) };
}

/**
 * Score a drawn area as one more member of the leaderboard's areas.
 *   data   loadData()'s result for the comparison type
 *   vals   { "<theme>.<variable>": value } for the drawn area; variables that
 *          are not comparable must already be left out (or null)
 *   state  the leaderboard's scoring state
 * Returns { overall, rank, of, partial, pct: { key: pct }, pillars: { theme: { score, rank, of } } }.
 * Its own percentiles count it as one more member; its rank is its place among
 * the areas' scores as the leaderboard shows them (without it), so it is
 * 1 + the number of areas in view that score higher, of their count + 1.
 * inScope: false leaves it out of a priority-scope view (overall and rank null).
 */
export function scoreDrawn(data, vals, state, spec, { inScope = true } = {}) {
    const me = { id: '__drawn__', name: '', vals, inScope, share: null };
    const res = score({ ...data, rows: [...data.rows, me] }, state, spec);
    const mine = res.rows.find(r => r.id === me.id);
    const shown = score(data, state, spec).rows.filter(r => r.inView);
    const place = (x, get) => {
        const others = shown.map(get).filter(v => v !== null && v !== undefined);
        return x === null || x === undefined || !mine.inView ? { rank: null, of: others.length + 1 } : { rank: 1 + others.filter(v => v > x).length, of: others.length + 1 };
    };
    const pillars = {};
    for (const p of data.pillars) {
        const sc = mine.pillars[p.theme.id] ?? null;
        pillars[p.theme.id] = { score: sc, ...place(sc, r => r.pillars[p.theme.id]) };
    }
    const o = place(mine.overall, r => r.overall);
    return { overall: mine.overall, rank: o.rank, of: o.of, partial: mine.partial, pct: mine.pct, pillars };
}

/**
 * The profile card for a drawn area: its overall and pillar scores among the
 * leaderboard's areas, and the rank it would take, from each pillar's query
 * run live over the area.
 *   ctx: { engine, spec, jur, aoi, state, isCurrent(), paramNote, genericLabels: labels that
 *          only name the kind of area (e.g. "Drawn area"), written as "this area" }
 */
export function drawnRankCard({ engine, spec, jur, aoi, state, isCurrent = () => true, paramNote = '', genericLabels = [] }) {
    const card = document.createElement('section');
    card.className = 'card lb-drawn';
    const peers = jur.peer_label || jur.label.toLowerCase();
    const overallLabel = spec.overall?.label || 'Overall';
    card.innerHTML = `
        <div class="card-head"><h3>Among ${escapeHtml(peers)}</h3></div>
        <p class="card-blurb">Where ${!aoi.label || genericLabels.includes(aoi.label) ? 'this area' : `“${escapeHtml(aoi.label)}”`} would rank if it were one of the ${escapeHtml(peers)}, scored as on the ${escapeHtml((spec.tab || 'leaderboard').toLowerCase())}.</p>
        <div class="lb-drawn-body"><div class="tile-note lb-drawn-progress">Loading the ${escapeHtml(peers)}…</div></div>`;
    const body = card.querySelector('.lb-drawn-body');
    const progress = card.querySelector('.lb-drawn-progress');
    (async () => {
        const params = aoi.params || {};
        const data = await loadData(engine, spec, jur, params);
        if (!isCurrent()) return;
        if (!data.rows.length) { body.innerHTML = `<p class="tile-note">The ${escapeHtml(peers)} are not precomputed at this setting, so there is nothing to rank against.</p>`; return; }
        let done = 0;
        const n = data.pillars.length;
        const tick = () => { progress.textContent = `Running ${n - done} of ${n} ${n === 1 ? 'query' : 'queries'} over this area…`; };
        tick();
        const [{ vals, left, failed }, sc] = await Promise.all([
            drawnValues(engine, data, aoi, () => { done++; if (isCurrent()) tick(); }),
            drawnScope(engine, spec, aoi),
        ]);
        if (!isCurrent()) return;
        // in the priority scope, an area outside it is ranked among all areas instead, and says so
        const priority = state.scope === 'priority' && !!spec.scope;
        const outside = priority && !sc.inScope;
        const res = scoreDrawn(data, vals, outside ? { ...state, scope: 'global' } : state, spec);
        const scope = priority && !outside ? ` (${escapeHtml(spec.scope.label || 'priority')})` : '';
        body.innerHTML = `
            <div class="lb-drawn-head">
                <div class="tile"><div class="tile-label">${escapeHtml(overallLabel)} score</div><div class="tile-value">${fmt(res.overall, 'num1')}${res.partial && res.overall !== null ? '*' : ''}</div></div>
                <div class="tile"><div class="tile-label">Would rank</div><div class="tile-value">${res.rank ? `${ordinal(res.rank)}` : '—'}</div>
                    <div class="tile-compare">${res.rank ? `of ${res.of} ${escapeHtml(peers)}${scope}, with this area` : 'No comparable values'}</div></div>
            </div>
            <table class="lb-drawn-table"><tbody>
                ${data.pillars.map(p => {
                    const ps = res.pillars[p.theme.id];
                    // a pillar whose weighted variables are all left out says why it has no score
                    const none = ps.score === null && !p.variables.some(v => v.comparable && (state.vars[v.key]?.w ?? 1) > 0);
                    const why = none ? `<td colspan="2" class="lb-drawn-none">No comparable variables at these weights${p.variables.some(v => v.comparable) ? '; switch one on under Scoring' : ''}</td>`
                        : `${bar(ps.score, p.color)}<td class="num rank">${ps.rank ? `${ordinal(ps.rank)} of ${ps.of}` : ''}</td>`;
                    return `<tr style="--c:${p.color}"><th><span class="dot"></span>${escapeHtml(p.label)}</th>${why}</tr>`;
                }).join('')}
            </tbody></table>
            <p class="tile-note">${[
                paramNote ? escapeHtml(paramNote) + '.' : '',
                'Scores use the leaderboard’s current weights; a percentile counts this area as one more of the ' + escapeHtml(peers) + '.',
                outside ? `This area is outside the ${escapeHtml(spec.scope.label || 'priority')} list${sc.share !== null ? ` (${fmt(sc.share, 'pct')})` : ''}, so it is ranked among all ${escapeHtml(peers)}.` : '',
                left.length ? `Left out as not comparable with whole areas: ${escapeHtml(left.join(', '))}.` : '',
                failed.length ? `Query failed: ${escapeHtml(failed.join(', '))}.` : '',
                res.partial && res.overall !== null ? '* Some pillars have no comparable data here; the overall score uses those present.' : '',
            ].filter(Boolean).join(' ')}</p>`;
    })().catch(err => {
        if (!isCurrent()) return;
        body.innerHTML = `<div class="err">Could not rank this area: ${escapeHtml(err.message)}</div>`;
        console.error(err);
    });
    return card;
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

/** The drawn area's row: its would-be rank, marked, with no rank change. */
function drawnRow(r, pillars, sc, spec) {
    const open = (spec.profile_tab || 'profile').toLowerCase();
    return `
            <tr data-id="__drawn__" tabindex="0" class="drawn">
                <td class="num rank" title="Would rank ${r.rank} of ${r.of} with this area">${r.rank}</td>
                <td class="num delta"></td>
                <td class="name"><button type="button" class="lb-name" title="Open its ${escapeHtml(open)}">${escapeHtml(r.name)}</button> <span class="lb-yours">your area</span></td>
                <td class="num overall"><b>${fmt(r.overall, 'num1')}</b>${r.partial && r.overall !== null ? '*' : ''}</td>
                ${pillars.map(p => bar(r.pillars[p.theme.id], p.color)).join('')}
                ${sc ? shareCell(r, sc) : ''}
                <td class="open"><button type="button" class="lb-open" title="Open its ${escapeHtml(open)}">›</button></td>
            </tr>`;
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
    const d = lb.result.drawn;
    const meta = `# ${lb.paramNote || ''}${st ? ` · scoring: ${st}` : ' · default scoring'}` +
        (d?.inView && d.rank ? `\n# drawn area "${String(d.name).replace(/\n/g, ' ')}" (not a row): would rank ${d.rank} of ${d.of}, overall ${round1(d.overall)}` : '');
    const blob = new Blob([meta + '\n' + lines.map(l => l.map(q).join(',')).join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leaderboard-${lb.jur.id}${lb.paramNote ? '-' + lb.paramNote.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() : ''}${lb.state.scope === 'priority' ? '-priority' : ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const round1 = v => (v === null || v === undefined ? '' : Math.round(v * 10) / 10);

export const leaderboardCss = `
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
/* No overflow here: a scrolling wrapper would become the box the sticky header
   sticks to, and it never scrolls vertically, so the header would scroll away
   with the rows. The report panel scrolls instead, sideways too when narrow. */
.lb-scroll { overflow: visible; }
.lb-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.lb-table th {
    /* stick at the panel's top edge, not below its top padding, so no row shows above */
    position: sticky; top: calc(-1 * var(--report-pad-top, 0px)); background: var(--card-bg); z-index: 1;
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
.lb-drawn .lb-drawn-head { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.lb-drawn .lb-drawn-head .tile { flex: 1 1 140px; }
.lb-drawn-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.lb-drawn-table th { text-align: left; font-weight: 500; padding: 3px 5px 3px 0; }
.lb-drawn-table th .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--c); margin-right: 6px; }
.lb-drawn-table td { padding: 3px 5px; border-top: 1px solid var(--line); }
.lb-drawn-table td.bar { white-space: nowrap; }
.lb-drawn-table td.bar .track { display: inline-block; width: 60px; height: 6px; border-radius: 3px; background: var(--line); vertical-align: middle; margin-right: 6px; overflow: hidden; }
.lb-drawn-table td.bar .track i { display: block; height: 100%; background: var(--c); }
.lb-drawn-table td.lb-drawn-none { color: var(--text-3); font-size: 12px; }
.lb-drawn-table td.rank { text-align: right; color: var(--text-2); white-space: nowrap; }
.lb-table tbody tr.drawn { background: color-mix(in srgb, var(--primary) 12%, var(--mix-base, white)); box-shadow: inset 3px 0 0 var(--primary); }
.lb-table tbody tr.drawn td.rank { color: var(--text); font-style: italic; }
.lb-table tbody tr.drawn.flash { animation: lb-flash 1.6s ease-out; }
@keyframes lb-flash { 0%, 30% { background: color-mix(in srgb, var(--primary) 35%, var(--mix-base, white)); } }
.lb-show-drawn { border: 0; background: none; padding: 0; font: inherit; color: var(--primary); text-decoration: underline; cursor: pointer; }
.lb-yours { font-size: 10.5px; color: var(--text-2); border: 1px solid var(--line-strong); border-radius: 999px; padding: 0 6px; white-space: nowrap; }
.lb-card > .lb-drawn-note { margin: 4px 14px; }
.lb-card > .lb-drawn-note:empty { display: none; }
.lb-open:hover { background: var(--primary); color: var(--on-primary, #fff); border-color: var(--primary); }
`;
