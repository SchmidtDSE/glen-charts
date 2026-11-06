// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveParams, paramTokens, paramKey, paramValueLabel, paramCombos, rangeValue, paramDefault, toggleGroup, statewideAoi } from '../core/engine.js';

const years = { id: 'years', label: 'Years', token: 'YEAR', control: 'range', options: [1990, 2000, 2010, 2020, { value: 2025, label: 'Now' }] };
const width = { id: 'width', token: 'WIDTH', options: [5, 10, 20], default: 10 };
const app = { params: [years, width] };

test('a range param defaults to the full span, or its default', () => {
    assert.deepEqual(paramDefault(years), [1990, 2025]);
    assert.deepEqual(paramDefault({ ...years, default: [2010, 2000] }), [2000, 2010]);
    assert.deepEqual(resolveParams(app), { years: [1990, 2025], width: 10 });
});

test('range values are two declared stops, low first', () => {
    assert.deepEqual(rangeValue(years, '2020,2000'), [2000, 2020]);
    assert.deepEqual(rangeValue(years, [2010, 2010]), [2010, 2010]);
    assert.equal(rangeValue(years, '2001,2020'), null);
    assert.equal(rangeValue(years, '2000'), null);
    assert.equal(rangeValue(years, "2000,2020); DROP TABLE t; --"), null);
    // an invalid link value falls back to the default
    assert.deepEqual(resolveParams(app, { years: 'bogus' }).years, [1990, 2025]);
    assert.deepEqual(resolveParams(app, { years: '2010,2000' }).years, [2000, 2010]);
});

test('a range binds two tokens, _MIN and _MAX or its own names', () => {
    const t = paramTokens(app, { years: [2000, 2020], width: 20 });
    assert.deepEqual(t, { YEAR_MIN: '2000', YEAR_MAX: '2020', WIDTH: '20' });
    assert.deepEqual(paramTokens({ params: [{ ...years, tokens: ['SINCE', 'UNTIL'] }] }, { years: [2010, 2025] }), { SINCE: '2010', UNTIL: '2025' });
    assert.throws(() => paramTokens(app, { years: [2001, 2020] }), /Invalid value for years/);
});

test('range cache key and settings line', () => {
    assert.equal(paramKey(app, { years: [2000, 2020] }), 'width-10_years-2000~2020');
    assert.equal(paramValueLabel(years, [2000, 2025]), '2000 – Now');
    assert.equal(paramValueLabel(years, [2010, 2010]), '2010');
    assert.equal(paramValueLabel({ ...years, all_label: 'All years' }, [1990, 2025]), 'All years');
    assert.equal(paramValueLabel({ ...years, all_label: 'All years' }, [1990, 2020]), '1990 – 2020');
});

test('precompute: every span of a range with all, one span when given', () => {
    assert.equal(paramCombos(app, { years: 'all' }).length, 15);       // 5 stops: 5 + 4 + 3 + 2 + 1 spans
    assert.deepEqual(paramCombos(app, { years: '2000,2010' }), [{ years: [2000, 2010], width: 10 }]);
});

test('the whole-region area expands range tokens', () => {
    const a = statewideAoi({ ...app, statewide: { aoi: 'SELECT * FROM g WHERE y BETWEEN {{YEAR_MIN}} AND {{YEAR_MAX}}' } }, { years: [2000, 2010], width: 5 });
    assert.equal(a.sql, 'SELECT * FROM g WHERE y BETWEEN 2000 AND 2010');
});

test('a group heading chooses or clears its whole group', () => {
    const funder = {
        id: 'funder', token: 'FUNDER', multiple: true, any: 'any', default: 'any',
        options: [{ value: 'any', label: 'All funders' },
            { value: 'wcb', group: 'State' }, { value: 'scc', group: 'State' },
            { value: 'lwcf', group: 'Federal' }, { value: 'usfws', group: 'Federal' }],
    };
    assert.deepEqual(toggleGroup(funder, ['any'], 'State'), ['wcb', 'scc']);              // clears "any"
    assert.deepEqual(toggleGroup(funder, ['scc', 'lwcf'], 'State'), ['wcb', 'scc', 'lwcf']); // part chosen: add the rest
    assert.deepEqual(toggleGroup(funder, ['wcb', 'scc', 'lwcf'], 'State'), ['lwcf']);      // all chosen: clear it
    assert.deepEqual(toggleGroup(funder, ['wcb', 'scc'], 'State'), ['any']);               // never empty: back to "any"
    const noAny = { ...funder, any: undefined, default: undefined, options: funder.options.slice(1) };
    assert.deepEqual(toggleGroup(noAny, ['wcb', 'scc'], 'State'), ['wcb', 'scc']);         // without "any": kept
    assert.equal(paramTokens({ params: [funder] }, { funder: toggleGroup(funder, ['any'], 'Federal') }).FUNDER, "'lwcf', 'usfws'");
});
