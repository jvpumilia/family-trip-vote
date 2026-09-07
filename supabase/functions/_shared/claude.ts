import Anthropic from "npm:@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
const MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-opus-5";

export const FAMILY_CONTEXT = `
THE FAMILY AND THE TRIP
- 14 people from five households: Southwest Florida (fly RSW or TPA), Gig Harbor WA (fly SEA), Nashville TN (fly BNA), Rockford IL (fly ORD/RFD/MKE), Janesville WI (fly MSN/MKE/ORD).
- Kids are 11, 8, 4 and 2. Two car seats and a booster travel with them.
- Seven nights in June 2027, Saturday to Saturday. Must be booked by 30 September 2026.
- HARD REQUIREMENT, the sleeping plan: seven real, enclosed bedrooms with real beds. Five are COUPLE ROOMS (five couples, each sharing a bed): each needs a king, a queen, or two full beds. Two are KIDS' ROOMS (the two households travelling with the children, Gig Harbor and Southwest Florida, each need a second room): bunk beds are fine there, and two kids sharing one bed need at least a queen. So one or two bunk-bed bedrooms are welcome and count toward the seven. Lofts, open sleeping nooks and pull-out couches do not count as bedrooms. Extra bedrooms beyond seven are margin, not waste.
- Stated goals, in the family's words: (1) a house that never becomes a point of contention, (2) low travel burden for everyone, weighing the longest trips most (Gig Harbor is farthest and Southwest Florida has fewer nonstops), with as few connections and car-seat hours as possible, (3) kid activities that work for a toddler AND an eleven-year-old, plus rainy-day options, (4) nature / national-park access.
- Also matters: six or more bathrooms, two refrigerators and two dishwashers, a table that seats 14, parking for three or more cars, on-site kid amenities (pool, game room, theater, playground), overflow lodging within 10 minutes for late-adding relatives, and June heat, crowds and cost.
`;

export const DEST_RUBRIC = `
DESTINATION RUBRIC (100 points). Score each criterion as an integer.
1. lodging (max 25) - GATE: depth of true 7+ bedroom inventory (five couple rooms with king/queen/two fulls plus two kids' rooms, bunks fine, no sofa beds), still bookable for peak June 2027 nine months out. Under 10 = disqualified. 25 = dozens of qualifying homes across several managers; 15-20 = a handful; <10 = one or none.
2. amenities (max 10) - pool, game room, theater, playground at or beside typical large rentals.
3. travel (max 20) - 10 points for the longest leg, Gig Harbor via Seattle (nonstop availability + ground time), 10 points for the other four origins combined. Describe travel neutrally; never frame any household as the complainer.
4. kids (max 15) - activity range for ages 2 through 11, must work for a toddler AND an 11-year-old, plus rainy-day options.
5. nature (max 15) - 15 = adjacent to a national park; 8 = strong state park or national forest; 4 = token.
6. overflow (max 5) - late-adding relatives can book something comparable within 10 minutes.
7. june (max 10) - price, heat, crowding and weather risk in June specifically.

TRAVEL DIFFICULTY per origin household: difficulty is an integer 1 (trivial) to 10 (brutal). Consider nonstop availability from that household's airports, flight time, drive time after landing, total door-to-door hours, connections, and hours a two-year-old spends in a car seat. Roughly: 1-2 = under 4 hours door to door or a short drive; 3-4 = one nonstop plus under an hour of driving; 5-6 = one nonstop plus a long drive, or an all-day drive; 7-8 = a connection or 9+ hours; 9-10 = a connection plus a long drive, 10+ hours.
`;

export const PROP_RUBRIC = `
LODGING RUBRIC (100 points). Score each criterion as an integer.
1. bedrooms (max 25) - the SLEEPING PLAN. Count couple_rooms (enclosed bedrooms with a king, a queen, or two full beds) and kid_rooms (enclosed bedrooms whose beds are bunks, twins, or a single queen suitable for two children). A room with a king AND a bunk still counts once, as a couple room. Lofts, nooks and sofa beds count for nothing. Then: couple_rooms >= 5 and total >= 7 with an extra room to spare = 25; exactly 5 couple rooms + 2 kids' rooms = 21; 7+ rooms but only 4 couple rooms (one couple in a bunk room) = 12; 6 rooms = 8; fewer = 0-3. If the listing does not say what beds are in each room, count only what you can verify, score conservatively and put "confirm beds per room in writing" in the checklist.
2. bathrooms (max 10) - 7+ full baths = 10; 6 = 8; 5 = 5; 4 or fewer = 2.
3. kid_amenities (max 15) - private pool (indoor pool is best for June storms), hot tub, game room/arcade, theater, playground, resort water park access.
4. kitchen_gathering (max 10) - two refrigerators, two dishwashers, table for 14, a gathering room that holds everyone.
5. location (max 10) - minutes to the main attractions, the park, and the airport; traffic; steepness/remoteness with a toddler.
6. value (max 15) - June price per bedroom-night against the local market and the family's budget sense; unknown price = 8 with a note.
7. reviews (max 10) - rating x volume; a new listing with no reviews scores 4 and gets a red flag.
8. logistics (max 5) - parking for 3+ cars, stairs/decks/loft safety for a 2- and 4-year-old, crib/high chair, check-in flexibility.
gate_pass is true only when you are reasonably confident of five couple rooms plus two kids' rooms (seven enclosed bedrooms total).
`;

