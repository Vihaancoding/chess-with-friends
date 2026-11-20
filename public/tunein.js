// LIVE TUNE-IN, in the browser. This browser analyses public live games with its own Stockfish (sfengine.js, in a Web Worker),
// one position at a time, and sends the evaluations to the server, which scores them (lib/tunein.js). It also draws the feed.
// Limits that keep it cheap: one game at a time; a bounded search per position; analysis pauses while the tab is hidden; a
// game is left as soon as it is no longer the one wanted; a failing engine backs off instead of retrying in a loop.
(function (root) {
  const POS_MS = 120;                  // time per position: bounded depth, so one game costs seconds, not minutes
  const BATCH = 8;                     // positions per submission
  const MAX_PLIES = 400;               // same cap as the server
  const IDLE_MS = 10000, FEED_MS = 8000, HIDDEN_MS = 5000;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (run, ms) => new Promise((res, rej) => {
    const t = setTimeout(() => { run.cancel(); rej(new Error('the engine did not answer in time')); }, ms);
    run.promise.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });

  // Rebuild every position from the moves (UCI strings). null if a move is not legal (a stale or damaged list).
  function build(C, uci) {
    const states = [C.initial()];
    for (const u of uci) {
      const st = states[states.length - 1], m = C.findUci(st, u);
      if (!m) return null;
      states.push(C.apply(st, m));
    }
    return states;
  }

  class Observer {
    constructor(api, opts) { this.api = api; this.opts = opts; this.on = false; this.gen = 0; this.failures = 0; this.until = 0; this.cancelRun = null; }
    start() { if (!this.on) { this.on = true; this.loop(); } }
    stop() { this.on = false; this.gen++; if (this.cancelRun) this.cancelRun(); this.opts.status('off', 'Log in to help find exciting games.'); }
    fail(e) {
      this.failures++;
      this.until = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(5, this.failures));
      this.opts.status('error', `Analysis paused: ${e && e.message ? e.message : 'something went wrong'}. Trying again soon.`);
    }
    async loop() {
      const gen = ++this.gen;
      const S = root.Stockfish;
      while (this.on && gen === this.gen) {
        if (!S || !S.available) { this.opts.status('unsupported', 'This browser cannot run Stockfish here, so it cannot analyse games.'); this.on = false; return; }
        if (document.visibilityState !== 'visible') { this.opts.status('hidden', 'Paused while this tab is in the background.'); await sleep(HIDDEN_MS); continue; }
        if (Date.now() < this.until) { await sleep(1000); continue; }
        let r;
        try { r = await this.api('tunein_claim', {}); } catch (e) { this.fail(e); continue; }
        if (!r || !r.ok) { this.fail(new Error((r && r.error) || 'no connection')); continue; }
        if (!r.job) { this.opts.status('idle', 'Nothing waiting for an analyser right now.'); await sleep(IDLE_MS); continue; }
        this.opts.status('analysing', `Analysing game ${r.job.code}.`);
        try { await this.analyse(r.job, gen); this.failures = 0; } catch (e) { this.fail(e); }
      }
    }
    // Evaluate positions from job.from on. Stops when the game is over, the tab hides, or another game is wanted.
    async analyse(job, gen) {
      const S = root.Stockfish, C = root.Chess;
      let hist = job.hist.slice(), states = build(C, hist);
      if (!states) throw new Error('the move list did not replay');
      let k = job.from, start = k, batch = [];
      const submit = async () => {
        const evals = batch; batch = [];
        const r = await this.api('tunein_submit', { code: job.code, from: start, evals });
        if (!r.ok && r.status === 409) return 'lost';          // another browser has the lease now: move on
        if (!r.ok) throw new Error(r.error || 'the server did not take the analysis');
        if (r.resync != null) { k = r.resync; start = k; return 'resync'; }
        if (r.hist && r.hist.length > hist.length) { hist = r.hist; states = build(C, hist) || states; }
        start = k;
        return r.over ? 'over' : 'ok';
      };
      while (gen === this.gen && this.on) {
        if (document.visibilityState !== 'visible') { if (batch.length) await submit(); return; }
        const top = Math.min(states.length, MAX_PLIES + 1);
        if (k >= top) { if (batch.length) { await submit(); } return; }
        const run = S.analyse(S.fen(states[k]), [], POS_MS);
        this.cancelRun = run.cancel;
        const res = await withTimeout(run, POS_MS * 4 + 3000);
        this.cancelRun = null;
        if (gen !== this.gen) return;
        if (!res) throw new Error('the engine gave no answer');
        batch.push(res.cp); k++;
        if (batch.length === BATCH || k === states.length) {
          const s = await submit();
          if (s === 'over' || s === 'lost') return;
          if (s === 'resync') { batch = []; }
        }
      }
    }
  }

  // The feed and the notifications. Events are shown once; the first look only remembers what is there, it does not notify.
  function Feed(api, opts) {
    const seen = new Set(); let since = 0, first = true, lastNotify = 0, timer = null;
    const poll = async () => {
      if (!opts.loggedIn() || document.visibilityState !== 'visible') return;
      const r = await api('tunein_feed', { since, watch: opts.watching() || '' });
      if (!r.ok) return;
      since = Math.max(since, r.now - 5000);
      render(r);
      if (first) { r.events.forEach((e) => seen.add(e.id)); first = false; return; }
      for (const e of r.events.slice().reverse()) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (opts.notifyOn() && Date.now() - lastNotify > 20000) { lastNotify = Date.now(); opts.notify(e); }
      }
    };
    const render = (r) => {
      const row = (g) => `<div class="liverow tune-row"><span class="lv"><b>${esc(g.w.name)}</b> <i>vs</i> <b>${esc(g.b.name)}</b>
        <span class="muted lm"> · ${esc(opts.tc(g.tc))} · move ${Math.ceil(g.ply / 2) || 1}</span>
        <span class="tune-why">${g.reasons.length ? esc(g.reasons.join(' · ')) : 'Quiet so far'}</span></span>
        <span class="tune-score" title="Excitement, 0-100">${g.score}</span>
        <button class="small" data-watch="${esc(g.code)}">Watch</button></div>`;
      const star = r.featured;
      opts.star.innerHTML = star ? `<div class="tune-star"><span class="muted tune-kicker">Match of the moment</span>${row(star)}</div>` : '';
      opts.list.innerHTML = r.ranked.length ? r.ranked.map(row).join('') : '<div class="muted empty">No games with a fresh analysis yet. Turn on analysis in this browser to help find them.</div>';
      opts.count.textContent = r.analysed || r.waiting ? `${r.analysed} analysed · ${r.waiting} waiting for an analyser` : '';
    };
    return {
      start() { if (!timer) { poll(); timer = setInterval(poll, FEED_MS); } },
      stop() { clearInterval(timer); timer = null; },
      poll,
    };
  }

  // Wire the panel. opts: { status(kind, text), star, list, count, tc(tc), watching(), loggedIn(), notifyOn(), notify(event), watch(code) }
  // No switch on the page: a logged-in browser helps by default. Notifications have no control, so they stay off.
  function init(api, opts) {
    const obs = new Observer(api, opts), feed = Feed(api, opts);
    opts.notifyOn = () => false;
    const sync = () => { if (opts.loggedIn()) obs.start(); else if (obs.on) obs.stop(); };
    opts.list.addEventListener('click', (e) => { const b = e.target.closest('[data-watch]'); if (b) opts.watch(b.dataset.watch); });
    opts.star.addEventListener('click', (e) => { const b = e.target.closest('[data-watch]'); if (b) opts.watch(b.dataset.watch); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync(); feed.poll(); } });
    feed.start();
    sync();
    setInterval(sync, 4000);   // a session restored after load, or a tab that came back: pick the state up without a click
    return { sync, feed, observer: obs };
  }

  root.TuneIn = { init, build, POS_MS, BATCH, MAX_PLIES };
})(typeof self !== 'undefined' ? self : this);
