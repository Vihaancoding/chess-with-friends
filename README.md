# Chess With Friends

Multiplayer chess in the browser. Make a game, share the 5-letter code (or challenge a username), and play.

**Features:** email accounts with **account recovery** (recovery codes, emailed or admin-issued reset links) · Glicko-2 ratings per time control (bullet/blitz/rapid/classical) with provisional ratings, history graph and recent games · live move push (Supabase Realtime) · in-game chat and a voice room for players and spectators (WebRTC) · post-game review (move ratings, accuracy, eval graph) · **game archive**: every finished game is saved for good, with search, filters and sorting, a replay with play/pause and speed control, and engine analysis from any move · **opening recognition** (ECO code and named variation, updated live and on transpositions) · mutual pause · **Learn**: interactive opening, middlegame and endgame courses · **Coach**: an adaptive opponent that grades every move you make (blunders, mistakes, best moves), shows the better move, offers hints and takebacks, and tracks what to work on · **Ask the coach**: ask what you want to learn ("teach me the Caro-Kann", "what is a pin?", "how do I improve?") and get a short explanation plus a lesson to play: any of the 3,000+ named openings becomes an interactive trainer for either colour, with a from-memory drill · time controls (bullet → classical) · challenges · **head-to-head matches**: play the same friend game after game to settle who is better: best of 3/5/7 (a level score ends in an Armageddon decider: Black has less time, but a draw counts as a Black win), first to 3/5/10 wins, or an open-ended marathon; colours alternate, the next game starts by itself after a 10-second countdown (or press Wait), and a scoreboard shows the score, every game, match point and win streaks · **play the computer** (4 levels, runs in your browser) · **play against a style**: builds a playstyle profile from a player's archived games (most-used openings, aggression, tactical vs positional play, risk, sacrifices, the tactics they use, the endgames they reach, time management, typical mistakes), then a bot that plays like them, mistakes included, at four difficulty levels and any time control; afterwards it compares you with the bot (style match score, which moves it predicted, where you differed). Anyone can play anyone's bot, but a player's weak spots (mistakes, time trouble, results by opening and endgame) are only shown to that player; players get an alert when someone finishes a game against their clone (who, the result and the difficulty) · **evaluation bar** in computer and pass & play games · **pass & play**: two players on one device, with the board turning for each player; it can count for ratings, and the opponent accepts or declines the result from their own account · premoves · planning arrows (right-click drag) · draw offers, threefold repetition · drag-and-drop and click-to-move · move review · live games you can spectate · lobby chat with a "who's online" panel (lobby / playing / watching, one-click challenge) · admin panel · sound packs (Classic, Marble, Wooden, Soft, Retro, Glass).

No framework and no build step: a vanilla JS client, a small Node API, and an optional Supabase database.

## Run it locally

```bash
node server.js          # needs Node 18+
```

Open http://localhost:3000. With no database configured, everything is stored in memory and resets when the server restarts. That's fine for development.

Tests: `node scripts/test-archive.js` (game archive API), `node scripts/test-match.js` (head-to-head matches), `node scripts/test-coach-ask.js` (Ask the coach), `node scripts/test-pass-play.js` (rated pass & play results) and `node scripts/test-style.js` (playstyle profiles and clone bots), no dependencies. The browser tests `node scripts/test-archive-ui.js`, `node scripts/test-match-ui.js`, `node scripts/test-premoves.js` and `node scripts/test-style-ui.js` need Playwright.

Optional: `ADMIN_KEY=something-long node server.js` to enable the admin panel (see below).

