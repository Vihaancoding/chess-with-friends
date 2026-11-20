// HIGHLIGHT REELS, in the browser: the feed of moments the server found in TUNE-IN analyses (lib/highlights.js). Each reel is a
// small board that starts a few moves before the moment, with step controls. Nothing here decides what is a highlight.
(function (root) {
  const LABEL = { upset: 'Upset', streak: 'Streak breaker', comeback: 'Comeback', sacrifice: 'Sacrifice', time: 'Time scramble', swing: 'Big swing' };
  const FILTERS = [['all', 'All'], ['upsets', 'Upsets'], ['streaks', 'Streak breakers'], ['comebacks', 'Comebacks'], ['sacrifices', 'Sacrifices'], ['time', 'Time scrambles']];
  const LEAD = 4;                       // moves shown before the moment
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // every position of a reel: states[i] after i moves, and the move that led to it (from/to squares)
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
    let h = '<div class="rl-board" role="img" aria-label="Board">';
    for (let i = 0; i < 64; i++) {
      const r = i >> 3, c = i & 7, p = st.board[i], dark = (r + c) % 2 === 1;
      const hot = last && (last.from === i || last.to === i);
      h += `<div class="rl-sq ${dark ? 'd' : 'l'}${hot ? ' hot' : ''}">${p ? `<img alt="" src="piece/cburnett/${p}.svg">` : ''}</div>`;
    }
    return h + '</div>';
  }

  // the line under a reel: how it ended, if it has ended
  function resultOf(h) {
    if (!h.over) return 'In progress';
    if (h.result === 'draw') return `Draw (${esc(h.reason || 'agreed')})`;
    const won = h.result === 'w' ? h.w : h.b;
    return `${esc(won.name)} won · ${esc(h.reason || 'finished')}`;
  }

  function Reels(api, opts) {
    const reels = new Map();            // id -> { h, states, last, ply }
    let filter = 'all', timer = null;

    const reelHtml = (h) => {
      const C = root.Chess, rp = replay(C, h.moves || []), start = Math.max(0, Math.min(h.ply - LEAD, rp.states.length - 1));
      reels.set(h.id, { h, ...rp, ply: start });
      const r = reels.get(h.id), max = rp.states.length - 1;
      return `<article class="rl-reel" data-id="${esc(h.id)}">
        <div class="rl-kind">${esc(LABEL[h.kind] || 'Moment')}</div>
        <h3 class="rl-head">${esc(h.headline)}</h3>
        <div class="rl-players"><b>${esc(h.w.name)}</b> <i>(${h.w.elo})</i> <i>vs</i> <b>${esc(h.b.name)}</b> <i>(${h.b.elo})</i></div>
        <div class="rl-line">${resultOf(h)}${h.tc ? ` · ${esc(opts.tc(h.tc))}` : ''}</div>
        <div class="rl-body">
          <div class="rl-boardwrap" data-board>${boardHtml(r.states[r.ply], r.last[r.ply])}</div>
          <div class="rl-side">
            <div class="rl-why">${esc(h.why)}</div>
            <div class="rl-ctl">
              <button class="small" data-step="-1" aria-label="Previous move">&#8249;</button>
              <input type="range" min="0" max="${max}" value="${r.ply}" data-ply aria-label="Move">
              <button class="small" data-step="1" aria-label="Next move">&#8250;</button>
            </div>
            <div class="rl-pos muted" data-pos>Move ${r.ply} of ${max}</div>
            <div class="rl-acts">
              ${h.gid ? `<button class="small primary" data-open="${esc(h.gid)}">Open full game</button>` : ''}
              ${!h.over ? `<button class="small" data-watch="${esc(h.code)}">Watch live</button>` : ''}
            </div>
          </div>
        </div>
      </article>`;
    };

    function paintReel(id) {
      const r = reels.get(id), el = opts.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!r || !el) return;
      el.querySelector('[data-board]').innerHTML = boardHtml(r.states[r.ply], r.last[r.ply]);
      el.querySelector('[data-ply]').value = r.ply;
      el.querySelector('[data-pos]').textContent = `Move ${r.ply} of ${r.states.length - 1}`;
    }

    function render(r) {
      opts.filters.innerHTML = FILTERS.map(([k, t]) => `<button class="small${k === filter ? ' on' : ''}" data-filter="${k}">${t}</button>`).join('');
      opts.trend.innerHTML = r.trending.length
        ? `<div class="rl-kicker muted">Trending</div>` + r.trending.map((h) => `<div class="rl-trow"><span class="rl-tk">${esc(LABEL[h.kind] || '')}</span> ${esc(h.headline)} <span class="muted">${esc(h.w.name)} vs ${esc(h.b.name)}</span></div>`).join('')
        : '';
      reels.clear();
      opts.list.innerHTML = r.feed.length ? r.feed.map(reelHtml).join('')
        : `<div class="muted empty">No reels yet. They appear when a checked analysis finds a moment worth one.</div>`;
      opts.count.textContent = r.feed.length ? `${r.feed.length} reel${r.feed.length === 1 ? '' : 's'}` : '';
    }

    async function load() {
      if (!opts.loggedIn()) { opts.list.innerHTML = '<div class="muted empty">Log in to see highlight reels.</div>'; return; }
      const r = await api('highlight_feed', { filter });
      if (r.ok) render(r);
    }

    // one listener for the whole list: step, scrub, open, watch
    opts.list.addEventListener('click', (e) => {
      const card = e.target.closest('[data-id]');
      const step = e.target.closest('[data-step]'), open = e.target.closest('[data-open]'), watch = e.target.closest('[data-watch]');
      if (open) return opts.open(open.dataset.open);
      if (watch) return opts.watch(watch.dataset.watch);
      if (!card || !step) return;
      const r = reels.get(card.dataset.id);
      if (!r) return;
      r.ply = Math.max(0, Math.min(r.states.length - 1, r.ply + +step.dataset.step));
      paintReel(card.dataset.id);
    });
    opts.list.addEventListener('input', (e) => {
      const card = e.target.closest('[data-id]'), r = card && reels.get(card.dataset.id);
      if (!r || !e.target.matches('[data-ply]')) return;
      r.ply = +e.target.value;
      paintReel(card.dataset.id);
    });
    opts.filters.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      load();
    });

    return {
      start() { if (!timer) { load(); timer = setInterval(load, 30000); } },
      reload: load,
    };
  }

  function init(api, opts) {
    const reels = Reels(api, opts);
    reels.start();
    return reels;
  }

  root.HighlightReels = { init, replay, LABEL, FILTERS };
})(typeof self !== 'undefined' ? self : this);
