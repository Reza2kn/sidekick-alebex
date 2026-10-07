// Resolve only public, official location pages. Listing text is evidence, never instructions.
const DIRECTORY_URL = 'https://locations.timhortons.ca/en/locations-list/bc/vancouver/';
const LOCATIONS_ORIGIN = 'https://locations.timhortons.ca';
const TTL_MS = 5 * 60_000;
const MAX_HTML_BYTES = 500_000;
const cache = new Map();
const pending = new Map();

function decode(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[entity.toLowerCase()];
  });
}

function text(value) {
  if (value === undefined || value === null) return '';
  return decode(value).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function attr(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decode(match[2]) : null;
}

const DIRECTIONS = new Map(Object.entries({ west: 'w', east: 'e', north: 'n', south: 's', southeast: 'se', southwest: 'sw', northeast: 'ne', northwest: 'nw' }));
const TYPES = new Map(Object.entries({ st: 'street', street: 'street', ave: 'avenue', av: 'avenue', avenue: 'avenue', dr: 'drive', drive: 'drive', rd: 'road', road: 'road', blvd: 'boulevard', boulevard: 'boulevard', wy: 'way', way: 'way' }));

function addressKey(input) {
  let value = text(input).toLowerCase().replace(/\b(?:tim\s*horton'?s|timmy'?s)\b/g, ' ').replace(/\b(?:british columbia|vancouver|canada|bc)\b/g, ' ');
  const postal = value.match(/\b([a-z]\d[a-z])\s?(\d[a-z]\d)\b/i);
  value = value.replace(/\b[a-z]\d[a-z]\s?\d[a-z]\d\b/gi, ' ');
  const units = [...value.matchAll(/(?:\b(?:unit|suite|ste)\s*#?\s*|#\s*)([\da-z]+(?:-[\da-z]+)?)/g)].map(match => match[1]);
  value = value.replace(/(?:\b(?:unit|suite|ste)\s*#?\s*|#\s*)[\da-z]+(?:-[\da-z]+)?/g, ' ');
  // A second comma-delimited level description is not part of the street name.
  // Keep units already extracted, so two stores at 1055 Georgia remain ambiguous.
  const segments = value.split(',');
  const streetIndex = segments.findIndex(segment => /(?:^|\s)\d+[a-z]?(?:\s|$)/.test(segment));
  if (streetIndex >= 0) {
    for (let index = 0; index < segments.length; index++) {
      if (index === streetIndex) continue;
      const extra = segments[index].replace(/[-\s]+/g, ' ').trim();
      if (extra && !/^(?:\d+(?:st|nd|rd|th)\s+)?(?:(?:ground|skytrain|concourse|first|second|third)\s+)*(?:level|floor)$/.test(extra)) return null;
    }
    value = segments[streetIndex];
  }
  const words = value.replace(/[^a-z\d]+/g, ' ').trim().split(/\s+/);
  const numberIndex = words.findIndex(word => /^\d+[a-z]?$/.test(word));
  if (numberIndex < 0 || units.length > 1) return null;
  const number = words[numberIndex];
  const qualifiers = words.slice(0, numberIndex).filter(word => !['at', 'the'].includes(word));
  const rest = words.slice(numberIndex + 1);
  const directions = [], types = [], street = [];
  for (const word of rest) {
    if (DIRECTIONS.has(word) || /^(?:w|e|n|s|se|sw|ne|nw)$/.test(word)) directions.push(DIRECTIONS.get(word) || word);
    else if (TYPES.has(word)) types.push(TYPES.get(word));
    else street.push(word);
  }
  if (!street.length || directions.length > 1 || types.length > 1) return null;
  return { number, street: street.join(' '), direction: directions[0] || '', type: types[0] || '', unit: units[0] || '', qualifiers: qualifiers.join(' '), postal_code: postal ? `${postal[1]} ${postal[2]}`.toUpperCase() : null };
}

function sameStreet(request, listed, { ignoreDirection = false } = {}) {
  return request && listed && request.number === listed.number && request.street === listed.street
    && (ignoreDirection || request.direction === listed.direction)
    && (!request.type || !listed.type || request.type === listed.type)
    && (!request.unit || request.unit === listed.unit)
    && (!request.qualifiers || request.qualifiers === listed.qualifiers);
}

async function officialHtml(url, deadline, fetchImpl) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < TTL_MS) return cached;
  if (pending.has(url)) return pending.get(url);
  const task = (async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Official location lookup timed out.');
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }, signal: AbortSignal.timeout(remaining) });
    if (!response.ok) throw new Error(`Official location page returned HTTP ${response.status}.`);
    if (response.url && new URL(response.url).origin !== LOCATIONS_ORIGIN) throw new Error('Official location page redirected outside its approved domain.');
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_HTML_BYTES) throw new Error('Official location page exceeded its size limit.');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error('Official location page exceeded its size limit.');
      chunks.push(chunk);
    }
    const result = { html: Buffer.concat(chunks).toString('utf8'), time: Date.now() };
    cache.set(url, result);
    return result;
  })();
  pending.set(url, task);
  try { return await task; } finally { pending.delete(url); }
}

