// Small, real-data tools. External listing text is evidence, never instructions.
const CACHE_TTL_MS = 5 * 60_000;
const LOCATION_MAX_AGE_MS = 2 * 60_000;
const REQUEST_BUDGET_MS = 10_000;
const MAX_UPSTREAM_BYTES = 2_000_000;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const CITY_BASE = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/';
const cache = new Map();
const inFlight = new Map();

export const LOCAL_TOOL_DEFINITIONS = [
  {
    name: 'get_location',
    description: 'Get the location already supplied by the device, its accuracy and freshness. Old device locations are refused. A chosen demo location is explicitly labeled. Never use coordinates alone to infer a street crossing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_nearby_places',
    description: 'Find up to three closest listed coffee, food, pharmacy or grocery places near the supplied location. Optional brand tim_hortons first uses current issued City of Vancouver business licences, then mapped listings if needed, filtering all fetched entries before choosing the nearest three. Distances are approximate straight-line metres. Listings do not verify current opening or online order availability. City business licences have no phone or hours. Store returned place IDs for later approved calls.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['coffee', 'food', 'pharmacy', 'grocery'] },
        radius_m: { type: 'number', minimum: 300, maximum: 2000, description: 'Search radius in metres; defaults to 800.' },
        brand: { type: 'string', enum: ['tim_hortons'], description: 'Optional. Return only mapped or City-listed Tim Hortons branches for coffee or food; current website ordering availability still needs verification.' },
      },
      required: ['category'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_local_amenities',
    description: 'Find up to three closest City of Vancouver listed public washrooms or drinking fountains. Distances are straight-line metres. Return listed seasonal hours and accessibility only when supplied; do not claim a facility is currently open, unlocked or working.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['washroom', 'drinking_water'] } },
      required: ['kind'],
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function cleanText(value, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return result ? result.slice(0, maxLength) : null;
}

function listedBrand(name, brand) {
  const isTimHortons = value => typeof value === 'string' && value.toLowerCase().replace(/[^a-z0-9]/g, '') === 'timhortons';
  return isTimHortons(brand) || isTimHortons(name) ? 'tim_hortons' : null;
}

function locationFrom(input) {
  if (!input || typeof input !== 'object') {
    throw new ToolError('LOCATION_REQUIRED', 'Please share your device location or choose a labeled demo location first.');
  }
  const { latitude, longitude, source } = input;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new ToolError('INVALID_LOCATION', 'The supplied location coordinates are invalid. Please share your location again.');
  }
  if (!['device', 'demo'].includes(source)) {
    throw new ToolError('INVALID_LOCATION', 'The location must be labeled as device or demo.');
  }
  const timestampMs = typeof input.timestamp === 'number' ? input.timestamp : Date.parse(input.timestamp);
  const ageMs = Date.now() - timestampMs;
  if (source === 'device' && (!Number.isFinite(timestampMs) || ageMs < -30_000)) {
    throw new ToolError('INVALID_LOCATION', 'The device location has no valid capture time. Please share a fresh location.');
  }
  if (source === 'device' && ageMs > LOCATION_MAX_AGE_MS) {
    throw new ToolError('STALE_LOCATION', 'Your device location is over two minutes old. Please refresh it before I search nearby.');
  }
  const accuracy = Number.isFinite(input.accuracy) && input.accuracy >= 0 ? Math.round(input.accuracy) : null;
  return {
    latitude, longitude, accuracy, source,
    timestamp: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null,
    age_seconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
    label: source === 'demo' ? 'Chosen demo location, not a device fix' : 'Device-reported location',
  };
}

function distanceM(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h))));
}

