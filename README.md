# Chess With Friends

A private chess club in the browser for you and your friends. Play live rated games, climb your own leaderboard, settle scores in rivalries and tournaments, and review your games with Stockfish.

No framework and no build step: a vanilla JS client, a small Node server and a Supabase database.

## Features

**Play**
- Live games with a 5-letter code or a challenge by username; bullet to classical time controls; premoves, planning arrows, draw offers, mutual pause
- Glicko-2 ratings per time control (bullet / blitz / rapid / classical) with provisional ratings and a history graph
- **Head-to-head matches:** best of 3/5/7 with an Armageddon decider, first to 3/5/10, or an open-ended marathon
- **Tournaments:** groups plus knockout, straight knockout or round robin, seeded by rating, with their own chat and a live strip
- **Play the computer** (4 levels, in your browser), **pass & play** (can count for ratings) and **play against a style**: a bot built from a player's own games that plays like them, mistakes included
- **Rooms:** private rooms for a group of friends with their own chat, tables and a shared sandbox board

**Compete**
- **Rivalries:** a head-to-head record with everyone you play, with tiers, streaks, moments and seasons
- **Win streaks** and **Streak Hunt:** players on a streak are targets, and ending a streak is an event the whole site hears about
- **King of the Server:** the longest active win streak (5+) wears the crown. When the King falls, everyone online sees a cinematic, and beating a King with no streak of your own makes you a permanent **Kingslayer**
- **The Damage Report:** a 0-100 Domination Score and commentary for every finished game, with a share card
- Leaderboards for ratings, streaks and move stats; banned players always rank last

**Watch and learn**
- **Live tune-in** finds the exciting games happening now; **Reels** is a vertical feed of great moments
- Spectating with chat, cameras (video only) and **SHUT UP** for disruptive spectators
- **Game archive:** every finished game saved for good, with search, replay and engine analysis
- **Learn** courses, a **Coach** that grades every move, **Ask the coach** (any of 3,000+ openings becomes a trainer) and a **puzzle trainer** with Lichess puzzles
- Opening recognition, evaluation bar, post-game review, and a choice of engine (our own or Stockfish 19 in the browser)

**Run the club**
- **Servers:** split players into separate groups, joined with a code
- Admin panel: moderation, announcements, password links, fair-play cases
- **Fair play:** a statistical engine-use detector with a community tribunal and appeals
- Accounts with recovery codes and emailed reset links, profile pictures, GIFs in chat, @mentions, an **Ideas** board for feature requests, sound packs

## Run it locally

```bash
npm install            # once (nodemailer for email, resvg for share images)
node server.js         # needs Node 18+
```

Open http://localhost:3000. With no database configured, everything is kept in memory and resets when the server restarts, which is fine for development. `ADMIN_KEY=something-long node server.js` enables the admin panel.

**Tests** are `scripts/test-*.js`; run one with `node scripts/test-name.js`. The `*-ui.js` ones drive real browsers and need Playwright. [`docs/code-map.md`](docs/code-map.md) lists every file, API route and test.

## Deploy

All data lives in Supabase, so the site can move between hosts without losing anything.

1. **Supabase:** create a free project, open **SQL Editor** and run [`supabase.sql`](supabase.sql).
2. **Pick a host:**
   - **Render (free):** **New → Web Service**, pick this repo, build command `npm install`, start command `npm start`, instance type Free. [`render.yaml`](render.yaml) has the same settings for **New → Blueprint**. Set `LITE=1`: the free instance has a fraction of one CPU, so the server runs no Stockfish (no automatic fair-play checks or new Damage Reports). A free instance sleeps after 15 idle minutes and takes 30-60 s to wake.
   - **Vercel:** import the repo; `vercel.json` sets everything up, and Stockfish runs in its own function (`api/fairplay.js`, set `FAIR_SECRET`). Heavy engine use can go over the Hobby plan's CPU limit.
