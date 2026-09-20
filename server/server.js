// Zero-dependency HTTP server. Binds to 0.0.0.0 so any device on the office LAN
// can reach it. Same code later runs behind nginx on Hostinger unchanged.
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { routes, fail } = require('./api');
const authz = require('./auth');
require('./migrate').migrate();

const PORT = Number(process.env.PORT || 4040);
const PUB  = path.join(__dirname, '..', 'public');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.png':'image/png' };

const readBody = req => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 12e6) { reject(new Error('body too large')); req.destroy(); } chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
                        catch { resolve({}); } });
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname.startsWith('/api/')) {
    try {
      const handler = routes[key];
      if (!handler) return fail(res, 404, `no route ${key}`);
      const user = authz.userFromCookie(req.headers.cookie);
      const body = req.method === 'POST' ? await readBody(req) : {};
      return handler(req, res, { body, user, req, url });
    } catch (e) {
      console.error('API error', key, e);
      if (!res.headersSent) fail(res, 500, e.message || 'server error');
      return;
    }
  }

  // static
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)) return fail(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) {                                  // SPA fallback
      return fs.readFile(path.join(PUB, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('\n  Swabha Financial Control System');
  console.log('  ' + '─'.repeat(46));
  console.log(`  On this computer :  http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  On the office LAN:  http://${ip}:${PORT}`));
  if (!authz.hasAnyUser()) console.log('\n  First run — open the link above to create your admin login.');
  console.log('');
});
