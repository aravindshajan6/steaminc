/**
 * STEAMINC — zero-dependency Node server.
 *
 * Responsibilities:
 *   1. Keep the TMDB credential server-side. The browser never sees it.
 *   2. Collapse TMDB's many small endpoints into a few fat ones the UI actually wants.
 *   3. Cache aggressively. TMDB rate-limits, and trending data does not change per-second.
 *   4. Degrade to bundled sample data when no credential is configured, so the app
 *      always boots and always renders something.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveMatch, archiveSearch, archiveTitle } from "./archive.js";
import {
  validate, throttle, clearThrottle,
  COOKIE, parseCookies, sessionCookie, clearCookie, publicUser,
} from "./auth.js";
import { createStore } from "./store.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));

// In Docker the frontend is a separate nginx container and this path does not exist,
// so the API serves API only. Running bare with `npm start`, it does exist, and the
// backend also serves the UI so there is still just one thing to start in dev.
const PUBLIC_DIR = resolve(ROOT, "..", "frontend", "public");
const SERVE_STATIC = existsSync(PUBLIC_DIR);

/* ------------------------------------------------------------------ env --- */

// Checks backend/.env first, then the project root. The root copy is the one that
// matters: docker compose reads its variables from there too, so a single file
// configures both the containerized and the bare `npm start` path.
function loadEnv() {
  const file = [join(ROOT, ".env"), resolve(ROOT, "..", ".env")].find((p) => existsSync(p));
  if (!file) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (value && !(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT) || 5173;
const DEFAULT_REGION = (process.env.DEFAULT_REGION || "US").toUpperCase();
const CREDENTIAL = (process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN || "").trim();
// v4 read-access tokens are JWTs and go in an Authorization header; v3 keys are a query param.
const IS_BEARER = CREDENTIAL.startsWith("eyJ");
const DEMO = CREDENTIAL === "";

const TMDB = "https://api.themoviedb.org/3";

// Kept separate from ROOT/data on purpose: that directory holds demo.json, which is
// baked into the image. Mounting a volume over it would hide the bundled data, so
// writable state lives somewhere of its own.
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const { store, kind: STORE_KIND } = createStore({
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB || "steaminc",
  dataDir: DATA_DIR,
});

/* ----------------------------------------------------------- http helpers --- */

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

function requireMethod(ctx, method) {
  if (ctx.req.method !== method) {
    throw Object.assign(new Error(`Use ${method} for this endpoint.`), { status: 405 });
  }
}

function requireUser(ctx) {
  if (!ctx.user) throw Object.assign(new Error("You need to be signed in."), { status: 401 });
  return ctx.user;
}

// Only ever store the fields the UI renders — a watchlist is user-controlled input,
// not a place to let arbitrary JSON accumulate on disk.
function cleanList(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error("list must be an array."), { status: 400 });
  return list
    .filter((i) => i && ["movie", "tv", "free"].includes(i.media) && ["string", "number"].includes(typeof i.id))
    .slice(0, 500)
    .map((i) => ({
      id: i.media === "free" ? String(i.id).slice(0, 200) : Number(i.id),
      media: i.media,
      title: String(i.title || "").slice(0, 200),
      poster: typeof i.poster === "string" ? i.poster.slice(0, 400) : null,
      year: String(i.year || "").slice(0, 8),
      score: Number.isFinite(i.score) ? i.score : null,
    }));
}

/* ---------------------------------------------------------------- cache --- */

const cache = new Map();

async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await producer();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  // Cheap bound: this is a single-process toy cache, not a datastore.
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

/* ----------------------------------------------------------------- tmdb --- */

async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { accept: "application/json" };
  if (IS_BEARER) headers.authorization = `Bearer ${CREDENTIAL}`;
  else url.searchParams.set("api_key", CREDENTIAL);

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`TMDB ${res.status} on ${path}: ${body.slice(0, 200)}`), {
      status: res.status,
    });
  }
  return res.json();
}

/* ------------------------------------------------------------ normalize --- */

// The UI speaks one shape. Movies and TV differ enough in TMDB that translating
// once here is cheaper than branching in every template.
function toCard(item, mediaHint) {
  const media = item.media_type || mediaHint || (item.first_air_date ? "tv" : "movie");
  const date = item.release_date || item.first_air_date || "";
  return {
    id: item.id,
    media,
    title: item.title || item.name || "Untitled",
    overview: item.overview || "",
    poster: item.poster_path || null,
    backdrop: item.backdrop_path || null,
    year: date ? date.slice(0, 4) : "",
    score: item.vote_average ? Math.round(item.vote_average * 10) : null,
    votes: item.vote_count || 0,
    popularity: item.popularity || 0,
  };
}

