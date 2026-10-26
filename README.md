# glen-charts

A library for small, static web apps that profile an area: pick a place, or a whole region, and see a set of themed panels (headline numbers, charts, rankings) computed with fixed SQL over the cloud-native DuckDB geo catalog. No AI model is involved; every number is SQL you can read, export and re-run in R or Python.

An app is configuration: `config/app.json`, one folder per theme with its SQL, and precomputed `data/`. The library supplies the page layout, the map, the query engine (MCP server or DuckDB-wasm in the browser), the charts, the report export with runnable code and data citations, and a precompute CLI.

Status: **0.3.0**. Extracted from [tpl-cities](https://github.com/boettiger-lab/tpl-cities) and the [ca-30x30 Assessment Explorer](https://github.com/boettiger-lab/ca-30x30/tree/main/assessment). Both run on it; see [DESIGN.md](DESIGN.md) for the plan. `example/` is a complete minimal app.

## An app in four files

```
index.html                  your header + one <main id="glen"> + the module below
config/app.json             area types, params, map, labels
config/themes/<id>/theme.json + *.sql
data/                       written by the precompute CLI
```

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-charts@v0.3.0/core/style.css">
<link rel="stylesheet" href="app/style.css">   <!-- optional: override the :root palette tokens -->
...
<main id="glen"></main>
<script type="module">
  import { createExplorer } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-charts@v0.3.0/core/explorer.js';
  createExplorer();               // or createExplorer({ extensions }) — see below
</script>
```

The page also loads MapLibre GL and PMTiles (see `example/index.html`). All fetches are relative to the page, so an app can be served from any path, including behind an auth proxy.

## Theming

The page's own stylesheet can override the palette tokens on `:root` (see the top of `core/style.css`): `--primary`, `--accent`, `--chrome-bg`, `--card-bg`, `--surface`, `--backdrop`, `--text`, `--text-2`, `--text-3`, `--line`, `--line-strong`, `--hover`, `--grid`, and for a dark theme also `--header-bg`, `--header-fg`, `--overlay-bg` (map legends), `--code-bg`, `--skeleton-a` / `--skeleton-b`, `--mix-base` (the base colour tints are mixed with, white by default) and `--on-primary` (text on primary-coloured buttons). `--header-h` sets the header height. Nothing in the library hard-codes a light surface colour, so a dark palette needs no other overrides.

## config/app.json

| Field | Meaning |
|---|---|
| `id` | short key for the reader's saved settings (sidebar width, code language) |
| `title`, `intro` | page title; HTML shown before an area is chosen |
| `mcp_url` | the duckdb-geo MCP server. A `config.json` next to the page with `mcp_server_url` overrides it at run time |
| `engine` / `wasm` | `"mcp"` (default) or `"wasm"`; `wasm` holds the DuckDB-wasm options (see `core/wasm.js`) |
| `view` | initial map `{ center, zoom }` |
| `basemap` | `"light-gray"` (default), `"dark-gray"`, `"natgeo"`, or `{ tiles, attribution, ref_tiles? }`; `ref_tiles` is a label layer drawn above the data |
| `overview`, `themes` | theme folder names (or paths) under `config/themes/`; the overview card is always shown, the themes are toggled |
| `jurisdictions` | area types; see below |
| `statewide` | optional whole region: `{ aoi, aoi10, label, kind_label?, description?, selectable? }`. Gives a region mode (unless `selectable: false`) and "California: …" comparisons on every tile and a tick on bar charts |
| `params` | user-chosen settings that enter the SQL; see below |
| `reference` | optional published source to compare with on the region's own view: `{ values: "data/report.json", label, chart_label?, title?, citation?, url?, note? }` |
| `labels` | `{ area, sections, place_hint, map_chips }` step titles |
| `format` | `{ nodata: "—", pct_decimals: "auto" | 1 }` |
| `boundary_style` | `{ fill, opacity, hover_opacity, line, line_opacity, selected, selected_width, selected_opacity }` |
| `tracts` | `{ url, source_layer, id_prop, line_width? }` for themes that color tracts (`theme.map`). `line_width` is the cell outline width, a number or a MapLibre expression (default 0.4); use a zoom expression for cells only a pixel or two wide at the landing zoom. A list of grids, each with an `id` and a `minzoom` and/or `maxzoom`, swaps grids by zoom, e.g. a coarse H3 grid zoomed out and a fine one zoomed in; see `theme.map.levels` |
| `default_area` | `{ jurisdiction, id }`: the area whose profile a link with no `#…` opens on, instead of an empty picker |
| `live_note` | text shown when a named area has no precomputed file |
| `project_url`, `export_css` | source link and extra CSS for the exported report |
| `extensions` | path of the app's extension module, for the precompute CLI |
| `data_base` | folder holding `data/`, when a site variant shares another's |
| `overlays` | map layers under the boundaries, as the extension `overlays` (below) with a declared popup: `popup_title` (a property) and `popup_fields` (`["Country", ["Area (ha)", "Area"]]`); `"visible": false` starts the layer switched off; `"above": true` draws it over the boundaries (and leaderboard colours) instead of under them |

An area type:

```json
{ "id": "county", "label": "Counties", "singular": "County", "peer_label": "California counties",
  "aoi":   "SELECT DISTINCT h0, h8 FROM ... WHERE GEOID = '{{ID}}'",
  "aoi10": "SELECT DISTINCT h0, h8, h10 FROM ... WHERE GEOID = '{{ID}}'",
  "list":  "SELECT id, name, xmin, ymin, xmax, ymax FROM ...",
  "list_params": false,
  "boundary": { "url": "https://.../county.pmtiles", "source_layer": "county", "id_prop": "GEOID", "name_prop": "NAMELSAD",
                "filter": ["==", ["get", "STATEFP"], "06"] } }
```

- `list` rows need `id`, `name` and a bounding box. A box with `xmin > xmax` crosses the antimeridian and is fitted across it.
- Ids match by value, so a numeric id in the tiles (`20001.0`) finds `20001` in the list.
- `list_params: true` when the list depends on a param (areas that exist only at some settings); it is then re-read when the param changes.
- The boundary `filter` may contain param tokens (`"{{WIDTH}}"`, filled as a number when numeric) and follows the param.
- The boundary `url` and `source_layer` may contain param tokens too, for areas with one tile set per param value (`".../level_0{{LEVEL}}.pmtiles"`); the boundaries reload when the param changes, keeping the selection and leaderboard colours.
- `boundary.style` overrides `app.boundary_style` for one area type, e.g. `{ "selected": "#c2410c", "selected_width": 1.2 }` for a thin outline on detailed polygons.
- `picker: "map"` chooses areas by clicking the map only: the search box gives way to `labels.place_hint` (e.g. "Click a coastline on the map").

### Params

```json
"params": [{ "id": "width", "label": "Band width", "token": "WIDTH", "options": [5, 10, 20, 50], "default": 10, "format": "{} km" }]
```

A param is drawn as a segmented control (or, with `"control": "slider"`, as a slider over its options, for ordered settings such as a resolution), kept in the link (`?width=20`), expanded as `{{WIDTH}}` in every SQL template (area, list and theme), and part of every cache key and precomputed file path. Its value is always one of its options, so it is safe in SQL. An option may be `{ "value": ..., "label": ... }`.

A slider param can hold offsets from a value that depends on the chosen area, such as a species' measured threshold that the reader may move up or down:

```json
{ "id": "adjust", "label": "Leaf threshold in °C", "token": "ADJUST", "control": "slider",
  "options": [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2], "default": 0,
  "relative": { "theme": "exposure", "query": "base", "field": "leaf_c", "format": "num1",
                "note": "The slider starts at the team's value, {} °C.", "offset_format": "{} °C from the team's value" } }
```

Once an area is chosen, the explorer runs `relative.query` (a theme query returning `field` in its first row) and labels each stop as that base plus the offset, so the reader sees absolute values. The token, the link and the cache key keep the offset, so a shared link means "the team's value plus 1" for whichever area it names. Before an area is chosen the stops show signed offsets; `offset_format` labels the offset in the report's settings line.

## Themes

`config/themes/<id>/theme.json`:

```json
{ "label": "Park access", "color": "#2a78d6", "blurb": "...", "method": "...",
  "queries": { "stats": { "file": "stats.sql", "all": "stats-all.sql" } },
  "headlines": [ { "query": "stats", "row": { "variable": "x" }, "field": "value", "label": "...", "format": "pct",
                   "compare": true, "reference": "path.in.values", "rank": { "field": "value" } } ],
  "charts": [ { "type": "bar", "query": "...", "category": "label", "series": [{ "field": "frac", "label": "..." }],
                "stacked": true, "format": "pct", "compare": { "field": "frac" } } ],
  "map": { "query": "...", "id_field": "GEOID", "value_field": "v", "label": "...", "format": "pct", "ramp": ["#...", "..."] } }
```

`map.type: "hex"` draws H3 cells instead of tracts: `id_field` holds each cell's id as a string (`h3_h3_to_string`), so the page needs [h3-js](https://github.com/uber/h3-js).

When `app.tracts` lists several grids, `map.levels` names the query for each grid by its id (`{ "h6": "map_h6", "h7": "map" }`; a grid not named uses `map.query`). Each grid's rows carry that grid's `id_prop` column, and fixed `breaks` keep the colours the same across grids (quantile breaks come from the first grid).

Template tokens in theme SQL: `{{AOI}}` (the area's res-8 cells, `h0, h8`), `{{AOI10}}` (res-10 cells), `{{ID}}` and `{{KIND}}` for a named area (not for the whole region or a drawn polygon), every param token, and any token the app registers. Tokens inside `--` comments are left as written. An unbound token is reported with the template's name; it never hides precomputed rows, because SQL is only expanded when it has to run. A query's optional `all` file computes the same rows for **every** area of a type at once, with an `id` column; the precompute CLI writes its results and the browser then serves each area from that file, and `percentile-strip` reads it as the distribution. Tokens in an `all` file: params, `{{KIND}}`, and `{{CELLS10}}` when the area type defines `cells10`.

**Formats:** `int`, `num`, `num1`, `num2`, `compact`, `pct` (0–1), `pct100`, `usd`, `acres`, `km2`, `ha`, `meters`, `degC`, `tempC`, `per1k`, `ordinal`, `text`. A NULL or NaN shows as `format.nodata`; bar charts leave it out rather than drawing zero.

### Chart types

- `bar` (default): grouped or stacked horizontal bars; `label_lines: 2` wraps long row labels; `pivot` builds rows from several one-row queries; `statewide_row` sets this area beside the region (and `reference_row` beside a published value).
- `percentile-strip`: one row per variable; a strip of every area's raw value with this area marked, the raw value, and its percentile rank among all areas of its type.

  ```json
  { "type": "percentile-strip", "title": "...", "query": "stats", "key": "variable", "label": "label", "value": "value",
    "format": "num1", "format_field": "fmt", "scale": "log", "scale_field": "scale",
    "rank_field": "pct", "rank_scale": 1, "direction_field": "dir", "peer_label": "coastal ecoregions", "note": "...",
    "label_lines": 2 }
  ```

  The rank is `rank_field` (0–100, times `rank_scale`; use 100 for a 0–1 `PERCENT_RANK`) when given, so the number on screen is the one in the exported SQL. Otherwise it is the mid-rank (share below plus half the ties), flipped where `direction_field` is negative. Without a distribution (a param value that was not precomputed) the row shows the raw value and says the rank is unavailable.

## Leaderboard

`app.json` `leaderboard` adds a second tab that ranks every area of one type by a combined score the reader can re-weight. It reads only precomputed all-areas results (`precompute results`), so every theme it uses needs an `all` SQL file.

```json
"leaderboard": {
  "jurisdiction": "ecoregion", "tab": "Leaderboard", "profile_tab": "Profile", "default": true,
  "title": "Coastal ecoregions, ranked", "intro": "<p>…</p>",
  "pillars": [{ "theme": "carbon", "query": "carbon", "weight": 1,
                "variables": { "irrecoverable_density": { "weight": 0 }, "fishing_effort": { "reverse": true } } }],
  "overall": { "label": "Overall", "note": "…" },
  "scope": { "theme": "priority", "query": "priority", "field": "priority_share", "min": 0.5,
             "detail_field": "priority_countries", "label": "Priority countries", "global_label": "Global", "note": "…" },
  "map": { "label": "Overall score", "ramp": ["#f7fcb9", "#c2e699", "#78c679", "#31a354", "#006837"] }
}
```

- Each pillar query returns one row per (area, variable) with `variable`, `label`, `value` and `dir` (+1 when higher is better, −1 when lower is better).
- Scoring runs in the browser. A variable's percentile is the mid-rank of `dir × value` among the areas in view (0–100, ties share the midpoint of their rank range); with every area in view it equals a SQL mid-rank `pct`. A pillar score is the weighted mean of its variables' percentiles; the overall score is the weighted mean of the pillar scores.
- The scoring panel sets pillar weights and, per variable, on/off, weight and direction. Weights run from 0 to 3. `pillars[].weight` and `variables` set the defaults; a ± column shows each area's change in rank from them.
- `scope` adds a Global / subset switch: the subset is the areas whose `field` (from the first row of that theme's results) is at least `min`. Percentiles are recomputed among the subset.
- Names in the table show the area on the map; › opens its profile. Clicking the map finds the area's row. The map colours areas by overall score.
- `default: true` makes the leaderboard the landing view (a link without `view=leaderboard` still opens the profile it names).
- The view and any non-default scoring are kept in the URL (`?view=leaderboard&score=scope=priority;carbon=2;carbon.irrecoverable_mt=-1`), so a re-weighted view is a link. The CSV download records the scoring it used.

## Extensions

What configuration cannot express, an app passes to `createExplorer({ extensions })` from its own module (`app/extensions.js`, also named in `app.json` `extensions` so the CLI gets its tokens and cites its overlays; the CLI imports it under Node, so it must not touch `document` or `maplibregl` at load time):

```js
export default {
  tokens:   { LAND: (aoi, app, params) => '...SQL...' },        // extra template tokens
  charts:   { representation: { load(ctx), render(el, chart, data, ctx), css } },
  overlays: [{ id, url, source_layer, type, paint, popup: props => html, legend: html, toggle: 'Show …' }],
  sources:  [polygonSource()],                                   // area modes beyond the area types; see Area sources
  reportHead: (aoi, ctx) => html,                                // under the report title
  shortName:  label => short,                                    // chart row labels
};
```

A chart type's `load(ctx)` returns its data (default: the query's rows); `ctx` is `{ engine, theme, chart, aoi, isRegion, params, opts }`. Imports of glen-charts from jsDelivr inside an extension module resolve to the local library when the CLI runs it.

### Area sources

A source adds an area mode with its own controls. The library ships two:

- `sources/polygon-source.js`, `polygonSource()`: draw a polygon or upload GeoJSON. Not kept in the link.
- `sources/isochrone-source.js`, `isochroneSource()`: the area reachable from a point (map click or address search) by walking, cycling or driving within a time budget, from a [Valhalla](https://github.com/valhalla/valhalla) router. Its bands add `{{BANDS10}}` (every cell with the smallest band that reaches it), `{{ORIGIN_LAT}}` and `{{ORIGIN_LON}}` to theme SQL, and the point, mode and time are kept in the link (`#@37.8,-122.27?mode=walk&t=15`). Configured in `app.json`:

  ```json
  "routing":    { "url": "https://valhalla1.openstreetmap.de" },
  "isochrones": { "modes": ["walk", "bike", "drive"], "minutes": [5, 10, 15], "default_mode": "walk", "default_minutes": 15,
                  "geocode_bbox": [-124.5, 32.5, -114.1, 42.1], "hint": "Click anywhere in California to start" }
  ```

An app whose only area mode is a source opens on it, and leaves the mode out of the link. A source is an object:

```js
{ id, label, description, kindLabel,
  mount(stepEl, ctx),            // draw its controls; ctx = { mapView, engine, app, setAoi, select, showHint, hideHint, showMessage, writeHash }
  activate({ restoring }), deactivate(),
  reportHead?(aoi) → html,       // under the report title
  hashState?() → { path, query }, restore?(path, query),   // state kept in the link
  hashable: false }              // instead of hashState/restore: not kept in the link
```

## Precompute

```
npx github:SchmidtDSE/glen-charts#v0.3.0 precompute --site <app dir> <job> [args] [flags]
```

| Job | Writes |
|---|---|
| `lists [jur ...]` | `data/lists/<jur>[-<params>].json` |
| `statewide [theme ...]` | `data/statewide.json` (or `data/statewide/<params>.json`) |
| `areas <jur> [id ...]` | `data/areas/<jur>[/<params>]/<id>.json`, every query for each area; skips existing files unless `--force`; `--theme a,b` re-runs only those themes |
| `results [theme ...]` | `data/results/<theme>/<query>/<jur>[-<params>].json` from each query's `all` file; `--jur a,b` limits area types |
| `distributions <jur>` | `data/distributions/<jur>[/<params>]/<theme>.json` from the area files (no queries) |
| `peers [theme ...]` | `data/peers/<theme>/<jur>.json` from a theme's `peers` SQL |
| `sources` | `data/sources.json`, the STAC records of every dataset the config reads or maps (including the extensions module's overlays), for the export's citations |
| (none) | lists, statewide, peers, sources |

`--param width=all` runs every option; `--param width=20` one; the default is each param's default. `MCP_URL` overrides `mcp_url`; `MCP_TIMEOUT_MS` overrides the 300 s query timeout (for a local query server running whole-catalog scans).

The browser always looks for a precomputed file before running a query live, for the whole region as for a named area, and both run the same SQL through the same engine, so a precomputed number is the live number.

## License

BSD 2-Clause; see [LICENSE](LICENSE). Tool use is disclosed in [DISCLOSURE.md](DISCLOSURE.md).