function directoryEntries(html) {
  const entries = [];
  for (const li of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const a = li[1].match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const href = attr(a[1], 'href');
    if (!href) continue;
    let url;
    try { url = new URL(href, LOCATIONS_ORIGIN); } catch { continue; }
    if (url.origin !== LOCATIONS_ORIGIN || !/^\/en\/bc\/vancouver\/[a-z\d-]+\/?$/.test(url.pathname)) continue;
    const address = text(li[1].slice(a.index + a[0].length)).replace(/^\s*-\s*/, '');
    const key = addressKey(address);
    if (key) entries.push({ official_page_url: url.href.replace(/\/$/, ''), address, key });
  }
  return [...new Map(entries.map(entry => [entry.official_page_url, entry])).values()];
}

function jsonLdObjects(html) {
  const result = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    result.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attr(script[1], 'type') !== 'application/ld+json') continue;
    try { visit(JSON.parse(script[2])); } catch { /* Malformed published data cannot verify a branch. */ }
  }
  return result;
}

function pickupLinks(html) {
  const urls = new Set();
  for (const link of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (attr(link[1], 'aria-label')?.toLowerCase() !== 'order pickup' && !/^order pickup\b/i.test(text(link[2]))) continue;
    let url;
    try { url = new URL(attr(link[1], 'href')); } catch { continue; }
    if (url.protocol !== 'https:' || !['timhortons.ca', 'www.timhortons.ca'].includes(url.hostname) || url.port || url.username || url.password) continue;
    if (url.pathname !== '/menu' || url.searchParams.get('service-mode') !== 'TAKEOUT' || !/^\d{1,12}$/.test(url.searchParams.get('store-number') || '')) continue;
    urls.add(url.href);
  }
  return [...urls];
}

function failure(error, message, extra = {}) {
  return { ok: false, error, message, sources: [DIRECTORY_URL], ...extra };
}