function cardList(payload, mediaHint) {
  return (payload?.results || [])
    .filter((r) => (r.media_type ? r.media_type !== "person" : true))
    .map((r) => toCard(r, mediaHint));
}

/* ----------------------------------------------------------------- demo --- */

let demoData = null;
function demo() {
  if (!demoData) demoData = JSON.parse(readFileSync(join(ROOT, "data", "demo.json"), "utf8"));
  return demoData;
}

function demoFeed() {
  const all = demo().titles;
  const pick = (fn) => all.filter(fn).map((t) => ({ ...t }));
  const shuffled = (offset) => all.slice(offset).concat(all.slice(0, offset));
  return {
    demo: true,
    hero: all[0],
    rows: [
      { key: "trending", label: "Trending Now", tag: "live", items: shuffled(0) },
      { key: "movies", label: "Popular Films", tag: "film", items: pick((t) => t.media === "movie") },
      { key: "tv", label: "Series People Binge", tag: "tv", items: pick((t) => t.media === "tv") },
      { key: "top", label: "All-Time Highest Rated", tag: "top", items: [...all].sort((a, b) => b.score - a.score) },
      { key: "new", label: "In Theaters & Just Landed", tag: "new", items: shuffled(5) },
    ],
  };
}

/* -------------------------------------------------------------- archive --- */

// The one row you can actually watch. Cached hard — the catalog is decades old
// and the Archive's search endpoint is not fast.
function freeRow() {
  return cached("free-row", 216e5, async () => ({
    key: "free",
    label: "Free To Watch Right Now",
    tag: "public domain",
    items: await archiveSearch({ rows: 24 }),
  }));
}

// One round-trip per row, all in flight at once. A row that fails is dropped
// rather than failing the whole page.
function tmdbFeed() {
  return cached("feed", 6e5, async () => {
    const jobs = [
      ["trending", "Trending Now", "live", tmdb("/trending/all/day"), null],
      ["movies", "Popular Films", "film", tmdb("/movie/popular"), "movie"],
      ["tv", "Series People Binge", "tv", tmdb("/tv/popular"), "tv"],
      ["top", "All-Time Highest Rated", "top", tmdb("/movie/top_rated"), "movie"],
      ["new", "In Theaters & Just Landed", "new", tmdb("/movie/now_playing"), "movie"],
    ];
    const settled = await Promise.allSettled(jobs.map((j) => j[3]));
    const rows = [];
    settled.forEach((result, i) => {
      const [key, label, tag, , hint] = jobs[i];
      if (result.status !== "fulfilled") {
        console.warn(`[feed] row "${key}" failed:`, result.reason?.message);
        return;
      }
      const items = cardList(result.value, hint);
      if (items.length) rows.push({ key, label, tag, items });
    });
    if (!rows.length) throw new Error("every feed row failed");
    const heroPool = rows[0].items.filter((i) => i.backdrop);
    return { demo: false, hero: heroPool[0] || rows[0].items[0], rows };
  });
}

/* --------------------------------------------------------------- routes --- */

