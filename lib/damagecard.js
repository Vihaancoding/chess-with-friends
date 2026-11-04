// The Damage Report share card: a broadcast-style stat card drawn on the server from a stored card, so it cannot be
// faked from a browser. svgOf() builds the picture (1080x1350 portrait or 1200x630 for link previews) and pngOf()
// turns it into a PNG with the fonts bundled in lib/fonts (Oswald and Inter, SIL Open Font License).
// Five text groups at most: the header, the matchup, the score, the line (with its detail) and the footer.
const fs = require('fs');
const path = require('path');

const FMT = { portrait: { w: 1080, h: 1350 }, wide: { w: 1200, h: 630 } };
// one strong accent per card: bone for Dominant, red for Brutal and Complete domination, green for a comeback
const ACCENT = { slight: '#9a9892', dominant: '#d8d6c4', brutal: '#d9534a', complete: '#e5392d', comeback: '#81b64c' };
const GREEN = '#81b64c', RED = '#d9534a', INK = '#1b1a18', PAPER = '#f2f1ec', MUTED = '#a09f9d';
const HEAD = "Oswald, 'Arial Narrow', Impact, sans-serif", BODY = "Inter, 'Helvetica Neue', Arial, sans-serif";

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// widths are estimated (SVG has no text measuring): Oswald is narrow, Inter is wide
const fitName = (name, px, max) => { const per = px * 0.46, n = Math.max(3, Math.floor(max / per)); const s = String(name); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };
function wrap(text, px, maxW, maxLines) {
  const per = px * 0.56, per1 = Math.max(8, Math.floor(maxW / per)), words = String(text).split(/\s+/), lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > per1 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.length > maxLines ? null : lines;
}
// the biggest size that fits in maxLines
function fitLines(text, maxW, maxLines, sizes) {
  for (const px of sizes) { const l = wrap(text, px, maxW, maxLines); if (l) return { px, lines: l }; }
  const px = sizes[sizes.length - 1], l = wrap(text, px, maxW, 99).slice(0, maxLines); l[l.length - 1] = l[l.length - 1].replace(/\s*\S*$/, '…'); return { px, lines: l };
}
const dateOf = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
const verdict = (c) => (c.score >= 92 ? 'NO SURVIVORS' : 'FINISHED');

// the evaluation graph from the winner's side: above the line the winner is better
function timeline(c, x, y, w, h) {
  if (!c.tl || c.tl.length < 4) return '';
  const wc = c.result, sign = wc === 'w' ? 1 : -1, n = c.tl.length;
  const ys = c.tl.map((v) => Math.max(-1, Math.min(1, (sign * v) / 900)));
  const px = (i) => x + (i / (n - 1)) * w, py = (v) => y + h / 2 - v * (h / 2 - 4);
  const pts = ys.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const mid = y + h / 2;
  const up = `M${x},${mid} ` + ys.map((v, i) => `L${px(i).toFixed(1)},${py(Math.max(0, v)).toFixed(1)}`).join(' ') + ` L${x + w},${mid} Z`;
  const down = `M${x},${mid} ` + ys.map((v, i) => `L${px(i).toFixed(1)},${py(Math.min(0, v)).toFixed(1)}`).join(' ') + ` L${x + w},${mid} Z`;
  let mark = '';
  if (c.low && c.plies) {
    const i = Math.max(0, Math.min(n - 1, Math.round((c.low.ply / c.plies) * (n - 1)))), mx = px(i), my = py(ys[i]);
    const label = `Move ${c.low.move}: ${c.low.label}`, tw = label.length * 12.5, lx = Math.max(x, Math.min(x + w - tw, mx - tw / 2));
    mark = `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="7" fill="${RED}" stroke="${INK}" stroke-width="3"/><text x="${lx.toFixed(1)}" y="${y - 12}" font-family="${BODY}" font-weight="600" font-size="22" fill="${PAPER}" opacity=".9">${esc(label)}</text>`;
  }
  return `<g><path d="${up}" fill="${GREEN}" opacity=".22"/><path d="${down}" fill="${RED}" opacity=".3"/><line x1="${x}" y1="${mid}" x2="${x + w}" y2="${mid}" stroke="#ffffff" opacity=".18"/><polyline points="${pts}" fill="none" stroke="${PAPER}" stroke-width="3" stroke-linejoin="round" opacity=".85"/>${mark}</g>`;
}
function torn(w, y, dir, color, op) {            // a ragged strip along an edge
  let d = `M0,${y}`; let x = 0, k = 0;
  while (x < w) { x += 28 + ((k * 37) % 41); k++; d += ` L${Math.min(x, w)},${y + dir * (10 + ((k * 53) % 34))}`; }
  d += ` L${w},${y - dir * 400} L0,${y - dir * 400} Z`;
  return `<path d="${d}" fill="${color}" opacity="${op}"/>`;
}
function cracks(cx, cy, color) {
  const rays = [[-420, -300], [380, -260], [-460, 120], [440, 180], [-120, -430], [160, 420]];
  return `<g stroke="${color}" stroke-width="3" fill="none" opacity=".22" stroke-linejoin="bevel">${rays.map(([dx, dy], i) => { const m = [cx + dx * 0.4 + (i % 2 ? 14 : -18), cy + dy * 0.4 + 22], m2 = [cx + dx * 0.7 - 20, cy + dy * 0.7 - 10]; return `<path d="M${cx},${cy} L${m[0]},${m[1]} L${m2[0]},${m2[1]} L${cx + dx},${cy + dy}"/>`; }).join('')}</g>`;
}

