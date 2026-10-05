# Chess With Friends

Multiplayer chess in the browser. Make a game, share the 5-letter code (or challenge a username), and play.

**Features:** email accounts · Elo ratings and leaderboard · time controls (bullet → classical) · challenges · draw offers, threefold repetition · drag-and-drop and click-to-move · move review · live games you can spectate · lobby chat · admin panel · sounds.

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

3. Deploy. Pushing to `main` redeploys automatically.

See [`.env.example`](.env.example) for the same list.

## Admin panel

Emails are not verified, so admin is unlocked with a secret instead of an email address:
log in, open `https://your-site/?admin=1`, and enter `ADMIN_KEY`. An **Admin** link then appears in the sidebar. From there you can mute, reset or delete players, end live games, post an announcement and moderate chat.

## How it works

| Path | What |
|---|---|
| `public/index.html` | The whole client (UI, polling, drag and drop, sounds) |
| `public/chess.js` | Chess engine shared by browser and server (legal moves, check/mate, castling, en passant, promotion, repetition key) |
| `lib/app.js` | API: accounts, rooms, clocks, Elo, challenges, chat, admin |
| `lib/store.js` | Tiny key-value store: Supabase when configured, memory otherwise |
| `api/index.js` | Vercel serverless entry (`server.js` is the local equivalent) |

The server is authoritative: every move is validated with the shared engine, and clocks run server-side. Vercel has no long-lived connections, so the client **polls** (about once a second in a game) instead of using websockets.

## Known limitations / ideas

- No email verification or password reset (needs an email service such as Resend or Supabase Auth).
- Polling means a ~1 s delay on opponent moves; websockets or Supabase Realtime would make it instant.
- Read-modify-write on the key-value store can race under heavy concurrency; fine for friends, not for thousands of players.
- No per-player game history or opening explorer yet.
- Abandoned untimed games are never cleaned up automatically.

## Credits

Piece images are the Cburnett set, loaded from the [lichess](https://github.com/lichess-org/lila) repository via jsDelivr (see their license). Fonts: Noto Sans.

## License

MIT. See [LICENSE](LICENSE).
