// Stockfish as an alternative analysis engine (Stockfish 19 lite, single-threaded WebAssembly, in public/stockfish/;
// GPLv3, see public/stockfish/COPYING.txt). StockfishWorker looks like a Worker running bot.js and answers the same
// { type: 'analyze' } messages with the same fields, so the game review, move badges, evaluation bar and coach can
// use either engine. Scores are in centipawns from the side to move's point of view, and mates use bot.js's scale
// (100000 minus the moves to mate, in plies).
(function (root) {
  const MATE = 100000;
  const FILES = 'abcdefgh';
  const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));
  const uciOf = (m) => sqName(m.from) + sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');

  function fen(st) {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      let row = '', empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = st.board[r * 8 + c];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p[0] === 'w' ? p[1] : p[1].toLowerCase();
      }
      rows.push(row + (empty || ''));
    }
    const c = st.castle || {};
    const cas = (c.wK ? 'K' : '') + (c.wQ ? 'Q' : '') + (c.bK ? 'k' : '') + (c.bQ ? 'q' : '') || '-';
    return `${rows.join('/')} ${st.turn} ${cas} ${st.ep != null ? sqName(st.ep) : '-'} ${st.half || 0} ${st.full || 1}`;
  }
  const scoreOf = (kind, v) => (kind === 'mate' ? (v > 0 ? MATE - (2 * v - 1) : -(MATE + 2 * v)) : v);

  // ---------- one engine: a Worker running Stockfish, one search at a time ----------
  class Engine {
    constructor() {
      this.w = new Worker('stockfish/stockfish-19-lite-single.js');
      this.wait = null; this.lines = null; this.busy = false;
      this.w.onmessage = (e) => this.line(String(e.data));
      this.w.onerror = (e) => { e.preventDefault(); this.dead = true; if (this.wait) { const w = this.wait; this.wait = null; w.reject(new Error('Stockfish stopped')); } };
      this.ready = this.until('uci', 'uciok').then(() => this.until('isready', 'readyok'));
    }
    until(cmd, word) { return new Promise((resolve, reject) => { this.wait = { word, resolve, reject }; this.w.postMessage(cmd); }); }
    line(s) {
      if (this.lines && s.startsWith('info ') && / pv /.test(s)) {
        const t = s.split(' '), at = (k) => t.indexOf(k);
        const sc = at('score'), pv = at('pv');
        if (sc < 0 || t[sc + 3] === 'lowerbound' || t[sc + 3] === 'upperbound') return;
        const k = at('multipv') >= 0 ? +t[at('multipv') + 1] : 1;
        this.lines[k] = { uci: t[pv + 1], s: scoreOf(t[sc + 1], +t[sc + 2]), depth: +t[at('depth') + 1] };
        return;
      }
      const w = this.wait;
      if (w && s.split(' ')[0] === w.word) { this.wait = null; w.resolve(s); }
    }
    // position: { fen, moves: [uci] }; returns [{ uci, s, depth }] best first
    async search(pos, ms, multipv, only) {
      await this.ready;
      this.lines = [];
      this.w.postMessage('setoption name MultiPV value ' + multipv);
      this.w.postMessage(`position fen ${pos.fen}${pos.moves.length ? ' moves ' + pos.moves.join(' ') : ''}`);
      await this.until(`go movetime ${Math.max(20, Math.round(ms))}${only ? ' searchmoves ' + only.join(' ') : ''}`, 'bestmove');
      const out = this.lines.filter(Boolean); this.lines = null;
      return out;
    }
    stop() { if (this.wait && this.wait.word === 'bestmove') this.w.postMessage('stop'); }
  }
  // Engines are kept and reused: callers end a StockfishWorker whenever a search is no longer wanted (the evaluation
  // bar does on every move), and starting Stockfish again each time would cost its start-up.
  const free = [];
  const take = () => { while (free.length) { const e = free.pop(); if (!e.dead) return e; } return new Engine(); };
  const give = (e) => { if (!e.dead && free.length < 2) free.push(e); else e.w.terminate(); };

  // ---------- the bot.js look-alike ----------
  class StockfishWorker {
    constructor() { this.onmessage = null; this.onerror = null; this.q = Promise.resolve(); this.dead = false; this.eng = null; }
    postMessage(d) {
      this.q = this.q.then(() => (this.dead ? null : this.run(d))).catch((err) => {
        if (this.dead) return;
        if (this.onerror) this.onerror({ message: err.message, preventDefault() {} });
      });
    }
    terminate() {
      if (this.dead) return;
      this.dead = true;
      const e = this.eng; this.eng = null;
      if (e) { e.stop(); this.q.then(() => give(e), () => give(e)); }
    }
    send(data) { if (!this.dead && this.onmessage) this.onmessage({ data }); }
    async run(d) {
      if (d.type !== 'analyze') throw new Error('Stockfish only analyzes positions here');
      this.eng = this.eng || take();
      const { id, states, hist, ms } = d;
      const order = d.order || Array.from({ length: hist.length + (d.skipFinal ? 0 : 1) }, (_, i) => i);
      const start = fen(states[0]), moves = hist.map(uciOf);
      for (const i of order) {
        if (this.dead) return;
        this.send({ id, i, n: hist.length, ...(await this.position(states[i], { fen: start, moves: moves.slice(0, i) }, hist[i], ms, !!d.scores)) });
      }
      this.send({ id, done: true });
    }
    // one position, answered like bot.js: best move and score, the second best, the played move's score, every
    // move's score when asked (the coach)
    async position(st, pos, h, ms, all) {
      const legal = root.Chess.legalMoves(st);
      if (!legal.length) return { best: null, bestScore: root.Chess.inCheck(st, st.turn) ? -MATE : 0, second: null, played: null, legal: 0, depth: 0, terminal: true };
      const byUci = new Map(legal.map((m) => [uciOf(m), m]));
      const plain = (m) => (m.promo ? { from: m.from, to: m.to, promo: m.promo } : { from: m.from, to: m.to });
      const lines = await this.eng.search(pos, ms, all ? legal.length : Math.min(2, legal.length));
      if (this.dead || !lines.length) return { best: null, bestScore: 0, second: null, played: null, legal: legal.length, depth: 0, terminal: false };
      let played = null;
      if (h) {
        const u = uciOf(h), hit = lines.find((x) => x.uci === u);
        if (hit) played = hit.s;
        else if (byUci.has(u)) { const r = await this.eng.search(pos, ms / 2, 1, [u]); played = r[0] ? Math.min(r[0].s, lines[0].s) : null; }
      }
      const best = byUci.get(lines[0].uci) || legal[0];
      return {
        best: plain(best), bestScore: lines[0].s, second: lines[1] ? lines[1].s : null, played, legal: legal.length, depth: lines[0].depth, terminal: false,
        scores: all ? lines.filter((x) => byUci.has(x.uci)).map((x) => ({ ...plain(byUci.get(x.uci)), s: x.s })) : undefined,
      };
    }
  }
  root.StockfishWorker = StockfishWorker;
  root.Stockfish = { fen, available: typeof WebAssembly === 'object' && typeof Worker === 'function' };
})(typeof self !== 'undefined' ? self : this);