function normalPhone(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Never guess a branch number from multiple numbers, extensions or arbitrary text.
  const phone = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(phone)) return null;
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+${digits}`;
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+1${digits}`;
  return null;
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_BUDGET_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(url, {
      ...options, signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'SidekickVancouverHackathon/0.1', ...options.headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    let text = '', bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_UPSTREAM_BYTES) { controller.abort(); throw new Error('Upstream response too large'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      if (text.length > MAX_UPSTREAM_BYTES) throw new Error('Upstream response too large');
    }
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

async function cached(key, loader) {
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve().then(loader).then(value => {
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
    if (cache.size > 100) {
      for (const [entryKey, entry] of cache) if (entry.expires <= Date.now()) cache.delete(entryKey);
      while (cache.size > 100) cache.delete(cache.keys().next().value);
    }
    return value;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

function placeFilters(category, around) {
  const prefix = `nwr`;
  const selectors = {
    coffee: ['[amenity=cafe]', '[amenity=fast_food][brand="Tim Hortons"]', '[amenity=fast_food][name~"^Tim[ ]*Horton.?s$",i]'],
    food: ['[amenity~"^(restaurant|fast_food|food_court)$"]'],
    pharmacy: ['[amenity=pharmacy]'],
    grocery: ['[shop~"^(supermarket|convenience|grocery)$"]'],
  };
  return selectors[category].map(selector => `${prefix}${selector}${around};`).join('');
}

async function mappedPlaces(location, category, radius, outerDeadline = Infinity) {
  const lat = Number(location.latitude.toFixed(5)), lon = Number(location.longitude.toFixed(5));
  return cached(`osm:${lat}:${lon}:${radius}:${category}`, async () => {
    const around = `(around:${radius},${lat},${lon})`;
    const query = `[out:json][timeout:8];(${placeFilters(category, around)});out center tags;`;
    const deadline = Math.min(Date.now() + REQUEST_BUDGET_MS, outerDeadline);
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      const remaining = deadline - Date.now();
      if (remaining < 300) break;
      try {
        const payload = await fetchJson(OVERPASS_ENDPOINTS[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }).toString(),
        }, i === 0 ? Math.min(6500, remaining) : remaining);
        if (!Array.isArray(payload.elements) || payload.remark) throw new Error('Incomplete Overpass response');
        const seen = new Set(), entries = [];
        for (const element of payload.elements) {
          const point = element.type === 'node' ? element : element.center;
          if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) continue;
          if (!['node', 'way', 'relation'].includes(element.type) || !Number.isSafeInteger(element.id) || element.id < 0) continue;
          const place_id = `${element.type}:${element.id}`;
          if (seen.has(place_id)) continue;
          seen.add(place_id);
          const tags = element.tags || {};
          const name = cleanText(tags.name || tags.brand, 120);
          if (!name) continue;
          const street = [cleanText(tags['addr:housenumber'], 20), cleanText(tags['addr:street'], 100)].filter(Boolean).join(' ');
          const address = cleanText(tags['addr:full'], 200) || cleanText([street, cleanText(tags['addr:city'], 60), cleanText(tags['addr:postcode'], 12)].filter(Boolean).join(', '), 200);
          const rawPhone = tags['contact:phone'] || tags.phone;
          const phone = normalPhone(rawPhone);
          entries.push({
            place_id, name, brand: listedBrand(name, tags.brand), address, latitude: point.lat, longitude: point.lon,
            phone, phone_status: phone ? 'mapped_not_call_verified' : rawPhone ? 'not_normalizable' : 'not_listed',
            listed_hours: cleanText(tags.opening_hours, 160), hours_status: tags.opening_hours ? 'listed_not_live' : 'unknown',
            source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
          });
        }
        return { entries, fetched_at: new Date().toISOString(), map_data_timestamp: cleanText(payload.osm3s?.timestamp_osm_base, 40), endpoint: OVERPASS_ENDPOINTS[i], provider: 'OpenStreetMap via Overpass', source_url: 'https://www.openstreetmap.org/copyright', freshness: 'mapped_not_live' };
      } catch { /* Retry only after failure and only within the original ten-second budget. */ }
    }
    if (category === 'coffee' && deadline - Date.now() >= 300) {
      try { return await cityCoffee(location, radius, deadline); } catch { /* No fabricated fallback. */ }
    }
    throw new ToolError('PLACES_UNAVAILABLE', 'The map service did not respond in time. I cannot verify nearby places right now; please try again.');
  });
}

async function cityCoffee(location, radius, deadline, brand = null) {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric' }).format(new Date()).slice(-2);
  const terms = brand === 'tim_hortons' ? ['Tim Hortons'] : ['coffee', 'cafe', 'Tim Hortons', 'Starbucks'];
  const matches = terms.flatMap(term => [`search(businessname,'${term}')`, `search(businesstradename,'${term}')`]).join(' OR ');
  const where = `within_distance(geo_point_2d, GEOM'POINT(${location.longitude} ${location.latitude})', ${radius / 1000}km) AND folderyear='${year}' AND status='Issued' AND (${matches})`;
  const fetchPage = async offset => {
    const url = new URL(`${CITY_BASE}business-licences/records`);
    url.searchParams.set('limit', '100'); url.searchParams.set('offset', String(offset)); url.searchParams.set('where', where);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Timeout');
    const data = await fetchJson(url, {}, left);
    if (!Array.isArray(data.results) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.total_count > 1000) throw new Error('Invalid business licence response');
    return data;
  };
  const first = await fetchPage(0);
  const later = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total_count / 100) - 1) }, (_, i) => fetchPage((i + 1) * 100)));
  const records = [first, ...later].flatMap(page => page.results);
  if (records.length < first.total_count) throw new Error('Incomplete business licence response');
  const seen = new Set(), entries = [];
  for (const record of records) {
    const point = record.geo_point_2d, id = cleanText(record.licencersn, 30);
    if (!id || !/^\d+$/.test(id) || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    if (!['Restaurant', 'Limited Service Food Establishment'].includes(record.businesstype)) continue;
    const name = cleanText(record.businesstradename || record.businessname, 120);
    if (!name) continue;
    const street = [cleanText(record.house, 20), cleanText(record.street, 100)].filter(Boolean).join(' ');
    const unit = cleanText(record.unit, 30);
    const address = cleanText([unit ? `Unit ${unit}` : null, street, cleanText(record.city, 60), cleanText(record.postalcode, 12)].filter(Boolean).join(', '), 200);
    const key = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}:${address?.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      place_id: `city_licence:${id}`, name, brand: listedBrand(name, record.businesstradename || record.businessname), address, latitude: point.lat, longitude: point.lon,
      phone: null, phone_status: 'not_listed', listed_hours: null, hours_status: 'unknown',
      listing_kind: 'current_business_licence_not_opening_verification', licence_extract_date: cleanText(record.extractdate, 40),
      source_url: `https://opendata.vancouver.ca/explore/dataset/business-licences/table/?refine.licencersn=${id}`,
    });
  }
  return {
    entries, fetched_at: new Date().toISOString(), map_data_timestamp: null,
    endpoint: `${CITY_BASE}business-licences/records`, provider: 'City of Vancouver business licences',
    source_url: 'https://opendata.vancouver.ca/explore/dataset/business-licences/information/', freshness: 'licence_listing_not_live',
  };
}

