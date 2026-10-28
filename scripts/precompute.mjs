#!/usr/bin/env node
/**
 * Precompute the slow, shared results so an app opens fast. Uses the same
 * engine + query client as the browser, so a precomputed number is exactly
 * what the live query returns.
 *
 *   data/lists/<jur>[-<paramKey>].json           pick lists (id, name, bbox)
 *   data/statewide.json                          every query over the whole region
 *   data/statewide/<paramKey>.json               (apps with params)
 *   data/areas/<jur>[/<paramKey>]/<id>.json      every query for one area
 *   data/results/<theme>/<query>/<jur>[-<paramKey>].json
 *                                                one query for every area, {id: rows},
 *                                                from the query's "all" SQL file
 *   data/distributions/<jur>[/<paramKey>]/<theme>.json
 *                                                every area's rows per query, built
 *                                                from the area files (no queries)
 *   data/peers/<theme>/<jur>.json                a theme's "peers" SQL per area type
 *   data/sources.json                            STAC records of every dataset read
 *   data/baselines/<country>/<preset>.json       compare mode: a catalog preset's units scored
 *                                                on every theme
 *
 *   glen-charts precompute [--site <app dir>] <job> [args] [flags]
 *     lists [jur ...]
 *     statewide [theme ...]
 *     areas <jur> [id ...]          skips files already written unless --force
 *     results [theme ...]           --jur a,b limits the area types
 *     distributions <jur>
 *     peers [theme ...]
 *     sources
 *     baselines [country ...]       compare mode: every catalog preset's units on every theme,
 *                                   per country (default: compare.precompute.countries);
 *                                   --preset a,b limits presets, --theme a,b re-runs only those themes
 *     (no job)                      lists, statewide, sources
 *   flags:
 *     --site <dir>       the app folder holding config/ and data/ (default: .)
 *     --theme a,b        areas: re-run only these themes in files already written
 *     --param id=v       a param value; id=all for every option (default: each param's default)
 *     --force            areas: rewrite files already written
 *   env: MCP_URL overrides app.mcp_url; MCP_TIMEOUT_MS overrides the 300 s query timeout
 *        (for a local query server running whole-catalog scans).
 *
 * An app's extensions module (app.json "extensions", e.g. "app/extensions.js")
 * is imported for its template tokens, and for its overlays' tile URLs, which
 * `sources` cites; its imports of glen-charts from jsDelivr resolve to this
 * copy of the library.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, Engine, statewideAoi, jurisdictionAoi, expand, paramKey, paramCombos, paramTokens, allFile } from '../core/engine.js';
import { dataPaths, pathPrefix } from '../core/sources.js';
import { McpQueryClient } from '../core/mcp.js';
import { countryTokens, presetsFor, presetUnitsSql, withStrata, strataNamesSql } from '../sources/units.js';

register('./resolve-cdn.mjs', import.meta.url);

const argv = process.argv.slice(2);
if (argv[0] === 'precompute') argv.shift();
const flag = (name, n = 1) => {
    const at = argv.indexOf(name);
    if (at < 0) return null;
    return argv.splice(at, n + 1).slice(1);
};
const force = !!flag('--force', 0);
const site = flag('--site')?.[0] || '.';
const onlyThemes = flag('--theme')?.[0]?.split(',') || null;
const jurFilter = flag('--jur')?.[0]?.split(',') || null;
const presetPick = flag('--preset')?.[0]?.split(',') || null;
const paramPick = {};
for (let p; (p = flag('--param')); ) { const [k, v] = p[0].split('='); paramPick[k] = v; }

const root = resolve(process.cwd(), site);
const fetchText = p => readFile(p, 'utf8');
const [what = 'all', ...only] = argv;
const overviewId = JSON.parse(await fetchText(`${root}/config/app.json`)).overview?.split('/').pop();
const themeFilter = what === 'lists' ? [overviewId]
    : (what === 'statewide' || what === 'results' || what === 'peers') && only.length ? [overviewId, ...only] : null;
const config = await loadConfig(root, fetchText, themeFilter ? { themes: themeFilter } : {});
const app = config.app;
let tokens = {}, overlays = [];
if (app.extensions) {
    const mod = await import(pathToFileURL(resolve(root, app.extensions)).href);
    ({ tokens = {}, overlays = [] } = mod.default || mod);
}
const mcpUrl = process.env.MCP_URL || app.mcp_url;
const client = process.env.MCP_TIMEOUT_MS ? new McpQueryClient(mcpUrl, { timeoutMs: Number(process.env.MCP_TIMEOUT_MS) }) : null;
const engine = new Engine(config, { mcpUrl, client, dataBase: null, tokens });
const combos = paramCombos(app, paramPick);
const allThemes = [config.overview, ...config.themes].filter(Boolean);
const secs = t0 => ((Date.now() - t0) / 1000).toFixed(1);

if (what === 'all' || what === 'lists') {
    await mkdir(`${root}/data/lists`, { recursive: true });
    for (const jur of app.jurisdictions) {
        if (what === 'lists' && only.length && !only.includes(jur.id)) continue;
        for (const params of jur.list_params ? combos : [{}]) {
            const pk = jur.list_params ? paramKey(app, params) : '';
            const t0 = Date.now();
            const rows = await engine.client.query(expand(jur.list, paramTokens(app, params)));
            await writeFile(`${root}/data/lists/${jur.id}${pk ? '-' + pk : ''}.json`, JSON.stringify(rows));
            console.log(`list ${jur.id}${pk ? ' ' + pk : ''}: ${rows.length} rows (${secs(t0)}s)`);
        }
    }
}

if ((what === 'all' || what === 'statewide') && app.statewide) {
    for (const params of combos) {
        const pk = paramKey(app, params);
        const file = pk ? `${root}/data/statewide/${pk}.json` : `${root}/data/statewide.json`;
        if (pk) await mkdir(`${root}/data/statewide`, { recursive: true });
        let out = { generated: null, results: {} };
        try { out = JSON.parse(await readFile(file, 'utf8')); } catch { /* fresh */ }
        const aoi = statewideAoi(app, params);
        for (const theme of allThemes) {
            if (only.length && !only.includes(theme.id)) continue;
            out.results[theme.id] ??= {};
            for (const [name, q] of Object.entries(theme.queries)) {
                if (q.statewide === false) continue;
                const t0 = Date.now();
                try {
                    out.results[theme.id][name] = await engine.client.query(engine.sqlFor(theme, name, aoi));
                    console.log(`statewide${pk ? ' ' + pk : ''} ${theme.id}.${name}: ok (${secs(t0)}s)`);
                } catch (err) {
                    console.error(`statewide${pk ? ' ' + pk : ''} ${theme.id}.${name}: FAILED — ${err.message.split('\n')[0]}`);
                }
            }
        }
        out.generated = new Date().toISOString();
        await writeFile(file, JSON.stringify(out, null, 1));
    }
}

