# Chess With Friends

A private chess club in the browser for you and your friends. Play live rated games, climb your own leaderboard, settle scores in rivalries and tournaments, and review your games with Stockfish.

No framework and no build step: a vanilla JS client, a small Node server and a Supabase database.

**Contents:** [Features](#features) · [Quick start](#quick-start) · [Deploy](#deploy) · [Running the site](#running-the-site) · [How it works](#how-it-works) · [Development](#development) · [Known limitations](#known-limitations) · [Credits and license](#credits-and-license)

## Features

**Play**
- Live games from a 5-letter code or a challenge by username, bullet to classical, with premoves, planning arrows, draw offers and mutual pause
- Glicko-2 ratings per time control (bullet, blitz, rapid, classical), with provisional ratings and a history graph
- **Head-to-head matches:** best of 3/5/7 with an Armageddon decider, first to 3/5/10, or an open-ended marathon
- **Tournaments:** groups then knockout, straight knockout or round robin, seeded by rating, with their own chat
- **Play the computer** (4 levels), **pass & play** (can count for ratings) and **play against a style**: a bot built from a player's own games that plays like them, mistakes included
- **Rooms:** private rooms for a group of friends, with chat, open tables and a shared sandbox board

**Compete**
- **Rivalries:** a head-to-head record with everyone you play, with tiers, streaks, moments and seasons
- **Win streaks** and the **Streak Hunt:** players on a streak are targets, and ending a streak is news for the whole site
- **King of the Server:** the longest active win streak (5+) wears the crown. When the King falls everyone online sees it, and beating the King with no streak of your own makes you a permanent **Kingslayer**
- **The Damage Report:** a 0-100 Domination Score and commentary for every finished game, with a share card
- Leaderboards for ratings, streaks and move stats (banned players always rank last)

**Watch and learn**
- **Live tune-in** finds the exciting games happening now, and **Reels** is a vertical feed of great moments
- Spectating with chat, video-only cameras, and **SHUT UP** for disruptive spectators
- **Game archive:** every finished game is kept for good, with search, replay and engine analysis
- **Learn** courses, a **Coach** that grades every move, **Ask the coach** (any of 3,000+ openings becomes a trainer) and a **puzzle trainer** with Lichess puzzles
- Opening recognition, an evaluation bar, post-game review, and a choice of engine (ours or Stockfish 19 in the browser)

**Community**
- **Servers:** separate groups of players on one site, joined with a code
- Recovery codes and emailed reset links, profile pictures, GIFs in chat, @mentions, an **Ideas** board for feature requests, sound packs
- **Fair play:** a statistical engine-use detector, a community tribunal and appeals

More detail on each feature: [docs/features.md](docs/features.md).

## Quick start

```bash
npm install            # once
node server.js         # Node 18+
```

Open http://localhost:3000. With no database configured, everything is kept in memory and resets when the server restarts, which is fine for development. Run with `ADMIN_KEY=something-long` to enable the admin panel.

## Deploy

All data lives in Supabase, so the site can move between hosts without losing anything.

1. **Database:** create a free [Supabase](https://supabase.com) project, open **SQL Editor** and run [`supabase.sql`](supabase.sql).
2. **Host:** pick one.
   - **Render (free):** **New → Web Service**, choose this repo, build command `npm install`, start command `npm start`, instance type Free, and set `LITE=1`. [`render.yaml`](render.yaml) has the same settings for **New → Blueprint**. A free instance sleeps after 15 idle minutes and takes 30-60 s to wake.
   - **Vercel:** import the repo; [`vercel.json`](vercel.json) sets everything up, and Stockfish runs in its own function (`api/fairplay.js`, needs `FAIR_SECRET`). Heavy engine use can go over the Hobby plan's CPU limit.
3. **Environment variables:**

   | Variable | Needed | What it is |
   |---|---|---|
   | `SUPABASE_URL` | yes | `https://<project-ref>.supabase.co` (the ref is in the Supabase dashboard URL) |
   | `SUPABASE_SERVICE_KEY` | yes | The `service_role` / secret key. Server only, never commit it |
   | `SUPABASE_ANON_KEY` | yes | The anon / publishable key. Turns on instant live updates; without it the app polls |
   | `ADMIN_KEY` | yes | A long passphrase of your choice. Unlocks the admin panel |
   | `LITE` | on small hosts | `1`: no Stockfish on the server, so no automatic fair-play checks or new Damage Reports |
   | `BREVO_API_KEY`, `MAIL_FROM` | for email | A free [Brevo](https://www.brevo.com) API key and a sender verified in Brevo, e.g. `Chess <you@gmail.com>`. Works on hosts that block SMTP, like Render's free plan |
   | `SMTP_USER`, `SMTP_PASS` | email, alternative | Send from a mailbox (Gmail: your address and an [app password](https://myaccount.google.com/apppasswords)); `SMTP_HOST` / `SMTP_PORT` for other providers |
   | `RESEND_API_KEY`, `MAIL_FROM` | email, alternative | [Resend](https://resend.com); needs a domain you own |
   | `APP_URL` | optional | The site's address for emailed links (found automatically on Render and Vercel) |
   | `GIPHY_API_KEY` | optional | GIF search in chat |
   | `ANTHROPIC_API_KEY` or `LLAMA_API_KEY` | optional | AI commentary for the Damage Report (Claude, or Llama through Groq); without one it uses built-in templates |
   | `TURN_URL`, `TURN_USER`, `TURN_PASS` | optional | A TURN relay for cameras on strict networks |
   | `FAIR_SECRET` | Vercel only | Shared secret between the app and the fair-play function |

   [`.env.example`](.env.example) has the full list with comments.

## Running the site

### Admin panel

Log in, open `https://your-site/?admin=1` and enter `ADMIN_KEY`. An **Admin** link then appears in the sidebar. From there you can mute, reset or delete players, end live games, post announcements, moderate chat, create password links, manage servers and review fair-play cases.

### Servers

Each server has its own players, leaderboard, lobby chat, live games, challenges and archive. Players on one server can't see, challenge, spectate or look up players on another. Accounts are shared, so usernames and emails are unique across all servers.

- Everyone who signed up before servers existed is on **Server 1**. It has no code, so nobody new can join it (except the very first account on a new site, so someone can sign up and become admin).
- Admins create servers in **Admin → Servers**. Each gets a sign-up code; **Copy invite link** gives `https://your-site/?join=CODE`, which fills the code in. Admins can replace a code or turn it off to close the server.
- Admins move a player with the **Server** menu next to their name, and use **Switch here** to look at another server themselves.

### Account recovery

Three ways back in after a forgotten password. Each sets a new password and signs out every other device.

- **Recovery code:** shown once at sign-up (and again after it is used). Players can make a new one from their profile; only a hash is stored.
- **Email link:** with an email service set up (see [Deploy](#deploy)), a one-time link that works for 30 minutes. Locally, with no email service, the link is printed in the server console.
- **Admin link:** **Password link** in the admin panel makes a one-time link (24 hours) to pass on by hand. Emails aren't verified, so check who you're talking to first.

### Fair play

The detector is a rating- and difficulty-adjusted statistical model with five levels: Normal, Unusual, Suspicious, High-confidence and Confirmed. Only High-confidence can forfeit a game automatically, through a tribunal with a community poll and appeals; Suspicious opens an admin-only investigation. During online games the browser also reports anything drawn on the board that the app didn't make, as engine extensions do.

On Vercel the engine runs in `api/fairplay.js`, never in the function that serves moves, and needs `FAIR_SECRET`. Locally it runs in the same process. With `LITE=1` it is off. Details and the benchmark: [docs/fairplay-detection.md](docs/fairplay-detection.md).

## How it works

- **The server is authoritative.** Every move is checked with the shared chess code, and clocks run on the server. Game writes carry a version number (compare-and-swap), so simultaneous actions never overwrite each other.
- **Live updates.** After a move the server pushes a ~40-byte event through Supabase Realtime (or Server-Sent Events locally). The opponent's browser applies it at once, then confirms with the server. If push drops, the client polls and resyncs.
- **Fast moves.** A move costs one database write on the critical path; ratings, the archive and everything else run after the push. Every API response carries a `Server-Timing` header.
- **Storage.** Everything is JSON in one Supabase key-value table (`lib/store.js`), or in memory when no database is configured.

### Project layout

| Area | Files |
|---|---|
| Server | `server.js` (Node server: local and Render), `api/index.js` (Vercel entry), `lib/app.js` (every API route), `lib/store.js`, `lib/realtime.js` |
| Chess | `public/chess.js` (rules, shared by browser and server), `public/opening.js` + `public/openings.js` (opening names from the [Lichess list](https://github.com/lichess-org/chess-openings)), `lib/rating.js` (Glicko-2) |
| Engines | `public/engine.js` (our analysis engine), `public/bot.js` (computer opponent and analysis worker), `public/sfengine.js` + `public/stockfish/` (Stockfish in the browser), `lib/sfserver.js` (Stockfish on the server) |
| Client | `public/index.html` (the whole app), plus `lessons.js`, `coachask.js`, `style.js`, `puzzles.js`, `lounge.js`, `sandbox.js` in `public/` |
| Competition | `public/match.js`, `public/tournament.js`, `lib/rivalry.js`, `lib/streaks.js`, `lib/streakhunt.js`, `lib/king.js` |
| Highlights | `lib/damage*.js` (Damage Report), `public/excite.js` + `lib/reels.js` (Live tune-in and Reels, see [docs/live-and-reels.md](docs/live-and-reels.md)), `lib/movestats.js` |
| Fair play | `lib/fairplay.js`, `lib/fairan.js`, `lib/fairmodel.js`, `lib/tribunal.js`, `api/fairplay.js` |
| Puzzles | `lib/puzzles.js`, `lib/puzzleai.js`, `data/puzzles.tsv.gz` (see [docs/puzzles.md](docs/puzzles.md)) |

[docs/code-map.md](docs/code-map.md) lists every file, who requires whom, and every API route.

## Development

- **Tests** are `scripts/test-*.js`. Run one with `node scripts/test-name.js`. The `*-ui.js` tests drive real browsers and need Playwright. The code map lists them all.
- **Code map:** run `node scripts/code-map.js` after adding or renaming files or routes.
- **Course content:** check edits to `public/lessons.js` with `node scripts/check-lessons.js`.
- **Rebuild data:** `node scripts/build-openings.js` (opening names), `node scripts/build-puzzles.js` (puzzle index), `node scripts/fair-calibrate.js` (fair-play calibration).

## Known limitations

- No email verification, and no "change password" while signed in (use a recovery code).
- Read-modify-write on the key-value store can race under heavy load: fine for friends, not for thousands of players.
- No opening explorer yet. Games finished before the archive existed show without a replay.
- Abandoned untimed games are never cleaned up automatically.

## Credits and license

- Puzzles are from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0). Piece images are the Cburnett set from [lichess](https://github.com/lichess-org/lila), loaded via jsDelivr. Font: Noto Sans.
- `public/stockfish/` is [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19 (lite, single-threaded WebAssembly), based on [Stockfish](https://github.com/official-stockfish/Stockfish), under the GPLv3 (see `public/stockfish/COPYING.txt`), separately from the rest of the project.
- Everything else: MIT. See [LICENSE](LICENSE).
