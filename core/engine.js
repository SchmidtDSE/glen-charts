/**
 * Query engine: loads the declarative config (area types + themes + SQL
 * templates), expands templates for an area of interest, runs them through a
 * query client (MCP or DuckDB-wasm), and caches results. Shared by the browser
 * app and scripts/precompute.mjs, so a precomputed number is exactly what the
 * live query returns.
 *
 * Template tokens
 *   {{AOI}}    → a SELECT returning DISTINCT (h0, h8) res-8 cells of the area.
 *   {{AOI10}}  → a SELECT returning DISTINCT (h0, h8, h10) res-10 cells.
 *   {{ID}}     → the sanitized feature id, in area-type aoi/aoi10 templates and,
 *                for a named area, in theme SQL ({{KIND}} is its area type).
 *                Unbound for the whole region, for drawn polygons and for
 *                several areas chosen together.
 *   {{IDS}}    → the named area's ids as a quoted SQL list ('06001', '06013'),
 *                bound for one area as well as several, for `x IN ({{IDS}})`.
 *   {{SITE}}   → (jurisdiction aoi/aoi10 templates) absolute URL of the site
 *                folder, for templates that read the site's own data files.
 *   {{<PARAM>}} → the current value of each app param (app.json "params",
 *                below), in every template, including the jurisdiction aoi and
 *                list queries.
 *   App-registered tokens: functions (aoi, app, params) → string, passed as
 *   `tokens` to the Engine (e.g. the assessment's {{LAND}}).
 *   An area may carry its own extra tokens in aoi.tokens (e.g. isochrone bands).
 *
 * Params (app.json)
 *   "params": [{ "id": "width", "label": "Band width", "token": "WIDTH",
 *                "options": [5, 10, 20, 50], "default": 10, "format": "{} km" }]
 *   A param's value is always one of its options, so it is safe to splice into
 *   SQL. It is part of every cache key and of precomputed file paths.
 *   With "multiple": true the value is a list of options (in option order) and
 *   the token is a SQL list, 'a', 'b' (bare numbers when every option is a
 *   number), for `x IN ({{TOKEN}})` or `[{{TOKEN}}]`. "any": <value> names an
 *   option that stands for all of them: it is exclusive, and an empty choice
 *   falls back to it. An option's "group" draws it under a heading that
 *   chooses the whole group (see toggleGroup).
 *   With "control": "range" the value is two of the options, which are ordered
 *   stops, [low, high], bound as {{TOKEN_MIN}} and {{TOKEN_MAX}} (or the two
 *   names in "tokens"). See rangeValue.
 *
 * Theme ids in app.json may be paths (e.g. "../config/themes/equity") so a
 * site variant can reuse another variant's themes; the id is the last segment.
 */

import { McpQueryClient } from './mcp.js';

export async function loadConfig(base = '.', fetchText = defaultFetchText, { themes: only = null } = {}) {
    const app = JSON.parse(await fetchText(`${base}/config/app.json`));
    app.jurisdictions ??= [];
    app.params ??= [];
    // the link and set_param separate a multiple param's values with commas
    for (const p of app.params) {
        if (!p.multiple) continue;
        const bad = p.options.map(optionValue).filter(v => String(v).includes(','));
        if (bad.length) console.warn(`Param "${p.id}" is multiple, but option values may not contain a comma: ${bad.join('; ')}`);
    }
    const themes = [];
    for (let id of [app.overview, ...(app.themes || [])].filter(Boolean)) {
        const dir = id.includes('/') ? `${base}/${id}` : `${base}/config/themes/${id}`;
        const path = id;
        id = id.split('/').pop();
        if (only && !only.includes(id)) continue;
        let theme;
        try {
            theme = JSON.parse(await fetchText(`${dir}/theme.json`));
        } catch (err) {
            if (path === app.overview) throw err;
            console.warn(`Skipping theme "${id}": ${err.message}`);
            continue;
        }
        theme.id = id;
        theme.dir = path.includes('/') ? path : `config/themes/${path}`;
        theme.sql = {};
        await Promise.all(Object.entries(theme.queries).map(async ([name, q]) => {
            theme.sql[name] = await fetchText(`${dir}/${q.file}`);
        }));
        themes.push(theme);
    }
    const hasOverview = !!app.overview && themes[0]?.id === app.overview.split('/').pop();
    return {
        app,
        overview: hasOverview ? themes[0] : null,
        themes: hasOverview ? themes.slice(1) : themes,
        themeById: Object.fromEntries(themes.map(t => [t.id, t])),
    };
}

