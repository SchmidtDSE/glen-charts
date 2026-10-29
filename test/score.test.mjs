// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineStrata, midRank, median, basket, scoreUnits, rankOf, weightedMedian } from '../core/score.js';
import { interiorPoint } from '../sources/units.js';

test('midRank counts half the ties', () => {
    assert.equal(midRank([1, 2, 2, 3], 2), 50);
    assert.equal(midRank([1, 2, 3, 4], 0), 0);
    assert.equal(midRank([1, 2, 3, 4], 5), 100);
});

test('median and leave-one-out range', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    // the toy basket from the walkthrough: median uplift 26.8%, LOO range 22.0% to 30.1%
    const b = basket([100, 26.829, 33.333, -5.172, 17.241]);
    assert.equal(b.median, 26.829);
    assert.deepEqual(b.loo.map(x => +x.toFixed(1)), [22.0, 30.1]);
});

test('combineStrata weights by area and drops units outside the landscape', () => {
    const rows = [
        { grp: 'focal', id: 'a', stratum: 1, variable: 'x', value: 1, w: 1 },
        { grp: 'focal', id: 'a', stratum: 2, variable: 'x', value: 4, w: 3 },
        { grp: 'floor', id: 'b', stratum: 3, variable: 'x', value: 9, w: 1 },
    ];
    const all = combineStrata(rows);
    assert.equal(all.get('focal|a').values.x, 13 / 4);
    const some = combineStrata(rows, new Set(['1']));
    assert.equal(some.get('focal|a').values.x, 1);
    assert.equal(some.has('floor|b'), false);
});

test('scoreUnits: percentiles, contrast and retention honour direction', () => {
    const rows = [];
    const add = (grp, id, x, y) => {
        rows.push({ grp, id, stratum: 0, variable: 'up', value: x, w: 1 });
        rows.push({ grp, id, stratum: 0, variable: 'down', value: y, w: 1 });
    };
    add('floor', 'f1', 1, 0.6); add('floor', 'f2', 2, 0.5); add('floor', 'f3', 3, 0.4);
    add('ceiling', 'c1', 8, 0.1); add('ceiling', 'c2', 10, 0.2);
    add('focal', 'p', 4, 0.25);
    const r = scoreUnits(combineStrata(rows), [{ id: 'up', dir: 1 }, { id: 'down', dir: -1 }]);
    const m = r.units[0].metrics;
    assert.equal(m.up.floorPct, 100);
    assert.equal(m.up.contrast, 100);          // (4 − 2) / 2
    assert.equal(m.up.retention, 4 / 9);
    assert.equal(m.down.floorPct, 100);        // lower than every floor unit
    assert.equal(m.down.ceilPct, 0);           // higher than every ceiling unit
    assert.equal(m.down.contrast, 50);         // (0.5 − 0.25) / 0.5
    assert.ok(Math.abs(m.down.retention - 0.6) < 1e-12);
});

test('covariates are flagged outside a set range, not scored', () => {
    const rows = [
        { grp: 'floor', id: 'f', stratum: 0, variable: 'elev', value: 100, w: 1 },
        { grp: 'floor', id: 'g', stratum: 0, variable: 'elev', value: 200, w: 1 },
        { grp: 'focal', id: 'p', stratum: 0, variable: 'elev', value: 900, w: 1 },
    ];
    const r = scoreUnits(combineStrata(rows), [{ id: 'elev', scored: false }]);
    assert.deepEqual(r.units[0].metrics.elev.outside, { floor: true, ceiling: null });
    assert.equal(r.units[0].basket.contrast.median, null);
});

test('interiorPoint lies inside a concave polygon', () => {
    // a U shape whose centroid falls in the notch
    const u = { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]]] };
    const [x, y] = interiorPoint(u);
    assert.ok(!(x > 1 && x < 2 && y > 1), `point ${x},${y} is in the notch`);
});

test('values differing only in the last digits tie', () => {
    const rows = [
        { grp: 'floor', id: 'a', stratum: 0, variable: 'f', value: 1, w: 1 },
        { grp: 'floor', id: 'b', stratum: 0, variable: 'f', value: 1, w: 1 },
        { grp: 'focal', id: 'p', stratum: 0, variable: 'f', value: 0.9999999999, w: 1 },
    ];
    const r = scoreUnits(combineStrata(rows), [{ id: 'f', dir: 1 }]);
    assert.equal(r.units[0].metrics.f.floorPct, 50);
});

test('position and rank place a unit between floor and ceiling medians', () => {
    assert.deepEqual([-0.3, 0, 0.19, 0.2, 0.5, 0.99, 1, 1.4].map(rankOf), [1, 1, 1, 2, 3, 5, 5, 5]);
    const rows = [];
    const add = (grp, id, up, down, flat) => {
        rows.push({ grp, id, stratum: 0, variable: 'up', value: up, w: 1 });
        rows.push({ grp, id, stratum: 0, variable: 'down', value: down, w: 1 });
        rows.push({ grp, id, stratum: 0, variable: 'flat', value: flat, w: 1 });
    };
    add('floor', 'f1', 0, 1, 5); add('floor', 'f2', 2, 0.8, 5); add('floor', 'f3', 4, 0.6, 5);
    add('ceiling', 'c1', 10, 0.2, 5); add('ceiling', 'c2', 12, 0, 5.0001);
    add('focal', 'good', 10, 0.2, 5); add('focal', 'poor', 1, 0.9, 5);
    const r = scoreUnits(combineStrata(rows), [{ id: 'up', dir: 1 }, { id: 'down', dir: -1 }, { id: 'flat', dir: 1 }]);
    assert.equal(r.stats.flat.separates, false);
    const good = r.units.find(u => u.id === 'good'), poor = r.units.find(u => u.id === 'poor');
    assert.equal(good.metrics.up.position, (10 - 2) / (11 - 2));
    assert.equal(good.metrics.flat.position, null);
    assert.equal(good.rank, 5);
    assert.equal(poor.rank, 1);
});

test('weightedMedian splits the weight in half', () => {
    assert.equal(weightedMedian([[1, 1], [2, 1], [3, 1]]), 2);
    assert.equal(weightedMedian([[1, 1], [2, 1]]), 1.5);
    assert.equal(weightedMedian([[1, 1], [9, 3]]), 9);
    assert.equal(weightedMedian([]), null);
});

test('scoreUnits: pooled scores the focal units as one, weighted by area', () => {
    const rows = [
        { grp: 'focal', id: 'a', stratum: 0, variable: 'x', value: 5, w: 3 },
        { grp: 'focal', id: 'b', stratum: 0, variable: 'x', value: 3, w: 1 },
        { grp: 'focal', id: 'c', stratum: 0, variable: 'x', value: -100, w: 1 },
        { grp: 'floor', id: 'f', stratum: 0, variable: 'x', value: 0, w: 1 },
        { grp: 'ceiling', id: 'c', stratum: 0, variable: 'x', value: 10, w: 1 },
    ];
    const r = scoreUnits(combineStrata(rows), [{ id: 'x', dir: 1 }]);
    assert.equal(r.pooled.metrics.x.value, 5);
    assert.equal(r.pooled.metrics.x.position, 0.5);
    assert.equal(r.pooled.rank, 3);
    assert.equal(r.set.metrics.x.value, 3);
});
