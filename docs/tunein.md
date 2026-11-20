# LIVE TUNE-IN

Finds exciting public games across the site. Analysis happens in browsers; the server only checks, scores and distributes.

## How it works

1. A logged-in browser with **Analyse games in this browser** on asks the server for a live public game (`tunein_claim`). It gets a lease: one browser per game at a time.
2. That browser evaluates each position with its own Stockfish (`public/sfengine.js`, a Web Worker, about 120 ms per position) and sends batches of 8 (`tunein_submit`), from White's point of view.
3. The server (`lib/tunein.js`) checks each batch: the game must be live, public and not one the sender plays in; the sender must hold the lease; positions must be in order; implausible jumps (over 1500 cp in one move, not involving a mate) end the batch. It then scores the game from its own move list.
4. `tunein_feed` returns the ranked games, MATCH OF THE MOMENT (sustained, not spiky), and events since the caller's last look.

## Scoring (0-100)

Major swings, comebacks, sacrifices, meaningful blunders (200+ cp from an even position), close fights and king attacks, time scrambles (both clocks under 10 s for 8 moves), mates, and sustained tension (hot positions over the last 30). Ratings and viewer counts are not inputs. The shown number is smoothed and only moves by 3+ points.

## Limits

- Evaluations come from one browser per game. Plausibility checks stop wild numbers, but they do not prove a number is right.
- Shallow analysis is noisy. A blunder from one search is not re-checked deeper (lib/movestats.js does that for the stats).
- Sacrifices are only the piece just moved and taken right away.
- Time scrambles come from the server's own clock record (`room.ck`), so browsers cannot fake them. Untimed games have none.
- Games with no fresh analysis are shown as waiting, never given a score.