/** No account, browser, undocumented API, or payment is used by this resolver. */
export async function resolveTimHortonsLocation(address, { timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof address !== 'string' || address.length > 300 || !address.trim()) return failure('INVALID_ADDRESS', 'Give the exact Vancouver street address, including any unit.');
  const requested = addressKey(address);
  if (!requested) return failure('INVALID_ADDRESS', 'The address needs a street number and street name.');
  const deadline = Date.now() + Math.min(15_000, Math.max(1000, Number(timeoutMs) || 10_000));
  try {
    const directory = await officialHtml(DIRECTORY_URL, deadline, fetchImpl);
    const entries = directoryEntries(directory.html);
    if (!entries.length) return failure('OFFICIAL_DIRECTORY_UNVERIFIED', 'The official directory could not be read.');
    const matches = entries.filter(entry => sameStreet(requested, entry.key));
    if (matches.length !== 1) {
      const candidates = (matches.length ? matches : entries.filter(entry => sameStreet(requested, entry.key, { ignoreDirection: true }))).slice(0, 5).map(({ address, official_page_url }) => ({ address, official_page_url }));
      return failure(matches.length > 1 ? 'AMBIGUOUS_ADDRESS' : 'ADDRESS_NOT_FOUND', matches.length > 1 ? 'Several official branches share this street address. Specify the unit or level.' : 'No unique exact street-address match was found in the official Vancouver directory.', { candidates });
    }
    const entry = matches[0];
    const page = await officialHtml(entry.official_page_url, deadline, fetchImpl);
    const businesses = jsonLdObjects(page.html).filter(item => {
      if (!item.address || typeof item.address !== 'object' || text(item.address.addressLocality).toLowerCase() !== 'vancouver' || text(item.address.addressRegion).toUpperCase() !== 'BC') return false;
      const pageKey = addressKey(item.address.streetAddress);
      // The official directory includes units that branch JSON-LD often omits.
      // A supplied unit must already match that unique directory entry; any unit
      // actually present on the branch page must agree with it as well.
      return pageKey && sameStreet({ ...entry.key, unit: '' }, pageKey)
        && (!pageKey.unit || !entry.key.unit || pageKey.unit === entry.key.unit)
        && (!entry.key.postal_code || !item.address.postalCode || entry.key.postal_code === text(item.address.postalCode).toUpperCase());
    });
    if (businesses.length !== 1) return failure('OFFICIAL_ADDRESS_UNVERIFIED', 'The location page did not uniquely verify the selected street address.', { sources: [DIRECTORY_URL, entry.official_page_url] });
    const branch = businesses[0];
    const links = pickupLinks(page.html);
    if (links.length !== 1) return failure('PICKUP_LINK_UNVERIFIED', 'The location page did not publish one unique branch-specific pickup link.', { sources: [DIRECTORY_URL, entry.official_page_url] });
    const streetAddress = text(branch.address.streetAddress);
    const postalCode = text(branch.address.postalCode);
    const phoneDigits = String(branch.telephone || '').replace(/[^\d+]/g, '');
    const latitude = Number(branch.geo?.latitude), longitude = Number(branch.geo?.longitude);
    return {
      ok: true,
      requested_address: address.trim(),
      match_method: 'Unique official directory street-address match, verified by the branch public JSON-LD',
      address: `${streetAddress}${entry.key.unit ? `, Unit ${entry.key.unit}` : ''}, Vancouver, BC ${postalCode}`,
      directory_address: entry.address,
      address_components: { street_address: streetAddress, unit: entry.key.unit || null, locality: 'Vancouver', region: 'BC', postal_code: postalCode, country: 'CA' },
      postal_code_matches: requested.postal_code ? requested.postal_code === postalCode.toUpperCase() : null,
      official_page_url: entry.official_page_url,
      pickup_url: links[0],
      store_number: new URL(links[0]).searchParams.get('store-number'),
      pickup_link_is_candidate: true,
      requires_live_branch_verification: true,
      phone: /^\+?1\d{10}$/.test(phoneDigits) ? `+${phoneDigits.replace(/^\+/, '')}` : null,
      latitude: Number.isFinite(latitude) && Math.abs(latitude) <= 90 ? latitude : null,
      longitude: Number.isFinite(longitude) && Math.abs(longitude) <= 180 ? longitude : null,
      listed_hours: (Array.isArray(branch.openingHoursSpecification) ? branch.openingHoursSpecification : []).slice(0, 14).map(day => ({ day: text(Array.isArray(day.dayOfWeek) ? day.dayOfWeek.join(', ') : day.dayOfWeek).replace(/https?:\/\/schema\.org\//g, ''), opens: text(day.opens), closes: text(day.closes) })),
      availability: 'Listed branch and pickup link; current opening, menu availability, and selected checkout branch require live website verification.',
      sources: [DIRECTORY_URL, entry.official_page_url],
      fetched_at: new Date(Math.min(directory.time, page.time)).toISOString(),
    };
  } catch (error) {
    return failure('OFFICIAL_LOOKUP_FAILED', error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'The official lookup timed out. Try again.' : 'The official location lookup is temporarily unavailable.');
  }
}

// Server compatibility. Failed or ambiguous lookups never expose a pickup URL.
export async function resolveTimLocation(address, options) {
  const result = await resolveTimHortonsLocation(address, options);
  return result.ok ? { ...result, pickupUrl: result.pickup_url } : result;
}
