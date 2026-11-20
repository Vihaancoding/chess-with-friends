# Puzzle trainer

Authentic Lichess puzzles, chosen by theme and difficulty, an AI search, your weak spots or a mix. Page: **Puzzles** in the menu (`/?puzzles`).

## Where the puzzles come from

- Source: the official Lichess puzzle database, <https://database.lichess.org/#puzzles> (CC0). Credit is shown on the page.
- `scripts/build-puzzles.js` turns the 300 MB download into the local index `data/puzzles.tsv.gz` (about 4 MB, ~57,000 puzzles). Nothing is invented: id, FEN, moves, rating, popularity, plays, themes, game and opening tags are the original fields.
  ```
  zstd -dc lichess_db_puzzle.csv.zst | node scripts/build-puzzles.js -
  ```
  (Node's own zstd decoder cannot read the skippable frames inside the official file, so pipe it through `zstd`; a decompressed `.csv` path also works.)
- The script keeps puzzles with a rating deviation of at most 100, at least 400 plays and a popularity of at least 70, spread evenly over every theme and rating band, and **drops any puzzle that fails verification**: all moves legal, Lichess line shape (opponent's move, then pairs), and a mate theme that agrees with the final position (`mateInN` also with the number of moves).
- The index is read once by the server (`lib/puzzles.js`, about 0.3 s) and kept in memory. There are no calls to Lichess while someone plays. `vercel.json` ships `data/**` with the function.
- To refresh or enlarge the index, re-run the script (env `PUZZLE_PER_BUCKET`, `PUZZLE_PER_RATING` change how many are kept) and commit the new `data/puzzles.tsv.gz`.

## Themes and difficulty

Theme ids are exactly Lichess's (`fork`, `discoveredAttack`, `intermezzo` = Zwischenzug, `mate` = Checkmate, `backRankMate`...). The picker lists only ids that exist in the data; anything else is dropped and reported. Bands: Beginner < 1000, Intermediate 1000–1499, Advanced 1500–1999, Expert 2000–2299, Master 2300+, a custom range, or relative to your own puzzle rating. Several themes can be combined with "all of them" or "any of them". Filters can also limit the solution length and the piece that makes the first move (this is how "knight forks" is expressed; the page says it is an approximation).

## Playing, and the solution stays on the server

`puzzle_next` sends the position before the opponent's move, that move, the side to play and the number of moves. The solution, themes and rating are not sent. Each move goes to `puzzle_move`, which answers right or wrong and, when right, the opponent's reply. Any move that gives checkmate is accepted, like on Lichess. Only the last move completes the puzzle. A wrong move is counted once as a failed puzzle, then the player can retry; hints and "show solution" also stop it counting as a clean solve. Only a puzzle the server handed out can be played (no probing other ids). The solution, themes and review facts become available after the puzzle is finished or the solution is shown.

## AI search

`puzzle_ai` → `lib/puzzleai.js`:

1. The AI (if a key is set) gets the request and the list of Lichess theme ids and answers with JSON: themes, match all/any, band or rating range, first-move piece, solution length, and `unsupported` phrases. It never sees puzzle data and never supplies puzzles, moves or solutions.
2. The JSON is validated by `normalizeFilter` (real theme ids only, clamped numbers, known pieces). Invalid themes are dropped and listed to the player; if nothing valid is left, the built-in parser (`parseRequest` in `lib/puzzles.js`, deterministic) answers instead. The built-in parser is also used when no key is set or the AI is down.
3. The sentence shown ("Understood: Fork · rated 1900+ ...") is built from the validated filter. Parts of a request that Lichess themes cannot express (named openings, positional ideas, time pressure) are listed as limits instead of silently returning unrelated puzzles.
4. The filter runs against the local index; the count and the start button follow.

Results are cached in memory, and a player can make 20 AI searches an hour.

## Review after a puzzle

- **Verified facts** (`reviewFacts`, from the position): the solution line in SAN, whether it ends in checkmate, material won, whether material is given up on the way, captures, promotion, themes and their meanings, the original Lichess game and puzzle links.
- **Checked by Stockfish** (in the browser, the same engine the game review uses, `public/sfengine.js`): how the solution's first move scores against Stockfish's top choice, the most tempting captures and checks and what they score, and what the opponent threatens (the position analysed with them to move). Shown with the search depth.
- **The idea**: a short explanation. With an AI key it is written from the verified facts only; the text is rejected (and the built-in explanation used) if it names a move that is not in the line, or gives an evaluation. It is labelled "AI, from the facts" or "built in".

## Progress

One document per player, `pz:<name>`: puzzle rating (Elo-style against the puzzle's rating, K 40/24/16), attempts, solved, average solving time, results per theme, the last 300 puzzles, recent mistakes (each can be retried), days, and the rating history. No migration: the document is created on first use. Modes:

- **Custom**: your themes and difficulty; optional adaptive difficulty (aims near your rating, up after a good run of 10, down after a bad one).
- **AI**: the filter made from your request.
- **Weakness**: themes with at least 3 attempts and under 60% solved, worst first (recent mistakes weigh more), at a rating near yours.
- **Mixed**: any themes, around your rating, easier or harder.

## Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` or `LLAMA_API_KEY` (+ `LLAMA_BASE_URL`, `LLAMA_MODEL`) | The AI provider, shared with the damage report (`lib/damagetext.js`). Without a key the built-in parser and explanations are used. Keys stay on the server. |
| `PUZZLE_MODEL` | Override the model for puzzles. |
| `PUZZLE_LLM=off` | Turn the puzzle AI off. |
| `PUZZLE_DATA` | Use another index file. |

## Tests

`node scripts/test-puzzles.js` (real data: retrieval, filters, themes, parsing, validation, moves, retry, progress, weakness, adaptive, empty results) and `node scripts/test-puzzles-ui.js` (browser: AI search, custom setup, play, hints, restart, solution, review with Stockfish, phone layout).