async function timHortonsPlaces(location, radius, category = 'coffee') {
  const lat = Number(location.latitude.toFixed(5)), lon = Number(location.longitude.toFixed(5));
  return cached(`tim_brand:${lat}:${lon}:${radius}:${category}`, async () => {
    const deadline = Date.now() + REQUEST_BUDGET_MS;
    let cityResult = null;
    try {
      cityResult = await cityCoffee(location, radius, Math.min(deadline, Date.now() + 2500), 'tim_hortons');
      const entries = cityResult.entries.filter(entry => entry.brand === 'tim_hortons');
      if (entries.length) return { ...cityResult, entries };
    } catch { /* A failed City lookup may still be resolved by actual mapped listings. */ }
    try {
      return await mappedPlaces(location, category, radius, deadline);
    } catch (error) {
      if (cityResult) return { ...cityResult, entries: [] };
      throw error;
    }
  });
}

async function cityAmenities(kind) {
  const dataset = kind === 'washroom' ? 'public-washrooms' : 'drinking-fountains';
  return cached(`city:${dataset}`, async () => {
    const deadline = Date.now() + REQUEST_BUDGET_MS;
    const page = async offset => {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Timeout');
      const payload = await fetchJson(`${CITY_BASE}${dataset}/records?limit=100&offset=${offset}`, {}, left);
      if (!Array.isArray(payload.results) || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0 || payload.total_count > 2000) throw new Error('Invalid City response');
      return payload;
    };
    try {
      const first = await page(0);
      const later = await Promise.all(Array.from({ length: Math.ceil(first.total_count / 100) - 1 }, (_, i) => page((i + 1) * 100)));
      const records = [first, ...later].flatMap(value => value.results);
      if (records.length < first.total_count) throw new Error('Incomplete City response');
      const entries = [];
      for (const [index, record] of records.entries()) {
        const point = record.geo_point_2d;
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) continue;
        if (kind === 'washroom') {
          const name = cleanText(record.location || record.park_name, 120) || 'City-listed public washroom';
          entries.push({
            amenity_id: `city:public-washrooms:${index}`, name,
            location_description: cleanText(record.park_name, 140), latitude: point.lat, longitude: point.lon,
            listed_summer_hours: cleanText(record.summer_hours, 100), listed_winter_hours: cleanText(record.winter_hours, 100),
            wheelchair_access: cleanText(record.wheelchair_access, 40), note: cleanText(record.note, 160), availability: 'unknown',
          });
        } else {
          entries.push({
            amenity_id: `city:drinking-fountains:${cleanText(record.mapid, 50) || index}`,
            name: cleanText(record.name, 120) || 'City-listed drinking fountain',
            location_description: cleanText(record.location, 140), latitude: point.lat, longitude: point.lon,
            listed_operation_season: cleanText(record.in_operation, 100), pet_friendly: cleanText(record.pet_friendly, 40), availability: 'unknown',
          });
        }
      }
      return { entries, fetched_at: new Date().toISOString(), record_count: records.length, dataset, source_url: `https://opendata.vancouver.ca/explore/dataset/${dataset}/information/` };
    } catch {
      throw new ToolError('AMENITIES_UNAVAILABLE', 'The City of Vancouver data service did not return a complete result. I cannot verify those amenities right now; please try again.');
    }
  });
}