3. **Environment variables:**

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` (the ref is in the dashboard URL) |
   | `SUPABASE_SERVICE_KEY` | The `service_role` / secret key. **Server only, never commit it** |
   | `SUPABASE_ANON_KEY` | The anon / publishable key. Turns on instant live updates; without it the app polls |
   | `ADMIN_KEY` | A long passphrase of your choice (unlocks the admin panel) |
   | `LITE` | `1` on a small host: no Stockfish on the server |
   | `BREVO_API_KEY`, `MAIL_FROM` | Optional, recommended for email: a free [Brevo](https://www.brevo.com) API key and a sender verified in Brevo, e.g. `Chess <you@gmail.com>`. Works on hosts that block SMTP (Render's free plan) |
   | `SMTP_USER`, `SMTP_PASS` | Optional alternative: send from a mailbox (Gmail: your address and an [app password](https://myaccount.google.com/apppasswords)); also `SMTP_HOST` / `SMTP_PORT` for others |
   | `RESEND_API_KEY`, `MAIL_FROM` | Optional alternative: [Resend](https://resend.com), needs a domain you own |
   | `APP_URL` | Optional: the site's address for emailed links (Render and Vercel addresses are found automatically) |
   | `GIPHY_API_KEY` | Optional: GIF search in chat |
   | `ANTHROPIC_API_KEY` or `LLAMA_API_KEY` | Optional: AI commentary for the Damage Report (Claude, or Llama through Groq); without one it uses built-in templates |
   | `TURN_URL`, `TURN_USER`, `TURN_PASS` | Optional: a TURN relay for cameras on strict networks |
   | `FAIR_SECRET` | Vercel only: the shared secret for the fair-play function |

   [`.env.example`](.env.example) has the full list with comments.

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
| `lib/rivalry.js` | Rivalries: head-to-head records, tiers (with anti-farming rules), streaks, moments, seasons and insights, all derived from the archive rows the server writes. Test with `node scripts/test-rivalries.js` (and `test-rivalries-ui.js` in the browser) |
| `lib/tribunal.js` | Fair-play tribunal rules: how sure the engine check must be before a forfeit (two independent signals, 95%), the announcement phrases and their checks, the five-option community poll, quorums and appeals. The flow lives in `lib/app.js` ("Fair play"); every case is one record with its evidence, votes and audit log. Spectators see a live game 4 moves late, and moves in live rated games go to the opponent's private channel, not the public room channel |
| `lib/damage.js`, `damageeng.js`, `damagetext.js`, `damagebank.js`, `damagecard.js` | The Damage Report: a deterministic 0-100 Domination Score per finished online game (replay, facts, score), background engine analysis in resumable slices (our own engine, not Stockfish), the commentary (AI candidates checked against the real facts, with a bank of 280+ templates as fallback) and the share picture (SVG rasterised by `@resvg/resvg-js` with the fonts in `lib/fonts/`). Test with `node scripts/test-damage.js` and `test-damage-ui.js` |
| `public/tournament.js` | Tournaments: groups, round robins, standings and tiebreaks, seeding, brackets with byes, results moving the tournament on. Shared by the server (which stores each tournament and plays every pairing in a room) and the page. Test with `node scripts/test-tournament.js` |
| `public/match.js` | Head-to-head matches: formats, scoring, the Armageddon decider, match point and streaks. Shared by the server (which keeps the match on the room and scores each game as it ends) and the page. Test with `node scripts/test-match.js` |
| `public/chess.js` | Chess engine shared by browser and server (legal moves, check/mate, castling, en passant, promotion, repetition key) |
| `lib/app.js` | API: accounts, rooms, clocks, Elo, challenges, chat, admin |
| `lib/rating.js` | Glicko-2 ratings, time-control categories |
| `lib/realtime.js` | Live push: Supabase Realtime broadcast or local SSE |
| `lib/store.js` | Tiny key-value store: Supabase when configured, memory otherwise |
| `api/index.js` | Vercel serverless entry (`server.js` runs the same app as a normal Node server: locally and on Render) |
| `lib/king.js` | King of the Server: who holds the crown and what happened after each game (pure). Test with `node scripts/test-king.js` |
| `lib/streakhunt.js`, `lib/streaks.js` | Win streaks and the Streak Hunt. See [docs/streak-hunt.md](docs/streak-hunt.md) |
| `public/excite.js`, `lib/reels.js` | Live tune-in and Reels. See [docs/live-and-reels.md](docs/live-and-reels.md) |
| `public/lounge.js`, `public/sandbox.js` | Rooms and the sandbox board |

The server is authoritative: every move is validated with the shared engine, and clocks run server-side. Game writes use a version number (compare-and-swap) so simultaneous actions never overwrite each other.

**Live updates:** after a move the server pushes a ~40-byte event (`{"m":"e2e4","v":42,"k":[wMs,bMs]}`) — through Supabase Realtime in production (needs `SUPABASE_ANON_KEY`) or Server-Sent Events when running `node server.js`. The opponent's browser applies it immediately, then confirms with the server. If push is unavailable or drops, the client falls back to polling and resyncs on reconnect.

**Performance notes:** functions are pinned to Mumbai (`bom1` in `vercel.json`) to sit next to the Supabase database. A move costs one database write on the critical path (warm instances cache the room; a version check keeps that safe), rating updates run after the push, and every API response carries a `Server-Timing` header with per-stage timings. While push is connected the client only sends a tiny version heartbeat every 4 s.

**Game archive:** when a game ends, the server saves it as `game:<id>` (no expiry) straight from the room's own record: the moves it validated, the result, the rating change and the opening. Each player gets a summary row in `games:<name>` (newest 1,000 kept in the list; the games themselves are never deleted). Saving is idempotent and is retried from the game's heartbeat until the room is marked archived, so a lost background task can't lose a game. Games need both players and at least one move to be saved. The profile lists, filters and sorts the rows in the browser. Opening a game loads the saved record and replays it in the normal game screen, using the same engine, opening matcher and review as a live game. Nothing there can change a game or an account. Computer and coach games stay on the device, as before.

**Play against a style:** the `style_games` API returns a player's last 40 archived games in one response; the browser builds the profile in a Web Worker and caches it on the device until they play again (about a minute for 40 games). Each of their moves gets a short engine search that scores every legal move as seen 1, 2 and 3 moves ahead. Two small models are then fitted to their own choices: a **move model** (softmax over ~28 features per move: the loss at each search depth, check, capture, trade, sacrifice, threat, retreat, castling, which piece, recapture…), whose weights on the three loss columns capture how deep they look, so the bot misses the same kind of tactics they miss; and a **timing model** (least squares on log think time: phase, clock left, number of legal moves, forced moves, recaptures, close decisions…), which the bot samples from for each move. Every 5th game is held out first and the profile card shows how many of those moves the model predicted exactly, next to the engine alone. The clone plays their opening book first, then the move model; difficulty scales how much it cares about what the deeper search sees. Online games record each move's thinking time and clock; older games have no time data.

**Ratings:** Glicko-2 (`lib/rating.js`), one game per rating period, separate ratings for bullet/blitz/rapid/classical (category = base + 40×increment seconds). New players are provisional (shown with `?`) until their rating deviation drops below 110. Games that end before both players have moved are not rated.

## Servers

Players can be split into separate servers on the same site. Each server has its own players, leaderboard, lobby chat, live games, challenges and game archive, and players on one server can't see, challenge, spectate or look up players on another.

- Everyone who signed up before servers existed is on **Server 1**. Server 1 never has a code, so nobody new can join it (except the very first account on a brand-new site, so someone can sign up and become admin).
- Admins create servers in the **Admin panel → Servers**. Each server gets a sign-up code: give it to the people who should join that server, and they enter it in **Server code** when they sign up. **Copy invite link** gives a link (`https://your-site/?join=CODE`) that fills the code in for them. Admins can make a new code (the old one stops working) or turn the code off to close the server.
- Admins move a player with the **Server** menu next to their name, and use **Switch here** to move themselves: the lobby, chat, live games and the rest of the admin panel then show that server.

