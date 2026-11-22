# LIVE TUNE-IN and REELS

LIVE TUNE-IN finds the exciting public games happening now and tells people about them. REELS keeps the great moments of
finished games (and of live ones while they happen) in a vertical highlight feed. They share one analysis pipeline.

## Where things live

| Part | File |
|---|---|
| Excitement, events, sacrifices, smoothing (pure, browser and server) | `public/excite.js` |
| Highlight detection, verification, feed ranking (pure) | `lib/reels.js` |
| Server: observer leases, evaluation intake, live scores, Match of the Moment, alerts, highlight storage, backfill, feed, reactions, saves | `lib/app.js` (search "REELS + LIVE TUNE-IN") |
| Browser: the analysis helper (Stockfish in Web Workers), the Live page, alerts, the Reels page | `public/index.html` (search "SHARED BROWSER ANALYSIS") |
| Tests | `scripts/test-reels.js`, `scripts/test-reels-ui.js` |

## The analysis: always in browsers

Every browser with the site open (and the option on: Live → Alerts → "Help analyse…") runs one small job every few seconds
while the tab is visible and the player isn't in a game, with Stockfish 19 (`public/sfengine.js`, pooled Web Workers,
bounded milliseconds per position, cancelled when the tab goes to the background). In order of priority:

1. **Observe a live game** (`live_obs` → `live_eval`): a 30 s lease on one public live game, newest positions first.
2. **The move-stats queue** (`stats_job` → `stats_submit`, existing): every finished game's evaluations. When a game's
   evaluations are complete (`statsFinish`) they are kept (`gev:<game id>`) and its engine highlights are found.
3. **Reels jobs** (`reel_job` → `reel_submit`): confirm a pending highlight, or evaluate a slice of an old game (backfill).

Browsers send only evaluations (score for the side to move, as Stockfish gives it). The server never trusts a score or a
claim: it recomputes excitement with `public/excite.js` from the evaluations it holds, and checks every evaluation:

- leases: only the lease holder submits as observer; a lease expires after 30 s (stale observers are replaced);
- bounds and plausibility: |score| ≤ 100000; an evaluation more than 30 pawns from the material balance without a mate
  is rejected and counts as a strike (3 strikes: 10-minute ban from observing);
- a second opinion: engine-based live events (sacrifice, comeback, blunder, forced mate, streak under threat) are only
  announced after a different browser re-evaluates the position and agrees; if it disagrees, the second opinion wins and
  the first observer gets a strike;
- rate limit (1 submission per second per player), game identity (a new game in the same room resets the record),
  players never observe their own game, private-room and local games are never observed or listed.

If no browser is analysing a game, it is shown as "analysis unavailable" with no score.

The existing server-side Stockfish (the fair-play worker, which also counts move stats on Vercel) is unchanged; nothing
new runs Stockfish on the server.

## LIVE TUNE-IN

- **Excitement (0–100)**: evaluation swings and blunders, comebacks (a side that was ≤15% is level or better), sound
  sacrifices (material down after the reply and the mover's next move, engine still happy), forced mate on the board,
  king attacks (repeated checks), tactics (captures and checks), close games late on, time scrambles (server clocks),
  a 5+ win streak under threat, and a little for ratings and viewers (never enough on their own).
- **Stability**: exponential smoothing; a game becomes "hot" at 36 and stays hot until 26 (hysteresis). The page only moves
  a game above another when it is 8+ points ahead.
- **Match of the Moment**: the hot game with the best slow average; it changes only when it ends, goes stale, or is beaten
  by 12+ after holding the spot for 2 minutes.
- **Alerts**: pushed on the existing lobby channel (`tune`), once per game and kind per 6 minutes and at most one per game
  per 30 s (server); each browser applies the player's categories (tactics, comebacks, time scrambles, brilliant moves,
  high-rated games, people from your rooms, streaks, Match of the Moment), shows at most one alert per 75 seconds, never
  while playing or for the game being watched. Shown in the site toast with WATCH LIVE, and as a system notification
  when the tab is in the background and notifications are allowed.

## REELS

Categories: brilliant (the existing move-stats rule: a sound sacrifice that is Stockfish's best move), forced mate (2+
moves of engine mate scores before the mate), comeback (the winner was ≤12% by Stockfish), tactic (one move by the
winner from balanced to winning, and it stayed winning), upset (200+ rating points, ratings at the time of the game),
streak breaker (from STREAK HUNT's verified break), time-scramble win (≤10 s left on the winner's clock).

- **Verification**: engine-based highlights are stored as `pending` and shown only after a different browser (not a player,
  not one that computed the evaluations) re-searches the positions they rest on and agrees (within 12% win probability,
  or the same mate). Record-based ones need no engine.
- **Storage**: `hl:<game id>:<kind>` (created once: idempotent), an index `hlidx`, the game's evaluations `gev:<game id>`,
  reactions `hlr:<id>`, saves `hlsave:<name>`.
- **Backfill**: once per server, every archived public game is read; record moments are found at once, games without
  evaluations go into `rqueue` and are evaluated by browsers in 16-position slices with a 90 s lease, resuming where they
  stopped (`rev:<id>`); progress is in the queue (`total`, `done`).
- **Feed**: filters (All, Brilliants, Checkmates, Upsets, Streak breakers, Comebacks) and Trending / Newest / Best of all time
  / Saved; quality first, fires add a little; never the same game twice in a row; 6 at a time. Live games with a confirmed
  moment appear at the top as LIVE reels and update every few seconds.
- **Saving**: the site has no puzzle-saving system to reuse, so saved reels are kept per account and shown under Saved.
