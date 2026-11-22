// KING OF THE SERVER: the pure crown rules (lib/king.js). Run: node scripts/test-king.js
const assert = require('assert');
const K = require('../lib/king');
const c = (name, cur, ts) => ({ [name.toLowerCase()]: { name, cur, ts } });

// below the minimum nobody is king
assert.strictEqual(K.pick(c('ann', 4, 1)), null);
// longest streak wins; a tie goes to whoever reached it first
assert.strictEqual(K.pick({ ...c('ann', 6, 5), ...c('bob', 7, 9) }).name, 'bob');
assert.strictEqual(K.pick({ ...c('ann', 7, 5), ...c('bob', 7, 9) }).name, 'ann');

// empty throne filled
let r = K.decide(null, c('ann', 5, 1), { id: 'g1', winner: 'ann', loser: 'x', winnerPrevCur: 4 }, 100);
assert.deepStrictEqual([r.king.name, r.ev.type], ['ann', 'crowned']);
const crown = r.king;

// the king wins again: same king, longer streak, no event, reign start kept
r = K.decide(crown, c('ann', 6, 2), { id: 'g2', winner: 'ann', loser: 'y', winnerPrevCur: 5 }, 200);
assert.strictEqual(r.ev, null); assert.strictEqual(r.king.streak, 6); assert.strictEqual(r.king.since, 100);

// equalling the king's streak does not steal it; passing it does
r = K.decide({ ...crown, streak: 6 }, { ...c('ann', 6, 2), ...c('bob', 6, 3) }, { id: 'g3', winner: 'bob', loser: 'z', winnerPrevCur: 5 }, 300);
assert.strictEqual(r.ev, null); assert.strictEqual(r.king.name, 'ann');
r = K.decide({ ...crown, streak: 6 }, { ...c('ann', 6, 2), ...c('bob', 7, 4) }, { id: 'g4', winner: 'bob', loser: 'z', winnerPrevCur: 6 }, 400);
assert.deepStrictEqual([r.king.name, r.ev.type, r.ev.fallen], ['bob', 'steal', 'ann']);

// the king loses to a streaker: fall, the next eligible player inherits
r = K.decide({ name: 'bob', streak: 7, since: 400 }, { ...c('ann', 6, 2), ...c('cat', 3, 5) }, { id: 'g5', code: 'ABC', winner: 'cat', loser: 'bob', winnerPrevCur: 2 }, 500);
assert.deepStrictEqual([r.ev.type, r.ev.fallen, r.ev.streak, r.ev.by, r.ev.heir, r.king.name], ['fall', 'bob', 7, 'cat', 'ann', 'ann']);
assert(K.cinematic(r.ev));

// the king loses to someone with no streak: kingslayer, and the slayer is not king (one win is below the minimum)
r = K.decide({ name: 'bob', streak: 7, since: 400 }, {}, { id: 'g6', winner: 'dan', loser: 'bob', winnerPrevCur: 0 }, 600);
assert.deepStrictEqual([r.ev.type, r.ev.by, r.ev.heir, r.king], ['kingslayer', 'dan', null, null]);

// the king draws: the crown moves on quietly
r = K.decide({ name: 'bob', streak: 7, since: 400 }, c('ann', 6, 2), { id: 'g7', draw: ['bob', 'eve'] }, 700);
assert.deepStrictEqual([r.ev.type, r.king.name], ['ended', 'ann']); assert(!K.cinematic(r.ev));

// names compare case-insensitively
r = K.decide({ name: 'Bob', streak: 7, since: 1 }, c('Bob', 8, 9), { id: 'g8', winner: 'BOB', loser: 'q', winnerPrevCur: 7 }, 800);
assert.strictEqual(r.ev, null);

// the Streak Hunt and the crown agree on a tie: the King is the top row
const SH = require('../lib/streakhunt');
const tie = [{ name: 'Nimzz', cur: 5, best: 7, lastTs: 200 }, { name: 'LingDiren', cur: 5, best: 5, lastTs: 100 }];
assert.strictEqual(SH.hunted(tie)[0].name, K.pick(Object.fromEntries(tie.map((d) => [d.name.toLowerCase(), { name: d.name, cur: d.cur, ts: d.lastTs }]))).name);

console.log('king: all tests passed');