if (what === 'areas') {
    const [jurId, ...ids] = only;
    const jur = app.jurisdictions.find(j => j.id === jurId);
    if (!jur) throw new Error(`Unknown area type ${jurId}`);
    for (const params of combos) {
        const pk = paramKey(app, params);
        const list = JSON.parse(await readFile(`${root}/data/lists/${jur.id}${jur.list_params && pk ? '-' + pk : ''}.json`, 'utf8'));
        const dir = `${root}/data/areas/${jur.id}${pk ? '/' + pk : ''}`;
        await mkdir(dir, { recursive: true });
        for (const f of list) {
            if (ids.length && !ids.includes(String(f.id))) continue;
            const file = `${dir}/${f.id}.json`;
            let prior = null;
            try { prior = JSON.parse(await readFile(file, 'utf8')); } catch { /* not yet */ }
            if (prior && !force && !onlyThemes) continue;
            const aoi = jurisdictionAoi(jur, f, app, params);
            const out = onlyThemes && prior ? prior : { generated: null, id: f.id, name: f.name, results: {} };
            let failed = 0;
            const t0 = Date.now();
            for (const theme of allThemes) {
                if (onlyThemes && prior && !onlyThemes.includes(theme.id)) continue;
                out.results[theme.id] = {};
                for (const name of Object.keys(theme.queries)) {
                    try {
                        out.results[theme.id][name] = await engine.client.query(engine.sqlFor(theme, name, aoi));
                    } catch (err) {
                        failed++;
                        console.error(`  ${f.name} ${theme.id}.${name}: FAILED — ${err.message.split('\n')[0]}`);
                    }
                }
            }
            out.generated = new Date().toISOString();
            if (!failed) await writeFile(file, JSON.stringify(out));
            console.log(`areas ${jur.id}${pk ? ' ' + pk : ''} ${f.name}: ${failed ? `${failed} failed, not written` : 'ok'} (${secs(t0).replace(/\.\d$/, '')}s)`);
        }
    }
}