Accounts are shared, so usernames and emails are unique across all servers.

## Admin panel

Emails are not verified, so admin is unlocked with a secret instead of an email address:
log in, open `https://your-site/?admin=1`, and enter `ADMIN_KEY`. An **Admin** link then appears in the sidebar. From there you can mute, reset or delete players, end live games, post an announcement and moderate chat.

**Fair play** (flags only; it never changes a game or an account):
- **Engine check:** while the admin panel is open, each player's recent finished games (16+ moves) are replayed through the analysis engine. For every move after the opening it records whether it was the engine's top choice and how many centipawns it lost. People usually play the top move about half the time and lose 30+ centipawns a move; a player well past that over several games, or in one long game, is marked **possible engine**. Move times are shown too, since engine users tend to spend the same time on every move.
- **Board reports:** during online games the player's browser looks for anything drawn on the board that the app didn't make (as Stockfish extensions do: arrows, highlights, a layer over the board) and for the names such tools use, and reports what it found. Other extensions can trip it, so check what was reported. Neither check can see a second device; the engine check is what catches that.

## Account recovery

Players who forget their password have three ways back in. Each one sets a new password and signs out every other device.

- **Recovery code:** shown once at sign-up (and again after it is used). Email + code + new password on the "Forgot password?" screen. Players can make a new code from their own profile page; the old one stops working. Only a hash of the code is stored.
- **Email link:** with an email service set up (`BREVO_API_KEY`, `SMTP_USER` + `SMTP_PASS`, or `RESEND_API_KEY`, each with `MAIL_FROM` where needed), players can ask for a one-time reset link that works for 30 minutes. In local development with no email service (in-memory storage), the link is printed in the server console instead.
- **Admin link:** in the admin panel, **Password link** creates a one-time reset link (valid 24 hours) to pass on by hand. Emails aren't verified, so check who you're talking to first.