const RETRYABLE = /overloaded|rate.?limit|529|503|timeout/i;

async function call(system: string, user: string, schema: Record<string, unknown>, maxTokens: number, withFallbacks: boolean) {
  const params: Record<string, unknown> = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
  };
  if (withFallbacks) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  // deno-lint-ignore no-explicit-any
  return await (client.beta.messages as any).create(params);
}

/** Ask Claude for a JSON object that matches `schema`. */
export async function askJson<T>(system: string, user: string, schema: Record<string, unknown>, maxTokens = 8000): Promise<T> {
  let res;
  try {
    res = await call(system, user, schema, maxTokens, true);
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/fallback|beta/i.test(msg) && !RETRYABLE.test(msg)) {
      res = await call(system, user, schema, maxTokens, false); // older API surface: retry plain
    } else if (RETRYABLE.test(msg)) {
      await new Promise((r) => setTimeout(r, 4000));
      res = await call(system, user, schema, maxTokens, true);
    } else throw e;
  }
  if (res.stop_reason === "refusal") throw new Error("The scoring model declined this request.");
  const text = (res.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text || "").join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Scoring model returned no JSON");
    return JSON.parse(m[0]) as T;
  }
}

const scoreObj = (max: number) => ({
  type: "object", additionalProperties: false, required: ["score", "why"],
  properties: { score: { type: "integer", description: `0 to ${max}` }, why: { type: "string" } },
});
const travelObj = {
  type: "object", additionalProperties: false, required: ["difficulty", "hours", "route", "nonstop", "notes"],
  properties: {
    difficulty: { type: "integer", description: "1 (easiest) to 10 (hardest)" },
    hours: { type: "number" },
    route: { type: "string" },
    nonstop: { type: "boolean" },
    notes: { type: "string" },
  },
};

export const DEST_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "region", "state", "summary", "pros", "cons", "scores", "travel", "attractions"],
  properties: {
    name: { type: "string", description: "Short destination name, e.g. 'Gatlinburg / Pigeon Forge'" },
    region: { type: "string", description: "City, ST" },
    state: { type: "string", description: "Two-letter state" },
    summary: { type: "string", description: "3-5 plain sentences for the family: what it is, why it might win, why it might lose." },
    pros: { type: "array", items: { type: "string" } },
    cons: { type: "array", items: { type: "string" } },
    scores: {
      type: "object", additionalProperties: false,
      required: ["lodging", "amenities", "travel", "kids", "nature", "overflow", "june"],
      properties: { lodging: scoreObj(25), amenities: scoreObj(10), travel: scoreObj(20), kids: scoreObj(15), nature: scoreObj(15), overflow: scoreObj(5), june: scoreObj(10) },
    },
    travel: {
      type: "object", additionalProperties: false,
      required: ["florida", "gigharbor", "nashville", "rockford", "janesville"],
      properties: { florida: travelObj, gigharbor: travelObj, nashville: travelObj, rockford: travelObj, janesville: travelObj },
    },
    attractions: {
      type: "array", description: "6 to 10 items",
      items: {
        type: "object", additionalProperties: false, required: ["name", "category", "rating", "ages", "why"],
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: ["theme park", "national park", "outdoors", "water", "animals", "museum", "rainy day", "food", "scenic", "other"] },
          rating: { type: "integer", description: "1 to 5, fit for THIS family, 5 = must-do" },
          ages: { type: "string", description: "e.g. 'all ages', '5+', 'toddler-friendly'" },
          why: { type: "string" },
        },
      },
    },
  },
};