async function defaultFetchText(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return res.text();
}

/** Ids are spliced into SQL string literals, so allow only safe characters (no quotes). */
export function sanitizeId(id) {
    const s = String(id);
    if (!/^[A-Za-z0-9 _.()-]{1,64}$/.test(s)) throw new Error(`Invalid id: ${s}`);
    return s;
}

/**
 * Fill {{TOKEN}}s in a SQL template. Tokens inside `--` line comments are
 * left as written, so a comment can name a token without needing it bound.
 * `where` names the template in the error for an unbound token.
 */
export function expand(template, tokens, where = '') {
    return template.split('\n').map(line => {
        const c = commentStart(line);
        const code = c < 0 ? line : line.slice(0, c);
        const filled = code.replace(/\{\{(\w+)\}\}/g, (m, k) => {
            if (!(k in tokens)) throw new Error(`Unbound template token ${m}${where ? ` in ${where}` : ''}; bound here: ${Object.keys(tokens).join(', ')}`);
            return tokens[k];
        });
        return c < 0 ? filled : filled + line.slice(c);
    }).join('\n');
}

/** SQL with its `--` comments removed (tokens in comments are never expanded). */
const stripComments = sql => String(sql ?? '').split('\n').map(line => { const c = commentStart(line); return c < 0 ? line : line.slice(0, c); }).join('\n');

/** Index of a `--` comment outside a quoted string, or -1. */
function commentStart(line) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"') q = ch;
        else if (ch === '-' && line[i + 1] === '-') return i;
    }
    return -1;
}

/* ------------------------------------------------------------------ params */

/**
 * Current param values: the given ones where valid, else each param's default.
 * A param with `when` (see matchesWhen) applies only at those settings of the
 * params before it; elsewhere it is held at its default, its control is hidden
 * and it is left out of paramKey. That makes a drill-down: an "agency" param
 * with "when": { "manager": "federal" }.
 */
export function resolveParams(app, given = {}) {
    const out = {};
    for (const p of app.params || []) {
        const want = given[p.id];
        if (p.control === 'range') {
            out[p.id] = (want !== undefined && matchesWhen(p.when, app, out) && rangeValue(p, want)) || paramDefault(p);
            continue;
        }
        if (p.multiple) {
            out[p.id] = want !== undefined && matchesWhen(p.when, app, out) ? multiValue(p, want) : paramDefault(p);
            continue;
        }
        const hit = want !== undefined && matchesWhen(p.when, app, out) && p.options.find(o => String(optionValue(o)) === String(want));
        out[p.id] = hit !== undefined && hit !== false ? optionValue(hit) : paramDefault(p);
    }
    return out;
}

/** A param's default value: `default`, else its first option; a list for a "multiple" param. */
export function paramDefault(p) {
    if (p.control === 'range') {
        const vals = p.options.map(optionValue);
        return rangeValue(p, p.default) || [vals[0], vals[vals.length - 1]];
    }
    const d = p.default ?? optionValue(p.options[0]);
    if (!p.multiple) return d;
    const v = multiValue(p, d, null);
    return v.length ? v : [optionValue(p.options[0])];
}

/**
 * A "multiple" param's value from a list, one value, or a comma-separated
 * string (as in the link): the options it names, in option order. "any"
 * (p.any, an option standing for all) is exclusive: given with others it is
 * dropped, and an empty choice falls back to it, or to the default.
 */
export function multiValue(p, want, fallback = undefined) {
    const raw = Array.isArray(want) ? want.map(String)
        : want === undefined || want === null || want === '' ? []
        : p.options.some(o => String(optionValue(o)) === String(want)) ? [String(want)]   // one value that holds a comma
        : String(want).split(',');
    let vals = p.options.map(optionValue).filter(v => raw.includes(String(v)));
    if (p.any !== undefined && vals.length > 1) vals = vals.filter(v => String(v) !== String(p.any));
    if (vals.length) return vals;
    if (fallback !== undefined) return fallback ?? [];
    return p.any !== undefined && p.options.some(o => String(optionValue(o)) === String(p.any)) ? [optionValue(p.options.find(o => String(optionValue(o)) === String(p.any)))] : paramDefault(p);
}