Players who signed up before recovery codes existed can create one from their profile.

## Win streaks

Career statistics, separate from the Damage Report. Streaks count from each player's very first completed game. `lib/streaks.js` is pure: current and longest streak, wins, losses, draws, games, win rate and milestones (3, 5, 10, 15, 20, 50 in a row) are always rebuilt from the player's whole archive (`games:<name>`), oldest game first, and stored as `strk:<name>` (no migration). A rebuild means a game is never counted twice, duplicate result events change nothing, and the backfill for existing players is the same code (done when a profile or the board is opened, 40 players at a time). A loss or a draw resets the streak, the longest never goes down, and abandoned games, games under 2 moves and rows without a valid result do not count. Limit: the archive keeps each player's latest 1000 games; for someone with more the stats say so.

Where it shows: a **Win streaks** card in the lobby with the leaderboard's own look (tabs: streak, best streak, win rate with a 10-game minimum, wins, games; a tier badge for anyone on 3+; one line of commentary from the real numbers), rating-style cards on profiles, and a toast after a game for a milestone, a new record or the end of a streak of 3+ (once per game). Tests: `node scripts/test-streaks.js`, `node scripts/test-streaks-ui.js`.

## SHUT UP

A player in a live game can tell a spectator who is being disruptive to **SHUT UP**: a bar above the game chat lists the spectators (and every spectator message has the same action) for the two players only. The server records it in the game's room record (`room.shut`), announces it in the chat ("ann told cat to SHUT UP."), and the spectators of the game (not the two players, who keep playing) see a full-screen takeover with the silenced spectator's name (about 2 s, then back to the board; the clock and the game are not touched). The spectator can keep watching but the server refuses any new chat message from them; what they wrote before stays in the chat for everybody. If both players do it, it becomes a **DOUBLE SHUT UP** with a bigger takeover; one player's revoke ("Let them talk") leaves the other's in place. Rules enforced server-side (`game_shutup`, `game_shutup_revoke`): only the two players of a game in progress, only against someone watching (never the opponent or yourself), once per player and spectator, 20 s cooldown per player and 6 s between any two in a room. It ends with the game and a rematch starts clean. The takeover respects the sound setting and `prefers-reduced-motion` (a calm static version). Tests: `node scripts/test-shutup.js` (API, 39 checks) and `node scripts/test-shutup-ui.js` (four browsers).

## Puzzle trainer

