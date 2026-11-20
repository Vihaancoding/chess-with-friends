// Puzzle trainer: authentic Lichess puzzles from the server's local index, chosen by theme, difficulty, an AI search, your weak
// spots or a mix. The server holds every solution (it only reveals it once you have solved the puzzle or asked to see it) and checks
// each move; this file is the board, the controls and the review. Loaded the first time someone opens "Puzzles".
// Uses the page's globals: $, api, esc, setHTML, setText, show, view, stopLobby, stopGame, stopAdmin, Chess, pieceHTML, loadScript.
(function () {
  const Z = window.Puzzles = {
    meta: null, stats: null, mode: 'ai', ai: null, aiBusy: false, countTimer: null, countSeq: 0, showAll: false,
    sel: { band: 'intermediate', min: 1000, max: 1500, themes: [], match: 'all', relative: '', adaptive: false },
    epoch: 0, mixRel: 'same', session: { solved: 0, tried: 0, streak: 0, ids: [] }, run: null, P: null,
  };
  const BANDS = [['beginner', 'Beginner', '< 1000'], ['intermediate', 'Intermediate', '1000–1500'], ['advanced', 'Advanced', '1500–2000'], ['expert', 'Expert', '2000–2300'], ['master', 'Master', '2300+'], ['custom', 'Custom', 'your range']];
  const EXAMPLES = ['Difficult knight forks', 'Rook endgames under 1500', 'Checkmate in several moves', 'Defensive tactics', 'Sacrifices to win material', 'Zwischenzug puzzles'];
  const el = () => $('#puzzles');
  const SIDE = { w: 'White', b: 'Black' };
  const pct = (x) => (x == null ? '–' : Math.round(100 * x) + '%');
  const secs = (ms) => (ms == null ? '–' : ms >= 60000 ? Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's');
  const uciOf = (m) => Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- entering
  Z.enter = async function (opts = {}) {
    stopLobby(); stopGame(); stopAdmin(); if (typeof stopTour === 'function') stopTour(); if (window.Lounge) Lounge.stop();
    view = 'puzzles'; gameCode = null; history.replaceState(null, '', '/?puzzles'); show('puzzles');
    document.title = 'Puzzles · Chess';
    if (!$('#pzHome')) {
      el().innerHTML = '<div id="pzHome"><div class="pzempty muted">Loading the puzzle trainer…</div></div><div id="pzPlay" class="hidden"></div>';
    }
    $('#pzPlay').classList.add('hidden'); $('#pzHome').classList.remove('hidden');
    Z.run = null; Z.P = null;
    if (!Z.meta) {
      const m = await api('puzzle_meta');
      if (view !== 'puzzles') return;
      if (!m.ok) { $('#pzHome').innerHTML = `<div class="pzempty"><b>The puzzle trainer is not available.</b><div class="muted">${esc(m.error || 'Check your connection and try again.')}</div></div>`; return; }
      Z.meta = m;
    }
    Z.buildHome();
    Z.loadStats();
    if (opts.mode) Z.setMode(opts.mode);
  };
  Z.loadStats = async function () {
    const s = await api('puzzle_stats');
    if (view !== 'puzzles' || !s.ok) return;
    Z.stats = s; Z.paintStats(); if (Z.mode === 'weakness') Z.paintMode();
  };

  // ---------------------------------------------------------------- home
  Z.buildHome = function () {
    const m = Z.meta;
    $('#pzHome').innerHTML = `
      <header class="pzhead"><div class="pzkicker">Puzzle trainer</div><h1>Train exactly what you want.</h1>
        <p>${m.total.toLocaleString()} authentic puzzles from Lichess, filtered by theme and difficulty, with your progress tracked.</p></header>
      <div class="pzgrid">
        <div class="pzmain">
          <section class="pzask" aria-label="Describe what to practise">
            <form id="pzAskForm" autocomplete="off">
              <label for="pzAsk" class="pzlabel">Describe what you want to practise</label>
              <div class="pzaskrow"><input id="pzAsk" maxlength="300" placeholder="For example: difficult knight forks" aria-describedby="pzAskNote"><button class="primary" type="submit" id="pzAskGo">Find puzzles</button></div>
              <div class="pzchips" role="list">${EXAMPLES.map((e) => `<button type="button" class="pzchip" data-pzex="${esc(e)}">${esc(e)}</button>`).join('')}</div>
              <div id="pzAskNote" class="pznote">${m.ai ? 'Your words are turned into Lichess themes and a difficulty range by AI; the puzzles themselves always come from the Lichess database.' : 'Your words are matched to Lichess themes and a difficulty range. The puzzles always come from the Lichess database.'}</div>
            </form>
            <div id="pzAskRes" aria-live="polite"></div>
          </section>
          <section class="pzmodes" aria-label="Training mode">
            <div class="pztabs" role="tablist">${[['custom', 'Custom'], ['weakness', 'Weakness'], ['mixed', 'Mixed']].map(([id, l]) => `<button role="tab" data-pzmode="${id}" aria-selected="false">${l}</button>`).join('')}</div>
            <div id="pzModeBody"></div>
          </section>
        </div>
        <aside class="pzside" id="pzStats" aria-label="Your training"></aside>
      </div>
      <footer class="pzcredit">Puzzles from the <a href="https://database.lichess.org/#puzzles" target="_blank" rel="noopener">Lichess puzzle database</a> (CC0). Solutions are checked by the server; analysis uses Stockfish in your browser.</footer>`;
    Z.setMode(Z.mode === 'ai' ? 'custom' : Z.mode);
    Z.paintStats();
  };
  Z.setMode = function (mode) {
    Z.mode = mode;
    document.querySelectorAll('#pzHome [data-pzmode]').forEach((b) => { const on = b.dataset.pzmode === mode; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    Z.paintMode();
  };
  const chip = (id, label, on, extra = '') => `<button type="button" class="pzth${on ? ' on' : ''}" data-pzth="${id}" aria-pressed="${on}" ${extra}>${esc(label)}</button>`;
  Z.paintMode = function () {
    const box = $('#pzModeBody'); if (!box) return;
    const S = Z.sel, m = Z.meta;
    if (Z.mode === 'custom') {
      const groups = {}; for (const t of m.themes) (groups[t.group] = groups[t.group] || []).push(t);
      const pop = m.popular.map((id) => m.themes.find((t) => t.id === id));
      box.innerHTML = `
        <div class="pzblock"><div class="pzlabel">Difficulty</div>
          <div class="pzseg" role="radiogroup" aria-label="Difficulty">${BANDS.map(([id, l, r]) => `<button type="button" role="radio" aria-checked="${S.band === id}" class="${S.band === id ? 'on' : ''}" data-pzband="${id}"><b>${l}</b><small>${r}</small></button>`).join('')}</div>
          <div class="pzrange ${S.band === 'custom' ? '' : 'hidden'}" id="pzRange"><label>From <input id="pzMin" type="number" min="400" max="3500" step="50" value="${S.min}"></label><label>to <input id="pzMax" type="number" min="400" max="3500" step="50" value="${S.max}"></label><span class="muted">puzzle rating</span></div>
          <div class="pzrel"><label class="pzcheck"><input type="checkbox" id="pzRel" ${S.relative ? 'checked' : ''}> Relative to my rating (${Z.meta.rating})</label>
            <span class="pzseg small ${S.relative ? '' : 'hidden'}" id="pzRelSeg" role="radiogroup" aria-label="Relative difficulty">${[['easier', 'Easier'], ['same', 'Similar'], ['harder', 'Harder']].map(([id, l]) => `<button type="button" role="radio" aria-checked="${S.relative === id}" class="${S.relative === id ? 'on' : ''}" data-pzrel="${id}">${l}</button>`).join('')}</span></div>
        </div>
        <div class="pzblock"><div class="pzlabel">Themes <span class="pzhint">Pick any number. ${S.themes.length ? `<button type="button" class="pzlink" data-pzclear>Clear</button>` : ''}</span></div>
          <div class="pzths" id="pzThs">${pop.map((t) => chip(t.id, t.label, S.themes.includes(t.id), `title="${esc(t.meaning)}"`)).join('')}</div>
          <button type="button" class="pzlink" data-pzmore>${Z.showAll ? 'Fewer themes' : 'All Lichess themes'}</button>
          <div id="pzAllThs" class="${Z.showAll ? '' : 'hidden'}">${Object.entries(groups).map(([g, ts]) => `<div class="pzgroup"><div class="pzglabel">${esc(g)}</div><div class="pzths">${ts.filter((t) => !m.popular.includes(t.id)).map((t) => chip(t.id, t.label, S.themes.includes(t.id), `title="${esc(t.meaning)}"`)).join('')}</div></div>`).join('')}</div>
          <div class="pzmatch ${S.themes.length > 1 ? '' : 'hidden'}" id="pzMatch"><span class="muted">Puzzles must have</span> <span class="pzseg small" role="radiogroup" aria-label="Match"><button type="button" role="radio" aria-checked="${S.match === 'all'}" class="${S.match === 'all' ? 'on' : ''}" data-pzmatch="all">all of them</button><button type="button" role="radio" aria-checked="${S.match === 'any'}" class="${S.match === 'any' ? 'on' : ''}" data-pzmatch="any">any of them</button></span></div>
        </div>
        <div class="pzstart"><label class="pzcheck"><input type="checkbox" id="pzAdaptive" ${S.adaptive ? 'checked' : ''}> Adapt difficulty to how I'm doing <span class="muted">(optional)</span></label>
          <div class="pzgo"><span id="pzCount" class="pzcount" aria-live="polite"></span><button class="primary" id="pzStart" data-pzstart="custom">Start training</button></div></div>`;
      Z.count();
    } else if (Z.mode === 'weakness') {
      const w = (Z.stats && Z.stats.weak) || [], n = Z.stats ? Z.stats.n : 0;
      box.innerHTML = `<div class="pzblock"><div class="pzlabel">Weakness training</div>
        ${w.length ? `<p class="pzp">Built from your own results. These themes keep going wrong, so the sessions are made from them, close to your rating (${Z.meta.rating}) and adjusting as you improve.</p>
          <div class="pzweak">${w.map((x) => `<div class="pzwrow"><b>${esc(x.label)}</b><span class="pzbar"><i style="width:${Math.round(x.rate * 100)}%"></i></span><span class="muted">${pct(x.rate)} of ${x.n}</span></div>`).join('')}</div>`
          : `<p class="pzp">${n < 6 ? 'Solve a few puzzles first. Once the same theme has gone wrong a few times, it shows up here and you can train it directly.' : 'Nothing is standing out as a weakness right now. Mixed training keeps things varied.'}</p>`}
        <div class="pzgo"><span></span><button class="primary" id="pzStart" data-pzstart="weakness" ${w.length ? '' : 'disabled'}>Train my weaknesses</button></div></div>`;
    } else {
      box.innerHTML = `<div class="pzblock"><div class="pzlabel">Mixed training</div>
        <p class="pzp">A varied run of puzzles across themes, around your rating (${Z.meta.rating}) and adjusting as you go.</p>
        <div class="pzseg small" role="radiogroup" aria-label="Difficulty compared with your rating">${[['easier', 'A little easier'], ['same', 'Around my rating'], ['harder', 'A little harder']].map(([id, l]) => `<button type="button" role="radio" aria-checked="${Z.mixRel === id}" class="${Z.mixRel === id ? 'on' : ''}" data-pzmix="${id}">${l}</button>`).join('')}</div>
        <div class="pzgo"><span></span><button class="primary" id="pzStart" data-pzstart="mixed">Start training</button></div></div>`;
    }
  };
  // the filter the custom controls describe
  Z.customFilter = function () {
    const S = Z.sel, f = { themes: S.themes.slice(), match: S.match };
    if (S.relative) f.relative = S.relative;
    else if (S.band === 'custom') { f.min = S.min; f.max = S.max; } else f.band = S.band;
    return f;
  };
  Z.count = function () {
    const f = Z.mode === 'custom' ? Z.customFilter() : null; if (!f) return;
    const seq = ++Z.countSeq; clearTimeout(Z.countTimer);
    Z.countTimer = setTimeout(async () => {
      let g = f;
      if (f.relative) { const t = Z.meta.rating + ({ easier: -250, harder: 250 }[f.relative] || 0); g = { ...f, min: t - 150, max: t + 150 }; }
      const r = await api('puzzle_count', { filter: g });
      if (seq !== Z.countSeq || !$('#pzCount')) return;
      const c = $('#pzCount'), go = $('#pzStart');
      if (!r.ok) { c.textContent = ''; return; }
      if (r.count) { c.innerHTML = `<b>${r.count.toLocaleString()}</b> puzzle${r.count === 1 ? '' : 's'} match`; go.disabled = false; }
      else { c.innerHTML = `<b>No puzzles</b> match this combination.${r.relax && r.relax.length ? ` <span class="muted">Try: ${r.relax.map((x) => `<button type="button" class="pzlink" data-pzrelax='${esc(JSON.stringify(x.filter))}'>${esc(x.label)} (${x.count.toLocaleString()})</button>`).join(' · ')}</span>` : ''}`; go.disabled = true; }
    }, 160);
  };

  // ---------------------------------------------------------------- stats panel
  Z.paintStats = function () {
    const box = $('#pzStats'); if (!box) return;
    const s = Z.stats || { rating: Z.meta.rating, n: 0, solved: 0, accuracy: null, avgMs: null, rhist: [], days: [], themes: [], misses: [], weak: [], recent: {} };
    const rh = s.rhist || [];
    let spark = '';
    if (rh.length > 1) {
      const lo = Math.min(...rh.map((x) => x[1])), hi = Math.max(...rh.map((x) => x[1])), w = 240, h = 46, pad = 3, span = Math.max(40, hi - lo);
      const pts = rh.map((x, i) => `${(pad + (i / (rh.length - 1)) * (w - 2 * pad)).toFixed(1)},${(h - pad - ((x[1] - lo) / span) * (h - 2 * pad)).toFixed(1)}`).join(' ');
      spark = `<svg viewBox="0 0 ${w} ${h}" class="pzspark" role="img" aria-label="Rating over time, from ${rh[0][1]} to ${rh[rh.length - 1][1]}"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
    }
    const trend = s.recent && s.recent.rate != null && s.recent.before != null ? Math.round(100 * (s.recent.rate - s.recent.before)) : null;
    const themes = (s.themes || []).filter((t) => !['mate', 'short', 'long', 'veryLong', 'oneMove', 'advantage', 'crushing', 'middlegame', 'endgame', 'opening'].includes(t.id)).slice(0, 6);
    const days = s.days || [], maxd = Math.max(1, ...days.map((d) => d.n));
    box.innerHTML = `
      <div class="pzrating"><div class="pzlabel">Puzzle rating</div><div class="pzbig">${s.rating}</div>${spark}
        ${trend != null ? `<div class="pztrend ${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}% accuracy over your last 20 vs the 20 before</div>` : ''}</div>
      <dl class="pzfacts"><div><dt>Attempted</dt><dd>${s.n}</dd></div><div><dt>Solved</dt><dd>${s.solved}</dd></div><div><dt>Accuracy</dt><dd>${pct(s.accuracy)}</dd></div><div><dt>Avg. time</dt><dd>${secs(s.avgMs)}</dd></div></dl>
      ${days.length ? `<div class="pzdays" aria-label="Puzzles per day">${days.map((d) => `<i title="${esc(d.d)}: ${d.ok}/${d.n} solved" style="height:${Math.max(8, Math.round((d.n / maxd) * 100))}%"></i>`).join('')}</div>` : ''}
      <div class="pzlabel">By theme <span class="pzhint">weakest first</span></div>
      ${themes.length ? themes.map((t) => `<div class="pzwrow"><span class="pzwl">${esc(t.label)}</span><span class="pzbar ${t.rate < 0.5 ? 'low' : ''}"><i style="width:${Math.round(t.rate * 100)}%"></i></span><span class="muted">${pct(t.rate)}</span></div>`).join('') : '<div class="muted pzsm">Your results by theme show up here after a few puzzles.</div>'}
      <div class="pzlabel">Recent mistakes</div>
      ${s.misses && s.misses.length ? s.misses.map((m) => `<div class="pzmiss"><span>${m.themes.slice(0, 2).map((t) => esc(t.label)).join(', ') || 'Puzzle'} <span class="muted">· ${m.rating}</span></span><button class="small" data-pzretry="${esc(m.id)}">Retry</button></div>`).join('') : '<div class="muted pzsm">Nothing missed lately.</div>'}`;
  };

  // ---------------------------------------------------------------- AI search
  Z.ask = async function (text) {
    text = String(text || '').trim(); if (!text || Z.aiBusy) return;
    Z.aiBusy = true; const go = $('#pzAskGo'), res = $('#pzAskRes'); go.disabled = true; go.textContent = 'Searching…';
    res.innerHTML = '<div class="pzthink" role="status"><i></i><i></i><i></i> Reading your request</div>';
    const r = await api('puzzle_ai', { text });
    Z.aiBusy = false; go.disabled = false; go.textContent = 'Find puzzles';
    if (view !== 'puzzles' || !$('#pzAskRes')) return;
    if (!r.ok) { res.innerHTML = `<div class="pzres bad" role="alert">${esc(r.error || 'The search failed. Try again.')}</div>`; return; }
    Z.ai = r;
    const lim = (r.limits || []).map((l) => `<li>${esc(l)}</li>`).join('');
    if (r.empty) { res.innerHTML = `<div class="pzres"><div class="pzres-h">I couldn't turn that into a Lichess filter.</div><ul class="pzlim">${lim}</ul></div>`; return; }
    res.innerHTML = `<div class="pzres">
      <div class="pzres-h">${r.src === 'ai' ? 'Understood' : 'Matched'}: <span class="pzmatchline">${(r.understood || []).map((u) => `<span class="pzpill">${esc(u)}</span>`).join('')}</span></div>
      ${lim ? `<ul class="pzlim">${lim}</ul>` : ''}
      ${r.count ? `<div class="pzgo"><span class="pzcount"><b>${r.count.toLocaleString()}</b> puzzle${r.count === 1 ? '' : 's'} match</span><span class="pzbtns"><button type="button" class="small" data-pzedit>Edit as custom</button><button class="primary" data-pzstart="ai">Start training</button></span></div>`
        : `<div class="pzres-h">No puzzles match that exactly.</div>${(r.relax || []).length ? `<div class="pzchips">${r.relax.map((x) => `<button type="button" class="pzchip" data-pzrelaxgo='${esc(JSON.stringify(x.filter))}'>${esc(x.label)} · ${x.count.toLocaleString()}</button>`).join('')}</div>` : ''}`}
    </div>`;
  };

  // ---------------------------------------------------------------- starting a run
  Z.start = async function (mode) {
    let filter = null, adaptive = false;
    if (mode === 'ai') { if (!Z.ai || Z.ai.empty) return; filter = Z.ai.filter; adaptive = false; }
    else if (mode === 'custom') { filter = Z.customFilter(); adaptive = Z.sel.adaptive; }
    else if (mode === 'mixed') filter = { relative: Z.mixRel };
    Z.run = { mode, filter, adaptive }; Z.session = { solved: 0, tried: 0, streak: 0, ids: [] };
    Z.buildPlay();
    await Z.next();
  };
  Z.loadFilter = function (f) {   // a looser filter from "Try:" suggestions becomes the custom setup
    const S = Z.sel; S.themes = (f.themes || []).slice(); S.match = f.match === 'any' ? 'any' : 'all'; S.relative = '';
    S.band = 'custom'; S.min = f.min || 0; S.max = f.max >= 4000 ? 3500 : f.max || 3500; S.adaptive = false;
    Z.setMode('custom');
  };

  // ---------------------------------------------------------------- the play screen
  Z.buildPlay = function () {
    $('#pzHome').classList.add('hidden'); const p = $('#pzPlay'); p.classList.remove('hidden');
    p.innerHTML = `
      <div class="pzbar-top"><button class="small" data-pzback>← Training setup</button><div class="pzsession" id="pzSession" aria-live="polite"></div></div>
      <div class="pzplay">
        <div class="pzboardcol">
          <div class="pzplayer" id="pzTop"></div>
          <div class="pzboardwrap"><div id="pzBoard" class="pzboard" role="grid" aria-label="Puzzle board"></div><div id="pzPromo" class="pzpromo hidden"></div><div id="pzFlash" class="pzflash" aria-hidden="true"></div></div>
          <div class="pzplayer" id="pzBottom"></div>
        </div>
        <div class="pzpanel">
          <section class="pzcard" id="pzPrompt" aria-live="polite"></section>
          <div class="pzbtns" id="pzBtns"></div>
          <div id="pzResult"></div>
        </div>
      </div>`;
    Z.paintSession();
  };
  Z.paintSession = function () {
    const s = Z.session, box = $('#pzSession'); if (!box) return;
    box.innerHTML = `<span><b>${s.solved}</b> solved of ${s.tried}</span>${s.streak > 1 ? `<span class="pzstreak">${s.streak} in a row</span>` : ''}${Z.run && Z.run.adaptive ? '<span class="pzpill">Adaptive</span>' : ''}`;
  };
  const startState = (P) => { let st = Chess.fromFEN(P.fen); const m = Chess.findUci(st, P.setup); return m ? Chess.apply(st, m) : st; };

  Z.next = async function () {
    const run = Z.run; if (!run) return;
    const epoch = ++Z.epoch || (Z.epoch = 1);
    Z.P = null; Z.paintLoading();
    const r = await api('puzzle_next', { mode: run.mode === 'ai' ? 'ai' : run.mode, filter: run.filter, adaptive: run.adaptive, exclude: Z.session.ids.slice(-40) });
    if (Z.epoch !== epoch || view !== 'puzzles' || !$('#pzPlay')) return;
    if (!r.ok) { $('#pzPrompt').innerHTML = `<div class="pzmsg bad">${esc(r.error || 'Could not load a puzzle.')}</div>`; $('#pzBtns').innerHTML = '<button data-pzretrynext>Try again</button>'; return; }
    if (r.empty) { Z.paintEmpty(r); return; }
    Z.begin(r.puzzle, r);
  };
  Z.paintLoading = function () {
    $('#pzPrompt').innerHTML = '<div class="pzthink" role="status"><i></i><i></i><i></i> Finding a puzzle</div>'; $('#pzBtns').innerHTML = ''; $('#pzResult').innerHTML = '';
    $('#pzBoard').classList.add('dim');
  };
  Z.paintEmpty = function (r) {
    $('#pzBoard').innerHTML = ''; $('#pzTop').innerHTML = $('#pzBottom').innerHTML = '';
    $('#pzPrompt').innerHTML = `<div class="pzmsg"><b>No puzzles match.</b><div class="muted">${esc((r.described || []).join(' · ') || 'This filter')} has nothing to show${Z.run.mode === 'weakness' ? ' yet' : ''}.</div></div>`;
    $('#pzBtns').innerHTML = (r.relax || []).map((x) => `<button type="button" data-pzrelaxgo='${esc(JSON.stringify(x.filter))}'>${esc(x.label)} · ${x.count.toLocaleString()}</button>`).join('') + '<button data-pzback>Change the setup</button>';
    $('#pzResult').innerHTML = '';
  };
  // one puzzle on the board
  Z.begin = function (pz, meta) {
    const st0 = Chess.fromFEN(pz.fen);
    const P = Z.P = { ...pz, st: st0, step: 1, sel: null, last: null, busy: true, status: 'ready', hintLevel: 0, hintSq: [], wrongSq: null, finished: false, flip: pz.side === 'b', epoch: ++Z.epoch, t0: Date.now(), meta: meta || {}, wrongs: 0, usedHelp: false, review: null };
    if (Z.session.ids[Z.session.ids.length - 1] !== pz.id) Z.session.ids.push(pz.id);
    $('#pzBoard').classList.remove('dim'); $('#pzResult').innerHTML = ''; $('#pzPromo').classList.add('hidden');
    document.title = 'Puzzles · Chess';
    Z.paintBoard(); Z.paintPlayers(); Z.paintPrompt(); Z.paintButtons();
    // the opponent's move comes first, on the board, so the position is understood
    const epoch = P.epoch;
    setTimeout(() => {
      if (Z.P !== P || P.epoch !== epoch) return;
      const m = Chess.findUci(P.st, pz.setup); if (!m) return;
      P.st = Chess.apply(P.st, m); P.last = { from: m.from, to: m.to }; P.lastBefore = P.last;
      Z.paintBoard({ animate: [m.from, m.to] }); P.busy = false; Z.paintPrompt(); Z.paintButtons();
    }, 450);
  };
  Z.paintPlayers = function () {
    const P = Z.P; if (!P) return;
    const me = P.side, opp = me === 'w' ? 'b' : 'w', dots = Array.from({ length: P.steps }, (_, i) => `<i class="${i < Math.floor((P.step - 1) / 2) ? 'done' : i === Math.floor((P.step - 1) / 2) && !P.finished ? 'now' : ''}${P.finished && P.status !== 'failed' ? ' done' : ''}"></i>`).join('');
    $('#pzTop').innerHTML = `<span class="pzpc ${opp}"></span><span>${SIDE[opp]}</span><span class="muted">opponent</span>`;
    $('#pzBottom').innerHTML = `<span class="pzpc ${me}"></span><span>${SIDE[me]}</span><span class="muted">you</span><span class="pzdots" aria-label="Your moves: ${Math.floor((P.step - 1) / 2)} of ${P.steps} played">${dots}</span>`;
  };
  Z.paintPrompt = function () {
    const P = Z.P, box = $('#pzPrompt'); if (!P || !box) return;
    const n = Math.floor((P.step - 1) / 2) + 1;
    let h;
    if (P.status === 'solved') h = `<div class="pzmsg good"><b>${P.clean ? 'Solved' : 'Completed'}.</b> ${P.clean ? 'Clean, no mistakes or hints.' : 'Done, though it will not count as a clean solve.'}</div>`;
    else if (P.status === 'failed') h = '<div class="pzmsg bad"><b>Solution shown.</b> This one counts as missed. Study it, then retry it any time.</div>';
    else if (P.status === 'wrong') h = '<div class="pzmsg bad"><b>Not that one.</b> Try something else, or use a hint.</div>';
    else if (P.status === 'right') h = '<div class="pzmsg good"><b>Correct.</b> Keep going.</div>';
    else h = `<div class="pzmsg"><b>Your move.</b> <span class="muted">${P.steps > 1 ? `Find the best continuation (move ${n} of ${P.steps}).` : 'Find the best move.'}</span></div>`;
    box.innerHTML = `<div class="pzprompt-top"><span class="pzpc ${P.side}"></span><span class="pzwho">${SIDE[P.side]} to play</span>${P.meta.target ? '<span class="pzpill">Adaptive</span>' : ''}</div>${h}${P.meta.described && P.meta.described.length ? `<div class="pzfilterline">${P.meta.described.slice(0, 3).map((x) => `<span class="pzpill">${esc(x)}</span>`).join('')}</div>` : ''}${P.meta.weak && P.meta.weak.length ? `<div class="pznote">Weakness training: ${P.meta.weak.map((w) => esc(w.label) + ' ' + pct(w.rate)).join(', ')}</div>` : ''}`;
  };
  Z.paintButtons = function () {
    const P = Z.P, box = $('#pzBtns'); if (!P || !box) return;
    const dis = P.busy ? 'disabled' : '';
    if (P.finished) box.innerHTML = '<button class="primary" data-pznext>Next puzzle</button><button data-pzreset>Retry this puzzle</button>';
    else box.innerHTML = `<button data-pzhint ${dis}>${P.hintLevel >= 1 ? 'Show the move' : 'Hint'}</button><button data-pzreset ${dis}>Restart</button><button data-pzsol ${dis}>Show solution</button><button data-pzskip ${dis}>Skip</button>`;
  };

  // ---------------------------------------------------------------- the board
  Z.paintBoard = function (opts = {}) {
    const P = Z.P, bd = $('#pzBoard'); if (!P || !bd) return;
    const st = P.st, targets = new Map((P.sel != null ? Chess.legalMoves(st).filter((m) => m.from === P.sel) : []).map((m) => [m.to, m]));
    const checkSq = Chess.inCheck(st, st.turn) ? st.board.indexOf(st.turn + 'K') : -1, mine = (c) => c && c[0] === P.side && !P.busy && !P.finished && st.turn === P.side;
    let h = '';
    for (let i = 0; i < 64; i++) {
      const sq = P.flip ? 63 - i : i, r = sq >> 3, c = sq & 7, p = st.board[sq], t = targets.get(sq);
      let cls = 'sq ' + ((r + c) % 2 ? 'd' : 'l');
      if (P.last && (sq === P.last.from || sq === P.last.to)) cls += ' last';
      if (sq === P.sel) cls += ' sel';
      if (t) cls += ' hint' + (p || t.enPassant ? ' cap' : '');
      if (sq === checkSq) cls += ' check';
      if (P.hintSq.includes(sq)) cls += ' pzhintsq';
      if (P.wrongSq === sq) cls += ' pzwrong';
      if (mine(p)) cls += ' mine';
      h += `<div class="${cls}" data-sq="${sq}" role="gridcell" aria-label="${esc(Chess.sqName(sq))}${p ? ' ' + (p[0] === 'w' ? 'white ' : 'black ') + ({ K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' })[p[1]] : ''}">${p ? pieceHTML(p) : ''}${i % 8 === 0 ? `<span class="coord r">${8 - (P.flip ? 7 - (i >> 3) : i >> 3)}</span>` : ''}${i >= 56 ? `<span class="coord f">${'abcdefgh'[P.flip ? 7 - (i & 7) : i & 7]}</span>` : ''}</div>`;
    }
    bd.innerHTML = h;
    if (opts.animate) Z.slide(opts.animate[0], opts.animate[1]);
  };
  // the piece that just moved glides from where it was
  Z.slide = function (from, to) {
    const P = Z.P, bd = $('#pzBoard'); if (!P) return;
    const a = bd.querySelector(`[data-sq="${from}"]`), b = bd.querySelector(`[data-sq="${to}"]`), pc = b && b.querySelector('img.piece, .glyph');
    if (!a || !pc) return;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    pc.style.transition = 'none'; pc.style.transform = `translate(${ra.left - rb.left}px, ${ra.top - rb.top}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => { pc.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)'; pc.style.transform = ''; }));
  };
  const flash = (text, good) => { const f = $('#pzFlash'); if (!f) return; f.textContent = text; f.className = 'pzflash show ' + (good ? 'good' : 'bad'); clearTimeout(Z.flashT); Z.flashT = setTimeout(() => { f.className = 'pzflash'; }, 900); };

  // input: click a piece then a square, or drag
  let drag = null;
  const sqOf = (x, y) => { const n = document.elementFromPoint(x, y), q = n && n.closest ? n.closest('#pzBoard .sq') : null; return q ? +q.dataset.sq : -1; };
  document.addEventListener('pointerdown', (e) => {
    if (view !== 'puzzles' || e.button > 0) return;
    const q = e.target.closest && e.target.closest('#pzBoard .sq'); if (!q) return;
    const P = Z.P; if (!P || P.busy || P.finished || P.st.turn !== P.side) return;
    const sq = +q.dataset.sq, c = P.st.board[sq];
    if (c && c[0] === P.side) { P.sel = sq; Z.paintBoard(); drag = { from: sq, x: e.clientX, y: e.clientY, on: false, c }; }
    else if (P.sel != null) { const from = P.sel; Z.tryMove(from, sq); }
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.on) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 7) return; drag.on = true; const g = document.createElement('div'); g.className = 'pzghost'; g.innerHTML = pieceHTML(drag.c); document.body.appendChild(g); drag.g = g; const s = document.querySelector(`#pzBoard [data-sq="${drag.from}"] .piece`); if (s) s.style.opacity = '.3'; }
    drag.g.style.left = e.clientX + 'px'; drag.g.style.top = e.clientY + 'px';
  });
  const endDrag = (e) => {
    const d = drag; drag = null; if (!d) return;
    if (!d.on) return;
    d.g.remove(); const P = Z.P; if (!P) return;
    const to = sqOf(e.clientX, e.clientY);
    if (to >= 0 && to !== d.from) Z.tryMove(d.from, to, true); else Z.paintBoard();
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', () => { if (drag && drag.g) drag.g.remove(); drag = null; if (Z.P) Z.paintBoard(); });

  Z.tryMove = function (from, to, dropped) {
    const P = Z.P; if (!P || P.busy || P.finished) return;
    const ms = Chess.legalMoves(P.st).filter((m) => m.from === from && m.to === to);
    if (!ms.length) {   // not a legal move: keep the selection if it was a click on another of my pieces
      const c = P.st.board[to]; P.sel = c && c[0] === P.side && !dropped ? to : null; Z.paintBoard(); return;
    }
    if (ms.length > 1) { Z.askPromotion(ms, dropped); return; }
    Z.submit(ms[0]);
  };
  Z.askPromotion = function (ms, dropped) {
    const P = Z.P, box = $('#pzPromo'); P.busy = true;
    box.innerHTML = `<div class="pzpromo-in" role="dialog" aria-label="Promote to"><div class="pzlabel">Promote to</div>${['Q', 'R', 'B', 'N'].map((k) => `<button data-pzpromo="${k}" aria-label="${({ Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight' })[k]}">${pieceHTML(P.side + k)}</button>`).join('')}<button class="small" data-pzpromo="">Cancel</button></div>`;
    box.classList.remove('hidden'); box._ms = ms;
  };
  Z.submit = async function (m) {
    const P = Z.P; if (!P) return;
    const epoch = P.epoch, step = P.step, prev = P.st, uci = uciOf(m);
    P.busy = true; P.sel = null; P.hintSq = []; P.wrongSq = null;
    P.st = Chess.apply(prev, m); P.last = { from: m.from, to: m.to };
    Z.paintBoard({ animate: [m.from, m.to] }); Z.paintButtons();
    const r = await api('puzzle_move', { id: P.id, step, move: uci });
    if (Z.P !== P || P.epoch !== epoch) return;                       // restarted or moved on while waiting
    if (!r.ok) { P.st = prev; P.last = null; P.busy = false; P.status = 'ready'; Z.paintBoard(); Z.paintPrompt(); setText($('#pzPrompt .pzmsg') || document.createElement('div'), ''); $('#pzPrompt').insertAdjacentHTML('beforeend', `<div class="pzmsg bad" role="alert">${esc(r.error || 'The move could not be checked. Try again.')}</div>`); Z.paintButtons(); return; }
    if (!r.correct) {                                                  // put the position back exactly as it was
      P.wrongs++; P.st = prev; P.last = P.lastBefore || null; P.status = 'wrong'; P.wrongSq = m.to; P.busy = false;
      if (r.counted) { Z.session.tried++; Z.session.streak = 0; Z.paintSession(); }
      Z.paintBoard(); flash('✗', false); Z.paintPrompt(); Z.paintButtons(); setTimeout(() => { if (Z.P === P && P.wrongSq === m.to) { P.wrongSq = null; Z.paintBoard(); } }, 700);
      return;
    }
    if (r.done) return Z.solved(r, P);
    P.status = 'right'; P.step = r.next; flash('✓', true); Z.paintPrompt(); Z.paintPlayers();
    await sleep(380);
    if (Z.P !== P || P.epoch !== epoch) return;
    const rm = Chess.findUci(P.st, r.reply); if (!rm) { P.busy = false; Z.paintButtons(); return; }
    P.st = Chess.apply(P.st, rm); P.last = { from: rm.from, to: rm.to }; P.lastBefore = P.last; P.hintLevel = 0;
    Z.paintBoard({ animate: [rm.from, rm.to] }); P.busy = false; Z.paintButtons();
  };
  Z.solved = function (r, P) {
    P.finished = true; P.busy = false; P.status = 'solved'; P.clean = !!r.clean; P.step = P.steps * 2 + 1; P.sel = null; P.hintSq = [];
    if (r.counted) { Z.session.tried++; if (r.clean) { Z.session.solved++; Z.session.streak++; } else Z.session.streak = 0; }
    Z.paintSession(); Z.paintBoard(); flash('✓', true); Z.paintPrompt(); Z.paintPlayers(); Z.paintButtons();
    Z.showResult({ solved: true, clean: r.clean, counted: r.counted, delta: r.delta, rating: r.rating, puzzleRating: r.puzzleRating, themes: r.themes });
    if (Z.meta) Z.meta.rating = r.rating;
    Z.review(P);
  };

  // ---------------------------------------------------------------- buttons
  Z.hint = async function () {
    const P = Z.P; if (!P || P.busy || P.finished) return;
    const r = await api('puzzle_hint', { id: P.id, step: P.step, level: P.hintLevel >= 1 ? 2 : 1 });
    if (!r.ok || Z.P !== P) return;
    const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
    P.hintLevel = r.level; P.usedHelp = true; P.hintSq = [sq(r.hint.from)].concat(r.hint.to ? [sq(r.hint.to)] : []);
    Z.paintBoard(); Z.paintButtons();
    const msg = r.level === 1 ? `Look at the ${r.hint.piece}.` : `Move the ${r.hint.piece} to ${r.hint.to}.`;
    $('#pzPrompt').insertAdjacentHTML('beforeend', `<div class="pzmsg"><b>Hint.</b> ${esc(msg)} <span class="muted">This puzzle will not count as a clean solve.</span></div>`);
  };
  Z.reset = function () {
    const P = Z.P; if (!P) return;
    const epoch = ++Z.epoch;                                           // answers still on their way are ignored
    P.epoch = epoch; P.st = startState(P); P.step = 1; P.sel = null; P.hintSq = []; P.wrongSq = null; P.hintLevel = 0; P.busy = false; P.finished = false; P.status = 'ready';
    const m = Chess.findUci(Chess.fromFEN(P.fen), P.setup); P.last = m ? { from: m.from, to: m.to } : null;
    $('#pzPromo').classList.add('hidden'); $('#pzResult').innerHTML = '';
    Z.paintBoard(); Z.paintPlayers(); Z.paintPrompt(); Z.paintButtons();
  };
  Z.solution = async function () {
    const P = Z.P; if (!P || P.busy || P.finished) return;
    P.busy = true; Z.paintButtons();
    const r = await api('puzzle_solution', { id: P.id });
    if (Z.P !== P) return;
    if (!r.ok) { P.busy = false; Z.paintButtons(); return; }
    if (r.counted) { Z.session.tried++; Z.session.streak = 0; Z.paintSession(); }
    P.status = 'failed'; P.finished = true; P.review = r.facts; Z.paintPrompt(); Z.paintButtons();
    Z.showResult({ solved: false, counted: r.counted, delta: r.delta, rating: r.rating, themes: r.facts.themes });
    if (Z.meta) Z.meta.rating = r.rating;
    // play the line out on the board from the start
    const epoch = ++Z.epoch; P.epoch = epoch;
    P.st = startState(P); P.step = 1; P.hintSq = []; P.sel = null; Z.paintBoard();
    for (const mv of r.facts.line.slice(1)) {
      await sleep(750); if (Z.P !== P || P.epoch !== epoch) return;
      const m = Chess.findUci(P.st, mv.uci); if (!m) break;
      P.st = Chess.apply(P.st, m); P.last = { from: m.from, to: m.to }; Z.paintBoard({ animate: [m.from, m.to] });
    }
    P.finished = true; Z.review(P, r.facts);
  };

  // ---------------------------------------------------------------- the result and the review
  Z.showResult = function (o) {
    const d = o.delta || 0, themes = (o.themes || []).filter((t) => t && t.label);
    $('#pzResult').innerHTML = `<section class="pzcard pzresult">
      <div class="pzrow"><div><div class="pzlabel">${o.solved ? (o.clean ? 'Solved' : 'Completed') : 'Missed'}</div><div class="pzdelta ${d >= 0 ? 'up' : 'down'}">${o.counted ? (d >= 0 ? '+' : '−') + Math.abs(d) : 'not counted again'}</div></div>
        <div><div class="pzlabel">Your rating</div><div class="pzmid">${o.rating != null ? o.rating : ''}</div></div>
        ${o.puzzleRating ? `<div><div class="pzlabel">Puzzle rating</div><div class="pzmid">${o.puzzleRating}</div></div>` : ''}</div>
      ${themes.length ? `<div class="pzths pzthemes">${themes.map((t) => `<span class="pzpill" title="">${esc(t.label)}</span>`).join('')}</div>` : ''}
      <div id="pzReview"></div></section>`;
  };
  Z.review = async function (P, facts) {
    const box = () => ($('#pzReview') && Z.P === P ? $('#pzReview') : null);
    if (!facts) { const r = await api('puzzle_review', { id: P.id }); if (!r.ok || !box()) return; facts = r.facts; }
    P.review = facts;
    const f = facts, you = f.solution;
    const mat = f.material, notes = [];
    if (f.mate) notes.push(`The line ends in checkmate${f.mateIn ? ` after your move ${f.mateIn}` : ''}.`);
    else if (mat.net > 0) notes.push(`You finish ${mat.net} point${mat.net > 1 ? 's' : ''} of material ahead (pawn 1, minor piece 3, rook 5, queen 9).`);
    if (mat.sacrifice) notes.push(`You give up material on the way: ${-mat.low} point${-mat.low > 1 ? 's' : ''} down at the lowest.`);
    if (f.promotion) notes.push(`A pawn promotes to a ${f.promotion}.`);
    if (f.captures.length) notes.push(`Captures in the line: ${f.captures.map((c) => `${c.by === 'you' ? 'you' : 'they'} take a ${c.piece} (${c.san})`).join(', ')}.`);
    const lineHtml = f.line.slice(1).map((x, i) => `<span class="${x.by === 'you' ? 'you' : 'opp'}">${esc(x.san)}</span>`).join(' ');
    box().innerHTML = `
      <div class="pzsect"><div class="pzsect-h"><span>The solution</span><span class="pzchipv">verified</span></div>
        <div class="pzline">${lineHtml}</div>
        <ul class="pzfactlist">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        <div class="pzthemedefs">${f.themes.filter((t) => !/^mateIn\d$/.test(t.id) && !['short', 'long', 'veryLong', 'oneMove', 'advantage', 'crushing', 'equality', 'middlegame', 'endgame', 'opening'].includes(t.id)).slice(0, 4).map((t) => `<div><b>${esc(t.label)}</b> <span class="muted">${esc(t.meaning)}</span></div>`).join('')}</div></div>
      <div class="pzsect" id="pzEngine"><div class="pzsect-h"><span>Checked by Stockfish</span><span class="pzchipv eng">engine</span></div><div class="pzthink" role="status"><i></i><i></i><i></i> Analysing the position</div></div>
      <div class="pzsect" id="pzWords"><div class="pzsect-h"><span>The idea</span><span class="pzchipv ai" id="pzWordsSrc">…</span></div><div class="pzthink" role="status"><i></i><i></i><i></i> Writing it up</div></div>
      <div class="pzsrc">${f.opening ? esc(f.opening) + ' · ' : ''}${f.game ? `<a href="${esc(f.game)}" target="_blank" rel="noopener">The game this puzzle came from, on Lichess</a> · ` : ''}<a href="https://lichess.org/training/${esc(f.id)}" target="_blank" rel="noopener">Puzzle ${esc(f.id)} on Lichess</a></div>`;
    Z.words(P, f); Z.engine(P, f);
  };
  Z.words = async function (P, f) {
    const r = await api('puzzle_explain', { id: P.id });
    const box = $('#pzWords'); if (!box || Z.P !== P) return;
    if (!r.ok) { box.innerHTML = '<div class="pzsect-h"><span>The idea</span></div><div class="muted pzsm">The explanation could not be loaded.</div>'; return; }
    box.innerHTML = `<div class="pzsect-h"><span>The idea</span><span id="pzWordsSrc" class="pzchipv ${r.src === 'ai' ? 'ai' : ''}" title="${r.src === 'ai' ? 'Written by AI from the verified facts above; any move it names must be one from the solution' : 'Built in from the verified facts'}">${r.src === 'ai' ? 'AI, from the facts' : 'built in'}</span></div><p class="pzexplain">${esc(r.text)}</p>`;
  };

  // ----- Stockfish (in the browser, the engine the game review uses) -----
  const fmt = (s) => {
    if (s == null) return '–';
    if (Math.abs(s) >= 90000) { const n = Math.ceil((100000 - Math.abs(s) + 1) / 2); return (s > 0 ? '' : '−') + 'mate in ' + n; }
    const v = s / 100; return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  };
  const clampS = (s) => Math.max(-3000, Math.min(3000, Math.abs(s) >= 90000 ? Math.sign(s) * 3000 : s));
  Z.analyse = async function (st, ms) {
    if (!window.StockfishWorker) await loadScript('sfengine.js');
    return new Promise((resolve, reject) => {
      const w = new StockfishWorker(), id = 'pz' + Math.random().toString(36).slice(2), to = setTimeout(() => { w.terminate(); reject(new Error('timeout')); }, ms + 15000);
      let got = null;
      w.onmessage = (e) => { const d = e.data; if (d.id !== id) return; if (d.done) { clearTimeout(to); w.terminate(); got ? resolve(got) : reject(new Error('no result')); } else if (d.i === 0) got = d; };
      w.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || 'engine error')); };
      w.postMessage({ type: 'analyze', id, states: [st], hist: [], order: [0], ms, scores: true });
    });
  };
  Z.engine = async function (P, f) {
    const box = () => ($('#pzEngine') && Z.P === P ? $('#pzEngine') : null);
    try {
      const st = startState(P), me = st.turn;
      const A = await Z.analyse(st, 2200);
      if (!box()) return;
      const sol = f.line.find((x) => x.by === 'you'), scoreOf = (m) => { const x = (A.scores || []).find((y) => y.from === m.from && y.to === m.to && (y.promo || '') === (m.promo || '')); return x ? x.s : null; };
      const legal = Chess.legalMoves(st), solM = legal.find((m) => uciOf(m) === sol.uci) || Chess.findUci(st, sol.uci), solS = solM ? scoreOf(solM) : null;
      const bestM = A.best ? legal.find((m) => m.from === A.best.from && m.to === A.best.to && (m.promo || '') === (A.best.promo || '')) : null;
      const rows = [];
      if (solS != null && bestM) {
        const same = uciOf(bestM) === sol.uci, gap = A.bestScore - solS;
        rows.push(`<li>${same ? `Stockfish agrees: <b>${esc(sol.san)}</b> is its first choice (${fmt(solS)}).` : gap <= 60 || (Math.abs(solS) >= 90000 && solS > 0) ? `<b>${esc(sol.san)}</b> scores ${fmt(solS)}. Stockfish's top move, <b>${esc(Chess.notate(st, bestM))}</b> (${fmt(A.bestScore)}), is just as good.` : `<b>${esc(sol.san)}</b> scores ${fmt(solS)}; Stockfish prefers <b>${esc(Chess.notate(st, bestM))}</b> (${fmt(A.bestScore)}). The puzzle's own line is still the one Lichess accepts.`}</li>`);
      }
      // the natural-looking alternatives: captures and checks, scored by the engine
      const alts = legal.filter((m) => uciOf(m) !== sol.uci).map((m) => ({ m, s: scoreOf(m), cap: !!st.board[m.to] || m.enPassant, chk: Chess.inCheck(Chess.apply(st, m), st.turn === 'w' ? 'b' : 'w') })).filter((x) => x.s != null && (x.cap || x.chk)).sort((a, b) => b.s - a.s).slice(0, 3);
      const altRows = solS == null ? [] : alts.map((x) => { const loss = clampS(solS) - clampS(x.s); return `<li><b>${esc(Chess.notate(st, x.m))}</b> ${x.cap ? 'takes' : 'gives check'} but scores ${fmt(x.s)}. ${loss >= 100 ? `It gives up ${(loss / 100).toFixed(1)} pawns compared with the solution.` : 'It is about as good as the solution here.'}</li>`; });
      // what the opponent was threatening: the same position with them to move (not possible when you are in check)
      let threat = '';
      if (!Chess.inCheck(st, me)) {
        const flip = { ...st, turn: me === 'w' ? 'b' : 'w', ep: null }, T = await Z.analyse(flip, 1400);
        if (!box()) return;
        const tm = T.best ? Chess.legalMoves(flip).find((m) => m.from === T.best.from && m.to === T.best.to && (m.promo || '') === (T.best.promo || '')) : null;
        if (tm) {
          const s = T.bestScore, san = Chess.notate(flip, tm);
          threat = Math.abs(s) >= 90000 && s > 0 ? `If it were their move, they could force checkmate, starting with <b>${esc(san)}</b>.` : s >= 200 ? `If it were their move, <b>${esc(san)}</b> would give them a clear edge (${fmt(s)} for them). That is what you have to deal with.` : `No big threat: with the move, their best, <b>${esc(san)}</b>, is only ${fmt(s)} for them.`;
        }
      } else threat = 'You are in check, so the first thing to deal with is the check itself.';
      box().innerHTML = `<div class="pzsect-h"><span>Checked by Stockfish</span><span class="pzchipv eng" title="Stockfish ${A.depth ? 'depth ' + A.depth : ''}, running in your browser">engine · depth ${A.depth || '?'}</span></div>
        <ul class="pzfactlist">${rows.join('')}</ul>
        ${threat ? `<div class="pzmini">What the opponent was threatening</div><p class="pzp">${threat}</p>` : ''}
        ${altRows.length ? `<div class="pzmini">Tempting alternatives</div><ul class="pzfactlist">${altRows.join('')}</ul>` : ''}
        <div class="pzsm muted">Scores are from ${SIDE[me]}'s side. They come from the engine, not from AI.</div>`;
    } catch (e) {
      if (box()) box().innerHTML = '<div class="pzsect-h"><span>Checked by Stockfish</span></div><div class="muted pzsm">The engine could not run in this browser, so there is no engine check this time. The solution above is still verified.</div>';
    }
  };

  // ---------------------------------------------------------------- events
  document.addEventListener('submit', (e) => { if (e.target.id !== 'pzAskForm') return; e.preventDefault(); Z.ask($('#pzAsk').value); });
  document.addEventListener('input', (e) => {
    if (view !== 'puzzles') return;
    if (e.target.id === 'pzMin' || e.target.id === 'pzMax') { Z.sel.min = +$('#pzMin').value || 0; Z.sel.max = +$('#pzMax').value || 3500; Z.count(); }
  });
  document.addEventListener('change', (e) => {
    if (view !== 'puzzles') return;
    if (e.target.id === 'pzRel') { Z.sel.relative = e.target.checked ? 'same' : ''; Z.paintMode(); }
    if (e.target.id === 'pzAdaptive') Z.sel.adaptive = e.target.checked;
  });
  document.addEventListener('click', (e) => {
    if (view !== 'puzzles') return;
    const t = e.target, q = (s) => t.closest(s); let b;
    if ((b = q('[data-pzex]'))) { $('#pzAsk').value = b.dataset.pzex; $('#pzAsk').focus(); return Z.ask(b.dataset.pzex); }
    if ((b = q('[data-pzmode]'))) return Z.setMode(b.dataset.pzmode);
    if ((b = q('[data-pzband]'))) { Z.sel.band = b.dataset.pzband; Z.sel.relative = ''; return Z.paintMode(); }
    if ((b = q('[data-pzrel]'))) { Z.sel.relative = b.dataset.pzrel; return Z.paintMode(); }
    if ((b = q('[data-pzth]'))) { const id = b.dataset.pzth, i = Z.sel.themes.indexOf(id); if (i >= 0) Z.sel.themes.splice(i, 1); else if (Z.sel.themes.length < 6) Z.sel.themes.push(id); return Z.paintMode(); }
    if (q('[data-pzclear]')) { Z.sel.themes = []; return Z.paintMode(); }
    if (q('[data-pzmore]')) { Z.showAll = !Z.showAll; return Z.paintMode(); }
    if ((b = q('[data-pzmatch]'))) { Z.sel.match = b.dataset.pzmatch; return Z.paintMode(); }
    if ((b = q('[data-pzmix]'))) { Z.mixRel = b.dataset.pzmix; return Z.paintMode(); }
    if ((b = q('[data-pzstart]'))) { if (!b.disabled) Z.start(b.dataset.pzstart); return; }
    if (q('[data-pzedit]')) { if (Z.ai && !Z.ai.empty) Z.loadFilter(Z.ai.filter); return; }
    if ((b = q('[data-pzrelax]'))) { try { Z.loadFilter(JSON.parse(b.dataset.pzrelax)); } catch {} return; }
    if ((b = q('[data-pzrelaxgo]'))) { try { const f = JSON.parse(b.dataset.pzrelaxgo); if (Z.run) { Z.run.filter = f; Z.run.mode = 'ai'; Z.next(); } else { Z.ai = { ...(Z.ai || {}), filter: f, empty: false }; Z.start('ai'); } } catch {} return; }
    if ((b = q('[data-pzretry]'))) { return Z.retry(b.dataset.pzretry); }
    if (q('[data-pzback]')) { Z.epoch = (Z.epoch || 0) + 1; Z.P = null; Z.run = null; $('#pzPlay').classList.add('hidden'); $('#pzHome').classList.remove('hidden'); Z.loadStats(); Z.paintMode(); return; }
    if (q('[data-pznext]')) return Z.next();
    if (q('[data-pzretrynext]')) return Z.next();
    if (q('[data-pzskip]')) return Z.next();
    if (q('[data-pzhint]')) return Z.hint();
    if (q('[data-pzreset]')) return Z.reset();
    if (q('[data-pzsol]')) return Z.solution();
    if ((b = q('[data-pzpromo]'))) {
      const box = $('#pzPromo'), ms = box._ms, k = b.dataset.pzpromo; box.classList.add('hidden');
      if (!k) { if (Z.P) { Z.P.busy = false; Z.P.sel = null; Z.paintBoard(); Z.paintButtons(); } return; }
      const m = (ms || []).find((x) => x.promo === k); if (Z.P) Z.P.busy = false; if (m) Z.submit(m); return;
    }
  });
  Z.retry = async function (id) {
    const r = await api('puzzle_load', { id });
    if (!r.ok) return;
    Z.run = { mode: 'retry', filter: null, adaptive: false }; Z.session = { solved: 0, tried: 0, streak: 0, ids: [] };
    Z.buildPlay(); Z.epoch = (Z.epoch || 0) + 1; Z.begin(r.puzzle, { described: ['A puzzle you missed'] });
  };
  // the next puzzle after a retry: back to the setup instead of a filter that does not exist
  const next0 = Z.next;
  Z.next = async function () { if (Z.run && Z.run.mode === 'retry') { Z.run = null; $('#pzPlay').classList.add('hidden'); $('#pzHome').classList.remove('hidden'); Z.loadStats(); return; } return next0(); };
})();
