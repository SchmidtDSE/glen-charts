import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resAtZoom, quantileCuts, classOf, lowestText, rampFor, LAYER_RAMP, viewUnitsSql, layerSql, overviewUnitsSql, OVERVIEW_RES } from '../core/layer-map.js';

test('resAtZoom: overview below zoom 8, then finer every two levels', () => {
    assert.equal(resAtZoom(5), OVERVIEW_RES);
    assert.equal(resAtZoom(8), 7);
    assert.equal(resAtZoom(10.5), 8);
    assert.equal(resAtZoom(14), 9);
});

test('quantileCuts: k − 1 increasing cut points, ties merged', () => {
    assert.deepEqual(quantileCuts([1, 2, 3, 4, 5, 6, 7, 8], 4), [3, 5, 7]);
    assert.deepEqual(quantileCuts([0, 0, 0, 0, 1], 4), [0]);
    assert.deepEqual(quantileCuts([], 4), []);
    assert.deepEqual(quantileCuts([0, 0, 0.5, 1, 1, 1, 1, 1], 4), [0.5]);
});

test('viewUnitsSql: resolution-7 hexagons become their resolution-8 children', () => {
    const s7 = viewUnitsSql([-75.5, -8.5, -75, -8], 7);
    assert.match(s7, /h3_cell_to_children\(c, 8\)/);
    assert.match(s7, /POLYGON\(\(-75\.50000 -8\.50000/);
    assert.doesNotMatch(viewUnitsSql([-75.5, -8.5, -75, -8], 9), /children/);
    assert.throws(() => viewUnitsSql([-75.5, -8.5, -75, NaN], 8));
    assert.throws(() => viewUnitsSql([-75.5, -8.5, -75, -8], 6));
});

test('layerSql fills the theme query and keeps one variable', () => {
    const sql = layerSql('SELECT * FROM ({{UNITS}}) WHERE x IN ({{H0S}})', { H0S: '1, 2' }, overviewUnitsSql('SELECT h8 FROM t'), 'msa');
    assert.match(sql, /WHERE variable = 'msa'/);
    assert.match(sql, /h3_cell_to_parent\(h8, 6\)/);
    assert.match(sql, /IN \(1, 2\)/);
    assert.throws(() => layerSql('{{UNITS}}', {}, 'x', "msa'; DROP"));
});

test('classOf: ties at a cut stay in the lower class', () => {
    assert.equal(classOf(0, [0]), 0);
    assert.equal(classOf(1, [0]), 1);
    assert.equal(classOf(5, [3, 5, 7]), 1);
});

test('rampFor: few classes take the ends of the ramp', () => {
    assert.deepEqual(rampFor(2), [LAYER_RAMP[0], LAYER_RAMP[6]]);
    assert.deepEqual(rampFor(7), LAYER_RAMP);
});

test('lowestText: a lowest cut at the data minimum is that value alone', () => {
    assert.equal(lowestText(0, 0, '0%'), '0%');
    assert.equal(lowestText(5, 0, '5%'), '5% or less');
    assert.equal(lowestText(5, undefined, '5%'), '5% or less');
});
