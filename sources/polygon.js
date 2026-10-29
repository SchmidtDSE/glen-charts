/**
 * Polygon areas of interest (drawn or uploaded). Any polygon becomes an AOI
 * by H3 polyfill on the DuckDB server, so every section's SQL runs unchanged.
 * (From tpl-cities app/iso.js, without the isochrone and geocoder parts.)
 * The cells are res 10 (sql10); sql is their res-8 parents.
 */

import { interiorPoint } from './units.js';

/** GeoJSON Polygon/MultiPolygon → list of WKT POLYGON strings (holes kept). */
export function geometryToWktPolygons(geom) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
        : geom.type === 'MultiPolygon' ? geom.coordinates
        : [];
    return polys.map(rings => 'POLYGON(' + rings.map(r =>
        '(' + closeRing(r).map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).join(', ') + ')').join(', ') + ')');
}

function closeRing(r) {
    const [a, b] = [r[0], r[r.length - 1]];
    return a[0] === b[0] && a[1] === b[1] ? r : [...r, a];
}

/**
 * AOI from arbitrary polygons (drawn / uploaded GeoJSON). A polygon smaller
 * than one res-10 cell (about 1.5 ha, so many parcels) covers no cell centre;
 * it gets the cell under an interior point instead.
 */
export function polygonAoi(geometries, label) {
    const ws = geometries.flatMap(g => (g.type === 'MultiPolygon' ? g.coordinates.map(c => ({ type: 'Polygon', coordinates: c })) : [g]))
        .flatMap(g => geometryToWktPolygons(g).map(w => {
            const [x, y] = interiorPoint(g);
            return `('${w}', ${y.toFixed(6)}, ${x.toFixed(6)})`;
        }));
    const sql10 = `SELECT DISTINCT h3_cell_to_parent(c, 0) AS h0, h3_cell_to_parent(c, 8) AS h8, c AS h10 FROM (SELECT unnest(CASE WHEN len(cs) = 0 THEN [h3_latlng_to_cell(lat, lng, 10)] ELSE cs END) AS c FROM (SELECT h3_polygon_wkt_to_cells(wkt, 10) AS cs, lat, lng FROM (VALUES ${ws.join(', ')}) t(wkt, lat, lng)))`;
    return { key: `poly:${hash(ws.join())}`, kind: 'polygon', label, sql10, sql: `SELECT DISTINCT h0, h8 FROM (${sql10})` };
}

function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}
