import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRequestedTimBranch } from '../lib/order-branch.mjs';

const tim = (address, place_id = 'city_licence:123') => ({ place_id, name: "Tim Horton's", brand: 'tim_hortons', address, fetched_at: '2020-01-01T00:00:00Z' });
const branch = '607 Dunsmuir St, Vancouver, BC V6B 1Y7';

test('a chosen session place copies stable branch identity and survives a long conversation', () => {
  const place = tim(branch), places = new Map([[place.place_id, place]]);
  const result = selectRequestedTimBranch({ placeId: place.place_id }, places);
  assert.deepEqual(result, { branchAddress: branch, placeId: 'city_licence:123', selectionSource: 'nearby_place_id' });
  assert.ok(Object.isFrozen(result));
  place.address = '108 West Pender St, Vancouver BC';
  assert.equal(result.branchAddress, branch);
});

test('matching explicit address binds the known Tim branch without selecting another nearby place', () => {
  const places = new Map([['city_licence:123', tim(branch)], ['node:456', tim('108 West Pender St, Vancouver BC', 'node:456')]]);
  const result = selectRequestedTimBranch({ branchAddress: '607 Dunsmuir Street, Vancouver BC' }, places);
  assert.equal(result.placeId, 'city_licence:123');
  assert.equal(result.branchAddress, branch);
  assert.equal(result.selectionSource, 'nearby_address_match');
});

test('an ID and conflicting branch address cannot silently drift to another restaurant', () => {
  const places = new Map([['city_licence:123', tim(branch)]]);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'city_licence:123', branchAddress: '108 West Pender St, Vancouver BC' }, places), /conflicts/);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'city_licence:123', branchAddress: '607 Dunsmuir St, Burnaby BC' }, places), /conflicts/);
  assert.equal(selectRequestedTimBranch({ placeId: 'city_licence:123', branchAddress: '607 Dunsmuir Street, Vancouver BC' }, places).branchAddress, branch);
});

test('foreign identifiers, unknown session places, non-Tim businesses and mismatched stored IDs are rejected', () => {
  assert.throws(() => selectRequestedTimBranch({ placeId: 'store:102277' }, new Map()), /exact place ID/);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'node:789' }, new Map()), /not in this session/);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'node:789' }, new Map([['node:789', { name: 'Other Café', address: branch }]])), /not a verified Tim/);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'node:789' }, new Map([['node:789', tim(branch, 'node:790')]])), /does not match/);
});

test('ambiguous known Tim matches fail while an explicit unmatched branch is preserved for official lookup', () => {
  const places = new Map([['city_licence:123', tim(branch)], ['node:456', tim(branch, 'node:456')]]);
  assert.throws(() => selectRequestedTimBranch({ branchAddress: branch }, places), /Several nearby/);
  assert.deepEqual(selectRequestedTimBranch({ branchAddress: '650 W Georgia St, Vancouver BC' }, places), { branchAddress: '650 W Georgia St, Vancouver BC', selectionSource: 'explicit_address' });
});

test('direction and branch unit remain part of the chosen branch identity', () => {
  const places = new Map([['node:123', tim('650 Georgia St W, Unit 118, Vancouver BC', 'node:123')]]);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'node:123', branchAddress: '650 Georgia St E, Unit 118, Vancouver BC' }, places), /conflicts/);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'node:123', branchAddress: '650 W Georgia St, Unit 119, Vancouver BC' }, places), /conflicts/);
  assert.throws(() => selectRequestedTimBranch({ placeId: 'node:123', branchAddress: '650 W Georgia St, Vancouver BC' }, places), /conflicts/);
  assert.equal(selectRequestedTimBranch({ placeId: 'node:123', branchAddress: '650 W Georgia Street, Unit 118, Vancouver BC' }, places).placeId, 'node:123');
});

test('no branch choice never falls back to the nearest listing and malformed addresses are refused', () => {
  const places = new Map([['city_licence:123', tim(branch)]]);
  assert.throws(() => selectRequestedTimBranch({}, places), /Choose the Tim Hortons branch/);
  assert.throws(() => selectRequestedTimBranch({ branchAddress: 'Tim Hortons' }, places), /street number/);
  assert.throws(() => selectRequestedTimBranch({ branchAddress: 607 }, places), /invalid/);
});

test('accepting the session offered branch needs no repeated address and never uses Map insertion order', () => {
  const places = new Map([['node:456', tim('108 West Pender St, Vancouver BC', 'node:456')], ['city_licence:123', tim(branch)]]);
  assert.equal(selectRequestedTimBranch({ offeredPlaceId: 'city_licence:123' }, places).branchAddress, branch);
  assert.equal(selectRequestedTimBranch({ offeredPlaceId: 'city_licence:123', branchAddress: '108 West Pender St, Vancouver BC' }, places).placeId, 'node:456');
  assert.throws(() => selectRequestedTimBranch({ offeredPlaceId: 'node:789' }, places), /not in this session/);
});

test('nearby recommendation speaks the selected address and its structured ID binds the identical branch', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(String(url).includes('business-licences'));
    return new Response(JSON.stringify({ total_count: 1, results: [{ licencersn: '900123', businesstradename: 'Tim Hortons', businesstype: 'Restaurant', house: '607', street: 'Dunsmuir St', city: 'Vancouver', postalcode: 'V6B 1Y7', geo_point_2d: { lat: 49.285, lon: -123.113 } }] }), { status: 200 });
  });
  const { handleLocalTool } = await import('../lib/tools.mjs');
  const session = { location: { latitude: 49.2851, longitude: -123.1131, timestamp: Date.now(), accuracy: 10, source: 'device' } };
  const result = await handleLocalTool('find_nearby_places', { category: 'coffee', brand: 'tim_hortons' }, session);
  assert.equal(result.ok, true);
  assert.equal(result.place_id, result.places[0].place_id);
  assert.equal(result.recommended_branch_address, result.places[0].address);
  assert.ok(result.spoken.includes(result.places[0].address));
  assert.ok(!result.spoken.includes(result.place_id), 'opaque IDs remain tool metadata, not spoken words');
  assert.equal(selectRequestedTimBranch({ placeId: result.place_id }, session.places).branchAddress, result.places[0].address);
});
