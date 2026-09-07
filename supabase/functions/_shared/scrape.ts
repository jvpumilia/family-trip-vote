// Best-effort listing scraper. Airbnb exposes rich metadata to a plain fetch;
// VRBO exposes title/description/image; everything else gets generic og: tags.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const STATES: Record<string, string> = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY","district of columbia":"DC",
};
export function stateAbbr(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return STATES[t.toLowerCase()] || null;
}

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function meta(html: string, name: string): string | null {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, "i");
  const m = html.match(re1) || html.match(re2);
  return m ? decode(m[1]) : null;
}
function num(re: RegExp, text: string): number | null {
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

export type Scraped = {
  ok: boolean; source: string; title: string | null; description: string | null; image_url: string | null;
  city: string | null; state: string | null; bedrooms: number | null; beds: number | null; bathrooms: number | null;
  sleeps: number | null; rating: number | null; review_count: number | null; property_type: string | null; text: string; note: string | null;
};

export function detectSource(url: string): string {
  const h = (() => { try { return new URL(url).hostname; } catch { return ""; } })().toLowerCase();
  if (h.includes("airbnb")) return "airbnb";
  if (h.includes("vrbo")) return "vrbo";
  if (h.includes("homeaway")) return "vrbo";
  if (h.includes("booking.com")) return "booking";
  if (h.includes("evolve")) return "evolve";
  if (h.includes("vacasa")) return "vacasa";
  return "other";
}

export async function scrape(url: string): Promise<Scraped> {
  const source = detectSource(url);
  const out: Scraped = { ok: false, source, title: null, description: null, image_url: null, city: null, state: null, bedrooms: null, beds: null, bathrooms: null, sleeps: null, rating: null, review_count: null, property_type: null, text: "", note: null };
  let html = "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html,application/xhtml+xml" }, redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) { out.note = `The site answered with HTTP ${res.status}; fill the details in by hand.`; return out; }
    html = (await res.text()).slice(0, 3_000_000);
  } catch (e) {
    out.note = `Could not fetch the page (${(e as Error).message}); fill the details in by hand.`;
    return out;
  }
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  const ogTitle = meta(html, "og:title");
  const ogDesc = meta(html, "og:description");
  const desc = meta(html, "description");
  out.image_url = meta(html, "og:image");

  if (source === "airbnb") {
    // og:title: "Cabin in Pigeon Forge · ★4.78 · 8 bedrooms · 11 beds · 8.5 baths"
    const ot = ogTitle || "";
    out.property_type = ot.match(/^([A-Za-z ]+?) in /)?.[1] || null;
    out.city = ot.match(/ in ([^·]+?)\s*·/)?.[1]?.trim() || null;
    out.rating = num(/★\s*([\d.]+)/, ot);
    out.bedrooms = num(/(\d+)\s*bedrooms?/i, ot);
    out.beds = num(/(\d+)\s*beds?\b/i, ot);
    out.bathrooms = num(/([\d.]+)\s*(?:private |shared )?baths?/i, ot);
    // <title>: "Name - Cabins for Rent in Pigeon Forge, Tennessee, United States - Airbnb"
    const tm = decode(title).match(/ in ([^,]+),\s*([^,]+),\s*United States/);
    if (tm) { out.city = out.city || tm[1].trim(); out.state = stateAbbr(tm[2].trim()); }
    out.title = ogDesc || decode(title).replace(/\s*-\s*[A-Za-z ]+ for Rent in .*$/, "").trim() || null;
    out.description = desc ? desc.replace(/^[A-Z][a-z]{2} \d{1,2}, \d{4}\s*·\s*/, "").replace(/^[^·]{0,40}·\s*/, "") : null;
    out.sleeps = num(/"personCapacity":(\d+)/, html);
    const cityJson = html.match(/"city":"([^"]+)"/)?.[1];
    if (cityJson && !out.city) out.city = cityJson;
    out.review_count = num(/"reviewCount":"?(\d+)/, html) ?? num(/(\d+)\s+reviews?/i, html);
    // Airbnb embeds the full description, the amenity list and the room-by-room sleeping arrangement in page JSON.
    const unescapeJson = (t: string) => { try { return JSON.parse('"' + t + '"'); } catch { return t.replace(/\\n/g, "\n").replace(/\\"/g, '"'); } };
    const lead = (out.description || "").slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // the same text appears several times (short teaser first); keep the longest
    const fulls = lead ? Array.from(html.matchAll(new RegExp('"localizedString":"(' + lead.slice(0, 40) + '(?:[^"\\\\]|\\\\.){100,})"', "g"))).map((m) => m[1]) : [];
    if (fulls.length) out.description = unescapeJson(fulls.sort((a, b) => b.length - a.length)[0]);
    const amen = Array.from(html.matchAll(/"available":true,"title":"([^"]+)"/g)).map((m) => m[1]);
    const rooms = Array.from(new Set(Array.from(html.matchAll(/"MediaTourStop","id":"[^"]+","name":"([^"]+)"/g)).map((m) => m[1])));
    const bedroomStops = rooms.filter((r) => /^bedroom/i.test(r)).length;
    const extra: string[] = [];
    if (amen.length) extra.push("Amenities listed: " + Array.from(new Set(amen)).slice(0, 60).join(", "));
    if (rooms.length) extra.push("Photo tour rooms: " + rooms.join(", ") + (bedroomStops ? ` (${bedroomStops} labelled bedrooms)` : ""));
    if (extra.length) out.description = (out.description || "") + "\n\n" + extra.join("\n");
    out.ok = !!(out.city && out.bedrooms);
    if (!out.description || out.description.length < 40) out.note = "Airbnb only gave us the headline; paste anything important from the listing into Notes.";
  } else if (source === "vrbo") {
    out.title = (ogTitle || decode(title)).replace(/\s*-\s*Browse Photos.*$/i, "").replace(/\s*\|\s*Vrbo.*$/i, "").trim();
    out.description = ogDesc || desc;
    const blob = [out.title, out.description].join(" ");
    out.bedrooms = num(/(\d+)\s*(?:BR|bedrooms?)\b/i, blob);
    out.bathrooms = num(/([\d.]+)\s*(?:BA|baths?|bathrooms?)\b/i, blob);
    out.sleeps = num(/sleeps\s*(\d+)/i, blob);
    out.note = "VRBO hides bedrooms, bathrooms and the exact town from us. Please confirm them below.";
    out.ok = false;
  } else {
    out.title = ogTitle || decode(title) || null;
    out.description = ogDesc || desc;
    const blob = [out.title, out.description].join(" ");
    out.bedrooms = num(/(\d+)\s*(?:BR|bedrooms?)\b/i, blob);
    out.bathrooms = num(/([\d.]+)\s*(?:BA|baths?|bathrooms?)\b/i, blob);
    out.sleeps = num(/sleeps\s*(\d+)/i, blob);
    out.note = "We could only read the page headline. Please confirm the details below.";
  }
  // visible text sample for the scorer (strip tags/scripts)
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  out.text = decode(text).slice(0, 6000);
  return out;
}

/** Free geocoder (OpenStreetMap Nominatim). One call per submission, so well inside their usage policy. */
export async function geocode(q: string): Promise<{ lat: number; lng: number; display: string } | null> {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  const res = await fetch(u, { headers: { "User-Agent": "family-trip-vote/1.0 (family reunion planning site)" } });
  if (!res.ok) return null;
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), display: arr[0].display_name };
}

export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 3958.8, toR = (d: number) => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