if (what === 'results') {
    for (const theme of allThemes) {
        if (only.length && !only.includes(theme.id)) continue;
        for (const [name, q] of Object.entries(theme.queries)) {
            if (!allFile(q)) continue;
            const sql = await fetchText(`${root}/${theme.dir}/${allFile(q)}`);
            await mkdir(`${root}/data/results/${theme.id}/${name}`, { recursive: true });
            for (const jur of app.jurisdictions) {
                if (jurFilter && !jurFilter.includes(jur.id)) continue;
                if (/\{\{CELLS10\}\}/.test(sql) && !jur.cells10) continue;
                for (const params of combos) {
                    const pk = paramKey(app, params);
                    const t0 = Date.now();
                    try {
                        const byId = {};
                        const toks = { ...paramTokens(app, params), KIND: jur.id, ...(jur.cells10 ? { CELLS10: jur.cells10 } : {}) };
                        for (const { id, ...row } of await engine.client.query(expand(sql, toks))) (byId[id] ??= []).push(row);
                        await writeFile(`${root}/data/results/${theme.id}/${name}/${jur.id}${pk ? '-' + pk : ''}.json`, JSON.stringify(byId));
                        console.log(`results ${theme.id}.${name}.${jur.id}${pk ? ' ' + pk : ''}: ${Object.keys(byId).length} areas (${secs(t0)}s)`);
                    } catch (err) {
                        console.error(`results ${theme.id}.${name}.${jur.id}${pk ? ' ' + pk : ''}: FAILED — ${err.message.split('\n')[0]}`);
                    }
                }
            }
        }
    }
}

if (what === 'distributions') {
    const [jurId] = only;
    const jur = app.jurisdictions.find(j => j.id === jurId);
    if (!jur) throw new Error(`Unknown area type ${jurId}`);
    for (const params of combos) {
        const pk = paramKey(app, params);
        const src = `${root}/data/areas/${jur.id}${pk ? '/' + pk : ''}`;
        const files = (await readdir(src).catch(() => [])).filter(f => f.endsWith('.json'));
        const byTheme = {};
        for (const f of files) {
            const area = JSON.parse(await readFile(`${src}/${f}`, 'utf8'));
            for (const [tid, queries] of Object.entries(area.results || {})) {
                for (const [q, rows] of Object.entries(queries)) {
                    ((byTheme[tid] ??= {})[q] ??= []).push(...rows.map(r => ({ __id: String(area.id), ...r })));
                }
            }
        }
        const out = `${root}/data/distributions/${jur.id}${pk ? '/' + pk : ''}`;
        await mkdir(out, { recursive: true });
        for (const [tid, results] of Object.entries(byTheme)) {
            await writeFile(`${out}/${tid}.json`, JSON.stringify({ generated: new Date().toISOString(), areas: files.length, results }));
        }
        console.log(`distributions ${jur.id}${pk ? ' ' + pk : ''}: ${files.length} areas, ${Object.keys(byTheme).length} themes`);
    }
}

