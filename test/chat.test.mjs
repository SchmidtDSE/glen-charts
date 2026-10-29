// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mdLite } from '../core/chat.js';
import { Engine, jurisdictionAoi } from '../core/engine.js';
import { polygonAoi } from '../sources/polygon.js';

test('the explorer imports chat.js only when app.chat is set', () => {
    const src = readFileSync(new URL('../core/explorer.js', import.meta.url), 'utf8');
    assert.ok(!/^import .*chat\.js/m.test(src), 'no static import of chat.js');
    assert.match(src, /if \(app\.chat\) this\.mountChat\(\)/);
});

test('expandFor fills area and param tokens in chat SQL', () => {
    const app = { params: [{ id: 'ptype', token: 'PTYPE', options: ['Any', 'Acquisition'], default: 'Any' }], jurisdictions: [] };
    const engine = new Engine({ app, themes: [] }, { mcpUrl: 'http://x', dataBase: null });
    const jur = { id: 'county', aoi: "SELECT h0, h8 FROM c WHERE id = '{{ID}}'", aoi10: "SELECT h0, h8, h10 FROM c WHERE id = '{{ID}}'" };
    const aoi = jurisdictionAoi(jur, { id: '06037', name: 'Los Angeles County' }, app, { ptype: 'Acquisition' });
    const sql = engine.expandFor("SELECT * FROM ({{AOI10}}) WHERE '{{ID}}' = '{{KIND}}' AND '{{PTYPE}}' = 'x'", aoi);
    assert.match(sql, /WHERE id = '06037'\)/);
    assert.match(sql, /'06037' = 'county'/);
    assert.match(sql, /'Acquisition' = 'x'/);
    assert.throws(() => engine.expandFor('{{NOPE}}', aoi), /Unbound template token/);
});

test('a polygon smaller than a cell falls back to its interior point', () => {
    const sq = { type: 'Polygon', coordinates: [[[-122.27, 37.8], [-122.2698, 37.8], [-122.2698, 37.8002], [-122.27, 37.8002], [-122.27, 37.8]]] };
    const aoi = polygonAoi([sq], 'parcel');
    assert.match(aoi.sql10, /CASE WHEN len\(cs\) = 0 THEN \[h3_latlng_to_cell\(lat, lng, 10\)\]/);
    assert.match(aoi.sql10, /37\.800100, -122\.269900\)/);
});

test('mdLite escapes HTML and renders lists, bold and links', () => {
    assert.equal(mdLite('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
    assert.equal(mdLite('- a\n- **b**'), '<ul><li>a</li><li><b>b</b></li></ul>');
    assert.match(mdLite('see https://example.com/a'), /<a href="https:\/\/example.com\/a"/);
});

test('queryParamKey keys a query by only the params it declares', async () => {
    const { queryParamKey, paramKey } = await import('../core/engine.js');
    const app = { params: [{ id: 'a', options: [1, 2], default: 1 }, { id: 'b', options: ['x', 'y'], default: 'x' }] };
    assert.equal(queryParamKey(app, { file: 'q.sql' }, { a: 2, b: 'y' }), paramKey(app, { a: 2, b: 'y' }));
    assert.equal(queryParamKey(app, { file: 'q.sql', params: [] }, { a: 2, b: 'y' }), '');
    assert.equal(queryParamKey(app, { file: 'q.sql', params: ['b'] }, { a: 2, b: 'y' }), 'b-y');
});
