import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocalTool, LOCAL_TOOL_DEFINITIONS } from '../lib/tools.mjs';

const device = (latitude = 49.28, longitude = -123.12) => ({ latitude, longitude, accuracy: 12, timestamp: Date.now(), source: 'device' });
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('location is required, device fixes expire, and demo coordinates remain explicitly labeled', async () => {
  assert.equal((await handleLocalTool('get_location', {}, {})).error_code, 'LOCATION_REQUIRED');
  const stale = device(); stale.timestamp -= 121_000;
  assert.equal((await handleLocalTool('get_location', {}, { location: stale })).error_code, 'STALE_LOCATION');
  const demo = { ...stale, source: 'demo' };
  const result = await handleLocalTool('get_location', {}, { location: demo });
  assert.equal(result.ok, true);
  assert.equal(result.location.source, 'demo');
  assert.match(result.spoken, /not your current device location/);
  assert.equal((await handleLocalTool('get_location', {}, { location: { ...device(), latitude: '49.28' } })).error_code, 'INVALID_LOCATION');
});

test('invalid category and radius do not query a provider', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unexpected'); });
  const session = { location: device() };
  assert.equal((await handleLocalTool('find_nearby_places', { category: 'anything' }, session)).error_code, 'INVALID_CATEGORY');
  assert.equal((await handleLocalTool('find_nearby_places', { category: 'coffee', radius_m: 2001 }, session)).error_code, 'INVALID_RADIUS');
  assert.equal((await handleLocalTool('find_nearby_places', { category: 'coffee', brand: 'fake_chain' }, session)).error_code, 'INVALID_BRAND');
  assert.equal((await handleLocalTool('find_nearby_places', { category: 'pharmacy', brand: 'tim_hortons' }, session)).error_code, 'INVALID_BRAND_CATEGORY');
  assert.equal(requests, 0);
});

test('Tim Hortons brand filtering considers all fetched places before taking the nearest three and retains source evidence', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    requests++;
    if (String(url).includes('business-licences')) return json({ total_count: 0, results: [] });
    return json({ osm3s: { timestamp_osm_base: '2026-10-07T20:00:00Z' }, elements: [
      ...Array.from({ length: 4 }, (_, index) => ({ type: 'node', id: 300 + index, lat: 49.284 + index * .0001, lon: -123.127, tags: { name: `Other Café ${index}` } })),
      { type: 'node', id: 305, lat: 49.2847, lon: -123.127, tags: { name: 'Tim Hortons', 'addr:housenumber': '607', 'addr:street': 'Dunsmuir Street' } },
      { type: 'node', id: 306, lat: 49.2851, lon: -123.127, tags: { name: "Tim Horton's", 'addr:housenumber': '650', 'addr:street': 'Georgia Street West' } },
      { type: 'node', id: 307, lat: 49.2855, lon: -123.127, tags: { name: 'Mapped branch display name', brand: 'Tim Hortons' } },
      { type: 'node', id: 308, lat: 49.2841, lon: -123.127, tags: { name: 'Tim Hortons Fan Café' } },
    ] });
  });
  const session = { location: device(49.284, -123.127) };
  const general = await handleLocalTool('find_nearby_places', { category: 'coffee', radius_m: 800 }, session);
  const result = await handleLocalTool('find_nearby_places', { category: 'coffee', radius_m: 800, brand: 'tim_hortons' }, session);
  assert.ok(general.places.every(place => place.brand !== 'tim_hortons'));
  assert.deepEqual(result.places.map(place => place.place_id), ['node:305', 'node:306', 'node:307']);
  assert.ok(result.places.every(place => place.brand === 'tim_hortons'));
  assert.equal(result.places[0].address, '607 Dunsmuir Street');
  assert.equal(result.sources[0].provider, 'OpenStreetMap via Overpass');
  assert.equal(result.sources[0].freshness, 'mapped_not_live');
  assert.equal(result.places[0].source_url, 'https://www.openstreetmap.org/node/305');
  assert.equal(session.places.get('node:305').fetched_at, result.fetched_at);
  assert.equal(result.location.source, 'device');
  assert.equal(result.brand, 'tim_hortons');
  assert.equal(requests, 2, 'the empty City brand lookup falls through to the existing full map cache');
});

