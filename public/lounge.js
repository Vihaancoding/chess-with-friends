// Rooms (lounges): private rooms for a group of friends. Loaded the first time someone opens "Rooms".
// Uses the page's globals: $, api, esc, setHTML, user, view, show, enterGame, rtSubscribe, stopLobby, stopGame, stopAdmin.
(function () {
  const L = window.Lounge = { id: null, data: null, timer: null, off: null, live: false, online: new Set(), busy: false, draft: '' };
  const TCS = [['180,0', '3 min'], ['300,0', '5 min'], ['600,0', '10 min'], ['900,10', '15 | 10'], ['0,0', 'No clock']];
  const tcVal = (v) => { const [base, inc] = v.split(',').map(Number); return base ? { base, inc } : null; };
  const el = () => $('#lounge');
  // errors show next to what caused them (the invite form, the chat box), else at the top of the page
  const err = (t, where) => { const e = (where && $(where)) || $('#lgErr'); document.querySelectorAll('#lounge .lgerr').forEach((x) => { if (x !== e) x.textContent = ''; }); if (e) e.textContent = t || ''; };

  L.stop = function () { clearInterval(L.timer); L.timer = null; if (L.off) { L.off(); L.off = null; } L.live = false; };
  // the newest message from someone else that I have seen, per room (for the "new messages" marks)
  const seenChat = L.seen = () => { if (!L.data || !L.data.room) return; const me = L.data.room.me, m = L.data.chat.filter((x) => x.n !== me).pop(); if (m && typeof loungeSeen === 'function') loungeSeen(L.data.room.id, m.ts); };

  L.enter = async function (id) {
    stopLobby(); stopGame(); stopAdmin(); if (typeof stopTour === 'function') stopTour(); L.stop();
    view = 'lounge'; gameCode = null; L.id = id || null; L.data = null;
    history.replaceState(null, '', id ? '/?lounge=' + id : '/?lounges');
    show('lounge');
    el().innerHTML = '<div class="muted" style="padding:20px">Loading…</div>'; el()._h = null;
    if (id) await L.loadRoom(); else await L.loadHome();
    L.timer = setInterval(() => { if (!document.hidden && view === 'lounge') (L.id ? L.loadRoom(true) : L.loadHome()); }, L.id ? 8000 : 15000);
    if (id && L.data && L.data.room) {
      const re = () => L.loadRoom(true);
      L.off = rtSubscribe(L.data.room.topic, { chat: (m) => L.onChat(m), cd: re, tbl: re, mem: re }, (ok) => { L.live = ok; });
    }
  };

  // ---------- home: my rooms, invites, make one ----------
  L.loadHome = async function () {
    const r = await api('lounge_mine'); if (view !== 'lounge' || L.id) return;
    const list = r.ok ? r.rooms : [], inv = list.filter((x) => x.st === 'invited'), mine = list.filter((x) => x.st === 'in');
    if (!r.ok) { setHTML(el(), `<div class="lgwrap"><h1 class="ptitle">Rooms</h1><div class="panel"><div class="muted" style="font-weight:600">Could not load your rooms. Check your connection.</div><div class="acts" style="margin-top:10px"><button data-lg="back">Try again</button></div></div></div>`); return; }
    if (typeof loungeNav === 'function') loungeNav(list);
    const kindB = (k) => (k === 'study' ? ' <span class="badge">study</span>' : k === 'board' ? ' <span class="badge">sandbox</span>' : '');
    const keepName = $('#lgName') ? $('#lgName').value : '', keepKind = (document.querySelector('input[name=lgkind]:checked') || {}).value || 'play', foc = document.activeElement && document.activeElement.id;
    setHTML(el(), `<div class="lgwrap"><h1 class="ptitle">Rooms</h1>
      <div class="muted" style="font-weight:600">Private rooms for you and your friends: chat, and play each other back and forth. Anyone in a room can invite people, and every game played from the room counts on its table.</div>
      ${inv.length ? `<div class="panel"><h2 class="ph">Invitations</h2>${inv.map((x) => `<div class="lgrow"><span><b>${esc(x.name)}</b>${kindB(x.kind)}${x.by ? ` <span class="muted">from ${esc(x.by)}</span>` : ''}</span><span class="acts"><button class="primary small" data-lg="yes" data-id="${esc(x.id)}">Join</button><button class="small" data-lg="no" data-id="${esc(x.id)}">No thanks</button></span></div>`).join('')}</div>` : ''}
      <div class="panel"><h2 class="ph">Your rooms</h2>${mine.length ? mine.map((x) => `<div class="lgrow"><span><b>${esc(x.name)}</b>${kindB(x.kind)}${loungeUnread(x) ? ' <span class="badge lgnew">new messages</span>' : ''}</span><button class="small" data-lg="open" data-id="${esc(x.id)}">Open</button></div>`).join('') : '<div class="muted">You are not in any room yet. Make one and invite your friends.</div>'}</div>
      <form class="panel" id="lgNew"><h2 class="ph">Make a room</h2>
        <div class="lgkind" role="radiogroup" aria-label="Room type"><label><input type="radio" name="lgkind" value="play" checked><span><b>Play room</b><small>Chat, open tables and challenges, with a results table</small></span></label><label><input type="radio" name="lgkind" value="board"><span><b>Sandbox room</b><small>One shared blank board: place any pieces anywhere, play from it, and leave notes</small></span></label><label><input type="radio" name="lgkind" value="study"><span><b>Study room</b><small>Annotate a game together; Stockfish checks your verdicts</small></span></label></div>
        <div class="lgrow"><input id="lgName" maxlength="30" placeholder="Room name, e.g. Friday club" aria-label="Room name" style="flex:1"><button class="primary" type="submit">Create</button></div><div id="lgErr" class="muted lgerr" role="alert"></div></form></div>`);
    // the 15-second refresh must not wipe a half-typed name or the chosen type
    if ($('#lgName')) { $('#lgName').value = keepName; const k = document.querySelector(`input[name=lgkind][value="${keepKind}"]`); if (k) k.checked = true; if (foc === 'lgName') $('#lgName').focus(); }
  };

  // ---------- one room ----------
  L.loadRoom = async function (quiet) {
    const r = await api('lounge_get', { id: L.id });
    if (view !== 'lounge' || !L.id) return;
    if (!r.ok) { if (r.status === 403 || r.status === 404) { L.stop(); return L.enter(null); } return; }
    if (r.invite) {
      const iv = r.invite, kn = iv.kind === 'study' ? 'study room' : iv.kind === 'board' ? 'sandbox room' : 'room';
      setHTML(el(), `<div class="lgwrap"><div class="lgtop"><button class="small" data-lg="back">← Rooms</button><h1 class="ptitle" style="margin:0">${esc(iv.name)}</h1></div><div class="panel"><div class="muted" style="font-weight:600">${esc(iv.by || iv.owner)} invited you to this ${kn} (${iv.members} member${iv.members === 1 ? '' : 's'}${iv.by && iv.by !== iv.owner ? ', owner ' + esc(iv.owner) : ''}).</div><div class="acts" style="margin-top:10px"><button class="primary" data-lg="yes" data-id="${esc(L.id)}">Join the room</button><button data-lg="no" data-id="${esc(L.id)}">No thanks</button></div><div id="lgErr" class="muted lgerr" role="alert"></div></div></div>`);
      return;
    }
    const first = !L.data || !L.data.room;
    L.data = r; L.paintRoom(first); seenChat();
    if (first || (L.tick = (L.tick || 0) + 1) % 3 === 0) L.loadOnline();   // the online dots refresh every few polls
  };
  L.loadOnline = async function () { const r = await api('presence'); if (r.ok) { L.online = new Set(r.on); if (L.data) L.paintRoom(false); } };

  L.paintRoom = function (full) {
    const d = L.data, rm = d.room, me = rm.me, owner = rm.owner === me, study = rm.kind === 'study', board = rm.kind === 'board', play = !study && !board;
    const keep = $('#lgIn') ? $('#lgIn').value : L.draft;
    const on = (n) => L.online.has(n) || n === me;
    // members: online first, then by name; the owner can remove anyone, challenges only in a play room
    const mem = rm.members.slice().sort((a, b) => (b === me) - (a === me) || on(b) - on(a) || a.localeCompare(b)).map((n) => `<div class="lgrow"><span class="who"><span class="lgdot${on(n) ? ' on' : ''}" role="img" aria-label="${on(n) ? 'online' : 'offline'}" title="${on(n) ? 'online' : 'offline'}"></span>${avImg(n, 28)}<span class="plink lgname" data-name="${esc(n)}">${esc(n)}</span>${n === rm.owner ? ' <span class="badge gold">owner</span>' : ''}${n === me ? ' <span class="muted">(you)</span>' : ''}</span><span class="acts">${play && n !== me ? `<button class="small" data-lg="chal" data-n="${esc(n)}">Challenge</button>` : ''}${owner && n !== me ? `<button class="small danger" data-lg="kick" data-n="${esc(n)}" aria-label="Remove ${esc(n)} from the room" title="Remove from the room">✕</button>` : ''}</span></div>`).join('');
    const waiting = rm.invited.map((n) => `<span class="lgwait">${esc(n)}${owner ? `<button class="delx lgx" data-lg="uninv" data-n="${esc(n)}" style="opacity:1" aria-label="Cancel the invite to ${esc(n)}" title="Cancel the invite"></button>` : ''}</span>`).join(', ');
    // invite suggestions: players I have seen around (online first) who are not in the room yet
    const inRoom = new Set([...rm.members, ...rm.invited]), now = Date.now();
    const sugg = typeof knownNames !== 'undefined' ? [...knownNames.keys()].filter((n) => !inRoom.has(n)).sort((a, b) => (now - knownNames.get(a) < 120e3 ? 0 : 1) - (now - knownNames.get(b) < 120e3 ? 0 : 1) || a.localeCompare(b)).slice(0, 6) : [];
    const free = 12 - rm.members.length - rm.invited.length;
    const tbl = d.table.map((x, i) => `<tr><td>${i + 1}</td><td class="lgname">${esc(x.name)}</td><td class="r">${x.w}</td><td class="r">${x.d}</td><td class="r">${x.l}</td><td class="r"><b>${x.pts % 1 ? (Math.floor(x.pts) || '') + '½' : x.pts}</b></td></tr>`).join('');
    const tabs = d.tables.map((t) => `<div class="lgrow"><span><b>${esc(t.by)}</b> <span class="muted">${esc(tcName(t.tc))}</span></span>${t.by === me ? '<button class="small" data-lg="sit" data-code="' + esc(t.code) + '">Go to my table</button>' : `<button class="primary small" data-lg="sit" data-code="${esc(t.code)}">Sit down</button>`}</div>`).join('');
    const body = `<div class="lgwrap">
      <div class="lgtop"><button class="small" data-lg="back">← Rooms</button><h1 class="ptitle" style="margin:0">${esc(rm.name)}${board ? ' <span class="badge">sandbox</span>' : study ? ' <span class="badge">study</span>' : ''}</h1><span class="acts"><button class="small" data-lg="link">Copy link</button>${owner ? '<button class="small" data-lg="rename">Rename</button><button class="small danger" data-lg="del">Delete</button>' : ''}<button class="small" data-lg="leave">Leave</button></span></div>
      <div id="lgErr" class="muted lgerr" role="alert"></div>
      <div class="lggrid">
        <div class="lgcol">
          ${board ? '<div class="panel lgmain"><h2 class="ph">Board</h2><div class="muted" style="font-weight:600;margin-bottom:10px">One board for the whole room: place any pieces anywhere, play from that position, and leave notes.</div><button class="primary" data-lg="sbopen" style="width:100%;min-height:48px">Open the shared board</button></div>' : study ? '<div class="panel lgmain" id="lgStudyP"><h2 class="ph"><span>Study</span><button class="small" data-lg="pick">Choose a game</button></h2><div id="stPick"></div><div id="stChoose"></div></div>' : `<div class="panel lgmain"><h2 class="ph">Play</h2>
            <div class="lgrow"><select id="lgTc" aria-label="Time control">${TCS.map(([v, n]) => `<option value="${v}"${v === (L.tcSel || '300,0') ? ' selected' : ''}>${n}</option>`).join('')}</select><button class="primary" data-lg="table">Open a table</button></div>
            <div class="muted" style="font-size:.85rem;margin:6px 0">An open table lets anyone in this room sit down against you. Or challenge a member below.</div>
            ${tabs || '<div class="muted">No open tables right now.</div>'}</div>`}
          <div class="panel"><h2 class="ph">Members · ${rm.members.length}</h2>${mem}
            ${free > 0 ? `<form id="lgInv" class="lgrow" style="margin-top:8px"><input id="lgInvName" maxlength="16" autocomplete="off" placeholder="Invite by username" aria-label="Invite by username" style="flex:1"><button type="submit">Invite</button></form>
            ${sugg.length ? `<div class="lgsugg"><span class="muted">Invite:</span>${sugg.map((n) => `<button type="button" class="small" data-lg="inv" data-n="${esc(n)}" aria-label="Invite ${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}` : '<div class="muted" style="margin-top:8px">This room is full (12 people).</div>'}
            <div id="lgInvErr" class="muted lgerr" role="alert"></div>
            ${waiting ? `<div class="muted" style="font-size:.85rem;margin-top:6px">Waiting for: ${waiting}</div>` : ''}</div>
          ${!play ? '' : `<div class="panel"><h2 class="ph">Table</h2>${tbl ? `<table class="lgtbl"><thead><tr><th></th><th>Player</th><th class="r">W</th><th class="r">D</th><th class="r">L</th><th class="r">Pts</th></tr></thead><tbody>${tbl}</tbody></table>` : ''}
            ${d.recent.length ? `<div class="muted" style="font-size:.85rem;margin-top:8px">Latest: ${d.recent.map((g) => `${esc(g.w)} ${g.res === 'draw' ? 'drew with' : g.res === 'w' ? 'beat' : 'lost to'} ${esc(g.b)}`).join(' · ')}</div>` : '<div class="muted" style="font-size:.85rem;margin-top:8px">Games played from this room show up here.</div>'}</div>`}
        </div>
        ${L.chatPanel('lg')}
      </div></div>`;
    const log = $('#lgLog'), atEnd = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const keepInv = $('#lgInvName') ? $('#lgInvName').value : '', keepPick = $('#stChoose') ? $('#stChoose').innerHTML : '';
    const errs = [...document.querySelectorAll('#lounge .lgerr')].map((x) => [x.id, x.textContent]);
    const foc = document.activeElement && el().contains(document.activeElement) ? document.activeElement : null, fid = foc && foc.id, fsel = foc && foc.dataset ? foc.dataset.lg + '|' + (foc.dataset.n || foc.dataset.code || foc.dataset.id || '') : null;
    setHTML(el(), body);
    const lg = $('#lgLog'); if (lg && (atEnd || full)) lg.scrollTop = lg.scrollHeight;
    if ($('#lgIn')) $('#lgIn').value = keep;
    if ($('#lgInvName') && keepInv) $('#lgInvName').value = keepInv;
    if ($('#stChoose') && keepPick) $('#stChoose').innerHTML = keepPick;   // the game picker stays open through a refresh
    for (const [id, t] of errs) if (id && $('#' + id) && t) $('#' + id).textContent = t;
    // a refresh (a message, a poll) must not steal the keyboard focus
    if (foc && !foc.isConnected) { const f = fid ? $('#' + fid) : [...el().querySelectorAll('[data-lg]')].find((x) => x.dataset.lg + '|' + (x.dataset.n || x.dataset.code || x.dataset.id || '') === fsel); if (f) f.focus({ preventScroll: true }); }
    if (study) L.paintStudyHome();
  };
  // the room chat box (the room page and the sandbox board use the same one); p is the id prefix
  L.chatPanel = function (p) {
    const d = L.data, me = d.room.me;
    const chat = d.chat.map((m) => `<div class="lgmsg">${avImg(m.n, 20)}<b>${esc(m.n)}</b> <span class="muted lgts" title="${esc(new Date(m.ts).toLocaleString())}">${esc(new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span> ${chatBody(m.t)}${m.n === me ? ` <button class="delx" data-lg="mdel" data-id="${esc(m.id)}" title="Delete your message" aria-label="Delete your message">×</button>` : ''}</div>`).join('');
    return `<div class="panel lgchat"><h2 class="ph">Chat</h2><div id="${p}Log" class="lglog" role="log" aria-live="polite" aria-label="Room chat">${chat || '<div class="muted">No messages yet. Say hello.</div>'}</div>
          <form id="${p}Send" class="lgrow lgsend"><input id="${p}In" maxlength="300" autocomplete="off" placeholder="Message the room" aria-label="Message the room" style="flex:1"><button type="button" class="small gifbtn" data-lg="gif" title="Send a GIF" aria-label="Send a GIF">GIF</button><button class="primary" type="submit">Send</button></form><div id="${p}ChatErr" class="muted lgerr" role="alert"></div></div>`;
  };
  const tcName = (tc) => (tc ? (TCS.find(([v]) => v === tc.base + ',' + tc.inc) || [0, `${Math.round(tc.base / 60)} min${tc.inc ? ' + ' + tc.inc : ''}`])[1] : 'No clock');

  L.onChat = function (m) {
    if (!L.data || L.data.chat.some((x) => x.id === m.id)) return;
    L.data.chat.push(m); L.data.chat = L.data.chat.slice(-50);
    if (view === 'sandbox' && window.Sandbox && Sandbox.room) Sandbox.paint(); else if (view === 'lounge') L.paintRoom(false);
    seenChat();
  };


  // ---------- study rooms ----------
  // The study board is the usual game viewer (board and pieces as you set them, move list, evaluation, Stockfish review).
  // A panel beside it holds the room's notes for the move on screen, and the room chat. Each member's mark (!! ! !? ?! ? ??)
  // is compared with the engine's rating of that move from the viewer's own review.
  const MARKS = [['!!', 'Brilliant'], ['!', 'Good'], ['!?', 'Interesting'], ['?!', 'Dubious'], ['?', 'Mistake'], ['??', 'Blunder']];
  const BUCKET = { brilliant: 'good', great: 'good', best: 'good', excellent: 'good', good: 'good', forced: 'good', inaccuracy: 'inacc', mistake: 'mistake', blunder: 'blunder' };
  const MARKB = { '!!': 'good', '!': 'good', '?!': 'inacc', '?': 'mistake', '??': 'blunder' };
  const ORDER = ['good', 'inacc', 'mistake', 'blunder'], BNAME = { good: 'a good move', inacc: 'an inaccuracy', mistake: 'a mistake', blunder: 'a blunder' };
  const MARKD = { '!!': 'a brilliant, surprising move', '!': 'a good, solid move', '!?': 'interesting, worth a look', '?!': 'dubious, probably not best', '?': 'a mistake that costs something', '??': 'a blunder that throws the game away' };
  L.mark = ''; L.sPly = -1; L.sDone = -1; L.sFormPly = -2; L.sMarks = '';

  // the room page: the chosen game and a button into the full board
  L.paintStudyHome = function () {
    const st = L.data && L.data.study, box = $('#stPick'); if (!box) return;
    const who = st ? new Set(st.notes.map((n) => n.by)).size : 0;
    setHTML(box, st ? `<div class="muted" style="font-weight:600">${esc(st.game.w)} vs ${esc(st.game.b)} · ${st.game.result === 'draw' ? 'draw' : st.game.result === 'w' ? '1-0' : '0-1'} · chosen by ${esc(st.by)}</div>
      <div class="muted" style="margin:4px 0 10px">${st.notes.length ? `${st.notes.length} note${st.notes.length === 1 ? '' : 's'} from ${who} member${who === 1 ? '' : 's'}` : 'No notes yet'}</div>
      <button class="primary" data-lg="board" style="width:100%;min-height:48px">Open the study board</button>`
      : '<div class="muted" style="font-weight:600">No game yet. Choose one of your finished games. Everyone then annotates it together on the full board, and Stockfish checks the marks.</div>');
  };
  L.studyBoard = function () {
    const st = L.data && L.data.study; if (!st) return;
    L.stop();
    enterArchive(st.game.id, { analyze: true, back: 'lounge:' + L.id, study: L.id });
  };

  const bestSan = (i) => { const r = AN.res[i]; if (!r || !r.best) return null; const h = AN.hist[i]; if (r.best.from === h.from && r.best.to === h.to) return null; const m = Chess.legalMoves(AN.states[i]).find((x) => x.from === r.best.from && x.to === r.best.to && (x.promo || undefined) === (r.best.promo || undefined)); return m ? Chess.notate(AN.states[i], m) : null; };
  const verdict = (n) => {
    const nb = MARKB[n.mark], c = AN.key && AN.cls[n.ply - 1]; if (!nb || !c) return null;
    const eb = BUCKET[c], d = Math.abs(ORDER.indexOf(eb) - ORDER.indexOf(nb));
    return { ok: d === 0, near: d === 1, name: BNAME[eb], best: d ? bestSan(n.ply - 1) : null };
  };
  const mvName = (ply) => { const h = AN.hist && AN.hist[ply - 1], st = AN.states && AN.states[ply - 1]; const m = h && st && Chess.legalMoves(st).find((x) => x.from === h.from && x.to === h.to && (x.promo || undefined) === (h.promo || undefined)); return `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '...'} ${m ? Chess.notate(st, m) : ''}`; };

  // open the panel beside the replay
  L.studyStart = async function (id) {
    L.id = id; L.sPly = -1; L.sDone = -1; L.sFormPly = -2; L.sMarks = '';
    const box = $('#studypanel'); if (!box) return;
    const col = document.querySelector('#game .boardcol'); if (col && box.parentNode !== col) col.appendChild(box);   // under the board, in the empty space
    document.body.classList.add('studying'); document.body.classList.remove('showreview');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="anhead sghead"><b id="sgTitle">Study</b><span class="muted" id="sgMem"></span><button type="button" class="small" data-sg="review" aria-pressed="false">Show game review</button></div>
      <div class="sgcols"><div class="sgcol"><details class="sghelp"><summary>How this works</summary><ol><li>Step through the game with the arrow keys, the buttons under the board, or by clicking a move.</li><li>On any move, pick a mark and say why. Everyone in the room sees your note.</li><li>When the review above says Done, Stockfish checks each mark: ✓ agrees, ~ close, ✗ disagrees.</li><li>The table at the bottom scores each member against Stockfish.</li></ol></details>
      <div id="sgSf" class="muted" style="font-size:.82rem;font-weight:700;margin:6px 0"></div>
      <div id="sgNav"></div>
      <div id="sgForm"></div><div id="sgList"></div></div><div class="sgcol"><div id="sgAll"></div><div id="sgScore"></div>
      <h2 class="ph" style="margin-top:14px"><span>Room chat</span></h2><div id="sgLog" class="lglog" style="height:160px"></div>
      <form id="sgSend" class="lgrow"><input id="sgIn" maxlength="300" autocomplete="off" placeholder="Message the room" aria-label="Message" style="flex:1"><button type="button" class="small gifbtn" data-sg="gif" title="Send a GIF">GIF</button><button class="primary" type="submit">Send</button></form></div></div><div id="sgErr" class="muted" style="color:var(--bad,#c0392b)"></div>`;
    await L.sFetch();
    if (L.data && L.data.room) L.sOff = rtSubscribe(L.data.room.topic, { chat: (m) => L.sChat(m), tbl: L.sFetch, cd: L.sFetch, mem: L.sFetch }, () => {});
    L.sTimer = setInterval(L.sTick, 300); L.sPoll = setInterval(() => { if (!document.hidden) L.sFetch(); }, 8000);
  };
  L.studyEnd = function () {
    clearInterval(L.sTimer); clearInterval(L.sPoll); L.sTimer = L.sPoll = null; if (L.sOff) { L.sOff(); L.sOff = null; }
    document.body.classList.remove('studying', 'showreview');
    const box = $('#studypanel'); if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    document.querySelectorAll('#moves .mv[data-notes]').forEach((c) => c.removeAttribute('data-notes'));
  };
  L.sFetch = async function () {
    const r = await api('lounge_get', { id: L.id });
    if (!r.ok || !r.room) { if (r.status === 403 || r.status === 404) { L.studyEnd(); if (typeof enterLounge === 'function') enterLounge(null); } return; }
    L.data = r; L.sPaint(false);
  };
  L.sChat = function (m) { if (!L.data || L.data.chat.some((x) => x.id === m.id)) return; L.data.chat.push(m); L.data.chat = L.data.chat.slice(-50); L.sPaint(false); };
  L.sTick = function () {
    if (view !== 'game' || typeof archive === 'undefined' || !archive || archive.study !== L.id) return L.studyEnd();
    const p = curPly(), done = AN.res.filter(Boolean).length;
    if (p !== L.sPly || done !== L.sDone) { L.sPly = p; L.sDone = done; L.sPaint(false); }
  };
  L.sPaint = function (force) {
    if (!$('#sgForm') || !L.data || !L.data.room) return;
    const d = L.data, st = d.study, me = d.room.me, p = curPly(), notes = (st && st.notes) || [], at = notes.filter((x) => x.ply === p);
    setText($('#sgTitle'), 'Study · ' + d.room.name); setText($('#sgMem'), `${d.room.members.length} member${d.room.members.length === 1 ? '' : 's'}`);
    if (force || L.sFormPly !== p) {                                          // the note form only changes with the move on screen
      L.sFormPly = p;
      const mine = at.find((x) => x.by === me); L.mark = mine ? mine.mark : '';
      setHTML($('#sgForm'), p ? `<div class="label">Your note on ${esc(mvName(p))}</div><div class="stmarks">${MARKS.map(([m, t]) => `<button type="button" class="stmk${m === L.mark ? ' on' : ''}" data-sg="mark" data-m="${m}" title="${m} ${t}: ${MARKD[m]}" aria-label="${t} (${m})"><b>${m}</b><small>${t}</small></button>`).join('')}</div><div class="muted" id="sgMarkDesc" style="font-size:.82rem;font-weight:600;min-height:1.2em">${L.mark ? esc(MARKD[L.mark]) : 'Optional: pick a mark, or just write a comment.'}</div><div class="lgrow"><input id="sgText" maxlength="240" autocomplete="off" placeholder="What do you see here? (Enter saves)" value="${esc(mine ? mine.text : '')}" style="flex:1"><button class="primary" data-sg="note">Save</button></div><div class="lgrow" style="justify-content:space-between"><span class="muted" style="font-size:.8rem">One note per member per move. Saving again replaces yours.</span><span id="sgSaved" style="color:#81b64c;font-weight:800;font-size:.85rem" role="status"></span></div>` : '<div class="muted" style="font-weight:600">Step to a move (arrow keys or click one), then mark it (!! ! !? ?! ? ??) and say why. Stockfish checks the marks.</div>');
    }
    setHTML($('#sgList'), p ? (at.length ? at : []).map((x) => { const v = verdict(x); return `<div class="stn"><div>${avImg(x.by, 20)}<b>${esc(x.by)}</b> ${x.mark ? `<span class="stmark">${esc(x.mark)}</span>` : ''} ${esc(x.text)}${x.by === me || d.room.owner === me ? ` <button class="delx" data-sg="ndel" data-id="${esc(x.id)}" style="opacity:1" aria-label="Remove note">×</button>` : ''}</div>${v ? `<div class="stv ${v.ok ? 'ok' : v.near ? 'near' : 'bad'}">${v.ok ? '✓ Stockfish agrees' : (v.near ? '~ Close: ' : '✗ Stockfish disagrees: ') + 'it rates this as ' + v.name}${v.best ? `. Better was <b>${esc(v.best)}</b>` : ''}</div>` : x.mark && !AN.done ? '<div class="stv muted">Stockfish is still checking this move…</div>' : ''}</div>`; }).join('') || '<div class="muted" style="margin-top:6px">No notes on this move yet.</div>' : '');
    const nps = [...new Set(notes.map((x) => x.ply))].sort((a, b) => a - b), prev = nps.filter((x) => x < p).pop(), next = nps.find((x) => x > p);
    const done = AN.res.filter(Boolean).length, total = (AN.hist || []).length;
    setText($('#sgSf'), AN.done || (total && done >= total) ? 'Stockfish review finished: marks are being checked.' : total ? `Stockfish is reviewing the game (${done} of ${total} moves). Marks are checked as it goes.` : 'Waiting for the Stockfish review to start…');
    setHTML($('#sgNav'), `<div class="lgrow sgnav"><button type="button" class="small" data-sg="prevn" ${prev == null ? 'disabled' : ''} title="Jump to the previous move with a note">◀ Previous note</button><span class="muted" style="font-size:.8rem;font-weight:700">${nps.length ? `${nps.length} noted` : 'No notes yet'}</span><button type="button" class="small" data-sg="nextn" ${next == null ? 'disabled' : ''} title="Jump to the next move with a note">Next note ▶</button></div>`);
    setHTML($('#sgAll'), nps.length ? `<h2 class="ph" style="margin-top:14px"><span>All notes</span><span class="muted" style="font-size:.8rem">tap a move to jump</span></h2>${nps.map((pl) => { const ns = notes.filter((x) => x.ply === pl); return `<button type="button" class="sgrow${pl === p ? ' on' : ''}" data-sg="goto" data-ply="${pl}"><b>${esc(mvName(pl))}</b><span class="sgchips">${ns.map((x) => `<span class="sgchip">${avImg(x.by, 16)}${x.mark ? `<span class="stmark">${esc(x.mark)}</span>` : ''}</span>`).join('')}</span><span class="muted sgtxt">${esc(ns.map((x) => x.text).filter(Boolean)[0] || '')}</span></button>`; }).join('')}` : '');
    const sc = {}; for (const x of notes) { const v = verdict(x); if (!v) continue; const r = (sc[x.by] = sc[x.by] || { n: 0, pts: 0 }); r.n++; r.pts += v.ok ? 1 : v.near ? 0.5 : 0; }
    const rows = Object.entries(sc).sort((a, b) => b[1].pts / b[1].n - a[1].pts / a[1].n);
    setHTML($('#sgScore'), rows.length ? `<h2 class="ph" style="margin-top:14px"><span>Agreement with Stockfish</span></h2>${rows.map(([nm, r]) => `<div class="lgrow"><span>${avImg(nm, 20)}${esc(nm)} <span class="muted">${r.n} mark${r.n === 1 ? '' : 's'}</span></span><b>${Math.round((100 * r.pts) / r.n)}%</b></div>`).join('')}` : '');
    const log = $('#sgLog'), near = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    setHTML(log, d.chat.map((m) => `<div class="lgmsg">${avImg(m.n, 20)}<b>${esc(m.n)}</b> ${chatBody(m.t)}</div>`).join('') || '<div class="muted">Say hello.</div>');
    if (near) log.scrollTop = log.scrollHeight;
    // a dot on every move in the list that has a note
    const sig = notes.map((x) => x.ply).join(',');
    if (sig !== L.sMarks) {
      L.sMarks = sig; const cnt = {}; for (const x of notes) cnt[x.ply] = (cnt[x.ply] || 0) + 1;
      document.querySelectorAll('#moves .mv:not(.ph)').forEach((c) => { const k = +c.dataset.ply; if (cnt[k]) c.dataset.notes = cnt[k]; else c.removeAttribute('data-notes'); });
    }
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'sgText') { e.preventDefault(); const b = document.querySelector('#sgForm [data-sg=note]'); if (b) b.click(); } });
  // the panel's own buttons (it lives next to the game board, outside the Rooms page)
  document.addEventListener('submit', async (e) => {
    if (!e.target.closest('#sgSend')) return; e.preventDefault();
    const inp = $('#sgIn'), text = inp.value.trim(); if (!text) return; inp.value = '';
    const r = await api('lounge_chat', { id: L.id, text }); if (!r.ok) { inp.value = text; return setText($('#sgErr'), r.error); }
    setText($('#sgErr'), ''); L.sChat(r.msg);
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#studypanel [data-sg]'); if (!b || b.disabled) return;
    const a = b.dataset.sg;
    if (a === 'mark') { L.mark = L.mark === b.dataset.m ? '' : b.dataset.m; document.querySelectorAll('#sgForm .stmk').forEach((x) => x.classList.toggle('on', x.dataset.m === L.mark)); setText($('#sgMarkDesc'), L.mark ? MARKD[L.mark] : 'Optional: pick a mark, or just write a comment.'); return; }
    if (a === 'note') { const r = await api('lounge_study_note', { id: L.id, ply: curPly(), mark: L.mark, text: $('#sgText').value }); if (!r.ok) return setText($('#sgErr'), r.error); setText($('#sgErr'), ''); L.sFlash = Date.now(); await L.sFetch(); setText($('#sgSaved'), 'Saved ✓'); setTimeout(() => setText($('#sgSaved'), ''), 2500); return; }
    if (a === 'review') { const on = document.body.classList.toggle('showreview'); b.setAttribute('aria-pressed', on); b.textContent = on ? 'Hide game review' : 'Show game review'; return; }
    if (a === 'goto') return navTo(+b.dataset.ply);
    if (a === 'prevn' || a === 'nextn') { const ps = [...new Set(((L.data.study || {}).notes || []).map((x) => x.ply))].sort((x, y) => x - y), p = curPly(), t = a === 'prevn' ? ps.filter((x) => x < p).pop() : ps.find((x) => x > p); if (t != null) navTo(t); return; }
    if (a === 'ndel') { const r = await api('lounge_study_del', { id: L.id, note: b.dataset.id }); return r.ok ? L.sFetch() : setText($('#sgErr'), r.error); }
    if (a === 'gif') return openGifPicker((u) => { $('#sgIn').value = u; $('#sgSend').requestSubmit(); });
  });

  L.pickGame = async function () {
    const box = $('#stChoose'); box.innerHTML = '<div class="muted">Loading your games…</div>';
    const r = await api('games', { name: L.data.room.me });
    const gs = (r.ok ? r.games : []).filter((g) => g.id).slice(0, 12);
    if (!gs.length) { box.innerHTML = '<div class="muted">You have no finished games yet. Play one first, then come back.</div>'; return; }
    box.innerHTML = '<div class="label">Pick a game to study</div>' + gs.map((g) => `<div class="lgrow"><span>You (${g.color === 'w' ? 'White' : 'Black'}) vs ${esc(g.opp)} <span class="muted">${g.result === 'win' ? 'won' : g.result === 'loss' ? 'lost' : 'drew'} · ${Math.ceil(g.moves / 2)} moves${g.op ? ' · ' + esc(g.op) : ''}</span></span><button class="small" data-lg="use" data-game="${esc(g.id)}">Use</button></div>`).join('');
  };

  // ---------- actions ----------
  const invite = async (n) => {
    const r = await api('lounge_invite', { id: L.id, name: n }); if (!r.ok) { err(r.error, '#lgInvErr'); return false; }
    err(''); L.loadRoom(true); return true;
  };
  // the room chat, on the room page (#lgSend) or beside the sandbox board (#sbSend)
  const sendChat = async (p) => {
    const inp = $('#' + p + 'In'), text = inp.value.trim(); if (!text) return; inp.value = '';
    const r = await api('lounge_chat', { id: L.id, text }); if (!r.ok) { inp.value = text; return err(r.error, '#' + p + 'ChatErr'); }
    err('', '#' + p + 'ChatErr'); L.onChat(r.msg);
  };
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('#lgNew, #lgSend, #lgInv, #sbSend'); if (!f) return; e.preventDefault();
    if (f.id === 'lgNew') {
      const btn = f.querySelector('button[type=submit]'); if (btn.disabled) return; btn.disabled = true;
      const r = await api('lounge_create', { name: $('#lgName').value, kind: (document.querySelector('input[name=lgkind]:checked') || {}).value }); btn.disabled = false;
      if (!r.ok) return err(r.error);
      return L.enter(r.id);
    }
    if (f.id === 'lgSend' || f.id === 'sbSend') return sendChat(f.id.slice(0, 2));
    if (f.id === 'lgInv') {
      const n = $('#lgInvName').value.trim(); if (!n) return;
      if (await invite(n)) $('#lgInvName').value = '';
    }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'lgTc') L.tcSel = e.target.value; });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#lounge [data-lg], #sandbox [data-lg]'); if (!b || b.disabled) return;
    const a = b.dataset.lg, id = b.dataset.id || L.id, p = b.closest('#sandbox') ? 'sb' : 'lg';
    if (a === 'board') return L.studyBoard();
    if (a === 'sbopen') return loadScript('/sandbox.js').then(() => Sandbox.enterRoom(L.id));
    if (a === 'pick') return L.pickGame();
    if (a === 'use') { if (L.data.study && L.data.study.notes.length && !confirm('Switching the game clears the notes. Continue?')) return; const r = await api('lounge_study_pick', { id: L.id, game: b.dataset.game }); if (!r.ok) return err(r.error); $('#stChoose').innerHTML = ''; return L.loadRoom(true); }
    if (a === 'gif') return openGifPicker((u) => { $('#' + p + 'In').value = u; $('#' + p + 'Send').requestSubmit(); });
    if (a === 'mdel') {
      b.closest('.lgmsg').remove();
      const r = await api('lounge_chat_delete', { id: L.id, mid: b.dataset.id }); if (!r.ok) err(r.error, '#' + p + 'ChatErr');
      if (L.data) L.data.chat = L.data.chat.filter((m) => m.id !== b.dataset.id);
      return p === 'sb' ? window.Sandbox && Sandbox.pull() : L.loadRoom(true);
    }
    if (a === 'open') return L.enter(id);
    if (a === 'back') return L.enter(null);
    if (a === 'yes' || a === 'no') { b.disabled = true; const r = await api('lounge_reply', { id, accept: a === 'yes' }); b.disabled = false; if (!r.ok) { err(r.error); if (r.status === 404) L.loadHome(); return; } return a === 'yes' ? L.enter(id) : L.enter(null); }
    if (a === 'link') return typeof copy === 'function' ? copy(location.origin + '/?lounge=' + L.id, '[data-lg="link"]') : null;
    if (a === 'leave') {
      const rm = L.data.room, next = rm.members.find((n) => n !== rm.me);
      const q = rm.owner === rm.me ? (next ? `Leave this room? ${next} becomes the owner.` : 'You are the last one here: leaving deletes the room. Leave?') : 'Leave this room?';
      if (!confirm(q)) return; const r = await api('lounge_leave', { id: L.id }); return r.ok ? L.enter(null) : err(r.error);
    }
    if (a === 'del') { if (!confirm('Delete this room for everyone? Its chat and table go too.')) return; const r = await api('lounge_delete', { id: L.id }); return r.ok ? L.enter(null) : err(r.error); }
    if (a === 'rename') {
      const n = prompt('A new name for the room', L.data.room.name); if (n == null || n.trim() === L.data.room.name) return;
      const r = await api('lounge_rename', { id: L.id, name: n }); return r.ok ? (err(''), L.loadRoom(true)) : err(r.error);
    }
    if (a === 'kick') { if (!confirm(`Remove ${b.dataset.n} from the room?`)) return; const r = await api('lounge_kick', { id: L.id, name: b.dataset.n }); return r.ok ? L.loadRoom(true) : err(r.error); }
    if (a === 'uninv') { const r = await api('lounge_kick', { id: L.id, name: b.dataset.n }); return r.ok ? L.loadRoom(true) : err(r.error, '#lgInvErr'); }
    if (a === 'inv') { b.disabled = true; await invite(b.dataset.n); b.disabled = false; return; }
    if (a === 'table') {
      b.disabled = true; const r = await api('lounge_table', { id: L.id, tc: tcVal($('#lgTc').value) }); b.disabled = false;
      return r.ok ? enterGame(r.code, r.snap) : err(r.error);
    }
    if (a === 'sit') { b.disabled = true; const r = await api('lounge_sit', { id: L.id, code: b.dataset.code }); b.disabled = false; return r.ok ? enterGame(r.code, r.snap) : err(r.error); }
    if (a === 'chal') {
      const tc = $('#lgTc') ? tcVal($('#lgTc').value) : { base: 300, inc: 0 };
      b.disabled = true; const r = await api('challenge', { to: b.dataset.n, tc, lounge: L.id }); b.disabled = false;
      if (!r.ok) return err(r.error);
      err('');
      curOut = { id: r.id, to: b.dataset.n, status: 'pending', ts: Date.now() }; localOut = { to: b.dataset.n, ts: Date.now(), id: r.id };   // so their answer opens the game for me
      b.textContent = 'Sent ✓'; setTimeout(() => { if (b.isConnected) b.textContent = 'Challenge'; }, 4000);
    }
  });
})();
