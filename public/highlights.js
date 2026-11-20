// REELS, in the browser: a centred vertical feed of highlight moments (lib/highlights.js decides what is worth one; the server
// stores them, with finished games too). Each card: the board with its controls, the two players, then the moment and an action.
// The reel on screen plays its moves; the others stop. Nothing here decides what is a highlight.
(function (root) {
  const LABEL = { upset: 'Upset', streak: 'Streak breaker', comeback: 'Comeback', sacrifice: 'Sacrifice', time: 'Time scramble', swing: 'Big swing' };
  const FILTERS = [['all', 'All'], ['trending', 'Trending'], ['upsets', 'Upsets'], ['streaks', 'Streak breakers'], ['comebacks', 'Comebacks'], ['sacrifices', 'Sacrifices'], ['time', 'Time scrambles']];
  const LEAD = 4;                 // moves shown before the moment
  const STEP_MS = 900;            // time per move when playing
  const REFRESH_MS = 15000;       // live clocks on the cards are refreshed this often (the list itself keeps its place)
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

  // White at the bottom: rank 8 is the top row, file a the left column
  function boardHtml(st, last) {
    let h = '<div class="rls-board" role="img" aria-label="Board position">';
    for (let i = 0; i < 64; i++) {
      const r = i >> 3, c = i & 7, p = st.board[i], dark = (r + c) % 2 === 1;
      const hot = last && (last.from === i || last.to === i);
      h += `<div class="rls-sq ${dark ? 'd' : 'l'}${hot ? ' hot' : ''}">${p ? `<img alt="" src="piece/cburnett/${p}.svg">` : ''}</div>`;
    }
    return h + '</div>';
  }

  const timeText = (ms) => (ms < 60000 ? `${Math.max(1, Math.ceil(ms / 1000))}s` : `${Math.floor(ms / 60000)}m`);

  function init(api, opts) {
    const el = opts.root;
    el.innerHTML = '<div class="rls-top"><div class="rls-filters"></div></div><div class="rls-scroll"></div>';
    const fEl = el.querySelector('.rls-filters'), sEl = el.querySelector('.rls-scroll');
    const reels = new Map();            // id -> { h, states, last, ply, start }
    const timers = new Map();           // id -> interval, for the reels that are playing
    let filter = 'all', io = null, timer = null;

    // the badge and the action: status changes as a live game ends
    const badgeHtml = (h) => (h.done
      ? `<span class="rls-badge done">Completed${h.result ? (h.result === 'draw' ? ' - Draw' : ' - Decisive') : ''}</span>`
      : `<span class="rls-badge live">Live${h.left != null ? ' - ' + timeText(h.left) + ' remaining' : ''}</span>`);
    const actionHtml = (h) => (h.done
      ? (h.gid ? `<button class="rls-go" data-open="${esc(h.gid)}">View full game</button>` : '')
      : `<button class="rls-go" data-watch="${esc(h.code)}">Watch live</button>`);
    const pill = (p) => `<div class="rls-pill"><span class="rls-avwrap"><span class="rls-av">${esc(String(p.name).charAt(0).toUpperCase())}</span>${opts.avatar(p.name)}</span><div class="rls-who"><b>${esc(p.name)}</b><span>${p.elo}</span></div></div>`;

    const slideHtml = (h) => {
      const rp = replay(root.Chess, h.moves || []);
      const max = Math.max(0, rp.states.length - 1), start = Math.max(0, Math.min(h.ply - LEAD, max));
      reels.set(h.id, { h, ...rp, start, ply: start });
      const r = reels.get(h.id);
      return `<section class="rls-slide" data-id="${esc(h.id)}"><div class="rls-card">
        <div class="rls-boardbox" data-board>${boardHtml(r.states[r.ply], r.last[r.ply])}</div>
        <div class="rls-ctl">
          <button data-first aria-label="Start of the game">&#124;&#8249;</button>
          <button data-step="-1" aria-label="Previous move">&#8249;</button>
          <input type="range" min="0" max="${max}" value="${r.ply}" data-ply aria-label="Move">
          <button data-step="1" aria-label="Next move">&#8250;</button>
          <button data-last aria-label="Last move">&#8250;&#124;</button>
          <button class="rls-play" data-toggle aria-label="Play">Play</button>
        </div>
        <div class="rls-pos" data-pos>Move ${r.ply} of ${max}</div>
        <div class="rls-pills">${pill(h.w)}${pill(h.b)}</div>
        <div class="rls-info">
          <div class="rls-tags"><span class="rls-kind">${esc(LABEL[h.kind] || 'Moment')}</span><span data-badge>${badgeHtml(h)}</span></div>
          <h2 class="rls-head">${esc(h.headline)}</h2>
          <p class="rls-why">${esc(h.why)}</p>
          <div class="rls-acts" data-action>${actionHtml(h)}</div>
        </div>
      </div></section>`;
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
    const jump = (id, ply) => {
      const r = reels.get(id);
      if (!r) return;
      r.ply = Math.max(0, Math.min(r.states.length - 1, ply));
      paint(id);
      if (r.ply >= r.states.length - 1) pause(id);
    };
    const step = (id, d) => { const r = reels.get(id); if (r) jump(id, r.ply + d); };
    function play(id) {
      const r = reels.get(id);
      if (!r || timers.has(id)) return;
      if (r.ply >= r.states.length - 1) r.ply = r.start;   // a finished reel starts again from its lead-in
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
    // play the card that fills the screen; stop the others
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
    const listOf = (r) => (filter === 'trending' ? r.trending : r.feed);

    async function load() {
      paintFilters();
      if (!opts.loggedIn()) { stopAll(); sEl.innerHTML = '<div class="rls-empty">Log in to see reels.</div>'; return; }
      const r = await api('highlight_feed', { filter: filter === 'trending' ? 'all' : filter });
      if (!r.ok) { sEl.innerHTML = `<div class="rls-empty">${esc(r.error || 'Could not load reels.')}</div>`; return; }
      render(listOf(r));
    }
    // Same reels: only the live badges and actions change, so the card on screen stays put. A different list is redrawn in place.
    async function refresh() {
      if (!opts.loggedIn() || !reels.size) return;
      const r = await api('highlight_feed', { filter: filter === 'trending' ? 'all' : filter });
      if (!r.ok) return;
      const list = listOf(r);
      if (!(list.length === reels.size && list.every((h) => reels.has(h.id)))) { const keep = sEl.scrollTop; render(list); sEl.scrollTop = keep; return; }
      for (const h of list) {
        const s = sEl.querySelector(`[data-id="${CSS.escape(h.id)}"]`);
        if (!s) continue;
        s.querySelector('[data-badge]').innerHTML = badgeHtml(h);
        s.querySelector('[data-action]').innerHTML = actionHtml(h);
      }
    }

    sEl.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]'), watch = e.target.closest('[data-watch]');
      if (open) return opts.open(open.dataset.open);
      if (watch) return opts.watch(watch.dataset.watch);
      const s = e.target.closest('[data-id]');
      if (!s) return;
      const id = s.dataset.id;
      if (e.target.closest('[data-toggle]')) { timers.has(id) ? pause(id) : play(id); return; }
      if (e.target.closest('[data-first]')) return jump(id, 0);
      if (e.target.closest('[data-last]')) { const r = reels.get(id); return r && jump(id, r.states.length - 1); }
      const st = e.target.closest('[data-step]');
      if (st) { pause(id); step(id, +st.dataset.step); }
    });
    sEl.addEventListener('input', (e) => {
      if (!e.target.matches('[data-ply]')) return;
      const s = e.target.closest('[data-id]');
      if (!s) return;
      pause(s.dataset.id);
      jump(s.dataset.id, +e.target.value);
    });
    fEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      load();
    });

    return {
      // the page was opened: its reels load fresh, and the live clocks stay current while it is open
      enter() { load(); if (!timer) timer = setInterval(refresh, REFRESH_MS); },
      // the page was left: stop everything that runs in the background
      leave() { stopAll(); clearInterval(timer); timer = null; },
    };
  }

  root.HighlightReels = { init, replay, LABEL, FILTERS };
})(typeof self !== 'undefined' ? self : this);
