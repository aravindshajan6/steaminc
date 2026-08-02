/**
 * Internet Archive source — the part of STEAMINC you can actually press play on.
 *
 * TMDB and JustWatch only ever tell you *where* something is licensed; they carry no
 * video and no rights to any. The Archive's public-domain and openly-licensed film
 * collections carry both, and neither endpoint used here needs an API key.
 */

const SEARCH = "https://archive.org/advancedsearch.php";
const META = "https://archive.org/metadata";
const DL = "https://archive.org/download";
export const THUMB = "https://archive.org/services/img";

// Archive rejects requests with no User-Agent, and Node's fetch does not set one.
const UA = { "user-agent": "steaminc/1.0 (+local discovery app)", accept: "application/json" };

// Collections that are public domain or explicitly openly licensed. Deliberately narrow:
// the Archive hosts plenty that is neither, and this app only points at what is free to watch.
const COLLECTIONS = ["publicmovies212", "feature_films", "prelinger", "classic_cartoons"];

const strip = (html) =>
  String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|quot|#39|lt|gt);/g, (m) => ({ "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" }[m] || " "))
    .replace(/\s+/g, " ")
    .trim();

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** Browse rows of watchable public-domain films. */
export async function archiveSearch({ rows = 24, page = 1, query = "" } = {}) {
  const scope = `collection:(${COLLECTIONS.join(" OR ")}) AND mediatype:(movies)`;
  // Lucene syntax leaks straight through this endpoint, so strip anything operator-shaped.
  const safe = query.replace(/[^\p{L}\p{N} ]+/gu, " ").trim();
  const q = safe ? `(${scope}) AND (title:(${safe}) OR description:(${safe}))` : scope;

  const url = new URL(SEARCH);
  url.searchParams.set("q", q);
  for (const f of ["identifier", "title", "year", "description", "downloads"]) {
    url.searchParams.append("fl[]", f);
  }
  url.searchParams.set("sort[]", "downloads desc");
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("page", String(page));
  url.searchParams.set("output", "json");

  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`archive search ${res.status}`);
  const data = await res.json();

  return (data.response?.docs || []).map((d) => ({
    id: d.identifier,
    media: "free",
    title: first(d.title) || d.identifier,
    overview: strip(first(d.description)).slice(0, 400),
    poster: `${THUMB}/${d.identifier}`,
    backdrop: `${THUMB}/${d.identifier}`,
    year: d.year ? String(d.year) : "",
    score: null,
    votes: d.downloads || 0,
    popularity: d.downloads || 0,
  }));
}

// "the thing (1982)" -> "thing" — enough to match titles across two catalogues
// that punctuate and article-prefix differently.
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/^(the|a|an) /, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Is this licensed title ALSO free somewhere legitimate? True for anything old enough
 * to have fallen into the public domain, which is a lot of what people go looking for.
 *
 * Deliberately strict: an exact normalized title match, and years within one when both
 * sides report one. A wrong match here would tell someone a film is free when it is not.
 */
export async function archiveMatch(title, year) {
  const target = norm(title);
  if (target.length < 3) return null;

  // Copyright-era gate. Plenty of Archive items carry no year, so a remake would
  // happily match its own public-domain original — "Nosferatu (2024)" onto the 1922
  // print — and we would advertise a licensed film as free. Nothing after this
  // cutoff is plausibly public domain, so it never even gets looked up.
  if (!year || Number(year) > 1970) return null;

  // Wide net, strict filter: results are ranked by downloads, so a less popular
  // print of the right film can sit well below a dozen loosely-related hits.
  const candidates = await archiveSearch({ rows: 40, query: title });
  const match = candidates.find((c) => {
    if (norm(c.title) !== target) return false;
    if (year && c.year) return Math.abs(Number(year) - Number(c.year)) <= 1;
    return true;
  });
  if (!match) return null;

  // Only promise a play button if there is actually something playable behind it.
  const full = await archiveTitle(match.id);
  return full.stream ? { id: full.id, title: full.title, year: full.year, poster: full.poster } : null;
}

// Best playable derivative first. Archive stores several encodings per item and the
// original is often a 3GB MPEG-2 that no browser will touch.
const RANK = ["h.264", "mpeg4", "512kb mpeg4", "webm", "ogg video"];

function pickPlayable(files = []) {
  const playable = files
    .filter((f) => /\.(mp4|webm|ogv)$/i.test(f.name || ""))
    .map((f) => ({ ...f, rank: RANK.indexOf(String(f.format || "").toLowerCase()) }));
  if (!playable.length) return null;
  playable.sort((a, b) => (a.rank < 0) - (b.rank < 0) || a.rank - b.rank || Number(a.size || 0) - Number(b.size || 0));
  return playable[0];
}

/** Full record for one Archive item, including a direct playable URL. */
export async function archiveTitle(identifier) {
  const res = await fetch(`${META}/${encodeURIComponent(identifier)}`, {
    headers: UA,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`archive metadata ${res.status}`);
  const data = await res.json();

  const m = data.metadata;
  if (!m) throw Object.assign(new Error("not found"), { status: 404 });

  const file = pickPlayable(data.files);
  const subs = (data.files || []).find((f) => /\.vtt$/i.test(f.name || ""));

  return {
    id: identifier,
    media: "free",
    title: first(m.title) || identifier,
    overview: strip(first(m.description)),
    poster: `${THUMB}/${identifier}`,
    backdrop: `${THUMB}/${identifier}`,
    year: m.year ? String(m.year) : "",
    score: null,
    tagline: "",
    runtime: file?.length ? Math.round(Number(String(file.length).split(":").reduce((a, b) => a * 60 + Number(b), 0)) / 60) || null : null,
    genres: [].concat(m.subject || []).slice(0, 4).map(String),
    creator: first(m.creator) || "",
    license: m.licenseurl || "",
    rights: strip(first(m.rights)),
    stream: file ? `${DL}/${encodeURIComponent(identifier)}/${encodeURIComponent(file.name)}` : null,
    streamType: file ? (/\.webm$/i.test(file.name) ? "video/webm" : /\.ogv$/i.test(file.name) ? "video/ogg" : "video/mp4") : null,
    captions: subs ? `${DL}/${encodeURIComponent(identifier)}/${encodeURIComponent(subs.name)}` : null,
    source: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    cast: [],
    trailer: null,
    providers: {},
    recommendations: [],
  };
}
