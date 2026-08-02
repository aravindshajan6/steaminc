/* =========================================================================
   STEAMINC front-end. No framework, no build step, no bundler.
   ========================================================================= */

const IMG = "https://image.tmdb.org/t/p";
const $ = (sel) => document.querySelector(sel);

// TMDB gives path fragments that need a size prefix; the Archive gives whole URLs.
const art = (path, size = "w500") =>
  !path ? null : /^https?:/.test(path) ? path : `${IMG}/${size}${path}`;

const state = {
  config: { demo: true, defaultRegion: "US", regions: [] },
  region: localStorage.getItem("sc:region") || "US",
  feed: null,
  user: null,
  authMode: "in",
  list: JSON.parse(localStorage.getItem("sc:list") || "[]"),
  open: null, // currently displayed title, so a region change can refresh it
  hits: [],
  cursor: -1,
};

/* ------------------------------------------------------------------ util -- */

const api = (path, params) => {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  });
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Stable hue per title, so a poster-less entry always gets the same artwork.
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function genArt(title) {
  const h = hue(title);
  return `linear-gradient(${h}deg, hsl(${h} 92% 42%), hsl(${(h + 58) % 360} 88% 26%) 55%, hsl(${(h + 200) % 360} 80% 14%))`;
}

const scoreClass = (n) => (n >= 75 ? "" : n >= 55 ? "mid" : "low");
const key = (i) => `${i.media}:${i.id}`;
const saved = (i) => state.list.some((x) => key(x) === key(i));

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("up");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("up"), 2200);
}

const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

