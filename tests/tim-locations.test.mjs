import test from 'node:test';
import assert from 'node:assert/strict';

const origin = 'https://locations.timhortons.ca';
const directoryUrl = `${origin}/en/locations-list/bc/vancouver/`;
const entry = (slug, address) => `<li><a href="/en/bc/vancouver/${slug}/">Tim Hortons</a> - ${address}</li>`;
const directory = entry('650-georgia-st-w', '650 Georgia St W, Vancouver BC V6B 4N7')
  + entry('ground-level-1055-georgia-st-w', 'Ground Level - 1055 Georgia St W, Unit 118, Vancouver BC V6E 3P3')
  + entry('skytrain-level-1055-west-georgia-st', 'Skytrain Level - 1055 West Georgia St, 3rd Concourse Level - Unit 2468, Vancouver BC V6E 3P1');
const branch = ({ street = '650 Georgia St W', pickup = true, external = false } = {}) => {
  const data = { '@type': 'CafeOrCoffeeShop', address: { streetAddress: street, addressLocality: 'Vancouver', addressRegion: 'BC', postalCode: 'V6B 4N7' }, geo: { latitude: '49.2818388', longitude: '-123.1173669' }, telephone: '16046324626' };
  const href = `${external ? 'https://example.com' : 'https://timhortons.ca'}/menu?locale-selected=0&amp;lang=en&amp;store-number=105340&amp;service-mode=TAKEOUT`;
  return `<script type="application/ld+json">${JSON.stringify(data)}</script><a href="${href}" aria-label="${pickup ? 'Order Pickup' : 'Order Now'}">${pickup ? 'Order Pickup' : 'Order Now'}</a>`;
};

async function resolver(page = branch()) {
  const { resolveTimLocation } = await import(`../lib/tim-locations.mjs?test=${Math.random()}`);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, timeoutBound: !!options.signal });
    return new Response(url === directoryUrl ? directory : page, { headers: { 'Content-Type': 'text/html' } });
  };
  return { calls, resolve: address => resolveTimLocation(address, { fetchImpl }) };
}

test('normalizes direction placement while preserving exact official branch evidence', async () => {
  const { resolve, calls } = await resolver();
  const result = await resolve('650 W Georgia Street, Vancouver BC V6B 0S6');
  assert.equal(result.ok, true);
  assert.equal(result.store_number, '105340');
  assert.equal(result.pickupUrl, result.pickup_url);
  assert.equal(new URL(result.pickupUrl).hostname, 'timhortons.ca');
  assert.equal(result.address, '650 Georgia St W, Vancouver, BC V6B 4N7');
  assert.equal(result.postal_code_matches, false);
  assert.equal(result.requires_live_branch_verification, true);
  assert.equal(result.phone, '+16046324626');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.timeoutBound));
});

test('two units at the same street address fail closed without fetching either branch', async () => {
  const { resolve, calls } = await resolver();
  const result = await resolve('1055 West Georgia St, Vancouver BC');
  assert.equal(result.error, 'AMBIGUOUS_ADDRESS');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.pickupUrl, undefined);
  assert.equal(calls.length, 1);
});

test('a specific directory unit resolves when JSON-LD verifies the street and level but omits the unit', async () => {
  const { resolve } = await resolver(branch({ street: 'Ground Level - 1055 Georgia St W' }).replace(/V6B 4N7/g, 'V6E 3P3'));
  const result = await resolve('1055 West Georgia St, Unit 118, Vancouver BC');
  assert.equal(result.ok, true);
  assert.equal(result.address_components.unit, '118');
  assert.ok(result.official_page_url.endsWith('/ground-level-1055-georgia-st-w'));
  assert.equal((await resolve('1055 West Georgia St, Unit 999, Vancouver BC')).ok, false);
});

test('conflicting directions or another city cannot resolve to the Vancouver branch', async () => {
  const { resolve } = await resolver();
  for (const address of ['650 Georgia St East, Vancouver BC', '650 W Georgia St, Burnaby BC', '650 W Georgia St, North Vancouver BC', '650 W Georgia Avenue, Vancouver BC']) {
    const result = await resolve(address);
    assert.equal(result.ok, false, address);
    assert.equal(result.pickupUrl, undefined, address);
  }
});

test('a featured Order Now link never substitutes for the exact Order Pickup anchor', async () => {
  const { resolve } = await resolver(branch({ pickup: false }));
  assert.equal((await resolve('650 W Georgia St, Vancouver BC')).error, 'PICKUP_LINK_UNVERIFIED');
});

test('mismatched branch JSON-LD or an external ordering link fails closed', async () => {
  for (const [page, error] of [[branch({ street: '19 Marion St' }), 'OFFICIAL_ADDRESS_UNVERIFIED'], [branch({ external: true }), 'PICKUP_LINK_UNVERIFIED']]) {
    const { resolve } = await resolver(page);
    const result = await resolve('650 W Georgia St, Vancouver BC');
    assert.equal(result.error, error);
    assert.equal(result.pickupUrl, undefined);
  }
});

const delivery = (href = 'https://timhortons.ca/menu?locale-selected=0&amp;lang=en&amp;store-number=105340&amp;service-mode=DELIVERY', label = 'Order Delivery') => `<a href="${href}" aria-label="${label}">${label}</a>`;

test('delivery URL is copied from the unique explicit same-store official delivery anchor', async () => {
  const { resolve } = await resolver(branch() + delivery());
  const result = await resolve('650 W Georgia St, Vancouver BC');
  assert.equal(result.ok, true);
  assert.equal(result.deliveryUrl, 'https://timhortons.ca/menu?locale-selected=0&lang=en&store-number=105340&service-mode=DELIVERY');
  assert.equal(result.deliveryUrl, result.delivery_url);
  assert.equal(result.delivery_link_is_candidate, true);
  assert.equal(result.requires_live_branch_verification, true);
  assert.equal(result.delivery_link_status, 'published_branch_candidate');
});

test('missing, featured, external, conflicting or different-store delivery links never produce an invented delivery URL', async () => {
  for (const addition of [
    '',
    delivery(undefined, 'Order Now'),
    delivery('https://example.com/menu?store-number=105340&amp;service-mode=DELIVERY'),
    delivery('https://timhortons.ca/menu?store-number=99999&amp;service-mode=DELIVERY'),
    delivery() + delivery('https://timhortons.ca/menu?store-number=99999&amp;service-mode=DELIVERY'),
    delivery('https://timhortons.ca/menu?store-number=105340&amp;service-mode=TAKEOUT'),
  ]) {
    const { resolve } = await resolver(branch() + addition);
    const result = await resolve('650 W Georgia St, Vancouver BC');
    assert.equal(result.ok, true);
    assert.equal(result.delivery_url, null);
    assert.equal(result.deliveryUrl, null);
    assert.equal(result.delivery_link_is_candidate, false);
    assert.equal(result.delivery_link_status, 'not_published_or_unverified');
    assert.ok(result.pickupUrl.includes('service-mode=TAKEOUT'));
  }
});
