/**
 * Scoring for compare mode: focal units against a floor set and a ceiling set,
 * metric by metric, in the browser. Pure functions, so the same code runs
 * under Node for tests and exports.
 *
 * Input rows come from each theme's units query, one per (grp, id, stratum,
 * variable): { grp, id, stratum, variable, value, w }, where value is the
 * area-weighted mean over the unit's cells in that stratum and w the area with
 * data. A landscape is a set of strata (e.g. ecoregions); a unit's value is
 * the w-weighted mean over its strata inside the landscape, and a unit with no
 * cells there is left out.
 *
 * For each focal unit and metric (dir is +1 when higher is better, −1 when lower is):
 *   floorPct, ceilPct   mid-rank percentile among the floor (ceiling) units,
 *                       0–100, direction-adjusted: share of the set below plus
 *                       half the ties, flipped when dir = −1
 *   contrast            100 × (V − M) ÷ M against the floor median M, the
 *                       arithmetic of the Wallacea Trust avoided-loss pathway;
 *                       100 × (M − V) ÷ M when dir = −1
 *   retention           V ÷ C against the ceiling median C; C ÷ V when dir = −1
 *   position            (V − M) ÷ (C − M): 0 at the floor median, 1 at the ceiling
 *                       median, for either direction. Null when the two medians
 *                       are too close to separate (a gap under MIN_GAP of both
 *                       the spread of the two sets and the medians' size) or
 *                       point the wrong way.
 *   rank                1–5: the position in five equal bands from floor to
 *                       ceiling, the quintile ranks of the Wallacea Trust
 *                       methodology with the floor as rank 1 and the ceiling as
 *                       rank 5; below the floor is rank 1, beyond the ceiling 5.
 * The headline for a unit is the rank of its median position across the metrics.
 * The basket summary is the median of each across the selected metrics, with
 * the leave-one-metric-out range of that median. Unscored variables
 * (covariates) get an `outside` flag when the focal value lies outside the
 * range of a comparison set.
 */

/** Map `${grp}|${id}` → { grp, id, values: { variable: value }, w: { variable: area } } over the strata in `landscape` (null: all). */
export function combineStrata(rows, landscape = null) {
    const keep = landscape ? new Set([...landscape].map(String)) : null;
    const acc = new Map();
    for (const r of rows) {
        if (keep && !keep.has(String(r.stratum))) continue;
        const v = Number(r.value), w = Number(r.w);
        if (r.value == null || !Number.isFinite(v) || !(w > 0)) continue;
        const key = `${r.grp}|${r.id}`;
        let u = acc.get(key);
        if (!u) acc.set(key, u = { grp: r.grp, id: String(r.id), sums: {}, w: {} });
        u.sums[r.variable] = (u.sums[r.variable] || 0) + v * w;
        u.w[r.variable] = (u.w[r.variable] || 0) + w;
    }
    // Every value is rounded to 6 significant digits, the precision precomputed
    // baselines are stored at, so live and precomputed units compare on equal
    // terms. Without it, the last digits that DuckDB's parallel sums move would
    // break ties at random: a forest share of 0.9999999999 would rank below
    // every unit at exactly 1.
    const out = new Map();
    for (const [key, u] of acc) {
        const values = {};
        for (const k of Object.keys(u.sums)) values[k] = SIG(u.sums[k] / u.w[k]);
        out.set(key, { grp: u.grp, id: u.id, values, w: u.w });
    }
    return out;
}

/** Rounded to 6 significant digits (see combineStrata). */
export const SIG = x => +x.toPrecision(6);

export function median(vals) {
    const s = vals.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median of [value, weight] pairs: the value where the cumulative weight reaches half, averaged with the next when it lands exactly on half. */
export function weightedMedian(pairs) {
    const s = pairs.filter(([v, w]) => Number.isFinite(v) && w > 0).sort((a, b) => a[0] - b[0]);
    if (!s.length) return null;
    const half = s.reduce((a, [, w]) => a + w, 0) / 2;
    let acc = 0;
    for (let i = 0; i < s.length; i++) {
        acc += s[i][1];
        if (Math.abs(acc - half) < 1e-12 * half && i + 1 < s.length) return (s[i][0] + s[i + 1][0]) / 2;
        if (acc > half) return s[i][0];
    }
    return s[s.length - 1][0];
}

/** Mid-rank percentile (0–100) of v among sorted values: share below plus half the ties. */
export function midRank(sorted, v) {
    if (!sorted.length || !Number.isFinite(v)) return null;
    let below = 0, ties = 0;
    for (const x of sorted) { if (x < v) below++; else if (x === v) ties++; else break; }
    return 100 * (below + ties / 2) / sorted.length;
}

/** Summary of one comparison set on one variable. */
function setStats(units, variable) {
    const values = units.map(u => u.values[variable]).filter(Number.isFinite).sort((a, b) => a - b);
    return values.length
        ? { n: values.length, median: median(values), min: values[0], max: values[values.length - 1], values }
        : { n: 0, median: null, min: null, max: null, values };
}

/** The smallest gap between floor and ceiling medians, as a share of the spread of both sets and of the medians' size, that a metric needs to place units between them. */
export const MIN_GAP = 0.05;

/** Rank 1–5 of a position: five equal bands from floor (0) to ceiling (1), clamped. */
export const rankOf = p => (Number.isFinite(p) ? Math.min(5, Math.max(1, Math.floor(p * 5) + 1)) : null);

const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);