// Surfaces the server's own error text — "Password needs at least 8 characters"
// is worth showing verbatim; "Request failed (400)" is not.
async function post(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

/* ------------------------------------------------------------- skeletons -- */

const skelCard = `
  <div class="card skel-card" aria-hidden="true">
    <div class="skel skel-art"></div>
    <div class="card-foot"><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>
  </div>`;

const skeletonScreen = (rows = 3) => `
  <div class="hero-skel" aria-hidden="true">
    <div class="skel skel-flag"></div>
    <div class="skel skel-hero-title"></div>
    <div class="skel skel-hero-title short"></div>
    <div class="skel skel-line wide"></div>
    <div class="skel skel-line wide"></div>
    <div class="skel skel-btn"></div>
  </div>
  ${Array.from({ length: rows }, () => `
    <section class="row">
      <div class="row-head"><div class="skel skel-title"></div><span class="row-rule"></span></div>
      <div class="strip">${skelCard.repeat(8)}</div>
    </section>`).join("")}`;

const sheetSkeleton = () => `
  <div class="skel skel-sheet-hero"></div>
  <div class="sheet-head">
    <div class="skel skel-hero-title"></div>
    <div class="chips">${'<div class="skel skel-chip"></div>'.repeat(4)}</div>
  </div>
  <div class="sheet-grid">
    <div>
      ${'<div class="skel skel-line wide"></div>'.repeat(4)}
    </div>
    <div>
      <div class="skel skel-title"></div>
      ${'<div class="skel skel-band"></div>'.repeat(3)}
    </div>
  </div>`;

/* ------------------------------------------------------------- watchlist -- */

function toggleSave(item) {
  const k = key(item);
  const i = state.list.findIndex((x) => key(x) === k);
  if (i > -1) { state.list.splice(i, 1); toast("removed from list"); }
  else { state.list.unshift({ id: item.id, media: item.media, title: item.title, poster: item.poster, year: item.year, score: item.score }); toast("saved to list"); }
  persistList();
  $("#listCount").textContent = state.list.length;
  markCat();
  document.querySelectorAll(`[data-key="${CSS.escape(k)}"] .card-save`).forEach((b) => b.classList.toggle("on", saved(item)));
  if (state.listOpen) renderRows();
}

// Signed in: the account is the source of truth. Signed out: this browser is.
// Debounced because starring three things quickly should be one write, not three.
function persistList() {
  if (!state.user) {
    localStorage.setItem("sc:list", JSON.stringify(state.list));
    return;
  }
  clearTimeout(persistList.timer);
  persistList.timer = setTimeout(() => {
    post("/api/list", "PUT", { list: state.list }).catch(() => toast("could not sync list"));
  }, 400);
}

/* -------------------------------------------------------------- accounts -- */

function renderAccount() {
  $("#accountLabel").textContent = state.user ? state.user.name : "Sign in";
  $("#account").setAttribute("aria-pressed", String(Boolean(state.user)));
}

// Mirrors PASSWORD_RULES in backend/auth.js. The server is the authority — this
// only exists so someone typing a password is told what is missing as they go,
// rather than after a round trip.
const PW_RULES = {
  len: (p) => p.length >= 8,
  alpha: (p) => /\p{L}/u.test(p),
  num: (p) => /\d/.test(p),
  special: (p) => /[^\p{L}\d]/u.test(p),
};

function passwordState() {
  const pw = $("#authPassword").value;
  const repeat = $("#authRepeat").value;
  const results = Object.fromEntries(Object.entries(PW_RULES).map(([k, fn]) => [k, fn(pw)]));
  results.match = pw.length > 0 && pw === repeat;
  return { pw, repeat, results, ok: Object.values(results).every(Boolean) };
}

function paintPasswordRules() {
  if (state.authMode !== "up") return;
  const { repeat, results } = passwordState();
  for (const [rule, pass] of Object.entries(results)) {
    const li = $(`#pwRules li[data-rule="${rule}"]`);
    if (!li) continue;
    li.classList.toggle("ok", pass);
    // Only call a mismatch out once they have actually started retyping.
    li.classList.toggle("bad", rule === "match" && !pass && repeat.length > 0);
  }
}

function openAuth(mode = "in") {
  state.authMode = mode;
  const signedIn = mode === "account";
  const signingUp = mode === "up";
  $("#authWrap").hidden = false;
  $("#authError").hidden = true;
  $("#authFields").hidden = signedIn;
  $("#authAccount").hidden = !signedIn;
  $("#nameField").hidden = !signingUp;
  $("#repeatField").hidden = !signingUp;
  $("#pwRules").hidden = !signingUp;
  $("#authPassword").autocomplete = signingUp ? "new-password" : "current-password";
  $("#authPassword").placeholder = signingUp ? "Letters, numbers and a symbol" : "Your password";
  $("#authSwap").parentElement.hidden = signedIn;
  if (signingUp) paintPasswordRules();

  const copy = {
    in: ["SIGN IN", "Your list stops living in this browser and starts following you.", "Sign in →", "No account yet?", "Create one"],
    up: ["CREATE ACCOUNT", "One email, one password. Nothing is sent to anyone.", "Create account →", "Already have one?", "Sign in"],
    account: ["YOUR ACCOUNT", "Your list is saved to this account.", "Sign out", "", ""],
  }[mode];

  $("#authTitle").textContent = copy[0];
  $("#authTitle").dataset.text = copy[0];
  $("#authSub").textContent = copy[1];
  $("#authGo").textContent = copy[2];
  $("#authSwapText").textContent = copy[3];
  $("#authSwap").textContent = copy[4];
  if (signedIn) paintAccount();
  else setTimeout(() => $(mode === "up" ? "#authName" : "#authEmail").focus(), 30);
}

const closeAuth = () => { $("#authWrap").hidden = true; };

function paintAccount() {
  const u = state.user;
  if (!u) return;
  $("#acctAvatar").textContent = (u.name || u.email)[0] || "?";
  $("#acctName").textContent = u.name;
  $("#acctEmail").textContent = u.email;
  $("#acctRename").value = u.name;

  const list = state.list || [];
  const free = list.filter((i) => i.media === "free").length;
  const since = u.created
    ? new Date(u.created).toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : "—";

  $("#acctStats").innerHTML = `
    <div class="acct-stat"><b>${list.length}</b><span>Saved</span></div>
    <div class="acct-stat"><b>${free}</b><span>Free to watch</span></div>
    <div class="acct-stat"><b>${esc(since)}</b><span>Member since</span></div>`;
}

async function saveName() {
  const name = $("#acctRename").value.trim();
  if (!name) return authError("A display name is required.");
  try {
    const d = await post("/api/auth/profile", "POST", { name });
    state.user = d.user;
    renderAccount();
    paintAccount();
    toast("name updated");
  } catch (err) {
    authError(err.message);
  }
}

async function deleteAccount() {
  const password = $("#acctDelPw").value;
  if (!password) return authError("Enter your password to confirm.");
  try {
    await post("/api/auth/delete", "POST", { password });
    state.user = null;
    state.list = [];
    localStorage.removeItem("sc:list");
    closeAuth();
    renderAccount();
    renderRows();
    $("#listCount").textContent = 0;
    toast("account deleted");
  } catch (err) {
    authError(err.message);
  }
}

function authBusy(on) {
  $("#authGo").disabled = on;
  $("#authGo").classList.toggle("busy", on);
}

function authError(msg) {
  const el = $("#authError");
  el.textContent = msg;
  el.hidden = false;
}

// Anything starred before signing in comes along, rather than being silently dropped.
function mergeLists(remote, local) {
  const out = [...remote];
  for (const item of local) if (!out.some((x) => key(x) === key(item))) out.push(item);
  return out.slice(0, 500);
}

async function submitAuth(e) {
  e.preventDefault();
  if (state.authMode === "account") return signOut();

  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const name = $("#authName").value.trim();
  if (!email || !password) return authError("Email and password are both required.");

  if (state.authMode === "up") {
    const { repeat, results, ok } = passwordState();
    paintPasswordRules();
    if (!results.match && repeat.length === 0) return authError("Please repeat your password.");
    if (!results.match) return authError("The two passwords do not match.");
    if (!ok) return authError("Your password is still missing something — see the checklist.");
  }

  authBusy(true);
  $("#authError").hidden = true;
  try {
    const path = state.authMode === "up" ? "/api/auth/signup" : "/api/auth/login";
    const data = await post(path, "POST", { email, password, name });

    state.user = data.user;
    const local = JSON.parse(localStorage.getItem("sc:list") || "[]");
    state.list = mergeLists(data.list || [], local);
    if (local.length) {
      await post("/api/list", "PUT", { list: state.list }).catch(() => {});
      localStorage.removeItem("sc:list");
    }

    $("#authForm").reset();
    closeAuth();
    renderAccount();
    renderRows();
    $("#listCount").textContent = state.list.length;
    toast(`welcome, ${data.user.name}`);
  } catch (err) {
    authError(err.message);
  } finally {
    authBusy(false);
  }
}

async function signOut() {
  authBusy(true);
  await post("/api/auth/logout", "POST").catch(() => {});
  state.user = null;
  state.list = JSON.parse(localStorage.getItem("sc:list") || "[]");
  authBusy(false);
  closeAuth();
  renderAccount();
  renderRows();
  $("#listCount").textContent = state.list.length;
  toast("signed out");
}

/* ----------------------------------------------------------------- cards -- */

function cardHTML(item) {
  const hasArt = Boolean(item.poster);
  const cls = hasArt ? "card-art" : "card-art gen";
  const bg = hasArt ? `url('${art(item.poster)}') center/cover` : genArt(item.title);
  return `
    <button class="card" data-key="${esc(key(item))}" data-id="${item.id}" data-media="${item.media}">
      <div class="${cls}" style="background:${bg}">
        ${hasArt ? "" : `<span>${esc(item.title)}</span>`}
        ${item.score ? `<span class="card-score ${scoreClass(item.score)}">${item.score}</span>` : ""}
        <span class="card-save ${saved(item) ? "on" : ""}" data-save="1" title="Save to list">★</span>
      </div>
      <div class="card-foot">
        <div class="card-name">${esc(item.title)}</div>
        <div class="card-sub">${esc(item.year || "—")} · ${item.media === "tv" ? "series" : item.media === "free" ? "free to watch" : "film"}</div>
      </div>
    </button>`;
}

function rowHTML(row) {
  return `
    <section class="row">
      <div class="row-head">
        <h2 class="row-title glitch" data-text="${esc(row.label)}">${esc(row.label)}</h2>
        <span class="row-tag">${esc(row.tag || "list")}</span>
        <span class="row-rule"></span>
        ${row.key === "list" ? "" : `<button class="view-all" data-row="${esc(row.key)}" data-label="${esc(row.label)}">View all →</button>`}
      </div>
      <div class="strip">${row.items.map(cardHTML).join("")}</div>
    </section>`;
}

function renderRows() {
  const rows = [...(state.feed?.rows || [])];
  if (state.listOpen) {
    rows.unshift({
      key: "list", label: "Your List", tag: "saved",
      items: state.list.length ? state.list : [],
    });
  }
  const notice = state.feed?.demo
    ? `<div class="notice">▲ The <b>Free To Watch</b> row below is real and playable right now. The other rows are bundled placeholders — drop a free TMDB key into .env and restart to swap them for the real catalog, real artwork and live "where to watch" data.</div>`
    : state.feed?.degraded
      ? `<div class="notice">▲ TMDB is not responding right now. Showing sample data so the page still works.</div>`
      : "";

  const emptyList = state.listOpen && !state.list.length
    ? `<div class="notice">Your list is empty. Hit ★ on anything to park it here.</div>` : "";

  $("#rows").innerHTML = notice + emptyList + rows.filter((r) => r.items.length).map(rowHTML).join("");
  wireCards();
  document.querySelectorAll(".view-all").forEach((b) =>
    b.addEventListener("click", () =>
      openBrowse({ kind: "row", key: b.dataset.row, name: b.dataset.label })));
}

function wireCards() {
  document.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", (e) => {
      // Archive ids are slugs — coercing with + turns them into NaN.
      const media = card.dataset.media;
      const item = { media, id: media === "free" ? card.dataset.id : Number(card.dataset.id) };
      if (e.target.dataset.save) {
        e.stopPropagation();
        const found = findItem(card.dataset.key) || { ...item, title: card.querySelector(".card-name").textContent };
        toggleSave(found);
        return;
      }
      openSheet(item.media, item.id);
    });
    if (!document.documentElement.classList.contains("chill")) attachTilt(card);
  });
}