/**
 * The value after the reader clicks one pill of a "multiple" param: it is
 * added or removed; "any" clears the others, a specific pill clears "any",
 * and removing the last specific pill falls back to "any" (or keeps it, when
 * the param has none, so the choice is never empty).
 */
export function toggleMulti(p, current, value) {
    const cur = [].concat(current ?? []).map(String);
    const v = String(value);
    const isAny = p.any !== undefined && v === String(p.any);
    let next;
    if (isAny) next = [v];
    else if (cur.includes(v)) next = cur.filter(x => x !== v);
    else next = [...cur.filter(x => p.any === undefined || x !== String(p.any)), v];
    if (!next.length) return p.any !== undefined ? multiValue(p, [String(p.any)]) : multiValue(p, cur);
    return multiValue(p, next);
}

/**
 * A "control": "range" param's value from [low, high] or "low,high" (as in the
 * link): two of its options, low first, or null when either is not an option.
 */
export function rangeValue(p, want) {
    if (want === undefined || want === null) return null;
    const parts = Array.isArray(want) ? want : String(want).split(',');
    if (parts.length !== 2) return null;
    const vals = p.options.map(optionValue);
    let [i, j] = parts.map(x => vals.findIndex(v => String(v) === String(x).trim()));
    if (i < 0 || j < 0) return null;
    if (i > j) [i, j] = [j, i];
    return [vals[i], vals[j]];
}

/** The template tokens a param binds: its token, or a range param's two. */
export function paramTokenNames(p) {
    const t = p.token || p.id.toUpperCase();
    return p.control === 'range' ? (p.tokens || [`${t}_MIN`, `${t}_MAX`]) : [t];
}

/**
 * The value after the reader clicks a group heading of a "multiple" param (the
 * options with that "group"): the whole group is added, or removed when all of
 * it is already chosen. Like toggleMulti, it clears "any" and never leaves the
 * choice empty.
 */
export function toggleGroup(p, current, group) {
    const cur = [].concat(current ?? []).map(String);
    const members = p.options.filter(o => o && typeof o === 'object' && o.group === group).map(o => String(optionValue(o)));
    const all = members.length > 0 && members.every(v => cur.includes(v));
    let next = all ? cur.filter(v => !members.includes(v)) : [...cur, ...members];
    if (p.any !== undefined) next = next.filter(v => v !== String(p.any));
    if (!next.length) return p.any !== undefined ? multiValue(p, [String(p.any)]) : multiValue(p, cur);
    return multiValue(p, next);
}

/** A param's value as a list: the value of a "multiple" param, or [value]. */
export const paramValues = (p, v) => (Array.isArray(v) ? v : [v]);

/** Whether a param applies at the current settings (its `when`, if any, matches). */
export const paramActive = (p, app, params = {}) => matchesWhen(p.when, app, params);

/**
 * Whether a config item applies at the current settings. `when` maps a param id
 * to a value or a list of values: { "manager": "all" } or { "manager": ["federal", "state"] }.
 * Every param named must match; an item without `when` always applies. Used for
 * headlines, charts, chart series, app.reference and params themselves.
 */
export function matchesWhen(when, app, params = {}) {
    if (!when) return true;
    return Object.entries(when).every(([id, want]) => {
        const p = (app.params || []).find(x => x.id === id);
        // a "multiple" param matches when every value chosen is one the item names
        const vs = paramValues(p, params[id] ?? (p ? paramDefault(p) : undefined)).map(String);
        const ws = (Array.isArray(want) ? want : [want]).map(String);
        return vs.length > 0 && vs.every(v => ws.includes(v));
    });
}

/** An option is a bare value or { value, label }. */
export const optionValue = o => (o && typeof o === 'object' ? o.value : o);
export const optionLabel = (p, o) => {
    if (o && typeof o === 'object' && o.label) return o.label;
    const v = optionValue(o);
    // a relative param's value is an offset from an area's base value: show its sign
    const text = p.relative && Number(v) > 0 ? `+${v}` : p.relative && Number(v) < 0 ? `−${Math.abs(Number(v))}` : String(v);
    const f = (p.relative && p.relative.offset_format) || p.format;
    return f ? f.replace('{}', text) : text;
};

