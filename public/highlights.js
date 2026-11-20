// REELS: a full-screen, vertical feed of highlight moments (lib/highlights.js decides what is worth one; the server stores them).
// One reel per screen, scroll-snap between them. The reel on screen plays its moves; the others stop. Nothing here decides
// what is a highlight.
(function (root) {
  const LABEL = { upset: 'Upset', streak: 'Streak breaker', comeback: 'Comeback', sacrifice: 'Sacrifice', time: 'Time scramble', swing: 'Big swing' };
  const FILTERS = [['all', 'All'], ['trending', 'Trending'], ['upsets', 'Upsets'], ['streaks', 'Streak breakers'], ['comebacks', 'Comebacks'], ['sacrifices', 'Sacrifices'], ['time', 'Time scrambles']];
  const LEAD = 4;                 // moves shown before the moment
  const STEP_MS = 900;            // time per move when playing
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // states[i] = the position after i moves; last[i] = the squares of move i (null at the start)
  function replay(C, moves) {
    const states = [C.initial()], last = [null];
    for (const u of moves) {
      const st = states[states.length - 1], m = C.findUci(st, u);
      if (!m) break;
      states.push(C.apply(st, m)); last.push({ from: m.from, to: m.to });
    }
    return { states, last };
  }

  function boardHtml(st, last) {
    let h = '<div class="rls-board" role="img" aria-label="Board position">';
    for (let i = 0; i < 64; i++) {
      const r = i >> 3, c = i & 7, p = st.board[i], dark = (r + c) % 2 === 1;
      const hot = last && (last.from === i || last.to === i);
      h += `<div class="rls-sq ${dark ? 'd' : 'l'}${hot ? ' hot' : ''}">${p ? `<img alt="" src="piece/cburnett/${p}.svg">` : ''}</div>`;
    }
    return h + '</div>';
  }

  function resultOf(h) {
    if (!h.over) return 'In progress';
    if (h.result === 'draw') return `Draw (${esc(h.reason || 'agreed')})`;
    const won = h.result === 'w' ? h.w : h.b;
    return `${esc(won.name)} won · ${esc(h.reason || 'finished')}`;
  }

  function init(api, opts) {
    const el = opts.root;
    el.innerHTML = '<div class="rls-top"><div class="rls-filters"></div></div><div class="rls-scroll"></div>';
    const fEl = el.querySelector('.rls-filters'), sEl = el.querySelector('.rls-scroll');
    const reels = new Map();            // id -> { h, states, last, ply, start }
    const timers = new Map();           // id -> interval, for the reels that are playing
    let filter = 'all', io = null;

    const slideHtml = (h) => {
      const C = root.Chess, rp = replay(C, h.moves || []);
      const max = Math.max(0, rp.states.length - 1), start = Math.max(0, Math.min(h.ply - LEAD, max));
      reels.set(h.id, { h, ...rp, start, ply: start });
      const r = reels.get(h.id);
      return `<section class="rls-slide" data-id="${esc(h.id)}">
        <div class="rls-boardwrap" data-board>${boardHtml(r.states[r.ply], r.last[r.ply])}</div>
        <div class="rls-meta">
          <div class="rls-kind">${esc(LABEL[h.kind] || 'Moment')}</div>
          <h2 class="rls-head">${esc(h.headline)}</h2>
          <div class="rls-players"><b>${esc(h.w.name)}</b> <i>(${h.w.elo})</i> <i>vs</i> <b>${esc(h.b.name)}</b> <i>(${h.b.elo})</i></div>
          <div class="rls-line">${resultOf(h)}${h.tc ? ` · ${esc(opts.tc(h.tc))}` : ''}</div>
          <p class="rls-why">${esc(h.why)}</p>
          <div class="rls-ctl">
            <button class="small" data-step="-1" aria-label="Previous move">&#8249;</button>
            <input type="range" min="0" max="${max}" value="${r.ply}" data-ply aria-label="Move">
            <button class="small" data-step="1" aria-label="Next move">&#8250;</button>
            <button class="small primary" data-toggle aria-label="Play">Play</button>
          </div>
          <div class="rls-pos" data-pos>Move ${r.ply} of ${max}</div>
          <div class="rls-acts">
            ${h.gid ? `<button class="small" data-open="${esc(h.gid)}">Open full game</button>` : ''}
            ${!h.over ? `<button class="small" data-watch="${esc(h.code)}">Watch live</button>` : ''}
          </div>
        </div>
      </section>`;
    };

    const paint = (id) => {
      const r = reels.get(id), s = sEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!r || !s) return;
      s.querySelector('[data-board]').innerHTML = boardHtml(r.states[r.ply], r.last[r.ply]);
      s.querySelector('[data-ply]').value = r.ply;
      s.querySelector('[data-pos]').textContent = `Move ${r.ply} of ${r.states.length - 1}`;
    };
    const setToggle = (id, playing) => {
      const b = sEl.querySelector(`[data-id="${CSS.escape(id)}"] [data-toggle]`);
      if (b) { b.textContent = playing ? 'Pause' : 'Play'; b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
    };
    const step = (id, d) => {
      const r = reels.get(id);
      if (!r) return;
      r.ply = Math.max(0, Math.min(r.states.length - 1, r.ply + d));
      paint(id);
      if (r.ply >= r.states.length - 1) pause(id);
    };
    function play(id) {
      const r = reels.get(id);
      if (!r || timers.has(id)) return;
      if (r.ply >= r.states.length - 1) r.ply = r.start;   // a finished reel starts again from the lead-in
      paint(id);
      timers.set(id, setInterval(() => step(id, 1), STEP_MS));
      setToggle(id, true);
    }
    function pause(id) {
      clearInterval(timers.get(id));
      timers.delete(id);
      setToggle(id, false);
    }
    function stopAll() {
      for (const id of [...timers.keys()]) pause(id);
      if (io) io.disconnect();
      io = null;
    }
    // play the reel that fills the screen; stop the others
    function watchScroll() {
      if (io) io.disconnect();
      io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const id = en.target.dataset.id;
          if (en.isIntersecting && en.intersectionRatio >= 0.6) play(id); else pause(id);
        }
      }, { root: sEl, threshold: [0, 0.6] });
      sEl.querySelectorAll('.rls-slide').forEach((s) => io.observe(s));
    }

    function render(list) {
      stopAll();
      reels.clear();
      sEl.scrollTop = 0;
      sEl.innerHTML = list.length ? list.map(slideHtml).join('')
        : `<div class="rls-empty">${filter === 'all' ? 'No reels yet. They appear when a checked analysis finds a moment worth one.' : 'Nothing in this filter yet.'}</div>`;
      watchScroll();
    }
    function paintFilters() {
      fEl.innerHTML = FILTERS.map(([k, t]) => `<button class="small${k === filter ? ' on' : ''}" data-filter="${k}">${t}</button>`).join('');
    }

    async function load() {
      paintFilters();
      if (!opts.loggedIn()) { stopAll(); sEl.innerHTML = '<div class="rls-empty">Log in to see highlight reels.</div>'; return; }
      const r = await api('highlight_feed', { filter: filter === 'trending' ? 'all' : filter });
      if (!r.ok) { sEl.innerHTML = `<div class="rls-empty">${esc(r.error || 'Could not load reels.')}</div>`; return; }
      render(filter === 'trending' ? r.trending : r.feed);
    }

    sEl.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]'), watch = e.target.closest('[data-watch]');
      if (open) return opts.open(open.dataset.open);
      if (watch) return opts.watch(watch.dataset.watch);
      const s = e.target.closest('[data-id]');
      if (!s) return;
      if (e.target.closest('[data-toggle]')) { timers.has(s.dataset.id) ? pause(s.dataset.id) : play(s.dataset.id); return; }
      const st = e.target.closest('[data-step]');
      if (st) { pause(s.dataset.id); step(s.dataset.id, +st.dataset.step); }
    });
    sEl.addEventListener('input', (e) => {
      if (!e.target.matches('[data-ply]')) return;
      const s = e.target.closest('[data-id]');
      if (!s) return;
      pause(s.dataset.id);
      const r = reels.get(s.dataset.id);
      if (r) { r.ply = +e.target.value; paint(s.dataset.id); }
    });
    fEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      load();
    });

    return {
      // the page was opened: load its reels (fresh each time it opens, so the feed never jumps while you scroll)
      enter() { load(); },
      // the page was left: stop everything that runs in the background
      leave() { stopAll(); },
    };
  }

  root.HighlightReels = { init, replay, LABEL, FILTERS };
})(typeof self !== 'undefined' ? self : this);