function findItem(k) {
  for (const row of state.feed?.rows || []) {
    const hit = row.items.find((i) => key(i) === k);
    if (hit) return hit;
  }
  return state.list.find((i) => key(i) === k) || state.hits.find((i) => key(i) === k);
}

// Pointer-tracked 3D tilt. Purely decorative, skipped entirely in chill mode.
function attachTilt(el) {
  const art = el;
  art.addEventListener("pointermove", (e) => {
    const r = art.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    art.style.transform = `perspective(700px) rotateY(${px * 13}deg) rotateX(${-py * 13}deg) translateZ(14px)`;
  });
  art.addEventListener("pointerleave", () => { art.style.transform = ""; });
}

/* ------------------------------------------------------------------ hero -- */

/* ----------------------------------------------------------------- seasons -- */

const seasonsSection = (d) => {
  const list = d.seasonList || [];
  if (d.media !== "tv" || !list.length) return "";
  // Open on the first real season — landing on Specials is rarely what anyone wants.
  const first = list.find((s) => !s.specials) || list[0];
  return `
    <div class="sec-cap">Episodes</div>
    <div class="seasons" id="seasonTabs" role="tablist">
      ${list.map((s) => `
        <button class="season-tab" role="tab" data-season="${s.number}"
                aria-selected="${s.number === first.number}">
          ${esc(s.name)} <span>${s.episodes}</span>
        </button>`).join("")}
    </div>
    <div class="eps" id="epList" data-tv="${esc(d.id)}"></div>`;
};

function episodeHTML(e) {
  const still = e.still ? `url('${art(e.still, "w300")}') center/cover` : genArt(e.name);
  return `
    <li class="ep">
      <div class="ep-still" style="background:${still}">
        <span class="ep-no">E${e.number}</span>
      </div>
      <div class="ep-body">
        <div class="ep-head">
          <h4 class="ep-name">${esc(e.name)}</h4>
          ${e.score ? `<span class="ep-score">${e.score}</span>` : ""}
        </div>
        <p class="ep-meta">${[e.air, e.runtime ? `${e.runtime} min` : null].filter(Boolean).map(esc).join(" · ")}</p>
        ${e.overview ? `<p class="ep-blurb">${esc(e.overview)}</p>` : ""}
      </div>
    </li>`;
}

async function loadSeason(tvId, number) {
  const box = $("#epList");
  if (!box) return;
  box.innerHTML = `<div class="skel skel-band"></div>`.repeat(3);
  try {
    const data = await api("/api/season", { id: tvId, season: number });
    // The sheet may have moved on, or another season tab been clicked, mid-flight.
    if (!$("#epList") || $("#epList").dataset.tv !== String(tvId)) return;
    if (state.season !== number) return;
    box.innerHTML = data.episodes.length
      ? `<ul class="ep-list">${data.episodes.map(episodeHTML).join("")}</ul>`
      : `<p class="cmt-empty">No episode details listed for this season.</p>`;
  } catch {
    box.innerHTML = `<p class="cmt-empty">Could not load that season.</p>`;
  }
}

function wireSeasons(d) {
  const tabs = $("#seasonTabs");
  if (!tabs) return;
  const list = d.seasonList || [];
  const first = list.find((s) => !s.specials) || list[0];
  state.season = first.number;
  loadSeason(d.id, first.number);

  tabs.querySelectorAll(".season-tab").forEach((t) =>
    t.addEventListener("click", () => {
      const n = Number(t.dataset.season);
      if (n === state.season) return;
      state.season = n;
      tabs.querySelectorAll(".season-tab").forEach((x) =>
        x.setAttribute("aria-selected", String(Number(x.dataset.season) === n)));
      loadSeason(d.id, n);
    }));
}

/* ---------------------------------------------------------------- comments -- */

const timeAgo = (iso) => {
  const secs = Math.max(1, Math.round((Date.now() - new Date(iso)) / 1000));
  const steps = [[60, "s"], [60, "m"], [24, "h"], [7, "d"], [4.35, "w"], [12, "mo"]];
  let v = secs, unit = "s";
  for (const [div, label] of steps) {
    if (v < div) break;
    v = Math.round(v / div);
    unit = label;
  }
  return `${v}${unit} ago`;
};

function commentHTML(c) {
  return `
    <li class="cmt" data-id="${esc(c.id)}">
      <div class="cmt-head">
        <span class="cmt-who">${esc(c.userName || "someone")}</span>
        <span class="cmt-when">${esc(timeAgo(c.created))}</span>
        ${c.mine ? `<button class="cmt-del" data-del="${esc(c.id)}" aria-label="Delete your comment">✕</button>` : ""}
      </div>
      <p class="cmt-body">${esc(c.body)}</p>
    </li>`;
}

function renderComments(list) {
  const box = $("#cmtList");
  if (!box) return;
  box.innerHTML = list.length
    ? list.map(commentHTML).join("")
    : `<li class="cmt-empty">No one has said anything yet. Go first.</li>`;

  box.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await post(`/api/comments?commentId=${encodeURIComponent(b.dataset.del)}&media=${state.open.media}&id=${encodeURIComponent(state.open.id)}`, "DELETE");
        state.comments = state.comments.filter((c) => c.id !== b.dataset.del);
        renderComments(state.comments);
        toast("comment removed");
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    }));
}

async function loadComments(media, id) {
  try {
    const { comments } = await api("/api/comments", { media, id });
    // The sheet may have moved on while this was in flight.
    if (!state.open || String(state.open.id) !== String(id)) return;
    state.comments = comments;
    renderComments(comments);
    const n = $("#cmtCount");
    if (n) n.textContent = comments.length;
  } catch {
    const box = $("#cmtList");
    if (box) box.innerHTML = `<li class="cmt-empty">Comments are unavailable right now.</li>`;
  }
}