function svgOf(c, fmt = 'portrait', site = 'chess.example') {
  const F = FMT[fmt] || FMT.portrait, W = F.w, H = F.h, wide = fmt === 'wide';
  const band = c.kind === 'comeback' ? 'comeback' : c.band, acc = ACCENT[band] || ACCENT.dominant;
  const wname = c.result === 'w' ? c.w : c.b, lname = c.result === 'w' ? c.b : c.w;
  const left = { name: c.w, rating: c.rw, win: c.result === 'w' }, right = { name: c.b, rating: c.rb, win: c.result === 'b' };
  const res = c.result === 'w' ? '1–0' : '0–1';
  const big = c.kind === 'comeback' ? 'COMEBACK' : String(c.score);
  const line = fitLines(c.line || c.headline || '', wide ? 640 : 900, wide ? 4 : 4, wide ? [38, 34, 30, 27] : [58, 52, 46, 42, 38]);
  const heavy = band === 'brutal' || band === 'complete';
  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  o += `<defs><pattern id="bd" width="120" height="120" patternUnits="userSpaceOnUse"><rect width="60" height="60" fill="#fff" opacity=".028"/><rect x="60" y="60" width="60" height="60" fill="#fff" opacity=".028"/></pattern>` +
    `<radialGradient id="vg" cx="50%" cy="42%" r="75%"><stop offset="0" stop-color="${band === 'complete' ? '#3a1512' : band === 'brutal' ? '#2d1a18' : '#2a2926'}"/><stop offset="1" stop-color="${INK}"/></radialGradient></defs>`;
  o += `<rect width="${W}" height="${H}" fill="url(#vg)"/><rect width="${W}" height="${H}" fill="url(#bd)"/>`;
  // a faint rook silhouette in the corner
  o += `<g opacity=".05" fill="#fff" transform="translate(${W - (wide ? 250 : 360)},${H - (wide ? 260 : 420)}) scale(${wide ? 0.9 : 1.4})"><path d="M30 0h20v18h18V0h20v18h18V0h20v40l-14 14v110l22 18v30H22v-30l22-18V54L30 40z"/></g>`;
  if (heavy) o += cracks(W / 2, wide ? 300 : 700, '#ffffff');
  if (band === 'brutal') o += torn(W, H, -1, '#7a2a24', 0.55) + torn(W, 0, 1, '#7a2a24', 0.35);
  if (band === 'complete') o += torn(W, H, -1, '#a8261d', 0.7) + torn(W, 0, 1, '#a8261d', 0.5);
  o += `<rect x="0" y="0" width="${wide ? 10 : W}" height="${wide ? H : 10}" fill="${acc}"/>`;

  const header = (x, y, anchorEnd) => `<text x="${x}" y="${y}" font-family="${HEAD}" font-weight="700" font-size="${wide ? 30 : 36}" fill="${PAPER}" letter-spacing="2">CHESS<tspan fill="${acc}">.</tspan><tspan fill="${MUTED}" font-size="${wide ? 20 : 22}" dx="18" letter-spacing="7">THE DAMAGE REPORT</tspan></text>`;
  const player = (p, x, y, r, anchor) => {
    const nm = fitName(p.name, wide ? 40 : 56, wide ? 190 : 330), tx = anchor === 'start' ? x + r + 18 : x - r - 18;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${p.win ? '#ebecd0' : '#3a3836'}" stroke="${p.win ? GREEN : RED}" stroke-width="${p.win ? 5 : 3}"/>` +
      `<text x="${x}" y="${y + r * 0.36}" font-family="${HEAD}" font-weight="700" font-size="${r * 1.05}" fill="${p.win ? '#302e2b' : '#e8e6e1'}" text-anchor="middle">${esc((p.name || '?')[0].toUpperCase())}</text>`;
  };
  const names = (p, x, y, anchor) => `<text x="${x}" y="${y}" font-family="${HEAD}" font-weight="700" font-size="${wide ? 40 : 56}" fill="${p.win ? PAPER : '#e49a93'}" text-anchor="${anchor}">${esc(fitName(p.name, wide ? 40 : 56, wide ? 190 : 330))}</text>` +
    `<text x="${x}" y="${y + (wide ? 30 : 44)}" font-family="${BODY}" font-weight="600" font-size="${wide ? 22 : 30}" fill="${p.win ? GREEN : MUTED}" text-anchor="${anchor}">${p.win ? 'WINNER' : ''}${p.rating ? `${p.win ? '  ' : ''}${esc(p.rating)}` : ''}</text>`;

  if (!wide) {
    o += header(70, 96);
    // the matchup
    o += player(left, 190, 330, 82) + player(right, W - 190, 330, 82);
    o += names(left, 190, 470, 'middle') + names(right, W - 190, 470, 'middle');
    o += `<text x="${W / 2}" y="372" font-family="${HEAD}" font-weight="700" font-size="150" fill="${PAPER}" text-anchor="middle">${res}</text>`;
    // the score
    const sy = 800;
    o += `<text x="${W / 2}" y="${sy}" font-family="${HEAD}" font-weight="700" font-size="${c.kind === 'comeback' ? 190 : 360}" fill="${PAPER}" text-anchor="middle" letter-spacing="-4">${esc(big)}</text>`;
    if (c.kind !== 'comeback') o += `<text x="${W / 2 + 330}" y="${sy - 12}" font-family="${HEAD}" font-weight="700" font-size="64" fill="${MUTED}">/100</text>`;
    o += `<text x="${W / 2}" y="${sy + 82}" font-family="${HEAD}" font-weight="700" font-size="58" fill="${acc}" text-anchor="middle" letter-spacing="9">${esc((c.kind === 'comeback' ? (c.swing ? `DOWN ${(Math.abs(c.swing) / 100).toFixed(1)} AND STILL WON` : 'COMEBACK') : c.label).toUpperCase())}</text>`;
    if (band === 'complete') o += `<g transform="rotate(-9 ${W / 2} ${sy - 120})"><rect x="${W / 2 - 330}" y="${sy - 245}" width="660" height="140" fill="none" stroke="${acc}" stroke-width="10" opacity=".92" rx="6"/><text x="${W / 2}" y="${sy - 138}" font-family="${HEAD}" font-weight="700" font-size="106" fill="${acc}" text-anchor="middle" opacity=".92" letter-spacing="8">${verdict(c)}</text></g>`;
    // the line and its detail
    const ly = 960, step = Math.round(line.px * 1.22);
    o += `<text font-family="${BODY}" font-weight="800" font-size="${line.px}" fill="${PAPER}" text-anchor="middle">${line.lines.map((t, i) => `<tspan x="${W / 2}" y="${ly + i * step}">${esc(t)}</tspan>`).join('')}</text>`;
    o += `<text x="${W / 2}" y="${ly + line.lines.length * step + 6}" font-family="${BODY}" font-weight="600" font-size="28" fill="${MUTED}" text-anchor="middle" letter-spacing="3">${esc((c.detail || '').toUpperCase())}</text>`;
    o += timeline(c, 80, 1215, W - 160, 66);
    o += `<text x="80" y="${H - 34}" font-family="${BODY}" font-weight="600" font-size="24" fill="${MUTED}" letter-spacing="2">${dateOf(c.at)}</text><text x="${W - 80}" y="${H - 34}" font-family="${BODY}" font-weight="600" font-size="24" fill="${MUTED}" text-anchor="end">Play at ${esc(site)}</text>`;
  } else {
    o += header(60, 66);
    // score on the left
    o += `<text x="250" y="${c.kind === 'comeback' ? 320 : 345}" font-family="${HEAD}" font-weight="700" font-size="${c.kind === 'comeback' ? 92 : 260}" fill="${PAPER}" text-anchor="middle" letter-spacing="-3">${esc(big)}</text>`;
    if (c.kind !== 'comeback') o += `<text x="250" y="395" font-family="${HEAD}" font-weight="700" font-size="30" fill="${MUTED}" text-anchor="middle" letter-spacing="6">OUT OF 100</text>`;
    o += `<text x="250" y="${c.kind === 'comeback' ? 380 : 450}" font-family="${HEAD}" font-weight="700" font-size="36" fill="${acc}" text-anchor="middle" letter-spacing="6">${esc((c.kind === 'comeback' ? 'COMEBACK' : c.label).toUpperCase())}</text>`;
    if (band === 'complete') o += `<g transform="rotate(-8 250 250)"><rect x="95" y="190" width="310" height="62" fill="none" stroke="${acc}" stroke-width="5" rx="4" opacity=".92"/><text x="250" y="236" font-family="${HEAD}" font-weight="700" font-size="44" fill="${acc}" text-anchor="middle" letter-spacing="5" opacity=".92">${verdict(c)}</text></g>`;
    // matchup on the right
    o += player(left, 540, 170, 40, 'start') + names(left, 596, 160, 'start');
    o += `<text x="900" y="188" font-family="${HEAD}" font-weight="700" font-size="76" fill="${PAPER}" text-anchor="middle">${res}</text>`;
    o += player(right, 1130, 170, 40, 'end') + names(right, 1074, 160, 'end');
    const ly = 292, step = Math.round(line.px * 1.24);
    o += `<text font-family="${BODY}" font-weight="800" font-size="${line.px}" fill="${PAPER}">${line.lines.map((t, i) => `<tspan x="500" y="${ly + i * step}">${esc(t)}</tspan>`).join('')}</text>`;
    o += `<text x="500" y="${ly + line.lines.length * step + 12}" font-family="${BODY}" font-weight="600" font-size="22" fill="${MUTED}" letter-spacing="2">${esc((c.detail || '').toUpperCase())}</text>`;
    o += timeline(c, 500, 540, 640, 46);
    o += `<text x="60" y="${H - 22}" font-family="${BODY}" font-weight="600" font-size="20" fill="${MUTED}" letter-spacing="2">${dateOf(c.at)}</text><text x="${W - 60}" y="${H - 22}" font-family="${BODY}" font-weight="600" font-size="20" fill="${MUTED}" text-anchor="end">Play at ${esc(site)}</text>`;
  }
  return o + '</svg>';
}

let Resvg = null, fontFiles = null;
function pngOf(svg, width) {
  if (Resvg === null) { try { Resvg = require('@resvg/resvg-js').Resvg; } catch (e) { Resvg = false; } }
  if (!Resvg) return null;                                                    // not installed: callers fall back to the SVG
  if (!fontFiles) fontFiles = ['Oswald_700Bold.ttf', 'Inter_600SemiBold.ttf', 'Inter_800ExtraBold.ttf'].map((f) => path.join(__dirname, 'fonts', f)).filter((f) => fs.existsSync(f));
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'Inter' } });
  return r.render().asPng();
}

module.exports = { svgOf, pngOf, FMT, ACCENT, esc, wrap, fitName };
