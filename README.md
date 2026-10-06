# Chess With Friends

Multiplayer chess in the browser. Make a game, share the 5-letter code (or challenge a username), and play.

**Features:** email accounts · Glicko-2 ratings per time control (bullet/blitz/rapid/classical) with provisional ratings, history graph and recent games · live move push (Supabase Realtime) · in-game chat and a voice room for players and spectators (WebRTC) · post-game review (move ratings, accuracy, eval graph) · **opening recognition** (ECO code and named variation, updated live and on transpositions) · mutual pause · **Learn**: interactive opening, middlegame and endgame courses · **Coach**: an adaptive opponent that grades every move you make (blunders, mistakes, best moves), shows the better move, offers hints and takebacks, and tracks what to work on · time controls (bullet → classical) · challenges · **play the computer** (4 levels, runs in your browser) · premoves · planning arrows (right-click drag) · draw offers, threefold repetition · drag-and-drop and click-to-move · move review · live games you can spectate · lobby chat with a "who's online" panel (lobby / playing / watching, one-click challenge) · admin panel · sound packs (Classic, Marble, Wooden, Soft, Retro, Glass).

No framework and no build step: a vanilla JS client, a small Node API, and an optional Supabase database.

## Run it locally

```bash
node server.js          # needs Node 18+
```

Open http://localhost:3000. With no database configured, everything is stored in memory and resets when the server restarts. That's fine for development.

Optional: `ADMIN_KEY=something-long node server.js` to enable the admin panel (see below).

## Deploy (Vercel + Supabase, both free tiers)

1. **Supabase:** create a project, open **SQL Editor**, and run [`supabase.sql`](supabase.sql).
2. **Vercel:** import this repo. Under **Settings → Environment Variables** add:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | Project URL (Supabase → Project Settings → API) |
   | `SUPABASE_SERVICE_KEY` | The `service_role` / secret key. **Server-only, never commit it** |
   | `ADMIN_KEY` | A long passphrase of your choice (enables the admin panel) |
   | `TURN_URL`, `TURN_USER`, `TURN_PASS` | Optional: a TURN relay for voice calls on networks that block direct connections |
   | `SUPABASE_ANON_KEY` | Optional: the *publishable / anon* key (Project Settings → API). Turns on instant live updates; without it the app polls |

3. Deploy. Pushing to `main` redeploys automatically.

See [`.env.example`](.env.example) for the same list.

## Admin panel

Emails are not verified, so admin is unlocked with a secret instead of an email address:
log in, open `https://your-site/?admin=1`, and enter `ADMIN_KEY`. An **Admin** link then appears in the sidebar. From there you can mute, reset or delete players, end live games, post an announcement and moderate chat.

## How it works

| Path | What |
|---|---|
| `public/index.html` | The whole client (UI, polling, drag and drop, sounds) |
| `public/lessons.js` | Course content (openings, middlegame, endgames). Validate edits with `node scripts/check-lessons.js` |
| `public/openings.js` | Opening names (ECO, name, moves) generated from the [Lichess opening list](https://github.com/lichess-org/chess-openings) (CC0). Rebuild with `node scripts/build-openings.js` |
| `public/bot.js` | Computer opponent: alpha-beta search with quiescence, runs in a Web Worker |
| `public/chess.js` | Chess engine shared by browser and server (legal moves, check/mate, castling, en passant, promotion, repetition key) |
| `lib/app.js` | API: accounts, rooms, clocks, Elo, challenges, chat, admin |
| `lib/rating.js` | Glicko-2 ratings, time-control categories |
| `lib/realtime.js` | Live push: Supabase Realtime broadcast or local SSE |
| `lib/store.js` | Tiny key-value store: Supabase when configured, memory otherwise |
| `api/index.js` | Vercel serverless entry (`server.js` is the local equivalent) |

The server is authoritative: every move is validated with the shared engine, and clocks run server-side. Game writes use a version number (compare-and-swap) so simultaneous actions never overwrite each other.

**Live updates:** after a move the server pushes a ~40-byte event (`{"m":"e2e4","v":42,"k":[wMs,bMs]}`) — through Supabase Realtime in production (needs `SUPABASE_ANON_KEY`) or Server-Sent Events when running `node server.js`. The opponent's browser applies it immediately, then confirms with the server. If push is unavailable or drops, the client falls back to polling and resyncs on reconnect.

**Performance notes:** functions are pinned to Mumbai (`bom1` in `vercel.json`) to sit next to the Supabase database. A move costs one database write on the critical path (warm instances cache the room; a version check keeps that safe), rating updates run after the push, and every API response carries a `Server-Timing` header with per-stage timings. While push is connected the client only sends a tiny version heartbeat every 4 s.

**Ratings:** Glicko-2 (`lib/rating.js`), one game per rating period, separate ratings for bullet/blitz/rapid/classical (category = base + 40×increment seconds). New players are provisional (shown with `?`) until their rating deviation drops below 110. Games that end before both players have moved are not rated.

## Known limitations / ideas

- No email verification or password reset (needs an email service such as Resend or Supabase Auth).
- Read-modify-write on the key-value store can race under heavy concurrency; fine for friends, not for thousands of players.
- No per-player game history or opening explorer yet.
- Abandoned untimed games are never cleaned up automatically.

## Credits

Piece images are the Cburnett set, loaded from the [lichess](https://github.com/lichess-org/lila) repository via jsDelivr (see their license). Fonts: Noto Sans.

## License

MIT. See [LICENSE](LICENSE).