/** Median of finite values and the leave-one-out range of that median. */
export function basket(vals) {
    const v = vals.filter(Number.isFinite);
    if (!v.length) return { median: null, n: 0, loo: null };
    const loo = v.length < 3 ? null : v.map((_, i) => median(v.filter((__, j) => j !== i)));
    return { median: median(v), n: v.length, loo: loo && [Math.min(...loo), Math.max(...loo)] };
}

/**
 * Score focal units against the floor and ceiling.
 *   units      Map from combineStrata (all groups)
 *   variables  [{ id, dir, scored, group? }] — the selected metrics and covariates;
 *              `group` (e.g. the theme) gives each unit a rank per group too
 *   groups     { focal: 'focal', floor: 'floor', ceiling: 'ceiling' } group names
 * Returns { stats: { variable: { floor, ceiling, focal } }, units: [...], set, pooled }:
 * `set` scores the median focal unit on each metric, and `pooled` scores all
 * focal units as one, each metric the area-weighted median over them: the
 * value with half their combined area on either side, so that one unusual unit
 * cannot move it far.
 */
export function scoreUnits(units, variables, groups = { focal: 'focal', floor: 'floor', ceiling: 'ceiling' }) {
    const by = g => [...units.values()].filter(u => u.grp === g);
    const focal = by(groups.focal), floor = by(groups.floor), ceiling = by(groups.ceiling);
    const stats = {};
    for (const v of variables) {
        const st = stats[v.id] = { floor: setStats(floor, v.id), ceiling: setStats(ceiling, v.id), focal: setStats(focal, v.id) };
        // whether the floor and ceiling medians are far enough apart, in the right
        // direction, to place a unit between them
        const lo = st.floor.median, hi = st.ceiling.median;
        if (v.scored !== false && lo != null && hi != null) {
            const spread = Math.max(st.floor.max, st.ceiling.max) - Math.min(st.floor.min, st.ceiling.min);
            const dir = v.dir === -1 ? -1 : 1;
            const gap = Math.abs(hi - lo);
            st.separates = (hi - lo) * dir > 0 && gap >= MIN_GAP * spread && gap >= MIN_GAP * Math.max(Math.abs(lo), Math.abs(hi));
        } else st.separates = false;
    }

    const scoreOne = values => {
        const metrics = {};
        for (const v of variables) {
            const x = values[v.id];
            const s = stats[v.id];
            if (!Number.isFinite(x)) { metrics[v.id] = { value: null }; continue; }
            const m = { value: x };
            if (v.scored === false) {
                // range_check: false for a covariate that a set is selected on (e.g. the
                // cocoa probability of pseudo-farms), where falling outside says nothing
                if (v.range_check !== false) m.outside = {
                    floor: s.floor.n ? x < s.floor.min || x > s.floor.max : null,
                    ceiling: s.ceiling.n ? x < s.ceiling.min || x > s.ceiling.max : null,
                };
            } else {
                const dir = v.dir === -1 ? -1 : 1;
                const pct = set => { const p = midRank(set.values, x); return p == null ? null : dir === 1 ? p : 100 - p; };
                m.floorPct = s.floor.n ? pct(s.floor) : null;
                m.ceilPct = s.ceiling.n ? pct(s.ceiling) : null;
                const fm = s.floor.median, cm = s.ceiling.median;
                const c = ratio(dir === 1 ? x - fm : fm - x, fm);
                m.contrast = c == null ? null : 100 * c;
                m.retention = dir === 1 ? ratio(x, cm) : ratio(cm, x);
                m.position = s.separates ? (x - fm) / (cm - fm) : null;
                m.rank = rankOf(m.position);
            }
            metrics[v.id] = m;
        }
        const scoredVars = variables.filter(v => v.scored !== false);
        const scored = scoredVars.map(v => metrics[v.id]);
        const position = basket(scored.map(m => m.position));
        // the same median position within each group of metrics (e.g. a theme)
        const groupsOf = [...new Set(scoredVars.map(v => v.group).filter(Boolean))];
        const byGroup = Object.fromEntries(groupsOf.map(g => {
            const b = basket(scoredVars.filter(v => v.group === g).map(v => metrics[v.id].position));
            return [g, { ...b, rank: rankOf(b.median) }];
        }));
        return {
            metrics,
            rank: rankOf(position.median),
            byGroup,
            basket: {
                position,
                floorPct: basket(scored.map(m => m.floorPct)),
                ceilPct: basket(scored.map(m => m.ceilPct)),
                contrast: basket(scored.map(m => m.contrast)),
                retention: basket(scored.map(m => m.retention)),
            },
        };
    };

    const out = focal.map(u => ({ id: u.id, ...scoreOne(u.values) }));
    // the focal set as a whole: each metric at the median over focal units
    const setValues = Object.fromEntries(variables.map(v => [v.id, stats[v.id].focal.median]));
    const pooledValues = {};
    for (const v of variables) {
        const m = weightedMedian(focal.filter(u => Number.isFinite(u.values[v.id]) && u.w?.[v.id] > 0).map(u => [u.values[v.id], u.w[v.id]]));
        if (m != null) pooledValues[v.id] = SIG(m);
    }
    return { stats, units: out, set: { n: focal.length, ...scoreOne(setValues) }, pooled: { n: focal.length, ...scoreOne(pooledValues) } };
}

/** Distinct strata of the focal group's rows: the default landscape. */
export function focalStrata(rows, focalGroup = 'focal') {
    return new Set(rows.filter(r => r.grp === focalGroup && r.stratum != null).map(r => String(r.stratum)));
}
