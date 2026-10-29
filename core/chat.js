/**
 * Optional assistant for a glen-charts app (app.json "chat"). The explorer
 * imports this module only when the app has a chat block, so apps without one
 * load no LLM code and run exactly as before.
 *
 *   "chat": {
 *     "title": "Chat",
 *     "system_prompt": "config/chat.md",      // app guidance, appended to the built-in prompt
 *     "examples": ["…", "…"],                 // suggested questions
 *     "llm_models": [{ "value", "label", "endpoint", "api_key" }], "llm_model": "…",
 *     "agent_url": "https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.36.0/app"
 *   }
 *
 * The models may instead come from the page's config.json (llm_models,
 * llm_model), which a deployment writes at start so no key is in the app.
 *
 * The agent loop and tool registry are geo-agent's (agent.js and
 * tool-registry.js, which touch no DOM), loaded from agent_url. The tools are
 * glen's own, over the explorer's query engine:
 *   query         run SQL; area tokens ({{AOI10}}, {{ID}}, params …) are expanded for the chosen area
 *   current_view  the chosen area, settings, panels and their current results
 *   add_card      show a result as a table or bar chart; the reader can add it to the report,
 *                 where it is a live panel that re-runs for each area
 *   select_area   choose a named area by type and name
 *   set_param     change a setting
 */

import { renderBarChart } from './charts.js';
import { fmt, escapeHtml } from './format.js';
import { optionValue, optionLabel } from './engine.js';

const GEO_AGENT = 'https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.36.0/app';
const MAX_ROWS = 100;          // rows of a query result passed back to the model
const MAX_CHARS = 20000;

export async function mountChat(explorer) {
    const chat = new Chat(explorer);
    await chat.init();
    return chat;
}

class Chat {
    constructor(ex) {
        this.ex = ex;
        this.app = ex.config.app;
        this.spec = this.app.chat || {};
        this.pinned = [];                       // card specs added to the report
        this.cards = new Map();                 // id → { spec, rows } shown in chat
        this.busy = false;
    }

