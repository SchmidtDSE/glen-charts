/**
 * In-browser query client: DuckDB-wasm runs the app's SQL against the public
 * parquet, with no MCP server. Drop-in for McpQueryClient — query(sql) → array
 * of rows — so the engine, reports and export are unchanged.
 *
 * The wasm build reads remote parquet with one synchronous range request at a
 * time, so a query that touches hundreds of row groups is latency-bound. When
 * "tiles" is set, datasets in the tile manifest are read instead from small
 * California-only files, one per county (scripts/browser-tiles.py): the client
 * fetches the files a place needs in parallel with fetch(), hands them to
 * DuckDB as in-memory buffers, and points the query's glob at them. Datasets
 * not in the manifest, and areas without a county list, read remotely.
 *
 * Options (app.json "wasm"):
 *   duckdb    @duckdb/duckdb-wasm version on jsDelivr
 *   workers   DuckDB instances to spread queries over; each runs one query at a time
 *   secrets   [{ scope, endpoint?, region?, url_style? }] anonymous S3 settings
 *             per path prefix (NRP Ceph, the source.coop mirror, ...)
 *   rewrite   [{ from, to }] path prefixes swapped just before a remote read,
 *             e.g. NRP → the source.coop mirror
 *   tiles     { url, counties } base URL of the tile set (manifest.json +
 *             <dataset>/<fips>.parquet) and the folder of the per-jurisdiction
 *             county lists (<counties>/<kind>-counties.json), relative to the page
 *
 * The SQL shown in the app and in exports keeps the original s3:// paths.
 */

const CDN = v => `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${v}`;

export class WasmQueryClient {
    constructor({ duckdb = '1.33.1-dev57.0', workers = 2, secrets = [], rewrite = [], tiles = null } = {}) {
        this.version = duckdb;
        this.n = workers;
        this.secrets = secrets;
        this.rewrite = rewrite;
        this.tiles = tiles;
        this.pool = null;
        this.files = new Map();    // tile URL → Promise<Uint8Array>
        this.json = new Map();     // URL → Promise<json>
        this.stats = { files: 0, bytes: 0 };
    }

    /** Start the DuckDB instances (once). */
    init() {
        this._init ??= (async () => {
            const duckdb = await import(`${CDN(this.version)}/+esm`);
            const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
            const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
            const start = async () => {
                const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
                await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
                const conn = await db.connect();
                await conn.query('INSTALL httpfs; LOAD httpfs; INSTALL h3 FROM community; LOAD h3; INSTALL spatial; LOAD spatial;');
                // no geometry is read from parquet, and parsing some GeoParquet metadata fails in the
                // wasm build with "stoi: no conversion" (cf. boettiger-lab/datasets#106)
                await conn.query('SET s3_allow_recursive_globbing = false; SET enable_geoparquet_conversion = false;');
                for (const [i, s] of this.secrets.entries()) await conn.query(secretSql(`s${i}`, s));
                return { db, conn, busy: 0, queue: Promise.resolve(), registered: new Set() };
            };
            // the first instance fetches and caches the wasm + extensions; the rest start from cache
            const first = await start();
            this.pool = [first, ...await Promise.all(Array.from({ length: this.n - 1 }, start))];
        })();
        return this._init;
    }

    /**
     * Run SQL and return an array of row objects (JSON-typed, as the MCP
     * client returns). ctx.aoi (from the engine) selects the tile files.
     */
    async query(sql, { aoi = null } = {}) {
        const [, plan] = await Promise.all([this.init(), this.planTiles(sql, aoi)]);
        const w = this.pool.reduce((a, b) => (b.busy < a.busy ? b : a));
        w.busy++;
        const run = w.queue.then(async () => {
            for (const { name, url } of plan.files) {
                if (w.registered.has(name)) continue;
                await w.db.registerFileBuffer(name, (await this.fetchFile(url)).slice());   // each worker gets its own copy
                w.registered.add(name);
            }
            return w.conn.query(`SELECT CAST(to_json(list(__q)) AS VARCHAR) AS __json FROM (\n${plan.sql.trim().replace(/;\s*$/, '')}\n) __q`);
        });
        w.queue = run.catch(() => {}).finally(() => { w.busy--; });
        try {
            const json = (await run).getChildAt(0)?.get(0);
            return json ? JSON.parse(json) : [];
        } catch (err) {
            throw new Error(String(err.message || err).replace(/^Error:\s*/, '').slice(0, 600));
        }
    }

    /** Swap tiled datasets' globs for the area's county files (fetching them), then apply path rewrites. */
    async planTiles(sql, aoi) {
        const files = [];
        if (this.tiles && aoi?.kind && aoi.id) {
            // if the tile set can't be reached, fall back to reading the public data remotely (slow)
            const [manifest, lists] = await Promise.all([
                this.getJson(`${this.tiles.url}/manifest.json`).catch(() => null),
                this.getJson(`${this.tiles.counties}/${aoi.kind}-counties.json`).catch(() => null),
            ]);
            const counties = lists?.[aoi.id];
            if (manifest && counties) {
                sql = sql.replace(/read_parquet\('s3:\/\/([^']+?)\/h0=\*\/data_0\.parquet'\)/g, (m, rel) => {
                    const have = manifest.datasets[rel];
                    if (!have) return m;
                    const want = have.includes('CA') ? ['CA'] : counties.filter(c => have.includes(c));   // "CA": one statewide file
                    // no rows here: an empty relation with the dataset's columns
                    if (!want.length) return `(SELECT * FROM read_parquet('${this.register(files, rel, have[0])}') WHERE false)`;
                    return `read_parquet([${want.map(c => `'${this.register(files, rel, c)}'`).join(', ')}])`;
                });
            }
        }
        // The site's own parquet (area cells) is fetched whole too: GitHub Pages gzips responses
        // and applies byte ranges to the compressed stream, which breaks DuckDB's range reads.
        const origin = globalThis.location?.origin;
        if (origin) {
            sql = sql.replace(new RegExp(`'(${origin.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/[^']+?\\.parquet)'`, 'g'), (m, url) => {
                const name = `site${new URL(url).pathname}`;
                if (!files.some(f => f.name === name)) files.push({ name, url });
                return `'${name}'`;
            });
        }
        await Promise.all(files.map(f => this.fetchFile(f.url)));
        for (const { from, to } of this.rewrite) sql = sql.split(from).join(to);
        return { sql, files };
    }

    register(files, rel, county) {
        const name = `tiles/${rel}/${county}.parquet`;
        if (!files.some(f => f.name === name)) files.push({ name, url: `${this.tiles.url}/${rel}/${county}.parquet` });
        return name;
    }

    fetchFile(url) {
        if (!this.files.has(url)) {
            this.files.set(url, fetch(url).then(async r => {
                if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
                const buf = new Uint8Array(await r.arrayBuffer());
                this.stats.files++;
                this.stats.bytes += buf.byteLength;
                return buf;
            }).catch(err => { this.files.delete(url); throw err; }));
        }
        return this.files.get(url);
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

function secretSql(name, { scope, endpoint, region = '', url_style = 'path' }) {
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const parts = [`TYPE s3`, `REGION ${q(region)}`, `URL_STYLE ${q(url_style)}`, `SCOPE ${q(scope)}`];
    if (endpoint) parts.push(`ENDPOINT ${q(endpoint)}`);
    return `CREATE OR REPLACE SECRET ${name} (${parts.join(', ')});`;
}
