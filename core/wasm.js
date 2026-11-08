/**
 * In-browser query client: DuckDB-wasm runs the app's SQL against the public
 * parquet, with no MCP server. Drop-in for McpQueryClient — query(sql) → array
 * of rows — so the engine, reports and export are unchanged.
 *
 * DuckDB-wasm itself (start-up, extensions, S3 secrets, path rewrites, the
 * pool of instances, whole-file fetches) is geo-query-wasm's engine, imported
 * at a pinned commit. What stays here is the county-tile planning, which
 * depends on the area being queried.
 *
 * The wasm build reads remote parquet with one synchronous range request at a
 * time, so a query that touches hundreds of row groups is latency-bound. When
 * "tiles" is set, datasets in the tile manifest are read instead from small
 * California-only files, one per county (scripts/browser-tiles.py): the query's
 * glob is pointed at the files a place needs, and the engine fetches them in
 * parallel and reads them from memory. Datasets not in the manifest, and areas
 * without a county list, read remotely. The site's own parquet is fetched
 * whole too: GitHub Pages gzips responses and applies byte ranges to the
 * compressed stream, which breaks DuckDB's range reads.
 *
 * Options (app.json "wasm"):
 *   duckdb    @duckdb/duckdb-wasm version on jsDelivr
 *   workers   DuckDB instances to spread queries over; each runs one query at a time
 *   secrets   [{ name?, scope, endpoint?, region?, url_style? }] anonymous S3
 *             settings per path prefix (NRP Ceph, the source.coop mirror, ...)
 *   rewrite   [{ from, to }] path prefixes swapped just before a remote read,
 *             e.g. NRP → the source.coop mirror
 *   tiles     { url, counties } base URL of the tile set (manifest.json +
 *             <dataset>/<fips>.parquet) and the folder of the per-jurisdiction
 *             county lists (<counties>/<kind>-counties.json), relative to the page
 *
 * The SQL shown in the app and in exports keeps the original s3:// paths.
 */

// one pinned commit for both modules, so the engine and its defaults match
const GEO_QUERY_WASM = 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@d7807360af99a32fed0a85f74321aee14af69aa4/src';
const [{ createEngine }, { DEFAULTS }] = await Promise.all([
    import(`${GEO_QUERY_WASM}/engine.js`),
    import(`${GEO_QUERY_WASM}/defaults.js`),
]);

export class WasmQueryClient {
    constructor({ duckdb, workers = 2, secrets, rewrite, tiles = null } = {}) {
        const base = globalThis.location?.href;
        this.tiles = tiles && { ...tiles, url: base ? new URL(tiles.url, base).href.replace(/\/$/, '') : tiles.url };
        const origin = globalThis.location?.origin;
        const opts = {
            duckdb, workers, secrets, rewrite,
            // glen-charts writes its SQL from fixed templates, so it needs no SELECT-only lock
            lock: false,
            fetchWhole: [origin && `${origin}/`, this.tiles && `${this.tiles.url}/`].filter(Boolean),
            // settings replaces the engine's defaults, so start from them and add glen-charts' own
            settings: { ...DEFAULTS.settings, s3_allow_recursive_globbing: false },
        };
        // unset options keep the engine's defaults
        for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
        this.engine = createEngine(opts);
        this.stats = this.engine.stats;   // { files, bytes } fetched whole
        this.json = new Map();            // URL → Promise<json>
    }

    /** Start the DuckDB instances (once). */
    init() {
        return this.engine.ready();
    }

    /**
     * Run SQL and return an array of row objects (JSON-typed, as the MCP
     * client returns). ctx.aoi (from the engine) selects the tile files.
     */
    async query(sql, { aoi = null } = {}) {
        try {
            return await this.engine.json(await this.planTiles(sql, aoi));
        } catch (err) {
            throw new Error(String(err.message || err).replace(/^Error:\s*/, '').slice(0, 600));
        }
    }

    /** Swap tiled datasets' globs for the area's county files. */
    async planTiles(sql, aoi) {
        // one named area, or several chosen together (aoi.ids): the counties any of them touches
        const ids = aoi?.ids?.length ? aoi.ids : aoi?.id ? [aoi.id] : [];
        if (!this.tiles || !aoi?.kind || !ids.length) return sql;
        // if the tile set can't be reached, fall back to reading the public data remotely (slow)
        const [manifest, lists] = await Promise.all([
            this.getJson(`${this.tiles.url}/manifest.json`).catch(() => null),
            this.getJson(`${this.tiles.counties}/${aoi.kind}-counties.json`).catch(() => null),
        ]);
        const per = ids.map(id => lists?.[id]);
        const counties = per.every(Boolean) ? [...new Set(per.flat())] : null;
        if (!manifest || !counties) return sql;
        const file = (rel, c) => `'${this.tiles.url}/${rel}/${c}.parquet'`;
        return sql.replace(/read_parquet\('s3:\/\/([^']+?)\/h0=\*\/data_0\.parquet'\)/g, (m, rel) => {
            const have = manifest.datasets[rel];
            if (!have) return m;
            const want = have.includes('CA') ? ['CA'] : counties.filter(c => have.includes(c));   // "CA": one statewide file
            // no rows here: an empty relation with the dataset's columns
            if (!want.length) return `(SELECT * FROM read_parquet(${file(rel, have[0])}) WHERE false)`;
            return `read_parquet([${want.map(c => file(rel, c)).join(', ')}])`;
        });
    }

    getJson(url) {
        if (!this.json.has(url)) {
            this.json.set(url, fetch(url).then(r => {
                if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
                return r.json();
            }).catch(err => { this.json.delete(url); throw err; }));
        }
        return this.json.get(url);
    }
}
