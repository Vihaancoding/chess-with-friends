# HIGHLIGHT REELS

A feed of moments worth replaying, found from the same checked analyses as LIVE TUNE-IN.

## How a moment gets in

1. A browser's batch of evaluations is checked (lib/tunein.js): lease, order, plausibility.
2. The server scores the game from its own move list and clock record (room.ck), then looks for moments (lib/highlights.js):
   - **Comeback:** a side 3+ pawns down that is winning now (or won).
   - **Sacrifice:** a piece taken right after it moved, net 3+ points down, with the position still held.
   - **Time scramble:** 8 moves in a row with under 10 s left. A win after one is ranked higher.
   - **Big swing:** a single move that moved the evaluation 3+ pawns.
   - **Upset:** a finished game where the side rated 300+ points lower won.
   - **Streak breaker:** a finished game that ended a 5+ win streak against 3+ different players (checked against the loser's archive).
3. Each new moment is stored once (lib/app.js `highlightsFor`), with the moves to replay. Nothing is stored for private rooms, because TUNE-IN never looks at them.

Clients never submit highlights or scores.

## The feed

- `highlight_feed` returns one reel per game (the strongest moment), for the chosen filter, plus a trending strip (last 48 h).
- Reels is its own page in the sidebar: one reel per screen, scroll-snap between them. The reel on screen plays from 4 moves before the moment; the others stop. Step, scrub and play controls on each reel.
- "Open full game" opens the archive replay for finished games. "Watch live" joins ongoing ones.

## Limits

- Brilliant moves and checkmate sequences are not detected yet. They need deeper verification than the live analysis gives.
- Only games that were analysed in a browser can produce reels. An unobserved game produces none.
- Analysis stops when the game ends, so the final result is only recorded if a batch was sent after the last move.
- The streak check is a simpler version of the breaker rule (no STREAK HUNT on this branch).