const ROUTES = {
  async "/api/config"() {
    const regions = DEMO
      ? demo().regions
      : await cached("regions", 864e5, async () => {
          const data = await tmdb("/watch/providers/regions");
          return (data.results || []).map((r) => ({ code: r.iso_3166_1, name: r.english_name }));
        });
    return { demo: DEMO, defaultRegion: DEFAULT_REGION, regions };
  },

  async "/api/feed"() {
    const base = DEMO ? demoFeed() : await tmdbFeed();
    const rows = [...base.rows];
    let hero = base.hero;

    // Archive row is additive: if it fails, the page is exactly what it was before.
    try {
      const free = await freeRow();
      if (free.items.length) {
        rows.splice(DEMO ? 0 : 1, 0, free);
        // Without a TMDB key nothing else has artwork, so lead with something that does.
        if (DEMO) hero = free.items.find((i) => i.poster) || hero;
      }
    } catch (err) {
      console.warn("[feed] free row unavailable:", err.message);
    }

    return { ...base, hero, rows };
  },

  async "/api/free"() {
    return freeRow();
  },

  // Container healthcheck. Deliberately touches no upstream: this reports whether
  // the process is alive, not whether TMDB is having a bad day.
  async "/api/health"() {
    return { ok: true, mode: DEMO ? "demo" : "live", uptime: Math.round(process.uptime()) };
  },

  /* ------------------------------------------------------------- accounts -- */

  async "/api/auth/signup"(params, ctx) {
    requireMethod(ctx, "POST");
    const body = await readJson(ctx.req);
    const problem = validate(body);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    if (await store.userByEmail(body.email)) {
      throw Object.assign(new Error("An account with that email already exists."), { status: 409 });
    }
    const user = await store.createUser(body);
    ctx.headers["set-cookie"] = sessionCookie(await store.startSession(user.id), { secure: ctx.secure });
    return { user: publicUser(user), list: user.list };
  },

  async "/api/auth/login"(params, ctx) {
    requireMethod(ctx, "POST");
    const body = await readJson(ctx.req);
    const email = String(body.email || "").trim().toLowerCase();

    const bucket = `${ctx.ip}:${email}`;
    const minutes = throttle(bucket);
    if (minutes) {
      throw Object.assign(new Error(`Too many attempts. Try again in ${minutes} minute(s).`), { status: 429 });
    }

    const user = await store.userByEmail(email);
    // Hash even when the account does not exist, so response time cannot be used to
    // discover which emails are registered.
    const ok = user
      ? await store.verify(user, String(body.password || ""))
      : (await store.verify({ salt: "00".repeat(16), hash: "00".repeat(64) }, "decoy"), false);

    // Deliberately does not say which half was wrong — that would confirm the email.
    if (!ok) throw Object.assign(new Error("Email or password is incorrect."), { status: 401 });

    clearThrottle(bucket);
    ctx.headers["set-cookie"] = sessionCookie(await store.startSession(user.id), { secure: ctx.secure });
    return { user: publicUser(user), list: user.list };
  },

  async "/api/auth/logout"(params, ctx) {
    requireMethod(ctx, "POST");
    await store.endSession(ctx.token);
    ctx.headers["set-cookie"] = clearCookie();
    return { ok: true };
  },

  async "/api/auth/me"(params, ctx) {
    return { user: publicUser(ctx.user), list: ctx.user?.list || [] };
  },

  async "/api/list"(params, ctx) {
    const user = requireUser(ctx);
    if (ctx.req.method === "GET") return { list: user.list };
    requireMethod(ctx, "PUT");
    const body = await readJson(ctx.req);
    return { list: await store.setList(user.id, cleanList(body.list)) };
  },

  async "/api/search"(params) {
    const q = (params.get("q") || "").trim();
    if (q.length < 2) return { query: q, items: [] };
    const slug = q.toLowerCase();

    const catalog = DEMO
      ? Promise.resolve(demo().titles.filter((t) => t.title.toLowerCase().includes(slug)))
      : cached(`search:${slug}`, 3e5, async () =>
          cardList(await tmdb("/search/multi", { query: q, include_adult: "false" }))
            .filter((i) => i.votes > 0 || i.poster)
            .sort((a, b) => b.popularity - a.popularity)
            .slice(0, 24));

    const free = cached(`free-search:${slug}`, 3e5, () => archiveSearch({ rows: 8, query: q }));

    // Watchable results ride along with the catalog, never instead of it — either
    // source failing just means fewer rows, not a broken search box.
    const [a, b] = await Promise.all([catalog.catch(() => []), free.catch(() => [])]);
    return { query: q, items: [...a, ...b] };
  },

  async "/api/title"(params) {
    const raw = params.get("media");
    const id = params.get("id");
    if (!id) throw Object.assign(new Error("id required"), { status: 400 });

    if (raw === "free") return cached(`free:${id}`, 36e5, () => archiveTitle(id));

    const media = raw === "tv" ? "tv" : "movie";
    const region = (params.get("region") || DEFAULT_REGION).toUpperCase();

    if (DEMO) {
      const t = demo().titles.find((x) => String(x.id) === String(id));
      if (!t) throw Object.assign(new Error("not found"), { status: 404 });
      return {
        ...t,
        demo: true,
        // Runs here too, so the cross-match is demonstrable without a TMDB key.
        freeMatch: await archiveMatch(t.title, t.year).catch(() => null),
        runtime: t.runtime || null,
        genres: t.genres || [],
        tagline: t.tagline || "",
        cast: t.cast || [],
        trailer: null,
        providers: demo().providers[region] || demo().providers.US || {},
        providerLink: null,
        recommendations: demo().titles.filter((x) => x.id !== t.id).slice(0, 12),
      };
    }

    return cached(`title:${media}:${id}:${region}`, 36e5, async () => {
      const d = await tmdb(`/${media}/${id}`, {
        append_to_response: "credits,videos,recommendations,watch/providers",
      });
      const wp = d["watch/providers"]?.results?.[region] || {};
      const trailer = (d.videos?.results || []).find(
        (v) => v.site === "YouTube" && /trailer|teaser/i.test(v.type),
      );
      const runtime = d.runtime || d.episode_run_time?.[0] || null;
      const card = toCard(d, media);

      // Old enough to be public domain? Then there is something to actually play.
      // Never allowed to break the page — a licensed title just has no free match.
      const freeMatch =
        media === "movie"
          ? await archiveMatch(card.title, card.year).catch((err) => {
              console.warn("[title] free match failed:", err.message);
              return null;
            })
          : null;

      return {
        ...card,
        freeMatch,
        tagline: d.tagline || "",
        runtime,
        seasons: d.number_of_seasons || null,
        episodes: d.number_of_episodes || null,
        status: d.status || "",
        genres: (d.genres || []).map((g) => g.name),
        cast: (d.credits?.cast || []).slice(0, 12).map((c) => ({
          name: c.name,
          role: c.character || "",
          photo: c.profile_path || null,
        })),
        trailer: trailer ? { key: trailer.key, name: trailer.name } : null,
        // JustWatch data, surfaced through TMDB. Attribution is rendered in the UI.
        providers: {
          stream: wp.flatrate || [],
          free: wp.free || [],
          ads: wp.ads || [],
          rent: wp.rent || [],
          buy: wp.buy || [],
        },
        providerLink: wp.link || null,
        recommendations: cardList(d.recommendations, media).slice(0, 12),
      };
    });
  },
};

