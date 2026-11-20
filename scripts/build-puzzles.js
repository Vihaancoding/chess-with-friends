// Builds the local puzzle index (data/puzzles.tsv.gz) from the official Lichess puzzle database.
//   download: https://database.lichess.org/lichess_db_puzzle.csv.zst   (CC0, about 300 MB, 4+ million puzzles)
//   run:      zstd -dc lichess_db_puzzle.csv.zst | node scripts/build-puzzles.js - [out.tsv.gz]
// Nothing is invented: every row is a Lichess puzzle with its original id, FEN, moves, rating and themes. The script keeps a
// well-tested subset (low rating deviation, many plays, popular) spread evenly over the themes and ratings, and drops any
// puzzle whose moves are not all legal here or whose "mate" themes do not match the final position.
const fs = require('fs'), zlib = require('zlib'), path = require('path'), readline = require('readline');
const Chess = require('../public/chess.js');
const P = require('../lib/puzzles.js');

const src = process.argv[2], out = process.argv[3] || path.join(__dirname, '..', 'data', 'puzzles.tsv.gz');
if (!src) { console.error('usage: zstd -dc lichess_db_puzzle.csv.zst | node scripts/build-puzzles.js - [out.tsv.gz]'); process.exit(1); }
const K = +process.env.PUZZLE_PER_BUCKET || 170;       // per theme and rating band
const KR = +process.env.PUZZLE_PER_RATING || 110;      // per 50 rating points, any theme
const MIN_PLAYS = 400, MAX_RD = 100, MIN_POP = 70;

const themeIds = new Set(P.KNOWN_THEMES);
const buckets = new Map();      // "theme|band" or "r|n" -> [{ pop, line }]
const freq = new Map();         // every theme in the whole database
let total = 0, kept = 0;
const push = (key, cap, row) => {
  let b = buckets.get(key); if (!b) buckets.set(key, (b = []));
  b.push(row);
  if (b.length > cap * 2) { b.sort((x, y) => y.score - x.score); b.length = cap; }
};

(async () => {
  // input: a decompressed CSV on stdin ("-", e.g. `zstd -dc lichess_db_puzzle.csv.zst | node scripts/build-puzzles.js -`), a .csv file,
  // or the .zst itself (Node's zstd decoder cannot read the skippable frames inside the official file, so prefer the pipe)
  const input = src === '-' ? process.stdin : /\.zst$/.test(src) ? fs.createReadStream(src).pipe(zlib.createZstdDecompress()) : fs.createReadStream(src);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    total++;
    const f = line.split(',');
    if (f.length < 8) continue;
    const [id, fen, moves, rating, rd, pop, plays, themes, gameUrl, opening] = f;
    const th = themes.split(' ').filter(Boolean);
    for (const t of th) freq.set(t, (freq.get(t) || 0) + 1);
    if (+rd > MAX_RD || +plays < MIN_PLAYS || +pop < MIN_POP) continue;
    kept++;
    const row = { score: +pop + Math.random() * 12, id, fen, moves, rating: +rating, pop: +pop, plays: +plays, themes: th, gameUrl: gameUrl || '', opening: opening || '' };
    const band = P.bandOf(+rating);
    for (const t of th) if (themeIds.has(t)) push(t + '|' + band, K, row);
    push('r|' + Math.floor(+rating / 50), KR, row);
  }
  const chosen = new Map();
  for (const b of buckets.values()) { b.sort((x, y) => y.score - x.score); for (const r of b) if (!chosen.has(r.id)) chosen.set(r.id, r); }
  const rows = [], dropped = {};
  for (const r of chosen.values()) {
    const bad = P.verifyRow(r);
    if (bad) { dropped[bad] = (dropped[bad] || 0) + 1; continue; }
    rows.push(P.encodeRow(r));
  }
  rows.sort();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const header2 = '# Lichess puzzle database (https://database.lichess.org/#puzzles), CC0. id fen moves rating popularity plays themes game opening firstPiece\n';
  fs.writeFileSync(out, zlib.gzipSync(Buffer.from(header2 + rows.join('\n') + '\n'), { level: 9 }));
  console.log(`read ${total} puzzles, ${kept} passed the quality filter, kept ${rows.length} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`, Object.keys(dropped).length ? 'dropped: ' + JSON.stringify(dropped) : '');
  const missing = [...freq.entries()].filter(([t]) => !themeIds.has(t) && !/^mateIn\d+$/.test(t)).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (missing.length) console.log('themes in the database not in the app list:', missing.map(([t, n]) => `${t} ${n}`).join(', '));
  console.log('theme counts in the whole database:', JSON.stringify(Object.fromEntries([...freq.entries()].sort())));
})();
