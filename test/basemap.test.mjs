import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basemapChoices } from '../core/map.js';

const keys = app => basemapChoices(app).choices.map(c => c.key);

test('the app basemap and satellite by default', () => {
    assert.deepEqual(keys({}), ['light-gray', 'satellite']);
    assert.deepEqual(keys({ basemap: 'natgeo' }), ['natgeo', 'satellite']);
    assert.deepEqual(keys({ basemap: 'satellite' }), ['satellite']);
    assert.equal(basemapChoices({}).choices[0].label, 'Plain');
});

test('basemaps false or a list of one leaves the switch out', () => {
    assert.deepEqual(keys({ basemaps: false }), ['light-gray']);
    assert.deepEqual(keys({ basemap: 'dark-gray', basemaps: false }), ['dark-gray']);
    assert.deepEqual(keys({ basemaps: ['natgeo'] }), ['natgeo']);
});

test('basemap picks the one shown first from a list', () => {
    assert.equal(basemapChoices({ basemaps: ['light-gray', 'satellite'], basemap: 'satellite' }).shown, 1);
    assert.equal(basemapChoices({ basemaps: ['light-gray', 'satellite'], basemap: 'natgeo' }).shown, 0);
});

test('custom basemaps and unknown names', () => {
    const { choices } = basemapChoices({ basemap: { tiles: 'https://t/{z}/{x}/{y}.png', label: 'Topo' } });
    assert.deepEqual(choices.map(c => [c.key, c.label]), [['custom-0', 'Topo'], ['satellite', 'Satellite']]);
    assert.deepEqual(keys({ basemaps: ['nope', 'satellite'] }), ['satellite']);
    assert.deepEqual(keys({ basemaps: ['nope'] }), ['light-gray']);
});
