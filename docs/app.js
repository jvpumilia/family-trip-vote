/* Family Trip Vote — single-page app. Talks to Supabase directly for reads/writes (row-level security
   enforces who may change what) and to three edge functions for signup, link scoring and admin tasks. */
(() => {
  const CFG = window.FTV_CONFIG;
  const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
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

  const S = { session: null, profile: null, profiles: [], origins: [], dests: [], props: [], votes: [], settings: {}, tab: "map", map: null, layers: {}, selectedDest: null, filter: "", sort: "total" };

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
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
    const [pr, o, d, p, v, st] = await Promise.all([
      sb.from("profiles").select("*"),
      sb.from("origins").select("*").order("sort"),
      sb.from("destinations").select("*"),
      sb.from("properties").select("*").order("created_at", { ascending: false }),
      sb.from("votes").select("*"),
      sb.from("settings").select("*"),
    ]);
    S.profiles = pr.data || []; S.origins = o.data || []; S.dests = d.data || []; S.props = p.data || []; S.votes = v.data || [];
    S.settings = Object.fromEntries((st.data || []).map((r) => [r.key, r.value]));
    S.profile = S.profiles.find((x) => x.id === S.session.user.id) || null;
    S.dests.sort((a, b) => b.total - a.total);
  }

  let booted = false;
  async function boot() {
    await loadAll();
    if (!S.profile) { authMsg("Your account has no profile yet. Ask Joseph."); await sb.auth.signOut(); return; }
    $("#auth").hidden = true; $("#app").hidden = false; $("#userchip").hidden = false;
    $("#user-name").textContent = `${S.profile.display_name} · ${S.profile.household}`;
    $("#admin-tab").hidden = !isAdmin();
    if (!booted) { booted = true; wireTabs(); wireForms(); }
    if (!S.channel) {
      let t;
      const refresh = () => { clearTimeout(t); t = setTimeout(async () => { await loadAll(); renderAll(); }, 400); };
      S.channel = sb.channel("live").on("postgres_changes", { event: "*", schema: "public", table: "properties" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "destinations" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "votes" }, refresh).subscribe();
    }
    renderAll();
  }

  function renderAll() {
    renderMap(); renderDests(); renderLodging(); renderMine(); renderVote(); renderResults(); if (isAdmin()) renderAdmin();
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
    if (name === "map" && S.map) setTimeout(() => S.map.invalidateSize(), 50);
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
    S.props.forEach((p) => {
      if (p.lat == null) return;
      const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<div class="prop-marker ${p.is_finalist ? "finalist" : ""}" style="width:16px;height:16px"></div>`, iconSize: [16, 16], iconAnchor: [8, 16] }), zIndexOffset: 300 });
      m.bindPopup(`<b>${esc(p.title)}</b><br>${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA · ${p.status === "scored" ? `<b>${p.total}</b>/100` : "scoring…"}${p.is_finalist ? " · ★ finalist" : ""}<br><a href="#" data-open-prop="${p.id}">Details →</a>`);
      m.addTo(props);
    });
    if (S.selectedDest) { const d = S.dests.find((x) => x.id === S.selectedDest.id); if (d) selectDest(d); else { lines.clearLayers(); $("#map-info").innerHTML = ""; } }
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
    return `<div class="bars">` + criteria.map(([k, label, max]) => {
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
        <div class="title-row"><h3>#${i + 1} ${esc(d.name)}</h3><span class="muted">${esc(d.region)}${d.source === "packet" ? " · from the packet" : ""}</span></div>
        ${d.gate_pass ? "" : `<p class="msg" style="display:inline-block">Fails the lodging gate (under 10/25)</p>`}
        <p>${esc(d.summary || "")}</p>
        ${scoreBars(d.scores, DEST_CRITERIA, false)}
        <div class="travel-row">Travel: ${S.origins.map((o) => { const t = d.travel?.[o.key]; return `<span title="${esc(o.label)}: ${t ? t.hours + " h, " + t.route : "?"}">${esc(o.label.split(",")[0])} ${t ? diffPill(t.difficulty) : ""}</span>`; }).join("")}</div>
        ${ballotLine(d)}
        <div class="actions"><button class="btn small" data-open-dest="${d.id}">Scorecard, travel &amp; things to do</button><button class="btn small ghost" data-goto-lodging="${d.id}">See lodging</button></div>
      </div></div>`).join("");
  }
  function destModal(d) {
    const ps = S.props.filter((p) => p.destination_id === d.id).sort((a, b) => b.total - a.total);
    openModal(`<h2>${esc(d.name)}</h2><p class="muted">${esc(d.region)} · <b>${d.total}/100</b>${d.gate_pass ? "" : " · fails the lodging gate"}</p>
      <p>${esc(d.summary || "")}</p>
      <div class="row"><div><div class="section-title">Why it might win</div><ul class="list">${(d.pros || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div><div class="section-title">Why it might lose</div><ul class="list">${(d.cons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
      <div class="section-title">Scorecard</div>${scoreBars(d.scores, DEST_CRITERIA, true)}
      <div class="section-title">Getting there from each home</div>${travelTable(d)}
      <div class="section-title">Things to do, rated for our crew</div>
      ${(d.attractions || []).map((a) => `<div class="attr"><div><b>${esc(a.name)}</b> <span class="cat">${esc(a.category)} · ${esc(a.ages)}</span><br><span class="muted">${esc(a.why)}</span></div><div>${stars(a.rating)}</div></div>`).join("") || `<p class="empty">None listed.</p>`}
      <div class="section-title">Lodging added here (${ps.length})</div>
      ${ps.length ? ps.map((p) => `<div class="attr"><div><b>${esc(p.title)}</b>${p.is_finalist ? ' <i class="pill sun">★ finalist</i>' : ""}<br><span class="muted">${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA · sleeps ${p.sleeps ?? "?"}${p.price_night ? " · " + money(p.price_night) + "/night" : ""}</span></div><div><button class="btn small" data-open-prop="${p.id}">${p.status === "scored" ? p.total + "/100" : "scoring…"}</button></div></div>`).join("") : `<p class="empty">Nobody has added a house here yet. Add one on the My picks tab.</p>`}
      ${isAdmin() ? `<div class="actions"><button class="btn small" data-rescore-dest="${d.id}">Re-run AI scoring</button><button class="btn small danger" data-del-dest="${d.id}">Delete destination</button></div>` : ""}`);
  }

  // ---------- lodging ----------
  function propCard(p, mine) {
    const d = destOf(p);
    const pending = p.status !== "scored";
    return `<div class="card prop-card" data-open-prop="${p.id}">
      <div class="thumb" style="${p.image_url ? `background-image:url('${esc(p.image_url)}')` : ""}"></div>
      ${p.is_finalist ? `<span class="star">★ Finalist</span>` : ""}
      ${pending ? `<i class="pill neutral badge">scoring…</i>` : (p.gate_pass ? `<i class="pill ok badge">7+ BR ✓</i>` : `<i class="pill warn badge">Bedroom gate ✗</i>`)}
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">${esc(d?.name || p.city)} · ${p.bedrooms ?? "?"} BR · ${p.bathrooms ?? "?"} BA · sleeps ${p.sleeps ?? "?"}</div>
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
    const sort = $("#lodging-sort").value;
    list = list.slice().sort((a, b) => sort === "price" ? (a.price_night || 1e9) - (b.price_night || 1e9) : sort === "bedrooms" ? (b.bedrooms || 0) - (a.bedrooms || 0) : sort === "newest" ? new Date(b.created_at) - new Date(a.created_at) : b.total - a.total);
    $("#lodging-list").innerHTML = list.length ? list.map((p) => propCard(p)).join("") : `<p class="empty">No houses yet. Be the first: paste a link on the My picks tab.</p>`;
  }
  $("#lodging-filter").onchange = (e) => { S.filter = e.target.value; renderLodging(); };
  $("#lodging-sort").onchange = renderLodging;

  function propModal(p) {
    const d = destOf(p);
    const mine = p.submitted_by === S.session.user.id || (householdOf(p.submitted_by) && householdOf(p.submitted_by) === S.profile.household);
    const det = p.details || {};
    const flags = [det.indoor_pool && "Indoor pool", det.outdoor_pool && "Outdoor pool", det.hot_tub && "Hot tub", det.game_room && "Game room", det.theater && "Theater"].filter(Boolean);
    openModal(`${p.image_url ? `<img class="hero" src="${esc(p.image_url)}" alt="">` : ""}
      <h2>${esc(p.title)}</h2>
      <p class="muted">${esc(d?.name || "")} · ${esc(p.city || "")}, ${esc(p.state || "")}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">Open the listing ↗</a>` : ""}</p>
      <div class="kv">
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
        <div class="section-title">Score: ${p.total}/100 ${p.gate_pass ? '<i class="pill ok">7+ real bedrooms ✓</i>' : '<i class="pill warn">Bedroom gate not met</i>'}</div>
        <p>${esc(p.ai_summary || "")}</p>
        ${scoreBars(p.scores, PROP_CRITERIA, true)}
        ${(p.red_flags || []).length ? `<div class="section-title">Red flags</div><ul class="list">${p.red_flags.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${(p.verify_checklist || []).length ? `<div class="section-title">Confirm in writing before any deposit</div><ul class="list">${p.verify_checklist.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ` : `<p class="msg info">Still being scored. This usually takes under a minute; the page updates by itself.</p>`}
      ${p.notes ? `<div class="section-title">Notes from whoever added it</div><p>${esc(p.notes)}</p>` : ""}
      ${p.description ? `<details class="quiet"><summary>Listing description</summary><p>${esc(p.description)}</p></details>` : ""}
      <details class="quiet"><summary>More</summary>Added ${fmtDate(p.created_at)}${p.submitted_by ? ` by ${esc(nameOf(p.submitted_by))} (${esc(householdOf(p.submitted_by))})` : " from the decision packet"}.</details>
      ${mine || isAdmin() ? `<div class="actions">
        <button class="btn small" data-rescore-prop="${p.id}">Re-run scoring</button>
        <button class="btn small" data-edit-prop="${p.id}">Edit details</button>
        <button class="btn small danger" data-del-prop="${p.id}">Delete</button></div>` : ""}`);
  }

  // ---------- my picks ----------
  function renderMine() {
    const hh = S.profile.household;
    const mine = S.props.filter((p) => householdOf(p.submitted_by) === hh);
    const fin = mine.filter((p) => p.is_finalist);
    const cap = S.settings.voting?.max_finalists_per_household ?? 2;
    $("#finalist-meter").innerHTML = `<b>${esc(hh)}</b> · ${mine.length} house${mine.length === 1 ? "" : "s"} added · <b>${fin.length} of ${cap}</b> finalists starred ${fin.length < cap ? `<span class="muted">— star ${cap - fin.length} more to fill your slots</span>` : `<span class="muted">— all set</span>`}`;
    $("#mine-list").innerHTML = mine.length ? mine.map((p) => `<div class="card mine-item">
      <div><div class="title" style="font-weight:600"><a href="#" data-open-prop="${p.id}">${esc(p.title)}</a></div>
      <div class="meta muted tiny">${esc(destOf(p)?.name || p.city)} · ${p.bedrooms ?? "?"} BR · ${p.status === "scored" ? p.total + "/100" : "scoring…"} ${p.status === "scored" && !p.gate_pass ? '· <i class="pill warn">bedroom gate ✗</i>' : ""} · added by ${esc(nameOf(p.submitted_by))}</div></div>
      <div class="actions"><button class="star-btn ${p.is_finalist ? "on" : ""}" data-star="${p.id}" ${p.status !== "scored" ? "disabled" : ""}>${p.is_finalist ? "★ Finalist" : "☆ Make finalist"}</button></div>
    </div>`).join("") : `<p class="empty">Your household hasn't added a house yet.</p>`;
  }

  async function toggleFinalist(id) {
    const p = S.props.find((x) => x.id === id);
    const { error } = await sb.from("properties").update({ is_finalist: !p.is_finalist }).eq("id", id);
    if (error) {
      if (/finalist_cap/.test(error.message)) toast("Your household already has its two finalists. Un-star one first.", 4500);
      else toast(error.message, 5000);
      return;
    }
    if (!p.is_finalist && !p.gate_pass) toast("Starred. Heads up: the scorer doesn't think this has 7 real bedrooms.", 5000);
    await loadAll(); renderAll();
  }

  function wireForms() {
    // add-a-house flow
    const pf = $("#preview-form"), sf = $("#submit-form");
    const showSubmit = (pre) => {
      pf.hidden = true; sf.hidden = false;
      const note = $("#prefill-note");
      note.hidden = !pre?.note; note.textContent = pre?.note || "";
      sf.url.value = pre?.url || "";  // server hands back the cleaned-up link sf.image_url.value = pre?.image_url || ""; sf.description.value = pre?.description || "";
      sf.rating.value = pre?.rating ?? ""; sf.review_count.value = pre?.review_count ?? "";
      sf.title.value = pre?.title || ""; sf.city.value = pre?.city || ""; sf.state.value = pre?.state || "";
      sf.bedrooms.value = pre?.bedrooms ?? ""; sf.bathrooms.value = pre?.bathrooms ?? ""; sf.sleeps.value = pre?.sleeps ?? "";
      sf.price_night.value = ""; sf.price_total.value = ""; sf.notes.value = "";
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
          const r = await callFn("ingest", { action: "submit", ...f });
          step(`<span class="step done">Placed in ${esc(r.destination.name)}${r.destination_created ? " (new destination, scored just now)" : ""}</span><span class="step active">Scoring the house against the family rubric (30–60 s)</span>`);
          await loadAll(); renderAll();
          await callFn("ingest", { action: "score", property_id: r.property.id });
          step(`<span class="step done">Placed in ${esc(r.destination.name)}</span><span class="step done">Scored</span>`);
        }
        await loadAll(); renderAll();
        toast("Done. It's on the map and in the lodging list.");
        setTimeout(() => { sf.hidden = true; pf.hidden = false; pf.reset(); prog.hidden = true; }, 1200);
      } catch (err) {
        step(`<span class="step">Problem: ${esc(err.message)}</span>`);
        toast(err.message, 6000);
        await loadAll(); renderAll();
      }
      btn.disabled = false;
    };
    $("#nominate-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      const b = e.target.querySelector("button"); b.disabled = true; b.textContent = "Scoring (30–60 s)…";
      try {
        const r = await callFn("ingest", { action: "nominate", ...f });
        toast(r.destination_created ? `Added and scored: ${r.destination.name}` : `That's already on the list as ${r.destination.name}`);
        e.target.reset(); await loadAll(); renderAll(); showTab("destinations");
      } catch (err) { toast(err.message, 6000); }
      b.disabled = false; b.textContent = "Score this destination";
    };

    // global click delegation
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-open-dest],[data-open-prop],[data-goto-lodging],[data-star],[data-rescore-prop],[data-edit-prop],[data-del-prop],[data-rescore-dest],[data-del-dest]");
      if (!t) return;
      if (t.dataset.openDest) { e.preventDefault(); const d = S.dests.find((x) => x.id === t.dataset.openDest); if (d) destModal(d); }
      else if (t.dataset.openProp) { e.preventDefault(); const p = S.props.find((x) => x.id === t.dataset.openProp); if (p) propModal(p); }
      else if (t.dataset.gotoLodging) { S.filter = t.dataset.gotoLodging; renderLodging(); showTab("lodging"); }
      else if (t.dataset.star) { toggleFinalist(t.dataset.star); }
      else if (t.dataset.rescoreProp) {
        t.disabled = true; t.textContent = "Scoring…";
        try { await callFn("ingest", { action: "score", property_id: t.dataset.rescoreProp }); toast("Re-scored."); await loadAll(); renderAll(); const p = S.props.find((x) => x.id === t.dataset.rescoreProp); if (p) propModal(p); }
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

  // ---------- vote ----------
  function finalists() { return S.props.filter((p) => p.is_finalist && p.status === "scored"); }
  let ranking = null; // array of property ids (local editing state)
  function renderVote() {
    const area = $("#vote-area");
    const fin = finalists();
    const myVote = S.votes.find((v) => v.user_id === S.session.user.id);
    if (ranking === null) ranking = (myVote?.ranking || []).filter((id) => fin.some((p) => p.id === id));
    else ranking = ranking.filter((id) => fin.some((p) => p.id === id));
    const v = S.settings.voting || {};
    const open = votingOpen();
    const deadline = v.closes ? `Voting closes ${fmtDateTime(v.closes)}.` : "";
    const noBallot = S.dests.filter((d) => !fin.some((p) => p.destination_id === d.id)).map((d) => d.name);
    let html = `<div class="notice">${open ? deadline : "<b>Voting is closed.</b>"} ${S.votes.length} of ${S.profiles.length} people have voted.${noBallot.length ? `<br><span class="muted tiny">Not on the ballot (no finalist house yet): ${noBallot.map(esc).join(", ")}.</span>` : ""}</div>`;
    if (!fin.length) { area.innerHTML = html + `<p class="empty">Nothing is on the ballot yet. A house appears here once its household stars it as one of their two finalists on the My picks tab.</p>`; return; }
    const unranked = fin.filter((p) => !ranking.includes(p.id)).sort((a, b) => b.total - a.total);
    const item = (p, i, inRank) => `<div class="rank-item"><div class="n">${inRank ? i + 1 : "·"}</div>
      <div><div class="t"><a href="#" data-open-prop="${p.id}">${esc(p.title)}</a> ${p.gate_pass ? "" : '<i class="pill warn">gate ✗</i>'}</div><div class="s">${esc(destOf(p)?.name || "")} · ${p.bedrooms ?? "?"} BR · ${p.total}/100${p.price_night ? " · " + money(p.price_night) + "/night" : ""}</div></div>
      <div class="ctl">${inRank ? `<button data-mv="${p.id}" data-dir="-1" title="Move up" ${!open ? "disabled" : ""}>▲</button><button data-mv="${p.id}" data-dir="1" title="Move down" ${!open ? "disabled" : ""}>▼</button><button data-rm="${p.id}" title="Remove" ${!open ? "disabled" : ""}>✕</button>` : `<button data-add="${p.id}" title="Add to my ranking" ${!open ? "disabled" : ""}>＋</button>`}</div></div>`;
    html += `<div class="ballot">
      <div class="card"><h3>My ranking</h3><p class="muted tiny">1 = the house I most want us to book. You don't have to rank them all, but a house you leave out gets no points from you.</p>
        <div class="rank-list">${ranking.length ? ranking.map((id, i) => item(fin.find((p) => p.id === id), i, true)).join("") : `<p class="empty">Tap ＋ on a house to start your ranking.</p>`}</div>
        <div class="actions"><button class="btn primary" id="save-vote" ${!open || !ranking.length ? "disabled" : ""}>${myVote ? "Update my vote" : "Cast my vote"}</button>${myVote ? `<span class="muted tiny" style="align-self:center">Last saved ${fmtDateTime(myVote.updated_at)}</span>` : ""}</div></div>
      <div class="card"><h3>On the ballot</h3><p class="muted tiny">Every starred finalist, best score first.</p>
        <div class="rank-list">${unranked.length ? unranked.map((p) => item(p, 0, false)).join("") : `<p class="empty">You've ranked them all.</p>`}</div></div></div>`;
    area.innerHTML = html;
    $$("[data-add]", area).forEach((b) => b.onclick = () => { ranking.push(b.dataset.add); renderVote(); });
    $$("[data-rm]", area).forEach((b) => b.onclick = () => { ranking = ranking.filter((x) => x !== b.dataset.rm); renderVote(); });
    $$("[data-mv]", area).forEach((b) => b.onclick = () => { const i = ranking.indexOf(b.dataset.mv), j = i + Number(b.dataset.dir); if (j < 0 || j >= ranking.length) return; [ranking[i], ranking[j]] = [ranking[j], ranking[i]]; renderVote(); });
    const save = $("#save-vote");
    if (save) save.onclick = async () => {
      save.disabled = true;
      const { error } = await sb.from("votes").upsert({ user_id: S.session.user.id, ranking });
      if (error) toast(/voting_closed/.test(error.message) ? "Voting is closed." : /not_finalist/.test(error.message) ? "One of those houses just left the ballot. Refreshing." : error.message, 5000);
      else toast("Vote saved. You can change it any time before the deadline.");
      await loadAll(); renderAll();
    };
  }

  // ---------- results ----------
  function tally() {
    const fin = finalists();
    const ids = fin.map((p) => p.id);
    const ballots = S.votes.map((v) => (v.ranking || []).filter((id) => ids.includes(id))).filter((b) => b.length);
    const n = ids.length;
    const borda = Object.fromEntries(ids.map((id) => [id, 0]));
    const first = Object.fromEntries(ids.map((id) => [id, 0]));
    ballots.forEach((b) => { b.forEach((id, i) => (borda[id] += n - i)); first[b[0]]++; });
    // instant runoff
    let alive = new Set(ids), rounds = [], winner = null;
    while (alive.size) {
      const counts = Object.fromEntries([...alive].map((id) => [id, 0]));
      let active = 0;
      ballots.forEach((b) => { const top = b.find((id) => alive.has(id)); if (top) { counts[top]++; active++; } });
      rounds.push(counts);
      const sorted = [...alive].sort((a, b) => counts[b] - counts[a] || borda[b] - borda[a]);
      if (!active || alive.size === 1 || counts[sorted[0]] > active / 2) { winner = sorted[0]; break; }
      const loser = sorted[sorted.length - 1];
      alive.delete(loser);
    }
    return { fin, ballots, borda, first, rounds, winner };
  }
  function renderResults() {
    const area = $("#results-area");
    const pub = !!S.settings.voting?.results_public;
    const voters = S.votes.map((v) => nameOf(v.user_id)).filter(Boolean);
    const who = `<div class="notice"><b>${S.votes.length} of ${S.profiles.length}</b> have voted${voters.length ? ": " + voters.map(esc).join(", ") : ""}.${votingOpen() ? "" : " Voting is closed."}</div>`;
    if (!pub && !isAdmin()) { area.innerHTML = who + `<p class="empty">Results stay hidden until Joseph opens them, so nobody votes based on the running score.</p>`; return; }
    const { fin, ballots, borda, first, rounds, winner } = tally();
    if (!fin.length || !ballots.length) { area.innerHTML = who + `<p class="empty">No votes on the ballot yet.</p>`; return; }
    const rows = fin.slice().sort((a, b) => borda[b.id] - borda[a.id]);
    const byDest = {};
    rows.forEach((p) => { const k = destOf(p)?.name || "?"; byDest[k] = (byDest[k] || 0) + borda[p.id]; });
    area.innerHTML = who + (!pub && isAdmin() ? `<p class="msg info">Only you can see this right now. Flip "results public" on the Admin tab to show everyone.</p>` : "") +
      `<div class="table-wrap"><table class="results-table"><tr><th>House</th><th>Destination</th><th>1st choices</th><th>Points</th><th>Final round</th></tr>` +
      rows.map((p) => `<tr class="${p.id === winner ? "winner" : ""}"><td>${p.id === winner ? "🏆 " : ""}<a href="#" data-open-prop="${p.id}">${esc(p.title)}</a></td><td>${esc(destOf(p)?.name || "")}</td><td>${first[p.id]}</td><td>${borda[p.id]}</td><td>${rounds[rounds.length - 1][p.id] ?? "—"}</td></tr>`).join("") + `</table></div>
      <p class="tiny muted">Points: with ${fin.length} houses on the ballot, a 1st-place rank is worth ${fin.length}, 2nd is ${fin.length - 1}, and so on. "Final round" is the instant-runoff count after the weakest houses were eliminated (${rounds.length} round${rounds.length > 1 ? "s" : ""}).</p>
      <div class="section-title">By destination (points)</div><div class="table-wrap"><table class="results-table">${Object.entries(byDest).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table></div>`;
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
        <label>Closes (your local time) <input type="datetime-local" id="adm-closes" value="${closesLocal}"></label>
        <label>Finalists per household <input type="number" id="adm-cap" min="1" max="5" value="${v.max_finalists_per_household ?? 2}"></label>
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
      const value = { ...v, open: $("#adm-open").checked, results_public: $("#adm-public").checked, closes, max_finalists_per_household: Number($("#adm-cap").value) || 2 };
      const { error } = await sb.from("settings").upsert({ key: "voting", value });
      if (error) toast(error.message, 5000); else { toast("Saved."); await loadAll(); renderAll(); }
    };
    $$("[data-reset]", area).forEach((b) => b.onclick = async () => {
      const pw = prompt(`New password for ${b.dataset.reset} (8+ characters):`);
      if (!pw) return;
      try { await callFn("admin", { action: "reset_password", email: b.dataset.reset, password: pw }); toast("Password reset. Tell them the new one."); }
      catch (err) { toast(err.message, 6000); }
    });
  }

  // kick off
  sb.auth.getSession().then(({ data: { session } }) => { S.session = session; if (session) boot(); else showAuth(); });
})();
