// node --test test/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, scoreDrawn, percentileAmong, isComparable, isFalse, parseState, defaultState } from '../core/leaderboard.js';
import { drawnRank } from '../charts/percentile-strip.js';
import { Engine } from '../core/engine.js';

const spec = {
    pillars: [
        { theme: 'a', variables: { total: { comparable: false } } },
        { theme: 'b', weight: 2 },
    ],
};
const pillar = (id, vars) => ({ theme: { id }, query: 'q', label: id, color: '#000', variables: vars.map(([variable, dir, comparable = true]) => ({ variable, key: `${id}.${variable}`, label: variable, dir, comparable })) });
const data = {
    pillars: [pillar('a', [['share', 1], ['total', 1, false]]), pillar('b', [['cost', -1]])],
    rows: [1, 2, 3, 4].map(i => ({ id: String(i), name: `area ${i}`, inScope: true, share: null, vals: { 'a.share': i, 'a.total': 100 * i, 'b.cost': i } })),
};

test('percentileAmong counts the value as one more member, by the leaderboard mid-rank', () => {
    assert.equal(percentileAmong([1, 2, 3, 4], 5), 100);
    assert.equal(percentileAmong([1, 2, 3, 4], 0), 0);
    assert.equal(percentileAmong([1, 2, 3, 4], 2.5), 50);
    assert.equal(percentileAmong([1, 2, 3, 4], 2), 37.5);      // ties with 2: ranks 1–2 of 0–4
    assert.equal(percentileAmong([1, 2, 3, 4], 5, -1), 0);     // lower is better
    assert.equal(percentileAmong([], 1), null);
    assert.equal(percentileAmong([1, 2], null), null);
});

test('a drawn area at the middle of every variable ranks among n + 1', () => {
    const state = defaultState(spec);
    const res = scoreDrawn(data, { 'a.share': 2.5, 'b.cost': 2.5 }, state, spec);
    assert.equal(res.of, 5);
    assert.equal(res.pct['a.share'], 50);
    assert.equal(res.pct['b.cost'], 50);
    assert.equal(res.overall, 50);
    assert.equal(res.rank, 3);
    assert.equal(res.pillars.a.of, 5);
    assert.equal(res.partial, false);
    // the named areas themselves score as without it, give or take the extra member
    assert.equal(score(data, state, spec).ranked, 4);
});

test('a drawn area best on every variable ranks first; missing pillars make it partial', () => {
    const state = defaultState(spec);
    assert.equal(scoreDrawn(data, { 'a.share': 9, 'b.cost': 0 }, state, spec).rank, 1);
    const part = scoreDrawn(data, { 'a.share': 9 }, state, spec);
    assert.equal(part.partial, true);
    assert.equal(part.overall, 100);
    assert.equal(part.pillars.b.score, null);
});

test('pillar weights and variable reversal from the link apply to a drawn area', () => {
    const state = parseState(spec, 'b=0;b.cost=-1');
    assert.equal(state.pillars.b, 0);
    assert.equal(state.vars['b.cost'].rev, true);
    const res = scoreDrawn(data, { 'a.share': 0, 'b.cost': 0 }, state, spec);
    assert.equal(res.overall, 0);          // pillar b off; worst on a
    assert.equal(res.rank, 5);
});

test('comparable flags: leaderboard variables and row columns', () => {
    const app = { leaderboard: spec };
    assert.equal(isComparable(app, 'a', 'total'), false);
    assert.equal(isComparable(app, 'a', 'share'), true);
    assert.equal(isComparable(app, 'b', 'cost', { comparable: 'false' }), false);
    assert.equal(isComparable({}, 'x', 'y'), true);
    assert.ok(isFalse(0) && isFalse('No') && !isFalse(null) && !isFalse(1));
});

test('percentile strip ranks a drawn area by the row dir unless direction_field is given', () => {
    assert.equal(drawnRank({}, { dir: -1 }, 5, [1, 2, 3, 4]), 0);
    assert.equal(drawnRank({}, {}, 5, [1, 2, 3, 4]), 100);
    assert.equal(drawnRank({ direction_field: 'd' }, { d: 1, dir: -1 }, 5, [1, 2, 3, 4]), 100);
});

test('distribution of a drawn area reads its comparison type', async () => {
    const theme = { id: 't', queries: { q: { file: 'q.sql', all: 'q-all.sql' } } };
    const engine = new Engine({ app: { params: [], jurisdictions: [{ id: 'eco' }] } }, { client: { query: async () => [] }, dataBase: null });
    const seen = [];
    engine.allResults = (th, q, aoi) => { seen.push(aoi.kind); return Promise.resolve({ 1: [{ variable: 'x', value: 1 }] }); };
    assert.equal(await engine.distribution(theme, 'q', { kind: 'polygon', key: 'poly:1' }), null);
    const d = await engine.distribution(theme, 'q', { kind: 'polygon', key: 'poly:1', compareKind: 'eco' });
    assert.deepEqual(seen, ['eco']);
    assert.deepEqual(d, [{ __id: '1', variable: 'x', value: 1 }]);
});

test('drawn_pct fills a percentile column for a drawn area, leaving non-comparable rows null', async () => {
    const theme = { id: 't', queries: { q: { file: 'q.sql', all: 'q-all.sql', drawn_pct: { field: 'pct', scale: 0.01 } } } };
    const app = { params: [], jurisdictions: [{ id: 'eco' }] };
    const live = [{ variable: 'x', value: 5, dir: 1, pct: null }, { variable: 'y', value: 5, dir: -1, pct: null }, { variable: 'tot', value: 9, comparable: false, pct: null }];
    const engine = new Engine({ app }, { client: { query: async () => live }, dataBase: null });
    engine.sqlFor = () => 'SELECT 1';
    const all = Object.fromEntries([1, 2, 3, 4].map(i => [i, [{ variable: 'x', value: i }, { variable: 'y', value: i }, { variable: 'tot', value: i }]]));
    engine.allResults = async () => all;
    const rows = await engine.run(theme, 'q', { kind: 'polygon', key: 'poly:1', compareKind: 'eco', source: 'draw' });
    assert.deepEqual(rows.map(r => r.pct), [1, 0, null]);
    assert.deepEqual(rows.map(r => r.__not_compared), [undefined, undefined, 'pct']);
    // a named area's rows are left as they are
    const named = await engine.drawnPct(theme, 'q', { kind: 'eco', id: '1', compareKind: 'eco' }, live);
    assert.equal(named, live);
});

test('polygonAoi fills at res 8 without sql10 when asked', async () => {
    const { polygonAoi } = await import('../sources/polygon.js');
    const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const a8 = polygonAoi([g], 'x', { res: 8 });
    assert.equal(a8.sql10, undefined);
    assert.match(a8.sql, /h3_polygon_wkt_to_cells\(wkt, 8\)/);
    assert.notEqual(a8.key, polygonAoi([g], 'x').key);
    assert.match(polygonAoi([g], 'x').sql10, /wkt, 10/);
    assert.throws(() => polygonAoi([g], 'x', { res: 9 }));
});
