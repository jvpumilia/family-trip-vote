import { corsHeaders, json, err } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/supa.ts";
import { scrape, geocode, milesBetween, stateAbbr, detectSource, canonicalUrl, crawlSite, verifyImages } from "../_shared/scrape.ts";
import { elevationFt, elevationNote, MAX_ELEVATION_FT } from "../_shared/elevation.ts";
import { askJson, extractListing, resolvePlace, findListings, pickHero, FAMILY_CONTEXT, DEST_RUBRIC, PROP_RUBRIC, DEST_SCHEMA, PROP_SCHEMA, sumScores } from "../_shared/claude.ts";

const MATCH_MILES = 45;

/** For a cabin company's own website, read the whole site (rooms, rates, amenities pages) and pull the facts out of all of it. */
async function enrichFromSite(s: { url: string; source: string; title: string | null; description: string | null; city: string | null; state: string | null; bedrooms: number | null; bathrooms: number | null; sleeps: number | null; text: string; note: string | null; ok: boolean }, force = false) {
  if (!force && (s.source === "airbnb" || s.source === "vrbo")) return;
  const crawl = await crawlSite(s.url, 10);
  if (crawl.pages.length) s.text = crawl.combined;
  if (crawl.photos?.length) (s as unknown as { photos: string[] }).photos = Array.from(new Set([...(s as unknown as { photos: string[] }).photos || [], ...crawl.photos])).slice(0, 16);
  if (!s.text || s.text.length < 200) return;
  const x = await extractListing(s.url, s.text);
  if (!x) return;
  s.title = x.title || s.title; s.city = x.city || s.city; s.state = stateAbbr(x.state) || x.state || s.state;
  s.bedrooms = x.bedrooms ?? s.bedrooms; s.bathrooms = x.bathrooms ?? s.bathrooms; s.sleeps = x.sleeps ?? s.sleeps;
  (s as unknown as Record<string, unknown>).price_night = x.price_night; (s as unknown as Record<string, unknown>).price_total = x.price_total;
  const pagesRead = crawl.pages.map((p) => p.url).join(", ");
  s.description = [x.summary, x.bed_summary ? "Beds per room (from the site): " + x.bed_summary : "", x.amenities?.length ? "Amenities: " + x.amenities.join(", ") : "", crawl.pages.length > 1 ? `Pages read: ${pagesRead}` : ""].filter(Boolean).join("\n\n");
  // keep the raw site text too, trimmed, so the scorer can see what the extractor saw
  s.description += "\n\n--- Site text (excerpt) ---\n" + s.text.slice(0, 9000);
  s.note = crawl.pages.length > 1 ? `We read ${crawl.pages.length} pages of that site. Please double-check the town, bedrooms and bathrooms before saving.` : "We read this page with a little AI help. Please double-check the town, bedrooms and bathrooms before saving.";
  s.ok = !!(s.city && s.bedrooms);
}

/** Cabin-company photos: keep only links that serve images, then let Claude choose the cover and drop graphics. */
async function curatePhotos(photos: string[], source: string): Promise<string[]> {
  if (!photos?.length) return [];
  if (source === "airbnb" || source === "vrbo") return photos;
  const ok = await verifyImages(photos, 20);
  if (!ok.length) return [];
  return await pickHero(ok);
}

