/**
 * Travel-time isochrones as areas of interest. Isochrones come from a
 * Valhalla routing server (keyless, CORS-enabled; set app.json
 * routing.url). The polygons become an area by H3 polyfill on the query
 * server, so every theme's SQL runs unchanged. (From tpl-cities app/iso.js.)
 */

import { geometryToWktPolygons } from './polygon.js';

export const MODES = {
    walk: { label: 'Walk', costing: 'pedestrian', icon: '🚶' },
    bike: { label: 'Bike', costing: 'bicycle', icon: '🚲' },
    drive: { label: 'Drive', costing: 'auto', icon: '🚗' },
};

/**
 * Fetch nested isochrones for one origin and mode.
 * Returns [{ minutes, geometry }] sorted by minutes ascending.
 */
export async function fetchIsochrones(routing, { lon, lat }, mode, minutes) {
    const m = MODES[mode];
    if (!m) throw new Error(`Unknown mode ${mode}`);
    const body = {
        locations: [{ lat, lon }],
        costing: m.costing,
        contours: minutes.map(t => ({ time: t })),
        polygons: true,
        denoise: 0.3,
        generalize: 25,   // metres; keeps polygons small without visible loss
    };
    const url = `${routing.url.replace(/\/$/, '')}/isochrone?json=${encodeURIComponent(JSON.stringify(body))}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Routing server error ${res.status}`);
    const fc = await res.json();
    if (!fc.features?.length) throw new Error('No isochrone returned for this location');
    return fc.features
        .map(f => ({ minutes: Number(f.properties.contour), geometry: f.geometry }))
        .sort((a, b) => a.minutes - b.minutes);
}

/**
 * Build an AOI from nested bands: [{ minutes, geometry }].
 * The AOI is the band `selected` (minutes); `bands10` labels every cell with
 * the smallest band containing it, for "how does reach grow with time" queries.
 */
export function bandsAoi(bands, selected, label, origin = null) {
    const rows = [];
    for (const b of bands) {
        for (const w of geometryToWktPolygons(b.geometry)) rows.push(`(${Number(b.minutes)}, '${w}')`);
    }
    const cells = `SELECT band, unnest(h3_polygon_wkt_to_cells(wkt, 10)) AS c FROM (VALUES ${rows.join(', ')}) t(band, wkt)`;
    const bands10 = `SELECT MIN(band) AS band, h3_cell_to_parent(c, 0) AS h0, h3_cell_to_parent(c, 8) AS h8, c AS h10 FROM (${cells}) GROUP BY c`;
    const sel = Number(selected);
    const sql10 = `SELECT h0, h8, h10 FROM (${bands10}) WHERE band <= ${sel}`;
    return {
        key: `iso:${label}:${sel}:${hash(rows.join())}`,
        kind: 'isochrone',
        label,
        sql10,
        sql: `SELECT DISTINCT h0, h8 FROM (${sql10})`,
        bands10,
        origin: origin ? { lat: +origin.lat, lon: +origin.lon } : null,
    };
}

function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

/**
 * Keyless geocoder (Photon / OpenStreetMap). bbox [west, south, east, north]
 * limits results to a region.
 */
export async function geocode(q, { bbox = null, limit = 6 } = {}) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}${bbox ? `&bbox=${bbox.join(',')}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Geocoder error ${res.status}`);
    const fc = await res.json();
    return fc.features.map(f => {
        const p = f.properties;
        const where = [p.street && p.housenumber ? `${p.housenumber} ${p.street}` : p.street, p.city || p.county].filter(Boolean).join(', ');
        return { name: p.name || where || 'Location', detail: p.name ? where : '', lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    });
}

/**
 * A point's name (Photon reverse lookup): { name, label } where label adds
 * the city, or null.
 */
export async function reverseGeocode({ lon, lat }) {
    const r = await fetch(`https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}&limit=1`);
    const p = (await r.json()).features?.[0]?.properties;
    const name = p && (p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || null);
    return name ? { name, label: name + (p.city && p.name !== p.city ? `, ${p.city}` : '') } : null;
}
