// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveParams, paramTokens, paramKey, paramText, paramLabel, paramCombos, normalizeParam, statewideAoi } from '../core/engine.js';

const funder = {
    id: 'funder', label: 'Funder', token: 'FUNDER', control: 'multi',
    options: [
        { value: 'wcb', label: 'WCB', group: 'State' },
        { value: 'scc', label: 'Coastal Conservancy', group: 'State' },
        { value: 'lwcf', label: 'LWCF', group: 'Federal' },
        { value: "o'neil", label: "O'Neil Fund" },
    ],
};
const years = {
    id: 'years', label: 'Years', token: 'YEAR', control: 'range',
    options: [1990, 2000, 2010, 2020, { value: 2025, label: 'Now' }],
};
const width = { id: 'width', token: 'WIDTH', options: [5, 10, 20], default: 10 };
const app = { params: [funder, years, width] };

test('defaults: every option of a multi, the full span of a range', () => {
    assert.deepEqual(resolveParams(app), { funder: ['wcb', 'scc', 'lwcf', "o'neil"], years: [1990, 2025], width: 10 });
    assert.deepEqual(resolveParams({ params: [{ ...funder, default: ['lwcf'] }, { ...years, default: [2000, 2010] }] }),
        { funder: ['lwcf'], years: [2000, 2010] });
});

test('multi values keep only declared options, in option order', () => {
    assert.deepEqual(normalizeParam(funder, 'lwcf,wcb'), ['wcb', 'lwcf']);
    assert.deepEqual(normalizeParam(funder, ['lwcf', "x'); DROP TABLE t; --"]), ['lwcf']);
    assert.equal(normalizeParam(funder, 'nope'), null);
    assert.equal(normalizeParam(funder, ''), null);
    assert.deepEqual(normalizeParam(funder, 'all'), ['wcb', 'scc', 'lwcf', "o'neil"]);
    // an invalid link value falls back to the default
    assert.deepEqual(resolveParams(app, { funder: 'bogus' }).funder, ['wcb', 'scc', 'lwcf', "o'neil"]);
});

test('range values are two declared stops, low first', () => {
    assert.deepEqual(normalizeParam(years, '2020,2000'), [2000, 2020]);
    assert.deepEqual(normalizeParam(years, [2010, 2010]), [2010, 2010]);
    assert.equal(normalizeParam(years, '2001,2020'), null);
    assert.equal(normalizeParam(years, '2000'), null);
});

test('tokens: a SQL list for multi, two numbers for range', () => {
    const t = paramTokens(app, { funder: ['wcb', "o'neil"], years: [2000, 2020], width: 20 });
    assert.equal(t.FUNDER, "['wcb', 'o''neil']");
    assert.equal(t.FUNDER_ALL, 'false');
    assert.equal(t.YEAR_MIN, '2000');
    assert.equal(t.YEAR_MAX, '2020');
    assert.equal(t.WIDTH, '20');
    assert.equal(paramTokens(app, {}).FUNDER_ALL, 'true');
    // a range may name its own tokens
    const t2 = paramTokens({ params: [{ ...years, tokens: ['SINCE', 'UNTIL'] }] }, { years: [2010, 2025] });
    assert.deepEqual(t2, { SINCE: '2010', UNTIL: '2025' });
    assert.throws(() => paramTokens(app, { funder: ['nope'] }), /Invalid value for funder/);
});

test('link text, cache key and settings line', () => {
    assert.equal(paramText(funder, ['wcb', 'lwcf']), 'wcb,lwcf');
    assert.equal(paramText(funder, ['wcb', 'scc', 'lwcf', "o'neil"]), 'all');
    assert.equal(paramText(years, [2000, 2020]), '2000,2020');
    assert.equal(paramKey(app, { funder: ['wcb', 'lwcf'], years: [2000, 2020] }), 'funder-wcb_lwcf_width-10_years-2000_2020');
    assert.equal(paramKey(app, {}), 'funder-all_width-10_years-1990_2025');
    assert.equal(paramLabel(funder, ['wcb', 'lwcf']), 'WCB, LWCF');
    assert.equal(paramLabel(funder, 'all'), 'All');
    assert.equal(paramLabel({ ...funder, all_label: 'All funders' }, 'all'), 'All funders');
    assert.equal(paramLabel(years, [2000, 2025]), '2000 – Now');
    assert.equal(paramLabel(years, [2010, 2010]), '2010');
    assert.equal(paramLabel({ ...years, all_label: 'All years' }, [1990, 2025]), 'All years');
    assert.equal(paramLabel(width, 20), '20');
});

test('precompute combinations: all spans of a range, one value for a multi', () => {
    const combos = paramCombos(app, { years: 'all', funder: 'all' });
    assert.equal(combos.length, 15);                     // 5 stops: 5 + 4 + 3 + 2 + 1 spans
    assert.ok(combos.every(c => c.funder.length === 4 && c.width === 10));
    assert.deepEqual(paramCombos(app, { funder: 'wcb,scc' }).map(c => c.funder), [['wcb', 'scc']]);
});

test('the whole-region area expands multi and range tokens', () => {
    const a = statewideAoi({ ...app, statewide: { aoi: 'SELECT * FROM g WHERE list_contains({{FUNDER}}, f) AND y BETWEEN {{YEAR_MIN}} AND {{YEAR_MAX}}' } },
        { funder: ['scc'], years: [2000, 2010], width: 5 });
    assert.equal(a.sql, "SELECT * FROM g WHERE list_contains(['scc'], f) AND y BETWEEN 2000 AND 2010");
    assert.equal(a.key, 'statewide@funder-scc_width-5_years-2000_2010');
});
