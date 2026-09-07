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

/** Strip tracking/search parameters: "vrbo.com/444236?chkin=...&semcid=..." -> "https://www.vrbo.com/444236". Long query strings get us rate-limited. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h.includes("vrbo") || h.includes("homeaway")) { const m = u.pathname.match(/\/(?:p)?(\d{5,})/); if (m) return `https://www.vrbo.com/${m[1]}`; }
    if (h.includes("airbnb")) { const m = u.pathname.match(/\/rooms\/(\d+)/); if (m) return `https://www.airbnb.com/rooms/${m[1]}`; }
    u.hash = "";
    return u.toString();
  } catch { return url; }
}

export type Scraped = {
  ok: boolean; source: string; url: string; title: string | null; description: string | null; image_url: string | null;
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
  url = canonicalUrl(url);
  const out: Scraped = { ok: false, source, url, title: null, description: null, image_url: null, city: null, state: null, bedrooms: null, beds: null, bathrooms: null, sleeps: null, rating: null, review_count: null, property_type: null, text: "", note: null };
  let html = "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const headers = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html,application/xhtml+xml" };
    let res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    if (res.status === 429 || res.status === 403) {
      await new Promise((r) => setTimeout(r, 2500));
      res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    }
    clearTimeout(t);
    if (!res.ok) {
      const backup = await readerBackup(url, out);
      if (!backup) out.note = `The site answered with HTTP ${res.status} (it is blocking robots right now). Fill the details in by hand; the link is still saved.`;
      return out;
    }
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
    const caps = Array.from(new Set(Array.from(html.matchAll(/"caption":"((?:[^"\\\\]|\\\\.){15,300})"/g)).map((m) => unescapeJson(m[1]))))
      .filter((c) => /\b(bed|bunk|king|queen|twin|full|sleep)/i.test(c)).slice(0, 25);
    if (caps.length) extra.push("Photo captions about beds and rooms: " + caps.join(" | "));
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
    const parts = (ogTitle || decode(title)).replace(/\s*\|\s*Vrbo.*$/i, "").split(/\s+-\s+/);
    const cityFromTitle = parts.length > 1 ? parts[parts.length - 1].trim() : "";
    if (cityFromTitle && /^[A-Za-z .']{3,30}$/.test(cityFromTitle) && !/browse photos|hot tub|pool|view|cabin|home|lodge/i.test(cityFromTitle)) out.city = cityFromTitle;
    const got = await readerBackup(url, out);
    out.note = got
      ? "VRBO numbers were read through a backup reader. Double-check bedrooms, bathrooms and the town before saving."
      : "VRBO hides bedrooms, bathrooms and the exact town from us. Please confirm them below.";
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
  out.text = decode(text).slice(0, 14000);
  return out;
}

/** Backup: a free page-to-text reader service renders the page for us. Fills whatever is still blank. */
async function readerBackup(url: string, out: Scraped): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch("https://r.jina.ai/" + url, { headers: { "Accept": "text/plain" }, signal: ctrl.signal }); // no browser UA: their edge challenges it
    clearTimeout(t);
    if (!res.ok) return false;
    const md = (await res.text()).slice(0, 200000);
    if (md.length < 500) return false;
    const text = md.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[ \t]+/g, " ");
    const title = md.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    if (title && !out.title) out.title = title.replace(/\s*\|\s*Vrbo.*$/i, "").replace(/\s*-\s*Browse Photos.*$/i, "");
    out.bedrooms = out.bedrooms ?? num(/(\d+)\s*bedrooms?\b/i, text);
    out.bathrooms = out.bathrooms ?? num(/([\d.]+)\s*bathrooms?\b/i, text);
    out.sleeps = out.sleeps ?? num(/sleeps\s*(\d+)/i, text);
    out.rating = out.rating ?? num(/([\d.]+)\s*out of 10/i, text);
    out.review_count = out.review_count ?? num(/(\d+)\s*reviews?/i, text);
    const body = text.split(/Markdown Content:/)[1] || text;
    const cleaned = body.replace(/\n{2,}/g, "\n").trim();
    if (!out.description || out.description.length < 200) out.description = cleaned.slice(0, 5000);
    out.text = out.text || cleaned.slice(0, 6000);
    return !!(out.bedrooms || out.sleeps);
  } catch { return false; }
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
