# STEAMINC

A very loud streaming deck with two jobs:

1. **Discovery** — search everything ever made and find out which licensed service actually has
   it in your country. These titles are *pointers*; nothing here hosts or proxies them.
2. **Watching** — the **Free To Watch Right Now** row is real video you can press play on,
   streamed from the Internet Archive's public-domain and openly-licensed film collections.

That split is the whole design. TMDB and JustWatch know where everything is licensed but carry
no video; the Archive carries video it has the right to give away. Using both means the app is
useful for any title and immediately watchable for thousands.

## Run it

**With Docker** — two containers, one published port:

```bash
cp .env.example .env      # add your TMDB key (optional, see below)
docker compose up --build -d
                          # → http://localhost:8080
```

**Without Docker** — the backend also serves the UI when run from a checkout:

```bash
npm start                 # → http://localhost:5173
```

No npm dependencies, no build step, no bundler. Node 20+ and a browser.

```
steaminc/
├── backend/          Node API — TMDB, Archive, accounts. No host port in Docker.
│   ├── server.js     routing, caching, static fallback for bare mode
│   ├── archive.js    Internet Archive search, playable-file picking, cross-match
│   ├── auth.js       scrypt hashing, sessions, rate limiting
│   └── data/         bundled demo.json (accounts live in a volume, not here)
├── frontend/         nginx — static files + the only way into the API
│   ├── public/       index.html, app.js, styles.css
│   └── nginx.conf    reverse proxy for /api/
└── docker-compose.yml
```

---

## Getting real data

The Internet Archive row needs no key and works immediately — real artwork, real video.

The other rows are the ~1M-title catalog, and **that** is what needs a TMDB key. Without one
they fall back to a dozen bundled placeholders drawn as generated gradients, because there is
no artwork to show. If the site looks like colored rectangles, this is why. To fix it:

1. Grab a free key at <https://www.themoviedb.org/settings/api> (v3 key or v4 read token — either works).
2. `cp .env.example .env` and paste it into `TMDB_API_KEY`.
3. Restart. The banner disappears and you get ~1M titles plus live availability.

The key stays on the server. The browser never sees it.

---

## Architecture

```
                    ┌─────────────── private compose network ───────────────┐
                    │                                                       │
browser ──► frontend:8080 ──┬── static files (nginx)                        │
  (only published port)     └── /api/* ──► backend:5173 ──┬─► themoviedb.org│
                    │                     (no host port)  └─► archive.org   │
                    └───────────────────────────────────────────────────────┘
```

**Only the frontend publishes a port**, and it binds to `127.0.0.1`. The backend declares
`expose` but no `ports:`, so Docker never binds it to a host interface — the API is reachable
only from inside the compose network, by name, from nginx. Adding a `ports:` entry to the
backend would defeat this entirely.

Because the browser talks to the API on its own origin, this also means **no CORS anywhere**,
and the `HttpOnly` / `SameSite=Lax` session cookie works without special cases. Two things
follow from putting a proxy in front, both handled:

- The backend reads `X-Forwarded-For` for login throttling. Without it, every request arrives
  from the proxy's container IP and all users share one rate-limit bucket, so a single attacker
  could lock out everybody. Trusting that header is safe *precisely because* the backend port is
  never published — nothing but nginx can reach it.
- Writable state is mounted at `/app/state`, not `/app/data`, so the volume cannot shadow the
  `demo.json` baked into the image.

Inside the backend: the TMDB credential lives there and nowhere else, responses are cached with
per-type TTLs (feed 10m · search 5m · title 60m · free row 6h), each screen fans out N upstream
calls and returns one response, and everything falls back to `data/demo.json` when TMDB is
unkeyed or unreachable. The frontend is vanilla ES modules with no framework.

[backend/archive.js](backend/archive.js) is the watchable source. It searches a deliberately narrow set of
collections (`publicmovies212`, `feature_films`, `prelinger`, `classic_cartoons`) — the Archive
hosts plenty that is neither public domain nor openly licensed, and this app only points at what
is free to watch. Per item it picks the best browser-playable derivative, since the "original"
is often a multi-gigabyte MPEG-2 no browser will touch, and surfaces the license and a link back
to the source.

Three deliberate choices:

**One fat endpoint per screen.** TMDB makes you call `/movie/popular`, `/tv/popular`,
`/trending/all/day` separately, and a detail page needs credits, videos, recommendations and
watch providers. The server issues those in parallel and hands the client exactly one JSON
document per screen. `append_to_response` collapses the five detail calls into one upstream request.

**Partial failure never blanks the page.** Feed rows are fetched with `Promise.allSettled`; a
row that fails is dropped and logged, the rest render. If *every* row fails, `/api/feed` still
returns 200 with sample data and a `degraded` flag that the UI surfaces as a banner.

**One normalized shape.** Movies and TV disagree about `title`/`name` and
`release_date`/`first_air_date`. `toCard()` translates once at the boundary so no template
ever branches on media type.

### Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/health` | Liveness for the container healthcheck. Touches no upstream |
| `GET /api/config` | Demo flag, default region, full watch-provider region list |
| `GET /api/feed` | Hero pick + rows of cards, one request, free row included |
| `GET /api/free` | Just the watchable public-domain row |
| `GET /api/search?q=` | Catalog search **plus** watchable results, merged |
| `GET /api/title?media=&id=&region=` | Details, cast, trailer, recommendations, **and where to watch in that region** |
| `POST /api/auth/signup` · `login` · `logout` | Accounts. Sets/clears the session cookie |
| `GET /api/auth/me` | Current user and their list, or `null` |
| `GET` / `PUT /api/list` | The signed-in user's watchlist |