    async init() {
        const sidebar = this.ex.$('#sidebar');
        const dock = this.dock = document.createElement('section');
        dock.className = 'chat-dock compact';      // header and input only, until the reader uses it
        dock.innerHTML = `
            <div class="chat-head">
                <b>${escapeHtml(this.spec.title || 'Chat')}</b>
                <span class="chat-head-right">
                    <select class="chat-model" aria-label="Model" hidden></select>
                    <button type="button" class="ghost-btn chat-toggle">Hide</button>
                </span>
            </div>
            <div class="chat-body">
                <div class="chat-log" aria-live="polite"></div>
                <div class="chat-examples"></div>
                <form class="chat-form">
                    <input type="text" autocomplete="off" placeholder="${escapeHtml(this.spec.placeholder || 'Ask a question')}" aria-label="Message">
                    <button type="submit" class="chat-send">Send</button>
                </form>
            </div>`;
        sidebar.appendChild(dock);
        this.log = dock.querySelector('.chat-log');
        this.input = dock.querySelector('input');
        const toggle = dock.querySelector('.chat-toggle');
        toggle.textContent = 'Show';
        this.expand = (open = true) => {
            dock.classList.toggle('compact', !open);
            toggle.textContent = open ? 'Hide' : 'Show';
        };
        toggle.onclick = () => this.expand(dock.classList.contains('compact'));
        this.input.addEventListener('focus', () => this.expand(true));
        dock.querySelector('form').onsubmit = e => { e.preventDefault(); this.send(this.input.value); };
        const ex = dock.querySelector('.chat-examples');
        ex.innerHTML = (this.spec.examples || []).map((q, i) => `<button type="button" data-i="${i}">${escapeHtml(q)}</button>`).join('');
        ex.onclick = e => { const b = e.target.closest('button'); if (b) this.send(this.spec.examples[+b.dataset.i]); };

        const rt = this.ex.runtime || {};
        const models = rt.llm_models || this.spec.llm_models || [];
        if (!models.length) {
            this.note('No language model is configured for this app, so the chat is off.');
            dock.querySelector('form').hidden = true;
            ex.hidden = true;
            return;
        }
        const base = (this.spec.agent_url || GEO_AGENT).replace(/\/$/, '');
        const [{ Agent }, { ToolRegistry }] = await Promise.all([import(`${base}/agent.js`), import(`${base}/tool-registry.js`)]);
        this.registry = new ToolRegistry({ memoTools: [] });
        for (const t of this.tools()) this.registry.registerLocal(t);
        this.agent = new Agent({
            llm_models: models,
            llm_model: rt.llm_model || this.spec.llm_model || models[0].value,
            auto_approve: true,
            max_tool_calls: this.spec.max_tool_calls ?? 15,
        }, this.registry);
        const sel = dock.querySelector('.chat-model');
        if (models.length > 1) {
            sel.innerHTML = models.map(m => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label || m.value)}</option>`).join('');
            sel.value = this.agent.selectedModel;
            sel.onchange = () => this.agent.setModel(sel.value);
            sel.hidden = false;
        }
        this.guidance = this.spec.system_prompt
            ? await fetch(`${this.ex.base}/${this.spec.system_prompt}`, { cache: 'no-cache' }).then(r => (r.ok ? r.text() : '')).catch(() => '')
            : '';
        this.agent.onThinkingStart = () => this.thinking(true);
        this.agent.onThinkingEnd = () => this.thinking(false);
        this.agent.onToolExecuting = calls => this.showCalls(calls);
        this.agent.onError = err => this.note(`Error: ${err?.message || err}`, 'err');
        this.agent.onCheckpoint = summary => this.say(summary);
        if (this.spec.welcome) this.say(this.spec.welcome);
    }

    /* ---------------------------------------------------------------- turn */

    async send(text) {
        text = String(text || '').trim();
        if (!text || this.busy || !this.agent) return;
        this.input.value = '';
        this.expand(true);
        this.busy = true;
        this.dock.classList.add('busy');
        this.add(`<div class="msg user">${escapeHtml(text)}</div>`);
        this.agent.setSystemPrompt(this.systemPrompt());
        try {
            const out = await this.agent.processMessage(text);
            if (out?.response) this.say(out.response);
        } catch (err) {
            this.note(`Error: ${err.message}`, 'err');
        } finally {
            this.thinking(false);
            this.busy = false;
            this.dock.classList.remove('busy');
        }
    }

    systemPrompt() {
        const ex = this.ex, app = this.app, s = ex.state;
        const themes = [ex.config.overview, ...ex.config.themes].filter(Boolean);
        const panels = themes.map(t => `### Panel "${t.label}" (theme ${t.id})\n${t.blurb || ''}\n` +
            Object.keys(t.queries).map(q => `Query ${q}:\n\`\`\`sql\n${t.sql[q].trim()}\n\`\`\``).join('\n')).join('\n\n');
        const types = app.jurisdictions.map(j => `${j.id} (${j.label})`).join(', ');
        const params = app.params.map(p => `${p.id} (token {{${p.token || p.id.toUpperCase()}}}): ${p.options.map(o => `${optionValue(o)}${typeof o === 'object' && o.label ? ` = ${o.label}` : ''}`).join(', ')}`).join('\n');
        return `You are the assistant in "${app.title || document.title}", a map and report of fixed panels about an area the reader chooses. You answer questions with data, by running SQL on DuckDB (with the spatial, h3 and httpfs extensions) through the query tool. Never invent numbers: every number you state comes from a query result or from current_view.

Area tokens. SQL you pass to query or add_card may use these tokens, which are expanded for the area the reader has chosen:
- {{AOI}}: a SELECT returning DISTINCT (h0, h8), the area's H3 cells at resolution 8.
- {{AOI10}}: a SELECT returning DISTINCT (h0, h8, h10), its cells at resolution 10. Prefer it for people and boundary-sensitive measures.
- {{ID}} and {{KIND}}: the area's id and type, for named areas only (not for drawn areas).
- Settings: ${params ? '\n' + params : 'none.'}
Join on h0 as well as the cell id, as the panel SQL below does: h0 is the partition key. Start with WITH aoi AS MATERIALIZED ({{AOI10}}).

Area types: ${types}${ex.ext.sources.length ? `, and ${ex.ext.sources.map(x => x.label).join(', ')}` : ''}.

Tools:
- current_view: the chosen area, settings and every panel's current results. Call it first when the question is about what the reader sees.
- query: run SQL and read the rows. Keep results small: aggregate, and LIMIT lists.
- add_card: show a result to the reader as a table or a bar chart. Use it whenever a table or chart helps; the reader can add the card to the report, where it re-runs for every area they pick, so write its SQL with the area tokens rather than with a fixed id where the question is about the chosen area, and do not name the area in its title or note. Select only the columns the reader needs, with readable names.
- select_area, set_param: change the area or a setting when the reader asks to.

Style: answer in a few plain sentences, with units, and say what the numbers cover. If a question cannot be answered from the data, say so.

${this.guidance ? `## App guidance\n${this.guidance}\n\n` : ''}## Panels and their SQL
These are the queries behind the panels; reuse their datasets, columns and joins.

${panels}

## Current state
${this.stateText()}`;
    }

    stateText() {
        const s = this.ex.state;
        const a = s.aoi;
        const area = a ? `Area: ${a.label} (type ${a.kind}${a.id != null && a.kind !== 'polygon' ? `, id ${a.id}` : ''}).` : 'No area is chosen yet; area tokens are unbound until the reader picks one or you call select_area.';
        const ps = this.app.params.map(p => `${p.label || p.id}: ${optionLabel(p, p.options.find(o => String(optionValue(o)) === String(s.params[p.id])) ?? s.params[p.id])}`).join('; ');
        return `${area}${ps ? `\nSettings: ${ps}.` : ''}`;
    }

    /* --------------------------------------------------------------- tools */

    tools() {
        return [
            {
                name: 'query',
                description: 'Run a DuckDB SQL query and return its rows as JSON. Area tokens such as {{AOI10}} are expanded for the chosen area.',
                inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'SQL, optionally with area tokens' } }, required: ['sql'] },
                execute: async ({ sql }) => {
                    const rows = await this.run(sql);
                    return clip({ row_count: rows.length, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS });
                },
            },
            {
                name: 'current_view',
                description: "The chosen area, the settings, and every panel's current results (first rows of each panel query).",
                inputSchema: { type: 'object', properties: {} },
                execute: () => this.currentView(),
            },
            {
                name: 'add_card',
                description: 'Show a query result to the reader as a table or a horizontal bar chart, in the chat; the reader can add it to the report. Write the SQL with area tokens when it is about the chosen area.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short noun-phrase title' },
                        sql: { type: 'string' },
                        chart: { type: 'string', enum: ['table', 'bar'] },
                        category: { type: 'string', description: 'bar: the column naming each bar' },
                        value: { type: 'string', description: 'bar: the numeric column' },
                        value_label: { type: 'string' },
                        format: { type: 'string', description: 'bar: number format, one of int, num, num1, pct (0-1), usd, acres, compact' },
                        note: { type: 'string', description: 'One sentence under the title saying what is shown' },
                    },
                    required: ['title', 'sql', 'chart'],
                },
                execute: async spec => {
                    if (spec.chart === 'bar' && !(spec.category && spec.value)) throw new Error('A bar card needs category and value columns.');
                    const rows = await this.run(spec.sql);
                    const id = `c${this.cards.size + 1}`;
                    this.cards.set(id, { spec, rows });
                    this.showCard(id);
                    return clip({ shown: true, card: id, row_count: rows.length, first_rows: rows.slice(0, 5) });
                },
            },
            {
                name: 'select_area',
                description: `Choose a named area, by area type and name. Area types: ${this.app.jurisdictions.map(j => j.id).join(', ')}.`,
                inputSchema: { type: 'object', properties: { type: { type: 'string' }, name: { type: 'string' } }, required: ['type', 'name'] },
                execute: async ({ type, name }) => {
                    const jur = this.app.jurisdictions.find(j => j.id === type || j.label.toLowerCase() === String(type).toLowerCase());
                    if (!jur) throw new Error(`Unknown area type ${type}.`);
                    const all = await this.ex.engine.listFeatures(jur, this.ex.state.params);
                    const q = String(name).toLowerCase();
                    const f = all.find(x => String(x.name).toLowerCase() === q) || all.find(x => String(x.name).toLowerCase().startsWith(q)) || all.find(x => String(x.name).toLowerCase().includes(q));
                    if (!f) throw new Error(`No ${jur.singular || jur.label} named ${name}.`);
                    if (this.ex.state.view !== 'profile') await this.ex.setView('profile');
                    if (this.ex.state.mode !== jur.id) await this.ex.setMode(jur.id);
                    this.ex.pick(f);
                    return { selected: f.name, type: jur.id, id: f.id };
                },
            },
            {
                name: 'set_param',
                description: `Change a setting. ${this.app.params.map(p => `${p.id}: ${p.options.map(optionValue).join(', ')}`).join('; ')}`,
                inputSchema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id', 'value'] },
                execute: async ({ id, value }) => {
                    const p = this.app.params.find(x => x.id === id);
                    if (!p) throw new Error(`Unknown setting ${id}.`);
                    if (!p.options.some(o => String(optionValue(o)) === String(value))) throw new Error(`${id} must be one of ${p.options.map(optionValue).join(', ')}.`);
                    await this.ex.setParam(id, value);
                    return { [id]: value };
                },
            },
        ];
    }

    async run(sql) {
        const aoi = this.ex.state.aoi;
        const expanded = aoi ? this.ex.engine.expandFor(sql, aoi, 'chat') : sql;
        if (/\{\{\w+\}\}/.test(expanded)) throw new Error('The SQL uses area tokens, but no area is chosen. Ask the reader to choose one, or call select_area.');
        return this.ex.engine.client.query(expanded, { aoi });
    }

    async currentView() {
        const ex = this.ex, aoi = ex.state.aoi;
        const out = { state: this.stateText(), panels: [] };
        if (!aoi) return out;
        for (const t of [ex.config.overview, ...ex.orderedThemes()].filter(Boolean)) {
            const res = {};
            await Promise.all(Object.keys(t.queries).map(async q => {
                try { res[q] = (await ex.engine.run(t, q, aoi)).slice(0, 20); } catch (err) { res[q] = `failed: ${err.message.slice(0, 200)}`; }
            }));
            out.panels.push({ panel: t.label, theme: t.id, results: res });
        }
        return clip(out);
    }

    /* ------------------------------------------------------------- display */

    add(html) {
        this.log.insertAdjacentHTML('beforeend', html);
        this.log.scrollTop = this.log.scrollHeight;
        return this.log.lastElementChild;
    }
    say(text) { this.add(`<div class="msg bot">${mdLite(text)}</div>`); }
    note(text, cls = '') { this.add(`<div class="msg note ${cls}">${escapeHtml(text)}</div>`); }
    thinking(on) {
        this.log.querySelector('.thinking')?.remove();
        if (on) this.add('<div class="msg thinking">Thinking…</div>');
    }
    showCalls(calls) {
        for (const c of calls || []) {
            let args = {};
            try { args = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments) : c.function?.arguments || {}; } catch { /* shown raw */ }
            const name = c.function?.name || c.name;
            const label = { query: 'Ran a query', current_view: 'Read the panels', add_card: 'Made a card', select_area: 'Chose an area', set_param: 'Changed a setting' }[name] || name;
            this.add(`<details class="msg call"><summary>${escapeHtml(label)}</summary>${args.sql ? `<pre>${escapeHtml(args.sql)}</pre>` : `<pre>${escapeHtml(JSON.stringify(args, null, 1))}</pre>`}</details>`);
        }
    }

    showCard(id) {
        const { spec, rows } = this.cards.get(id);
        const el = this.add(`<div class="msg card-msg"><section class="card chat-card"><h4>${escapeHtml(spec.title)}</h4>${spec.note ? `<p class="card-blurb">${escapeHtml(spec.note)}</p>` : ''}<div class="plot"></div></section><button type="button" class="ghost-btn chat-pin">Add to report</button></div>`);
        renderCardBody(el.querySelector('.plot'), spec, rows);
        const b = el.querySelector('.chat-pin');
        b.onclick = () => {
            this.pinned.push({ ...spec, id });
            b.disabled = true;
            b.textContent = 'Added to report';
            const r = this.ex.$('#report');
            if (this.ex.state.view === 'profile' && this.ex.state.aoi) {
                r.appendChild(this.pinnedCard(this.pinned[this.pinned.length - 1], this.ex.state.aoi, () => true));
                r.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        };
    }

    /** Cards added from chat, as live report panels re-run for this area. Called by the explorer after the themes. */
    renderPinned(report, aoi, isCurrent) {
        for (const spec of this.pinned) report.appendChild(this.pinnedCard(spec, aoi, isCurrent));
    }

    pinnedCard(spec, aoi, isCurrent) {
        const card = document.createElement('section');
        card.className = 'card theme-card chat-pinned';
        card.innerHTML = `
            <div class="card-head"><h3><span class="dot"></span>${escapeHtml(spec.title)}</h3><button type="button" class="ghost-btn" title="Remove from the report">Remove</button></div>
            ${spec.note ? `<p class="card-blurb">${escapeHtml(spec.note)}</p>` : ''}
            <div class="plot skeleton" style="height:80px"></div>
            <details class="method"><summary>Method &amp; SQL</summary><div class="method-body"><p>Added from the chat. The query re-runs for each area.</p><pre></pre></div></details>`;
        card.querySelector('.card-head button').onclick = () => {
            this.pinned = this.pinned.filter(p => p !== spec);
            card.remove();
        };
        const plot = card.querySelector('.plot');
        let sql = spec.sql;
        try { sql = this.ex.engine.expandFor(spec.sql, aoi, spec.title); } catch (err) { sql = `-- ${err.message}\n${spec.sql}`; }
        card.querySelector('pre').textContent = sql;
        this.run(spec.sql).then(rows => {
            if (!isCurrent()) return;
            plot.classList.remove('skeleton');
            plot.style.height = '';
            renderCardBody(plot, spec, rows);
        }).catch(err => {
            if (!isCurrent()) return;
            plot.classList.remove('skeleton');
            plot.style.height = '';
            plot.innerHTML = `<div class="err">Query failed for this area: ${escapeHtml(err.message.split('\n')[0].slice(0, 160))}</div>`;
        });
        return card;
    }
}

/** A card's table or bar chart. */
export function renderCardBody(el, spec, rows) {
    if (!rows?.length) { el.innerHTML = '<div class="sub">No rows for this area.</div>'; return; }
    if (spec.chart === 'bar') {
        renderBarChart(el, { category: spec.category, series: [{ field: spec.value, label: spec.value_label || spec.value }], format: spec.format || 'num', sort: 'desc', limit: 25 }, rows);
        return;
    }
    const cols = Object.keys(rows[0]).slice(0, 8);
    const cell = v => (typeof v === 'number' ? fmt(v, Number.isInteger(v) ? 'int' : 'num1') : v === null || v === undefined ? '—'
        : escapeHtml(Array.isArray(v) ? v.join('; ') : String(v).replace(/^(\d{4}-\d{2}-\d{2})[ T]00:00:00(\.0+)?Z?$/, '$1')));
    el.innerHTML = `<div class="table-wrap"><table class="chat-table"><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 50).map(r => `<tr>${cols.map(c => `<td class="${typeof r[c] === 'number' ? 'num' : ''}">${cell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > 50 ? `<div class="sub">First 50 of ${rows.length} rows.</div>` : ''}`;
}

/** JSON for the model, cut to MAX_CHARS. */
function clip(obj) {
    const s = JSON.stringify(obj);
    return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '… [truncated]' : s;
}

/** Minimal markdown: paragraphs, - lists, **bold**, `code`, [text](url) and bare URLs. */
export function mdLite(text) {
    const inline = t => escapeHtml(t)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return String(text || '').trim().split(/\n{2,}/).map(block => {
        const lines = block.split('\n');
        if (lines.every(l => /^\s*[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
        return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
}