test('Tim Hortons uses current City licences first and falls through to maps only when no verified brand listing exists', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).includes('business-licences')) {
      const where = new URL(url).searchParams.get('where');
      assert.match(where, /status='Issued'/);
      assert.match(where, /search\(businessname,'Tim Hortons'\)/);
      if (where.includes('-123.128')) return json({ total_count: 2, results: [
        { licencersn: '509', businesstradename: 'Tim Hortons Fan Café', businesstype: 'Restaurant', house: '1', street: 'Other St', city: 'Vancouver', geo_point_2d: { lat: 49.287, lon: -123.128 } },
        { licencersn: '510', businesstradename: "Tim Horton's", businesstype: 'Restaurant', house: '607', street: 'Dunsmuir St', city: 'Vancouver', geo_point_2d: { lat: 49.2872, lon: -123.128 } },
      ] });
      return json({ total_count: 1, results: [
        { licencersn: '511', businesstradename: 'Tim Hortons Fan Café', businesstype: 'Restaurant', geo_point_2d: { lat: 49.288, lon: -123.129 } },
      ] });
    }
    return json({ elements: [{ type: 'node', id: 512, lat: 49.2882, lon: -123.129, tags: { name: 'Tim Hortons' } }] });
  });
  const city = await handleLocalTool('find_nearby_places', { category: 'coffee', brand: 'tim_hortons' }, { location: device(49.287, -123.128) });
  assert.equal(calls.length, 1, 'a verified City listing does not wait for Overpass');
  assert.equal(city.places[0].place_id, 'city_licence:510');
  assert.equal(city.sources[0].freshness, 'licence_listing_not_live');
  assert.equal(city.places[0].listed_hours, null);
  const mapped = await handleLocalTool('find_nearby_places', { category: 'coffee', brand: 'tim_hortons' }, { location: device(49.288, -123.129) });
  assert.equal(calls.length, 3);
  assert.match(calls[1], /business-licences/);
  assert.match(calls[2], /overpass/);
  assert.equal(mapped.places[0].place_id, 'node:512');
  assert.equal(mapped.sources[0].freshness, 'mapped_not_live');
});

test('places deduplicate pending requests, sort distance, normalize only unambiguous phones, and register IDs', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return json({ osm3s: { timestamp_osm_base: '2026-10-07T20:00:00Z' }, elements: [
      { type: 'node', id: 101, lat: 49.281, lon: -123.121, tags: { name: 'Farther Café', phone: '(604) 555-0123', opening_hours: 'Mo-Fr 09:00-17:00', 'addr:housenumber': '10', 'addr:street': 'Sample Street' } },
      { type: 'node', id: 102, lat: 49.2801, lon: -123.121, tags: { name: 'Nearest Café', phone: '+1 604 555 0145 ext 2' } },
      { type: 'node', id: 103, lat: 49.2802, lon: -123.121, tags: { name: 'Other Café', phone: '604-555-0160;604-555-0170' } },
      { type: 'node', id: 104, lat: 49.4, lon: -123.121, tags: { name: 'Outside Radius' } },
      { type: 'node', id: 101, lat: 49.281, lon: -123.121, tags: { name: 'Duplicate' } },
    ] });
  });
  const a = { location: device(49.28, -123.121) }, b = { location: device(49.28, -123.121) };
  const [result, duplicate] = await Promise.all([
    handleLocalTool('find_nearby_places', { category: 'coffee', radius_m: 800 }, a),
    handleLocalTool('find_nearby_places', { category: 'coffee', radius_m: 800 }, b),
  ]);
  assert.equal(requests, 1);
  assert.equal(result.ok, true);
  assert.equal(duplicate.ok, true);
  assert.deepEqual(result.places.map(place => place.place_id), ['node:102', 'node:103', 'node:101']);
  assert.equal(result.places[0].phone, null);
  assert.equal(result.places[1].phone, null);
  assert.equal(result.places[2].phone, '+16045550123');
  assert.equal(result.places[2].address, '10 Sample Street');
  assert.equal(a.places.get('node:101').phone, '+16045550123');
  assert.equal(b.places.size, 3);
  assert.equal(result.distance_kind, 'approximate_straight_line');
  assert.equal(result.places[0].hours_status, 'unknown');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 6000);
});