`media` is `movie`, `tv`, or `free`. A `free` id is an Archive identifier string rather than a
numeric TMDB id, and the response carries a direct `stream` URL instead of a provider list.

Client-side routes (`location.hash`, so links are shareable):

- `#/t/movie/27205` — opens that title's sheet directly
- `#/t/free/wings-1927_202404` — opens a free film with its player
- `#/q/blade%20runner` — opens the search palette pre-filled

### Free-copy cross-match

Opening any pre-1970 film also asks the Archive whether a public-domain copy exists. If one
does, the sheet gets a **"This one is free"** panel with a real play button instead of only
pointing at paid services.

The matching is deliberately strict, because a wrong match tells someone a film is free when it
is not: exact normalized title, years within one, and a verified playable file before the button
is ever shown. It is also gated to titles from 1970 or earlier — plenty of Archive items carry no
year, so without that gate *Nosferatu (2024)* would match the 1922 print and a licensed film
would be advertised as free. Modern titles skip the lookup entirely, which makes it cheap too.

### Where the availability data comes from

TMDB exposes JustWatch's per-country provider data at `/watch/providers`. That gives us
subscription / free / ad-supported / rent / buy tiers per region, which is the whole product.
Switching the region selector re-fetches the open title in place. Attribution is rendered in
the UI, as both APIs require.

---

## The interface

Maximalist on purpose: animated gradient mesh, film grain, scanlines, chromatic-aberration
glitch type, a cursor-tracked spotlight, pointer-tilt cards, hard offset shadows, a marquee.

All of it is gated behind one class. **Chill mode** (top right, persisted) strips every
animation and overlay while keeping the layout identical, and
`prefers-reduced-motion: reduce` does the same automatically. The loud version is a choice,
not a tax.

Other bits worth knowing:

- **`/` or ⌘K** opens search from anywhere. Arrows move, enter opens, esc closes. 180ms debounce.
- **★** on any card saves to a watchlist in `localStorage`. The **LIST** button folds it in as a row.
- Missing artwork generates a deterministic gradient from a hash of the title, so a poster-less
  entry always looks the same and never renders as a grey box.
- Trailers embed via `youtube-nocookie`, lazily.

---

## Why it works this way

The sites this replaces are fragile because they wrap scraped file hosts behind rotating
tokens and obfuscated players, and they break weekly. This one is built on two documented,
stable, permissively-licensed APIs, so it keeps working. Every outbound link goes to a service
that has the rights.

This product uses the TMDB API but is not endorsed or certified by TMDB.

---

## Accounts

Sign up with an email and a password and your watchlist follows the account instead of the
browser. Anything starred while signed out is merged in on your first sign-in rather than being
dropped. [backend/auth.js](backend/auth.js) has no dependencies:

- **Passwords** are hashed with `scrypt` (N=16384) under a per-user 16-byte random salt, and
  compared with `timingSafeEqual`. Plaintext is never stored or logged.
- **Sessions** are 32 random bytes in an `HttpOnly`, `SameSite=Lax` cookie. HttpOnly means an XSS
  bug still cannot read the session; SameSite=Lax blocks the cross-site POST shape of CSRF.
- **Login is deliberately vague** — "Email or password is incorrect" either way — and hashes a
  decoy even when no such account exists, so neither the message nor the response time reveals
  which emails are registered.
- **Throttled** to 8 failed attempts per email+IP per 15 minutes.
- **Watchlist input is sanitized** server-side to the six fields the UI renders, so it cannot
  become a dumping ground for arbitrary JSON.
- Writes go through a promise queue and a temp-file rename, so concurrent updates can neither
  interleave nor leave a half-written file.

⚠️ **This is a local-first setup, not a production auth system.** Accounts live in
`data/accounts.json` (gitignored), sessions are in that same file, and there is no email
verification, password reset, or 2FA. Before this faces a network you would want a real database,
`Secure` cookies over HTTPS (the flag is already set when `x-forwarded-proto` says https), and a
verified-email flow.

## Deploying

**GitHub Pages cannot host this.** Pages is a static file host — it serves HTML, CSS and JS and
runs no server-side code at all. This app needs a running process for three things Pages has no
way to provide:

1. Keeping the TMDB key secret. On Pages the key would have to ship inside `app.js`, where
   anyone can read it and use your quota.
2. Accounts and sessions. There is nothing to hash a password with or store a session in.
3. The Archive cross-match and caching, which are server-side calls.

You could publish a cut-down static build to Pages — catalog browsing only, key exposed in the
client, no accounts, no watchlist sync — but that is a different, worse app.

What does work, since the whole thing is now a compose file: anywhere that runs containers.
**Fly.io**, **Render**, **Railway** and any small VPS all take this as-is. Two changes when you
put it on a real host:

- Publish the frontend on `0.0.0.0` instead of `127.0.0.1` (drop the prefix in `docker-compose.yml`),
  and terminate TLS in front of it.
- Make sure the TLS terminator sends `X-Forwarded-Proto: https`, which flips the session cookie
  to `Secure` automatically — that code path is already there.

Re-read the warning in **Accounts** before exposing this publicly. The auth system is honest
local-first work, not production-hardened.

## Worth adding next

- Email verification and password reset — the two biggest gaps in the account system
- "New this week on the services I have" — filter the feed by selected providers
- Person pages (`/person/{id}` is already in TMDB)
- A `Cache-Control` header on `/api/feed` so the browser stops re-asking on every reload