function locationPhrase(location) {
  return location.source === 'demo' ? 'Using the chosen demo location, ' : '';
}

async function localToolResult(name, args = {}, session = {}) {
  try {
    if (!LOCAL_TOOL_DEFINITIONS.some(tool => tool.name === name)) throw new ToolError('UNKNOWN_TOOL', 'That local tool is not available.');
    const location = locationFrom(session.location);
    if (name === 'get_location') {
      return { ok: true, location, spoken: location.source === 'demo' ? 'I am using the chosen demo location. It is not your current device location.' : `Your device location is ${location.age_seconds} seconds old${location.accuracy === null ? ', with accuracy not reported' : `, with reported accuracy of about ${location.accuracy} metres`}.` };
    }
    if (name === 'find_nearby_places') {
      if (!['coffee', 'food', 'pharmacy', 'grocery'].includes(args.category)) throw new ToolError('INVALID_CATEGORY', 'Choose coffee, food, pharmacy or grocery for the nearby search.');
      if (args.brand !== undefined && args.brand !== 'tim_hortons') throw new ToolError('INVALID_BRAND', 'The available brand filter is tim_hortons.');
      if (args.brand && !['coffee', 'food'].includes(args.category)) throw new ToolError('INVALID_BRAND_CATEGORY', 'Use coffee or food when searching for Tim Hortons.');
      const radius = args.radius_m === undefined ? 800 : args.radius_m;
      if (!Number.isFinite(radius) || radius < 300 || radius > 2000) throw new ToolError('INVALID_RADIUS', 'Choose a search radius between 300 and 2000 metres.');
      const data = args.brand === 'tim_hortons' ? await timHortonsPlaces(location, Math.round(radius), args.category) : await mappedPlaces(location, args.category, Math.round(radius));
      const places = data.entries.map(entry => ({ ...entry, straight_line_distance_m: distanceM(location, entry) }))
        .filter(entry => entry.straight_line_distance_m <= radius && (!args.brand || entry.brand === args.brand)).sort((a, b) => a.straight_line_distance_m - b.straight_line_distance_m).slice(0, 3);
      if (!(session.places instanceof Map)) session.places = new Map();
      for (const place of places) session.places.set(place.place_id, { ...place, fetched_at: data.fetched_at, location_source: location.source });
      const first = places[0];
      return {
        ok: true, status: places.length ? 'found' : 'no_results', category: args.category, ...(args.brand ? { brand: args.brand } : {}), radius_m: radius, location,
        distance_kind: 'approximate_straight_line', places,
        sources: [{ provider: data.provider, url: data.source_url, endpoint: data.endpoint, freshness: data.freshness, map_data_timestamp: data.map_data_timestamp }],
        fetched_at: data.fetched_at,
        spoken: locationPhrase(location) + (first ? `I found ${first.name}${data.freshness === 'licence_listing_not_live' ? ' in the City business-licence listings' : ''}, about ${first.straight_line_distance_m} metres away in a straight line.${first.listed_hours ? ' Its hours are map listings; I have not verified that it is open.' : ' Its opening hours are not listed.'}` : `I did not find a listed ${args.brand ? 'Tim Hortons' : args.category + ' place'} within ${radius} metres. That does not mean there are none.`),
      };
    }
    if (!['washroom', 'drinking_water'].includes(args.kind)) throw new ToolError('INVALID_AMENITY', 'Choose washroom or drinking_water for the amenity search.');
    const data = await cityAmenities(args.kind);
    const amenities = data.entries.map(entry => ({ ...entry, straight_line_distance_m: distanceM(location, entry) }))
      .sort((a, b) => a.straight_line_distance_m - b.straight_line_distance_m).slice(0, 3);
    const first = amenities[0];
    return {
      ok: true, status: amenities.length ? 'found' : 'no_results', kind: args.kind, location, amenities,
      distance_kind: 'approximate_straight_line', fetched_at: data.fetched_at,
      sources: [{ provider: 'City of Vancouver Open Data', url: data.source_url, dataset: data.dataset, records_fetched: data.record_count, freshness: 'listed_not_live' }],
      spoken: locationPhrase(location) + (first ? `The closest City-listed ${args.kind === 'washroom' ? 'washroom' : 'drinking fountain'} I found is ${first.name}, about ${first.straight_line_distance_m} metres away in a straight line. I have not verified that it is ${args.kind === 'washroom' ? 'currently unlocked' : 'currently working'}.` : 'The City data did not list any matching amenities.'),
    };
  } catch (error) {
    const known = error instanceof ToolError;
    return { ok: false, error_code: known ? error.code : 'TOOL_UNAVAILABLE', spoken: known ? error.message : 'I could not complete that lookup. Please try again.' };
  }
}