if (what === 'all' || what === 'peers') {
    for (const theme of allThemes) {
        if (!theme.peers || (only.length && !only.includes(theme.id))) continue;
        const sql = await fetchText(`${root}/${theme.dir}/${theme.peers.file}`);
        await mkdir(`${root}/data/peers/${theme.id}`, { recursive: true });
        for (const jur of app.jurisdictions) {
            if (!jur.cells10) continue;
            const t0 = Date.now();
            try {
                const rows = await engine.client.query(expand(sql, { CELLS10: jur.cells10 }));
                await writeFile(`${root}/data/peers/${theme.id}/${jur.id}.json`, JSON.stringify(rows));
                console.log(`peers ${theme.id}.${jur.id}: ${rows.length} rows (${secs(t0)}s)`);
            } catch (err) {
                console.error(`peers ${theme.id}.${jur.id}: FAILED — ${err.message.split('\n')[0]}`);
            }
        }
    }
}

if (what === 'baselines') {
    // Compare mode: every catalog preset's units scored on every theme, per
    // country, so only the reader's own units run live. One file per preset:
    // the unit names, the strata the units touch, and each theme's rows as
    // [id, stratum, variable, value, w] with values to 6 significant digits.
    const cmp = app.compare;
    if (!cmp) throw new Error('baselines: app.json has no "compare" block');
    const countries = JSON.parse(await fetchText(`${root}/${cmp.countries}`));
    const ids = only.length ? only : cmp.precompute?.countries || [cmp.default_country];
    for (const cid of ids) {
        const country = countries.find(c => c.id === cid);
        if (!country) { console.error(`baselines: no country ${cid} in ${cmp.countries}`); continue; }
        const ctok = countryTokens(country);
        for (const role of cmp.roles) {
            for (const preset of presetsFor(role, cid)) {
                if (presetPick && !presetPick.includes(preset.id)) continue;
                const file = `${root}/data/baselines/${cid}/${preset.id}.json`;
                let out = { generated: null, country: cid, role: role.id, preset: preset.id, units: {}, strata: [], columns: ['id', 'stratum', 'variable', 'value', 'w'], results: {} };
                try { if (onlyThemes) out = JSON.parse(await readFile(file, 'utf8')); } catch { /* fresh */ }
                const part = presetUnitsSql(preset, role.id, ctok);
                let t0 = Date.now();
                const names = await engine.client.query(`SELECT id::VARCHAR AS id, ANY_VALUE(name) AS name, COUNT(DISTINCT cell) AS cells, SUM(h3_cell_area(cell, 'km^2')) AS km2 FROM (${expand(preset.sql, ctok)}) GROUP BY 1`);
                out.units = Object.fromEntries(names.map(r => [r.id, { name: r.name ?? null, cells: r.cells, km2: +Number(r.km2).toPrecision(4) }]));
                out.strata = cmp.strata ? await engine.client.query(strataNamesSql([part], cmp.strata)) : [];
                console.log(`baselines ${cid} ${preset.id}: ${names.length} units, ${out.strata.length} strata (${secs(t0)}s)`);
                const UNITS = withStrata([part], cmp.strata);
                for (const theme of config.themes) {
                    if (onlyThemes && !onlyThemes.includes(theme.id)) continue;
                    t0 = Date.now();
                    try {
                        const rows = await engine.client.query(expand(theme.sql.units, { ...ctok, UNITS }, `${theme.id}/units`));
                        const sig = x => (x == null ? null : +Number(x).toPrecision(6));
                        out.results[theme.id] = rows.map(r => [String(r.id), r.stratum, r.variable, sig(r.value), sig(r.w)]);
                        console.log(`baselines ${cid} ${preset.id} ${theme.id}: ${rows.length} rows (${secs(t0)}s)`);
                    } catch (err) {
                        console.error(`baselines ${cid} ${preset.id} ${theme.id}: FAILED — ${err.message.split('\n')[0]}`);
                    }
                }
                out.generated = new Date().toISOString();
                await mkdir(`${root}/data/baselines/${cid}`, { recursive: true });
                await writeFile(file, JSON.stringify(out));
            }
        }
    }
}