/** Same listing link, or the same house name in the same destination, already on the list? */
async function findDuplicate(admin: ReturnType<typeof adminClient>, url: string | null, title: string, destinationId: string | null) {
  const normT = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (url) {
    const cu = canonicalUrl(url).toLowerCase().replace(/\/$/, "");
    const { data: byUrl } = await admin.from("properties").select("id,title,url,submitted_by,ai_pick,destination_id").not("url", "is", null);
    const hit = (byUrl || []).find((r: { url?: string }) => canonicalUrl(r.url || "").toLowerCase().replace(/\/$/, "") === cu);
    if (hit) return hit;
  }
  if (destinationId && title) {
    const { data: byTitle } = await admin.from("properties").select("id,title,submitted_by,ai_pick,destination_id").eq("destination_id", destinationId);
    const hit = (byTitle || []).find((r: { title: string }) => normT(r.title) === normT(title));
    if (hit) return hit;
  }
  return null;
}
const dupMessage = async (admin: ReturnType<typeof adminClient>, hit: { id: string; title: string; submitted_by: string | null; ai_pick: boolean }) => {
  let who = hit.ai_pick ? "Claude (AI Selected)" : "someone";
  if (hit.submitted_by) { const { data: pr } = await admin.from("profiles").select("household").eq("id", hit.submitted_by).maybeSingle(); if (pr?.household) who = `the ${pr.household} household`; }
  return `"${hit.title}" is already on the list, added by ${who}. Open that one instead; if it's yours, star it or edit it there.`;
};