export const PROP_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["scores", "real_bedrooms", "couple_rooms", "kid_rooms", "bed_plan", "gate_pass", "ai_summary", "red_flags", "verify_checklist", "details"],
  properties: {
    scores: {
      type: "object", additionalProperties: false,
      required: ["bedrooms", "bathrooms", "kid_amenities", "kitchen_gathering", "location", "value", "reviews", "logistics"],
      properties: { bedrooms: scoreObj(25), bathrooms: scoreObj(10), kid_amenities: scoreObj(15), kitchen_gathering: scoreObj(10), location: scoreObj(10), value: scoreObj(15), reviews: scoreObj(10), logistics: scoreObj(5) },
    },
    real_bedrooms: { type: "integer", description: "Your best estimate of real enclosed bedrooms" },
    couple_rooms: { type: "integer", description: "Enclosed bedrooms with a king, queen or two full beds" },
    kid_rooms: { type: "integer", description: "Enclosed bedrooms with bunks/twins/one queen that suit two children (not already counted as couple rooms)" },
    bed_plan: { type: "string", description: "One or two plain sentences: which rooms sleep the five couples and which two rooms take the kids, and what is unknown." },
    gate_pass: { type: "boolean" },
    ai_summary: { type: "string", description: "3-4 plain sentences: what this house is, what it does well for us, what worries you." },
    red_flags: { type: "array", items: { type: "string" } },
    verify_checklist: { type: "array", items: { type: "string" }, description: "Things to confirm with the host in writing before a deposit." },
    details: {
      type: "object", additionalProperties: false,
      required: ["indoor_pool", "outdoor_pool", "hot_tub", "game_room", "theater", "kitchen_notes", "parking", "toddler_notes"],
      properties: {
        indoor_pool: { type: "boolean" }, outdoor_pool: { type: "boolean" }, hot_tub: { type: "boolean" },
        game_room: { type: "boolean" }, theater: { type: "boolean" },
        kitchen_notes: { type: "string" }, parking: { type: "string" }, toddler_notes: { type: "string" },
      },
    },
  },
};

const DEST_MAX: Record<string, number> = { lodging: 25, amenities: 10, travel: 20, kids: 15, nature: 15, overflow: 5, june: 10 };
const PROP_MAX: Record<string, number> = { bedrooms: 25, bathrooms: 10, kid_amenities: 15, kitchen_gathering: 10, location: 10, value: 15, reviews: 10, logistics: 5 };
/** Clamp every score into its rubric range, then add them up. */
export function sumScores(scores: Record<string, { score: number }>): number {
  let total = 0;
  for (const [k, s] of Object.entries(scores || {})) {
    const max = DEST_MAX[k] ?? PROP_MAX[k] ?? 100;
    const v = Math.max(0, Math.min(max, Math.round(Number(s?.score) || 0)));
    s.score = v; total += v;
  }
  return total;
}

const nullable = (t: string, description = "") => ({ type: [t, "null"], description });
export const EXTRACT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "city", "state", "bedrooms", "bathrooms", "sleeps", "price_night", "price_total", "summary", "amenities", "bed_summary"],
  properties: {
    title: nullable("string", "The house's name as the listing gives it"),
    city: nullable("string", "Town the house is in (not the company's office town)"),
    state: nullable("string", "Two-letter state"),
    bedrooms: nullable("integer", "Bedrooms the listing states"),
    bathrooms: nullable("number"),
    sleeps: nullable("integer"),
    price_night: nullable("number", "Nightly rate in USD if the page states one"),
    price_total: nullable("number", "Weekly total in USD if the page states one"),
    summary: { type: "string", description: "The listing's own description, condensed to the facts that matter for a 14-person family: rooms, beds, pools, game room, theater, kitchen, parking, location" },
    amenities: { type: "array", items: { type: "string" } },
    bed_summary: nullable("string", "Beds per bedroom as the page states them, e.g. '4 king rooms, 2 queen rooms, 1 bunk room (2 queen bunks)'"),
  },
};
export type Extracted = { title: string | null; city: string | null; state: string | null; bedrooms: number | null; bathrooms: number | null; sleeps: number | null; price_night: number | null; price_total: number | null; summary: string; amenities: string[]; bed_summary: string | null };

/** Pull listing facts out of raw page text with a fast model. */
export async function extractListing(url: string, text: string): Promise<Extracted | null> {
  if (!text || text.length < 200) return null;
  const params: Record<string, unknown> = {
    model: Deno.env.get("CLAUDE_EXTRACT_MODEL") || "claude-sonnet-5",
    max_tokens: 2000,
    system: "You extract facts from vacation-rental web pages. Use only what the page text says. Use null for anything the page does not state. The town must be where the house is, not where the rental company is based; if the page names a resort or community, still give the town.",
    messages: [{ role: "user", content: `URL: ${url}\n\nPAGE TEXT:\n${text.slice(0, 14000)}` }],
    output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
  };
  // deno-lint-ignore no-explicit-any
  const res = await (client.beta.messages as any).create(params);
  if (res.stop_reason === "refusal") return null;
  const t = (res.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text || "").join("");
  try { return JSON.parse(t) as Extracted; } catch { return null; }
}