/** The label of a param's current value: its option's label, or, for a "multiple" param, the labels joined. */
export function paramValueLabel(p, value) {
    if (p.control === 'range') {
        const r = rangeValue(p, value);
        if (!r) return String(value);
        const vals = p.options.map(optionValue);
        const label = v => optionLabel(p, p.options.find(o => String(optionValue(o)) === String(v)));
        if (p.all_label && String(r[0]) === String(vals[0]) && String(r[1]) === String(vals[vals.length - 1])) return p.all_label;
        return String(r[0]) === String(r[1]) ? label(r[0]) : `${label(r[0])} – ${label(r[1])}`;
    }
    return paramValues(p, value).map(v => {
        const o = p.options.find(x => String(optionValue(x)) === String(v));
        return o === undefined ? String(v) : optionLabel(p, o);
    }).join(', ');
}

/**
 * The option nearest to a typed number, so a number box still sets one of the param's options
 * (and so stays safe in SQL). A value past either end is held to that end.
 */
export function nearestOption(p, x) {
    let best = optionValue(p.options[0]);
    for (const o of p.options) {
        const v = optionValue(o);
        if (Math.abs(Number(v) - x) < Math.abs(Number(best) - x)) best = v;
    }
    return best;
}

/** { WIDTH: '10', ... } for template expansion. */
export function paramTokens(app, params = {}) {
    const out = {};
    for (const p of app.params || []) {
        const v = params[p.id] ?? paramDefault(p);
        if (p.control === 'range') {
            const r = rangeValue(p, v);
            if (!r) throw new Error(`Invalid value for ${p.id}: ${v}`);
            const [lo, hi] = paramTokenNames(p);
            out[lo] = String(r[0]);
            out[hi] = String(r[1]);
            continue;
        }
        const vs = p.multiple ? paramValues(p, v) : [v];
        for (const x of vs) if (!p.options.some(o => String(optionValue(o)) === String(x))) throw new Error(`Invalid value for ${p.id}: ${x}`);
        if (p.multiple && !vs.length) throw new Error(`No value for ${p.id}`);
        out[p.token || p.id.toUpperCase()] = p.multiple ? sqlList(vs, p.options.every(o => typeof optionValue(o) === 'number')) : String(v);
    }
    return out;
}

/** 'a', 'b' (quotes doubled), or 1, 2 for numbers: a list to splice into IN (...) or [...]. */
export const sqlList = (vals, numeric = false) => vals.map(v => (numeric ? String(Number(v)) : `'${String(v).replace(/'/g, "''")}'`)).join(', ');

/**
 * "width-10" (sorted by id), or '' when the app has no params. File and cache key part.
 * A param whose `when` does not match is left out, so adding a drill-down param does
 * not rename the files of the settings it does not apply to.
 */
export function paramKey(app, params = {}) {
    return (app.params || []).filter(p => paramActive(p, app, params)).sort((a, b) => a.id.localeCompare(b.id))
        .map(p => `${p.id}-${paramValues(p, params[p.id] ?? paramDefault(p)).map(v => String(v).replace(/[^A-Za-z0-9.]+/g, '_')).join('~')}`).join('_');
}

/**
 * The file and cache key part for one query: like paramKey, but over only the
 * params the query declares it uses ("params": ["width"]; [] for none), so a
 * query that ignores the settings is precomputed once rather than per combination.
 */
export function queryParamKey(app, q, params = {}) {
    if (!Array.isArray(q?.params)) return paramKey(app, params);
    return paramKey({ params: (app.params || []).filter(p => q.params.includes(p.id)) }, params);
}

/**
 * Every combination of param values: [{ width: 5 }, { width: 10 }, ...]. For a
 * "multiple" param, 'all' takes each option on its own ([v]), not every subset;
 * a comma-separated pick ("a,b") is one list. For a "range" param, 'all' takes
 * every span (low <= high) and "a,b" one span.
 */
export function paramCombos(app, pick = {}) {
    let combos = [{}];
    for (const p of app.params || []) {
        const want = pick[p.id];
        const opts = p.options.map(optionValue);
        const vals = p.control === 'range'
            ? (want === 'all' ? opts.flatMap((a, i) => opts.slice(i).map(b => [a, b])) : [want !== undefined ? rangeValue(p, want) || paramDefault(p) : paramDefault(p)])
            : p.multiple
            ? (want === 'all' ? p.options.map(o => [optionValue(o)]) : [want !== undefined ? multiValue(p, want) : paramDefault(p)])
            : want === 'all' ? p.options.map(optionValue)
            : want !== undefined ? [optionValue(p.options.find(o => String(optionValue(o)) === String(want)) ?? p.default ?? p.options[0])]
            : [p.default ?? optionValue(p.options[0])];
        combos = combos.flatMap(c => vals.map(v => ({ ...c, [p.id]: v })));
    }
    // a param held at its default where its `when` does not match: keep each setting once
    const seen = new Set();
    return combos.map(c => resolveParams(app, c)).filter(c => {
        const k = JSON.stringify(c);
        return !seen.has(k) && seen.add(k);
    });
}

