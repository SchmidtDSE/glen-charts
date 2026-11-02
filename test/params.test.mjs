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
