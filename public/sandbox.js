// Sandbox room: one blank board. Put any pieces anywhere, then play from that position. Nothing is saved or shared.
// Loaded the first time someone opens "Sandbox". Uses the page's globals: $, esc, setHTML, show, view, stopLobby, stopGame, stopAdmin, Chess.
(function () {
  const S = window.Sandbox = { board: new Array(64).fill(null), turn: 'w', mode: 'setup', pick: 'wQ', st: null, hist: [], sel: null, last: null };
  const KINDS = ['K', 'Q', 'R', 'B', 'N', 'P'], NAME = { K: 'King', Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight', P: 'Pawn' };
  const img = (p) => `<img src="/piece/cburnett/${p}.svg" alt="" draggable="false">`;
  const el = () => $('#sandbox');

  const FIELDS = ['board', 'turn', 'mode', 'st', 'hist', 'sel', 'last'];
  S.leaveRoom = function () {
    S.room = null; clearInterval(S.poll); S.poll = null; if (S.off) { S.off(); S.off = null; }
    if (S.solo) { FIELDS.forEach((k) => { S[k] = S.solo[k]; }); S.solo = null; }
  };
  S.enter = function () {
    stopLobby(); stopGame(); stopAdmin(); if (window.Lounge) Lounge.stop(); S.leaveRoom();
    view = 'sandbox'; gameCode = null; history.replaceState(null, '', '/?sandbox'); show('sandbox');
    S.paint(true);
  };

  // ----- shared board room: the server holds the board and the notes; everyone in the room sees the same thing -----
  S.enterRoom = async function (id) {
    stopLobby(); stopGame(); stopAdmin(); if (window.Lounge) Lounge.stop();
    if (!S.solo && !S.room) S.solo = Object.fromEntries(FIELDS.map((k) => [k, S[k]]));
    clearInterval(S.poll); if (S.off) { S.off(); S.off = null; }
    S.room = id; S.sel = null; S.rd = null;
    view = 'sandbox'; gameCode = null; history.replaceState(null, '', '/?lounge=' + id); show('sandbox');
    el().innerHTML = '<div class="muted" style="padding:20px">Loading…</div>'; el()._h = null;
    await S.pull();
    if (S.rd) S.off = rtSubscribe(S.rd.room.topic, { tbl: S.pull, cd: S.pull, mem: S.pull }, () => {});
    S.poll = setInterval(() => { if (view !== 'sandbox' || !S.room) return S.leaveRoom(); if (!document.hidden) S.pull(); }, 6000);
  };
  S.pull = async function () {
    const id = S.room; if (!id) return;
    const r = await api('lounge_get', { id }); if (S.room !== id) return;
    if (!r.ok || !r.room || r.room.kind !== 'board') { S.leaveRoom(); return Lounge.enter(null); }
    S.rd = r; S.take(r.board); S.paint();
  };
  S.take = function (b) {
    S.board = b.board; S.turn = b.turn; S.mode = b.mode; S.hist = b.hist; S.notes = b.notes;
    S.st = b.mode === 'play' ? state2(b) : null; S.last = b.hist.length ? b.hist[b.hist.length - 1] : null;
    if (b.mode !== 'play') S.sel = null;
  };
  const state2 = (b) => { let st = state(); for (const m of b.hist) st = Chess.apply(st, m); return st; };
  const act = async (op, extra) => { const r = await api('lounge_board', { id: S.room, op, ...extra }); if (!r.ok) { S.err = r.error; return S.paint(); } S.err = ''; S.take(r.board); S.rd.board = r.board; S.paint(); };

  // the position being played (or set up)
  // in the sandbox only "no legal move" ends play (a hand-made position can have any pieces, so no draw rules get in the way)
  const over = (st) => { const none = !Chess.legalMoves(st).length, check = Chess.inCheck(st, st.turn); return { over: none, mate: none && check, check }; };
  const pos = () => (S.mode === 'play' ? S.st : { board: S.board, turn: S.turn });
  const state = () => ({ board: S.board.slice(), turn: S.turn, castle: { wK: false, wQ: false, bK: false, bQ: false }, ep: null, half: 0, full: 1 });   // no castling in a hand-made position

  S.paint = function (full) {
    const p = pos(), play = S.mode === 'play';
    const moves = play && S.sel != null ? Chess.legalMoves(S.st).filter((m) => m.from === S.sel) : [], to = new Set(moves.map((m) => m.to));
    const sq = p.board.map((c, i) => `<div class="sq sbsq ${((i >> 3) + (i & 7)) % 2 ? 'd' : 'l'}${S.last && (i === S.last.from || i === S.last.to) ? ' last' : ''}${S.sel === i ? ' sel' : ''}${to.has(i) ? ' tgt hint' + (c ? ' cap' : '') : ''}" data-sq="${i}" role="button" aria-label="${esc(Chess.sqName(i))}${c ? ' ' + (c[0] === 'w' ? 'white ' : 'black ') + NAME[c[1]] : ''}">${c ? pieceHTML(c) : ''}${i % 8 === 0 ? `<span class="coord r">${8 - (i >> 3)}</span>` : ''}${i >= 56 ? `<span class="coord f">${'abcdefgh'[i & 7]}</span>` : ''}</div>`).join('');
    let status = '';
    if (play) {
      const s = over(S.st), side = S.st.turn === 'w' ? 'White' : 'Black';
      status = s.over ? (s.mate ? `Checkmate: ${S.st.turn === 'w' ? 'Black' : 'White'} wins` : 'Stalemate: no legal move') : `${side} to move${s.check ? ' (check)' : ''}`;
    }
    const pal = ['w', 'b'].map((c) => `<div class="sbpal">${KINDS.map((k) => `<button class="sbp${S.pick === c + k ? ' on' : ''}" data-pick="${c}${k}" aria-label="${c === 'w' ? 'White' : 'Black'} ${NAME[k]}" aria-pressed="${S.pick === c + k}">${img(c + k)}</button>`).join('')}</div>`).join('') +
      `<div class="sbpal"><button class="sbp wide${S.pick === 'x' ? ' on' : ''}" data-pick="x" aria-pressed="${S.pick === 'x'}">Remove a piece</button></div>`;
    const rm = S.room && S.rd ? S.rd.room : null, me = rm ? rm.me : '';
    const nt = !rm ? '' : `<div class="panel sbnotes" style="margin-top:12px"><h2 class="ph">Notes</h2><div id="sbNoteList">${(S.notes || []).slice().reverse().map((n) => `<div class="lgrow"><span><b>${esc(n.by)}</b> <span class="muted">${n.ply ? 'after move ' + n.ply : 'setup'}</span><br>${esc(n.text)}</span>${n.by === me || rm.owner === me ? `<button class="delx" data-sbnd="${esc(n.id)}" aria-label="Delete note" title="Delete note">×</button>` : ''}</div>`).join('') || '<div class="muted">No notes yet.</div>'}</div>
        <form id="sbNoteForm" class="lgrow"><input id="sbNoteIn" maxlength="240" autocomplete="off" placeholder="${play ? 'Note on this position (after move ' + S.hist.length + ')' : 'Note on this setup'}" aria-label="Note" style="flex:1"><button class="primary" type="submit">Add</button></form></div>`;
    const html = `<div class="lgwrap"><div class="lgtop">${rm ? '<button class="small" data-sbback>← Room</button>' : ''}<h1 class="ptitle" style="margin:0">${rm ? esc(rm.name) : 'Sandbox'}</h1><span class="muted" style="font-weight:600">${rm ? 'Shared board: everyone in the room sees the same pieces and moves.' : 'A blank board. Place any pieces anywhere, then play from that position.'}</span></div>${S.err ? `<div class="err" role="alert">${esc(S.err)}</div>` : ''}
      <div class="sbgrid"><div><div class="sbboard">${sq}</div></div>
      <div><div class="panel sbside">
        <div class="authtabs" role="tablist"><button data-sbmode="setup" class="${play ? '' : 'on'}" role="tab" aria-selected="${!play}">Place pieces</button><button data-sbmode="play" class="${play ? 'on' : ''}" role="tab" aria-selected="${play}">Play</button></div>
        ${play ? `<div class="sbstatus" role="status">${esc(status)}</div><div class="acts"><button data-sbundo ${S.hist.length ? '' : 'disabled'}>Undo</button></div><div class="muted" style="font-size:.85rem;font-weight:600;margin-top:8px">Move by clicking a piece, then where it goes. Pawns that reach the last row become queens. Go back to Place pieces to change the position.</div>`
        : `<div class="label" style="margin-top:10px">Pick a piece, then click squares</div>${pal}<div class="label" style="margin-top:10px">Who moves first</div><div class="authtabs"><button data-sbturn="w" class="${S.turn === 'w' ? 'on' : ''}">White</button><button data-sbturn="b" class="${S.turn === 'b' ? 'on' : ''}">Black</button></div><div class="acts" style="margin-top:12px"><button data-sbclear>Clear the board</button></div>`}
      </div>${nt}</div></div></div>`;
    const keep = $('#sbNoteIn') ? $('#sbNoteIn').value : '', foc = document.activeElement && document.activeElement.id === 'sbNoteIn';
    setHTML(el(), html);
    if ($('#sbNoteIn') && keep) $('#sbNoteIn').value = keep; if (foc && $('#sbNoteIn')) $('#sbNoteIn').focus();
  };

  S.start = function () {
    S.st = state(); S.hist = []; S.sel = null; S.last = null; S.mode = 'play'; S.paint();
  };

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'sbNoteForm') return; e.preventDefault();
    const t = $('#sbNoteIn').value.trim(); if (!t) return; $('#sbNoteIn').value = ''; act('note', { text: t });
  });
  document.addEventListener('click', (e) => {
    if (view !== 'sandbox') return;
    const t = e.target, q = (s) => t.closest(s);
    let b;
    if (S.room) {
      if (q('[data-sbback]')) { const id = S.room; S.leaveRoom(); return Lounge.enter(id); }
      if ((b = q('[data-sbnd]'))) return act('ndel', { note: b.dataset.sbnd });
      if (q('[data-sbclear]')) return act('clear');
      if ((b = q('[data-sbturn]'))) return act('turn', { turn: b.dataset.sbturn });
      if ((b = q('[data-sbmode]'))) return act('mode', { mode: b.dataset.sbmode });
      if (q('[data-sbundo]')) return act('undo');
      if ((b = q('[data-sq]'))) {
        const i = +b.dataset.sq;
        if (S.mode === 'setup') return act('put', { sq: i, piece: S.pick === 'x' || S.board[i] === S.pick ? null : S.pick });
        if (S.sel != null && Chess.legalMoves(S.st).some((m) => m.from === S.sel && m.to === i)) { const from = S.sel; S.sel = null; return act('move', { from, to: i }); }
        const c = S.st.board[i]; S.sel = c && c[0] === S.st.turn && !over(S.st).over ? i : null; return S.paint();
      }
    }
    if ((b = q('[data-pick]'))) { S.pick = b.dataset.pick; return S.paint(); }
    if ((b = q('[data-sbturn]'))) { S.turn = b.dataset.sbturn; return S.paint(); }
    if (q('[data-sbclear]')) { S.board = new Array(64).fill(null); return S.paint(); }
    if ((b = q('[data-sbmode]'))) { if (b.dataset.sbmode === 'play') return S.start(); S.mode = 'setup'; S.sel = null; return S.paint(); }
    if (q('[data-sbundo]')) { if (S.hist.length) { const h = S.hist.pop(); S.st = h.st; S.last = h.last; S.sel = null; S.paint(); } return; }
    if ((b = q('[data-sq]'))) {
      const i = +b.dataset.sq;
      if (S.mode === 'setup') { S.board[i] = S.pick === 'x' || S.board[i] === S.pick ? null : S.pick; return S.paint(); }
      // play: pick up a piece of the side to move, or put it down on a square it can reach
      if (S.sel != null) {
        const ms = Chess.legalMoves(S.st).filter((m) => m.from === S.sel && m.to === i);
        if (ms.length) { const m = ms.find((x) => x.promo === 'Q') || ms[0]; S.hist.push({ st: S.st, last: S.last }); S.st = Chess.apply(S.st, m); S.last = { from: m.from, to: m.to }; S.sel = null; return S.paint(); }
      }
      const c = S.st.board[i]; S.sel = c && c[0] === S.st.turn && !over(S.st).over ? i : null; S.paint();
    }
  });
})();
