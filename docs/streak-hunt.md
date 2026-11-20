# STREAK HUNT

Win streaks are a target; ending one is an event the whole site hears about. Built on the existing win streaks
(`lib/streaks.js`, rebuilt from each player's archive), so the streak rules are the same everywhere: a win adds one,
a loss or a draw resets it, aborted games and games under 2 moves don't count, and each game counts once.

## Where things live

| Part | File |
|---|---|
| Rules (pure): finding a break, what qualifies, headlines, breaker stats, achievements, ON THE LINE | `lib/streakhunt.js` |
| Server: detection after each archived game, the feed, backfill, routes `streak_hunt` and `streak_line`, `hunt` on `profile` | `lib/app.js` (search "STREAK HUNT") |
| UI: the Streak Hunt panel on the main page, the live announcement (site toast), profile cards | `public/index.html` (search "STREAK HUNT") |
| Tests | `scripts/test-streakhunt.js` |

## How a break is found

`archiveGame` → `streakAfterGame` → `huntAfterGame`, before the streaks are rebuilt. The loser's archive already holds
the game, so the streak it ended is read from the stored, server-validated results, not from anything a browser sends.

A break is announced and counts when the streak was **3+ wins**, and:

- the game is not from a private room, was not a fair-play forfeit, and lasted at least **10 plies**;
- the streak was won against at least **3 different opponents** (a streak farmed off one or two accounts doesn't count);
- breaker and victim are different players.

Each break is recorded once with an atomic create of `sbrk:<game id>`, so a duplicate result event, two servers
finishing the same game, or a backfill can never announce it twice. The feed (`sbrks`, latest 30) and each breaker's
list (`sbk:<name>`) are compare-and-swap lists, so simultaneous completions don't lose entries.

The announcement is pushed on the existing `lobby` realtime channel (event `sbreak`) and shown with the site's toast.
It gets more dramatic with the length: 3+, 5+, 10+ (gold, longer on screen), 15+, 20+ ("THE KING HAS FALLEN.").
It is not shown to the player who lost (they get their own streak toast) or to anyone in the middle of a game.

## Breaker record

Total, biggest and most recent, from `sbk:<name>`. Achievements: First Blood (1 break), Giant Slayer (10+),
Legend Hunter (15+), Streak Executioner (20+); the highest one is the player's title. The same breaker ending the
same player's streak again within 30 days counts once, so two friends can't farm titles off each other.

## ON THE LINE

A player on 3+ can mark the streak as on the line (`streak_line`). It's a status, nothing is staked. It stays live
while no loss or draw has happened since (checked against the streak's loss + draw count), and a break of a streak on
the line gets its own headline.

## History

The first `streak_hunt` request on a server runs `huntBackfill` in the background: every player's archive is read,
past breaks are recorded with `hist: 1` and are not announced. It runs once (`sbrkbuilt`).
