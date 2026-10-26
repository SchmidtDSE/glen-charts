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
 *                Unbound for the whole region and for drawn polygons.
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
 *
 * Theme ids in app.json may be paths (e.g. "../config/themes/equity") so a
 * site variant can reuse another variant's themes; the id is the last segment.
 */

import { McpQueryClient } from './mcp.js';

export async function loadConfig(base = '.', fetchText = defaultFetchText, { themes: only = null } = {}) {
    const app = JSON.parse(await fetchText(`${base}/config/app.json`));
    app.jurisdictions ??= [];
    app.params ??= [];
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

/** Current param values: the given ones where valid, else each param's default. */
export function resolveParams(app, given = {}) {
    const out = {};
    for (const p of app.params || []) {
        const want = given[p.id];
        const hit = want !== undefined && p.options.find(o => String(optionValue(o)) === String(want));
        out[p.id] = hit !== undefined && hit !== false ? optionValue(hit) : (p.default ?? optionValue(p.options[0]));
    }
    return out;
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

/** { WIDTH: '10', ... } for template expansion. */
export function paramTokens(app, params = {}) {
    const out = {};
    for (const p of app.params || []) {
        const v = params[p.id] ?? p.default;
        if (!p.options.some(o => String(optionValue(o)) === String(v))) throw new Error(`Invalid value for ${p.id}: ${v}`);
        out[p.token || p.id.toUpperCase()] = String(v);
    }
    return out;
}

/** "width-10" (sorted by id), or '' when the app has no params. File and cache key part. */
export function paramKey(app, params = {}) {
    return (app.params || []).slice().sort((a, b) => a.id.localeCompare(b.id))
        .map(p => `${p.id}-${String(params[p.id] ?? p.default).replace(/[^A-Za-z0-9.]+/g, '_')}`).join('_');
}

/** Every combination of param values: [{ width: 5 }, { width: 10 }, ...]. */
export function paramCombos(app, pick = {}) {
    let combos = [{}];
    for (const p of app.params || []) {
        const want = pick[p.id];
        const vals = want === 'all' ? p.options.map(optionValue)
            : want !== undefined ? [resolveParams(app, { [p.id]: want })[p.id]]
            : [p.default ?? optionValue(p.options[0])];
        combos = combos.flatMap(c => vals.map(v => ({ ...c, [p.id]: v })));
    }
    return combos;
}

/* -------------------------------------------------------------------- areas */

/**
 * An AOI is { key, kind, id, label, sql, sql10, params } where sql yields
 * DISTINCT (h0, h8) and sql10 DISTINCT (h0, h8, h10). Jurisdictions build
 * theirs from config; area sources (polygons, isochrones) build their own —
 * the themes don't care which.
 */
export function jurisdictionAoi(jur, feature, app = null, params = {}) {
    const id = sanitizeId(feature.id);
    const SITE = globalThis.location ? new URL('.', globalThis.location.href).href.replace(/\/$/, '') : '.';
    const pt = app ? paramTokens(app, params) : {};
    const pk = app ? paramKey(app, params) : '';
    return {
        key: `${jur.id}:${id}${pk ? '@' + pk : ''}`,
        kind: jur.id,
        id,
        label: feature.name,
        params,
        sql: expand(jur.aoi, { ...pt, ID: id, SITE }).trim(),
        sql10: jur.aoi10 ? expand(jur.aoi10, { ...pt, ID: id, SITE }).trim() : undefined,
    };
}

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

    sqlFor(theme, queryName, aoi) {
        const app = this.config.app;
        const params = aoi.params || {};
        const tokens = { ...paramTokens(app, params), AOI: aoi.sql, AOI10: aoi.sql10 ?? '' };
        if (aoi.id != null && aoi.kind && aoi.kind !== 'polygon') { tokens.ID = String(aoi.id); tokens.KIND = aoi.kind; }
        if (aoi.bands10) tokens.BANDS10 = aoi.bands10;
        if (aoi.origin) { tokens.ORIGIN_LAT = String(+aoi.origin.lat); tokens.ORIGIN_LON = String(+aoi.origin.lon); }
        Object.assign(tokens, aoi.tokens || {});
        for (const [name, fn] of Object.entries(this.tokens)) tokens[name] = fn(aoi, app, params);
        return expand(theme.sql[queryName], tokens, `${theme.id}/${theme.queries[queryName]?.file || queryName}`);
    }

    run(theme, queryName, aoi) {
        const key = `${aoi.key}|${theme.id}|${queryName}`;
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
        const pk = paramKey(this.config.app, aoi.params || {});
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
        const pk = paramKey(this.config.app, params);
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
