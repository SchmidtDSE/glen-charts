# glen-charts design

**Status:** 0.4.0 released. The coasts explorer, the Assessment Explorer and all three tpl-cities sites run on it. 0.4.0 adds compare mode (README), first used by the Wallacea comparison explorer. **Scope:** [tpl-cities](https://github.com/boettiger-lab/tpl-cities), [ca-30x30/assessment](https://github.com/boettiger-lab/ca-30x30/tree/main/assessment), [geo-agent](https://github.com/boettiger-lab/geo-agent).

There are now two no-LLM explorer apps on the GLEN architecture: fixed SQL templates over H3-indexed parquet, run either on our duckdb MCP server or in the visitor's browser with DuckDB-wasm. About three-quarters of each app's code is the same machinery, and the copies have already started to drift apart. This document sets out which parts become the shared library, glen-charts, which parts stay in each app, and how to move there without breaking either app.

## Decisions

| Question | Decision |
|---|---|
| Name and home | `SchmidtDSE/glen-charts` |
| Relation to geo-agent | Separate for now. Converging the export code (SQL to R and Python, citations) can come later. |
| Migration of the Assessment Explorer | Done in 0.2.8; the app now runs 0.2.10. |
| Migration of tpl-cities | Done in 0.3.0. |
| 0.1.0 | Released from tpl-cities' modules plus the Assessment Explorer's additions, so the coasts explorer can build on it. It changes neither existing app. |
| What is general vs app-specific | Agreed with the coasts app: see *What 0.1.0 adds*. The test is whether tpl-cities, the assessment, or a plausible later glen app would use it. |

## Summary

glen-charts is a library of ES modules served from jsDelivr at a pinned tag, as geo-agent is, with no build step. It runs the same SQL on either of two query engines, chosen per app in configuration: the MCP server or DuckDB-wasm in the browser. It is designed around five extension points that the two apps have already had to add by hand: query backend, template tokens, area sources, chart types and precompute jobs. The Assessment Explorer moved first, then tpl-cities. A migration step is accepted only when the library generates the same SQL text as the app's own engine for every query and area, and the regenerated `data/` matches every value to within 1e-9. (Byte-for-byte is too strict: DuckDB sums in parallel, so re-running the same SQL moves the last digits.)

## What the two apps share today

The Assessment Explorer was forked from tpl-cities at `ca2ee19`. Comparing that fork with tpl-cities as it stands now (`ed0daca`) shows what is genuinely common and where each app had to change the common code.

| Module | Role | tpl-cities | assessment | Lines differing | Verdict |
|---|---|--:|--:|--:|---|
| `mcp.js` | Stateless MCP query client | 75 | 75 | 0 | core |
| `charts.js` | SVG bar and stacked charts, hover | 177 | 177 | 0 | core |
| `sources.js` | Data paths to STAC citations | 47 | 47 | 0 | core |
| `format.js` | Number formats | 45 | 45 | 2 | core; precision becomes an option |
| `report.js` | Theme card: headline tiles, charts, method | 145 | 160 | 23 | core, plus a chart-type hook |
| `export.js` | Self-contained HTML report with SQL / R / Python | 591 | 603 | 26 | core; constants become config |
| `engine.js` | Config, template expansion, cache | 175 | 195 | 54 | core, plus token and precompute hooks |
| `map.js` | Basemap, boundaries, selection | 306 | 368 | 72 | core base; overlays stay in apps |
| `style.css` | Layout and components | 263 | 287 | 38 | core; palette becomes tokens |
| `precompute.mjs` | Runs the same SQL ahead of time | 155 | 174 | ~120 | core; job kinds pluggable |
| `main.js`, `access.js` | Page shell and flow | 385 + 366 | 416 | most | shared shell + app |
| `wasm.js` | DuckDB-wasm query client | 163 | — | — | core engine |
| `browser-tiles.py`, `browser-aoi.py` | Build the wasm engine's tile set and place files | 133 + 41 | — | — | core tooling |
| `iso.js` | Isochrone area of interest | 104 | — | — | plugin |
| `draw.js`, `polygon.js` | Draw or upload a polygon | — | 141 | — | plugin |
| `represent.js` | Representation table (report Tables 3–13) | — | 225 | — | app chart type |

Line counts are from the two working trees. "Lines differing" counts changed lines in a plain diff of each module against tpl-cities' current version.

Roughly 2,200 of the Assessment Explorer's 2,950 lines of JavaScript and CSS belong in the core. All three entry points (tpl-cities' `main.js` and `access.js`, and the assessment's `main.js`) re-implement the same page shell: theme buttons, place search, intro, report rendering, URL-hash state, the resizable sidebar and map hints. They differ only in how the area of interest is chosen.

### The drift has already started

- After the fork, tpl-cities made the engine's query client injectable so it could add the DuckDB-wasm variant. The assessment's copy still hard-codes the MCP client, so it cannot use the wasm backend without re-applying that change.
- The assessment added precomputed per-area results, the `--theme` partial refresh, and a fix for file names that contain spaces. tpl-cities has none of these, though its counties and districts would benefit from all three.
- tpl-cities added a `{{SITE}}` token, which the wasm engine uses to read precomputed place files from the site; the assessment's copy lacks it. The assessment added `{{LAND}}`. Each edit was made in place inside `engine.js`.

Each of these is a change to shared code made in only one copy. A third app would add more.

## The five extension points

Each of these was added by hand, in place, by at least one app. In the library each becomes a registration or an option, so an app extends the core without editing it.

1. **Query engine.** Anything with `query(sql) → rows`. The core ships two engines, described in the next section, and an app picks one with `"engine": "mcp"` or `"engine": "wasm"` in `app.json`. A third engine only has to implement `query`.
   *Evidence:* tpl-cities' `wasm.js` is already a drop-in replacement, and it needed the engine's `client` option.
2. **Template tokens.** The core expands `{{AOI}}`, `{{AOI10}}` and `{{ID}}`. An app registers further tokens as functions of the area, for example `LAND: aoi => …` for the California land grid with conserved-area weights.
   *Evidence:* `{{SITE}}` in tpl-cities and `{{LAND}}` in the assessment were both hard-coded into `sqlFor`.
3. **Area sources.** A source turns user input into an area of interest (`{kind, id, key, sql, sql10, label}`) and owns its controls and map layers. The core provides jurisdiction pick lists and statewide; polygon drawing, isochrones and later sources are modules.
   *Evidence:* this is the only real difference between the three entry points.
4. **Chart types.** Charts in `theme.json` with a `type` are looked up in a registry, with bar and stacked bar built in. The representation table registers as `"representation"`; a later app registers its own.
   *Evidence:* `report.js` gained an `if (c.type === 'representation')` branch and a report-comparison row.
5. **Precompute jobs.** The precompute script runs named jobs over the same engine: pick lists, statewide results, per-area results, peer ranks and source citations, with `--theme` and `--force` on all of them. The browser checks for a precomputed file before running a query live.
   *Evidence:* tpl-cities has `peers` and the assessment has `areas`; each lacks the other's.

## Two query engines

Both engines run the same SQL templates, so the themes, reports, precompute and export are identical whichever one an app uses. The SQL shown in the app and in exports always keeps the original `s3://` paths.

| | MCP server | DuckDB-wasm in the browser |
|---|---|---|
| Where queries run | Our duckdb MCP server, next to the data | The visitor's browser |
| Needs | The server to be up | Nothing beyond static hosting |
| Data reach | The whole catalog, at any extent | Fast on a prepared California tile set; other datasets are read remotely, one range request at a time |
| Heavy queries (statewide, res-10 joins) | Yes | Too slow live; precompute them instead |
| Configuration | `mcp_url` | `wasm`: DuckDB version, worker count, S3 settings per path prefix, path rewrites to a mirror, and the tile set's URL |
| Tooling | `precompute.mjs` | Also `browser-tiles.py` (California-only copies of each dataset, one small parquet per county, only the columns the SQL uses) and `browser-aoi.py` (each place's H3 cells, read through `{{SITE}}`) |

**How an app chooses.** The engine is a configuration choice, not a code change. tpl-cities already serves both from one codebase: `/` uses MCP and `/wasm/` uses DuckDB-wasm, with only `app.json` differing. The library keeps this pattern, and the engine is loaded only when it is selected, so an MCP-only app never downloads DuckDB-wasm.

**The engines can be combined.** Precompute runs under Node against the MCP server, whichever engine the app uses in the browser. An app can then use the wasm engine for live areas, such as a drawn polygon, while statewide and per-area results come from precomputed files. That combination suits the Assessment Explorer, whose statewide res-10 queries are too heavy to run in a browser.

**Possible later:** a fallback mode that tries MCP and switches to wasm when the server is unreachable. This needs every template to run on both engines, which the wasm engine's tile manifest makes checkable.

## App entry point

An app's entry point then shrinks to configuration and registration:

```js
import { createExplorer, jurisdictions, statewide } from 'glen-charts@1.0.0/core.js';
import { polygonSource } from 'glen-charts@1.0.0/sources/polygon.js';
import { representation } from './represent.js';      // app-specific chart type

createExplorer({
  config: './config/app.json',
  sources: [statewide(), jurisdictions(), polygonSource({ maxVertices: 5000 })],
  tokens: { LAND: (aoi, app) => landCells(aoi, app) },
  charts: { representation },
  overlays: [conservedAreas],                           // map layer, legend, popup
});
```

This is illustrative; the exact names are settled in the first migration step.

## What stays in each app

This follows the same line the geo-agent apps draw: the library holds behaviour, and the app holds the domain.

| Stays in the app | Why |
|---|---|
| `config/app.json`, `config/themes/*` | The SQL, thresholds and feature definitions are the app. In the assessment they are what was checked against the published report. |
| `data/` | Precomputed results, pick lists, citations and reference values, such as the assessment's transcribed `report.json`. |
| Domain chart types and overlays | The representation table, the need-class rule and the conserved-areas layer encode the 30x30 framework; tpl-cities' tract choropleth and isochrone bands are the same kind of thing. |
| Validation scripts | `validate.py` compares against one report's numbers. The pattern is general; the content is not. |
| `index.html`, palette, copy | Branding. The library exposes design tokens and leaves their values to the app. |

### Shared configuration, not just shared code

The county, congressional, State Senate and Assembly definitions are identical in both apps' `app.json`, apart from a `cells10` field that tpl-cities adds for its peer ranks. A small package of California jurisdiction definitions, referenced by name from `app.json`, would remove the duplication. A boundary change, such as new districts after redistricting, would then be made once.

## Relation to geo-agent

geo-agent is the LLM framework and the closest relative. Its MCP client (`mcp-client.js`, 274 lines) wraps the full MCP SDK with sessions and reconnects, which the agent needs and a fixed-query app does not. Its report export (`export-report.js`, 1,575 lines) does the same SQL to R and Python translation as glen-charts' `export.js`.

The two stay separate for now. Later, the code translation and citation logic can move into one module that both libraries import. Merging the libraries would tie small static apps to the agent's release cadence and dependencies.

## Distribution

- **Repository:** `SchmidtDSE/glen-charts`, ES modules, no bundler, BSD 2-Clause like both apps.
- **Loading:** from jsDelivr at an exact tag, the way ca-30x30 pins geo-agent. An app upgrades by changing the tag, and can test the change on a branch first.
- **Node:** the same modules run under Node for `precompute`, `run` and tests, as both apps' engines already do.
- **Python tooling:** the wasm engine's tile and place builders ship in `scripts/` with the library, configured by the app's `app.json`.
- **Docs:** a README with the configuration reference and the five extension points, plus a minimal example app that CI builds and precomputes.

## What 0.1.0 adds

Everything below came from the coasts explorer, was judged general, and is in the library. What stayed in the coasts app is listed after it.

| In the library | Why it is general |
|---|---|
| **Params**: user-chosen values (`"params"` in `app.json`) drawn as a control, kept in the link, expanded as `{{TOKEN}}` in every SQL template and in boundary filters, and part of cache keys and precomputed paths | A buffer width, a travel-time band or a year is the same pattern. |
| **Optional, comparison-only region**: `statewide` may be absent, or `selectable: false` (tpl-cities' case) | Global apps have no state; tpl-cities compares with California but never selects it. |
| **All-areas queries**: a query's `"all"` SQL computes every area at once, served per area from one file | tpl-cities' `precompute` field, generalised with params. One query instead of one per area. |
| **`percentile-strip` chart** with optional `rank_field`, log scale and per-row formats | Ranking a place among its peers is tpl-cities' "#9 of 58", drawn. |
| **Antimeridian bounding boxes** (`xmin > xmax`), ids matched by value, **lists that vary with a param** | Any global or classed area set. |
| **No-data handling and formats**: NULL/NaN as `format.nodata`, never drawn as zero; `km2`, `ha`, `num2`, `ordinal` | Global and marine data. |
| **Relative paths throughout** | Hosting behind an auth proxy or under a sub-path. |

| Stays in the coasts app | Why |
|---|---|
| MEOW unit definitions, including the antimeridian-aware bounding-box SQL | Data-specific. |
| The four pillars, their variables and SQL | The app's content. |
| Score semantics: direction, transforms, mid-rank in SQL, the "provisional" label, the pillar summary as a SQL headline | Scoring choices belong to the app, visible in its exported SQL. |

## Migration plan

Each step leaves both apps deployed and working. The acceptance test is mechanical: the library must generate the same SQL text as the app's own engine for every query and area, and the app's `data/` must regenerate to within 1e-9 on every value. The assessment must also pass `validate.py` unchanged.

1. **Create the library (done: 0.1.0).** Built from tpl-cities' modules with the assessment's additions folded in, which also covers most of step 3. Checked against both apps without changing them: identical SQL for all 2,510 assessment and 14,973 tpl-cities query × area pairs; the assessment's Mono ecoregion regenerated within 1e-9; both apps' reports render the same text line for line from the library (tpl-cities differs only in placing the place search above the dimension buttons).
2. **Move tpl-cities onto it (done: 0.3.0).** Its main site, access variant and wasm variant are three page shells over `createExplorer`, differing only in `app.json`. The access variant's isochrone and geocoder code became the library's isochrone area source (`sources/isochrone-source.js`), which needed three explorer additions: `map.type: "hex"` choropleths, sources that keep state in the link, and a source's own report header and status messages. The library generates the same SQL as the app's old engine for all 30,101 query × area pairs across the three sites, so `data/` did not change. The wasm tile scripts (`browser-tiles.py`, `browser-aoi.py`) are still California-specific and stay in tpl-cities until they read their extent from `app.json`.
3. **Port the assessment's additions into the library (done: 0.1.0).** These are the precomputed per-area results, `--theme`, file names by raw id, the one-decimal percent option and the export legend fix. tpl-cities gets them with no further work.
4. **Move the Assessment Explorer onto it (done: 0.2.8).** `{{LAND}}`, the representation table, the conserved-areas overlay and the framework note are the app's extensions (`app/extensions.js`); polygon drawing uses the library's area source. The library generates the same SQL as the app's old engine for all 2,520 query × area pairs (the region, 251 named areas and a drawn polygon), so `data/` and the inputs to `validate.py` did not change. The port found two library gaps, fixed in 0.2.9 (the region's own view reads `data/statewide.json`) and 0.2.10 (`precompute sources` cites extension overlays). The app can now add a wasm variant like tpl-cities' `/wasm/`, once its datasets are in a browser tile set.
5. **Extract the California jurisdiction definitions** and point both apps at them.
6. **Tag `1.0.0`** once a third app, or the minimal example, has been built from the README alone.

The remaining steps are a few days of focused work. The SQL-identity check keeps the risk low, because any change in behaviour shows up as a data diff.

## Risks

- **Abstracting from two examples.** Some extension points may fit these two apps too closely. Holding `1.0` until a third app uses the library guards against this.
- **Release coupling.** A library bug reaches every app at its next tag bump. Pinning exact tags means nothing changes until an app opts in.
- **Validated numbers.** The assessment's numbers were checked against a published report, so the library must never change query results silently. The regeneration check enforces this.