**Puzzles** in the menu: authentic puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0), filtered by theme and difficulty, with an AI search ("difficult knight forks"), weakness and mixed training, hints, an engine-checked review and progress tracking. The puzzles live in a local index (`data/puzzles.tsv.gz`, built by `scripts/build-puzzles.js`); solutions stay on the server until a puzzle is finished. Setup, data, AI and configuration: [docs/puzzles.md](docs/puzzles.md).

## Camera / Chat tabs

In a live game the two players get CAMERA and CHAT tabs beside the board. The camera is video only (never any audio or microphone), browser-to-browser WebRTC at 320x240, 15 fps and 140 kbps at most, never recorded or stored. Each player turns their own camera on (the browser asks); the server only relays the handshake (`cam_signal`), privately to the opponent, and only between the two players. Spectators can chat as before (set `GAME_CHAT_PLAYERS_ONLY=1` to keep a live game's chat to the two players; games played from a private room are only open to that room's members, chat included), and spectators can open the CAMERA tab to watch both players' cameras (receive only, at most 3 spectators per player at once, only while their tab is open). Test: `node scripts/test-camera-ui.js` (two real browsers with fake cameras).

## Fair-play detection

Stockfish never runs in `api/index.js` (moves, chat). After a move, `api/index.js` POSTs `{ code, srv }` to `/api/fairplay` with the shared secret in `x-fair-secret` and does not wait; `api/fairplay.js` (maxDuration 60) answers 202 at once and checks the game in the background after every move, and also analyses finished games. **Set `FAIR_SECRET` in Vercel** (any long random string); without it the check is off on Vercel. Locally (`node server.js`) the check runs in the same process and needs nothing.

The detector is a rating- and difficulty-adjusted statistical model with five levels (Normal, Unusual, Suspicious, High-confidence, Confirmed). Only High-confidence can forfeit a game automatically; Suspicious opens an admin-only investigation. How it works, the benchmark against the old rule and the limitations: [docs/fairplay-detection.md](docs/fairplay-detection.md). Rebuild the calibration with `node scripts/fair-calibrate.js`.

## Profile pictures, GIFs and move stats

- **Profile pictures:** on your own profile, choose a picture; the browser shrinks it to a small square and saves it (`avatar_set`); a GIF or animated WebP up to 400 KB is saved as it is, so it stays animated. It shows next to names in the sidebar, players list, leaderboard, chats and rivalries; without one you get a coloured initial. Anyone can fetch `/api?r=avatar&n=<name>`; admins can clear someone's picture from the admin page.
- **GIFs in chat:** a GIF button next to every chat box. Pasting a link from Giphy, Tenor or Imgur works anywhere; set `GIPHY_API_KEY` to also get a search. The message is just the GIF's address, shown as a picture only for those sites.
- **Move stats:** every finished game is judged move by move with Stockfish (`lib/movestats.js`) for the stats leaderboard. Players' browsers do the counting in the background (`stats_job` / `stats_submit`); set `STATS_SERVER=1` to count on the server instead. Tests: `node scripts/test-brilliant.js`, `node scripts/test-movestats.js`.

## Known limitations / ideas

- No email verification, and no "change password" while signed in (use a recovery code).
- `LITE=1` (the free Render setup) turns off the fair-play engine and the Damage Report engine on the server.
- Read-modify-write on the key-value store can race under heavy concurrency; fine for friends, not for thousands of players.
- No opening explorer yet. Games finished before the archive existed show in the list without a replay (their moves were never stored).
- Abandoned untimed games are never cleaned up automatically.

## Third-party code

`public/stockfish/` is [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19 (lite, single-threaded WebAssembly), based on [Stockfish](https://github.com/official-stockfish/Stockfish). It is licensed under the GPLv3 (see `public/stockfish/COPYING.txt`), separately from the rest of this project. It only runs when a player picks Stockfish as their analysis engine.

## Credits

Puzzles are from the Lichess puzzle database (CC0). Piece images are the Cburnett set, loaded from the [lichess](https://github.com/lichess-org/lila) repository via jsDelivr (see their license). Fonts: Noto Sans.

## License

MIT. See [LICENSE](LICENSE).
