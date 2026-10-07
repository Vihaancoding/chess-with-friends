// "Ask the coach": answers questions like "teach me the Caro-Kann" or "what is a pin?" with a short explanation and
// things to do next: a course lesson, or an opening trainer built on the fly from the Lichess opening list.
// Runs entirely in the browser (no AI service); checked by scripts/test-coach-ask.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'));
  else root.CoachAsk = factory(root.Chess);
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/defence/g, 'defense').replace(/[’']s\b/g, 's').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set(('i im me my mine the a an to how do does did can could you your teach learn learning show explain about what whats ' +
    'is are was of in on at with for from play playing played against want wanna would like please help tell some and or it its this that ' +
    'should best good great openings white black as move moves chess coach more know understand main idea ideas why when which work works ' +
    'beginner beginners easy simple new lesson lessons practice practise train training drill memorize memorise lines get give let lets ' +
    'need start starting basic basics be up any all one us we really then so if way ways tips trick tricks beat beating face facing meet ' +
    'vs versus counter deal handle improve better').split(' '));
  const WEAK = new Set('opening defense game gambit attack variation system line counterattack accepted declined countergambit formation'.split(' '));
  const ALIAS = { kid: 'kings indian defense', qgd: 'queens gambit declined', qga: 'queens gambit accepted', ruy: 'ruy lopez',
    spanish: 'ruy lopez', caro: 'caro kann', scandi: 'scandinavian', nimzo: 'nimzo indian', grunfeld: 'grunfeld', petroff: 'petrovs', petrov: 'petrovs',
    giuoco: 'italian game', jobava: 'rapport jobava', fried: 'fried liver', stafford: 'stafford gambit' };

  // A few words on the openings people ask about most (keys are normalized family names).
  const ABOUT = {
    'italian game': 'White develops fast and points the bishop at f7, then often plays c3 and d4 for a big centre. A great first opening.',
    'ruy lopez': 'White pins down the knight that defends e5 with Bb5. Slow, deep pressure. Played by every world champion.',
    'scotch game': 'White opens the centre at once with d4. Open lines and quick development, with fewer long lines to memorise than the Ruy Lopez.',
    'vienna game': 'White plays Nc3 before Nf3 to keep the f-pawn free for an f4 push. Aggressive and surprising.',
    'kings gambit': 'White gives up the f-pawn for fast development and an attack on f7. Romantic and sharp.',
    'sicilian defense': 'Black answers 1.e4 with ...c5, fighting for d4 from the side. Unbalanced positions where both sides play to win.',
    'french defense': 'Black plays ...e6 and ...d5, accepting a cramped game for a rock-solid centre, then strikes back with ...c5.',
    'caro kann defense': 'Black supports ...d5 with ...c6. Solid and sound: the light-squared bishop usually gets out before ...e6.',
    'scandinavian defense': 'Black hits e4 straight away with ...d5. Simple to learn: the queen recaptures and Black develops quickly.',
    'pirc defense': 'Black lets White build a centre, fianchettoes the bishop on g7 and attacks the centre later.',
    'alekhine defense': 'Black attacks e4 with the knight and invites White\'s pawns forward, then tries to show they are overextended.',
    'petrovs defense': 'Black copies White and counterattacks e4 with ...Nf6. Very solid, popular with top players who want a draw-proof game.',
    'philidor defense': 'Black defends e5 with ...d6. Solid but a little passive; easy to learn.',
    'queens gambit': 'White offers the c-pawn to pull Black\'s d-pawn away from the centre. The classic 1.d4 opening.',
    'queens gambit declined': 'Black keeps the pawn on d5 with ...e6. Solid and classical, played for over a century.',
    'queens gambit accepted': 'Black takes the c4 pawn, plans to give it back, and uses the time to hit the centre with ...c5.',
    'slav defense': 'Black defends d5 with ...c6, keeping the light-squared bishop free to develop. Very solid.',
    'kings indian defense': 'Black lets White take the centre, castles behind a g7 bishop and attacks it later with ...e5 or ...c5. Fighting chess.',
    'nimzo indian defense': 'Black pins the c3 knight with ...Bb4 and fights for e4 with pieces. Flexible and highly respected.',
    'grunfeld defense': 'Black lets White build a big pawn centre and then attacks it with pieces and ...c5.',
    'dutch defense': 'Black plays ...f5 to grab e4 and plan a kingside attack. Ambitious and unbalanced.',
    'benoni defense': 'Black plays ...c5 against 1.d4 for a queenside pawn majority and active pieces. Sharp.',
    'london system': 'White sets up d4, Bf4, e3, Nf3 and c3 against almost anything. Easy to learn, solid, and full of plans.',
    'english opening': 'White starts with c4 and controls d5 from the side. Flexible; it often turns into a reversed Sicilian.',
    'reti opening': 'White starts with Nf3 and stays flexible, attacking the centre from the side with c4 and g3.',
    'catalan opening': 'White combines d4 and c4 with a bishop on g2 that bears down on Black\'s queenside.',
    'kings indian attack': 'White sets up Nf3, g3, Bg2, O-O, d3 and e4: one system against everything.',
    'bird opening': 'White starts with f4 to control e5. Uncommon and a bit risky.',
  };

  // ---------- opening book (from public/openings.js), indexed by name ----------
  let book = null;
  function loadBook(tsv) {
    if (book || !tsv) return book;
    const byName = new Map(), next = new Map();   // next: line so far -> { move: how many book lines continue with it }
    for (const line of tsv.split('\n')) {
      const [eco, name, ucis] = line.split('\t'); if (!ucis) continue;
      const moves = ucis.split(' '), had = byName.get(name);
      for (let i = 0; i < moves.length; i++) {
        const pre = moves.slice(0, i).join(' '), m = next.get(pre) || {};
        m[moves[i]] = (m[moves[i]] || 0) + 1; next.set(pre, m);
      }
      if (!had || moves.length < had.moves.length) byName.set(name, { eco, name, moves, n: norm(name), toks: norm(name).split(' '), kids: 0 });
    }
    const list = [...byName.values()], byLine = new Map();
    for (const o of list) {
      byLine.set(o.moves.join(' '), o);
      for (let i = o.name.length; (i = Math.max(o.name.lastIndexOf(':', i - 1), o.name.lastIndexOf(',', i - 1))) > 0;) {
        const p = byName.get(o.name.slice(0, i)); if (p) p.kids++;
      }
    }
    return (book = { list, byName, byLine, next });
  }

  const tokMatch = (q, t) => q === t || (q.length >= 4 && t.length >= 4 && (t.startsWith(q) || q.startsWith(t)));
  // the opening a question names, or null: most strong words matched, then the most general name
  function findOpening(q) {
    if (!book) return null;
    let words = norm(q).split(' ').filter((w) => w && !STOP.has(w));
    words = words.flatMap((w) => (ALIAS[w] ? ALIAS[w].split(' ') : [w]));
    const strong = words.filter((w) => !WEAK.has(w) && w.length > 1);
    if (!strong.length) return null;
    let best = null, bs = 0;
    for (const o of book.list) {
      let s = 0, hit = 0;
      for (const w of words) if (o.toks.some((t) => tokMatch(w, t))) { s += WEAK.has(w) ? 1 : 3; if (!WEAK.has(w)) hit++; }
      if (!hit) continue;
      if (words.length > 1 && (' ' + o.n + ' ').includes(' ' + words.join(' ') + ' ')) s += 2;   // the words in order, as in "vienna gambit"
      s -= 0.01 * o.toks.length + 0.001 * o.moves.length;
      if (s > bs) { bs = s; best = o; }
    }
    // every strong word has to appear somewhere in the name, so "what is a fork" doesn't turn into the "Fork Trick"
    return best && strong.every((w) => best.toks.some((t) => tokMatch(w, t))) ? best : null;
  }
  // the main lines under an opening: hand-picked for the most popular ones, else the variations with the most sub-variations
  const MAIN = {
    'Sicilian Defense': ['Open', 'Najdorf Variation', 'Dragon Variation', 'Alapin Variation', 'Closed'],
    'French Defense': ['Advance Variation', 'Winawer Variation', 'Tarrasch Variation', 'Classical Variation'],
    'Caro-Kann Defense': ['Advance Variation', 'Classical Variation', 'Panov Attack', 'Exchange Variation'],
    'Italian Game': ['Giuoco Pianissimo', 'Two Knights Defense', 'Evans Gambit', 'Giuoco Piano'],
  };
  function variations(o, n = 4) {
    const mine = (MAIN[o.name] || []).map((v) => book.byName.get(o.name + ': ' + v)).filter(Boolean);
    if (mine.length) return mine.slice(0, n);
    return book.list.filter((x) => x !== o && (x.name.startsWith(o.name + ': ') || x.name.startsWith(o.name + ', ')) && !x.name.slice(o.name.length + 2).includes(','))
      .sort((a, b) => b.kids - a.kids || a.moves.length - b.moves.length).slice(0, n);
  }
  const blackish = (name) => /defen[cs]e|declined|accepted|counter|countergambit/i.test(name.split(':')[0]);
  function sideFor(o, q) {
    const m = /\b(?:as|for|with|playing)\s+(white|black)\b/.exec(norm(q));
    if (m) return m[1][0];
    const theirs = /\b(beat|beating|against|vs|versus|face|facing|meet|counter|deal with|handle)\b/.test(norm(q));
    return blackish(o.name) !== theirs ? 'b' : 'w';
  }
  function sanLine(moves) {
    let st = Chess.initial(), out = [];
    moves.forEach((u, i) => { const m = Chess.findUci(st, u); out.push((i % 2 ? '' : i / 2 + 1 + '.') + Chess.notate(st, m)); st = Chess.apply(st, m); });
    return out.join(' ');
  }

  // A short line is carried on along the book's busiest branch (the move most named lines continue with), so there's
  // something to play. Stops at `plies`, or where fewer than 3 lines go on.
  function extend(moves, plies = 10) {
    moves = moves.slice();
    while (moves.length < plies) {
      const m = Object.entries(book.next.get(moves.join(' ')) || {}).sort((a, b) => b[1] - a[1])[0];
      if (!m || m[1] < 3) break;
      moves.push(m[0]);
    }
    return moves;
  }

  // An interactive lesson (same format as lessons.js) that has you play your side of an opening line.
  function trainer(name, side, memory) {
    const o = book && book.byName.get(name); if (!o) return null;
    const sans = [], moves = extend(o.moves);
    if (moves.length < 2) side = 'w';
    let st = Chess.initial();
    for (const u of moves) { const m = Chess.findUci(st, u); sans.push(Chess.notate(st, m)); st = Chess.apply(st, m); }
    const label = (i) => (i % 2 ? `${(i + 1) / 2}...` : `${i / 2 + 1}.`) + sans[i];
    const named = (i) => { const x = book.byLine.get(moves.slice(0, i + 1).join(' ')); return x && x.name; };
    const steps = [];
    let last = null;
    for (let i = side === 'w' ? 0 : 1; i < moves.length; i += 2) {
      const at = named(i), r = i + 1 < moves.length ? named(i + 1) : null;
      const why = at && at !== last ? `${label(i)}: this is the ${at}.` : r && r !== last ? `${label(i)}. Your opponent's reply brings us to the ${r}.` : `${label(i)}. Correct!`;
      last = r || at || last;
      steps.push({ say: memory ? 'Your move. What comes next in the line?' : `Play ${label(i)}`, move: [moves[i]], reply: moves[i + 1], why });
    }
    const col = side === 'w' ? 'White' : 'Black';
    return {
      id: 'ask:' + side + ':' + name, title: name, side, trainer: { name, side, memory: !!memory },
      parts: [{ pre: side === 'b' ? [moves[0]] : [],
        intro: memory ? `Now from memory: play ${col}'s moves of the ${name}. Use Hint if you get stuck.`
          : `You play ${col}. The line is ${sanLine(moves)}. Play your moves and I'll answer with the book replies.`,
        steps }],
      outro: `That's the ${name} (${o.eco}). The whole line: ${sanLine(moves)}.`,
    };
  }

  // ---------- topics that aren't openings ----------
  // lesson: an id from lessons.js; course: a course id; ask: follow-up questions shown as chips
  const TOPICS = [
    { re: /\bforks?\b|\bforking\b|double attack/, text: 'A <b>fork</b> is one piece attacking two things at once. Your opponent can only save one of them. Knights are the best forkers, because they jump to squares that are hard to see coming. Look for a square where your piece would hit the king and another piece (or two loose pieces).', lesson: 'mg-fork', ask: ['What is a pin?', 'What is a skewer?'] },
    { re: /\bpin(s|ned|ning)?\b/, text: 'A <b>pin</b> is when a piece can\'t move (or shouldn\'t) because a more valuable piece is behind it on the same line. Pinned to the king, it legally can\'t move at all. Pile up on a pinned piece: it can\'t run away.', lesson: 'mg-pin', ask: ['What is a skewer?', 'What is a fork?'] },
    { re: /skewer/, text: 'A <b>skewer</b> is a pin in reverse: you attack a valuable piece (often the king), it moves away, and you take the piece that was behind it.', lesson: 'mg-skewer', ask: ['What is a pin?', 'What is a discovered attack?'] },
    { re: /discover/, text: 'A <b>discovered attack</b> happens when one piece moves out of the way and uncovers an attack by the piece behind it. If the piece that moves also attacks something (or gives check), your opponent faces two threats at once.', lesson: 'mg-discovered', ask: ['What is a fork?'] },
    { re: /back ?rank|back row/, text: 'A <b>back-rank mate</b> is a rook or queen checkmating a king that is stuck behind its own pawns on the first rank. Give your king an escape square (a "luft", like h3 or h6) and watch for it in your opponent\'s camp.', lesson: 'mg-backrank' },
    { re: /scholar|four move (check)?mate|4 move (check)?mate|quickest (check)?mate|fastest (check)?mate|early queen/, text: '<b>Scholar\'s mate</b> is 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#. The queen and bishop team up on f7, which only the king defends. Block it with ...g6 or defend with ...Qe7, then attack the early queen with your pieces.', lesson: 'op-scholar' },
    { re: /opening principles|how (do i|to|should i) (start|open|begin)|first (few )?moves|in the opening|general opening/, text: 'Three habits win the opening: <b>take the centre</b> with a pawn or two, <b>develop</b> your knights and bishops toward the middle, and <b>castle</b> early. Don\'t move the same piece twice or bring the queen out early without a reason.', lesson: 'op-principles', ask: ['Which opening should I learn?'] },
    { re: /(check)?mate with (a |the |king and )?queen|queen (check)?mate|king and queen/, text: 'With king and queen against a lone king, use the queen to box the king in (a knight\'s move away keeps it safe), shrink the box, bring your own king up, then mate on the edge. Always check that the enemy king still has a move, or it\'s stalemate.', lesson: 'eg-queen', ask: ['How do I mate with a rook?'] },
    { re: /(check)?mate with (a |the |two )?rooks?|rook (check)?mate|ladder|lawnmower|two rooks/, text: 'Two rooks mate with the "ladder": one rook cuts the king off along a rank, the other gives check on the next rank, and they leapfrog to the edge. With one rook you need your king\'s help to push the enemy king back.', lesson: 'eg-rook', ask: ['How do I mate with a queen?'] },
    { re: /rule of the square|pawn race|catch (a |the )?pawn/, text: 'The <b>rule of the square</b>: draw a square from the pawn to its promotion rank. If the defending king can step into that square, it catches the pawn. If not, the pawn queens.', lesson: 'eg-square', ask: ['What is the opposition?'] },
    { re: /opposition|king and pawn|pawn endgame|pawn ending/, text: 'Kings are in <b>opposition</b> when they face each other with one square between. The side that does NOT have to move holds the opposition and wins the fight for key squares. That decides most king-and-pawn endings.', lesson: 'eg-opposition', ask: ['What is the rule of the square?'] },
    { re: /castl/, text: '<b>Castling</b> moves the king two squares toward a rook and puts the rook on the other side of it, in one move. It\'s allowed if neither piece has moved, the squares between are empty, and the king isn\'t in check, doesn\'t pass through an attacked square and doesn\'t land on one. Castle early: it hides the king and brings a rook to the middle.', lesson: 'op-principles' },
    { re: /en passant|passant/, text: '<b>En passant</b>: when a pawn moves two squares and lands right beside an enemy pawn, that pawn may take it as if it had moved only one. It must be done on the very next move or the chance is gone.', ask: ['What is a fork?'] },
    { re: /stalemate/, text: '<b>Stalemate</b> is a draw: the player to move is not in check but has no legal move. When you\'re winning, always leave the enemy king a square until the mating move.', lesson: 'eg-queen' },
    { re: /promot/, text: 'A pawn that reaches the last rank <b>promotes</b> to a queen, rook, bishop or knight (almost always a queen). Getting a pawn there is what most endgames are about.', lesson: 'eg-opposition' },
    { re: /piece values?|how much (is|are)|worth|points?/, text: 'The usual values: pawn 1, knight 3, bishop 3, rook 5, queen 9. The king is priceless. Use them to judge trades, but activity matters too: an active knight can beat a passive rook.' },
    { re: /tactic|puzzle|combination/, text: 'Tactics win games at every level. The core patterns are the <b>fork</b>, the <b>pin</b>, the <b>skewer</b> and the <b>discovered attack</b>. Before every move, look at all checks, captures and threats, yours and your opponent\'s.', course: 'middlegame', ask: ['What is a fork?', 'What is a pin?'] },
    { re: /endgame|ending|end game/, text: 'Start with the basic mates (queen, rooks), then king-and-pawn endings: the rule of the square and the opposition. In the endgame the king becomes a fighting piece. Bring it to the centre.', course: 'endgames', ask: ['How do I mate with a rook?', 'What is the opposition?'] },
    { re: /middlegame|middle game|plan|what (should i|to) do after the opening/, text: 'When the opening is done: find the weakest piece in your camp and improve it, look for weak squares and loose pieces in your opponent\'s, and check every forcing move (checks, captures, threats) first.', course: 'middlegame' },
    { re: /\b(what can you|what do you|who are you|hello|hi|hey|help me|help)\b/, intro: true },
  ];
  const RECOMMEND = /\b(an|some|a new|my first) openings?\b|which opening|what opening|opening (should|to)|best opening|good opening|recommend|repertoire|openings? for (a )?beginners?|beginner openings?|^(an? )?openings?$/;
  const IMPROVE = /improve|get better|getting better|stop (blundering|losing|hanging)|blunder|what (should|do) i (learn|study|work on|practi[cs]e)|where (do|should) i start|next/;

  const intro = () => ({
    html: 'Ask me about anything you want to learn. I can teach you an <b>opening</b> (there are over 3,000 in my book, try "teach me the Caro-Kann" or "the London System as White"), explain <b>tactics</b> like forks and pins, and walk you through <b>endgames</b>. I\'ll give you a lesson to play on the board.',
    actions: [], ask: ['Teach me the Sicilian', 'Which opening should I learn?', 'What is a fork?', 'How do I mate with a rook?'],
  });

  function openingAnswer(o, q) {
    const side = sideFor(o, q), fam = o.name.split(':')[0], about = ABOUT[norm(o.name)] || ABOUT[norm(fam)];
    const kids = o.moves.length <= 6 ? variations(o) : [];
    let html = `<b>${esc(o.name)}</b> <span class="muted">${esc(o.eco)}</span> starts ${esc(sanLine(o.moves))}.`;
    if (about) html += ' ' + about;
    html += kids.length ? ` Pick a line to learn, or start with the first moves. You'll play ${side === 'w' ? 'White' : 'Black'}.` : ` Let's play it: you're ${side === 'w' ? 'White' : 'Black'}, I'll answer with the book moves.`;
    const actions = [{ kind: 'train', name: o.name, side, label: kids.length ? 'First moves' : 'Learn this line' }];
    for (const k of kids) actions.push({ kind: 'train', name: k.name, side, label: k.name.slice(o.name.length + 2) });
    actions.push({ kind: 'train', name: o.name, side: side === 'w' ? 'b' : 'w', label: `Play it as ${side === 'w' ? 'Black' : 'White'}`, minor: true });
    return { html, actions, lessonFor: o.name };
  }

  // the lessons.js lesson that teaches an opening, if there is one
  const OPENING_LESSONS = [[/^italian game/, 'op-italian'], [/^ruy lopez/, 'op-ruy'], [/^queens gambit/, 'op-qgd'], [/^sicilian defense/, 'op-sicilian']];

  // question -> { html, actions: [{kind:'lesson'|'course'|'train'|'coach', ...label}], ask: [follow-up questions] }
  // ctx: { courses (lessons.js), done ({lessonId: time}), focus ([titles of the player's weak spots]) }
  function answer(q, ctx = {}) {
    const n = norm(q);
    if (!n) return intro();
    const lessonById = (id) => { for (const [cid, c] of Object.entries(ctx.courses || {})) { const i = c.lessons.findIndex((l) => l.id === id); if (i >= 0) return { kind: 'lesson', cid, id, label: `Lesson: ${c.lessons[i].title}` }; } return null; };
    const openingy = /opening|defen[cs]e|gambit|variation|system|attack|repertoire|\b(as|for) (white|black)\b/.test(n);
    const topic = TOPICS.find((t) => t.re.test(n));
    if (!openingy && IMPROVE.test(n) && !(topic && !topic.intro)) return improve(ctx);
    const o = (openingy || !topic || topic.intro) && findOpening(q);
    if (o) {
      const a = openingAnswer(o, q);
      const lid = (OPENING_LESSONS.find(([re]) => re.test(norm(o.name))) || [])[1], l = lid && lessonById(lid);
      if (l) a.actions.unshift({ ...l, label: l.label + ' (guided)' });
      return a;
    }
    if (RECOMMEND.test(n)) {
      return { html: 'Good first openings teach you to develop and fight for the centre. <b>As White</b>: the Italian Game (1.e4) or the London System (1.d4). <b>As Black</b>: 1...e5 against 1.e4, or the Caro-Kann if you want something solid, and the Queen\'s Gambit Declined against 1.d4. Pick one to learn:',
        actions: [lessonById('op-principles'), { kind: 'train', name: 'Italian Game: Giuoco Pianissimo', side: 'w', label: 'Italian Game (White)' },
          { kind: 'train', name: 'London System', side: 'w', label: 'London System (White)' }, { kind: 'train', name: 'Caro-Kann Defense: Advance Variation', side: 'b', label: 'Caro-Kann (Black)' },
          { kind: 'train', name: 'Queen\'s Gambit Declined: Orthodox Defense', side: 'b', label: 'Queen\'s Gambit Declined (Black)' }].filter((x) => x && (x.kind !== 'train' || (book && book.byName.has(x.name)))),
        ask: ['Teach me the Sicilian', 'What are the opening principles?'] };
    }
    if (topic && !topic.intro) {
      const actions = [];
      if (topic.lesson) { const l = lessonById(topic.lesson); if (l) actions.push(l); }
      if (topic.course && ctx.courses && ctx.courses[topic.course]) actions.push({ kind: 'course', cid: topic.course, label: `${ctx.courses[topic.course].title} course` });
      return { html: topic.text, actions, ask: topic.ask || [] };
    }
    if (IMPROVE.test(n)) return improve(ctx);
    if (topic) return intro();
    return { html: 'I\'m not sure what you mean. I know the openings in my book by name (like "Najdorf", "King\'s Indian" or "London System"), tactics like forks, pins and skewers, and the basic endgames. Try one of these:',
      actions: [], ask: ['Teach me the French Defense', 'What is a skewer?', 'How do I improve?', 'Which opening should I learn?'] };
  }
  function improve(ctx) {
    const done = ctx.done || {}, next = [];
    for (const [cid, c] of Object.entries(ctx.courses || {})) { const l = c.lessons.find((x) => !done[x.id]); if (l) next.push({ kind: 'lesson', cid, id: l.id, label: `${c.title}: ${l.title}` }); }
    const focus = (ctx.focus || []).length ? ` In our games your biggest leak is <b>${esc(ctx.focus[0].toLowerCase())}</b>, so start there.` : '';
    return { html: `The fastest way to improve: stop giving pieces away (check every capture and threat before you move), learn the basic tactics, and play games where someone points out your mistakes.${focus} Here's what I'd do next:`,
      actions: [...next, { kind: 'coach', label: 'Play a coached game' }], ask: ['What is a fork?', 'Which opening should I learn?'] };
  }


  return { answer, trainer, loadBook, findOpening, variations, norm };
});