/** Elevation is a hard health concern: cap the relevant criterion and make sure the text says why. */
function applyElevationCap(scores: Record<string, { score: number; why: string }>, key: string, cap: number, elev: number | null) {
  if (elev == null || !scores) return;
  delete scores.elevation;
  if (elev <= MAX_ELEVATION_FT) return;
  if (scores[key]) {
    if (scores[key].score > cap) scores[key].score = cap;
    if (!/elevation|altitude|feet|ft\b/i.test(scores[key].why || "")) scores[key].why = `Elevation ${elev.toLocaleString()} ft is above the family's 5,000 ft health limit. ` + (scores[key].why || "");
  }
  // plus a flat, visible penalty so the health issue can't be averaged away by strong scores elsewhere
  scores.elevation = { score: -10, why: `Flat penalty: ${elev.toLocaleString()} ft is above the family's ${MAX_ELEVATION_FT.toLocaleString()} ft health limit. Sleeping this high for a week is a problem for members of the group.` };
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

async function originsText(admin: ReturnType<typeof adminClient>, lat: number, lng: number) {
  const { data: origins } = await admin.from("origins").select("*").order("sort");
  return (origins || []).map((o) => `- ${o.key}: ${o.label} (airports ${o.airports}), ${Math.round(milesBetween(o, { lat, lng }))} miles as the crow flies`).join("\n");
}

async function createDestination(admin: ReturnType<typeof adminClient>, city: string, state: string, lat: number, lng: number, userId: string | null, hint = "") {
  const originsInfo = await originsText(admin, lat, lng);
  const elev = await elevationFt(lat, lng);
  const system = `You are the family's travel analyst. Score candidate destinations for a 14-person family reunion using the rubric exactly. Be honest and specific; the family would rather hear a weakness now than at check-in. Use what you know about the place as of your knowledge; if you are unsure of an inventory fact, say so in the why text.\n${FAMILY_CONTEXT}\n${DEST_RUBRIC}`;
  const user = `Score this destination: ${city}, ${state} (lat ${lat.toFixed(3)}, lng ${lng.toFixed(3)}). ${hint}\n${elevationNote(elev)}\n\nStraight-line distances from each household:\n${originsInfo}\n\nName the destination the way a travel planner would (e.g. "Gatlinburg / Pigeon Forge" rather than a single suburb). List 6-10 attractions and activities rated for THIS family (toddler through 11-year-old) including at least one rainy-day option. Give travel difficulty for all five households.`;
  const d = await askJson<Record<string, unknown>>(system, user, DEST_SCHEMA, 9000);
  const scores = d.scores as Record<string, { score: number; why: string }>;
  applyElevationCap(scores, "june", 3, elev);
  const total = sumScores(scores);
  const name = String(d.name || city);
  let slug = slugify(name);
  const { data: clash } = await admin.from("destinations").select("id").eq("slug", slug).maybeSingle();
  if (clash) slug = slug + "-" + Math.random().toString(36).slice(2, 6);
  const row = {
    slug, name, region: String(d.region || `${city}, ${state}`), state: stateAbbr(String(d.state || state)) || String(d.state || state).slice(0, 40),
    lat, lng, summary: d.summary, pros: d.pros, cons: d.cons, scores, total,
    gate_pass: (scores.lodging?.score || 0) >= 10, travel: d.travel, attractions: d.attractions,
    source: "ai", status: "scored", created_by: userId, elevation_ft: elev,
  };
  const { data: dest, error } = await admin.from("destinations").insert(row).select("*").single();
  if (error) throw new Error("Could not save destination: " + error.message);
  return dest;
}

async function nearestDestination(admin: ReturnType<typeof adminClient>, pt: { lat: number; lng: number }) {
  const { data: dests } = await admin.from("destinations").select("*");
  let best: Record<string, unknown> | null = null, bestMi = Infinity;
  for (const d of dests || []) {
    const mi = milesBetween(d as { lat: number; lng: number }, pt);
    if (mi < bestMi) { bestMi = mi; best = d; }
  }
  return best && bestMi <= MATCH_MILES ? best : null;
}

/** A house's town + state/province -> existing destination or a newly scored one. */
async function resolveDestination(admin: ReturnType<typeof adminClient>, city: string, state: string, userId: string | null) {
  const geo = await geocode(`${city}, ${state}`);
  if (!geo) throw new Error(`Could not find "${city}, ${state}" on the map. Check the spelling.`);
  const existing = await nearestDestination(admin, geo);
  if (existing) return { dest: existing, created: false, geo };
  const dest = await createDestination(admin, city, state, geo.lat, geo.lng, userId);
  return { dest, created: true, geo };
}

/** Free text ("banff canada", "yellowstone", "disney") -> existing destination or a newly scored one. */
async function resolveDestinationFromText(admin: ReturnType<typeof adminClient>, text: string, userId: string | null) {
  const place = await resolvePlace(text);
  if (!place) throw new Error(`We couldn't work out where "${text}" is. Try adding the state, province or country.`);
  // verify the town with the geocoder; fall back to the model's coordinates if the geocoder disagrees wildly or fails
  const q = [place.locality, place.region, place.country].filter(Boolean).join(", ");
  const geo = await geocode(q);
  let pt = geo && milesBetween(geo, place) < 150 ? { lat: geo.lat, lng: geo.lng } : { lat: place.lat, lng: place.lng };
  const existing = await nearestDestination(admin, pt);
  if (existing) return { dest: existing, created: false, place, geo: pt };
  const region = place.region_code || place.region;
  const hint = `The family asked for "${text}" (${place.place_name}, ${place.kind}). Base town: ${place.locality}, ${place.region}, ${place.country}. ${place.hint} Name the destination after what the family meant plus the base town, e.g. "Banff / Canmore, AB".`;
  const dest = await createDestination(admin, place.locality, region, pt.lat, pt.lng, userId, hint);
  return { dest, created: true, place, geo: pt };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { user, profile } = await requireUser(req);
    if (!user) return err("Please sign in.", 401);
    const body = await req.json();
    const admin = adminClient();
    const action = String(body.action || "");
    // nominations lock: a week before the vote closes, the ballot is fixed
    if (["submit", "nominate", "adopt", "prospect", "prospect_add"].includes(action)) {
      const { data: vs } = await admin.from("settings").select("value").eq("key", "voting").maybeSingle();
      const lock = vs?.value?.nominations_close ? new Date(vs.value.nominations_close) : null;
      if (lock && Date.now() > lock.getTime() && !(profile?.is_admin && body.as_ai)) {
        return err(`Nominations closed on ${lock.toLocaleDateString("en-US", { month: "long", day: "numeric" })}. The ballot is set; head to the Vote tab.`, 423);
      }
    }

    // 1) Paste a link -> read what we can from the page
    if (action === "preview") {
      const url = String(body.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return err("Paste a full link that starts with http.");
      const s = await scrape(url);
      if (s.source !== "airbnb" && s.source !== "vrbo") {
        try { await enrichFromSite(s); } catch (e) { console.error("site enrich failed", e); }
        return json({ prefill: { ...s, text: undefined }, source: s.source });
      }
      const incomplete = !s.city || !s.state || !s.bedrooms || !s.bathrooms || !s.sleeps;
      if (incomplete && s.text && s.text.length > 200) {
        try {
          const x = await extractListing(s.url, s.text);
          if (x) {
            s.title = s.title && s.source === "airbnb" ? s.title : (x.title || s.title);
            // the AI read of the page text beats a title-based guess for everything but Airbnb (whose tags are exact)
            s.city = s.source === "airbnb" ? (s.city || x.city) : (x.city || s.city);
            s.state = s.state || stateAbbr(x.state); s.bedrooms = s.bedrooms ?? x.bedrooms;
            s.bathrooms = s.bathrooms ?? x.bathrooms; s.sleeps = s.sleeps ?? x.sleeps;
            (s as unknown as Record<string, unknown>).price_night = x.price_night; (s as unknown as Record<string, unknown>).price_total = x.price_total;
            if (!s.description || s.description.length < 300) s.description = [x.summary, x.amenities?.length ? "Amenities: " + x.amenities.join(", ") : ""].filter(Boolean).join("\n\n");
            if (x.bed_summary) s.description = (s.description || "") + "\n\nBeds per room (from the page): " + x.bed_summary;
            s.note = "We read this page with a little AI help. Please double-check the town, bedrooms and bathrooms before saving.";
            s.ok = !!(s.city && s.bedrooms);
          }
        } catch (e) { console.error("extract failed", e); }
      }
      return json({ prefill: { ...s, text: undefined }, source: s.source });
    }

    // 2) Confirmed details -> place it on the map, create the destination if new, save as pending
    if (action === "submit") {
      const city = String(body.city || "").trim();
      const rawState = String(body.state || "").trim();
      const state = stateAbbr(rawState) || rawState.slice(0, 40);
      const title = String(body.title || "").trim();
      if (!city || !state) return err("Town and state/province are required so we can put it on the map.");
      if (!title) return err("Give the place a name.");
      const url = body.url ? canonicalUrl(String(body.url).trim()) : null;
      if (!body.as_ai) {
        const dupByUrl = await findDuplicate(admin, url, "", null);
        if (dupByUrl) return err(await dupMessage(admin, dupByUrl), 409, { existing_id: dupByUrl.id });
      }
      const { dest, created, geo } = await resolveDestination(admin, city, state, user.id);
      if (!body.as_ai) {
        const dupByTitle = await findDuplicate(admin, null, title, dest.id);
        if (dupByTitle) return err(await dupMessage(admin, dupByTitle), 409, { existing_id: dupByTitle.id });
      }
      // jitter property pins slightly so several in one town don't stack
      const jit = () => (Math.random() - 0.5) * 0.06;
      const asAi = !!body.as_ai && !!profile?.is_admin;
      const elevH = await elevationFt(geo.lat, geo.lng);
      const src = url ? detectSource(url) : "other";
      const photosIn: string[] = Array.isArray(body.photos) ? body.photos.filter((x: unknown) => typeof x === "string").slice(0, 16) : [];
      const photosOut = photosIn.length ? await curatePhotos(photosIn, src) : [];
      const row = {
        elevation_ft: elevH,
        ai_pick: asAi, ai_note: asAi ? (body.ai_note || null) : null,
        destination_id: dest.id, url, source: url ? detectSource(url) : "other", title, city, state,
        lat: geo.lat + jit(), lng: geo.lng + jit(),
        bedrooms: body.bedrooms ? parseInt(body.bedrooms) : null,
        bathrooms: body.bathrooms ? parseFloat(body.bathrooms) : null,
        sleeps: body.sleeps ? parseInt(body.sleeps) : null,
        price_night: body.price_night ? parseFloat(body.price_night) : null,
        price_total: body.price_total ? parseFloat(body.price_total) : null,
        image_url: (src === "airbnb" || src === "vrbo") ? (body.image_url || photosOut[0] || null) : (photosOut[0] || null), description: body.description || null,
        photos: photosOut,
        rating: body.rating ? parseFloat(body.rating) : null,
        review_count: body.review_count ? parseInt(body.review_count) : null,
        notes: body.notes || null, submitted_by: asAi ? null : user.id, status: "pending",
      };
      const { data: prop, error } = await admin.from("properties").insert(row).select("*").single();
      if (error) return err("Could not save the lodging: " + error.message, 500);
      return json({ property: prop, destination: dest, destination_created: created });
    }

    // 3) Score a saved lodging (owner or admin)
    if (action === "score") {
      const { data: prop } = await admin.from("properties").select("*").eq("id", body.property_id).maybeSingle();
      if (!prop) return err("Lodging not found", 404);
      const pendingAi = prop.ai_pick && prop.status === "pending";
      if (prop.submitted_by !== user.id && !profile?.is_admin && !pendingAi) return err("Only the person who added it can re-score it.", 403);
      if (body.ai_note !== undefined && profile?.is_admin) await admin.from("properties").update({ ai_note: body.ai_note }).eq("id", prop.id);
      const { data: dest } = await admin.from("destinations").select("*").eq("id", prop.destination_id).single();
      const thin = !prop.description || prop.description.length < 1500 || !prop.bathrooms;
      if (prop.url && prop.source !== "airbnb" && prop.source !== "vrbo" && (body.reread || thin)) {
        try {
          const s = await scrape(prop.url);
          await enrichFromSite(s, true);
          const upd: Record<string, unknown> = { description: s.description || prop.description, bedrooms: s.bedrooms ?? prop.bedrooms, bathrooms: s.bathrooms ?? prop.bathrooms, sleeps: s.sleeps ?? prop.sleeps, image_url: prop.image_url || s.image_url || s.photos?.[0] || null };
          if (s.photos?.length) { upd.photos = await curatePhotos(s.photos, prop.source); upd.image_url = (upd.photos as string[])[0] || prop.image_url || null; }
          const pn = (s as unknown as Record<string, unknown>).price_night; if (pn && !prop.price_night) upd.price_night = pn;
          if (s.city && s.state && (s.city.toLowerCase() !== (prop.city || "").toLowerCase())) {
            const g = await geocode(`${s.city}, ${s.state}`);
            if (g && milesBetween(g, dest) <= 90) { upd.city = s.city; upd.state = s.state; upd.lat = g.lat + (Math.random() - 0.5) * 0.06; upd.lng = g.lng + (Math.random() - 0.5) * 0.06; upd.elevation_ft = await elevationFt(g.lat, g.lng); }
          }
          const { data: fresh } = await admin.from("properties").update(upd).eq("id", prop.id).select("*").single();
          if (fresh) Object.assign(prop, fresh);
        } catch (e) { console.error("reread failed", e); }
      }
      const system = `You are the family's lodging analyst. Score one rental house for a 14-person family reunion using the rubric exactly. Base every score on the listing facts given; when a fact is missing, say so in the why text, score conservatively, and add it to the verify checklist. Never invent amenities.\n${FAMILY_CONTEXT}\n${PROP_RUBRIC}`;
      let elevP = prop.elevation_ft ?? (prop.lat != null ? await elevationFt(prop.lat, prop.lng) : null);
      if (elevP == null) elevP = dest.elevation_ft ?? null;
      const facts = {
        elevation_ft: elevP, elevation_note: elevationNote(elevP),
        title: prop.title, url: prop.url, source: prop.source, city: prop.city, state: prop.state,
        bedrooms_listed: prop.bedrooms, bathrooms_listed: prop.bathrooms, sleeps_listed: prop.sleeps,
        price_per_night: prop.price_night, price_total_week: prop.price_total, rating: prop.rating, review_count: prop.review_count,
        submitter_notes: prop.notes, listing_description: prop.description,
      };
      const user_msg = `DESTINATION CONTEXT: ${dest.name} (${dest.region}). ${dest.summary || ""}\nDestination scores: ${JSON.stringify(dest.scores)}\n\nLISTING FACTS (from the listing page and the family member who added it):\n${JSON.stringify(facts, null, 2)}\n\nScore this lodging.`;
      const r = await askJson<Record<string, unknown>>(system, user_msg, PROP_SCHEMA, 6000);
      const scores = r.scores as Record<string, { score: number; why: string }>;
      applyElevationCap(scores, "location", 3, elevP);
      const flags = Array.isArray(r.red_flags) ? r.red_flags as string[] : [];
      if (elevP != null && elevP > MAX_ELEVATION_FT && !flags.some((f) => /elevation|altitude/i.test(f))) flags.unshift(`Elevation ${elevP.toLocaleString()} ft: above the family's 5,000 ft health limit.`);
      r.red_flags = flags;
      const total = sumScores(scores);
      const couple = Number(r.couple_rooms) || 0, kids = Number(r.kid_rooms) || 0;
      const gate = couple >= 5 && couple + kids >= 7;
      const upd = {
        scores, total, gate_pass: gate, ai_summary: r.ai_summary, red_flags: r.red_flags,
        verify_checklist: r.verify_checklist,
        details: { ...(r.details as object), real_bedrooms: r.real_bedrooms, couple_rooms: couple, kid_rooms: kids, bed_plan: r.bed_plan, highlights: Array.isArray(r.highlights) ? (r.highlights as string[]).slice(0, 12) : [] }, elevation_ft: elevP,
        status: "scored", updated_at: new Date().toISOString(),
      };
      const { data: saved, error } = await admin.from("properties").update(upd).eq("id", prop.id).select("*").single();
      if (error) return err("Could not save the score: " + error.message, 500);
      return json({ property: saved });
    }

    // 3b) Adopt a system recommendation as one of my household's houses (a copy under my name)
    if (action === "adopt") {
      const { data: src } = await admin.from("properties").select("*").eq("id", body.property_id).maybeSingle();
      if (!src || !src.ai_pick) return err("Only recommendations can be adopted.", 400);
      const { data: dup } = await admin.from("properties").select("id").eq("adopted_from", src.id).eq("submitted_by", user.id).maybeSingle();
      if (dup) return json({ property_id: dup.id, already: true });
      const { id: _id, created_at: _c, updated_at: _u, ai_pick: _a, ai_note: _n, is_finalist: _f, ...rest } = src;
      const { data: prop, error } = await admin.from("properties").insert({ ...rest, submitted_by: user.id, adopted_from: src.id, ai_pick: false, is_finalist: false, notes: src.notes }).select("*").single();
      if (error) return err(error.message, 500);
      return json({ property_id: prop.id });
    }

    // 4) Nominate a destination with no lodging yet (it shows on the map but stays off the ballot)
    if (action === "nominate") {
      const text = String(body.place || [body.city, body.state].filter(Boolean).join(", ")).trim();
      if (text.length < 2) return err("Tell us where: a town, a park, a resort, anywhere.");
      const { dest, created, place } = await resolveDestinationFromText(admin, text, user.id);
      return json({ destination: dest, destination_created: created, resolved: place ? `${place.place_name} → ${place.locality}, ${place.region}, ${place.country}` : null });
    }

    // 4b) When a destination is new, search the web for the best 7+ BR houses there
    if (action === "prospect") {
      const { data: dest } = await admin.from("destinations").select("*").eq("id", body.destination_id).maybeSingle();
      if (!dest) return err("Destination not found", 404);
      const { count } = await admin.from("properties").select("id", { count: "exact", head: true }).eq("destination_id", dest.id).eq("ai_pick", true);
      if ((count || 0) >= 2 && !body.force) return json({ candidates: [], skipped: "already has AI picks" });
      const [locality, region] = String(dest.region || "").split(",").map((x: string) => x.trim());
      const country = /^[A-Z]{2}$/.test(dest.state) && !["AB", "BC", "ON", "QC", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU"].includes(dest.state) ? "United States" : (dest.state?.length > 2 ? dest.state : "Canada");
      const found = await findListings(dest.name, locality || dest.name, region || dest.state, country, 3);
      const { data: existing } = await admin.from("properties").select("url");
      const have = new Set((existing || []).map((r: { url: string | null }) => canonicalUrl(r.url || "").toLowerCase()));
      const candidates = found.filter((f) => !have.has(canonicalUrl(f.url).toLowerCase()));
      return json({ candidates, debug: body.debug ? (found as unknown as { _raw?: string })._raw : undefined });
    }
    // 4c) Read one found listing and file it as a pending AI pick (the client then calls "score")
    if (action === "prospect_add") {
      const url = canonicalUrl(String(body.url || "").trim());
      const { data: dest } = await admin.from("destinations").select("*").eq("id", body.destination_id).maybeSingle();
      if (!dest) return err("Destination not found", 404);
      const s = await scrape(url);
      if (s.source !== "airbnb" && s.source !== "vrbo") { try { await enrichFromSite(s); } catch (e) { console.error("site enrich failed", e); } }
      const incomplete = !s.city || !s.bedrooms || !s.bathrooms;
      if (incomplete && s.text && s.text.length > 200 && (s.source === "airbnb" || s.source === "vrbo")) {
        try {
          const x = await extractListing(s.url, s.text);
          if (x) {
            s.title = s.title && s.source === "airbnb" ? s.title : (x.title || s.title);
            s.city = s.source === "airbnb" ? (s.city || x.city) : (x.city || s.city);
            s.state = s.state || stateAbbr(x.state) || x.state; s.bedrooms = s.bedrooms ?? x.bedrooms; s.bathrooms = s.bathrooms ?? x.bathrooms; s.sleeps = s.sleeps ?? x.sleeps;
            (s as unknown as Record<string, unknown>).price_night = x.price_night;
            if (!s.description || s.description.length < 300) s.description = [x.summary, x.amenities?.length ? "Amenities: " + x.amenities.join(", ") : ""].filter(Boolean).join("\n\n");
            if (x.bed_summary) s.description = (s.description || "") + "\n\nBeds per room (from the page): " + x.bed_summary;
          }
        } catch (e) { console.error("extract failed", e); }
      }
      if (!s.title || !s.bedrooms || s.bedrooms < 6) return json({ skipped: `not usable (${s.bedrooms ?? "?"} BR)`, title: s.title });
      if (await findDuplicate(admin, s.url, s.title, dest.id)) return json({ skipped: "already on the list", title: s.title });
      // the listing has to actually be near this destination (search engines love a same-named town elsewhere)
      let near = { lat: dest.lat, lng: dest.lng };
      if (s.city) {
        const g = await geocode([s.city, s.state].filter(Boolean).join(", "));
        if (g) {
          if (milesBetween(g, dest) > 90) return json({ skipped: `wrong place: ${s.city}, ${s.state} is ${Math.round(milesBetween(g, dest))} miles from ${dest.name}`, title: s.title });
          near = g;
        }
      }
      const jit = () => (Math.random() - 0.5) * 0.06;
      const row = {
        ai_pick: true, ai_note: `Found by web search when ${dest.name} was added. ${body.why || ""}`.trim(),
        destination_id: dest.id, url: s.url, source: s.source, title: s.title, city: s.city || dest.region.split(",")[0], state: s.state || dest.state,
        lat: near.lat + jit(), lng: near.lng + jit(), elevation_ft: await elevationFt(near.lat, near.lng), bedrooms: s.bedrooms, bathrooms: s.bathrooms, sleeps: s.sleeps,
        price_night: (s as unknown as Record<string, unknown>).price_night ?? null, image_url: (s.source === "airbnb" || s.source === "vrbo") ? (s.image_url || s.photos?.[0] || null) : ((s.photos = await curatePhotos(s.photos || [], s.source))[0] || null), description: s.description, photos: s.photos || [],
        rating: s.rating, review_count: s.review_count, submitted_by: null, status: "pending",
      };
      const { data: prop, error } = await admin.from("properties").insert(row).select("id,title").single();
      if (error) return err(error.message, 500);
      return json({ property_id: prop.id, title: prop.title });
    }

    // 4d) Pull the listing's photos again (owner, admin, or anyone for an AI pick)
    if (action === "refresh_photos") {
      const { data: prop } = await admin.from("properties").select("*").eq("id", body.property_id).maybeSingle();
      if (!prop || !prop.url) return err("No listing link on this house.", 400);
      let photos: string[] = [];
      const s = await scrape(prop.url);
      photos = s.photos || [];
      if (prop.source !== "airbnb" && prop.source !== "vrbo") { try { const c = await crawlSite(prop.url, 8); photos = Array.from(new Set([...photos, ...c.photos])).slice(0, 16); } catch (e) { console.error(e); } }
      photos = await curatePhotos(photos, prop.source);
      const upd: Record<string, unknown> = { photos, image_url: photos[0] || prop.image_url || null };
      const { data: saved, error } = await admin.from("properties").update(upd).eq("id", prop.id).select("id,photos").single();
      if (error) return err(error.message, 500);
      return json({ photos: saved.photos });
    }

    // 5) Admin: re-run a destination's scoring
    if (action === "rescore_destination") {
      if (!profile?.is_admin) return err("Admins only.", 403);
      const { data: dest } = await admin.from("destinations").select("*").eq("id", body.destination_id).single();
      if (!dest) return err("Not found", 404);
      const originsInfo = await originsText(admin, dest.lat, dest.lng);
      const elevD = dest.elevation_ft ?? await elevationFt(dest.lat, dest.lng);
      const system = `You are the family's travel analyst. Score candidate destinations for a 14-person family reunion using the rubric exactly. Be honest and specific.\n${FAMILY_CONTEXT}\n${DEST_RUBRIC}`;
      const u = `Re-score this destination: ${dest.name} (${dest.region}), lat ${dest.lat}, lng ${dest.lng}.\n${elevationNote(elevD)}\nStraight-line distances from each household:\n${originsInfo}\nList 6-10 attractions rated for this family, and travel difficulty for all five households.`;
      const d = await askJson<Record<string, unknown>>(system, u, DEST_SCHEMA, 9000);
      const scores = d.scores as Record<string, { score: number; why: string }>;
      applyElevationCap(scores, "june", 3, elevD);
      const upd = { summary: d.summary, pros: d.pros, cons: d.cons, scores, total: sumScores(scores), gate_pass: (scores.lodging?.score || 0) >= 10, travel: d.travel, attractions: d.attractions, source: dest.source === "packet" ? "packet" : "ai", status: "scored", updated_at: new Date().toISOString(), elevation_ft: elevD };
      const { data: saved, error } = await admin.from("destinations").update(upd).eq("id", dest.id).select("*").single();
      if (error) return err(error.message, 500);
      return json({ destination: saved });
    }

    return err("Unknown action");
  } catch (e) {
    console.error(e);
    return err((e as Error).message || "Something went wrong", 500);
  }
});
