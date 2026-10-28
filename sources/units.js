/**
 * Unit sets for compare mode. A unit is one polygon (drawn, uploaded or from a
 * catalog preset) as a list of H3 cells; a set is a group of units with one
 * role (focal, floor, ceiling). Theme SQL receives every set at once through
 * {{UNITS}}, a relation of (grp, id, stratum, cell) rows.
 *
 *   polygonUnitsSql(units, grp)   drawn or uploaded polygons → (grp, id, cell),
 *                                 resolution-10 polyfill on the query server; a
 *                                 polygon too small to contain a cell centre
 *                                 gets the cell holding an interior point
 *   presetUnitsSql(preset, grp, tokens)
 *                                 a catalog preset's SQL (returning id, name,
 *                                 cell) → (grp, id, cell)
 *   withStrata(parts, strata)     the union of the parts, each cell tagged with
 *                                 its stratum (e.g. ecoregion id; −1 for none)
 *   strataNamesSql(parts, strata) (stratum, name) for the strata the parts touch
 */

import { geometryToWktPolygons } from './polygon.js';
import { expand } from '../core/engine.js';

export const POLYFILL_RES = 10;

/** Ids are generated (f1, f2 …), never user text, so they are safe in SQL. */
const safeId = id => {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(id))) throw new Error(`Invalid unit id: ${id}`);
    return String(id);
};
const safeGrp = g => {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(g)) throw new Error(`Invalid group: ${g}`);
    return g;
};

/** units: [{ id, geometry }] (Polygon or MultiPolygon). */
export function polygonUnitsSql(units, grp) {
    const polys = [], points = [];
    for (const u of units) {
        const id = safeId(u.id);
        for (const w of geometryToWktPolygons(u.geometry)) polys.push(`('${id}', '${w}')`);
        const [x, y] = interiorPoint(u.geometry);
        points.push(`('${id}', ${y.toFixed(6)}, ${x.toFixed(6)})`);
    }
    if (!polys.length) return null;
    return `WITH p(id, wkt) AS (VALUES ${polys.join(', ')}),
    pt(id, lat, lng) AS (VALUES ${points.join(', ')}),
    c AS (SELECT id, unnest(h3_polygon_wkt_to_cells(wkt, ${POLYFILL_RES})) AS cell FROM p)
  SELECT DISTINCT '${safeGrp(grp)}' AS grp, id, cell FROM c
  UNION ALL
  SELECT '${grp}' AS grp, id, h3_latlng_to_cell(lat, lng, ${POLYFILL_RES}) AS cell FROM pt
  WHERE id NOT IN (SELECT DISTINCT id FROM c)`;
}

/**
 * Template tokens for a country from the app's country list
 * ({ id, iso3, h0s: ['578…', …] }): {{ISO2}}, {{ISO3}} and {{H0S}}, the
 * comma-separated resolution-0 cells its land falls in, for partition pruning.
 */
export function countryTokens(country) {
    if (!/^[A-Z]{2}$/.test(country.id) || !/^[A-Z]{3}$/.test(country.iso3)) throw new Error(`Invalid country: ${country.id}`);
    const h0s = country.h0s.map(String);
    if (!h0s.length || !h0s.every(h => /^\d{1,20}$/.test(h))) throw new Error(`Invalid h0 list for ${country.id}`);
    return { ISO2: country.id, ISO3: country.iso3, H0S: h0s.join(', ') };
}

/** Presets of a role that apply to a country (no `countries` list means every country). */
export const presetsFor = (role, countryId) => (role.presets || []).filter(p => !p.countries || p.countries.includes(countryId));

/** A catalog preset ({ sql } returning id, name, cell) as (grp, id, cell). */
export function presetUnitsSql(preset, grp, tokens) {
    return `SELECT '${safeGrp(grp)}' AS grp, id::VARCHAR AS id, cell FROM (${expand(preset.sql, tokens, `preset ${preset.id}`).trim()})`;
}

/**
 * The union of the parts with each cell's stratum. strata.sql returns
 * (h0, h8, stratum, name); a cell on a boundary between two strata takes the
 * smaller id. The strata table is masked to the units' cells before it is
 * aggregated, so only the partitions the units touch are read.
 */
