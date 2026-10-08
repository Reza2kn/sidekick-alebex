import { browserOrderGuards } from './browser-order.mjs';

const PLACE_ID = /^(?:city_licence|node|way|relation):\d+$/;

function address(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('Choose the Tim Hortons branch by its street address or the place ID from your nearby search.');
    return null;
  }
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('The Tim Hortons branch address is invalid. Give its street address.');
  const result = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!/\b\d{1,6}[a-z]?\b/i.test(result) || !/[a-z]{3}/i.test(result)) throw new Error('The Tim Hortons branch needs a street number and street name.');
  return result;
}

function isTim(place) {
  const name = typeof place?.name === 'string' ? place.name.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const brand = typeof place?.brand === 'string' ? place.brand.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return brand === 'timhortons' || name === 'timhortons';
}

function sameAddress(left, right) {
  return browserOrderGuards.branchMatches(left, right) && browserOrderGuards.branchMatches(right, left);
}

function chosen(placeId, place, selectionSource) {
  if (!isTim(place)) throw new Error('That nearby place is not a verified Tim Hortons listing. Choose a Tim Hortons branch.');
  if (place.place_id && place.place_id !== placeId) throw new Error('The nearby place identifier does not match its stored listing. Search again.');
  const branchAddress = address(place.address, { required: true });
  // Copy stable identity into a frozen result. Passage of time never changes a
  // chosen branch; the official resolver and actual website verify it separately.
  return Object.freeze({ branchAddress, placeId, selectionSource });
}

/** Pure branch binding. Never chooses a nearest place, calls an API, or acts on UI. */
export function selectRequestedTimBranch({ placeId, branchAddress, offeredPlaceId } = {}, places) {
  const explicit = address(branchAddress);
  // A spoken acceptance of the offered branch need not restate its address.
  // This fallback is trusted session metadata, never the nearest Map entry.
  if (!placeId && !explicit && offeredPlaceId) placeId = offeredPlaceId;
  if (placeId !== undefined && placeId !== null && placeId !== '') {
    if (typeof placeId !== 'string' || !PLACE_ID.test(placeId)) throw new Error('Use the exact place ID from this session’s nearby Tim Hortons search.');
    const place = places instanceof Map ? places.get(placeId) : null;
    if (!place) throw new Error('That Tim Hortons place is not in this session’s nearby results. Give its street address or search nearby again.');
    const result = chosen(placeId, place, 'nearby_place_id');
    if (explicit && !sameAddress(explicit, result.branchAddress)) throw new Error('The supplied address conflicts with the selected Tim Hortons branch. Keep the selected branch or explicitly choose another.');
    return result;
  }
  if (!explicit) throw new Error('Choose the Tim Hortons branch by its street address or the place ID from your nearby search.');
  const matches = places instanceof Map ? [...places.entries()].filter(([id, place]) => PLACE_ID.test(id) && isTim(place) && typeof place.address === 'string' && sameAddress(explicit, place.address)) : [];
  if (matches.length > 1) throw new Error('Several nearby Tim Hortons listings match that address. Specify the exact place ID or branch unit.');
  if (matches.length === 1) return chosen(matches[0][0], matches[0][1], 'nearby_address_match');
  return Object.freeze({ branchAddress: explicit, selectionSource: 'explicit_address' });
}