if (what === 'all' || what === 'sources') {
    // Every data path the config can read or draw, matched to the STAC
    // collection whose own asset is its longest prefix (as geo-agent's export
    // does), so the export can cite a dataset without crawling the catalog.
    const catalogUrl = app.stac_catalog || 'https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json';
    const allSql = await Promise.all(allThemes.flatMap(t => Object.values(t.queries).filter(allFile).map(q => fetchText(`${root}/${t.dir}/${allFile(q)}`))));
    const text = [JSON.stringify(app), ...overlays.map(o => o.url || ''), ...allThemes.flatMap(t => Object.values(t.sql)), ...allSql].join('\n');
    const paths = [...new Set(dataPaths(text))];
    const t0 = Date.now();
    const collections = await crawl(catalogUrl);
    const assets = [];
    for (const c of collections) {
        for (const a of Object.values(c.assets || {})) {
            if (!a?.href) continue;
            const pmtiles = /\.pmtiles$/.test(a.href);
            const parquet = String(a.type || '').includes('parquet') || /\.parquet$|\/hex\/*$/.test(a.href);
            if (!pmtiles && !parquet) continue;
            const p = pmtiles ? a.href : pathPrefix(a.href);
            if (/^s3:\/\/[^/]+\/.+/.test(p) || pmtiles) assets.push({ p, pmtiles, c });
        }
    }
    assets.sort((a, b) => b.p.length - a.p.length);
    const used = new Map();
    const unmatched = [];
    for (const path of paths) {
        const target = /\.pmtiles$/.test(path) ? path : pathPrefix(path);
        const hit = assets.find(({ p, pmtiles }) => pmtiles ? p === path : (target === p || target.startsWith(p + '/')));
        if (!hit) { unmatched.push(path); continue; }
        if (!used.has(hit.c.id)) {
            const c = hit.c;
            used.set(c.id, {
                id: c.id,
                prefixes: [],
                stac: {
                    id: c.id, title: c.title, license: c.license, providers: c.providers,
                    'sci:citation': c['sci:citation'], 'sci:doi': c['sci:doi'],
                    links: (c.links || []).filter(l => ['self', 'about', 'license', 'cite-as'].includes(l.rel)),
                },
            });
        }
        const e = used.get(hit.c.id);
        if (!e.prefixes.includes(hit.p)) e.prefixes.push(hit.p);
    }
    await mkdir(`${root}/data`, { recursive: true });
    await writeFile(`${root}/data/sources.json`, JSON.stringify({ generated: new Date().toISOString(), catalog: catalogUrl, datasets: [...used.values()] }, null, 1));
    console.log(`sources: ${used.size} datasets from ${collections.length} collections (${secs(t0)}s)`);
    if (unmatched.length) console.warn('no STAC record for:\n  ' + unmatched.join('\n  '));
}

/** Every collection under a STAC catalog (children followed recursively). */
async function crawl(url) {
    const seen = new Set();
    const out = [];
    async function visit(u) {
        if (seen.has(u)) return;
        seen.add(u);
        let doc;
        try {
            const r = await fetch(u);
            if (!r.ok) return;
            doc = await r.json();
        } catch { return; }
        if (doc.type === 'Collection') out.push({ ...doc, links: (doc.links || []).map(l => ({ ...l, href: new URL(l.href, u).href })) });
        const kids = (doc.links || []).filter(l => l.rel === 'child').map(l => new URL(l.href, u).href);
        await Promise.all(kids.map(visit));
    }
    await visit(url);
    return out;
}
