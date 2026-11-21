// REELS, in the browser: a centred vertical feed of highlight moments, with a move list and evaluation graph on the left and
// Up Next and Happening Live on the right (from 1200px wide). Each reel: the board with its evaluation bar, the two players, the
// moment and an action, plus a rail of controls. The reel on screen plays its moves; the others stop.
// Nothing here decides what is a highlight: lib/highlights.js does that, the server stores it.
(function (root) {
  const LABEL = { upset: 'Upset', streak: 'Streak breaker', comeback: 'Comeback', sacrifice: 'Sacrifice', time: 'Time scramble', swing: 'Big swing' };
  const FILTERS = [['all', 'All'], ['trending', 'Trending'], ['upsets', 'Upsets'], ['streaks', 'Streak breakers'], ['comebacks', 'Comebacks'], ['sacrifices', 'Sacrifices'], ['time', 'Time scrambles']];
  const LEAD = 4;                 // moves shown before the moment
  const STEP_MS = 900;            // time per move when playing
  const REFRESH_MS = 15000;       // live clocks, reactions and the side lists are refreshed this often
  const SAVES = 'chess:reelSaves';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (p, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const ICON = {
    up: svg('<path d="M6 14l6-6 6 6"/>'),
    down: svg('<path d="M6 10l6 6 6-6"/>'),
    flame: svg('<path d="M12 3c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8z"/>'),
    save: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
    flip: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
    share: svg('<path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/>'),
  };

  // states[i] = the position after i moves; last[i] = the squares of move i; san[i] = move i in notation
  function replay(C, moves) {
    const states = [C.initial()], last = [null], san = [];
    for (const u of moves) {
      const st = states[states.length - 1], m = C.findUci(st, u);
      if (!m) break;
      san.push(C.notate(st, m));
      states.push(C.apply(st, m)); last.push({ from: m.from, to: m.to });
    }
    return { states, last, san };
  }

  // The 8x8 board. White at the bottom by default; flip turns it round (rank 1 on top).
  function boardHtml(st, last, flip) {
    let h = '<div class="rls-board" role="img" aria-label="Board position">';
    for (let k = 0; k < 64; k++) {
      const i = flip ? 63 - k : k, r = i >> 3, c = i & 7, p = st.board[i], dark = (r + c) % 2 === 1;
      const hot = last && (last.from === i || last.to === i);
      h += `<div class="rls-sq ${dark ? 'd' : 'l'}${hot ? ' hot' : ''}">${p ? `<img alt="" src="piece/cburnett/${p}.svg">` : ''}</div>`;
    }
    return h + '</div>';
  }

  // White's share of the bar, from the engine score in centipawns (White's view)
  const barPct = (cp) => (cp == null ? 50 : 100 / (1 + Math.pow(10, -Math.max(-2000, Math.min(2000, cp)) / 400)));

  // the evaluation through the game as a line; the dot is the position on screen
  function sparkHtml(evals, ply) {
    if (!evals || evals.length < 2) return '<div class="rls-noeval muted">No evaluation for this game yet.</div>';
    const W = 280, H = 70, n = evals.length - 1;
    const pts = evals.map((cp, i) => {
      const x = (i / n) * W, y = H / 2 - Math.max(-600, Math.min(600, cp)) / 600 * (H / 2 - 4);
      return [x, y];
    });
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const cur = pts[Math.max(0, Math.min(n, ply))];
    return `<svg class="rls-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Evaluation through the game">
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="rls-mid"/>
      <path d="${line}" class="rls-line"/>
      <circle cx="${cur[0].toFixed(1)}" cy="${cur[1].toFixed(1)}" r="4" class="rls-dot"/></svg>`;
  }

  const timeText = (ms) => (ms < 60000 ? `${Math.max(1, Math.ceil(ms / 1000))}s` : `${Math.floor(ms / 60000)}m`);

  function init(api, opts) {
    const el = opts.root;
    el.innerHTML = `<div class="rls-top"><div class="rls-filters"></div></div>
      <div class="rls-body">
        <aside class="rls-side rls-left">
          <div class="rls-panel"><h3>Move List</h3><div class="rls-pgn"></div></div>
          <div class="rls-panel"><h3>Game Evaluation</h3><div class="rls-graph"></div></div>
        </aside>
        <div class="rls-scroll"></div>
        <aside class="rls-side rls-right">
          <div class="rls-panel"><h3>Up Next</h3><div class="rls-next"></div></div>
          <div class="rls-panel"><h3>Happening Live</h3><div class="rls-liveList"></div></div>
        </aside>
      </div>`;
    const fEl = el.querySelector('.rls-filters'), sEl = el.querySelector('.rls-scroll');
    const pgnEl = el.querySelector('.rls-pgn'), graphEl = el.querySelector('.rls-graph');
    const nextEl = el.querySelector('.rls-next'), liveEl = el.querySelector('.rls-liveList');
    const reels = new Map();            // id -> { h, states, last, san, ply, start, flip, evals }
    const timers = new Map();           // id -> interval, for the cards that are playing
    let list = [], live = [], filter = 'all', io = null, timer = null, current = null;
    const saved = () => { try { return JSON.parse(localStorage.getItem(SAVES) || '[]'); } catch (e) { return []; } };
    const setSaved = (arr) => { try { localStorage.setItem(SAVES, JSON.stringify(arr)); } catch (e) { /* private window: this page only */ } };

    const badgeHtml = (h) => (h.done
      ? `<span class="rls-badge done">Completed${h.result ? (h.result === 'draw' ? ' - Draw' : ' - Decisive') : ''}</span>`
      : `<span class="rls-badge live">Live${h.left != null ? ' - ' + timeText(h.left) + ' remaining' : ''}</span>`);
    const actionHtml = (h) => (h.done
      ? (h.gid ? `<button class="rls-go" data-open="${esc(h.gid)}">View full game</button>` : '')
      : `<button class="rls-go" data-watch="${esc(h.code)}">Watch live</button>`);
    const pill = (p) => `<div class="rls-pill"><span class="rls-avwrap"><span class="rls-av">${esc(String(p.name).charAt(0).toUpperCase())}</span>${opts.avatar(p.name)}</span><div class="rls-who"><b>${esc(p.name)}</b><span>${p.elo}</span></div></div>`;
    const rail = (h, r) => {
      const isSaved = saved().includes(h.id);
      return `<div class="rls-rail">
        <button class="rls-rb" data-up aria-label="Previous reel">${ICON.up}</button>
        <button class="rls-rb" data-down aria-label="Next reel">${ICON.down}</button>
        <button class="rls-rb rls-react${h.mine ? ' on' : ''}" data-react aria-label="React">${ICON.flame}<span data-rcount>${h.reacts || 0}</span></button>
        <button class="rls-rb${isSaved ? ' on' : ''}" data-save aria-label="Save to puzzles">${ICON.save}</button>
        <button class="rls-rb" data-flip aria-label="Flip board">${ICON.flip}</button>
        <button class="rls-rb" data-share aria-label="Share">${ICON.share}</button>
      </div>`;
    };

    const slideHtml = (h) => {
      const rp = replay(root.Chess, h.moves || []);
      const max = Math.max(0, rp.states.length - 1), start = Math.max(0, Math.min(h.ply - LEAD, max));
      const prev = reels.get(h.id);
      reels.set(h.id, { h, ...rp, start, ply: prev ? prev.ply : start, flip: prev ? prev.flip : false, evals: prev ? prev.evals : null });
      const r = reels.get(h.id);
      return `<section class="rls-slide" data-id="${esc(h.id)}"><div class="rls-cardwrap">
        <div class="rls-boardrow">
          <div class="rls-evbar" data-evbar><div class="rls-evw"></div></div>
          <div class="rls-boardbox" data-board>${boardHtml(r.states[r.ply], r.last[r.ply], r.flip)}</div>
        </div>
        <div class="rls-pills">${pill(h.w)}${pill(h.b)}</div>
        <div class="rls-info">
          <div class="rls-tags"><span class="rls-kind">${esc(LABEL[h.kind] || 'Moment')}</span><span data-badge>${badgeHtml(h)}</span></div>
          <h2 class="rls-head">${esc(h.headline)}</h2>
          <p class="rls-why">${esc(h.why)}</p>
          <div class="rls-acts" data-action>${actionHtml(h)}</div>
        </div>
        ${rail(h, r)}
      </div></section>`;
    };

    // the eval bar and the board of one card, from its current position
    const paintCard = (id) => {
      const r = reels.get(id), s = sEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!r || !s) return;
      s.querySelector('[data-board]').innerHTML = boardHtml(r.states[r.ply], r.last[r.ply], r.flip);
      const cp = r.evals && r.evals.length > r.ply ? r.evals[r.ply] : null;
      s.querySelector('.rls-evw').style.height = barPct(cp) + '%';
    };
    const jump = (id, ply) => {
      const r = reels.get(id);
      if (!r) return;
      r.ply = Math.max(0, Math.min(r.states.length - 1, ply));
      paintCard(id);
      if (id === current) paintSide();
      if (r.ply >= r.states.length - 1) pause(id);
    };
    const step = (id, d) => { const r = reels.get(id); if (r) jump(id, r.ply + d); };
    function play(id) {
      const r = reels.get(id);
      if (!r || timers.has(id)) return;
      if (r.ply >= r.states.length - 1) r.ply = r.start;   // a finished reel starts again from its lead-in
      paintCard(id);
      timers.set(id, setInterval(() => step(id, 1), STEP_MS));
    }
    function pause(id) { clearInterval(timers.get(id)); timers.delete(id); }
    function stopAll() {
      for (const id of [...timers.keys()]) pause(id);
      if (io) io.disconnect();
      io = null;
    }

    // the side panels follow the card on screen
    function paintSide() {
      const r = current && reels.get(current);
      if (!r) { pgnEl.innerHTML = ''; graphEl.innerHTML = ''; }
      else {
        const rows = [];
        for (let i = 0; i < r.san.length; i += 2) {
          const on = (ply) => (r.ply === ply ? ' class="on"' : '');
          rows.push(`<tr><td>${i / 2 + 1}.</td><td${on(i + 1)}>${esc(r.san[i])}</td><td${r.san[i + 1] ? on(i + 2) : ''}>${r.san[i + 1] ? esc(r.san[i + 1]) : ''}</td></tr>`);
        }
        pgnEl.innerHTML = rows.length ? `<table class="rls-moves">${rows.join('')}</table>` : '<div class="muted">No moves yet.</div>';
        graphEl.innerHTML = sparkHtml(r.evals, r.ply);
      }
      const at = current ? list.findIndex((h) => h.id === current) : -1;
      const ups = list.slice(at + 1, at + 4);
      nextEl.innerHTML = ups.length ? ups.map((h) => `<button class="rls-nx" data-goto="${esc(h.id)}"><span class="rls-nk">${esc(LABEL[h.kind] || '')}</span><span class="rls-nh">${esc(h.headline)}</span><span class="rls-nm muted">${esc(h.w.name)} vs ${esc(h.b.name)}</span></button>`).join('')
        : '<div class="muted">Nothing after this yet.</div>';
      liveEl.innerHTML = live.length ? live.map((g) => `<div class="rls-lv"><div class="rls-nm"><b>${esc(g.w.name)}</b> <i>vs</i> <b>${esc(g.b.name)}</b></div><div class="muted">${g.tc ? esc(opts.tc(g.tc)) : 'No clock'} · move ${Math.ceil((g.moves || 0) / 2) || 1}</div><button class="rls-go" data-watch="${esc(g.code)}">Watch live</button></div>`).join('')
        : '<div class="muted">No live games right now.</div>';
    }
    async function loadEvals(id) {
      const r = reels.get(id);
      if (!r || r.evals) return;
      const d = await api('highlight_detail', { id });
      if (!d.ok || !reels.has(id)) return;
      reels.get(id).evals = d.evals;
      paintCard(id);
      if (id === current) paintSide();
    }
    // the card nearest the middle of the screen is the current one: it plays, its side panels show it, the others stop
    function nearest() {
      const box = sEl.getBoundingClientRect(), mid = box.top + box.height / 2;
      let best = null, gap = Infinity;
      sEl.querySelectorAll('.rls-slide').forEach((s) => {
        const b = s.getBoundingClientRect(), d = Math.abs(b.top + b.height / 2 - mid);
        if (d < gap) { gap = d; best = s; }
      });
      return best && best.dataset.id;
    }
    function setCurrent(id) {
      if (!id) return;
      if (current !== id) { current = id; paintSide(); loadEvals(id); }
      for (const s of sEl.querySelectorAll('.rls-slide')) { if (s.dataset.id === id) play(id); else pause(s.dataset.id); }
    }
    function watchScroll() {
      if (io) io.disconnect();
      io = new IntersectionObserver(() => setCurrent(nearest()), { root: sEl, threshold: [0, 0.25, 0.5, 0.75, 1] });
      sEl.querySelectorAll('.rls-slide').forEach((s) => io.observe(s));
      setCurrent(nearest());
    }

    function render(items) {
      stopAll();
      reels.clear();
      list = items;
      current = null;
      sEl.scrollTop = 0;
      sEl.innerHTML = items.length ? items.map(slideHtml).join('')
        : `<div class="rls-empty">${filter === 'all' ? 'No reels yet. They appear when a checked analysis finds a moment worth one.' : 'Nothing in this filter yet.'}</div>`;
      watchScroll();
      paintSide();
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
      live = r.live || [];
      render(listOf(r));
    }
    // Same reels: badges, actions, reactions and the side lists update in place, so the card on screen stays put.
    async function refresh() {
      if (!opts.loggedIn() || !reels.size) return;
      const r = await api('highlight_feed', { filter: filter === 'trending' ? 'all' : filter });
      if (!r.ok) return;
      const items = listOf(r);
      live = r.live || [];
      if (!(items.length === reels.size && items.every((h) => reels.has(h.id)))) { const keep = sEl.scrollTop; render(items); sEl.scrollTop = keep; return; }
      list = items;
      for (const h of items) {
        const s = sEl.querySelector(`[data-id="${CSS.escape(h.id)}"]`);
        if (!s) continue;
        s.querySelector('[data-badge]').innerHTML = badgeHtml(h);
        s.querySelector('[data-action]').innerHTML = actionHtml(h);
        s.querySelector('[data-rcount]').textContent = h.reacts || 0;
        s.querySelector('[data-react]').classList.toggle('on', !!h.mine);
      }
      paintSide();
    }

    sEl.addEventListener('click', async (e) => {
      const open = e.target.closest('[data-open]'), watch = e.target.closest('[data-watch]');
      if (open) return opts.open(open.dataset.open);
      if (watch) return opts.watch(watch.dataset.watch);
      const s = e.target.closest('[data-id]');
      if (!s) return;
      const id = s.dataset.id, r = reels.get(id);
      if (!r) return;
      if (e.target.closest('[data-boardbox], [data-board]')) { timers.has(id) ? pause(id) : play(id); return; }
      if (e.target.closest('[data-up]')) return s.previousElementSibling && s.previousElementSibling.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (e.target.closest('[data-down]')) return s.nextElementSibling && s.nextElementSibling.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (e.target.closest('[data-flip]')) { r.flip = !r.flip; return paintCard(id); }
      if (e.target.closest('[data-save]')) {
        const arr = saved(), on = arr.includes(id);
        setSaved(on ? arr.filter((x) => x !== id) : [...arr, id]);
        return e.target.closest('[data-save]').classList.toggle('on', !on);
      }
      if (e.target.closest('[data-share]')) {
        const text = `${r.h.headline} ${r.h.w.name} vs ${r.h.b.name}`;
        try { await navigator.clipboard.writeText(text); } catch (err) { /* no clipboard here: nothing to do */ }
        return;
      }
      if (e.target.closest('[data-react]')) {
        const mine = !r.h.mine;
        const d = await api('highlight_react', { id, on: mine });
        if (!d.ok) return;
        r.h.mine = d.mine; r.h.reacts = d.count;
        s.querySelector('[data-react]').classList.toggle('on', d.mine);
        s.querySelector('[data-rcount]').textContent = d.count;
        return;
      }
    });
    // the right panel: jump to a reel
    el.querySelector('.rls-right').addEventListener('click', (e) => {
      const b = e.target.closest('[data-goto]');
      if (!b) return;
      const s = sEl.querySelector(`[data-id="${CSS.escape(b.dataset.goto)}"]`);
      if (s) s.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    el.addEventListener('click', (e) => {
      const w = e.target.closest('[data-watch]');
      if (w && !sEl.contains(w)) opts.watch(w.dataset.watch);
    });
    fEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      load();
    });

    return {
      // the page was opened: its reels load fresh, and stay current while it is open
      enter() { load(); if (!timer) timer = setInterval(refresh, REFRESH_MS); },
      // the page was left: stop everything that runs in the background
      leave() { stopAll(); clearInterval(timer); timer = null; },
    };
  }

  root.HighlightReels = { init, replay, LABEL, FILTERS };
})(typeof self !== 'undefined' ? self : this);