/* -------------------------------------------------------------------- areas */

/**
 * An AOI is { key, kind, id, label, sql, sql10, params } where sql yields
 * DISTINCT (h0, h8) and sql10 DISTINCT (h0, h8, h10). Jurisdictions build
 * theirs from config; area sources (polygons, isochrones) build their own —
 * the themes don't care which.
 */
export function jurisdictionAoi(jur, feature, app = null, params = {}) {
    // several features (an area type with "multiple": true): the union of their cells
    if (Array.isArray(feature)) {
        if (feature.length === 1) return jurisdictionAoi(jur, feature[0], app, params);
        return multiAoi(jur, feature, app, params);
    }
    const id = sanitizeId(feature.id);
    const SITE = siteUrl();
    const pt = app ? paramTokens(app, params) : {};
    const pk = app ? paramKey(app, params) : '';
    return {
        key: `${jur.id}:${id}${pk ? '@' + pk : ''}`,
        kind: jur.id,
        id,
        ids: [id],
        label: feature.name,
        params,
        sql: expand(jur.aoi, { ...pt, ID: id, SITE }).trim(),
        sql10: jur.aoi10 ? expand(jur.aoi10, { ...pt, ID: id, SITE }).trim() : undefined,
    };
}

const siteUrl = () => (globalThis.location ? new URL('.', globalThis.location.href).href.replace(/\/$/, '') : '.');

/**
 * Several features of one area type as one area: sql and sql10 are the UNION of
 * each feature's cells. `id` is null (so {{ID}} is unbound and no precomputed
 * single-area rows are used); `ids` lists them, and {{IDS}} is their SQL list.
 */
function multiAoi(jur, features, app, params) {
    const ids = features.map(f => sanitizeId(f.id));
    const SITE = siteUrl();
    const pt = app ? paramTokens(app, params) : {};
    const pk = app ? paramKey(app, params) : '';
    // the ) on its own line, so a template ending in a -- comment does not swallow it
    const union = tpl => ids.map(id => `SELECT * FROM (\n${expand(tpl, { ...pt, ID: id, SITE }).trim().replace(/;\s*$/, '')}\n)`).join('\nUNION\n');
    return {
        // sorted, so the same areas chosen in another order share cached results
        key: `${jur.id}:${[...ids].sort().join('+')}${pk ? '@' + pk : ''}`,
        kind: jur.id,
        id: null,
        ids,
        label: listLabel(features.map(f => f.name)),
        params,
        sql: union(jur.aoi),
        sql10: jur.aoi10 ? union(jur.aoi10) : undefined,
    };
}