test('Overpass retries an alternate public endpoint after initial failure', async t => {
  const endpoints = [];
  t.mock.method(globalThis, 'fetch', async url => {
    endpoints.push(String(url));
    if (endpoints.length === 1) return new Response('Busy', { status: 503 });
    return json({ elements: [{ type: 'node', id: 201, lat: 49.282, lon: -123.122, tags: { name: 'Mapped Pharmacy' } }] });
  });
  const result = await handleLocalTool('find_nearby_places', { category: 'pharmacy', radius_m: 300 }, { location: device(49.282, -123.122) });
  assert.equal(result.ok, true);
  assert.equal(endpoints.length, 2);
  assert.match(endpoints[1], /overpass\.private\.coffee/);
  assert.equal(result.sources[0].endpoint, endpoints[1]);
});

test('City amenities fetch every page before choosing the closest entries; missing availability is unknown', async t => {
  const offsets = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsets.push(offset);
    const records = Array.from({ length: offset === 0 ? 100 : 47 }, (_, i) => ({
      location: `Listed washroom ${offset + i}`,
      geo_point_2d: { lat: offset === 0 ? 49.4 : 49.283 + i * .00001, lon: -123.123 },
      summer_hours: offset ? '6am - 10pm' : null, wheelchair_access: offset ? 'Yes' : null,
    }));
    return json({ total_count: 147, results: records });
  });
  const result = await handleLocalTool('find_local_amenities', { kind: 'washroom' }, { location: device(49.283, -123.123) });
  assert.equal(result.ok, true);
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(result.sources[0].records_fetched, 147);
  assert.equal(result.amenities[0].name, 'Listed washroom 100');
  assert.equal(result.amenities[0].straight_line_distance_m, 0);
  assert.equal(result.amenities[0].availability, 'unknown');
  assert.equal(result.amenities[0].listed_winter_hours, null);
  assert.equal(result.amenities[0].wheelchair_access, 'Yes');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 6000);
});

test('schemas expose only the three agreed local tool names', () => {
  assert.deepEqual(LOCAL_TOOL_DEFINITIONS.map(tool => tool.name), ['get_location', 'find_nearby_places', 'find_local_amenities']);
  assert.deepEqual(LOCAL_TOOL_DEFINITIONS[1].parameters.properties.category.enum, ['coffee', 'food', 'pharmacy', 'grocery']);
  assert.deepEqual(LOCAL_TOOL_DEFINITIONS[1].parameters.properties.brand.enum, ['tim_hortons']);
  assert.deepEqual(LOCAL_TOOL_DEFINITIONS[2].parameters.properties.kind.enum, ['washroom', 'drinking_water']);
});

test('failed maps can return explicitly labeled current City café licences without inventing contact details', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).includes('overpass')) return new Response('Unavailable', { status: 503 });
    return json({ total_count: 3, results: [
      { licencersn: '301', businesstradename: 'Listed Coffee', businesstype: 'Restaurant', house: '25', street: 'Sample St', city: 'Vancouver', geo_point_2d: { lat: 49.285, lon: -123.125 }, extractdate: '2026-10-07T07:00:00Z' },
      { licencersn: '302', businesstradename: 'Listed Coffee', businesstype: 'Restaurant', house: '25', street: 'Sample St', city: 'Vancouver', geo_point_2d: { lat: 49.285, lon: -123.125 } },
      { licencersn: '303', businessname: 'Cafe Equipment Seller', businesstype: 'Retail Dealer', geo_point_2d: { lat: 49.285, lon: -123.125 } },
    ] });
  });
  const session = { location: device(49.285, -123.125) };
  const result = await handleLocalTool('find_nearby_places', { category: 'coffee', radius_m: 300 }, session);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.match(new URL(calls[2]).searchParams.get('where'), /status='Issued'/);
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].place_id, 'city_licence:301');
  assert.equal(result.places[0].phone, null);
  assert.equal(result.places[0].listed_hours, null);
  assert.equal(result.sources[0].freshness, 'licence_listing_not_live');
  assert.match(result.spoken, /City business-licence listings/);
  assert.ok(session.places.has('city_licence:301'));
});

test('international listing text cannot exceed the six-kilobyte tool response budget', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ elements: [1, 2, 3].map(id => ({
    type: 'node', id: 400 + id, lat: 49.286, lon: -123.126,
    tags: { name: '界'.repeat(120), 'addr:full': '界'.repeat(200), opening_hours: '界'.repeat(160) },
  })) }));
  const result = await handleLocalTool('find_nearby_places', { category: 'grocery', radius_m: 300 }, { location: device(49.286, -123.126) });
  assert.equal(result.ok, true);
  assert.equal(result.places.length, 3);
  assert.equal(result.response_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 6000);
  assert.equal(result.places[0].place_id, 'node:401');
});