/* ---------------------------------------------------------------- static --- */

// nginx sets these in front of the split deployment, but the single-service image
// (Render, Fly) serves static files straight from here with no proxy in front —
// so they have to be set here too, or they silently vanish in production.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(PUBLIC_DIR, rel === "/" || rel === "\\" ? "index.html" : rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "forbidden" });

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(PUBLIC_DIR, "index.html"); // SPA fallback
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      // no-cache everywhere: there is no build step or content hashing here, so a
      // cached app.js silently serves stale code after every edit.
      "cache-control": "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}

/* ---------------------------------------------------------------- server --- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    const handler = ROUTES[url.pathname];
    if (!handler) return send(res, 404, { error: "no such endpoint" });

    const token = parseCookies(req.headers.cookie)[COOKIE] || null;
    const ctx = {
      req,
      res,
      token,
      user: await store.sessionUser(token),
      headers: {},
      // Behind nginx every request arrives from the proxy's container IP, which would
      // put every user in ONE login-throttle bucket — one attacker could lock out
      // everybody. Trusting X-Forwarded-For is safe here precisely because the backend
      // port is never published: nothing but the proxy can reach it.
      ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.socket.remoteAddress
        || "?",
      secure: (req.headers["x-forwarded-proto"] || "").includes("https"),
    };

    try {
      send(res, 200, await handler(url.searchParams, ctx), ctx.headers);
    } catch (err) {
      const status = err.status || 502;
      console.error(`[api] ${url.pathname} ->`, err.message);
      // A dead upstream should not blank the homepage.
      if (url.pathname === "/api/feed") return send(res, 200, { ...demoFeed(), degraded: true });
      send(res, status, { error: err.message });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method" });
  if (!SERVE_STATIC) {
    return send(res, 404, { error: "This is the API. The UI is served by the frontend container." });
  }
  await serveStatic(url.pathname, res);
});

// A misconfigured database should fail loudly at boot, not on the first signup.
try {
  await store.load();
} catch (err) {
  console.error(`\n  ✖ storage (${STORE_KIND}) failed to start: ${err.message}\n`);
  process.exit(1);
}

const accounts = await store.count();

server.listen(PORT, () => {
  const mode = DEMO
    ? "DEMO MODE — bundled sample data (add TMDB_API_KEY to .env for the real catalog)"
    : `LIVE — TMDB via ${IS_BEARER ? "v4 bearer token" : "v3 api key"}`;
  const who = `${accounts} account(s) · storage: ${STORE_KIND}`;
  console.log(`\n  ▓▓ STEAMINC  ▓▓  http://localhost:${PORT}\n  ${mode}\n  ${who}\n`);
});

// Close the pool on shutdown so Mongo does not hold a connection slot after exit.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await store.close?.().catch(() => {});
    process.exit(0);
  });
}
