// Optional token gate, for exposing the board beyond localhost (Tailscale).
// Token comes from KFK_TOKEN or data/auth-token. No token → no gate, and the
// server refuses to bind beyond 127.0.0.1 (the runner executes code; an open
// port would be remote code execution for anyone who can reach it).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_FILE = path.join(__dirname, '..', 'data', 'auth-token');

function getToken() {
  if (process.env.KFK_TOKEN) return process.env.KFK_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function tokenMatches(candidate, token) {
  if (!candidate || candidate.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kungfu Kanban — sign in</title>
<style>
  body{background:#141210;color:#ECE5D6;font-family:-apple-system,'Instrument Sans',sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  form{background:#1C1916;border:2px solid #ECE5D6;border-radius:4px;box-shadow:6px 6px 0 rgba(0,0,0,.85);
    padding:28px;display:flex;flex-direction:column;gap:12px;width:min(340px,90vw)}
  h1{font-size:20px;margin:0;letter-spacing:-.01em}
  p{margin:0;font-size:13px;color:#978F80}
  input{background:#141210;border:1px solid rgba(236,229,214,.14);border-radius:2px;color:#ECE5D6;
    padding:10px;font-family:ui-monospace,monospace;font-size:13px}
  button{background:#E0524A;border:1px solid #E8776F;border-radius:2px;color:#141210;font-weight:600;
    padding:10px;cursor:pointer;box-shadow:0 2px 0 #E8776F}button:active{transform:translateY(2px);box-shadow:none}
  .err{color:#E06C5F;font-size:12.5px}
</style></head><body>
<form method="POST" action="/login">
  <h1>🥋 Kungfu Kanban</h1>
  <p>This board can run code. Enter the access token from <code>data/auth-token</code> on the host machine.</p>
  __ERR__
  <input type="password" name="token" placeholder="access token" autofocus autocomplete="current-password">
  <button type="submit">Enter the dojo</button>
</form></body></html>`;

function install(app) {
  app.get('/login', (req, res) => {
    res.type('html').send(LOGIN_PAGE.replace('__ERR__', ''));
  });
  app.post('/login', require('express').urlencoded({ extended: false }), (req, res) => {
    const token = getToken();
    const candidate = (req.body && req.body.token || '').trim();
    if (token && tokenMatches(candidate, token)) {
      res.setHeader(
        'Set-Cookie',
        `kk_auth=${encodeURIComponent(candidate)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      );
      return res.redirect('/');
    }
    res.status(401).type('html').send(LOGIN_PAGE.replace('__ERR__', '<span class="err">✕ wrong token</span>'));
  });

  app.use((req, res, next) => {
    const token = getToken();
    if (!token) return next(); // no token configured → local-only mode, no gate
    if (req.path === '/login') return next();
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (tokenMatches(parseCookies(req).kk_auth, token) || tokenMatches(bearer, token)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
    res.redirect('/login');
  });
}

module.exports = { install, getToken, TOKEN_FILE };
