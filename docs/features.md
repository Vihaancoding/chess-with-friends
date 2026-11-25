# Feature details

The longer write-ups behind the README's feature list. Each section names the code and the tests.

## Ratings

Glicko-2 (`lib/rating.js`), one game per rating period, separate ratings for bullet/blitz/rapid/classical (category = base + 40×increment seconds). New players are provisional (shown with `?`) until their rating deviation drops below 110. Games that end before both players have moved are not rated.

## Game archive

when a game ends, the server saves it as `game:<id>` (no expiry) straight from the room's own record: the moves it validated, the result, the rating change and the opening. Each player gets a summary row in `games:<name>` (newest 1,000 kept in the list; the games themselves are never deleted). Saving is idempotent and is retried from the game's heartbeat until the room is marked archived, so a lost background task can't lose a game. Games need both players and at least one move to be saved. The profile lists, filters and sorts the rows in the browser. Opening a game loads the saved record and replays it in the normal game screen, using the same engine, opening matcher and review as a live game. Nothing there can change a game or an account. Computer and coach games stay on the device, as before.

## Play against a style

the `style_games` API returns a player's last 40 archived games in one response; the browser builds the profile in a Web Worker and caches it on the device until they play again (about a minute for 40 games). Each of their moves gets a short engine search that scores every legal move as seen 1, 2 and 3 moves ahead. Two small models are then fitted to their own choices: a **move model** (softmax over ~28 features per move: the loss at each search depth, check, capture, trade, sacrifice, threat, retreat, castling, which piece, recapture…), whose weights on the three loss columns capture how deep they look, so the bot misses the same kind of tactics they miss; and a **timing model** (least squares on log think time: phase, clock left, number of legal moves, forced moves, recaptures, close decisions…), which the bot samples from for each move. Every 5th game is held out first and the profile card shows how many of those moves the model predicted exactly, next to the engine alone. The clone plays their opening book first, then the move model; difficulty scales how much it cares about what the deeper search sees. Online games record each move's thinking time and clock; older games have no time data.

## Win streaks

Career statistics, separate from the Damage Report. Streaks count from each player's very first completed game. `lib/streaks.js` is pure: current and longest streak, wins, losses, draws, games, win rate and milestones (3, 5, 10, 15, 20, 50 in a row) are always rebuilt from the player's whole archive (`games:<name>`), oldest game first, and stored as `strk:<name>` (no migration). A rebuild means a game is never counted twice, duplicate result events change nothing, and the backfill for existing players is the same code (done when a profile or the board is opened, 40 players at a time). A loss or a draw resets the streak, the longest never goes down, and abandoned games, games under 2 moves and rows without a valid result do not count. Limit: the archive keeps each player's latest 1000 games; for someone with more the stats say so.

Where it shows: a **Win streaks** card in the lobby with the leaderboard's own look (tabs: streak, best streak, win rate with a 10-game minimum, wins, games; a tier badge for anyone on 3+; one line of commentary from the real numbers), rating-style cards on profiles, and a toast after a game for a milestone, a new record or the end of a streak of 3+ (once per game). Tests: `node scripts/test-streaks.js`, `node scripts/test-streaks-ui.js`.

## SHUT UP

A player in a live game can tell a spectator who is being disruptive to **SHUT UP**: a bar above the game chat lists the spectators (and every spectator message has the same action) for the two players only. The server records it in the game's room record (`room.shut`), announces it in the chat ("ann told cat to SHUT UP."), and the spectators of the game (not the two players, who keep playing) see a full-screen takeover with the silenced spectator's name (about 2 s, then back to the board; the clock and the game are not touched). The spectator can keep watching but the server refuses any new chat message from them; what they wrote before stays in the chat for everybody. If both players do it, it becomes a **DOUBLE SHUT UP** with a bigger takeover; one player's revoke ("Let them talk") leaves the other's in place. Rules enforced server-side (`game_shutup`, `game_shutup_revoke`): only the two players of a game in progress, only against someone watching (never the opponent or yourself), once per player and spectator, 20 s cooldown per player and 6 s between any two in a room. It ends with the game and a rematch starts clean. The takeover respects the sound setting and `prefers-reduced-motion` (a calm static version). Tests: `node scripts/test-shutup.js` (API, 39 checks) and `node scripts/test-shutup-ui.js` (four browsers).

## Camera and chat tabs

In a live game the two players get CAMERA and CHAT tabs beside the board. The camera is video only (never any audio or microphone), browser-to-browser WebRTC at 320x240, 15 fps and 140 kbps at most, never recorded or stored. Each player turns their own camera on (the browser asks); the server only relays the handshake (`cam_signal`), privately to the opponent, and only between the two players. Spectators can chat as before (set `GAME_CHAT_PLAYERS_ONLY=1` to keep a live game's chat to the two players; games played from a private room are only open to that room's members, chat included), and spectators can open the CAMERA tab to watch both players' cameras (receive only, at most 3 spectators per player at once, only while their tab is open). Test: `node scripts/test-camera-ui.js` (two real browsers with fake cameras).

## Puzzle trainer

**Puzzles** in the menu: authentic puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0), filtered by theme and difficulty, with an AI search ("difficult knight forks"), weakness and mixed training, hints, an engine-checked review and progress tracking. The puzzles live in a local index (`data/puzzles.tsv.gz`, built by `scripts/build-puzzles.js`); solutions stay on the server until a puzzle is finished. Setup, data, AI and configuration: [docs/puzzles.md](docs/puzzles.md).

## Profile pictures, GIFs and move stats

- **Profile pictures:** on your own profile, choose a picture; the browser shrinks it to a small square and saves it (`avatar_set`); a GIF or animated WebP up to 400 KB is saved as it is, so it stays animated. It shows next to names in the sidebar, players list, leaderboard, chats and rivalries; without one you get a coloured initial. Anyone can fetch `/api?r=avatar&n=<name>`; admins can clear someone's picture from the admin page.
- **GIFs in chat:** a GIF button next to every chat box. Pasting a link from Giphy, Tenor or Imgur works anywhere; set `GIPHY_API_KEY` to also get a search. The message is just the GIF's address, shown as a picture only for those sites.
- **Move stats:** every finished game is judged move by move with Stockfish (`lib/movestats.js`) for the stats leaderboard. Players' browsers do the counting in the background (`stats_job` / `stats_submit`); set `STATS_SERVER=1` to count on the server instead. Tests: `node scripts/test-brilliant.js`, `node scripts/test-movestats.js`.
