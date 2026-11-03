// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesWhen } from '../core/engine.js';

const app = { params: [{ id: 'manager', options: ['all', 'federal', 'state'], default: 'all' }, { id: 'width', options: [5, 10], default: 10 }] };

test('an item without when always applies', () => {
    assert.equal(matchesWhen(undefined, app, { manager: 'state' }), true);
});

test('when takes a value or a list of values', () => {
    assert.equal(matchesWhen({ manager: 'all' }, app, { manager: 'all' }), true);
    assert.equal(matchesWhen({ manager: 'all' }, app, { manager: 'federal' }), false);
    assert.equal(matchesWhen({ manager: ['federal', 'state'] }, app, { manager: 'state' }), true);
    assert.equal(matchesWhen({ manager: ['federal', 'state'] }, app, { manager: 'all' }), false);
});

test('a param not given is read at its default, and numbers match their strings', () => {
    assert.equal(matchesWhen({ manager: 'all' }, app, {}), true);
    assert.equal(matchesWhen({ width: 10 }, app, { width: '10' }), true);
});

test('every param named must match', () => {
    assert.equal(matchesWhen({ manager: 'all', width: 5 }, app, { manager: 'all', width: 10 }), false);
});
