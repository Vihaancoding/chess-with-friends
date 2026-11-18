// Rooms (lounges): private rooms for a group of friends. Loaded the first time someone opens "Rooms".
// Uses the page's globals: $, api, esc, setHTML, user, view, show, enterGame, rtSubscribe, stopLobby, stopGame, stopAdmin.
(function () {
  const L = window.Lounge = { id: null, data: null, timer: null, off: null, live: false, online: new Set(), busy: false, draft: '' };
  const TCS = [['180,0', '3 min'], ['300,0', '5 min'], ['600,0', '10 min'], ['900,10', '15 | 10'], ['0,0', 'No clock']];
  const tcVal = (v) => { const [base, inc] = v.split(',').map(Number); return base ? { base, inc } : null; };
  const el = () => $('#lounge');
  const err = (t) => { const e = $('#lgErr'); if (e) e.textContent = t || ''; };

  L.stop = function () { clearInterval(L.timer); L.timer = null; if (L.off) { L.off(); L.off = null; } L.live = false; };

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
      <div class="panel"><h2 class="ph">Your rooms</h2>${mine.length ? mine.map((x) => `<div class="lgrow"><b>${esc(x.name)}</b><button class="small" data-lg="open" data-id="${esc(x.id)}">Open</button></div>`).join('') : '<div class="muted">You are not in any room yet. Make one and invite your friends.</div>'}</div>
      <form class="panel" id="lgNew"><h2 class="ph">Make a room</h2><div class="lgrow"><input id="lgName" maxlength="30" placeholder="Room name, e.g. Friday club" aria-label="Room name" style="flex:1"><button class="primary" type="submit">Create</button></div><div id="lgErr" class="muted" style="color:var(--bad,#c0392b)"></div></form></div>`);
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
    const d = L.data, rm = d.room, me = rm.me, owner = rm.owner === me;
    const keep = $('#lgIn') ? $('#lgIn').value : L.draft, hadFocus = document.activeElement && document.activeElement.id === 'lgIn';
    const mem = rm.members.map((n) => `<div class="lgrow"><span><span class="lgdot${L.online.has(n) ? ' on' : ''}"></span><span class="plink" data-name="${esc(n)}">${esc(n)}</span>${n === rm.owner ? ' <span class="badge gold">owner</span>' : ''}${n === me ? ' <span class="muted">(you)</span>' : ''}</span><span class="acts">${n !== me ? `<button class="small" data-lg="chal" data-n="${esc(n)}">Challenge</button>` : ''}${owner && n !== me ? `<button class="small danger" data-lg="kick" data-n="${esc(n)}" aria-label="Remove ${esc(n)}">✕</button>` : ''}</span></div>`).join('');
    const tbl = d.table.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td class="r">${x.w}</td><td class="r">${x.d}</td><td class="r">${x.l}</td><td class="r"><b>${x.pts % 1 ? (Math.floor(x.pts) || '') + '½' : x.pts}</b></td></tr>`).join('');
    const tabs = d.tables.map((t) => `<div class="lgrow"><span><b>${esc(t.by)}</b> <span class="muted">${esc(tcName(t.tc))}</span></span>${t.by === me ? '<button class="small" data-lg="sit" data-code="' + esc(t.code) + '">Go to my table</button>' : `<button class="primary small" data-lg="sit" data-code="${esc(t.code)}">Sit down</button>`}</div>`).join('');
    const chat = d.chat.map((m) => `<div class="lgmsg"><b>${esc(m.n)}</b> ${esc(m.t)}</div>`).join('');
    const body = `<div class="lgwrap">
      <div class="lgtop"><button class="small" data-lg="back">← Rooms</button><h1 class="ptitle" style="margin:0">${esc(rm.name)}</h1><span class="acts"><button class="small" data-lg="link">Copy link</button>${owner ? '<button class="small danger" data-lg="del">Delete</button>' : ''}<button class="small" data-lg="leave">Leave</button></span></div>
      <div class="lggrid">
        <div class="lgcol">
          <div class="panel"><h2 class="ph">Play</h2>
            <div class="lgrow"><select id="lgTc" aria-label="Time control">${TCS.map(([v, n]) => `<option value="${v}"${v === (L.tcSel || '300,0') ? ' selected' : ''}>${n}</option>`).join('')}</select><button class="primary" data-lg="table">Open a table</button></div>
            <div class="muted" style="font-size:.85rem;margin:6px 0">An open table lets anyone in this room sit down against you. Or challenge a member below.</div>
            ${tabs || '<div class="muted">No open tables right now.</div>'}</div>
          <div class="panel"><h2 class="ph">Members · ${rm.members.length}</h2>${mem}
            <form id="lgInv" class="lgrow" style="margin-top:8px"><input id="lgInvName" maxlength="16" placeholder="Invite by username" aria-label="Invite by username" style="flex:1"><button type="submit">Invite</button></form>
            ${rm.invited.length ? `<div class="muted" style="font-size:.85rem;margin-top:6px">Waiting for: ${rm.invited.map(esc).join(', ')}</div>` : ''}</div>
          <div class="panel"><h2 class="ph">Table</h2>${tbl ? `<table class="lgtbl"><thead><tr><th></th><th>Player</th><th class="r">W</th><th class="r">D</th><th class="r">L</th><th class="r">Pts</th></tr></thead><tbody>${tbl}</tbody></table>` : ''}
            ${d.recent.length ? `<div class="muted" style="font-size:.85rem;margin-top:8px">Latest: ${d.recent.map((g) => `${esc(g.w)} ${g.res === 'draw' ? 'drew with' : g.res === 'w' ? 'beat' : 'lost to'} ${esc(g.b)}`).join(' · ')}</div>` : '<div class="muted" style="font-size:.85rem;margin-top:8px">Games played from this room show up here.</div>'}</div>
        </div>
        <div class="panel lgchat"><h2 class="ph">Chat</h2><div id="lgLog" class="lglog">${chat || '<div class="muted">Say hello.</div>'}</div>
          <form id="lgSend" class="lgrow"><input id="lgIn" maxlength="300" autocomplete="off" placeholder="Message the room" aria-label="Message" style="flex:1"><button class="primary" type="submit">Send</button></form></div>
      </div><div id="lgErr" class="muted" style="color:var(--bad,#c0392b)"></div></div>`;
    const log = $('#lgLog'), atEnd = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const keepInv = $('#lgInvName') ? $('#lgInvName').value : '';
    setHTML(el(), body);
    const lg = $('#lgLog'); if (lg && (atEnd || full)) lg.scrollTop = lg.scrollHeight;
    if ($('#lgIn')) { $('#lgIn').value = keep; if (hadFocus) $('#lgIn').focus(); }
    if ($('#lgInvName') && keepInv) $('#lgInvName').value = keepInv;
  };
  const tcName = (tc) => (tc ? (TCS.find(([v]) => v === tc.base + ',' + tc.inc) || [0, `${Math.round(tc.base / 60)} min${tc.inc ? ' + ' + tc.inc : ''}`])[1] : 'No clock');

  L.onChat = function (m) {
    if (!L.data || L.data.chat.some((x) => x.id === m.id)) return;
    L.data.chat.push(m); L.data.chat = L.data.chat.slice(-50); L.paintRoom(false);
  };

  // ---------- actions ----------
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('#lgNew, #lgSend, #lgInv'); if (!f) return; e.preventDefault();
    if (f.id === 'lgNew') {
      const r = await api('lounge_create', { name: $('#lgName').value }); if (!r.ok) return err(r.error);
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
