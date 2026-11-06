// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveParams, paramKey, paramCombos, paramActive } from '../core/engine.js';

const app = { params: [
    { id: 'manager', options: ['all', 'federal', 'state'], default: 'all' },
    { id: 'agency', options: ['all', 'usfs', 'blm'], default: 'all', when: { manager: 'federal' } },
] };

test('a dependent param applies only where its when matches', () => {
    assert.equal(paramActive(app.params[1], app, { manager: 'federal' }), true);
    assert.equal(paramActive(app.params[1], app, { manager: 'state' }), false);
});

test('a dependent param is held at its default where it does not apply', () => {
    assert.deepEqual(resolveParams(app, { manager: 'federal', agency: 'usfs' }), { manager: 'federal', agency: 'usfs' });
    assert.deepEqual(resolveParams(app, { manager: 'state', agency: 'usfs' }), { manager: 'state', agency: 'all' });
});

test('paramKey leaves out a param that does not apply', () => {
    assert.equal(paramKey(app, { manager: 'all', agency: 'all' }), 'manager-all');
    assert.equal(paramKey(app, { manager: 'federal', agency: 'usfs' }), 'agency-usfs_manager-federal');
});

test('paramCombos lists each setting once', () => {
    const keys = paramCombos(app, { manager: 'all', agency: 'all' }).map(c => paramKey(app, c));
    assert.deepEqual(keys, ['manager-all', 'agency-all_manager-federal', 'agency-usfs_manager-federal', 'agency-blm_manager-federal', 'manager-state']);
});

test('paramCombos takes a dependent value given with the param it depends on', () => {
    const keys = paramCombos(app, { manager: 'federal', agency: 'usfs' }).map(c => paramKey(app, c));
    assert.deepEqual(keys, ['agency-usfs_manager-federal']);
});
