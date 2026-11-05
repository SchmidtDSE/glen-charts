// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveParams, paramTokens, paramKey, paramCombos, matchesWhen, toggleMulti, paramValueLabel,
    jurisdictionAoi, Engine,
} from '../core/engine.js';

const ptype = {
    id: 'ptype', token: 'PTYPE', multiple: true, any: 'Any', default: 'Acquisition',
    options: ['Any', 'Acquisition', 'Easement', 'Restoration', { value: 'Planning/Design', label: 'Planning' }],
};
const applicant = {
    id: 'applicant', token: 'APPLICANT', multiple: true, default: '501(c)(3)',
    options: [{ value: '501(c)(3)', label: 'Nonprofit' }, { value: 'Tribe', label: 'Tribe' }, { value: "O'Brien", label: 'Quote' }],
};
const width = { id: 'width', token: 'WIDTH', options: [5, 10, 20], default: 10 };
const app = { params: [ptype, applicant, width] };

test('a multiple param resolves to a list in option order', () => {
    const p = resolveParams(app, { ptype: ['Restoration', 'Acquisition'], width: 20 });
    assert.deepEqual(p.ptype, ['Acquisition', 'Restoration']);
    assert.deepEqual(p.applicant, ['501(c)(3)']);
    assert.equal(p.width, 20);
});

test('a link value is comma-separated; unknown values are dropped', () => {
    assert.deepEqual(resolveParams(app, { ptype: 'Easement,Nope,Acquisition' }).ptype, ['Acquisition', 'Easement']);
    assert.deepEqual(resolveParams(app, { ptype: 'Nope' }).ptype, ['Any']);
    assert.deepEqual(resolveParams(app, { applicant: 'Nope' }).applicant, ['501(c)(3)']);
});

test('"any" is exclusive and the fallback for an empty choice', () => {
    assert.deepEqual(resolveParams(app, { ptype: ['Any', 'Easement'] }).ptype, ['Easement']);
    assert.deepEqual(toggleMulti(ptype, ['Acquisition', 'Easement'], 'Any'), ['Any']);
    assert.deepEqual(toggleMulti(ptype, ['Any'], 'Easement'), ['Easement']);
    assert.deepEqual(toggleMulti(ptype, ['Easement'], 'Acquisition'), ['Acquisition', 'Easement']);
    assert.deepEqual(toggleMulti(ptype, ['Easement'], 'Easement'), ['Any']);
    assert.deepEqual(toggleMulti(ptype, ['Any'], 'Any'), ['Any']);
});

test('without "any", the last pill cannot be cleared', () => {
    assert.deepEqual(toggleMulti(applicant, ['Tribe'], 'Tribe'), ['Tribe']);
    assert.deepEqual(toggleMulti(applicant, ['Tribe'], '501(c)(3)'), ['501(c)(3)', 'Tribe']);
});

test('a multiple param token is a quoted SQL list', () => {
    const t = paramTokens(app, resolveParams(app, { ptype: ['Acquisition', 'Planning/Design'], applicant: ["O'Brien"] }));
    assert.equal(t.PTYPE, "'Acquisition', 'Planning/Design'");
    assert.equal(t.APPLICANT, "'O''Brien'");
    assert.equal(t.WIDTH, '10');
    const n = { params: [{ id: 'w', multiple: true, options: [5, 10, 20], default: [5, 20] }] };
    assert.equal(paramTokens(n, resolveParams(n)).W, '5, 20');
    assert.throws(() => paramTokens(app, { ptype: ['Bogus'] }), /Invalid value/);
});

test('paramKey joins a list with +; single values are unchanged', () => {
    const k = paramKey(app, resolveParams(app, { ptype: ['Acquisition', 'Planning/Design'] }));
    assert.equal(k, 'applicant-501_c_3__ptype-Acquisition+Planning_Design_width-10');
    assert.equal(paramKey({ params: [width] }, { width: 20 }), 'width-20');
});

test('when on a multiple param matches only if every chosen value is named', () => {
    assert.ok(matchesWhen({ ptype: ['Acquisition', 'Easement'] }, app, { ptype: ['Acquisition'] }));
    assert.ok(matchesWhen({ ptype: ['Acquisition', 'Easement'] }, app, { ptype: ['Acquisition', 'Easement'] }));
    assert.ok(!matchesWhen({ ptype: 'Acquisition' }, app, { ptype: ['Acquisition', 'Easement'] }));
    assert.ok(matchesWhen({ width: 10 }, app, { width: 10 }));
});

test('paramCombos takes each option of a multiple param on its own for "all"', () => {
    const c = paramCombos({ params: [ptype, width] }, { ptype: 'all' });
    assert.equal(c.length, ptype.options.length);
    assert.deepEqual(c[1], { ptype: ['Acquisition'], width: 10 });
    assert.deepEqual(paramCombos({ params: [ptype] }, { ptype: 'Easement,Acquisition' }), [{ ptype: ['Acquisition', 'Easement'] }]);
});

test('paramValueLabel joins option labels', () => {
    assert.equal(paramValueLabel(ptype, ['Acquisition', 'Planning/Design']), 'Acquisition, Planning');
    assert.equal(paramValueLabel(width, 10), '10');
});

const county = { id: 'county', aoi: "SELECT DISTINCT h0, h8 FROM t WHERE GEOID = '{{ID}}' AND w = {{WIDTH}}" };

test('one feature, alone or in a list, gives the same area as before', () => {
    const a = jurisdictionAoi(county, { id: '06001', name: 'Alameda' }, app, resolveParams(app));
    const b = jurisdictionAoi(county, [{ id: '06001', name: 'Alameda' }], app, resolveParams(app));
    assert.deepEqual(a, b);
    assert.equal(a.id, '06001');
    assert.deepEqual(a.ids, ['06001']);
    assert.ok(!a.sql.includes('UNION'));
});

test('several features are the union of their cells, with IDS bound and ID not', () => {
    const params = resolveParams(app);
    const a = jurisdictionAoi(county, [{ id: '06001', name: 'Alameda' }, { id: '06013', name: 'Contra Costa' }, { id: '06075', name: 'SF' }], app, params);
    assert.equal(a.id, null);
    assert.deepEqual(a.ids, ['06001', '06013', '06075']);
    assert.equal(a.label, 'Alameda, Contra Costa and SF');
    assert.match(a.key, /^county:06001\+06013\+06075@/);
    assert.equal(a.sql.split('UNION').length, 3);
    assert.match(a.sql, /GEOID = '06013' AND w = 10/);
    const e = new Engine({ app, themes: [] }, { client: { query: async () => [] }, dataBase: null });
    const t = e.tokensFor(a);
    assert.equal(t.IDS, "'06001', '06013', '06075'");
    assert.equal(t.KIND, 'county');
    assert.ok(!('ID' in t));
    assert.throws(() => e.expandFor("SELECT '{{ID}}'", a), /Unbound template token \{\{ID\}\}/);
});

test('IDS is bound for a single named area too', () => {
    const e = new Engine({ app, themes: [] }, { client: { query: async () => [] }, dataBase: null });
    const a = jurisdictionAoi(county, { id: '06001', name: 'Alameda' }, app, resolveParams(app));
    assert.equal(e.tokensFor(a).IDS, "'06001'");
    assert.equal(e.tokensFor(a).ID, '06001');
});
