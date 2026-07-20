// Optional token gate, for exposing the board beyond localhost (Tailscale).
// Token comes from KFK_TOKEN or data/auth-token. No token → no gate, and the
// server refuses to bind beyond 127.0.0.1 (the runner executes code; an open
// port would be remote code execution for anyone who can reach it).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

const TOKEN_FILE = path.join(DATA_DIR, 'auth-token');

function getToken() {
  if (process.env.KFK_TOKEN) return process.env.KFK_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function tokenMatches(candidate, token) {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const raw = part.slice(i + 1).trim();
      let val;
      try {
        val = decodeURIComponent(raw);
      } catch {
        val = raw;
      }
      out[part.slice(0, i).trim()] = val;
    }
  }
  return out;
}

// Same "Ink & Tape" palette as the app, honoring the saved kk-theme (and the
// OS preference on first visit) so a day-dojo user doesn't hit a night wall.
const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kungfu Kanban — sign in</title>
<script>try{var s=localStorage.getItem('kk-theme');
if(s==='light'||(!s&&matchMedia('(prefers-color-scheme: light)').matches))document.documentElement.dataset.theme='light'}catch(e){}</script>
<style>
  :root{--bg:#141210;--panel:#1C1916;--ink:#ECE5D6;--sub:#978F80;--rule:rgba(236,229,214,.14);
    --strong:#ECE5D6;--accent:#E0524A;--accent2:#E8776F;--on:#141210;--err:#E06C5F;--shadow:rgba(0,0,0,.85);color-scheme:dark}
  [data-theme='light']{--bg:#F6F2E9;--panel:#FDFBF5;--ink:#1A1714;--sub:#5F594F;--rule:rgba(26,23,20,.16);
    --strong:#1A1714;--accent:#C1272D;--accent2:#A31F24;--on:#FDFBF5;--err:#8F1D1D;--shadow:rgba(26,23,20,.92);color-scheme:light}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,'Instrument Sans',sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;margin:0}
  form{background:var(--panel);border:2px solid var(--strong);border-radius:4px;box-shadow:6px 6px 0 var(--shadow);
    padding:28px;display:flex;flex-direction:column;gap:12px;width:min(360px,90vw)}
  h1{font-size:20px;margin:0;letter-spacing:-.01em}
  p{margin:0;font-size:13px;color:var(--sub)}
  input{background:var(--bg);border:1px solid var(--rule);border-radius:2px;color:var(--ink);
    padding:10px;font-family:ui-monospace,monospace;font-size:13px}
  button{background:var(--accent);border:1px solid var(--accent2);border-radius:2px;color:var(--on);font-weight:600;
    padding:10px;cursor:pointer;box-shadow:0 2px 0 var(--accent2)}button:active{transform:translateY(2px);box-shadow:none}
  .err{color:var(--err);font-size:12.5px}
  code,pre{font-family:ui-monospace,monospace;font-size:12px;background:var(--bg);border:1px solid var(--rule);
    border-radius:2px;padding:1px 5px}
  pre{padding:8px 10px;margin:0;user-select:all;overflow-x:auto}
  .hint{font-size:12px}
</style></head><body>
<form method="POST" action="/login">
  <h1>🥋 Kungfu Kanban</h1>
  <p>This board can run code. Enter the access token from <code>data/auth-token</code> on the host machine.</p>
  __ERR__
  <input type="password" name="token" placeholder="access token" autofocus autocomplete="current-password">
  <button type="submit">Enter the dojo</button>
  <p class="hint">No token yet? Create one on the host, then restart nothing — it's read per request:</p>
  <pre>openssl rand -hex 16 &gt; data/auth-token</pre>
</form></body></html>`;

// Brute-force damper: 5 straight failures from one address locks login for a
// minute, and the page says so instead of silently repainting.
const loginFailures = new Map(); // ip → { count, lockedUntil }
const LOCK_AFTER = 5;
const LOCK_MS = 60_000;

function loginPage(res, status, err) {
  res.status(status).type('html').send(LOGIN_PAGE.replace('__ERR__', err ? `<span class="err">${err}</span>` : ''));
}

function install(app) {
  app.get('/login', (req, res) => loginPage(res, 200, ''));
  app.post('/login', require('express').urlencoded({ extended: false }), (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const rec = loginFailures.get(ip) || { count: 0, lockedUntil: 0 };
    if (rec.lockedUntil > Date.now()) {
      const wait = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
      return loginPage(res, 429, `✕ too many attempts — try again in ${wait}s`);
    }
    const token = getToken();
    const candidate = (req.body && req.body.token || '').trim();
    if (token && tokenMatches(candidate, token)) {
      loginFailures.delete(ip);
      res.setHeader(
        'Set-Cookie',
        `kk_auth=${encodeURIComponent(candidate)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      );
      return res.redirect('/');
    }
    rec.count += 1;
    if (rec.count >= LOCK_AFTER) {
      rec.count = 0;
      rec.lockedUntil = Date.now() + LOCK_MS;
      loginFailures.set(ip, rec);
      return loginPage(res, 429, `✕ too many attempts — locked for ${Math.round(LOCK_MS / 1000)}s`);
    }
    loginFailures.set(ip, rec);
    loginPage(res, 401, `✕ wrong token (${LOCK_AFTER - rec.count} tr${LOCK_AFTER - rec.count === 1 ? 'y' : 'ies'} before a cooldown)`);
  });

  // sign out: clear this device's cookie (the token itself stays valid)
  app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'kk_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.redirect('/login');
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
