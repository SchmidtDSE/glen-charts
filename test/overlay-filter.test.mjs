// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayFilter } from '../core/engine.js';

const app = { params: [
    { id: 'manager', label: 'Managed by', default: 'all', options: [
        { value: 'all', label: 'All' },
        { value: 'federal', label: 'Federal', levels: ['Federal'] },
        { value: 'local', label: 'Local', levels: ['City', 'County'] },
    ] },
    { id: 'agency', label: 'Federal manager', multiple: true, any: 'all', default: 'all', when: { manager: 'federal' }, options: [
        { value: 'all', label: 'All federal' },
        { value: 'blm', label: 'BLM', agencies: ['BLM', 'United States Bureau of Land Management'] },
        { value: 'nps', label: 'National Park Service', agencies: ['NPS'] },
    ] },
    { id: 'width', options: [5, 10], default: 5 },
] };
const o = { id: 'units', param_filters: [
    { param: 'manager', property: 'MNG_AG_LEV', values: 'levels' },
    { param: 'agency', property: 'MNG_AGENCY', values: 'agencies' },
] };

test('an option without the values field filters nothing', () => {
    assert.deepEqual(overlayFilter(o, app, { manager: 'all', agency: ['all'] }), { filter: null, note: '' });
});

test('a level keeps its values; the any option of a dependent param adds nothing', () => {
    assert.deepEqual(overlayFilter(o, app, { manager: 'local', agency: ['all'] }),
        { filter: ['match', ['get', 'MNG_AG_LEV'], ['City', 'County'], true, false], note: 'Local' });
});

test('picked options combine with the level, and the note names the picks', () => {
    const r = overlayFilter(o, app, { manager: 'federal', agency: ['blm', 'nps'] });
    assert.deepEqual(r.filter, ['all',
        ['match', ['get', 'MNG_AG_LEV'], ['Federal'], true, false],
        ['match', ['get', 'MNG_AGENCY'], ['BLM', 'United States Bureau of Land Management', 'NPS'], true, false]]);
    assert.equal(r.note, 'BLM and National Park Service');
});

test('a param that does not apply is ignored', () => {
    const r = overlayFilter({ param_filters: [{ param: 'agency', property: 'MNG_AGENCY', values: 'agencies' }] }, app, { manager: 'local', agency: ['blm'] });
    assert.equal(r.filter, null);
});

test('without values, the option value itself is matched, keeping its type', () => {
    assert.deepEqual(overlayFilter({ param_filters: [{ param: 'width', property: 'W' }] }, app, { width: 10 }).filter,
        ['match', ['get', 'W'], [10], true, false]);
});

test('a static or function filter is combined with the param filters', () => {
    const own = ['==', ['get', 'TerrMar'], 'Terrestrial'];
    assert.deepEqual(overlayFilter({ filter: own }, app, {}).filter, own);
    const r = overlayFilter({ ...o, filter: params => (params.width === 10 ? own : null) }, app, { manager: 'federal', agency: ['all'], width: 10 });
    assert.deepEqual(r.filter, ['all', own, ['match', ['get', 'MNG_AG_LEV'], ['Federal'], true, false]]);
});
