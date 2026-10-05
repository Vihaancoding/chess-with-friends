// Local dev server: node server.js  (on Vercel, api/index.js + public/ are used instead)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const handler = require('./lib/app');
const store = require('./lib/store');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') return handler(req, res);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ♞ Chess is running! (${store.persistent ? 'Redis storage' : 'in-memory storage — resets on restart'})\n`);
  console.log(`  You:      http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Friends on your Wi-Fi: http://${i.address}:${PORT}`);
  console.log('');
});
