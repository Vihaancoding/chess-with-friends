// Rooms (lounges): private rooms for a group of friends. Loaded the first time someone opens "Rooms".
// Uses the page's globals: $, api, esc, setHTML, user, view, show, enterGame, rtSubscribe, stopLobby, stopGame, stopAdmin.
(function () {
  const L = window.Lounge = { id: null, data: null, timer: null, off: null, live: false, online: new Set(), busy: false, draft: '' };
  const TCS = [['180,0', '3 min'], ['300,0', '5 min'], ['600,0', '10 min'], ['900,10', '15 | 10'], ['0,0', 'No clock']];
  const tcVal = (v) => { const [base, inc] = v.split(',').map(Number); return base ? { base, inc } : null; };
  const el = () => $('#lounge');
  const err = (t) => { const e = $('#lgErr'); if (e) e.textContent = t || ''; };

  L.stop = function () { if (L.sg && L.sg.worker) { L.sg.worker.terminate(); } L.sg = null; clearInterval(L.timer); L.timer = null; if (L.off) { L.off(); L.off = null; } L.live = false; };

  L.enter = async function (id) {
    stopLobby(); stopGame(); stopAdmin(); if (typeof stopTour === 'function') stopTour(); L.stop();
    view = 'lounge'; gameCode = null; L.id = id || null; L.data = null;
    history.replaceState(null, '', id ? '/?lounge=' + id : '/?lounges');
    show('lounge');
    el().innerHTML = '<div class="muted" style="padding:20px">Loading…</div>';
    if (id) await L.loadRoom(); else await L.loadHome();
    L.timer = setInterval(() => { if (!document.hidden && view === 'lounge') (L.id ? L.loadRoom(true) : L.loadHome()); }, L.id ? 8000 : 15000);
    if (id && L.data && L.data.room) {
      const re = () => L.loadRoom(true);
      L.off = rtSubscribe(L.data.room.topic, { chat: (m) => L.onChat(m), tbl: re, mem: re }, (ok) => { L.live = ok; });
    }
  };

  // ---------- home: my rooms, invites, make one ----------
  L.loadHome = async function () {
    const r = await api('lounge_mine'); if (view !== 'lounge' || L.id) return;
    const list = r.ok ? r.rooms : [], inv = list.filter((x) => x.st === 'invited'), mine = list.filter((x) => x.st === 'in');
    L.badge(inv.length);
    setHTML(el(), `<div class="lgwrap"><h1 class="ptitle">Rooms</h1>
      <div class="muted" style="font-weight:600">Private rooms for you and your friends: chat, and play each other back and forth. Anyone in a room can invite people, and every game played from the room counts on its table.</div>
      ${inv.length ? `<div class="panel"><h2 class="ph">Invitations</h2>${inv.map((x) => `<div class="lgrow"><b>${esc(x.name)}</b><span class="acts"><button class="primary small" data-lg="yes" data-id="${esc(x.id)}">Join</button><button class="small" data-lg="no" data-id="${esc(x.id)}">No thanks</button></span></div>`).join('')}</div>` : ''}
      <div class="panel"><h2 class="ph">Your rooms</h2>${mine.length ? mine.map((x) => `<div class="lgrow"><span><b>${esc(x.name)}</b>${x.kind === 'study' ? ' <span class="badge">study</span>' : ''}</span><button class="small" data-lg="open" data-id="${esc(x.id)}">Open</button></div>`).join('') : '<div class="muted">You are not in any room yet. Make one and invite your friends.</div>'}</div>
      <form class="panel" id="lgNew"><h2 class="ph">Make a room</h2>
        <div class="lgkind" role="radiogroup" aria-label="Room type"><label><input type="radio" name="lgkind" value="play" checked><span><b>Play room</b><small>Chat, open tables and challenges, with a results table</small></span></label><label><input type="radio" name="lgkind" value="study"><span><b>Study room</b><small>Annotate a game together; Stockfish checks your verdicts</small></span></label></div>
        <div class="lgrow"><input id="lgName" maxlength="30" placeholder="Room name, e.g. Friday club" aria-label="Room name" style="flex:1"><button class="primary" type="submit">Create</button></div><div id="lgErr" class="muted" style="color:var(--bad,#c0392b)"></div></form></div>`);
  };

  L.badge = function (n) { const b = $('#navLounge'); if (b) b.classList.toggle('dot', n > 0); };

  // ---------- one room ----------
  L.loadRoom = async function (quiet) {
    const r = await api('lounge_get', { id: L.id });
    if (view !== 'lounge' || !L.id) return;
    if (!r.ok) { if (r.status === 403 || r.status === 404) { L.stop(); return L.enter(null); } return; }
    if (r.invite) {
      setHTML(el(), `<div class="lgwrap"><h1 class="ptitle">${esc(r.invite.name)}</h1><div class="panel"><div class="muted" style="font-weight:600">${esc(r.invite.owner)} invited you to this room (${r.invite.members} member${r.invite.members === 1 ? '' : 's'}).</div><div class="acts" style="margin-top:10px"><button class="primary" data-lg="yes" data-id="${esc(L.id)}">Join the room</button><button data-lg="no" data-id="${esc(L.id)}">No thanks</button></div></div></div>`);
      return;
    }
    const first = !L.data || !L.data.room;
    L.data = r; L.paintRoom(first);
    if (first) L.loadOnline();
  };
  L.loadOnline = async function () { const r = await api('presence'); if (r.ok) { L.online = new Set(r.on); if (L.data) L.paintRoom(false); } };

  L.paintRoom = function (full) {
    const d = L.data, rm = d.room, me = rm.me, owner = rm.owner === me, study = rm.kind === 'study';
    const keepNote = $('#stText') ? $('#stText').value : '';
    const keep = $('#lgIn') ? $('#lgIn').value : L.draft, hadFocus = document.activeElement && document.activeElement.id === 'lgIn';
    const mem = rm.members.map((n) => `<div class="lgrow"><span><span class="lgdot${L.online.has(n) ? ' on' : ''}"></span>${avImg(n, 22)}<span class="plink" data-name="${esc(n)}">${esc(n)}</span>${n === rm.owner ? ' <span class="badge gold">owner</span>' : ''}${n === me ? ' <span class="muted">(you)</span>' : ''}</span><span class="acts">${n !== me ? `<button class="small" data-lg="chal" data-n="${esc(n)}">Challenge</button>` : ''}${owner && n !== me ? `<button class="small danger" data-lg="kick" data-n="${esc(n)}" aria-label="Remove ${esc(n)}">✕</button>` : ''}</span></div>`).join('');
    const tbl = d.table.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td class="r">${x.w}</td><td class="r">${x.d}</td><td class="r">${x.l}</td><td class="r"><b>${x.pts % 1 ? (Math.floor(x.pts) || '') + '½' : x.pts}</b></td></tr>`).join('');
    const tabs = d.tables.map((t) => `<div class="lgrow"><span><b>${esc(t.by)}</b> <span class="muted">${esc(tcName(t.tc))}</span></span>${t.by === me ? '<button class="small" data-lg="sit" data-code="' + esc(t.code) + '">Go to my table</button>' : `<button class="primary small" data-lg="sit" data-code="${esc(t.code)}">Sit down</button>`}</div>`).join('');
    const chat = d.chat.map((m) => `<div class="lgmsg">${avImg(m.n, 18)}<b>${esc(m.n)}</b> ${chatBody(m.t)}</div>`).join('');
    const body = `<div class="lgwrap">
      <div class="lgtop"><button class="small" data-lg="back">← Rooms</button><h1 class="ptitle" style="margin:0">${esc(rm.name)}</h1><span class="acts"><button class="small" data-lg="link">Copy link</button>${owner ? '<button class="small danger" data-lg="del">Delete</button>' : ''}<button class="small" data-lg="leave">Leave</button></span></div>
      <div class="lggrid">
        <div class="lgcol">
          ${study ? '<div class="panel" id="lgStudyP"><h2 class="ph"><span>Study</span><button class="small" data-lg="pick">Choose a game</button></h2><div id="stPick"></div><div id="stBoardW"></div><div id="stForm"></div><div id="stList"></div><div id="stScore"></div></div>' : `<div class="panel"><h2 class="ph">Play</h2>
            <div class="lgrow"><select id="lgTc" aria-label="Time control">${TCS.map(([v, n]) => `<option value="${v}"${v === (L.tcSel || '300,0') ? ' selected' : ''}>${n}</option>`).join('')}</select><button class="primary" data-lg="table">Open a table</button></div>
            <div class="muted" style="font-size:.85rem;margin:6px 0">An open table lets anyone in this room sit down against you. Or challenge a member below.</div>
            ${tabs || '<div class="muted">No open tables right now.</div>'}</div>`}
          <div class="panel"><h2 class="ph">Members · ${rm.members.length}</h2>${mem}
            <form id="lgInv" class="lgrow" style="margin-top:8px"><input id="lgInvName" maxlength="16" placeholder="Invite by username" aria-label="Invite by username" style="flex:1"><button type="submit">Invite</button></form>
            ${rm.invited.length ? `<div class="muted" style="font-size:.85rem;margin-top:6px">Waiting for: ${rm.invited.map(esc).join(', ')}</div>` : ''}</div>
          ${study ? '' : `<div class="panel"><h2 class="ph">Table</h2>${tbl ? `<table class="lgtbl"><thead><tr><th></th><th>Player</th><th class="r">W</th><th class="r">D</th><th class="r">L</th><th class="r">Pts</th></tr></thead><tbody>${tbl}</tbody></table>` : ''}
            ${d.recent.length ? `<div class="muted" style="font-size:.85rem;margin-top:8px">Latest: ${d.recent.map((g) => `${esc(g.w)} ${g.res === 'draw' ? 'drew with' : g.res === 'w' ? 'beat' : 'lost to'} ${esc(g.b)}`).join(' · ')}</div>` : '<div class="muted" style="font-size:.85rem;margin-top:8px">Games played from this room show up here.</div>'}</div>`}
        </div>
        <div class="panel lgchat"><h2 class="ph">Chat</h2><div id="lgLog" class="lglog">${chat || '<div class="muted">Say hello.</div>'}</div>
          <form id="lgSend" class="lgrow"><input id="lgIn" maxlength="300" autocomplete="off" placeholder="Message the room" aria-label="Message" style="flex:1"><button type="button" class="small gifbtn" data-lg="gif" title="Send a GIF">GIF</button><button class="primary" type="submit">Send</button></form></div>
      </div><div id="lgErr" class="muted" style="color:var(--bad,#c0392b)"></div></div>`;
    const log = $('#lgLog'), atEnd = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const keepInv = $('#lgInvName') ? $('#lgInvName').value : '';
    setHTML(el(), body);
    const lg = $('#lgLog'); if (lg && (atEnd || full)) lg.scrollTop = lg.scrollHeight;
    if ($('#lgIn')) { $('#lgIn').value = keep; if (hadFocus) $('#lgIn').focus(); }
    if ($('#lgInvName') && keepInv) $('#lgInvName').value = keepInv;
    if (study) { L.studyInit(); L.paintStudy(true); if ($('#stText') && keepNote) $('#stText').value = keepNote; }
  };
  const tcName = (tc) => (tc ? (TCS.find(([v]) => v === tc.base + ',' + tc.inc) || [0, `${Math.round(tc.base / 60)} min${tc.inc ? ' + ' + tc.inc : ''}`])[1] : 'No clock');

  L.onChat = function (m) {
    if (!L.data || L.data.chat.some((x) => x.id === m.id)) return;
    L.data.chat.push(m); L.data.chat = L.data.chat.slice(-50); L.paintRoom(false);
  };


  // ---------- study rooms ----------
  // The game's moves are shared; every member's browser has Stockfish check the game once, then each note's mark
  // (!! ! !? ?! ? ??) is compared with the engine's rating of that move.
  const MARKS = [['!!', 'Brilliant'], ['!', 'Good'], ['!?', 'Interesting'], ['?!', 'Dubious'], ['?', 'Mistake'], ['??', 'Blunder']];
  const BUCKET = { brilliant: 'good', great: 'good', best: 'good', excellent: 'good', good: 'good', forced: 'good', inaccuracy: 'inacc', mistake: 'mistake', blunder: 'blunder' };
  const MARKB = { '!!': 'good', '!': 'good', '?!': 'inacc', '?': 'mistake', '??': 'blunder' };
  const ORDER = ['good', 'inacc', 'mistake', 'blunder'], BNAME = { good: 'a good move', inacc: 'an inaccuracy', mistake: 'a mistake', blunder: 'a blunder' };
  L.ply = 0; L.mark = '';

  L.studyInit = function () {
    const st = L.data && L.data.study; if (!st) { if (L.sg && L.sg.worker) L.sg.worker.terminate(); L.sg = null; return; }
    const key = st.game.id + ':' + st.at; if (L.sg && L.sg.key === key) return;
    if (L.sg && L.sg.worker) L.sg.worker.terminate();
    let pos = Chess.initial(); const states = [pos], san = [], hist = [];
    for (const h of st.game.hist) {
      const m = Chess.legalMoves(pos).find((x) => x.from === h.from && x.to === h.to && (x.promo || undefined) === (h.promo || undefined));
      if (!m) break; san.push(Chess.notate(pos, m)); hist.push(h); pos = Chess.apply(pos, m); states.push(pos);
    }
    const sg = L.sg = { key, states, san, hist, res: [], cls: [], worker: null, done: false };
    L.ply = Math.min(L.ply, hist.length);
    try {
      sg.worker = anaWorker();
      sg.worker.onmessage = (e) => {
        const d = e.data; if (L.sg !== sg) return;
        if (d.done) { sg.done = true; return L.paintStudy(false); }
        sg.res[d.i] = d; if (d.i < hist.length) sg.cls[d.i] = classifyMove(d, states[d.i], hist[d.i]);
        clearTimeout(sg.t); sg.t = setTimeout(() => L.paintStudy(false), 200);
      };
      sg.worker.onerror = () => { sg.failed = true; L.paintStudy(false); };
      sg.worker.postMessage({ type: 'analyze', id: 1, states, hist, ms: hist.length > 80 ? 120 : 180, order: states.map((_, i) => i) });
    } catch { sg.failed = true; }
  };
  const bestSan = (i) => { const sg = L.sg, r = sg.res[i]; if (!r || !r.best) return null; const h = sg.hist[i]; if (r.best.from === h.from && r.best.to === h.to) return null; const m = Chess.legalMoves(sg.states[i]).find((x) => x.from === r.best.from && x.to === r.best.to && (x.promo || undefined) === (r.best.promo || undefined)); return m ? Chess.notate(sg.states[i], m) : null; };
  // what the engine thinks of a member's mark: { ok, near, name, best } or null (no mark, or not analysed yet)
  const verdict = (n) => {
    const sg = L.sg, nb = MARKB[n.mark], c = sg && sg.cls[n.ply - 1]; if (!nb || !c) return null;
    const eb = BUCKET[c], d = Math.abs(ORDER.indexOf(eb) - ORDER.indexOf(nb));
    return { ok: d === 0, near: d === 1, name: BNAME[eb], best: d ? bestSan(n.ply - 1) : null };
  };
  const mvName = (ply) => { const k = Math.ceil(ply / 2); return `${k}${ply % 2 ? '.' : '...'} ${L.sg.san[ply - 1]}`; };

  L.paintStudy = function (form) {
    const box = $('#stBoardW'); if (!box) return;
    const st = L.data.study, me = L.data.room.me;
    if (!st || !L.sg) { setHTML($('#stPick'), '<div class="muted" style="font-weight:600">No game yet. Choose one from your finished games, then everyone can annotate it.</div>'); box.innerHTML = ''; $('#stForm').innerHTML = ''; $('#stList').innerHTML = ''; $('#stScore').innerHTML = ''; return; }
    const sg = L.sg, n = sg.hist.length, p = L.ply, bd = sg.states[p].board, last = p ? sg.hist[p - 1] : null;
    const notes = st.notes, at = (k) => notes.filter((x) => x.ply === k);
    const sq = bd.map((c, i) => `<div class="stsq ${((i >> 3) + (i & 7)) % 2 ? 'dk' : 'lt'}${last && (i === last.from || i === last.to) ? ' lm' : ''}">${c ? `<img src="/piece/cburnett/${c}.svg" alt="">` : ''}</div>`).join('');
    const prog = sg.done ? '' : sg.failed ? 'Stockfish is not available in this browser, so there are no engine checks.' : `Stockfish is checking the game… ${sg.res.filter(Boolean).length}/${n + 1}`;
    const chips = sg.san.map((m, i) => { const k = i + 1, c = sg.cls[i], b = c && BUCKET[c] !== 'good' ? BUCKET[c] : '', nn = at(k).length; return `${k % 2 ? `<span class="stnum">${(k + 1) >> 1}.</span>` : ''}<button class="stmv${k === p ? ' on' : ''}${b ? ' ' + b : ''}" data-lg="ply" data-p="${k}">${esc(m)}${nn ? `<sup>${nn}</sup>` : ''}</button>`; }).join('');
    setHTML($('#stPick'), `<div class="muted" style="font-weight:600;font-size:.9rem">${esc(st.game.w)} vs ${esc(st.game.b)} · ${st.game.result === 'draw' ? 'draw' : st.game.result === 'w' ? '1-0' : '0-1'} · chosen by ${esc(st.by)}${prog ? `<br><span id="stProg">${prog}</span>` : ''}</div>`);
    setHTML(box, `<div class="stboard">${sq}</div><div class="stctl"><button class="small" data-lg="ply" data-p="0" aria-label="Start">⏮</button><button class="small" data-lg="ply" data-p="${Math.max(0, p - 1)}" aria-label="Back">◀</button><span class="muted" style="font-weight:700">${p ? esc(mvName(p)) : 'Start'}</span><button class="small" data-lg="ply" data-p="${Math.min(n, p + 1)}" aria-label="Forward">▶</button><button class="small" data-lg="ply" data-p="${n}" aria-label="End">⏭</button></div><div class="stmoves">${chips}</div>`);
    if (form || L.formPly !== p) {
      L.formPly = p;
      const mine = at(p).find((x) => x.by === me); L.mark = mine ? mine.mark : '';
      setHTML($('#stForm'), p ? `<div class="stnote"><div class="label">Your note on ${esc(mvName(p))}</div><div class="stmarks">${MARKS.map(([m, t]) => `<button type="button" class="stmk${m === L.mark ? ' on' : ''}" data-lg="mark" data-m="${m}" title="${t}">${m}</button>`).join('')}</div><div class="lgrow"><input id="stText" maxlength="240" autocomplete="off" placeholder="What do you see here?" value="${esc(mine ? mine.text : '')}" style="flex:1"><button class="primary" data-lg="note">Save</button></div></div>` : '<div class="muted" style="margin-top:8px">Step to a move, then mark it (!! ! !? ?! ? ??) and say why. Stockfish checks the marks.</div>');
    }
    const list = at(p).map((x) => { const v = verdict(x); return `<div class="stn"><div><b>${esc(x.by)}</b> ${x.mark ? `<span class="stmark">${esc(x.mark)}</span>` : ''} ${esc(x.text)}${x.by === me || L.data.room.owner === me ? ` <button class="small" data-lg="ndel" data-id="${esc(x.id)}" aria-label="Remove note">✕</button>` : ''}</div>${v ? `<div class="stv ${v.ok ? 'ok' : v.near ? 'near' : 'bad'}">${v.ok ? '✓ Stockfish agrees' : (v.near ? '~ Close: ' : '✗ Stockfish disagrees: ') + 'it rates this as ' + v.name}${v.best ? `. Better was <b>${esc(v.best)}</b>` : ''}</div>` : ''}</div>`; }).join('');
    setHTML($('#stList'), p ? list || '<div class="muted" style="margin-top:6px">No notes on this move yet.</div>' : '');
    // agreement with the engine, per member (marked notes only)
    const sc = {}; for (const x of notes) { const v = verdict(x); if (!v) continue; const r = (sc[x.by] = sc[x.by] || { n: 0, pts: 0 }); r.n++; r.pts += v.ok ? 1 : v.near ? 0.5 : 0; }
    const rows = Object.entries(sc).sort((a, b) => b[1].pts / b[1].n - a[1].pts / a[1].n);
    setHTML($('#stScore'), rows.length ? `<h2 class="ph" style="margin-top:14px"><span>Agreement with Stockfish</span></h2>${rows.map(([nm, r]) => `<div class="lgrow"><span>${esc(nm)} <span class="muted">${r.n} mark${r.n === 1 ? '' : 's'}</span></span><b>${Math.round((100 * r.pts) / r.n)}%</b></div>`).join('')}` : '');
  };

  L.pickGame = async function () {
    const box = $('#stPick'); box.innerHTML = '<div class="muted">Loading your games…</div>';
    const r = await api('games', { name: L.data.room.me });
    const gs = (r.ok ? r.games : []).filter((g) => g.id).slice(0, 12);
    if (!gs.length) { box.innerHTML = '<div class="muted">You have no finished games yet. Play one first, then come back.</div>'; return; }
    box.innerHTML = '<div class="label">Pick a game to study</div>' + gs.map((g) => `<div class="lgrow"><span>You (${g.color === 'w' ? 'White' : 'Black'}) vs ${esc(g.opp)} <span class="muted">${g.result === 'win' ? 'won' : g.result === 'loss' ? 'lost' : 'drew'} · ${Math.ceil(g.moves / 2)} moves${g.op ? ' · ' + esc(g.op) : ''}</span></span><button class="small" data-lg="use" data-game="${esc(g.id)}">Use</button></div>`).join('');
  };

  document.addEventListener('keydown', (e) => {
    if (view !== 'lounge' || !L.sg || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
    if (e.key === 'ArrowLeft') { L.ply = Math.max(0, L.ply - 1); L.paintStudy(false); } else if (e.key === 'ArrowRight') { L.ply = Math.min(L.sg.hist.length, L.ply + 1); L.paintStudy(false); }
  });

  // ---------- actions ----------
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('#lgNew, #lgSend, #lgInv'); if (!f) return; e.preventDefault();
    if (f.id === 'lgNew') {
      const r = await api('lounge_create', { name: $('#lgName').value, kind: (document.querySelector('input[name=lgkind]:checked') || {}).value }); if (!r.ok) return err(r.error);
      return L.enter(r.id);
    }
    if (f.id === 'lgSend') {
      const inp = $('#lgIn'), text = inp.value.trim(); if (!text) return; inp.value = '';
      const r = await api('lounge_chat', { id: L.id, text }); if (!r.ok) { inp.value = text; return err(r.error); }
      L.onChat(r.msg); return;
    }
    if (f.id === 'lgInv') {
      const n = $('#lgInvName').value.trim(); if (!n) return;
      const r = await api('lounge_invite', { id: L.id, name: n }); if (!r.ok) return err(r.error);
      $('#lgInvName').value = ''; err(''); L.loadRoom(true);
    }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'lgTc') L.tcSel = e.target.value; });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#lounge [data-lg]'); if (!b || b.disabled) return;
    const a = b.dataset.lg, id = b.dataset.id || L.id;
    if (a === 'ply') { L.ply = +b.dataset.p; return L.paintStudy(false); }
    if (a === 'mark') { L.mark = L.mark === b.dataset.m ? '' : b.dataset.m; document.querySelectorAll('.stmk').forEach((x) => x.classList.toggle('on', x.dataset.m === L.mark)); return; }
    if (a === 'note') { const r = await api('lounge_study_note', { id: L.id, ply: L.ply, mark: L.mark, text: $('#stText').value }); return r.ok ? L.loadRoom(true) : err(r.error); }
    if (a === 'ndel') { const r = await api('lounge_study_del', { id: L.id, note: b.dataset.id }); return r.ok ? L.loadRoom(true) : err(r.error); }
    if (a === 'pick') return L.pickGame();
    if (a === 'use') { if (L.data.study && L.data.study.notes.length && !confirm('Switching the game clears the notes. Continue?')) return; const r = await api('lounge_study_pick', { id: L.id, game: b.dataset.game }); if (!r.ok) return err(r.error); L.ply = 0; L.formPly = -1; return L.loadRoom(true); }
    if (a === 'gif') return openGifPicker((u) => { $('#lgIn').value = u; $('#lgSend').requestSubmit(); });
    if (a === 'open') return L.enter(id);
    if (a === 'back') return L.enter(null);
    if (a === 'yes' || a === 'no') { const r = await api('lounge_reply', { id, accept: a === 'yes' }); if (!r.ok) return err(r.error); return a === 'yes' ? L.enter(id) : L.enter(null); }
    if (a === 'link') return typeof copy === 'function' ? copy(location.origin + '/?lounge=' + L.id, '[data-lg="link"]') : null;
    if (a === 'leave') { if (!confirm('Leave this room?')) return; const r = await api('lounge_leave', { id: L.id }); return r.ok ? L.enter(null) : err(r.error); }
    if (a === 'del') { if (!confirm('Delete this room for everyone?')) return; const r = await api('lounge_delete', { id: L.id }); return r.ok ? L.enter(null) : err(r.error); }
    if (a === 'kick') { if (!confirm(`Remove ${b.dataset.n} from the room?`)) return; const r = await api('lounge_kick', { id: L.id, name: b.dataset.n }); return r.ok ? L.loadRoom(true) : err(r.error); }
    if (a === 'table') {
      b.disabled = true; const r = await api('lounge_table', { id: L.id, tc: tcVal($('#lgTc').value) }); b.disabled = false;
      return r.ok ? enterGame(r.code, r.snap) : err(r.error);
    }
    if (a === 'sit') { b.disabled = true; const r = await api('lounge_sit', { id: L.id, code: b.dataset.code }); b.disabled = false; return r.ok ? enterGame(r.code, r.snap) : err(r.error); }
    if (a === 'chal') {
      b.disabled = true; const r = await api('challenge', { to: b.dataset.n, tc: tcVal($('#lgTc').value), lounge: L.id }); b.disabled = false;
      if (!r.ok) return err(r.error);
      curOut = { id: r.id, to: b.dataset.n, status: 'pending', ts: Date.now() }; localOut = { to: b.dataset.n, ts: Date.now(), id: r.id };   // so their answer opens the game for me
      b.textContent = 'Sent ✓'; setTimeout(() => { if (b.isConnected) b.textContent = 'Challenge'; }, 4000);
    }
  });
})();