export async function handleLocalTool(name, args = {}, session = {}) {
  const result = await localToolResult(name, args, session);
  // Bound bytes as well as character counts: international listing text can
  // require several UTF-8 bytes per character. Keep identifiers and numbers intact.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= 6000) return result;
  let trimmed = false;
  const compact = (value, key = '') => {
    if (Array.isArray(value)) return value.map(entry => compact(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, compact(entry, field)]));
    if (typeof value !== 'string' || ['place_id', 'amenity_id', 'phone', 'source_url', 'url', 'endpoint', 'timestamp', 'fetched_at'].includes(key)) return value;
    const maxBytes = key === 'spoken' ? 512 : 192;
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    let text = '', bytes = 0;
    for (const character of value) {
      const size = Buffer.byteLength(character, 'utf8');
      if (bytes + size > maxBytes - 3) break;
      text += character; bytes += size;
    }
    trimmed = true;
    return `${text}…`;
  };
  const bounded = compact(result);
  if (trimmed) bounded.response_truncated = true;
  return bounded;
}

export async function prefetchLocalData(location) {
  let valid;
  try { valid = locationFrom(location); } catch { return { ok: false, error_code: 'INVALID_LOCATION' }; }
  const results = await Promise.allSettled([mappedPlaces(valid, 'coffee', 800), cityAmenities('washroom'), cityAmenities('drinking_water'), timHortonsPlaces(valid, 800)]);
  return { ok: true, coffee: results[0].status, washroom: results[1].status, drinking_water: results[2].status, tim_hortons: results[3].status };
}
