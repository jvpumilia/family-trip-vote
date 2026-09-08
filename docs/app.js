/* Family Trip Vote — single-page app. Talks to Supabase directly for reads/writes (row-level security
   enforces who may change what) and to three edge functions for signup, link scoring and admin tasks. */
(() => {
  const CFG = window.FTV_CONFIG;
  const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  // date-only strings ("2027-06-05") are calendar dates, not instants: format them in UTC so they don't slip a day
  const fmtDate = (s) => s ? (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) : "";
  const fmtDateTime = (s) => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

  const DEST_CRITERIA = [
    ["lodging", "Lodging (gate)", 25], ["amenities", "Kid amenities", 10], ["travel", "Travel burden", 20],
    ["kids", "Kid activities", 15], ["nature", "Nature / parks", 15], ["overflow", "Overflow lodging", 5], ["june", "June cost & weather", 10],
  ];
  const PROP_CRITERIA = [
    ["bedrooms", "Real bedrooms (gate)", 25], ["bathrooms", "Bathrooms", 10], ["kid_amenities", "Kid amenities", 15],
    ["kitchen_gathering", "Kitchen & gathering", 10], ["location", "Location", 10], ["value", "Value", 15],
    ["reviews", "Reviews", 10], ["logistics", "Parking & toddler logistics", 5],
  ];

  const S = { session: null, profile: null, profiles: [], origins: [], dests: [], props: [], votes: [], settings: {}, avail: [], favs: new Set(), noms: [], seen: new Set(), tab: "map", map: null, layers: {}, selectedDest: null, filter: "", sort: "total" };

  // ---------- tiny UI helpers ----------
  let toastT;
  function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
  function openModal(html) { $("#modal-body").innerHTML = html; $("#modal").hidden = false; document.body.style.overflow = "hidden"; }
  function closeModal() { $("#modal").hidden = true; document.body.style.overflow = ""; }
  $("#modal-close").onclick = closeModal;
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  const stars = (n) => `<span class="stars" title="${n} of 5">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
  const diffPill = (d, label) => `<i class="pill d${Math.min(10, Math.max(1, d || 5))}" title="Travel difficulty ${d}/10">${esc(label ?? d)}</i>`;
  const householdOf = (uid) => S.profiles.find((p) => p.id === uid)?.household || "";
  const nameOf = (uid) => S.profiles.find((p) => p.id === uid)?.display_name || "";
  const destOf = (p) => S.dests.find((d) => d.id === p.destination_id);
  const normUrl = (u) => (u || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const aiPicks = () => S.props.filter((p) => p.ai_pick);
  const isDq = (p) => p.avail_status === "unavailable";
  const isFav = (p) => S.favs.has(p.id);
  /** "New" = added after this person's account was created and not opened by them yet */
  const isNew = (p) => !!S.profile && !S.seen.has(p.id) && new Date(p.created_at).getTime() > new Date(S.profile.created_at).getTime();
  const newBadge = (p) => isNew(p) ? `<i class="pill new">New</i>` : "";
  const newCount = () => S.props.filter(isNew).length;
  function markSeen(p) {
    if (!isNew(p)) return;
    S.seen.add(p.id);
    sb.from("seen_properties").insert({ user_id: S.session.user.id, property_id: p.id }).then(({ error }) => { if (error && !/duplicate/.test(error.message)) console.warn("seen", error.message); });
    renderAll();
  }
  const favBtn = (p, cls = "") => `<button class="fav ${isFav(p) ? "on" : ""} ${cls}" data-fav="${p.id}" title="${isFav(p) ? "Remove from my favorites" : "Save to my favorites"}" aria-label="favorite">${isFav(p) ? "♥" : "♡"}</button>`;
  async function toggleFav(id) {
    if (S.favs.has(id)) { const { error } = await sb.from("favorites").delete().eq("user_id", S.session.user.id).eq("property_id", id); if (error) { toast(error.message, 5000); return; } S.favs.delete(id); }
    else { const { error } = await sb.from("favorites").insert({ user_id: S.session.user.id, property_id: id }); if (error) { toast(error.message, 5000); return; } S.favs.add(id); }
    renderAll();
    const open = $("#modal").hidden ? null : S.props.find((x) => x.id === id); if (open && $("#modal-body").innerHTML.includes(`data-fav="${id}"`)) { const b = $(`#modal-body [data-fav="${id}"]`); if (b) { b.classList.toggle("on", S.favs.has(id)); b.textContent = S.favs.has(id) ? "♥" : "♡"; } }
  }
  const maxElev = () => S.settings.trip?.max_elevation_ft ?? 5000;
  const elevPill = (ft) => ft == null ? "" : ft > maxElev() ? `<i class="pill warn" title="Above the family's ${maxElev().toLocaleString()} ft health limit">⛰ ${ft.toLocaleString()} ft: too high</i>` : ft > maxElev() - 1000 ? `<i class="pill sun" title="Borderline for the ${maxElev().toLocaleString()} ft limit">⛰ ${ft.toLocaleString()} ft</i>` : `<i class="pill neutral">⛰ ${ft.toLocaleString()} ft</i>`;
  const tripWeek = () => { const t = S.settings.trip || {}; return t.check_in && t.check_out ? `${fmtDate(t.check_in)} to ${fmtDate(t.check_out)}` : "our June 2027 week (dates not set yet)"; };
  const availBadge = (p, small) => isDq(p) ? `<i class="pill warn">Not available: disqualified</i>` : p.avail_status === "available" ? `<i class="pill ok">Availability confirmed</i>` : (small ? "" : `<i class="pill neutral">Availability unchecked</i>`);
  async function setAvailability(id, status, note) {
    const { error } = await sb.rpc("set_availability", { p_id: id, p_status: status, p_note: note || null });
    if (error) { toast(error.message, 6000); return false; }
    await loadAll(); renderAll(); return true;
  }
  /** the AI pick a family house matches (same listing), or null */
  const aiMatchFor = (p) => p.ai_pick ? null : aiPicks().find((a) => a.id === p.adopted_from || (a.url && p.url && normUrl(a.url) === normUrl(p.url))) || null;
  /** family houses that match an AI pick */
  const familyMatchesFor = (a) => S.props.filter((p) => !p.ai_pick && (p.adopted_from === a.id || (a.url && p.url && normUrl(a.url) === normUrl(p.url))));
  const nomLock = () => { const c = S.settings.voting?.nominations_close; return c ? new Date(c) : null; };
  const nominationsLocked = () => { const l = nomLock(); return !!l && Date.now() > l.getTime(); };
  const votingOpen = () => { const v = S.settings.voting || {}; if (v.open === false) return false; if (v.closes && Date.now() > new Date(v.closes).getTime()) return false; return true; };
  const isAdmin = () => !!S.profile?.is_admin;

  async function callFn(name, body) {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY, Authorization: `Bearer ${session?.access_token || CFG.SUPABASE_ANON_KEY}` },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.data = data; e.status = res.status; throw e; }
    return data;
  }

  // ---------- auth ----------
  const hsel = $("#signup-form select[name=household]");
  hsel.innerHTML = `<option value="">Choose…</option>` + CFG.HOUSEHOLDS.map((h) => `<option>${esc(h)}</option>`).join("");
  $$("[data-authtab]").forEach((b) => b.onclick = () => {
    $$("[data-authtab]").forEach((x) => x.classList.toggle("active", x === b));
    $("#signin-form").hidden = b.dataset.authtab !== "signin";
    $("#signup-form").hidden = b.dataset.authtab !== "signup";
    $("#auth-msg").hidden = true;
  });
  function authMsg(m, ok) { const el = $("#auth-msg"); el.textContent = m; el.className = "msg " + (ok ? "ok" : ""); el.hidden = false; }
  $("#signin-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector("button"); btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    btn.disabled = false;
    if (error) authMsg(/invalid/i.test(error.message) ? "Email or password doesn't match. (No account yet? Use Create account.)" : error.message);
  };
  $("#signup-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector("button"); btn.disabled = true;
    try {
      await callFn("signup", Object.fromEntries(f.entries()));
      const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
      if (error) authMsg("Account created. Now sign in.", true);
    } catch (err) { authMsg(err.message); }
    btn.disabled = false;
  };
  $("#signout").onclick = () => sb.auth.signOut();

  sb.auth.onAuthStateChange((_evt, session) => {
    S.session = session;
    if (session) boot(); else showAuth();
  });

  function showAuth() {
    $("#auth").hidden = false; $("#app").hidden = true; $("#userchip").hidden = true;
    if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
  }

  // ---------- data ----------
  async function loadAll() {
    const [pr, o, d, p, v, st, av, fv, nm, sn] = await Promise.all([
      sb.from("profiles").select("*"),
      sb.from("origins").select("*").order("sort"),
      sb.from("destinations").select("*"),
      sb.from("properties").select("*").order("created_at", { ascending: false }),
      sb.from("votes").select("*"),
      sb.from("settings").select("*"),
      sb.from("availability").select("*").order("start_date"),
      sb.from("favorites").select("property_id"),
      sb.from("nominations").select("*"),
      sb.from("seen_properties").select("property_id"),
    ]);
    S.noms = nm.data || [];
    S.seen = new Set((sn.data || []).map((r) => r.property_id));
    S.avail = av.data || [];
    S.favs = new Set((fv.data || []).map((r) => r.property_id));
    S.profiles = pr.data || []; S.origins = o.data || []; S.dests = d.data || []; S.props = p.data || []; S.votes = v.data || [];
    S.settings = Object.fromEntries((st.data || []).map((r) => [r.key, r.value]));
    S.profile = S.profiles.find((x) => x.id === S.session.user.id) || null;
    S.dests.sort((a, b) => b.total - a.total);
  }

  let booted = false;
  async function boot() {
    await loadAll();
    if (!S.profile) { if (S.channel) { sb.removeChannel(S.channel); S.channel = null; } await sb.auth.signOut(); authMsg("That account no longer exists. Create a new one or ask Joseph."); return; }
    $("#auth").hidden = true; $("#app").hidden = false; $("#userchip").hidden = false;
    $("#user-name").textContent = `${S.profile.display_name} · ${S.profile.household}`;
    $("#admin-tab").hidden = !isAdmin();
    if (!booted) { booted = true; wireTabs(); wireForms(); }
    if (!S.channel) {
      let t;
      const refresh = () => { clearTimeout(t); t = setTimeout(async () => { if (!S.session) return; await loadAll(); renderAll(); }, 400); };
      S.channel = sb.channel("live").on("postgres_changes", { event: "*", schema: "public", table: "properties" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "destinations" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "votes" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "availability" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "nominations" }, refresh).subscribe();
    }
    renderAll();
    resumePendingAi();
  }

  function renderAll() {
    if (!S.session || !S.profile) return; // signed out, or an account that no longer exists
    renderMap(); renderDests(); renderLodging(); renderMine(); renderVote(); renderAvail(); renderRecs(); renderResults(); if (isAdmin()) renderAdmin();
  }

  // ---------- tabs ----------
  function wireTabs() {
    $$("#main-tabs .tab").forEach((b) => b.onclick = () => showTab(b.dataset.tab));
    const h = location.hash.replace("#", "");
    if (h && $(`[data-tab="${h}"]`)) showTab(h);
  }
  function showTab(name) {
    S.tab = name;
    $$("#main-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".panel").forEach((p) => p.hidden = p.dataset.panel !== name);
    history.replaceState(null, "", "#" + name);
    if (name === "map" && S.map) setTimeout(() => { S.map.invalidateSize(); fitMapOnce(); }, 60);
  }

  // ---------- map ----------
  function ensureMap() {
    if (S.map) return;
    S.map = L.map("map", { scrollWheelZoom: false }).setView([38.5, -96.5], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 18 }).addTo(S.map);
    S.layers.origins = L.layerGroup().addTo(S.map);
    S.layers.dests = L.layerGroup().addTo(S.map);
    S.layers.props = L.layerGroup().addTo(S.map);
    S.layers.lines = L.layerGroup().addTo(S.map);
  }
  /** Fit the map to every pin, but only once the map box actually has a size (a hidden tab measures 0×0 and the fit collapses onto one pin). */
  function fitMapOnce() {
    if (S.mapFitted || !S.map || !S.dests.length) return;
    const el = $("#map"); if (!el.offsetWidth || !el.offsetHeight) return;
    S.map.invalidateSize();
    const pts = [...S.dests.map((d) => [d.lat, d.lng]), ...S.origins.map((o) => [o.lat, o.lng])];
    S.map.fitBounds(pts, { padding: [30, 30], maxZoom: 5 }); S.mapFitted = true;
  }
  function renderMap() {
    ensureMap();
    const { origins, dests, props, lines } = S.layers;
    origins.clearLayers(); dests.clearLayers(); props.clearLayers();
    S.origins.forEach((o) => {
      L.marker([o.lat, o.lng], { icon: L.divIcon({ className: "", html: `<div class="home-marker">🏠 ${esc(o.label)}</div>`, iconAnchor: [0, 10] }), zIndexOffset: -100 }).addTo(origins);
    });
    S.dests.forEach((d) => {
      const size = d.status !== "scored" ? 34 : 30 + Math.round((d.total / 100) * 26);
      const cls = d.status !== "scored" ? "pending" : (d.gate_pass ? "" : "nogate");
      const m = L.marker([d.lat, d.lng], { icon: L.divIcon({ className: "", html: `<div class="dest-marker ${cls}" style="width:${size}px;height:${size}px">${d.status === "scored" ? d.total : "…"}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), zIndexOffset: 500 + (d.total || 0) * 10 });
      const n = S.props.filter((p) => p.destination_id === d.id).length;
      const nf = S.props.filter((p) => p.destination_id === d.id && p.is_finalist).length;
      m.bindPopup(`<b>${esc(d.name)}</b><br>${esc(d.region)} · <b>${d.total}</b>/100<br>${n} lodging added · ${nf} on the ballot<br><a href="#" data-open-dest="${d.id}">Full scorecard →</a>`);
      m.on("click", () => selectDest(d));
      m.addTo(dests);
    });
    fitMapOnce();
    S.props.forEach((p) => {
      if (p.lat == null) return;
      const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<div class="prop-marker ${p.is_finalist ? "finalist" : ""}" style="width:16px;height:16px"></div>`, iconSize: [16, 16], iconAnchor: [8, 16] }), zIndexOffset: 300 });
      m.bindPopup(`<b>${esc(p.title)}</b>${p.ai_pick ? " · AI Selected" : ""}<br>${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA · ${p.status === "scored" ? `<b>${p.total}</b>/100` : "scoring…"}${p.is_finalist ? " · ★ finalist" : ""}<br><a href="#" data-open-prop="${p.id}">Details →</a>`);
      m.addTo(props);
    });
    if (S.selectedDest) { const d = S.dests.find((x) => x.id === S.selectedDest.id); if (d) selectDest(d); else { lines.clearLayers(); $("#map-info").innerHTML = ""; } }
    renderLanding();
  }
  function renderLanding() {
    $("#landing-dests").innerHTML = S.dests.length ? S.dests.map((d, i) => {
      const fin = S.props.filter((p) => p.destination_id === d.id && p.is_finalist).length;
      const n = S.props.filter((p) => p.destination_id === d.id).length;
      return `<div class="rank-row"><div class="n">${i + 1}</div>
        <div><div class="t"><a href="#" data-open-dest="${d.id}">${esc(d.name)}</a>${d.gate_pass ? "" : ' <i class="pill warn">gate ✗</i>'}${d.elevation_ft > maxElev() ? ' <i class="pill warn">⛰ too high</i>' : ""}</div>
        <div class="s">${esc(d.region)} · ${fin ? `<i class="pill ok">on the ballot</i> ${fin} finalist${fin > 1 ? "s" : ""}` : n ? `${n} house${n > 1 ? "s" : ""} added, none starred` : "no house yet"}</div></div>
        <div class="sc">${d.total}<small>/100</small></div></div>`;
    }).join("") : `<p class="empty">Nothing yet.</p>`;
    const top = S.props.filter((p) => p.status === "scored" && !isDq(p)).sort((a, b) => b.total - a.total).slice(0, 5);
    $("#landing-props").innerHTML = top.length ? top.map((p, i) => `<div class="rank-row"><div class="n">${i + 1}</div>
        <div><div class="t"><a href="#" data-open-prop="${p.id}">${esc(p.title)}</a>${p.ai_pick ? ' <i class="pill ai">AI Selected</i>' : ""}${p.is_finalist ? ' <i class="pill sun">★</i>' : ""}${p.gate_pass ? "" : ' <i class="pill warn">bed plan ✗</i>'} ${newBadge(p)}</div>
        <div class="s">${esc(destOf(p)?.name || p.city || "")} · ${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA${p.price_night ? " · " + money(p.price_night) + "/night" : ""}</div></div>
        <div class="sc">${p.total}<small>/100</small></div></div>`).join("") : `<p class="empty">No houses scored yet. Add one on the My picks tab.</p>`;
  }
  function selectDest(d) {
    S.selectedDest = d;
    const { lines } = S.layers; lines.clearLayers();
    S.origins.forEach((o) => {
      const t = d.travel?.[o.key];
      const diff = t?.difficulty || 5;
      const color = diff <= 3 ? "#2f9e63" : diff <= 5 ? "#e0a437" : diff <= 7 ? "#ef7c2a" : "#d23f3f";
      L.polyline([[o.lat, o.lng], [d.lat, d.lng]], { color, weight: 3, opacity: .75, dashArray: t?.nonstop === false ? "6 6" : null }).addTo(lines)
        .bindTooltip(`${o.label}: ${t ? t.hours + " h · " + t.route : "?"}`, { sticky: true });
    });
    $("#map-info").innerHTML = `<div class="card"><div class="title-row"><h3>${esc(d.name)} <span class="muted" style="font-weight:400;font-size:.9rem">${esc(d.region)} · ${d.total}/100</span></h3>
      <button class="btn small" data-open-dest="${d.id}">Full scorecard</button></div>
      ${travelTable(d)}<p class="tiny muted">Solid line = nonstop flight or drive; dashed = a connection. Hours are door to door.</p></div>`;
  }
  function travelTable(d) {
    return `<table class="travel-table"><tr><th>From</th><th>Difficulty</th><th>Hours</th><th>Route</th></tr>` +
      S.origins.map((o) => { const t = d.travel?.[o.key]; return `<tr><td>${esc(o.label)}</td><td>${t ? diffPill(t.difficulty, t.difficulty + "/10") : "—"}</td><td>${t ? t.hours : ""}</td><td>${t ? esc(t.route) + (t.notes ? ` <span class="muted">— ${esc(t.notes)}</span>` : "") : ""}</td></tr>`; }).join("") + `</table>`;
  }

  // ---------- destinations ----------
  function ballotLine(d) {
    const ps = S.props.filter((p) => p.destination_id === d.id);
    const fin = ps.filter((p) => p.is_finalist);
    if (fin.length) return `<div class="ballot-line"><i class="pill ok">On the ballot</i> ${fin.length} finalist house${fin.length > 1 ? "s" : ""} · ${ps.length} added</div>`;
    if (ps.length) return `<div class="ballot-line"><i class="pill sun">Not on the ballot yet</i> ${ps.length} house${ps.length > 1 ? "s" : ""} added, none starred as a finalist</div>`;
    return `<div class="ballot-line"><i class="pill neutral">Not on the ballot</i> No house added here yet, so it can't be voted on</div>`;
  }
  function scoreBars(scores, criteria, withWhy) {
    const crit = scores?.elevation ? [...criteria, ["elevation", "Elevation penalty", 0]] : criteria;
    return `<div class="bars">` + crit.map(([k, label, max]) => {
      if (k === "elevation") { const s = scores.elevation; return `<div style="color:var(--d9)">${esc(label)}</div><div></div><div style="color:var(--d9);font-weight:700">${s.score}</div>` + (withWhy && s.why ? `<div class="why">${esc(s.why)}</div>` : ""); }
      const s = scores?.[k] || {}; const v = Number(s.score) || 0;
      return `<div>${esc(label)}</div><div class="bar"><i class="${k === "lodging" || k === "bedrooms" ? "gate" : ""}" style="width:${(v / max) * 100}%"></i></div><div>${v}/${max}</div>` + (withWhy && s.why ? `<div class="why">${esc(s.why)}</div>` : "");
    }).join("") + `</div>`;
  }
  function renderDests() {
    const el = $("#dest-list");
    if (!S.dests.length) { el.innerHTML = `<p class="empty">No destinations yet.</p>`; return; }
    el.innerHTML = S.dests.map((d, i) => `<div class="card dest-card">
      <div class="score-badge ${d.gate_pass ? "" : "low"}">${d.total}<small>/100</small></div>
      <div>
        <div class="title-row"><h3>#${i + 1} ${esc(d.name)}</h3><span class="muted">${esc(d.region)}${d.source === "packet" ? " · from the packet" : ""} ${elevPill(d.elevation_ft)}</span></div>
        ${d.gate_pass ? "" : `<p class="msg" style="display:inline-block">Fails the lodging gate (under 10/25)</p>`}
        <p>${esc(d.summary || "")}</p>
        ${scoreBars(d.scores, DEST_CRITERIA, false)}
        <div class="travel-row">Travel: ${S.origins.map((o) => { const t = d.travel?.[o.key]; return `<span title="${esc(o.label)}: ${t ? t.hours + " h, " + t.route : "?"}">${esc(o.label.split(",")[0])} ${t ? diffPill(t.difficulty) : ""}</span>`; }).join("")}</div>
        <details class="travel-detail"><summary>Travel difficulty by household: hours and route</summary>${travelTable(d)}</details>
        ${ballotLine(d)}
        <div class="actions"><button class="btn small" data-open-dest="${d.id}">Scorecard, travel &amp; things to do</button><button class="btn small ghost" data-goto-lodging="${d.id}">See lodging</button></div>
      </div></div>`).join("");
  }
  function destModal(d) {
    const ps = S.props.filter((p) => p.destination_id === d.id).sort((a, b) => b.total - a.total);
    openModal(`<h2>${esc(d.name)}</h2><p class="muted">${esc(d.region)} · <b>${d.total}/100</b>${d.gate_pass ? "" : " · fails the lodging gate"} ${elevPill(d.elevation_ft)}</p>
      ${d.elevation_ft > maxElev() ? `<p class="msg">Elevation ${d.elevation_ft.toLocaleString()} ft is above the family's ${maxElev().toLocaleString()} ft health limit. Sleeping this high is a problem for some of us; day trips higher are fine.</p>` : ""}
      <p>${esc(d.summary || "")}</p>
      <div class="row"><div><div class="section-title">Why it might win</div><ul class="list">${(d.pros || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div><div class="section-title">Why it might lose</div><ul class="list">${(d.cons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
      <div class="section-title">Scorecard</div>${scoreBars(d.scores, DEST_CRITERIA, true)}
      <div class="section-title">Getting there from each home</div>${travelTable(d)}
      <div class="section-title">Things to do, rated for our crew</div>
      ${(d.attractions || []).map((a) => `<div class="attr"><div><b>${esc(a.name)}</b> <span class="cat">${esc(a.category)} · ${esc(a.ages)}</span><br><span class="muted">${esc(a.why)}</span></div><div>${stars(a.rating)}</div></div>`).join("") || `<p class="empty">None listed.</p>`}
      <div class="section-title">Lodging added here (${ps.length})</div>
      ${ps.length ? ps.map((p) => `<div class="attr"><div><b>${esc(p.title)}</b>${p.ai_pick ? ' <i class="pill ai">AI Selected</i>' : ""}${p.is_finalist ? ' <i class="pill sun">★ finalist</i>' : ""}<br><span class="muted">${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA · sleeps ${p.sleeps ?? "?"}${p.price_night ? " · " + money(p.price_night) + "/night" : ""}</span></div><div><button class="btn small" data-open-prop="${p.id}">${p.status === "scored" ? p.total + "/100" : "scoring…"}</button></div></div>`).join("") : `<p class="empty">Nobody has added a house here yet. Add one on the My picks tab.</p>`}
      ${isAdmin() ? `<div class="actions"><button class="btn small" data-rescore-dest="${d.id}">Re-run AI scoring</button><button class="btn small danger" data-del-dest="${d.id}">Delete destination</button></div>` : ""}`);
  }

  // ---------- highlights (amenities at a glance) ----------
  const HL_ICONS = [[/arcade|game ?room|pool table|air hockey|foosball|ping ?pong|billiard/i, "🕹️"], [/indoor.*pool|pool.*indoor/i, "🏊"], [/pool|swim spa/i, "🏊"], [/hot ?tub|spa\b|jacuzzi/i, "♨️"], [/theater|theatre|cinema|movie/i, "🎬"], [/kitchen/i, "🍳"], [/fire ?pit|fireplace/i, "🔥"], [/lake|river|beach|ocean|water(front)?\b/i, "🌊"], [/view/i, "🏔️"], [/park(ing)?|garage|cars/i, "🚗"], [/crib|pack.?n.?play|high ?chair|toddler|baby/i, "👶"], [/bunk/i, "🛏️"], [/gym|fitness/i, "🏋️"], [/pickleball|tennis|basketball|court|golf|slide|playground|trampoline|zip/i, "🏀"], [/sauna|steam/i, "🧖"], [/washer|dryer|laundry/i, "🧺"], [/pet|dog/i, "🐾"], [/wifi|internet|workspace/i, "📶"], [/deck|patio|porch|balcony|yard|grill|bbq/i, "🌿"], [/elevator|accessib/i, "♿"], [/ev charg/i, "🔌"]];
  const HL_DERIVE = [[/indoor (heated )?pool|private indoor pool/i, "Indoor pool"], [/outdoor pool|private pool|heated pool|swim spa|resort pool|pool access|pool table(?!)/i, "Pool"], [/hot ?tub|jacuzzi|spillover spa/i, "Hot tub"], [/game ?room|arcade/i, "Game room"], [/pool table|billiard/i, "Pool table"], [/air hockey|foosball|ping ?pong|shuffleboard/i, "Arcade games"], [/theater|theatre|cinema|movie room/i, "Theater"], [/fire ?pit/i, "Fire pit"], [/two kitchens|2 kitchens|second kitchen|chef'?s kitchens/i, "2 kitchens"], [/lake(front| access| view)/i, "Lake access"], [/river(front| access)/i, "River access"], [/beach|oceanfront|ocean view/i, "Beach / ocean"], [/mountain view/i, "Mountain views"], [/fenced/i, "Fenced yard"], [/playground/i, "Playground"], [/pickleball/i, "Pickleball"], [/basketball/i, "Basketball court"], [/sauna/i, "Sauna"], [/gym|fitness/i, "Gym"], [/crib|pack.?n.?play/i, "Crib available"], [/high ?chair/i, "High chair"], [/bunk/i, "Bunk room"], [/pet friendly|pets allowed|dog friendly/i, "Pet friendly"], [/ev charg/i, "EV charger"], [/washer/i, "Washer & dryer"], [/elevator/i, "Elevator"], [/water ?park|lazy river|splash/i, "Water park access"], [/trampoline/i, "Trampoline"], [/zip ?line/i, "Zip line"], [/slide/i, "Slide"], [/golf/i, "Golf nearby"]];
  function highlightsFor(p) {
    const det = p.details || {};
    let hl = Array.isArray(det.highlights) && det.highlights.length ? det.highlights.slice(0, 12) : [];
    if (!hl.length) {
      const set = new Set();
      if (det.indoor_pool) set.add("Indoor pool"); else if (det.outdoor_pool) set.add("Pool");
      if (det.hot_tub) set.add("Hot tub"); if (det.game_room) set.add("Game room"); if (det.theater) set.add("Theater");
      const text = [p.description || "", det.kitchen_notes || "", det.parking || "", p.ai_summary || ""].join(" \n ");
      HL_DERIVE.forEach(([re, label]) => { if (re.test(text) && !(label === "Pool" && set.has("Indoor pool"))) set.add(label); });
      if (p.bathrooms >= 6) set.add(`${p.bathrooms} baths`);
      hl = Array.from(set).slice(0, 12);
    }
    return hl;
  }
  const chip = (h) => { const ic = (HL_ICONS.find(([re]) => re.test(h)) || [null, "✓"])[1]; return `<span class="chip">${ic} ${esc(h)}</span>`; };
  const highlightsHtml = (p, max) => { const hl = highlightsFor(p); return hl.length ? `<div class="chips">${hl.slice(0, max || 12).map(chip).join("")}</div>` : ""; };

  // ---------- lodging ----------
  function propCard(p, mine) {
    const d = destOf(p);
    const pending = p.status !== "scored";
    return `<div class="card prop-card ${isDq(p) ? "dq" : ""}" data-open-prop="${p.id}">
      <div class="thumb" style="${(p.photos?.[0] || p.image_url) ? `background-image:url('${esc(p.photos?.[0] || p.image_url)}')` : ""}"></div>
      ${favBtn(p, "card-fav")}
      ${isNew(p) ? `<span class="new-tag">New</span>` : ""}
      ${p.is_finalist ? `<span class="star">★ On the ballot${nomsFor(p.id).length > 1 ? ` ×${nomsFor(p.id).length}` : ""}</span>` : p.ai_pick ? `<span class="star" style="background:#5b3fa8;color:#fff">AI Selected</span>` : aiMatchFor(p) ? `<span class="star" style="background:#1f7a8c;color:#fff">Matches AI Selected</span>` : ""}
      ${pending ? `<i class="pill neutral badge">scoring…</i>` : (p.gate_pass ? `<i class="pill ok badge">Sleeps us right ✓</i>` : `<i class="pill warn badge">Bed plan short ✗</i>`)}
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">${esc(d?.name || p.city)} · ${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA · sleeps ${p.sleeps ?? "?"}</div>
        ${isDq(p) || p.avail_status === "available" || p.elevation_ft > maxElev() ? `<div class="meta">${availBadge(p, true)} ${p.elevation_ft > maxElev() ? elevPill(p.elevation_ft) : ""}</div>` : ""}
        ${S.avail.some((a) => a.property_id === p.id) ? strip(p) : ""}
        ${highlightsHtml(p, 3)}
        <div class="foot"><span class="meta">${p.price_night ? money(p.price_night) + "/night" : ""}${p.price_total ? " · " + money(p.price_total) + " week" : ""}</span>
        <span class="mini-score">${pending ? "…" : p.total}<small>/100</small></span></div>
      </div></div>`;
  }
  function renderLodging() {
    const sel = $("#lodging-filter");
    const cur = sel.value;
    sel.innerHTML = `<option value="">All destinations</option>` + S.dests.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
    sel.value = S.filter || cur || "";
    let list = S.props.filter((p) => !S.filter || p.destination_id === S.filter);
    if ($("#lodging-favs").checked) list = list.filter(isFav);
    if ($("#lodging-new").checked) list = list.filter(isNew);
    $("#lodging-new-count").textContent = newCount() ? `(${newCount()})` : "";
    const tab = $('[data-tab="lodging"]'); if (tab) tab.innerHTML = newCount() ? `Lodging <span class="tabdot">${newCount()}</span>` : "Lodging";
    $("#lodging-favs-count").textContent = S.favs.size ? `(${S.favs.size})` : "";
    const sort = $("#lodging-sort").value;
    list = list.slice().sort((a, b) => (isDq(a) - isDq(b)) || (sort === "price" ? (a.price_night || 1e9) - (b.price_night || 1e9) : sort === "bedrooms" ? (b.bedrooms || 0) - (a.bedrooms || 0) : sort === "newest" ? new Date(b.created_at) - new Date(a.created_at) : b.total - a.total));
    $("#lodging-list").innerHTML = list.length ? list.map((p) => propCard(p)).join("") : ($("#lodging-favs").checked ? `<p class="empty">No favorites yet. Tap the ♡ on any house to save it here.</p>` : `<p class="empty">No houses yet. Be the first: paste a link on the My picks tab.</p>`);
  }
  $("#lodging-filter").onchange = (e) => { S.filter = e.target.value; renderLodging(); };
  $("#lodging-favs").onchange = renderLodging;
  $("#lodging-new").onchange = renderLodging;
  $("#lodging-sort").onchange = renderLodging;

  function propModal(p) {
    markSeen(p);
    const d = destOf(p);
    const mine = !p.ai_pick && (p.submitted_by === S.session.user.id || (householdOf(p.submitted_by) && householdOf(p.submitted_by) === S.profile.household));
    const det = p.details || {};
    const flags = [det.indoor_pool && "Indoor pool", det.outdoor_pool && "Outdoor pool", det.hot_tub && "Hot tub", det.game_room && "Game room", det.theater && "Theater"].filter(Boolean);
    const photos = (p.photos && p.photos.length ? p.photos : (p.image_url ? [p.image_url] : []));
    openModal(`${photos.length ? `<img class="hero" id="hero-img" src="${esc(photos[0])}" alt="" referrerpolicy="no-referrer">` : ""}
      ${photos.length > 1 ? `<div class="gallery">${photos.map((u, i) => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-hero="${esc(u)}" class="${i === 0 ? "on" : ""}">`).join("")}</div>` : ""}
      <h2>${esc(p.title)} ${favBtn(p, "inline")}</h2>
      <p class="muted">${esc(d?.name || "")} · ${esc(p.city || "")}, ${esc(p.state || "")}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">Open the listing ↗</a>` : ""}</p>
      ${highlightsFor(p).length ? `<div class="section-title" style="margin-top:.4em">Highlights</div>${highlightsHtml(p)}` : ""}
      <div class="kv">
        ${p.elevation_ft != null ? `<b>Elevation</b><span>${p.elevation_ft.toLocaleString()} ft ${p.elevation_ft > maxElev() ? `<i class="pill warn">above our ${maxElev().toLocaleString()} ft health limit</i>` : ""}</span>` : ""}
        <b>Bedrooms</b><span>${p.bedrooms ?? "?"} listed${det.real_bedrooms != null && det.real_bedrooms !== p.bedrooms ? ` · scorer thinks ${det.real_bedrooms} are real` : ""}</span>
        <b>Bathrooms</b><span>${p.bathrooms ?? "?"}</span>
        <b>Sleeps</b><span>${p.sleeps ?? "?"}</span>
        <b>Price</b><span>${p.price_night ? money(p.price_night) + " / night" : "not given"}${p.price_total ? " · " + money(p.price_total) + " for the week" : ""}</span>
        ${p.rating ? `<b>Reviews</b><span>★ ${p.rating}${p.review_count ? ` (${p.review_count})` : ""}</span>` : ""}
        ${flags.length ? `<b>Has</b><span>${flags.join(" · ")}</span>` : ""}
        ${det.parking ? `<b>Parking</b><span>${esc(det.parking)}</span>` : ""}
        ${det.kitchen_notes ? `<b>Kitchen</b><span>${esc(det.kitchen_notes)}</span>` : ""}
        ${det.toddler_notes ? `<b>Little kids</b><span>${esc(det.toddler_notes)}</span>` : ""}
      </div>
      ${p.status === "scored" ? `
        <div class="section-title">Score: ${p.total}/100 ${p.gate_pass ? '<i class="pill ok">5 couple rooms + 2 kids\' rooms ✓</i>' : '<i class="pill warn">Bed plan doesn\'t cover us</i>'}</div>
        <p>${esc(p.ai_summary || "")}</p>
        ${det.bed_plan ? `<p><b>Sleeping plan:</b> ${det.couple_rooms ?? "?"} couple room${det.couple_rooms === 1 ? "" : "s"} · ${det.kid_rooms ?? "?"} kids' room${det.kid_rooms === 1 ? "" : "s"}. ${esc(det.bed_plan)}</p>` : ""}
        ${scoreBars(p.scores, PROP_CRITERIA, true)}
        ${(p.red_flags || []).length ? `<div class="section-title">Red flags</div><ul class="list">${p.red_flags.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${(p.verify_checklist || []).length ? `<div class="section-title">Confirm in writing before any deposit</div><ul class="list">${p.verify_checklist.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ` : `<p class="msg info">Still being scored. This usually takes under a minute; the page updates by itself.</p>`}
      <div class="section-title">Availability for ${esc(tripWeek())} ${availBadge(p)}</div>
      ${p.avail_status !== "unknown" ? `<p class="tiny muted">Marked by ${esc(nameOf(p.avail_by) || "someone")} ${fmtDateTime(p.avail_at)}${p.avail_note ? `: ${esc(p.avail_note)}` : ""}</p>` : `<p class="tiny muted">Nobody has checked the host's calendar yet. The site can't read availability from the listing sites; a person has to look and mark it here.</p>`}
      <div class="actions">
        ${p.avail_status !== "available" ? `<button class="btn small" data-avail="${p.id}" data-status="available">✓ I checked: available for our week</button>` : ""}
        ${!isDq(p) ? `<button class="btn small danger" data-avail="${p.id}" data-status="unavailable">✗ Not available: disqualify</button>` : `<button class="btn small" data-avail="${p.id}" data-status="unknown">Undo disqualification</button>`}
      </div>
      ${availSection(p)}
      <div class="section-title">Ballot ${nomsFor(p.id).length ? nomPills(p) : '<i class="pill neutral">not nominated yet</i>'}</div>
      <div class="actions">${p.status === "scored" && !isDq(p) ? `<button class="btn ${nominatedByMe(p.id) ? "" : "primary"} small" data-star="${p.id}" ${nominationsLocked() ? "disabled" : ""}>${nominatedByMe(p.id) ? "Withdraw my household's nomination" : "★ Nominate for my household"}</button>` : ""}<span class="muted tiny" style="align-self:center">Each household gets ${S.settings.voting?.max_finalists_per_household ?? 2} nominations. A house nominated by several households is on the ballot once.</span></div>
      ${p.ai_pick ? `<div class="section-title">Why Claude recommends it <i class="pill ai">AI Selected</i></div><p>${esc(p.ai_note || "")}</p>` : ""}
      ${!p.ai_pick && aiMatchFor(p) ? `<p class="msg ok"><i class="pill match">Matches an AI Selected house</i> Claude independently recommended this same house. <a href="#" data-open-prop="${aiMatchFor(p).id}">See its note</a>.</p>` : ""}
      ${p.notes ? `<div class="section-title">Notes from whoever added it</div><p>${esc(p.notes)}</p>` : ""}
      ${p.description ? `<details class="quiet"><summary>Listing description</summary><p>${esc(p.description)}</p></details>` : ""}
      <details class="quiet"><summary>More</summary>Added ${fmtDate(p.created_at)}${p.submitted_by ? ` by ${esc(nameOf(p.submitted_by))} (${esc(householdOf(p.submitted_by))})` : p.ai_pick ? " by Claude (AI Selected)" : " from the decision packet"}.</details>
      ${mine || isAdmin() || p.ai_pick ? `<div class="actions">
        ${p.url ? `<button class="btn small" data-photos="${p.id}">${photos.length ? "Refresh photos" : "Get photos from the listing"}</button>` : ""}
        ${mine || isAdmin() ? `<button class="btn small" data-rescore-prop="${p.id}">Re-run scoring</button>` : ""}
        ${(mine || isAdmin()) && p.url && p.source !== "airbnb" && p.source !== "vrbo" ? `<button class="btn small" data-rescore-prop="${p.id}" data-reread="1">Re-read the whole website &amp; re-score</button>` : ""}
        ${mine || isAdmin() ? `<button class="btn small" data-edit-prop="${p.id}">Edit details</button>
        <button class="btn small danger" data-del-prop="${p.id}">Delete</button>` : ""}</div>` : ""}`);
  }

  // ---------- my picks ----------
  function renderMine() {
    const hh = S.profile.household;
    const mine = S.props.filter((p) => householdOf(p.submitted_by) === hh);
    const fin = myNoms().map((n) => S.props.find((p) => p.id === n.property_id)).filter(Boolean);
    const cap = S.settings.voting?.max_finalists_per_household ?? 2;
    const lock = nomLock();
    const lockLine = lock ? (nominationsLocked() ? `<br><span class="pill warn">Nominations closed ${fmtDateTime(lock)}</span> <span class="muted">The ballot is set. You can still vote.</span>` : `<br><span class="muted tiny">Add houses and set your finalists by <b>${fmtDateTime(lock)}</b>. After that the ballot is locked and voting runs until ${fmtDateTime(S.settings.voting?.closes)}.</span>`) : "";
    const favPool = S.props.filter((p) => isFav(p) && p.status === "scored" && !isDq(p) && !nominatedByMe(p.id));
    $("#finalist-meter").innerHTML = `<b>${esc(hh)}</b> · ${mine.length} house${mine.length === 1 ? "" : "s"} added · <b>${fin.length} of ${cap}</b> nominations ${fin.length < cap ? `<span class="muted">— nominate ${cap - fin.length} more (any house on the site: yours, an AI pick, or another family's find)</span>` : `<span class="muted">— all set</span>`}${lockLine}
      <div class="nom-list">${fin.length ? fin.map((p) => `<div class="win-row"><i class="pill sun">★</i><span><a href="#" data-open-prop="${p.id}">${esc(p.title)}</a> <span class="muted tiny">${esc(destOf(p)?.name || "")} · ${p.total}/100${nomsFor(p.id).length > 1 ? ` · also nominated by ${nomsFor(p.id).filter((n) => n.household !== hh).map((n) => esc(n.household.split(",")[0])).join(", ")}` : ""}</span></span><button class="btn small ghost" data-star="${p.id}" ${nominationsLocked() ? "disabled" : ""}>Withdraw</button></div>`).join("") : `<p class="empty">No nominations yet.</p>`}</div>
      ${fin.length < cap && !nominationsLocked() ? `<div class="actions"><button class="btn small" id="spin-nom" ${favPool.length ? "" : "disabled"} title="${favPool.length ? "" : "Save some favorites first (the ♡ on any house)"}">🎲 Can't decide? Spin ${cap - fin.length === 1 ? "one" : "two"} of my ${favPool.length} favorite${favPool.length === 1 ? "" : "s"}</button></div>` : ""}`;
    const spin = $("#spin-nom");
    if (spin) spin.onclick = () => roulette(favPool, cap - fin.length, "Nominate", async (picked) => { for (const p of picked) await nominate(p.id, true); toast(`Nominated: ${picked.map((p) => p.title).join(" and ")}.`, 6000); });
    $$("#preview-form button, #submit-form button, form.nominate-form button, [data-adopt]").forEach((b) => { if (nominationsLocked()) { b.disabled = true; b.title = "Nominations are closed"; } });
    $("#mine-list").innerHTML = (mine.length ? `<h3 style="margin:.6em 0 .3em">Houses my household added</h3>` : "") + (mine.length ? mine.map((p) => `<div class="card mine-item">
      <div><div class="title" style="font-weight:600"><a href="#" data-open-prop="${p.id}">${esc(p.title)}</a></div>
      <div class="meta muted tiny">${esc(destOf(p)?.name || p.city)} · ${p.bedrooms ?? "?"} BR · ${p.status === "scored" ? p.total + "/100" : "scoring…"} ${p.status === "scored" && !p.gate_pass ? '· <i class="pill warn">bed plan ✗</i>' : ""} ${availBadge(p, true)} · added by ${esc(nameOf(p.submitted_by))}</div></div>
      <div class="actions">${favBtn(p, "inline")}<button class="star-btn ${nominatedByMe(p.id) ? "on" : ""}" data-star="${p.id}" ${p.status !== "scored" || nominationsLocked() ? "disabled" : ""}>${nominatedByMe(p.id) ? "★ Nominated" : "☆ Nominate"}</button></div>
    </div>`).join("") : `<p class="empty">Your household hasn't added a house yet. You can still nominate any house on the Lodging or AI Selected tabs.</p>`);
  }

  // ---------- roulette ----------
  function roulette(pool, count, verb, onDone) {
    if (!pool.length) return;
    const n = Math.min(count, pool.length);
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, n);
    openModal(`<h2>🎲 Spinning…</h2><p class="muted">Picking ${n} at random from ${pool.length}.</p><div id="wheel" class="wheel"></div><div id="wheel-result" hidden></div>`);
    const wheel = $("#wheel"); let ticks = 0;
    const iv = setInterval(() => {
      const r = pool[Math.floor(Math.random() * pool.length)];
      wheel.innerHTML = `<div class="wheel-item">${esc(r.title)}<br><span class="muted tiny">${esc(destOf(r)?.name || "")} · ${r.total}/100</span></div>`;
      if (++ticks > 18) {
        clearInterval(iv);
        wheel.innerHTML = picked.map((p) => `<div class="wheel-item on">${esc(p.title)}<br><span class="muted tiny">${esc(destOf(p)?.name || "")} · ${p.total}/100</span></div>`).join("");
        const res = $("#wheel-result"); res.hidden = false;
        res.innerHTML = `<div class="actions" style="margin-top:1em"><button class="btn primary" id="wheel-ok">${esc(verb)} ${n === 1 ? "this one" : "these"}</button><button class="btn" id="wheel-again">Spin again</button><button class="btn ghost" id="wheel-cancel">Cancel</button></div>`;
        $("#wheel-ok").onclick = async () => { closeModal(); await onDone(picked); };
        $("#wheel-again").onclick = () => roulette(pool, count, verb, onDone);
        $("#wheel-cancel").onclick = closeModal;
      }
    }, 110);
  }

  const nomsFor = (pid) => S.noms.filter((n) => n.property_id === pid);
  const myNoms = () => S.noms.filter((n) => n.household === S.profile.household);
  const nominatedByMe = (pid) => myNoms().some((n) => n.property_id === pid);
  const nomPills = (p) => nomsFor(p.id).map((n) => `<i class="pill sun" title="Nominated by ${esc(n.household)}">★ ${esc(n.household.split(",")[0])}</i>`).join(" ");
  async function nominate(pid, quiet) {
    const p = S.props.find((x) => x.id === pid); if (!p) return false;
    if (isDq(p)) { toast("This house is marked not available for our week, so it can't be nominated.", 6000); return false; }
    if (!quiet && p.avail_status === "unknown" && !confirm(`Nobody has confirmed this house is available for ${tripWeek()}. Nominate it anyway? (Please check the host's calendar soon and mark it in the house details.)`)) return false;
    const { error } = await sb.from("nominations").insert({ household: S.profile.household, property_id: pid, nominated_by: S.session.user.id });
    if (error) {
      if (/finalist_cap/.test(error.message)) toast("Your household already has its two nominations. Withdraw one first.", 5000);
      else if (/nominations_locked/.test(error.message)) toast("Nominations are closed; the ballot is set.", 4500);
      else if (/disqualified/.test(error.message)) toast("This house is disqualified (not available).", 4500);
      else if (/duplicate key/.test(error.message)) toast("Your household already nominated this house.", 4000);
      else toast(error.message, 5000);
      return false;
    }
    if (!quiet) toast(nomsFor(pid).length ? "Nominated. Another household had it too; it stays on the ballot once." : "Nominated. It's on the ballot for the whole family.");
    await loadAll(); renderAll(); return true;
  }
  async function withdraw(pid) {
    const { error } = await sb.from("nominations").delete().eq("household", S.profile.household).eq("property_id", pid);
    if (error) { toast(/nominations_locked/.test(error.message) ? "Nominations are closed; the ballot is set." : error.message, 5000); return; }
    toast("Withdrawn."); await loadAll(); renderAll();
  }
  async function toggleFinalist(id) {
    if (nominatedByMe(id)) return withdraw(id);
    return nominate(id);
  }
  async function toggleFinalistLegacy(id) {
    const p = S.props.find((x) => x.id === id);
    if (!p.is_finalist && isDq(p)) { toast("This house is marked not available for our week, so it can't be a finalist. Undo that in its details if it's wrong.", 6000); return; }
    if (!p.is_finalist && p.avail_status === "unknown" && !confirm(`Nobody has confirmed this house is available for ${tripWeek()}. Star it anyway? (Please check the host's calendar soon and mark it in the house details.)`)) return;
    const { error } = await sb.from("properties").update({ is_finalist: !p.is_finalist }).eq("id", id);
    if (error) {
      if (/finalist_cap/.test(error.message)) toast("Your household already has its two finalists. Un-star one first.", 4500);
      else if (/nominations_locked/.test(error.message)) toast("Nominations are closed; the ballot is set.", 4500);
      else if (/disqualified/.test(error.message)) toast("This house is disqualified (not available).", 4500);
      else toast(error.message, 5000);
      return;
    }
    if (!p.is_finalist && !p.gate_pass) toast("Starred. Heads up: the scorer doesn't think the beds cover five couples plus two kids' rooms.", 5500);
    await loadAll(); renderAll();
  }

  function wireForms() {
    // add-a-house flow
    const pf = $("#preview-form"), sf = $("#submit-form");
    const showSubmit = (pre) => {
      pf.hidden = true; sf.hidden = false;
      const note = $("#prefill-note");
      note.hidden = !pre?.note; note.textContent = pre?.note || "";
      sf.url.value = pre?.url || "";  // server hands back the cleaned-up link
      sf.dataset.prefillPhotos = JSON.stringify(pre?.photos || []); sf.image_url.value = pre?.image_url || ""; sf.description.value = pre?.description || "";
      sf.rating.value = pre?.rating ?? ""; sf.review_count.value = pre?.review_count ?? "";
      sf.title.value = pre?.title || ""; sf.city.value = pre?.city || ""; sf.state.value = pre?.state || "";
      sf.bedrooms.value = pre?.bedrooms ?? ""; sf.bathrooms.value = pre?.bathrooms ?? ""; sf.sleeps.value = pre?.sleeps ?? "";
      sf.price_night.value = pre?.price_night ?? ""; sf.price_total.value = pre?.price_total ?? ""; sf.notes.value = "";
      sf.dataset.editing = "";
      $("#submit-btn").textContent = "Save & score it";
      (pre?.title ? sf.city : sf.title).focus();
    };
    pf.onsubmit = async (e) => {
      e.preventDefault();
      const url = pf.url.value.trim();
      if (!url) { showSubmit({}); return; }
      const b = $("#preview-btn"); b.disabled = true; b.textContent = "Reading…";
      try {
        const { prefill } = await callFn("ingest", { action: "preview", url });
        showSubmit({ ...prefill, url: prefill.url || url });
        if (prefill.ok) toast("Got it. Check the details, add the price, then save.");
      } catch (err) { toast(err.message, 5000); showSubmit({ url, note: "We couldn't read that page. Fill in the details by hand." }); }
      b.disabled = false; b.textContent = "Read the listing";
    };
    $("#manual-btn").onclick = () => showSubmit({});
    $("#cancel-submit").onclick = () => { sf.hidden = true; pf.hidden = false; $("#submit-progress").hidden = true; };
    sf.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(sf).entries());
      const prog = $("#submit-progress"); prog.hidden = false;
      const btn = $("#submit-btn"); btn.disabled = true;
      const step = (html) => (prog.innerHTML = html);
      try {
        if (sf.dataset.editing) {
          step(`<span class="step active">Saving your changes</span>`);
          const upd = { title: f.title, city: f.city, state: f.state, bedrooms: f.bedrooms || null, bathrooms: f.bathrooms || null, sleeps: f.sleeps || null, price_night: f.price_night || null, price_total: f.price_total || null, notes: f.notes || null, status: "pending" };
          const { error } = await sb.from("properties").update(upd).eq("id", sf.dataset.editing);
          if (error) throw new Error(error.message);
          step(`<span class="step done">Saved</span><span class="step active">Re-scoring against the family rubric</span>`);
          await callFn("ingest", { action: "score", property_id: sf.dataset.editing });
          step(`<span class="step done">Saved</span><span class="step done">Re-scored</span>`);
        } else {
          step(`<span class="step active">Finding it on the map</span>`);
          const r = await callFn("ingest", { action: "submit", ...f, photos: JSON.parse(sf.dataset.prefillPhotos || "[]") });
          step(`<span class="step done">Placed in ${esc(r.destination.name)}${r.destination_created ? " (new destination, scored just now)" : ""}</span><span class="step active">Scoring the house against the family rubric (30–60 s)</span>`);
          await loadAll(); renderAll();
          await callFn("ingest", { action: "score", property_id: r.property.id });
          step(`<span class="step done">Placed in ${esc(r.destination.name)}</span><span class="step done">Scored</span>`);
          if (r.destination_created) prospectDestination(r.destination);
        }
        await loadAll(); renderAll();
        toast("Done. It's on the map and in the lodging list.");
        setTimeout(() => { sf.hidden = true; pf.hidden = false; pf.reset(); prog.hidden = true; }, 1200);
      } catch (err) {
        step(`<span class="step">Problem: ${esc(err.message)}</span>`);
        toast(err.message, 8000);
        await loadAll(); renderAll();
        if (err.status === 409 && err.data?.existing_id) { const p = S.props.find((x) => x.id === err.data.existing_id); if (p) propModal(p); }
      }
      btn.disabled = false;
    };
    $$("form.nominate-form").forEach((form) => form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form).entries());
      const b = form.querySelector("button"); b.disabled = true; b.textContent = "Scoring (30–60 s)…";
      try {
        const r = await callFn("ingest", { action: "nominate", ...f });
        toast(r.destination_created ? `Added and scored: ${r.destination.name}${r.resolved ? ` (${r.resolved})` : ""}` : `That's already on the list as ${r.destination.name}`, 6000);
        form.reset(); await loadAll(); renderAll(); showTab("destinations");
        if (r.destination_created) { destModal(S.dests.find((d) => d.id === r.destination.id) || r.destination); prospectDestination(r.destination); }
      } catch (err) { toast(err.message, 6000); }
      b.disabled = false; b.textContent = "Score this destination";
    });

    // global click delegation
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-open-dest],[data-open-prop],[data-goto-lodging],[data-star],[data-rescore-prop],[data-edit-prop],[data-del-prop],[data-rescore-dest],[data-del-dest],[data-adopt],[data-avail],[data-del-win],[data-photos],[data-hero],[data-fav]");
      if (!t || t.tagName === "FORM" || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
      if (t.dataset.openDest) { e.preventDefault(); const d = S.dests.find((x) => x.id === t.dataset.openDest); if (d) destModal(d); }
      else if (t.dataset.openProp) { e.preventDefault(); const p = S.props.find((x) => x.id === t.dataset.openProp); if (p) propModal(p); }
      else if (t.dataset.gotoLodging) { S.filter = t.dataset.gotoLodging; renderLodging(); showTab("lodging"); }
      else if (t.dataset.star) { toggleFinalist(t.dataset.star); }
      else if (t.dataset.fav) { e.preventDefault(); e.stopPropagation(); toggleFav(t.dataset.fav); }
      else if (t.dataset.hero) { const h = $("#hero-img"); if (h) h.src = t.dataset.hero; $$(".gallery img").forEach((i) => i.classList.toggle("on", i === t)); }
      else if (t.dataset.photos) {
        t.disabled = true; t.textContent = "Fetching…";
        try { const r = await callFn("ingest", { action: "refresh_photos", property_id: t.dataset.photos }); await loadAll(); renderAll(); const p = S.props.find((x) => x.id === t.dataset.photos); if (p) propModal(p); toast(r.photos?.length ? `Got ${r.photos.length} photos.` : "The site didn't give up any usable photos."); }
        catch (err) { toast(err.message, 6000); t.disabled = false; t.textContent = "Refresh photos"; }
      }
      else if (t.dataset.delWin) {
        const w = S.avail.find((x) => x.id === t.dataset.delWin);
        const { error } = await sb.from("availability").delete().eq("id", t.dataset.delWin);
        if (error) toast(error.message, 5000); else { await loadAll(); renderAll(); const p = S.props.find((x) => x.id === w?.property_id); if (p) propModal(p); }
      }
      else if (t.dataset.avail) {
        const status = t.dataset.status;
        let note = "";
        if (status === "unavailable") { note = prompt("What did you find on the host's calendar or from the host? (e.g. 'Booked June 5–12', 'Owner said 3-night max'). Disqualification is only for availability; this takes the house off the ballot."); if (note === null) return; if (!note.trim()) { toast("Please say what you found; that's the record for the family."); return; } }
        else if (status === "available") { note = prompt("Optional: how you confirmed it (e.g. 'Called host 9/8, open for our week, $9,800').") || ""; }
        if (await setAvailability(t.dataset.avail, status, note)) { const p = S.props.find((x) => x.id === t.dataset.avail); if (p) propModal(p); toast(status === "unavailable" ? "Disqualified. It's off the ballot and can't be starred." : status === "available" ? "Marked available. Thank you for checking." : "Disqualification removed."); }
      }
      else if (t.dataset.adopt) {
        t.disabled = true; t.textContent = "Adopting…";
        try { const r = await callFn("ingest", { action: "adopt", property_id: t.dataset.adopt }); await loadAll(); renderAll(); closeModal(); toast(r.already ? "You already adopted this one. It's in My picks." : "Adopted. It's now in My picks under your household; star it to put it on the ballot."); showTab("mine"); }
        catch (err) { toast(err.message, 6000); t.disabled = false; t.textContent = "Adopt as one of my household's houses"; }
      }
      else if (t.dataset.rescoreProp) {
        t.disabled = true; t.textContent = "Scoring…";
        try { await callFn("ingest", { action: "score", property_id: t.dataset.rescoreProp, reread: !!t.dataset.reread }); toast("Re-scored."); await loadAll(); renderAll(); const p = S.props.find((x) => x.id === t.dataset.rescoreProp); if (p) propModal(p); }
        catch (err) { toast(err.message, 6000); t.disabled = false; t.textContent = "Re-run scoring"; }
      }
      else if (t.dataset.editProp) {
        const p = S.props.find((x) => x.id === t.dataset.editProp); if (!p) return;
        closeModal(); showTab("mine");
        pf.hidden = true; sf.hidden = false; $("#prefill-note").hidden = true;
        sf.url.value = p.url || ""; sf.title.value = p.title; sf.city.value = p.city || ""; sf.state.value = p.state || "";
        sf.bedrooms.value = p.bedrooms ?? ""; sf.bathrooms.value = p.bathrooms ?? ""; sf.sleeps.value = p.sleeps ?? "";
        sf.price_night.value = p.price_night ?? ""; sf.price_total.value = p.price_total ?? ""; sf.notes.value = p.notes || "";
        sf.dataset.editing = p.id; $("#submit-btn").textContent = "Save changes & re-score";
        sf.scrollIntoView({ behavior: "smooth" });
      }
      else if (t.dataset.delProp) {
        if (!confirm("Delete this house? Votes that ranked it will drop it.")) return;
        const { error } = await sb.from("properties").delete().eq("id", t.dataset.delProp);
        if (error) toast(error.message, 5000); else { closeModal(); toast("Deleted."); await loadAll(); renderAll(); }
      }
      else if (t.dataset.rescoreDest) {
        t.disabled = true; t.textContent = "Scoring…";
        try { await callFn("ingest", { action: "rescore_destination", destination_id: t.dataset.rescoreDest }); toast("Destination re-scored."); await loadAll(); renderAll(); closeModal(); }
        catch (err) { toast(err.message, 6000); t.disabled = false; t.textContent = "Re-run AI scoring"; }
      }
      else if (t.dataset.delDest) {
        if (!confirm("Delete this destination and every house under it?")) return;
        const { error } = await sb.from("destinations").delete().eq("id", t.dataset.delDest);
        if (error) toast(error.message, 5000); else { closeModal(); await loadAll(); renderAll(); }
      }
    });
  }

  // ---------- availability calendar ----------
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  function seasonWeeks() {
    const t = S.settings.trip || {};
    const start = new Date((t.season_start || "2027-05-01") + "T00:00:00Z"), end = new Date((t.season_end || "2027-08-20") + "T00:00:00Z");
    const weeks = []; let d = start;
    while (d <= end) { weeks.push({ start: iso(d), end: iso(addDays(d, 7)) }); d = addDays(d, 7); }
    return weeks;
  }
  const weekLabel = (w) => new Date(w.start + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2; // [start,end) half-open
  /** week status from recorded windows: booked (any booked overlap), avail (available covers the whole week), part (mix), or "" */
  function weekStatus(propId, w) {
    const ws = S.avail.filter((x) => x.property_id === propId);
    const bookedHit = ws.some((x) => x.status === "booked" && overlaps(x.start_date, x.end_date, w.start, w.end));
    const availCover = ws.some((x) => x.status === "available" && x.start_date <= w.start && x.end_date >= w.end);
    const availTouch = ws.some((x) => x.status === "available" && overlaps(x.start_date, x.end_date, w.start, w.end));
    if (bookedHit && availTouch) return "part";
    if (bookedHit) return "booked";
    if (availCover) return "avail";
    if (availTouch) return "part";
    return "";
  }
  const isTripWeek = (w) => { const t = S.settings.trip || {}; return !!(t.check_in && t.check_in >= w.start && t.check_in < w.end); };
  function strip(p) {
    return `<div class="strip">${seasonWeeks().map((w) => `<div class="cell ${weekStatus(p.id, w)} ${isTripWeek(w) ? "trip" : ""}" title="${weekLabel(w)}"></div>`).join("")}</div>`;
  }
  function renderAvail() {
    const area = $("#avail-area");
    const sel = $("#avail-filter"); const cur = sel.value;
    sel.innerHTML = `<option value="">All destinations</option>` + S.dests.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
    sel.value = cur || "";
    const onlyKnown = $("#avail-only-known").checked;
    const weeks = seasonWeeks();
    let rows = S.props.filter((p) => p.status === "scored" && (!cur || p.destination_id === cur));
    if (onlyKnown) rows = rows.filter((p) => S.avail.some((a) => a.property_id === p.id) || p.avail_status !== "unknown");
    if ($("#avail-favs").checked) rows = rows.filter(isFav);
    rows.sort((a, b) => (isDq(a) - isDq(b)) || (b.is_finalist - a.is_finalist) || (b.total - a.total));
    if (!rows.length) { area.innerHTML = `<p class="empty">Nothing to show yet.</p>`; return; }
    const t = S.settings.trip || {};
    area.innerHTML = `<div class="avail-legend"><span><i style="background:#8fd3a6"></i>open (confirmed)</span><span><i style="background:#ef9a9a"></i>booked</span><span><i style="background:linear-gradient(135deg,#8fd3a6 50%,#ef9a9a 50%)"></i>partly</span><span><i style="background:#ebe5d8"></i>nobody has checked</span>${t.check_in ? `<span><i style="outline:2px solid var(--accent);outline-offset:-2px"></i>our week (${fmtDate(t.check_in)})</span>` : `<span class="muted">Joseph can set our target week on the Admin tab.</span>`}</div>
      <div class="avail-wrap"><div class="avail-grid" style="grid-template-columns:230px repeat(${weeks.length},minmax(38px,1fr))">
        <div class="hdr"></div>${weeks.map((w) => `<div class="hdr ${isTripWeek(w) ? "trip" : ""}">${weekLabel(w)}</div>`).join("")}
        ${rows.map((p) => `<div class="rowlabel"><a href="#" data-open-prop="${p.id}">${esc(p.title.length > 34 ? p.title.slice(0, 33) + "…" : p.title)}</a><span class="s">${esc(destOf(p)?.name?.split(" / ")[0]?.split(":")[0] || "")} · ${p.total}${p.is_finalist ? " · ★" : ""}${p.ai_pick ? " · AI" : ""}${isDq(p) ? " · disqualified" : ""}</span></div>` +
          weeks.map((w) => { const st = weekStatus(p.id, w); const notes = S.avail.filter((x) => x.property_id === p.id && overlaps(x.start_date, x.end_date, w.start, w.end)).map((x) => `${x.status} ${fmtDate(x.start_date)}–${fmtDate(x.end_date)}${x.note ? ": " + x.note : ""} (${nameOf(x.created_by) || "?"})`).join("\n"); return `<div class="cell ${st} ${isTripWeek(w) ? "trip" : ""} ${isDq(p) ? "dq" : ""}" data-open-prop="${p.id}" title="${esc(weekLabel(w) + (notes ? "\n" + notes : "\nNothing recorded"))}"></div>`; }).join("")).join("")}
      </div></div>
      <p class="tiny muted">Hover a square for the details. Click a house name to add what you found on its calendar.</p>`;
  }
  $("#avail-filter").onchange = renderAvail;
  $("#avail-only-known").onchange = renderAvail;
  $("#avail-favs").onchange = renderAvail;
  function availSection(p) {
    const t = S.settings.trip || {};
    const ws = S.avail.filter((x) => x.property_id === p.id);
    const min = t.season_start || "2027-05-01", max = t.season_end || "2027-08-20";
    return `<div class="section-title">Calendar: what people have found</div>${strip(p)}
      ${ws.length ? ws.map((x) => `<div class="win-row"><i class="pill ${x.status === "available" ? "ok" : "warn"}">${x.status === "available" ? "open" : "booked"}</i><span>${fmtDate(x.start_date)} – ${fmtDate(x.end_date)}${x.note ? ` · ${esc(x.note)}` : ""} <span class="muted tiny">(${esc(nameOf(x.created_by) || "?")}, ${fmtDate(x.created_at)})</span></span>${x.created_by === S.session.user.id || isAdmin() ? `<button class="btn small ghost" data-del-win="${x.id}">✕</button>` : "<span></span>"}</div>`).join("") : `<p class="tiny muted">No dates recorded yet.</p>`}
      <form class="win-form stack" data-prop="${p.id}" style="margin-top:.6em">
        <div class="row three">
          <label>Check-in <input type="date" name="start" min="${min}" max="${max}" required></label>
          <label>Check-out <input type="date" name="end" min="${min}" max="${max}" required></label>
          <label>Status <select name="status"><option value="available">Open</option><option value="booked">Booked</option></select></label>
        </div>
        <div class="row"><input name="note" placeholder="Optional: where you saw it, price, minimum stay…"><button class="btn small primary" type="submit">Add dates</button></div>
      </form>`;
  }
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest("form.win-form"); if (!f) return;
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    if (!fd.start || !fd.end) return;
    if (fd.end <= fd.start) { toast("Check-out has to be after check-in."); return; }
    const { error } = await sb.from("availability").insert({ property_id: f.dataset.prop, start_date: fd.start, end_date: fd.end, status: fd.status, note: fd.note || null, created_by: S.session.user.id });
    if (error) { toast(error.message, 6000); return; }
    await loadAll(); renderAll();
    const p = S.props.find((x) => x.id === f.dataset.prop); if (p) propModal(p);
    toast("Added. Thanks for checking.");
  });

  // ---------- vote ----------
  function finalists() { return S.props.filter((p) => p.is_finalist && p.status === "scored" && !isDq(p)); }
  const minRanked = () => Number(S.settings.voting?.min_ranked) || 1;
  let ranking = null; // array of property ids (local editing state)
  function renderVote() {
    const area = $("#vote-area");
    const fin = finalists();
    const myVote = S.votes.find((v) => v.user_id === S.session.user.id);
    if (ranking === null) ranking = (myVote?.ranking || []).filter((id) => fin.some((p) => p.id === id));
    else ranking = ranking.filter((id) => fin.some((p) => p.id === id));
    const v = S.settings.voting || {};
    const open = votingOpen();
    const deadline = (v.closes ? `Voting closes ${fmtDateTime(v.closes)}.` : "") + (nomLock() ? (nominationsLocked() ? " The ballot is locked." : ` Houses can be added and starred until ${fmtDateTime(nomLock())}; after that the ballot is fixed.`) : "");
    const noBallot = S.dests.filter((d) => !fin.some((p) => p.destination_id === d.id)).map((d) => d.name);
    let html = `<div class="notice">${open ? deadline : "<b>Voting is closed.</b>"} ${S.votes.length} of ${S.profiles.length} people have voted.${noBallot.length ? `<br><span class="muted tiny">Not on the ballot (no finalist house yet): ${noBallot.map(esc).join(", ")}.</span>` : ""}</div>`;
    if (!fin.length) { area.innerHTML = html + `<p class="empty">Nothing is on the ballot yet. A house appears here once its household stars it as one of their two finalists on the My picks tab.</p>`; return; }
    const unranked = fin.filter((p) => !ranking.includes(p.id)).sort((a, b) => b.total - a.total);
    const item = (p, i, inRank) => `<div class="rank-item"><div class="n">${inRank ? i + 1 : "·"}</div>
      <div><div class="t"><a href="#" data-open-prop="${p.id}">${esc(p.title)}</a> ${p.gate_pass ? "" : '<i class="pill warn">gate ✗</i>'} ${newBadge(p)}</div><div class="s">${esc(destOf(p)?.name || "")} · ${p.bedrooms ?? "?"} BR · ${p.total}/100${p.price_night ? " · " + money(p.price_night) + "/night" : ""}</div></div>
      <div class="ctl">${inRank ? `<button data-mv="${p.id}" data-dir="-1" title="Move up" ${!open ? "disabled" : ""}>▲</button><button data-mv="${p.id}" data-dir="1" title="Move down" ${!open ? "disabled" : ""}>▼</button><button data-rm="${p.id}" title="Remove" ${!open ? "disabled" : ""}>✕</button>` : `<button data-add="${p.id}" title="Add to my ranking" ${!open ? "disabled" : ""}>＋</button>`}</div></div>`;
    html += `<div class="ballot">
      <div class="card"><h3>My ranking</h3><p class="muted tiny">1 = the house I most want us to book. ${minRanked() > 1 ? `Rank at least ${Math.min(minRanked(), fin.length)}.` : "You don't have to rank them all, but"} A house you leave out gets no points from you.</p>
        <div class="rank-list">${ranking.length ? ranking.map((id, i) => item(fin.find((p) => p.id === id), i, true)).join("") : `<p class="empty">Tap ＋ on a house to start your ranking.</p>`}</div>
        <div class="actions"><button class="btn primary" id="save-vote" ${!open || ranking.length < Math.min(minRanked(), fin.length) ? "disabled" : ""}>${myVote ? "Update my vote" : "Cast my vote"}</button>${open ? `<button class="btn" id="spin-vote" title="Fills your ranking in a random order; you can still adjust it before casting">🎲 Can't decide? Spin</button>` : ""}${myVote ? `<span class="muted tiny" style="align-self:center">Last saved ${fmtDateTime(myVote.updated_at)}</span>` : ""}</div></div>
      <div class="card"><h3>On the ballot</h3><p class="muted tiny">Every starred finalist, best score first.</p>
        <div class="rank-list">${unranked.length ? unranked.map((p) => item(p, 0, false)).join("") : `<p class="empty">You've ranked them all.</p>`}</div></div></div>`;
    area.innerHTML = html;
    $$("[data-add]", area).forEach((b) => b.onclick = () => { ranking.push(b.dataset.add); renderVote(); });
    $$("[data-rm]", area).forEach((b) => b.onclick = () => { ranking = ranking.filter((x) => x !== b.dataset.rm); renderVote(); });
    $$("[data-mv]", area).forEach((b) => b.onclick = () => { const i = ranking.indexOf(b.dataset.mv), j = i + Number(b.dataset.dir); if (j < 0 || j >= ranking.length) return; [ranking[i], ranking[j]] = [ranking[j], ranking[i]]; renderVote(); });
    const spinV = $("#spin-vote");
    if (spinV) spinV.onclick = () => roulette(fin, 1, "Rank first", (picked) => { const first = picked[0].id; const rest = fin.filter((p) => p.id !== first).map((p) => p.id).sort(() => Math.random() - 0.5); ranking = [first, ...rest]; renderVote(); toast("Random ranking filled in. Adjust if you like, then cast your vote.", 6000); });
    const save = $("#save-vote");
    if (save) save.onclick = async () => {
      save.disabled = true;
      const { error } = await sb.from("votes").upsert({ user_id: S.session.user.id, ranking });
      if (error) toast(/voting_closed/.test(error.message) ? "Voting is closed." : /not_finalist/.test(error.message) ? "One of those houses just left the ballot. Refreshing." : error.message, 5000);
      else toast("Vote saved. You can change it any time before the deadline.");
      await loadAll(); renderAll();
    };
  }

  // ---------- automatic lodging search for new destinations ----------
  async function prospectDestination(dest) {
    try {
      toast(`New destination. Searching the web for 7-bedroom houses in ${dest.name}… (a minute or two)`, 8000);
      const { candidates = [], skipped } = await callFn("ingest", { action: "prospect", destination_id: dest.id });
      if (skipped || !candidates.length) { if (!skipped) toast(`No suitable houses found automatically for ${dest.name}. Add one yourself if you know of it.`, 6000); return; }
      const ids = [];
      for (const c of candidates) {
        try { const r = await callFn("ingest", { action: "prospect_add", destination_id: dest.id, url: c.url, why: c.why }); if (r.property_id) ids.push(r.property_id); } catch (e) { console.warn("prospect_add", e.message); }
      }
      await loadAll(); renderAll();
      if (!ids.length) { toast(`Found listings for ${dest.name} but none passed the bedroom check.`, 6000); return; }
      toast(`Found ${ids.length} house${ids.length > 1 ? "s" : ""} in ${dest.name}; scoring now…`, 6000);
      await scorePending(ids);
      toast(`AI Selected houses for ${dest.name} are ready (see the AI Selected tab).`, 7000);
    } catch (e) { toast("Automatic house search hit a snag: " + e.message, 7000); }
  }
  async function scorePending(ids) {
    for (const id of ids) {
      try { await callFn("ingest", { action: "score", property_id: id }); } catch (e) { console.warn("score", e.message); }
      await loadAll(); renderAll();
    }
  }
  // safety net: AI picks left pending (someone closed the tab mid-run) get scored when anyone loads the page
  let resumed = false;
  function resumePendingAi() {
    if (resumed) return;
    const stale = S.props.filter((p) => p.ai_pick && p.status === "pending" && Date.now() - new Date(p.updated_at).getTime() > 3 * 60 * 1000).map((p) => p.id);
    if (!stale.length) return;
    resumed = true; scorePending(stale);
  }

  // ---------- AI recommendations ----------
  function recCard(p, rank) {
    const d = destOf(p); const det = p.details || {};
    const matches = familyMatchesFor(p);
    return `<div class="card rec-card ${isDq(p) ? "dq" : ""}">
      <div class="thumb" data-open-prop="${p.id}" style="${(p.photos?.[0] || p.image_url) ? `background-image:url('${esc(p.photos?.[0] || p.image_url)}')` : ""}"></div>
      <div>
        <div class="title-row"><h3>${rank ? `#${rank} ` : ""}<a href="#" data-open-prop="${p.id}">${esc(p.title)}</a> <i class="pill ai">AI Selected</i> ${newBadge(p)} ${favBtn(p, "inline")}</h3><span class="mini-score">${p.status === "scored" ? p.total : "…"}<small>/100</small></span></div>
        <div class="muted tiny">${esc(d?.name || "")} · ${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA · sleeps ${p.sleeps ?? "?"}${p.price_night ? " · " + money(p.price_night) + "/night" : ""}${p.rating ? ` · ★ ${p.rating}${p.review_count ? ` (${p.review_count})` : ""}` : ""}
          ${p.gate_pass ? '<i class="pill ok">sleeps us right ✓</i>' : '<i class="pill warn">bed plan short ✗</i>'} ${availBadge(p, true)} ${p.elevation_ft > maxElev() ? elevPill(p.elevation_ft) : ""}
          ${nomsFor(p.id).length ? nomPills(p) : ""}</div>
        <p>${esc(p.ai_note || p.ai_summary || "")}</p>
        ${det.bed_plan ? `<p class="tiny"><b>Beds:</b> ${esc(det.bed_plan)}</p>` : ""}
        ${(p.red_flags || []).length ? `<p class="tiny"><b>Watch:</b> ${p.red_flags.slice(0, 3).map(esc).join(" · ")}</p>` : ""}
        <div class="actions"><button class="btn small" data-open-prop="${p.id}">Full scorecard</button>${p.url ? `<a class="btn small" href="${esc(p.url)}" target="_blank" rel="noopener">Open listing ↗</a>` : ""}${p.status === "scored" && !isDq(p) ? `<button class="btn small ${nominatedByMe(p.id) ? "" : "primary"}" data-star="${p.id}" ${nominationsLocked() ? "disabled" : ""}>${nominatedByMe(p.id) ? "Withdraw nomination" : "★ Nominate"}</button>` : ""}</div>
      </div></div>`;
  }
  function renderRecs() {
    const area = $("#recs-area");
    const picks = aiPicks().filter((p) => p.status === "scored").sort((a, b) => (isDq(a) - isDq(b)) || b.total - a.total);
    const recs = S.settings.ai_recs || {};
    if (!picks.length) { area.innerHTML = `<p class="empty">Research is still running. Check back shortly.</p>`; return; }
    const top = (recs.top || []).map((t) => ({ ...t, p: picks.find((x) => x.id === t.property_id) })).filter((t) => t.p && !isDq(t.p));
    let html = recs.intro ? `<div class="card" style="margin-bottom:14px">${recs.intro.split(/\n\n+/).map((para) => `<p>${esc(para)}</p>`).join("")}${recs.updated_at ? `<p class="tiny muted">Research date: ${fmtDate(recs.updated_at)}. Prices are what the listing pages showed and will move with dates.</p>` : ""}</div>` : "";
    if (top.length) {
      html += `<h3>If Claude had to pick</h3><div class="cards">` + top.map((t, i) => `<div class="card"><div class="title-row"><b>#${i + 1} <a href="#" data-open-prop="${t.p.id}">${esc(t.p.title)}</a></b><span class="muted tiny">${esc(destOf(t.p)?.name || "")} · ${t.p.total}/100</span></div><p>${esc(t.why)}</p></div>`).join("") + `</div>`;
    }
    html += `<h3 style="margin-top:1.2em">Best house found in each destination</h3>`;
    S.dests.forEach((d) => {
      const ps = picks.filter((p) => p.destination_id === d.id);
      html += `<div class="section-title">${esc(d.name)} <span class="muted" style="font-weight:400">· destination ${d.total}/100</span></div>`;
      html += ps.length ? `<div class="cards">${ps.map((p) => recCard(p)).join("")}</div>` : `<p class="empty">No house met the bar here. ${esc(d.cons?.[0] || "")}</p>`;
    });
    area.innerHTML = html;
  }

  // ---------- results ----------
  /**
   * How much one person's ballot counts. The family's rule (settings.voting.vote_weighting), agreed 2026-09-07:
   *   "household" (the standing rule) - each household counts 1 in total, split evenly among the adults in it who voted
   *   "person"                       - every adult's ballot counts 1
   */
  function voteWeight(voter, hhVoters, mode) {
    return mode === "household" ? 1 / Math.max(1, hhVoters) : 1;
  }
  function tally() {
    const fin = finalists();
    const ids = fin.map((p) => p.id);
    const mode = S.settings.voting?.vote_weighting || "household";
    const hhCount = {}; S.votes.forEach((v) => { const h = householdOf(v.user_id); if (h) hhCount[h] = (hhCount[h] || 0) + 1; });
    const ballots = S.votes.map((v) => { const voter = S.profiles.find((p) => p.id === v.user_id); return { r: (v.ranking || []).filter((id) => ids.includes(id)), w: voter ? voteWeight(voter, hhCount[voter.household] || 1, mode) : 0, hh: voter?.household }; }).filter((b) => b.r.length && b.w > 0);
    const n = ids.length;
    const borda = Object.fromEntries(ids.map((id) => [id, 0]));
    const first = Object.fromEntries(ids.map((id) => [id, 0]));
    ballots.forEach((b) => { b.r.forEach((id, i) => (borda[id] += (n - i) * b.w)); first[b.r[0]] += b.w; });
    const scoreOf = (id) => fin.find((p) => p.id === id)?.total || 0;
    // instant runoff on weighted ballots; ties broken by points, then by the house's score
    let alive = new Set(ids), rounds = [], winner = null;
    while (alive.size) {
      const counts = Object.fromEntries([...alive].map((id) => [id, 0]));
      let active = 0;
      ballots.forEach((b) => { const top = b.r.find((id) => alive.has(id)); if (top) { counts[top] += b.w; active += b.w; } });
      rounds.push(counts);
      const sorted = [...alive].sort((a, b) => counts[b] - counts[a] || borda[b] - borda[a] || scoreOf(b) - scoreOf(a));
      if (!active || alive.size === 1 || counts[sorted[0]] > active / 2) { winner = sorted[0]; break; }
      const loser = sorted[sorted.length - 1];
      alive.delete(loser);
    }
    const round1 = (v) => Math.round(v * 100) / 100;
    Object.keys(borda).forEach((k) => (borda[k] = round1(borda[k]))); Object.keys(first).forEach((k) => (first[k] = round1(first[k])));
    rounds = rounds.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round1(v)])));
    return { fin, ballots: ballots.map((b) => b.r), weighted: ballots, borda, first, rounds, winner, mode };
  }
  /** points each household gave each house, plus every person's ranking */
  function householdTally(rows, ballots) {
    const n = rows.length;
    const hhs = CFG.HOUSEHOLDS.filter((h) => S.profiles.some((p) => p.household === h));
    const pts = {}; // house -> household -> points
    const voterRows = [];
    S.votes.forEach((v) => {
      const hh = householdOf(v.user_id); if (!hh) return;
      const r = (v.ranking || []).filter((id) => rows.some((p) => p.id === id));
      const w = voteWeight(S.profiles.find((p) => p.id === v.user_id) || {}, S.votes.filter((x) => householdOf(x.user_id) === hh).length, S.settings.voting?.vote_weighting || "household");
      r.forEach((id, i) => { pts[id] = pts[id] || {}; pts[id][hh] = Math.round(((pts[id][hh] || 0) + (n - i) * w) * 100) / 100; });
      voterRows.push({ hh, name: nameOf(v.user_id), r });
    });
    const hhVoted = (h) => S.votes.filter((v) => householdOf(v.user_id) === h).length;
    const hhSize = (h) => S.profiles.filter((p) => p.household === h).length;
    return `<div class="section-title">By household (points given)</div>
      <div class="table-wrap"><table class="results-table hh-table"><tr><th>House</th>${hhs.map((h) => `<th>${esc(h.split(",")[0])}<br><span class="tiny muted" style="font-weight:400">${hhVoted(h)}/${hhSize(h)} voted</span></th>`).join("")}</tr>
      ${rows.map((p) => `<tr><td>${esc(p.title)}</td>${hhs.map((h) => `<td class="pts">${pts[p.id]?.[h] ?? "·"}</td>`).join("")}</tr>`).join("")}</table></div>
      <div class="section-title">How each person ranked them</div>
      <div class="table-wrap"><table class="results-table">${hhs.map((h) => voterRows.filter((v) => v.hh === h).map((v) => `<tr><td><b>${esc(v.name)}</b><br><span class="tiny muted">${esc(h)}</span></td><td>${v.r.length ? v.r.map((id, i) => `${i + 1}. ${esc(rows.find((p) => p.id === id)?.title || "?")}`).join("<br>") : "<span class='muted'>no ballot</span>"}</td></tr>`).join("")).join("")}</table></div>`;
  }
  function renderResults() {
    const area = $("#results-area");
    const pub = !!S.settings.voting?.results_public;
    const voters = S.votes.map((v) => nameOf(v.user_id)).filter(Boolean);
    const who = `<div class="notice"><b>${S.votes.length} of ${S.profiles.length}</b> have voted${voters.length ? ": " + voters.map(esc).join(", ") : ""}.${votingOpen() ? "" : " Voting is closed."}</div>`;
    if (!pub && !isAdmin()) { area.innerHTML = who + `<p class="empty">Results stay hidden until Joseph opens them, so nobody votes based on the running score.</p>`; return; }
    const { fin, ballots, borda, first, rounds, winner, mode } = tally();
    if (!fin.length || !ballots.length) { area.innerHTML = who + `<p class="empty">No votes on the ballot yet.</p>`; return; }
    const rows = fin.slice().sort((a, b) => borda[b.id] - borda[a.id]);
    const byDest = {};
    rows.forEach((p) => { const k = destOf(p)?.name || "?"; byDest[k] = (byDest[k] || 0) + borda[p.id]; });
    area.innerHTML = who + (!pub && isAdmin() ? `<p class="msg info">Only you can see this right now. Flip "results public" on the Admin tab to show everyone.</p>` : "") +
      `<div class="table-wrap"><table class="results-table"><tr><th>House</th><th>Destination</th><th>1st choices</th><th>Points</th><th>Final round</th></tr>` +
      rows.map((p) => `<tr class="${p.id === winner ? "winner" : ""}"><td>${p.id === winner ? "🏆 " : ""}<a href="#" data-open-prop="${p.id}">${esc(p.title)}</a></td><td>${esc(destOf(p)?.name || "")}</td><td>${first[p.id]}</td><td>${borda[p.id]}</td><td>${rounds[rounds.length - 1][p.id] ?? "—"}</td></tr>`).join("") + `</table></div>
      <p class="tiny muted">Points: with ${fin.length} houses on the ballot, a 1st-place rank is worth ${fin.length}, 2nd is ${fin.length - 1}, and so on. ${mode === "household" ? "Each household counts once: when two people in a household vote, their ballots count half each." : "Every adult's ballot counts once."} "Final round" is the instant-runoff count after the weakest houses were eliminated (${rounds.length} round${rounds.length > 1 ? "s" : ""}). Ties break on points, then on the house's score.</p>
      <div class="section-title">By destination (points)</div><div class="table-wrap"><table class="results-table">${Object.entries(byDest).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table></div>
      ${householdTally(rows, ballots)}`;
  }

  // ---------- admin ----------
  function renderAdmin() {
    const v = S.settings.voting || {};
    const area = $("#admin-area");
    const toLocalInput = (iso) => { const d = new Date(iso); const pad = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const closesLocal = v.closes ? toLocalInput(v.closes) : "";
    area.innerHTML = `<div class="admin-grid">
      <div class="card"><h3>Voting</h3><div class="stack">
        <label class="switch"><input type="checkbox" id="adm-open" ${v.open !== false ? "checked" : ""}> Voting is open</label>
        <label class="switch"><input type="checkbox" id="adm-public" ${v.results_public ? "checked" : ""}> Results visible to everyone</label>
        <label>Nominations lock (your local time) <input type="datetime-local" id="adm-nomclose" value="${v.nominations_close ? toLocalInput(v.nominations_close) : ""}"></label>
        <label>Voting closes (your local time) <input type="datetime-local" id="adm-closes" value="${closesLocal}"></label>
        <label>Nominations per household <input type="number" id="adm-cap" min="1" max="5" value="${v.max_finalists_per_household ?? 2}"></label>
        <label>Vote counting <select id="adm-weight"><option value="household" ${(v.vote_weighting || "household") === "household" ? "selected" : ""}>Each household counts once (split among its voters)</option><option value="person" ${v.vote_weighting === "person" ? "selected" : ""}>Each adult counts once</option></select></label>
        <label>Each ballot must rank at least <input type="number" id="adm-minrank" min="1" max="10" value="${v.min_ranked ?? 1}"></label>
        <div class="row"><label>Trip check-in <input type="date" id="adm-checkin" value="${S.settings.trip?.check_in || ""}"></label><label>Trip check-out <input type="date" id="adm-checkout" value="${S.settings.trip?.check_out || ""}"></label></div>
        <button class="btn primary" id="adm-save">Save voting settings</button>
        <p class="tiny muted">Family code for new accounts is set on the server (INVITE_CODE). Current: <b>JUNE2027FAM</b> unless you changed it.</p>
      </div></div>
      <div class="card"><h3>People (${S.profiles.length})</h3>
        <div class="table-wrap"><table class="results-table">${S.profiles.map((p) => `<tr><td>${esc(p.display_name)}${p.is_admin ? " <i class='pill sea'>admin</i>" : ""}<br><span class="tiny muted">${esc(p.household)} · ${esc(p.email || "")}</span></td><td>${S.votes.some((x) => x.user_id === p.id) ? "voted" : "<span class='muted'>no vote</span>"}</td><td><button class="btn small" data-reset="${esc(p.email || "")}">Reset pw</button></td></tr>`).join("")}</table></div>
      </div>
      <div class="card"><h3>Destinations</h3>
        ${S.dests.map((d) => `<div class="attr"><div><b>${esc(d.name)}</b> <span class="cat">${d.total}/100 · ${d.source}</span></div><div><button class="btn small" data-open-dest="${d.id}">Open</button></div></div>`).join("")}
      </div></div>`;
    $("#adm-save").onclick = async () => {
      const closes = $("#adm-closes").value ? new Date($("#adm-closes").value).toISOString() : null;
      const nominations_close = $("#adm-nomclose").value ? new Date($("#adm-nomclose").value).toISOString() : null;
      const value = { ...v, open: $("#adm-open").checked, results_public: $("#adm-public").checked, closes, nominations_close, max_finalists_per_household: Number($("#adm-cap").value) || 2, vote_weighting: $("#adm-weight").value, min_ranked: Number($("#adm-minrank").value) || 1 };
      const { error } = await sb.from("settings").upsert({ key: "voting", value });
      const trip = { ...(S.settings.trip || {}), check_in: $("#adm-checkin").value || null, check_out: $("#adm-checkout").value || null };
      const { error: e2 } = await sb.from("settings").upsert({ key: "trip", value: trip });
      if (error || e2) toast((error || e2).message, 5000); else { toast("Saved."); await loadAll(); renderAll(); }
    };
    $$("[data-reset]", area).forEach((b) => b.onclick = async () => {
      const pw = prompt(`New password for ${b.dataset.reset} (8+ characters):`);
      if (!pw) return;
      try { await callFn("admin", { action: "reset_password", email: b.dataset.reset, password: pw }); toast("Password reset. Tell them the new one."); }
      catch (err) { toast(err.message, 6000); }
    });
  }

  // remember whether the how-it-works panel is open
  (() => { const h = $("#howto"); if (!h) return; try { h.open = localStorage.getItem("ftv_howto") !== "closed"; } catch { h.open = true; } h.addEventListener("toggle", () => { try { localStorage.setItem("ftv_howto", h.open ? "open" : "closed"); } catch { /* ignore */ } }); })();

  // kick off
  sb.auth.getSession().then(({ data: { session } }) => { S.session = session; if (session) boot(); else showAuth(); });
})();