export function withStrata(parts, strata) {
    const all = parts.filter(Boolean).map(p => `(${p})`).join('\n  UNION ALL\n  ');
    if (!strata) return `SELECT grp, id, 0 AS stratum, cell FROM (${all})`;
    return `WITH s AS MATERIALIZED (
    SELECT grp, id, cell, h3_cell_to_parent(cell, 8) AS h8, h3_cell_to_parent(cell, 0)::BIGINT AS h0 FROM (
  ${all}
    )
  ),
  k AS (SELECT DISTINCT h0, h8 FROM s),
  m AS (
    SELECT x.h0, x.h8, MIN(x.stratum)::INTEGER AS stratum
    FROM (${strata.sql.trim()}) x SEMI JOIN k ON x.h0 = k.h0 AND x.h8 = k.h8
    GROUP BY x.h0, x.h8
  )
  SELECT s.grp, s.id, COALESCE(m.stratum, -1) AS stratum, s.cell
  FROM s LEFT JOIN m ON m.h0 = s.h0 AND m.h8 = s.h8`;
}

/**
 * The cells of units already resolved by withStrata, written into the query as
 * a literal: rows [{ grp, id, stratum, cells: ['6265…', …] }] (cell ids as
 * decimal strings, since JSON numbers cannot hold a 64-bit id). Resolving the
 * units once and inlining them saves every theme query from repeating the
 * polyfill and the strata join.
 */
export function inlineUnitsSql(rows) {
    const vals = rows.map(r => {
        const stratum = Number.parseInt(r.stratum, 10);
        if (!Number.isFinite(stratum)) throw new Error(`Invalid stratum: ${r.stratum}`);
        const cells = r.cells.map(c => { if (!/^\d{1,20}$/.test(String(c))) throw new Error(`Invalid cell: ${c}`); return c; });
        return `('${safeGrp(r.grp)}', '${safeId(r.id)}', ${stratum}, [${cells.join(', ')}]::UBIGINT[])`;
    });
    if (!vals.length) throw new Error('No units to inline');
    return `SELECT grp, id, stratum, unnest(cells) AS cell FROM (VALUES ${vals.join(',\n  ')}) t(grp, id, stratum, cells)`;
}

/** withStrata's rows grouped per unit and stratum, with cell ids as strings, for inlineUnitsSql. */
export const resolvedUnitsSql = unitsSql => `SELECT grp, id, stratum, list(cell::VARCHAR ORDER BY cell) AS cells FROM (${unitsSql}) GROUP BY grp, id, stratum`;

/** (stratum, name) for every stratum the parts' cells fall in. */
export function strataNamesSql(parts, strata) {
    const all = parts.filter(Boolean).map(p => `(${p})`).join(' UNION ALL ');
    return `WITH k AS (SELECT DISTINCT h3_cell_to_parent(cell, 0)::BIGINT AS h0, h3_cell_to_parent(cell, 8) AS h8 FROM (${all}))
  SELECT DISTINCT x.stratum::INTEGER AS stratum, x.name FROM (${strata.sql.trim()}) x SEMI JOIN k ON x.h0 = k.h0 AND x.h8 = k.h8
  ORDER BY 1`;
}

/**
 * A point inside a Polygon or MultiPolygon, for polygons smaller than one
 * polyfill cell: the area centroid of the largest outer ring when it lies
 * inside that ring, else the midpoint of the widest horizontal span through
 * the ring at the centroid's latitude.
 */
export function interiorPoint(geom) {
    const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map(p => p[0]);
    let best = rings[0], bestA = -1;
    for (const r of rings) { const a = Math.abs(signedArea(r)); if (a > bestA) { bestA = a; best = r; } }
    const c = centroid(best);
    if (inside(c, best)) return c;
    const xs = [];
    for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
        const [xi, yi] = best[i], [xj, yj] = best[j];
        if ((yi > c[1]) !== (yj > c[1])) xs.push(xi + (c[1] - yi) / (yj - yi) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    let span = null;
    for (let i = 0; i + 1 < xs.length; i += 2) if (!span || xs[i + 1] - xs[i] > span[1] - span[0]) span = [xs[i], xs[i + 1]];
    return span ? [(span[0] + span[1]) / 2, c[1]] : best[0];
}

function signedArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return a / 2;
}

function centroid(r) {
    let a = 0, x = 0, y = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
        a += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f;
    }
    if (a === 0) return r[0];
    return [x / (3 * a), y / (3 * a)];
}

function inside([px, py], r) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
}
