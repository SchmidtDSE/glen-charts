// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestOption, paramTokens } from '../core/engine.js';

const adjust = { id: 'adjust', token: 'ADJUST', control: 'number', options: [-1, -0.5, 0, 0.5, 1], default: 0 };

test('nearestOption snaps a typed number to the closest option', () => {
    assert.equal(nearestOption(adjust, 0.3), 0.5);
    assert.equal(nearestOption(adjust, -0.74), -0.5);
    assert.equal(nearestOption(adjust, 0), 0);
});

test('nearestOption holds a value past either end to that end', () => {
    assert.equal(nearestOption(adjust, 9), 1);
    assert.equal(nearestOption(adjust, -40), -1);
});

test('a snapped value is always a valid token', () => {
    for (const x of [-3, -0.26, 0.24, 0.76, 7]) {
        const v = nearestOption(adjust, x);
        assert.doesNotThrow(() => paramTokens({ params: [adjust] }, { adjust: v }));
    }
});

test('a chosen option binds its own tokens', () => {
    const source = { id: 'source', token: 'SOURCE', default: 'a', options: [
        { value: 'a', label: 'A', tokens: { UNIT_URL: 'https://x/a.pmtiles', UNIT_NAME: 'name' } },
        { value: 'b', label: 'B', tokens: { UNIT_URL: 'https://x/b.pmtiles', UNIT_NAME: 'facility_name' } },
    ] };
    assert.deepEqual(paramTokens({ params: [source] }, {}), { SOURCE: 'a', UNIT_URL: 'https://x/a.pmtiles', UNIT_NAME: 'name' });
    assert.equal(paramTokens({ params: [source] }, { source: 'b' }).UNIT_NAME, 'facility_name');
});
