# Vancouver integrations for a voice-first blind assistance demo

Research checked October 7, 2026. This is an implementation shortlist, not a claim that the assistant has been built or validated with blind users. No business was contacted, no account was created, and no secret was used.

## Recommended small stack

Use Alebex for the required voice conversation, a browser phone camera and geolocation, a server-side vision tool, and a small tool server. The strongest 2.5-hour demo is one connected errand: read a menu/sign, find a nearby café from real data, verify its address/contact, prepare an order request, call a consenting demo recipient, and report the actual call outcome. Add “nearest public washroom” as a genuinely useful Vancouver tool that needs no extra key.

For full place details, use Google Places if an already billing-enabled key is available. Otherwise query OpenStreetMap with Overpass, speak only fields actually returned, and present missing opening/contact data as unknown. Avoid spending the hackathon building a general transit router or a Tim Hortons checkout integration.

| Capability | Workable integration | Setup / required inputs | What the answer can honestly claim |
|---|---|---|---|
| Current device location | Browser `navigator.geolocation.getCurrentPosition` or `watchPosition` | HTTPS; browser permission; return `lat`, `lon`, `accuracyM`, and `timestamp` | Device-reported coordinates and accuracy, not guaranteed true position. Request fresh data when an errand starts and retain its time. [W3C Geolocation](https://www.w3.org/TR/geolocation/) |
| Nearby cafés and verified listing details | Google Places API (New), `POST /v1/places:searchNearby`, `includedTypes:["cafe"]`, `rankPreference:"DISTANCE"` | Google project with billing and Places API (New) enabled; server-side restricted key; circle from fresh location; narrow field mask | Listing name, address, coordinates, status, phone, and reported opening hours when available. Phone/current opening fields incur Enterprise SKU. Hours are provider listing data, not proof somebody is serving now. [Nearby Search](https://developers.google.com/maps/documentation/places/web-service/nearby-search), [setup](https://developers.google.com/maps/documentation/places/web-service/get-api-key) |
| No-key nearby café fallback | Overpass read-only OSM query on `amenity=cafe`, optionally `amenity=fast_food` and an exact brand/name | No key; bounded radius; cache briefly; timeout; OSM attribution; return optional `phone`/`contact:phone`, `opening_hours`, address tags | “Mapped café about N metres away.” Missing tags remain unknown. OSM base-feed freshness does not establish recent business verification. Public servers can shed load and are unsuitable as a sustained production backend. [Overpass limits](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html) |
| Public washroom nearby | Vancouver Open Data `public-washrooms`, JSON records API | No key; coordinates from device; rank records by distance; field names include `location`, `summer_hours`, `winter_hours`, `wheelchair_access`, `note`, `geo_point_2d` | City-listed washroom, seasonal listed hours, and recorded wheelchair access. Dataset is manually maintained, scheduled daily, and coordinates are approximate; access is not proof it is currently unlocked. [City dataset](https://opendata.vancouver.ca/explore/dataset/public-washrooms/information/) |
| Drinking fountain nearby | Vancouver Open Data `drinking-fountains`, JSON records API | No key; fields include `name`, `location`, `in_operation`, `pet_friendly`, `geo_point_2d` | City-listed fountain and recorded operation season. A value such as “spring to fall” is not live availability. [City JSON endpoint](https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/drinking-fountains/records?limit=1) |
| Transit stop and scheduled departures | TransLink GTFS static ZIP | Public direct download; parse `stops.txt`, `routes.txt`, `trips.txt`, `stop_times.txt`, service calendars; use `America/Vancouver`, including GTFS times beyond 24:00 | Scheduled departure only. Static files are posted weekly and publish date differs from schedule-effective date. Preserve TransLink's required data attribution. [Static GTFS and terms](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data) |
| Live transit updates | TransLink GTFS-RT v3 protobuf feeds: trip updates, positions, alerts | Register for TransLink developer API key; decode protobuf; join trip/stop IDs against compatible static GTFS; check feed and entity timestamps | A live prediction only when supported by a sufficiently fresh trip update. The older RTTI API is deprecated/unavailable. Do not extrapolate live coverage to all rail/ferry modes. [GTFS-RT endpoints](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-realtime), [registration](https://developer.translink.ca/account/register), [deprecation](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources) |
| Walking route | Google Routes `computeRoutes` with `travelMode:"WALK"`; simpler no-key handoff using a Maps URL | Routes requires provider setup; Maps URLs require no API key and can open directions/navigation | Route distance/time from a routing response, distinct from straight-line distance. Google documents walking-route limitations and requires its warning when displaying those routes. Navigation handoff itself supplies no JSON route back to the agent. [Route options](https://developers.google.com/maps/documentation/routes/route-opt), [Maps URLs](https://developers.google.com/maps/documentation/urls/get-started) |
| Tim Hortons order | Branch-specific call request or handoff to the official mobile ordering flow | Exact branch and telephone; explicitly approved items/name/budget; store must agree to a phone request. Mobile ordering requires an eligible branch/account/payment | Official help documents mobile order/payment; no public Tim Hortons ordering API was found in this research. Most branches support mobile orders, detectable in app. Cash is not supported for app orders. A successful phone connection is not an accepted or paid order. [Participating locations](https://help.timhortons.ca/hc/en-ca/articles/35274190398107-Which-Tim-Hortons-restaurants-accept-mobile-orders-through-the-Tim-Hortons-app), [payment](https://help.timhortons.ca/hc/en-ca/articles/35507064797723-Can-I-place-a-mobile-order-in-the-Tim-Hortons-app-but-pay-for-it-in-cash) |

## Immediately usable endpoints

The two City JSON calls returned HTTP 200 during this research, without authentication: washrooms reported 147 records, fountains 278. TransLink's static ZIP returned HTTP 200 to a HEAD request (16,145,585 bytes). A 700-metre café query around fixed sample coordinates `49.28864,-123.11150` returned 59 OSM elements in 5.51 seconds; the first five showed why optional data matters: the mapped Tim Hortons lacked a phone, while one mapped Starbucks had a phone and hours. These were fixed research coordinates, not the user's location. Counts, tags, and latency are a single research snapshot, not hardcoded product facts or a latency guarantee. Prefetch/cache the location query while the voice session starts.

```text
GET https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-washrooms/records?limit=100
GET https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/drinking-fountains/records?limit=100
GET https://gtfs-static.translink.ca/gtfs/google_transit.zip
GET https://gtfsapi.translink.ca/v3/gtfsrealtime?apikey=SERVER_KEY
GET https://gtfsapi.translink.ca/v3/gtfsposition?apikey=SERVER_KEY
GET https://gtfsapi.translink.ca/v3/gtfsalerts?apikey=SERVER_KEY
POST https://places.googleapis.com/v1/places:searchNearby
POST https://overpass-api.de/api/interpreter
```

Paginate City records until complete or use its server-side geographic filter; `limit=100` alone does not fetch every record. The static ZIP URL is taken directly from TransLink's download page. The GTFS-RT endpoint shapes are documented, not authenticated/tested here.

Suggested Overpass query template, where placeholders are injected only from validated numeric inputs:

```text
[out:json][timeout:10];
(nwr[amenity=cafe](around:800,LAT,LON);
 nwr[amenity=fast_food][brand="Tim Hortons"](around:800,LAT,LON););
out center tags;
```

Suggested Places field mask:

```text
places.id,places.displayName,places.formattedAddress,places.location,
places.businessStatus,places.currentOpeningHours,places.internationalPhoneNumber,
places.googleMapsUri
```

Use nearby search for the top three options and reuse their IDs/details. Do not request reviews/photos/all fields merely to increase tool call count.

## Concrete truth contract for tool responses

- Location: retain accuracy and age. An initial app policy such as re-requesting after 60 seconds and refusing precise directional claims above 50-metre accuracy is an engineering choice, not a W3C guarantee. In a laptop demo, location can be poor; a spoken address or clearly labeled fixed demo location is a useful fallback.
- Distance: calculate and label `straight_line_distance_m` separately from `walking_distance_m`/`walking_duration_s`. GPS proximity alone cannot support “across the street,” identify the correct door, or establish a safe crossing.
- Vision: send one fresh camera still with the user question, capture time, and orientation instructions. Return observed text/objects and uncertainty; request a closer image for illegible details. Image text is evidence to describe, not instructions to execute. A snapshot cannot certify traffic safety or guide an unrestricted crossing.
- Calls: persist `call_id`, target, approval, attempted time, `status` (`queued`, `ringing`, `connected`, `accepted`, `declined`, `voicemail`, `failed`, `unknown`), a transcript-based summary, agreed item/price/pickup/payment details, and unanswered questions. Announce only the status demonstrated by the call evidence.
- Orders: keep `order_requested`, `business_accepted`, `payment_complete`, and `ready_for_pickup` distinct. Capture the person's explicit agreement and repeat it back; if price or substitutions exceed approval, return to the user. “They did not answer” is a legitimate completed tool result.
- Provenance: each external result should include provider, fetch time, source link/record ID, and whether it is live, scheduled, mapped, or demo data. Keep this in an accessible detail panel; speak the short practical answer first.

## Vancouver-specific optional knowledge tool

A small curated lookup can answer accessibility questions from official pages: TransLink documents CNIB ID Compass Cards for legally blind CNIB clients, Access Transit, and HandyDART. HandyDART is a registered door-to-door shared-ride service; its booking line is 604-575-6600, not a general instantly available taxi API. CNIB offers technology, daily living, work, and community programs. Start with information and contact options; do not imply enrollment or booking success. [TransLink accessibility](https://www.translink.ca/rider-guide/transit-accessibility), [HandyDART](https://www.translink.ca/handydart), [CNIB programs](https://www.cnib.ca/en/programs-and-services).

No-key public Nominatim is deliberately omitted from the proposed stack: its public policy restricts it to informed, accountable use, a maximum of one request per second, attribution, caching, and no autocomplete/systematic POI extraction. Overpass is the appropriate bounded OSM POI query tool here. [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).