/** "A", "A and B", "A, B and C". */
export const listLabel = names => (names.length <= 1 ? String(names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The whole-region area, or null when the app has none (app.statewide absent). */
export function statewideAoi(app, params = {}) {
    const s = app.statewide;
    if (!s) return null;
    const pt = paramTokens(app, params);
    const pk = paramKey(app, params);
    return {
        key: 'statewide' + (pk ? '@' + pk : ''), kind: 'state', id: s.id || 'all', label: s.label || 'All',
        params,
        sql: expand(s.aoi, pt).trim(), sql10: s.aoi10 ? expand(s.aoi10, pt).trim() : undefined,
        cells: s.cells?.trim(),
    };
}

export class Engine {
    /**
     * client:   anything with query(sql, { aoi }) → rows; defaults to the MCP client.
     * dataBase: folder holding data/ (pick lists, precomputed results), relative
     *           to the page; null disables precomputed files (Node).
     * statewide: precomputed whole-region results { results: { theme: { query: rows } } }
     * tokens:   app-registered template tokens { NAME: (aoi, app, params) → string }
     */
    constructor(config, { mcpUrl, statewide = null, client = null, dataBase = '.', tokens = {} } = {}) {
        this.config = config;
        this.client = client || new McpQueryClient(mcpUrl || config.app.mcp_url);
        this.dataBase = dataBase;
        this.tokens = tokens;
        this.cache = new Map();          // key → Promise<rows>
        this.statewide = statewide;
    }

    /** Every template token bound for an area: AOI, AOI10, ID and KIND (named areas), params, source and app tokens. */
    tokensFor(aoi) {
        const app = this.config.app;
        const params = aoi.params || {};
        const tokens = { ...paramTokens(app, params), AOI: aoi.sql, AOI10: aoi.sql10 ?? '' };
        if (aoi.id != null && aoi.kind && aoi.kind !== 'polygon') { tokens.ID = String(aoi.id); tokens.KIND = aoi.kind; }
        // an area built with only an id (e.g. by an extension source) still binds {{IDS}}
        const ids = aoi.ids ?? (aoi.id != null ? [aoi.id] : null);
        if (ids?.length && aoi.kind && aoi.kind !== 'polygon' && aoi.kind !== 'state') { tokens.IDS = sqlList(ids); tokens.KIND = aoi.kind; }
        if (aoi.bands10) tokens.BANDS10 = aoi.bands10;
        if (aoi.origin) { tokens.ORIGIN_LAT = String(+aoi.origin.lat); tokens.ORIGIN_LON = String(+aoi.origin.lon); }
        Object.assign(tokens, aoi.tokens || {});
        for (const [name, fn] of Object.entries(this.tokens)) tokens[name] = fn(aoi, app, params);
        return tokens;
    }

    sqlFor(theme, queryName, aoi) {
        // {{ID}} names one area: say so plainly rather than "unbound token" when several are chosen
        if (aoi.id == null && aoi.ids?.length > 1 && /\{\{ID\}\}/.test(stripComments(theme.sql[queryName]))) {
            throw new Error('This panel shows one area at a time. Choose a single area to see it.');
        }
        return expand(theme.sql[queryName], this.tokensFor(aoi), `${theme.id}/${theme.queries[queryName]?.file || queryName}`);
    }

    /** Any SQL template (e.g. one written in chat) expanded for an area. */
    expandFor(sql, aoi, where = '') {
        return expand(sql, this.tokensFor(aoi), where);
    }

    run(theme, queryName, aoi) {
        // keyed by only the params the query uses, so changing another setting reuses its rows
        const pk = queryParamKey(this.config.app, theme.queries[queryName], aoi.params || {});
        const key = `${aoi.key.split('@')[0]}@${pk}|${theme.id}|${queryName}`;
        if (!this.cache.has(key)) {
            // precomputed rows for a named area when they exist, else live; the
            // SQL is expanded only when it has to run, so a template problem
            // never hides rows that were already computed
            const p = this.precomputed(theme, queryName, aoi).then(rows => {
                if (rows) return rows;
                const sql = this.sqlFor(theme, queryName, aoi);
                return this.client.query(sql, { aoi }).catch(err => { err.sql = sql; throw err; });
            }).catch(err => {
                this.cache.delete(key);          // let a retry re-run it
                throw err;
            });
            this.cache.set(key, p);
        }
        return this.cache.get(key);
    }

    _json(key, url) {
        if (!this.cache.has(key)) {
            this.cache.set(key, typeof fetch === 'undefined' || this.dataBase == null ? Promise.resolve(null)
                : fetch(url, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null));
        }
        return this.cache.get(key);
    }

    /** "<kind>/" or "<kind>/<paramKey>/" — the folder part of per-area files. */
    _areaDir(aoi) {
        const pk = paramKey(this.config.app, aoi.params || {});
        return `${aoi.kind}/${pk ? pk + '/' : ''}`;
    }

    /**
     * A query's precomputed rows for the whole region (data/statewide.json, or
     * data/statewide/<paramKey>.json for an app with params), or a named
     * area, or null. Two layouts for a named area:
     *   data/areas/<kind>[/<paramKey>]/<id>.json   every query of every theme
     *     for one area (`precompute areas`)
     *   data/results/<theme>/<query>/<kind>[-<paramKey>].json   one query for
     *     every area, {id: rows}, for queries with an "all" SQL file
     *     (`precompute results`)
     */
    async precomputed(theme, queryName, aoi) {
        if (aoi.kind === 'state') return this.statewideRows(theme, queryName, aoi.params || {});
        if (!aoi.id || !aoi.kind || aoi.kind === 'polygon') return null;
        const byId = await this.allResults(theme, queryName, aoi);
        const hit = byId?.[aoi.id] ?? byId?.[String(Number(aoi.id))];
        if (hit) return hit;          // an id missing from the file runs live
        const area = await this.areaFile(aoi);
        return area?.results?.[theme.id]?.[queryName] ?? null;
    }

    /** {id: rows} for every area of the AOI's kind and params, when the query has an "all" file and it was precomputed. */
    allResults(theme, queryName, aoi) {
        if (!allFile(theme.queries[queryName])) return Promise.resolve(null);
        const pk = queryParamKey(this.config.app, theme.queries[queryName], aoi.params || {});
        const name = `${aoi.kind}${pk ? '-' + pk : ''}`;
        return this._json(`results|${theme.id}|${queryName}|${name}`, `${this.dataBase}/data/results/${theme.id}/${queryName}/${name}.json`);
    }

    /** The per-area file (data/areas/...), or null. */
    areaFile(aoi) {
        if (!aoi.id || !aoi.kind || aoi.kind === 'state' || aoi.kind === 'polygon') return Promise.resolve(null);
        return this._json(`area|${aoi.key}`, `${this.dataBase}/data/areas/${this._areaDir(aoi)}${encodeURIComponent(aoi.id)}.json`);
    }

    /** The region's precomputed rows for one query, or null. */
    async statewideRows(theme, queryName, params = {}) {
        const pk = queryParamKey(this.config.app, theme.queries[queryName], params);
        if (!pk) return this.statewide?.results?.[theme.id]?.[queryName] ?? null;
        const f = await this._json(`statewide|${pk}`, `${this.dataBase}/data/statewide/${pk}.json`);
        return f?.results?.[theme.id]?.[queryName] ?? null;
    }

    /**
     * Whole-region comparison rows: precomputed file first, live query as
     * fallback (none for a query marked "statewide": false); null without a region.
     */
    runStatewide(theme, queryName, params = {}) {
        const aoi = statewideAoi(this.config.app, params);
        if (!aoi) return Promise.resolve(null);
        if (theme.queries[queryName].statewide === false) return this.statewideRows(theme, queryName, params);
        return this.run(theme, queryName, aoi);
    }

    /**
     * Every area of the AOI's kind (and params) for one theme's query:
     * [{ __id, ...row }]. From the query's precomputed "all" results when
     * present, else data/distributions/<kind>[/<paramKey>]/<theme>.json
     * (`precompute distributions`, built from per-area files); null when neither exists.
     */
    async distribution(theme, queryName, aoi) {
        if (!aoi.kind || aoi.kind === 'state' || aoi.kind === 'polygon') return null;
        const byId = await this.allResults(theme, queryName, aoi);
        if (byId) return Object.entries(byId).flatMap(([id, rows]) => rows.map(r => ({ __id: id, ...r })));
        const f = await this._json(`dist|${this._areaDir(aoi)}|${theme.id}`, `${this.dataBase}/data/distributions/${this._areaDir(aoi)}${theme.id}.json`);
        return f?.results?.[queryName] ?? null;
    }

    /**
     * Precomputed peer table for a theme and jurisdiction type
     * (data/peers/<theme>/<jur>.json, written by `precompute peers`); null when absent.
     */
    peers(themeId, jurId) {
        return this._json(`peers|${themeId}|${jurId}`, `${this.dataBase}/data/peers/${themeId}/${jurId}.json`);
    }

    /** Pick list for a jurisdiction type: precomputed file first, then live. */
    async listFeatures(jur, params = {}) {
        const pk = jur.list_params ? paramKey(this.config.app, params) : '';
        const key = `list|${jur.id}|${pk}`;
        if (!this.cache.has(key)) {
            this.cache.set(key, (async () => {
                const pre = await this._json(`listfile|${jur.id}|${pk}`, `${this.dataBase}/data/lists/${jur.id}${pk ? '-' + pk : ''}.json`);
                if (pre) return pre;
                return this.client.query(expand(jur.list, paramTokens(this.config.app, params)));
            })());
        }
        return this.cache.get(key);
    }
}

/** A query's all-areas SQL file ("all", or tpl-cities' older "precompute"), or null. */
export const allFile = q => q?.all || q?.precompute || null;