async function submitComment(e) {
  e.preventDefault();
  const input = $("#cmtInput");
  const body = input.value.trim();
  if (body.length < 2) return;

  const btn = $("#cmtSend");
  btn.disabled = true;
  try {
    const { comment } = await post("/api/comments?media=" + state.open.media + "&id=" + encodeURIComponent(state.open.id), "POST", { body });
    state.comments = [comment, ...(state.comments || [])];
    input.value = "";
    renderComments(state.comments);
    $("#cmtCount").textContent = state.comments.length;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

const commentsSection = () => `
  <div class="sec-cap">Comments <span id="cmtCount">0</span></div>
  ${state.user
    ? `<form class="cmt-form" id="cmtForm">
         <textarea id="cmtInput" maxlength="1000" rows="2" placeholder="What did you make of it?"></textarea>
         <button class="btn btn-primary" id="cmtSend" type="submit">Post</button>
       </form>`
    : `<p class="cmt-signin">
         <button class="btn" id="cmtSignIn">Sign in to comment</button>
       </p>`}
  <ul class="cmt-list" id="cmtList"><li class="cmt-empty">Loading…</li></ul>`;

/* ---------------------------------------------------------- hero carousel -- */

const HERO_MS = 7000;

function startHeroCarousel(items) {
  const heroes = (items || []).filter(Boolean);
  if (!heroes.length) return;

  state.heroes = heroes;
  state.heroIdx = 0;
  document.documentElement.style.setProperty("--hero-ms", `${HERO_MS}ms`);

  const single = heroes.length < 2;
  $("#heroPrev").hidden = single;
  $("#heroNext").hidden = single;
  $("#heroDots").innerHTML = single
    ? ""
    : heroes.map((h, i) =>
        `<button class="hero-dot" role="tab" data-i="${i}" aria-selected="${i === 0}" aria-label="${esc(h.title)}"></button>`).join("");

  $("#heroDots").querySelectorAll(".hero-dot").forEach((d) =>
    d.addEventListener("click", () => goHero(+d.dataset.i)));

  renderHero(heroes[0]);
  if (!single) armHeroTimer();
}

function armHeroTimer() {
  clearTimeout(state.heroTimer);
  // Auto-advance is motion. Chill mode and reduced-motion users get arrows and
  // dots, and nothing that moves without being asked.
  if (document.documentElement.classList.contains("chill")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  state.heroTimer = setTimeout(() => goHero(state.heroIdx + 1), HERO_MS);
}

function goHero(next) {
  const heroes = state.heroes || [];
  if (heroes.length < 2) return;
  const i = (next + heroes.length) % heroes.length;
  if (i === state.heroIdx) return;

  const hero = $("#hero");
  hero.classList.add("swapping");
  clearTimeout(state.heroTimer);

  // Swap at the midpoint of the fade so the change itself is never visible.
  setTimeout(() => {
    state.heroIdx = i;
    renderHero(heroes[i]);
    hero.classList.remove("swapping");
    $("#heroDots").querySelectorAll(".hero-dot").forEach((d) =>
      d.setAttribute("aria-selected", String(+d.dataset.i === i)));
    armHeroTimer();
  }, 450);
}

function renderHero(item) {
  if (!item) return;
  $("#hero").hidden = false;
  $("#heroArt").style.background = item.backdrop
    ? `url('${art(item.backdrop, "w1280")}') center 22%/cover`
    : genArt(item.title);
  const t = $("#heroTitle");
  t.textContent = item.title;
  t.dataset.text = item.title;
  const isFree = item.media === "free";
  $("#heroFlag").textContent = isFree ? "▶ FREE TO WATCH" : "▶ TOP OF THE PILE";
  $("#heroMeta").textContent = [
    item.year,
    isFree ? "PUBLIC DOMAIN" : item.media === "tv" ? "SERIES" : "FILM",
    item.score ? `${item.score}% LIKED` : null,
  ].filter(Boolean).join("  ///  ");
  $("#heroBlurb").textContent = item.overview || "No synopsis on file. Go in blind.";
  $("#heroOpen").textContent = isFree ? "▶ Watch it free →" : "Where can I watch this →";
  $("#heroOpen").onclick = () => openSheet(item.media, item.id);
  $("#heroSave").onclick = () => toggleSave(item);
}

/* ---------------------------------------------------------------- search -- */

function openSearch() {
  $("#searchWrap").hidden = false;
  $("#q").focus();
  $("#q").select();
}
function closeSearch() {
  $("#searchWrap").hidden = true;
  state.cursor = -1;
}

const runSearch = debounce(async (q) => {
  if (q.trim().length < 2) {
    $("#results").innerHTML = `<div class="empty">Two letters and we start looking.</div>`;
    state.hits = [];
    return;
  }
  try {
    const data = await api("/api/search", { q });
    state.hits = data.items;
    state.cursor = data.items.length ? 0 : -1;
    renderHits();
  } catch {
    $("#results").innerHTML = `<div class="empty">Search is down. Try again in a moment.</div>`;
  }
}, 180);

function renderHits() {
  if (!state.hits.length) {
    $("#results").innerHTML = `<div class="empty">Nothing matched. Try fewer words.</div>`;
    return;
  }
  $("#results").innerHTML = state.hits
    .map((i, n) => `
      <button class="hit" data-n="${n}" ${n === state.cursor ? 'aria-selected="true"' : ""}>
        <span class="hit-art" style="background:${i.poster ? `url('${art(i.poster, "w185")}') center/cover` : genArt(i.title)}"></span>
        <span>
          <span class="hit-name">${esc(i.title)}</span>
          <span class="hit-sub">${esc(i.year || "—")} · ${i.media === "tv" ? "series" : i.media === "free" ? "▶ free to watch" : "film"}${i.score ? ` · ${i.score}%` : ""}</span>
        </span>
      </button>`)
    .join("");
  document.querySelectorAll(".hit").forEach((el) =>
    el.addEventListener("click", () => {
      const i = state.hits[+el.dataset.n];
      closeSearch();
      openSheet(i.media, i.id);
    }));
}

function moveCursor(delta) {
  if (!state.hits.length) return;
  state.cursor = (state.cursor + delta + state.hits.length) % state.hits.length;
  renderHits();
  document.querySelector('.hit[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

/* ---------------------------------------------------------------- detail -- */

async function openSheet(media, id, updateHash = true) {
  // Archive identifiers are slugs; TMDB ids are numbers. Keep both as-is.
  state.open = { media, id: media === "free" ? String(id) : Number(id) };
  if (updateHash) location.hash = `/t/${media}/${id}`;
  $("#sheetWrap").hidden = false;
  $("#sheetBody").innerHTML = sheetSkeleton();
  try {
    const d = await api("/api/title", { media, id, region: state.region });
    renderSheet(d);
  } catch {
    $("#sheetBody").innerHTML = `<div class="empty">Could not load that one.</div>`;
  }
}

function closeSheet(updateHash = true) {
  $("#sheetWrap").hidden = true;
  state.open = null;
  if (updateHash && location.hash) history.pushState("", document.title, location.pathname);
}

// Titles and searches both get real URLs, so either one is linkable.
function routeFromHash() {
  const t = location.hash.match(/^#\/t\/(movie|tv|free)\/(.+)$/);
  if (t) {
    const id = t[1] === "free" ? decodeURIComponent(t[2]) : Number(t[2]);
    if (t[1] !== "free" && !Number.isFinite(id)) return;
    if (state.open && state.open.media === t[1] && String(state.open.id) === String(id)) return;
    return openSheet(t[1], id, false);
  }

  const row = location.hash.match(/^#\/r\/([a-z]+)\/(\d+)$/);
  if (row) {
    const page = Number(row[2]);
    const b = state.browse;
    if (b?.kind === "row" && b.key === row[1] && b.page === page) return;
    if (b?.kind === "row" && b.key === row[1]) { b.page = page; return loadBrowse(); }
    return openBrowse({ kind: "row", key: row[1], page, name: null }, { push: false });
  }

  const cat = location.hash.match(/^#\/c\/(movie|tv)\/([\d,]+)(?:\/(\d+))?$/);
  if (cat) {
    const page = Number(cat[3] || 1);
    const b = state.browse;
    if (b?.kind === "genre" && b.genre === cat[2] && b.page === page) return;
    // Reads the sidebar, which replaced the old chip bar. Falls back to the row
    // label the API returns rather than the useless generic "Category".
    const name = $(`#railGenres [data-genre="${CSS.escape(cat[2])}"]`)?.dataset.name || null;
    return openBrowse({ kind: "genre", media: cat[1], genre: cat[2], page, name }, { push: false });
  }

  if (state.browse && !/^#\/(c|r)\//.test(location.hash)) closeBrowse();

  const auth = location.hash.match(/^#\/(signin|signup)$/);
  if (auth) {
    return openAuth(state.user ? "account" : auth[1] === "signup" ? "up" : "in");
  }

  const q = location.hash.match(/^#\/q\/(.+)$/);
  if (q) {
    const term = decodeURIComponent(q[1]);
    openSearch();
    $("#q").value = term;
    runSearch(term);
    return;
  }

  if (!$("#sheetWrap").hidden) closeSheet(false);
}

// TMDB gives one JustWatch link per title, not per provider, so every chip points
// there. Still beats inert text: it is one click to the service that has it.
function provRow(label, list, cls, link) {
  if (!list?.length) return "";
  const chip = (p) => `
    ${p.logo_path ? `<img src="${art(p.logo_path, "w45")}" alt="" />` : ""}
    <span>${esc(p.provider_name)}</span>`;
  return `
    <div class="watch-band ${cls}">
      <h4>${label}</h4>
      <div class="provs">
        ${list.map((p) => (link
          ? `<a class="prov" href="${esc(link)}" target="_blank" rel="noopener" title="Open ${esc(p.provider_name)} via JustWatch">${chip(p)} <b>↗</b></a>`
          : `<span class="prov">${chip(p)}</span>`)).join("")}
      </div>
    </div>`;
}

function renderSheet(d) {
  const isFree = d.media === "free";
  const providers = d.providers || {};
  const anywhere = ["stream", "free", "ads", "rent", "buy"].some((k) => providers[k]?.length);
  const regionName = state.config.regions.find((r) => r.code === state.region)?.name || state.region;

  const watch = isFree
    ? `<div class="watch-band">
         <h4>Free — no account, no service</h4>
         <p style="font-size:13px;line-height:1.6;margin:0 0 10px">
           Public domain or openly licensed, streamed straight from the Internet Archive.
           Press play on the left.
         </p>
         ${d.creator ? `<p class="tiny">Credited to ${esc(d.creator)}</p>` : ""}
         ${d.rights ? `<p class="tiny">${esc(d.rights.slice(0, 200))}</p>` : ""}
         ${d.license ? `<p class="tiny"><a href="${esc(d.license)}" target="_blank" rel="noopener">License terms ↗</a></p>` : ""}
         <p class="tiny"><a href="${esc(d.source)}" target="_blank" rel="noopener">View on archive.org ↗</a></p>
       </div>`
    : anywhere
    ? [
        provRow("Included with subscription", providers.stream, "sub", d.providerLink),
        provRow("Free", providers.free, "sub", d.providerLink),
        provRow("Free with ads", providers.ads, "sub", d.providerLink),
        provRow("Rent", providers.rent, "rent", d.providerLink),
        provRow("Buy", providers.buy, "buy", d.providerLink),
      ].join("")
    : `<div class="nowhere">Nothing licensed in ${esc(regionName)} right now.<br />Try another region above, or check back — catalogs rotate constantly.</div>`;

  // A licensed title has no player here, by design. A public-domain one does.
  const freeBand = d.freeMatch
    ? `<div class="watch-band free-hit">
         <h4>▶ This one is free</h4>
         <p style="font-size:13px;line-height:1.6;margin:0 0 12px">
           A public domain copy is on the Internet Archive. No account, no subscription.
         </p>
         <button class="btn btn-primary" data-free="${esc(d.freeMatch.id)}">▶ Watch it free now</button>
       </div>`
    : "";

  // Suppressed when a free copy exists — "nothing to play" next to a play button is a lie.
  const demoNote = d.demo && !d.freeMatch
    ? `<div class="nowhere">This is a bundled placeholder title, so there is nothing to play and
         the services listed are fake. Add a TMDB key for the real catalog — or open anything in the
         <b>Free To Watch</b> row, which is real video.</div>`
    : "";

  const meta = [
    d.year, d.runtime ? `${d.runtime} min` : null,
    d.seasons ? `${d.seasons} season${d.seasons > 1 ? "s" : ""}` : null,
    d.status, ...(d.genres || []),
  ].filter(Boolean);

  $("#sheetBody").innerHTML = `
    <div class="sheet-hero" style="background:${d.backdrop ? `url('${IMG}/w1280${d.backdrop}') center 25%/cover` : genArt(d.title)}"></div>
    <div class="sheet-head">
      <h2 class="sheet-title glitch" id="sheetTitle" data-text="${esc(d.title)}">${esc(d.title)}</h2>
      ${d.tagline ? `<p class="sheet-tag">“${esc(d.tagline)}”</p>` : ""}
      <div class="chips">
        ${d.score ? `<span class="chip hot">${d.score}% liked</span>` : ""}
        ${meta.map((m) => `<span class="chip">${esc(m)}</span>`).join("")}
      </div>
    </div>

    <div class="sheet-grid">
      <div>
        ${isFree ? (d.stream ? `
          <div class="sec-cap">▶ Watch it now</div>
          <video class="player" controls playsinline preload="metadata" poster="${esc(art(d.poster) || "")}">
            <source src="${esc(d.stream)}" type="${esc(d.streamType || "video/mp4")}" />
            ${d.captions ? `<track kind="captions" src="${esc(d.captions)}" srclang="en" label="English" default />` : ""}
            Your browser cannot play this file.
          </video>` : `
          <div class="nowhere">This item has no browser-playable encoding.
            <a href="${esc(d.source)}" target="_blank" rel="noopener">Open it on archive.org ↗</a>
          </div>`) : ""}

        <p class="sheet-blurb">${esc(d.overview || "No synopsis on file.")}</p>

        ${d.trailer ? `
          <div class="sec-cap alt">Trailer</div>
          <iframe class="trailer" src="https://www.youtube-nocookie.com/embed/${esc(d.trailer.key)}"
                  title="${esc(d.trailer.name)}" allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
                  referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>` : ""}

        ${d.cast?.length ? `
          <div class="sec-cap alt">Cast</div>
          <div class="cast">
            ${d.cast.map((c) => `
              <div class="who">
                <div class="who-face" style="background:${c.photo ? `url('${IMG}/w185${c.photo}') center/cover` : genArt(c.name)}">${c.photo ? "" : esc(c.name[0] || "?")}</div>
                <div class="who-name">${esc(c.name)}</div>
                <div class="who-role">${esc(c.role)}</div>
              </div>`).join("")}
          </div>` : ""}
      </div>

      <div>
        <div class="sec-cap">${isFree ? "How to watch" : `Where to watch · ${esc(state.region)}`}</div>
        <div class="watch">${freeBand}${demoNote}${watch}</div>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" id="sheetSave">★ ${saved(d) ? "Saved" : "Save it"}</button>
          ${d.providerLink ? `<a class="btn" href="${esc(d.providerLink)}" target="_blank" rel="noopener">All options ↗</a>` : ""}
        </div>
        <p class="attrib">
          ${isFree
            ? "Streamed from the Internet Archive. Public domain or openly licensed."
            : "Availability by JustWatch via TMDB. Links go to licensed services only."}
        </p>
      </div>
    </div>

    ${d.recommendations?.length ? `
      <div style="padding:0 clamp(16px,3.4vw,34px) 30px">
        <div class="sec-cap">If you liked that</div>
        <div class="strip" style="padding-left:0;padding-right:0">${d.recommendations.map(cardHTML).join("")}</div>
      </div>` : ""}

    ${d.media === "tv" && d.seasonList?.length
      ? `<div class="seasons-wrap">${seasonsSection(d)}</div>` : ""}

    <div class="cmt-wrap">${commentsSection()}</div>
  `;

  $("#sheetSave").onclick = () => { toggleSave(d); $("#sheetSave").innerHTML = `★ ${saved(d) ? "Saved" : "Save it"}`; };
  wireSeasons(d);
  if ($("#cmtForm")) $("#cmtForm").addEventListener("submit", submitComment);
  if ($("#cmtSignIn")) $("#cmtSignIn").onclick = () => openAuth("in");
  loadComments(d.media, d.id);
  $("#sheetBody").querySelector("[data-free]")?.addEventListener("click", (e) =>
    openSheet("free", e.currentTarget.dataset.free));
  wireCards();
  $("#sheetWrap").scrollTop = 0;
}

/* ------------------------------------------------------------- categories -- */

const SORTS = [
  ["popularity.desc", "Most popular"],
  ["vote_average.desc", "Highest rated"],
  ["primary_release_date.desc", "Newest first"],
  ["revenue.desc", "Biggest hits"],
];

// Quick links sit above the genres — the things people reach for most often,
// which are not genres at all.
const RAIL_QUICK = [
  { id: "home",  ic: "◀", label: "Home" },
  { id: "free",  ic: "▶", label: "Free To Watch", hot: true },
  { id: "trending", ic: "◆", label: "Trending Now" },
  { id: "top",   ic: "★", label: "Highest Rated" },
  { id: "tv",    ic: "▤", label: "Series" },
  { id: "list",  ic: "☰", label: "Your List" },
];

function renderCats(genres) {
  const movie = (genres?.movie || []).slice(0, 18);

  $("#railQuick").innerHTML = RAIL_QUICK.map((q) => `
    <button class="rail-item ${q.hot ? "hot" : ""}" data-quick="${q.id}">
      <span class="ic">${q.ic}</span>${esc(q.label)}
      ${q.id === "list" ? `<span class="n" id="railListCount">${state.list.length}</span>` : ""}
    </button>`).join("");

  $("#railGenres").innerHTML = movie.map((g, i) => `
    <button class="rail-item" data-genre="${esc(g.id)}" data-name="${esc(g.name)}">
      <span class="ic">${String(i + 1).padStart(2, "0")}</span>${esc(g.name)}
    </button>`).join("");

  $("#railQuick").querySelectorAll("[data-quick]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.quick;
      if (id === "home") closeBrowse();
      else if (id === "list") { state.listOpen = true; closeBrowse(); renderRows(); }
      else location.hash = `/r/${id}/1`;
      if (!matchMedia("(min-width: 1280px)").matches) setRail(false);
    }));

  $("#railGenres").querySelectorAll("[data-genre]").forEach((b) =>
    b.addEventListener("click", () => {
      location.hash = `/c/movie/${b.dataset.genre}/1`;
      if (!matchMedia("(min-width: 1280px)").matches) setRail(false);
    }));

  markCat();
}

// Reflects wherever the user currently is, whichever route took them there.
function markCat() {
  const b = state.browse;
  document.querySelectorAll("#railGenres [data-genre]").forEach((el) =>
    el.setAttribute("aria-current", String(b?.kind === "genre" && b.genre === el.dataset.genre)));
  document.querySelectorAll("#railQuick [data-quick]").forEach((el) => {
    const id = el.dataset.quick;
    const on = id === "home" ? !b && !state.listOpen
      : id === "list" ? Boolean(state.listOpen)
      : b?.kind === "row" && b.key === id;
    el.setAttribute("aria-current", String(on));
  });
  const n = $("#railListCount");
  if (n) n.textContent = state.list.length;
}

function setRail(open) {
  document.documentElement.classList.toggle("rail-open", open);
  $("#railToggle").setAttribute("aria-expanded", String(open));
  $("#railVeil").hidden = !open || matchMedia("(min-width: 1280px)").matches;
  localStorage.setItem("sc:rail", open ? "1" : "0");
}

const railOpen = () => document.documentElement.classList.contains("rail-open");

// Shown while a page of results is in flight: the same tumbling cube as the
// splash, sized to sit inside a page heading rather than replace the screen.
function browseLoader(name, page) {
  // Deliberately NOT skeleton cards: a grid of empty outlines advertises how much
  // is missing. One panel over the whole shelf hides the assembly instead.
  return `
    <div class="cat-head"><h2 class="cat-title">${esc(name || "Loading")}</h2></div>
    <div class="load-stage" role="status" aria-live="polite">
      <div class="load-veil" aria-hidden="true"></div>
      <div class="mini-cube big" aria-hidden="true">
        <span class="mf f1"></span><span class="mf f2"></span><span class="mf f3"></span>
        <span class="mf f4"></span><span class="mf f5"></span><span class="mf f6"></span>
      </div>
      <p class="load-line">
        <span class="load-bar"><i></i></span>
        ${page ? `fetching page ${page}` : "pulling the shelf"}
      </p>
    </div>`;
}

async function openBrowse(desc, { push = true } = {}) {
  state.browse = { page: 1, sort: "popularity.desc", items: [], ...desc };
  const b = state.browse;

  if (push) {
    location.hash = b.kind === "row"
      ? `/r/${b.key}/${b.page}`
      : `/c/${b.media}/${b.genre}/${b.page}`;
  }

  $("#hero").hidden = true;            // the carousel belongs to the homepage
  clearTimeout(state.heroTimer);
  markCat();
  $("#rows").innerHTML = browseLoader(b.name);
  window.scrollTo({ top: 0, behavior: "instant" });

  await loadBrowse();
}

async function loadBrowse() {
  const b = state.browse;
  if (!b) return;
  try {
    const data = b.kind === "row"
      ? await api("/api/row", { key: b.key, page: b.page })
      : await api("/api/category", { media: b.media, genre: b.genre, page: b.page, sort: b.sort });

    // A slow page that resolves after the user has moved on must not overwrite.
    if (state.browse !== b) return;
    b.items = data.items || [];
    b.totalPages = data.totalPages || 1;
    b.name = b.name || data.label || "Browse";
    renderBrowse();
  } catch {
    $("#rows").innerHTML = `<div class="notice">Could not load that list. Try another.</div>`;
  }
}

// Windowed pager: first, last, and a few either side of the current page, so 100
// pages do not produce 100 buttons.
const PAGE_WINDOW = 5;

// A sliding window of exactly PAGE_WINDOW numbers whenever that many pages exist.
// The previous "current ±2 plus first and last" approach shrank to three or four
// numbers near either end, so the control changed width as you paged through it.
function pagerHTML(page, total) {
  if (total < 2) return "";

  const span = Math.min(PAGE_WINDOW, total);
  // Clamped so the window stays full at both ends: page 1 shows 1-5, and the
  // last page shows the final five rather than trailing off.
  const start = Math.max(1, Math.min(page - Math.floor(span / 2), total - span + 1));
  const nums = Array.from({ length: span }, (_, i) => start + i);

  const first = page === 1;
  const last = page >= total;
  // Only worth offering a jump to the ends when the window cannot already reach them.
  const jumps = total > span;

  let out = "";
  if (jumps) out += `<button class="pg-step" data-page="1" aria-label="First page" ${first ? "disabled" : ""}>«</button>`;
  out += `<button class="pg-step" data-page="${page - 1}" ${first ? "disabled" : ""}>‹ Prev</button>`;
  for (const n of nums) {
    out += `<button class="pg-num" data-page="${n}" aria-current="${n === page}">${n}</button>`;
  }
  out += `<button class="pg-step" data-page="${page + 1}" ${last ? "disabled" : ""}>Next ›</button>`;
  if (jumps) out += `<button class="pg-step" data-page="${total}" aria-label="Last page (${total})" ${last ? "disabled" : ""}>»</button>`;
  return `<nav class="pager" aria-label="Pages">${out}</nav>`;
}

function renderBrowse() {
  const b = state.browse;
  if (!b) return;

  $("#rows").innerHTML = `
    <div class="cat-head">
      <h2 class="cat-title glitch" data-text="${esc(b.name)}">${esc(b.name)}</h2>
      <span class="row-tag">page ${b.page} of ${b.totalPages}</span>
      ${b.kind === "genre" ? `
        <select class="cat-sort" id="catSort" aria-label="Sort">
          ${SORTS.map(([v, l]) => `<option value="${v}"${v === b.sort ? " selected" : ""}>${l}</option>`).join("")}
        </select>` : ""}
    </div>
    <div class="grid">${b.items.map(cardHTML).join("")}</div>
    ${pagerHTML(b.page, b.totalPages)}`;

  wireCards();

  const sort = $("#catSort");
  if (sort) sort.onchange = (e) => { b.sort = e.target.value; b.page = 1; goPage(1); };

  document.querySelectorAll(".pager [data-page]").forEach((el) =>
    el.addEventListener("click", () => goPage(Number(el.dataset.page))));
}

async function goPage(n) {
  const b = state.browse;
  if (!b || n < 1 || n > b.totalPages || n === b.page) return;
  b.page = n;
  location.hash = b.kind === "row"
    ? `/r/${b.key}/${n}`
    : `/c/${b.media}/${b.genre}/${n}`;
  $("#rows").innerHTML = browseLoader(b.name, n);
  window.scrollTo({ top: 0, behavior: "instant" });
  await loadBrowse();
}

function closeBrowse() {
  if (!state.browse) return;
  state.browse = null;
  if (/^#\/(c|r)\//.test(location.hash)) history.pushState("", document.title, location.pathname);
  markCat();
  startHeroCarousel(state.feed?.heroes?.length ? state.feed.heroes : [state.feed?.hero]);
  renderRows();
}

/* ---------------------------------------------------------------- regions -- */

// TMDB returns 200+ countries alphabetically, which buries the handful anyone
// actually picks. These float to the top; the rest stay browsable underneath.
const COMMON_REGIONS = ["US", "GB", "CA", "AU", "IN", "DE", "FR", "JP", "BR", "ES", "IT", "MX"];

function renderRegions(config) {
  const all = config.regions || [];
  const sel = $("#region");

  if (!all.length) {
    // Never leave an empty select — it collapses to a sliver and looks broken.
    sel.innerHTML = `<option value="${esc(state.region)}">${esc(state.region)} — unavailable</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;

  // Keep the user's saved region only if this list actually has it.
  state.region = all.some((r) => r.code === state.region) ? state.region : config.defaultRegion;

  const opt = (r) =>
    `<option value="${esc(r.code)}"${r.code === state.region ? " selected" : ""}>${esc(r.code)} — ${esc(r.name)}</option>`;

  const common = COMMON_REGIONS.map((c) => all.find((r) => r.code === c)).filter(Boolean);
  const rest = all.filter((r) => !COMMON_REGIONS.includes(r.code));

  sel.innerHTML =
    (common.length ? `<optgroup label="Common">${common.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="All countries">${rest.map(opt).join("")}</optgroup>`;
  sel.title = `Watch providers for ${all.find((r) => r.code === state.region)?.name || state.region}`;
}

/* ------------------------------------------------------------------ chill -- */

function setChill(on) {
  document.documentElement.classList.toggle("chill", on);
  $("#chill").setAttribute("aria-pressed", String(on));
  localStorage.setItem("sc:chill", on ? "1" : "0");
  if (on) document.querySelectorAll(".card").forEach((c) => (c.style.transform = ""));
}

/* ------------------------------------------------------------------ boot -- */

const TICKER = [
  "NO ACCOUNT REQUIRED", "NO POPUPS", "NO FAKE PLAY BUTTONS", "WE DO NOT HOST A SINGLE FRAME",
  "METADATA BY TMDB", "AVAILABILITY BY JUSTWATCH", "EVERY LINK IS LICENSED",
  "PRESS / TO SEARCH ANYTHING", "★ TO SAVE", "SWITCH REGIONS UP TOP", "CHILL MODE KILLS THE NOISE",
];

/* ---------------------------------------------------------------- splash -- */

// Shown once per browser session. A loader that reappears on every navigation
// stops being an intro and becomes an obstacle.
function initSplash() {
  const el = $("#splash");
  if (!el) return () => {};

  const seen = sessionStorage.getItem("sc:splash") === "1";
  const still =
    document.documentElement.classList.contains("chill") ||
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (seen) {
    el.remove();
    return () => {};
  }
  if (still) el.classList.add("still");

  const shownAt = Date.now();
  const lines = ["THREADING THE PROJECTOR", "DIMMING THE HOUSE LIGHTS", "CHECKING THE LISTINGS"];
  let i = 0;
  const cycle = still ? null : setInterval(() => {
    i = (i + 1) % lines.length;
    const sub = $("#splashSub");
    if (sub) sub.textContent = lines[i];
  }, 1400);

  // Returns the dismisser so boot() can close it exactly when data is ready.
  return () => {
    clearInterval(cycle);
    // Hold briefly if the data beat the animation — a splash that flashes for
    // 80ms reads as a glitch, not an intro.
    const held = Math.max(0, 900 - (Date.now() - shownAt));
    setTimeout(() => {
      el.classList.add("gone");
      sessionStorage.setItem("sc:splash", "1");
      setTimeout(() => el.remove(), 700);
    }, held);
  };
}

async function boot() {
  $("#ticker").innerHTML = [...TICKER, ...TICKER].map((t) => `<span>${t} ✦</span>`).join("");
  $("#listCount").textContent = state.list.length;
  if (localStorage.getItem("sc:chill") === "1") setChill(true);

  const dismissSplash = initSplash();

  // Paint the shape of the page before any request lands.
  $("#rows").innerHTML = skeletonScreen();

  const [config, feed, me, genres] = await Promise.all([
    api("/api/config").catch(() => state.config),
    api("/api/feed").catch(() => null),
    api("/api/auth/me").catch(() => ({ user: null, list: null })),
    api("/api/genres").catch(() => ({ movie: [], tv: [] })),
  ]);
  renderCats(genres);
  const savedRail = localStorage.getItem("sc:rail");
  setRail(savedRail === null ? matchMedia("(min-width: 1280px)").matches : savedRail === "1");

  if (me.user) {
    state.user = me.user;
    state.list = me.list || [];
    localStorage.removeItem("sc:list"); // the account owns the list now
    $("#listCount").textContent = state.list.length;
  }
  renderAccount();

  state.config = config;
  renderRegions(config);

  if (!feed) {
    dismissSplash();
    $("#rows").innerHTML = `<div class="notice">Server unreachable. Is <code>npm start</code> still running?</div>`;
    return;
  }
  dismissSplash();

  state.feed = feed;
  startHeroCarousel(feed.heroes?.length ? feed.heroes : [feed.hero]);
  renderRows();
  routeFromHash();
}

/* ----------------------------------------------------------------- events -- */

$("#openSearch").onclick = openSearch;
$("#closeSearch").onclick = closeSearch;
$("#closeSheet").onclick = () => closeSheet();
addEventListener("hashchange", routeFromHash);
addEventListener("popstate", routeFromHash);
$("#q").addEventListener("input", (e) => runSearch(e.target.value));

$("#chill").onclick = () => setChill(!document.documentElement.classList.contains("chill"));

$("#heroPrev").onclick = () => goHero(state.heroIdx - 1);
$("#heroNext").onclick = () => goHero(state.heroIdx + 1);

// Reading the blurb should not cost you the slide. Hovering or tabbing in holds it.
for (const ev of ["pointerenter", "focusin"]) {
  $("#hero").addEventListener(ev, () => {
    $("#hero").classList.add("paused");
    clearTimeout(state.heroTimer);
  });
}
for (const ev of ["pointerleave", "focusout"]) {
  $("#hero").addEventListener(ev, () => {
    $("#hero").classList.remove("paused");
    armHeroTimer();
  });
}

$("#railToggle").onclick = () => setRail(!railOpen());
$("#railVeil").onclick = () => setRail(false);

$("#account").onclick = () => openAuth(state.user ? "account" : "in");
$("#closeAuth").onclick = closeAuth;
$("#authForm").addEventListener("submit", submitAuth);
$("#authSwap").onclick = () => openAuth(state.authMode === "up" ? "in" : "up");
$("#acctSave").onclick = saveName;
$("#acctDelete").onclick = deleteAccount;
for (const id of ["#authPassword", "#authRepeat"]) $(id).addEventListener("input", paintPasswordRules);

$("#openList").onclick = (e) => {
  state.listOpen = !state.listOpen;
  e.currentTarget.setAttribute("aria-pressed", String(state.listOpen));
  renderRows();
  if (state.listOpen) $("#rows").scrollIntoView({ block: "start" });
};

$("#region").addEventListener("change", (e) => {
  state.region = e.target.value;
  localStorage.setItem("sc:region", state.region);
  toast(`region → ${state.region}`);
  if (state.open) openSheet(state.open.media, state.open.id); // refresh availability in place
});

// Click the dimmed area to dismiss, but not the panel itself.
for (const [id, close] of [["searchWrap", closeSearch], ["sheetWrap", closeSheet], ["authWrap", closeAuth]]) {
  document.getElementById(id).addEventListener("click", (e) => {
    if (e.target.id === id) close();
  });
}

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === "Escape") {
    if (!$("#authWrap").hidden) return closeAuth();
    if (railOpen() && !matchMedia("(min-width: 1280px)").matches
        && $("#searchWrap").hidden && $("#sheetWrap").hidden) return setRail(false);
    if (!$("#searchWrap").hidden) return closeSearch();
    if (!$("#sheetWrap").hidden) return closeSheet();
  }
  if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key === "k")) {
    e.preventDefault();
    openSearch();
  }
  if (!$("#searchWrap").hidden) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); }
    if (e.key === "Enter" && state.cursor > -1) {
      const i = state.hits[state.cursor];
      closeSearch();
      openSheet(i.media, i.id);
    }
  }
});

// Cursor-follow spotlight. Cheap enough to run raw; skipped in chill mode by CSS.
addEventListener("pointermove", (e) => {
  const s = $("#spot").style;
  s.setProperty("--mx", `${e.clientX}px`);
  s.setProperty("--my", `${e.clientY}px`);
}, { passive: true });

boot();