To test emailed password resets locally with `SMTP_USER` / `SMTP_PASS` set, run `npm install` once first (it adds `nodemailer`). Everything else needs no install.

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
   | `SMTP_USER`, `SMTP_PASS` | Optional: turns on "email me a reset link", sent from this mailbox. For Gmail: your address and a [Google app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification). Other providers: also set `SMTP_HOST` / `SMTP_PORT` |
   | `RESEND_API_KEY`, `MAIL_FROM` | Optional alternative to SMTP: a [Resend](https://resend.com) API key and a sender on a domain you own (e.g. `Chess <noreply@yourdomain.com>`) |
   | `APP_URL` | Optional: your site's address for links in emails (defaults to the Vercel production URL) |
   | `SERVER_ID`, `SERVER_NAME` | Optional: run a [separate server](#separate-servers) on the same database, and a label for it |

3. Deploy. Pushing to `main` redeploys automatically.

See [`.env.example`](.env.example) for the same list.

## Separate servers

You can run a second server that is completely cut off from the first: its own accounts, leaderboard, lobby chat, live games, challenges and archive. Players on one server can't see, challenge, spectate or message players on the other, and an account made on one doesn't exist on the other. Give the second server's link to people you don't want on your main one.

Both servers use the same code and the same Supabase database (no extra SQL), so pushing to `main` updates both.

1. In Vercel, **Add New → Project** and import this same repo again (give it a different name, e.g. `chess-with-friends-2`; that name becomes its address).
2. Add the same environment variables as your main project, plus `SERVER_ID` = `2` and, if you like, `SERVER_NAME` = `Server 2` (shown next to the logo).
3. Deploy, and share the new project's URL.

Leave `SERVER_ID` unset on the main project: everyone already there keeps their account and games. For more servers use `3`, `4`, … Each server has its own admins: claim admin there with `?admin=1` and the same `ADMIN_KEY`.

## Admin panel

Emails are not verified, so admin is unlocked with a secret instead of an email address:
log in, open `https://your-site/?admin=1`, and enter `ADMIN_KEY`. An **Admin** link then appears in the sidebar. From there you can mute, reset or delete players, end live games, post an announcement and moderate chat.

## Account recovery

Players who forget their password have three ways back in. Each one sets a new password and signs out every other device.

- **Recovery code:** shown once at sign-up (and again after it is used). Email + code + new password on the "Forgot password?" screen. Players can make a new code from their own profile page; the old one stops working. Only a hash of the code is stored.
- **Email link:** with an email service set up (`SMTP_USER` + `SMTP_PASS`, or `RESEND_API_KEY` + `MAIL_FROM`), players can ask for a one-time reset link that works for 30 minutes. In local development with no email service (in-memory storage), the link is printed in the server console instead.
- **Admin link:** in the admin panel, **Password link** creates a one-time reset link (valid 24 hours) to pass on by hand. Emails aren't verified, so check who you're talking to first.

Players who signed up before recovery codes existed can create one from their profile.

## How it works

| Path | What |
|---|---|
| `public/index.html` | The whole client (UI, polling, drag and drop, sounds) |
| `public/lessons.js` | Course content (openings, middlegame, endgames). Validate edits with `node scripts/check-lessons.js` |
| `public/coachask.js` | Ask the coach: matches a question to an opening (from `openings.js`) or a topic, and builds opening trainer lessons. Runs in the browser, no AI service. Test with `node scripts/test-coach-ask.js` |
| `public/opening.js` | Opening recognition shared by browser and server (matches positions, so transpositions count) |
| `public/openings.js` | Opening names (ECO, name, moves) generated from the [Lichess opening list](https://github.com/lichess-org/chess-openings) (CC0). Rebuild with `node scripts/build-openings.js` |
| `public/bot.js` | Computer opponent (alpha-beta search with quiescence) and the Web Worker that runs reviews, live move grades, the evaluation bar, the coach's grading and playstyle scoring |
| `public/engine.js` | Analysis engine: its own fast board (make/unmake, Zobrist hashing), transposition table, null-move pruning, late-move reductions, killer/history ordering, check extensions, repetition and 50-move draws, and a tapered evaluation (PeSTO tables, pawn structure, mobility, endgame knowledge). In a review only the played move and the best two are scored exactly, which buys several extra plies. Test with `node scripts/test-engine.js` |
| `public/style.js` | Play against a style: builds a playstyle profile from archived games, picks moves the way that player would, and compares a game with a profile. Shared by the page, the worker and Node. Test with `node scripts/test-style.js` |
| `public/match.js` | Head-to-head matches: formats, scoring, the Armageddon decider, match point and streaks. Shared by the server (which keeps the match on the room and scores each game as it ends) and the page. Test with `node scripts/test-match.js` |
| `public/chess.js` | Chess engine shared by browser and server (legal moves, check/mate, castling, en passant, promotion, repetition key) |
| `lib/app.js` | API: accounts, rooms, clocks, Elo, challenges, chat, admin |
| `lib/rating.js` | Glicko-2 ratings, time-control categories |
| `lib/realtime.js` | Live push: Supabase Realtime broadcast or local SSE |
| `lib/store.js` | Tiny key-value store: Supabase when configured, memory otherwise |
| `api/index.js` | Vercel serverless entry (`server.js` is the local equivalent) |

The server is authoritative: every move is validated with the shared engine, and clocks run server-side. Game writes use a version number (compare-and-swap) so simultaneous actions never overwrite each other.

**Live updates:** after a move the server pushes a ~40-byte event (`{"m":"e2e4","v":42,"k":[wMs,bMs]}`) — through Supabase Realtime in production (needs `SUPABASE_ANON_KEY`) or Server-Sent Events when running `node server.js`. The opponent's browser applies it immediately, then confirms with the server. If push is unavailable or drops, the client falls back to polling and resyncs on reconnect.

**Performance notes:** functions are pinned to Mumbai (`bom1` in `vercel.json`) to sit next to the Supabase database. A move costs one database write on the critical path (warm instances cache the room; a version check keeps that safe), rating updates run after the push, and every API response carries a `Server-Timing` header with per-stage timings. While push is connected the client only sends a tiny version heartbeat every 4 s.

**Game archive:** when a game ends, the server saves it as `game:<id>` (no expiry) straight from the room's own record: the moves it validated, the result, the rating change and the opening. Each player gets a summary row in `games:<name>` (newest 1,000 kept in the list; the games themselves are never deleted). Saving is idempotent and is retried from the game's heartbeat until the room is marked archived, so a lost background task can't lose a game. Games need both players and at least one move to be saved. The profile lists, filters and sorts the rows in the browser. Opening a game loads the saved record and replays it in the normal game screen, using the same engine, opening matcher and review as a live game. Nothing there can change a game or an account. Computer and coach games stay on the device, as before.

**Play against a style:** the `style_games` API returns a player's last 40 archived games in one response; the browser builds the profile in a Web Worker and caches it on the device until they play again (about a minute for 40 games). Each of their moves gets a short engine search that scores every legal move as seen 1, 2 and 3 moves ahead. Two small models are then fitted to their own choices: a **move model** (softmax over ~28 features per move: the loss at each search depth, check, capture, trade, sacrifice, threat, retreat, castling, which piece, recapture…), whose weights on the three loss columns capture how deep they look, so the bot misses the same kind of tactics they miss; and a **timing model** (least squares on log think time: phase, clock left, number of legal moves, forced moves, recaptures, close decisions…), which the bot samples from for each move. Every 5th game is held out first and the profile card shows how many of those moves the model predicted exactly, next to the engine alone. The clone plays their opening book first, then the move model; difficulty scales how much it cares about what the deeper search sees. Online games record each move's thinking time and clock; older games have no time data.

**Ratings:** Glicko-2 (`lib/rating.js`), one game per rating period, separate ratings for bullet/blitz/rapid/classical (category = base + 40×increment seconds). New players are provisional (shown with `?`) until their rating deviation drops below 110. Games that end before both players have moved are not rated.

## Known limitations / ideas

- No email verification, and no "change password" while signed in (use a recovery code).
- Read-modify-write on the key-value store can race under heavy concurrency; fine for friends, not for thousands of players.
- No opening explorer yet. Games finished before the archive existed show in the list without a replay (their moves were never stored).
- Abandoned untimed games are never cleaned up automatically.

## Credits

Piece images are the Cburnett set, loaded from the [lichess](https://github.com/lichess-org/lila) repository via jsDelivr (see their license). Fonts: Noto Sans.

## License

MIT. See [LICENSE](LICENSE).
