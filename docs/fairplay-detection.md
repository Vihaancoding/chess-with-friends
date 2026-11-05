# Fair-play detection: how it worked, what changed, what the numbers show

Read the "Limitations" section before quoting any number from this page.

## 1. The detector before this upgrade

- Stockfish (depth 12, then 14), one line, checked each of a player's moves from the 10th ply on against the engine's first choice.
- Two numbers per game: **match** (share of moves equal to the engine's first choice or equally good) and **average centipawn loss**. A third, **move-time spread**, was used as a bonus.
- Verdict (`lib/tribunal.js judge`): match of 94% or more and average loss of 5 or less, or 90%/8 with a browser trace, plus a small bonus for steady times. At 95% confidence it forfeited the game automatically.

Weaknesses:

1. It was a fixed threshold for every player. A 2400 player, a 1200 player and a lucky streak were held to the same number.
2. It ignored how hard the positions were. Matching the engine in an obvious recapture says nothing; matching it in a quiet position with five equal moves says a lot.
3. Engine-best agreement was close to the whole case. It did not ask how likely that agreement is for a human.
4. No probability. Nothing said how surprising a game was, only whether it crossed a line.
5. No history. A player who suddenly improved by a thousand points looked like anyone else.
6. Move times were a bonus, not a calibrated signal, and bullet was skipped entirely.
7. Every check re-searched positions it had already searched. One alternative move per position was all it saw.
8. It had never been measured: no labelled data, no false-positive or false-negative rate.

## 2. Signals that were missing

Position difficulty (how far the best move stands out), rating, time control and game length as baselines, blunder behaviour (people make mistakes; engines do not), tactical versus quiet positions, consistency through the whole game, move-time patterns against difficulty, the player's own history, and any measure of uncertainty.

## 3. What was built

| Part | Where |
|---|---|
| Stockfish analysis with several lines (MultiPV), configurable depth, cached per game, resumable, never searches a position twice | `lib/sfserver.js analyseGame`, `lib/fairan.js` |
| Statistical model (rating- and difficulty-adjusted, calibrated p-value) | `lib/fairmodel.js`, baseline in `lib/fairbaseline.json` |
| Levels 1-5 with an evidence explanation for each | `lib/fairmodel.js assess` |
| History (change against a player's own past) | `historyShift`, `fhist:<name>` |
| Policy, post-game analysis, investigations | `lib/fairan.js`, `lib/app.js` (`fairWatch`, `fairPost`, `fairInvestigate`, `fairSweep`) |
| Simulator, dataset builder, calibration and benchmark | `scripts/fair-sim.js`, `fair-gen.js`, `fair-calibrate.js` |
| Tests | `scripts/test-fairmodel.js`, `test-fairdetect.js` |

### The model

For every analysed position the baseline knows how often a human of that rating plays the engine's first choice, how many centipawns they lose on average and how often they blunder, given the **difficulty** of the position (how far the best move stands out from the second best; five buckets) and the **rating** (interpolated between five bands). For one side of one game:

- `z_match`: engine first choices against the expected number (binomial z-score).
- `z_loss`: average loss (each move counted up to 100 centipawns) against the expected loss.
- `z_blunder`: how unlikely it is to make as few blunders (150+ centipawn loss) as they did (Poisson).
- `z_time`: move times flatter than people's and unrelated to difficulty, against the baseline for the time control.

They are combined with weights **fitted by logistic regression on the training games** (not guessed), then standardised against the spread of genuine games, because real players have good and bad days. The tail of that distribution gives **p: the probability that a legitimate player of that rating plays at least this well.** Tactical and quiet positions are also scored separately (`z_tact`, `z_pos`) and each quarter of the game is checked for consistency.

### Levels

| Level | Meaning | What happens |
|---|---|---|
| 1 Normal | p not unusual | nothing |
| 2 Unusual | p < 0.02 | nothing (kept for the dashboard) |
| 3 Suspicious | p < 0.001, at least 10 positions | an investigation for admins only; nobody else is told |
| 4 High-confidence | p below the validation-tuned limit, at least 14 positions **and** at least two independent supporting findings | the only level allowed to forfeit a live game automatically (public announcement and community vote, as before) |
| 5 Confirmed | a tribunal or admin ban that was applied and not overturned | set only after review |

Independent support means: engine-like in both tactical and quiet positions, sustained through the whole game, a browser trace, or a significant jump against the player's own history. Move times count inside the score but are **not** counted as independent support, so a high-confidence level never rests on timing alone. Playing several engine-best moves never matters by itself: the model asks how surprising the whole game is.

Every assessment carries a plain explanation (percentages, expected values, z-scores, the probability, what supports it). It is stored with the case and shown in the admin dashboard and, for a public case, under "Why was this flagged?".

### History

Each analysed game adds a standardised score to the player's history. A player is flagged when their last 5 games average at least 1.5 standard units, at least 4 of those 5 are above 1, and the jump over their previous 8+ games has p < 0.001. Fewer games means "not enough data".

### Integration

- Live games: after each move the check runs in the separate `api/fairplay.js` function (every move; analyses only the new positions thanks to the cache).
- Finished rated games are analysed once (also in `api/fairplay.js`); the result goes to the player's history and, if Suspicious, to the admin investigations list. Analysis cut short by the time limit is queued and resumed by the next lobby refresh.
- Admin dashboard: per player the level, p, history and the latest evidence; an "investigations" list with "Open community vote" and "Dismiss"; the existing flag and exceptions features are unchanged.
- Tribunal: automatic forfeits store level, probability and evidence; a confirmed ban raises the player to level 5; an overturned one lowers it again.

## 4. Benchmark: old against new

**Read this first.** There is no labelled set of real cheaters on this server, and no internet access to build one. The dataset is **simulated** (`scripts/fair-sim.js`): genuine players choose among the engine's top lines with a rating-dependent softmax and blunder rate, with per-game form, human-like move times and random openings; engine-assisted players use an engine as deep as the analysis that agrees with the analysis 88% of the time, in four styles. The numbers below describe how the detector behaves on that world. They are not the rate at which it would catch real cheaters or wrongly accuse real people.

- Dataset: 246 games, 492 samples (one side of one game each). Genuine 396 (rating bands 800 to 2400, bullet/blitz/rapid, 20 to 60+ positions), engine-assisted 96 plus their genuine opponents.
- Split by game: **train 40%** (baselines, weights, tails), **validation 20%** (thresholds), **test 40%** (every number below). Nothing was tuned on the test split.
- Analysis depth 12, MultiPV 3.

Test split (163 genuine samples, 33 engine-assisted):

| Detector | Precision | Recall | False-positive rate (95% CI) | False-negative rate |
|---|---|---|---|---|
| Old rule (automatic forfeit) | n/a (flagged nothing) | 0.0% | 0.0% (0 to 2.3%) | 100% |
| New, Suspicious or higher (investigation) | 100% (17 of 17) | 51.5% (CI 35 to 67%) | 0.0% (0 to 2.3%) | 48.5% |
| New, High-confidence (automatic forfeit allowed) | 100% (1 of 1) | 3.0% | 0.0% (0 to 2.3%) | 97.0% |
| New, Suspicious or higher, move times withheld | 100% (5 of 5) | 15.2% | 0.0% (0 to 2.3%) | 84.8% |

Slices (flagged at Suspicious or higher): genuine games by rating band: 0 flagged in every band. Engine-assisted by style: critical-only 7 of 9, mixed 6 of 10, always-engine 4 of 8, **time-randomising ("evade") 0 of 6**. By time control: bullet 3, blitz 9, rapid 5 flagged out of 22 (counting both groups). By length: under 20 positions 9, 20 to 34 positions 5, 35 or more 3. Full tables: `docs/fairplay-benchmark.md` and `.json` (regenerate with `node scripts/fair-calibrate.js`).

History, on 400 simulated honest players (40 games each) and 200 players who start using an engine after 15 games: 1 of 400 honest players ever flagged (0.25%); 200 of 200 switchers detected, on average 4.5 games after the switch.

Why the old rule flagged nothing: it needs 94% or more engine moves, but an assistant that disagrees with a depth-12 analysis a quarter of the time never gets there. The new model flags the same games because it compares against what humans of that rating do, not against a fixed ceiling.

## 5. Limitations

- **The benchmark is simulated.** A real cheater may behave differently, and real people differ from the simulated ones (opening knowledge, premoves, tilt, time scrambles). The simulator's assumptions drive the results, especially the move-time behaviour: the recall drops from 51.5% to 15.2% without move times, so a cheater who randomises their times is much harder to catch (0 of 6 in the "evade" style).
- **Small test set.** 163 genuine and 33 engine-assisted test samples. "0 false positives" means at most about 2.3% with 95% confidence, not zero. Tail probabilities below roughly 1 in 100 come from an exponential fit to the genuine games, not from enough data to see them directly.
- **Short games are weak evidence.** With 15 to 25 analysed positions a single game rarely reaches high confidence. That is intended: the history and repeated games are what accumulate evidence. Automatic forfeits are rare by design (1 of 33 here).
- **Selective and low-rate cheating** (a few critical moves per game) stays close to normal play and may never reach Suspicious.
- **Screenshots, a second device and engine use before the game** cannot be seen by any server-side check.
- **Strong genuine players** can look engine-like in forced, sharp positions. The rating adjustment and the "two independent findings" rule reduce this, but a very strong player on a hot streak can reach Suspicious; that only opens an admin investigation.
- **Depth 12 with three lines** is cheap enough for live use but is a weaker reference than a deep analysis; baselines are tied to this depth (changing `FAIR_AN_DEPTH` needs a recalibration).
- **Re-calibration.** When there are reviewed cases and enough genuine games, add them to the dataset format in `scripts/fixtures/fair-shards` and run `node scripts/fair-calibrate.js`.
- The old single-number check remains as a test hook (`fairDeps.scan`) and is not used in production.
