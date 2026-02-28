import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'store.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// ── In-memory stores ────────────────────────────────────────────────
let dataStore = {};   // { apiKey: { key: value, ... } }
let accounts = {};    // { email: { passwordHash, salt, apiKeys: [{ key, label, created, lastUsed }] } }
let sessions = {};    // { sessionToken: { email, created, expires } }

// ── Persistence ─────────────────────────────────────────────────────
function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) dataStore = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load data store:', e.message); dataStore = {}; }
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load accounts:', e.message); accounts = {}; }
  try {
    if (fs.existsSync(SESSIONS_FILE)) sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load sessions:', e.message); sessions = {}; }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(dataStore, null, 2));
}
function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// ── Helpers ─────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function generateKey(prefix = 'd2l') {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

function generateSession() {
  return crypto.randomBytes(48).toString('hex');
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5e6) reject(new Error('Payload too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getSessionFromReq(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/d2l_session=([^;]+)/);
  if (!match) return null;
  const token = match[1];
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() > session.expires) {
    delete sessions[token];
    saveSessions();
    return null;
  }
  return { token, ...session };
}

function getApiKeyFromReq(req) {
  return req.headers['x-api-key'] || null;
}

function findAccountByApiKey(apiKey) {
  for (const [email, account] of Object.entries(accounts)) {
    if (account.apiKeys.some(k => k.key === apiKey)) {
      return { email, account };
    }
  }
  return null;
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ── Clean expired sessions periodically ─────────────────────────────
setInterval(() => {
  let changed = false;
  for (const [token, session] of Object.entries(sessions)) {
    if (Date.now() > session.expires) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) saveSessions();
}, 60000);

// ── Router ──────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    });
    return res.end();
  }

  // ── Auth endpoints ──────────────────────────────────────────────
  if (pathname === '/auth/signup' && method === 'POST') {
    try {
      const { email, password } = JSON.parse(await readBody(req));
      if (!email || !password) return json(res, 400, { error: 'Email and password required' });
      if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
      const normalizedEmail = email.toLowerCase().trim();
      if (accounts[normalizedEmail]) return json(res, 409, { error: 'Account already exists' });

      const { hash, salt } = hashPassword(password);
      accounts[normalizedEmail] = { passwordHash: hash, salt, apiKeys: [], created: Date.now() };
      saveAccounts();

      const sessionToken = generateSession();
      sessions[sessionToken] = { email: normalizedEmail, created: Date.now(), expires: Date.now() + 7 * 86400000 };
      saveSessions();

      return json(res, 201, {
        success: true,
        session: sessionToken,
        email: normalizedEmail,
      });
    } catch (e) {
      return json(res, 400, { error: 'Invalid request body' });
    }
  }

  if (pathname === '/auth/login' && method === 'POST') {
    try {
      const { email, password } = JSON.parse(await readBody(req));
      const normalizedEmail = email.toLowerCase().trim();
      const account = accounts[normalizedEmail];
      if (!account) return json(res, 401, { error: 'Invalid credentials' });

      const { hash } = hashPassword(password, account.salt);
      if (hash !== account.passwordHash) return json(res, 401, { error: 'Invalid credentials' });

      const sessionToken = generateSession();
      sessions[sessionToken] = { email: normalizedEmail, created: Date.now(), expires: Date.now() + 7 * 86400000 };
      saveSessions();

      return json(res, 200, { success: true, session: sessionToken, email: normalizedEmail });
    } catch (e) {
      return json(res, 400, { error: 'Invalid request body' });
    }
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    const session = getSessionFromReq(req);
    if (session) {
      delete sessions[session.token];
      saveSessions();
    }
    return json(res, 200, { success: true });
  }

  if (pathname === '/auth/me' && method === 'GET') {
    const session = getSessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Not authenticated' });
    const account = accounts[session.email];
    return json(res, 200, {
      email: session.email,
      apiKeys: (account.apiKeys || []).map(k => ({
        key: k.key.slice(0, 8) + '...' + k.key.slice(-4),
        fullKey: k.key,
        label: k.label,
        created: k.created,
        lastUsed: k.lastUsed,
      })),
      created: account.created,
    });
  }

  // ── API Key management (session-authenticated) ──────────────────
  if (pathname === '/keys' && method === 'POST') {
    const session = getSessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Not authenticated' });
    try {
      const { label } = JSON.parse(await readBody(req));
      const apiKey = generateKey();
      const account = accounts[session.email];
      account.apiKeys.push({ key: apiKey, label: label || 'Untitled', created: Date.now(), lastUsed: null });
      dataStore[apiKey] = {};
      saveAccounts();
      saveData();
      return json(res, 201, { key: apiKey, label: label || 'Untitled' });
    } catch (e) {
      return json(res, 400, { error: 'Invalid request body' });
    }
  }

  if (pathname === '/keys' && method === 'GET') {
    const session = getSessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Not authenticated' });
    const account = accounts[session.email];
    return json(res, 200, {
      keys: (account.apiKeys || []).map(k => ({
        key: k.key,
        label: k.label,
        created: k.created,
        lastUsed: k.lastUsed,
        entryCount: Object.keys(dataStore[k.key] || {}).length,
      })),
    });
  }

  if (pathname.startsWith('/keys/') && method === 'DELETE') {
    const session = getSessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Not authenticated' });
    const keyToDelete = pathname.slice(6);
    const account = accounts[session.email];
    const idx = account.apiKeys.findIndex(k => k.key === keyToDelete);
    if (idx === -1) return json(res, 404, { error: 'API key not found' });
    account.apiKeys.splice(idx, 1);
    delete dataStore[keyToDelete];
    saveAccounts();
    saveData();
    return json(res, 200, { success: true });
  }

  // ── Data API (API-key authenticated) ────────────────────────────
  if (pathname.startsWith('/api/data')) {
    const apiKey = getApiKeyFromReq(req);
    if (!apiKey) return json(res, 401, { error: 'X-API-Key header required' });

    const ownerInfo = findAccountByApiKey(apiKey);
    if (!ownerInfo) return json(res, 403, { error: 'Invalid API key' });

    // Update lastUsed
    const keyObj = ownerInfo.account.apiKeys.find(k => k.key === apiKey);
    if (keyObj) { keyObj.lastUsed = Date.now(); saveAccounts(); }

    if (!dataStore[apiKey]) dataStore[apiKey] = {};
    const store = dataStore[apiKey];

    const dataPath = pathname.replace('/api/data', '').replace(/^\//, '');

    // GET /api/data — list all keys
    if (!dataPath && method === 'GET') {
      return json(res, 200, {
        keys: Object.keys(store),
        count: Object.keys(store).length,
      });
    }

    // GET /api/data/:key — get value
    if (dataPath && method === 'GET') {
      const key = decodeURIComponent(dataPath);
      if (!(key in store)) return json(res, 404, { error: 'Key not found' });
      return json(res, 200, { key, value: store[key] });
    }

    // PUT /api/data/:key — set value
    if (dataPath && method === 'PUT') {
      try {
        const key = decodeURIComponent(dataPath);
        const body = JSON.parse(await readBody(req));
        store[key] = body.value !== undefined ? body.value : body;
        saveData();
        return json(res, 200, { key, success: true });
      } catch (e) {
        return json(res, 400, { error: 'Invalid JSON body' });
      }
    }

    // POST /api/data/:key — alias for PUT
    if (dataPath && method === 'POST') {
      try {
        const key = decodeURIComponent(dataPath);
        const body = JSON.parse(await readBody(req));
        store[key] = body.value !== undefined ? body.value : body;
        saveData();
        return json(res, 200, { key, success: true });
      } catch (e) {
        return json(res, 400, { error: 'Invalid JSON body' });
      }
    }

    // DELETE /api/data/:key — delete key
    if (dataPath && method === 'DELETE') {
      const key = decodeURIComponent(dataPath);
      if (!(key in store)) return json(res, 404, { error: 'Key not found' });
      delete store[key];
      saveData();
      return json(res, 200, { key, deleted: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  // ── Static files ────────────────────────────────────────────────
  if (method === 'GET') {
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveStatic(res, filePath);
    }
    // SPA fallback
    return serveStatic(res, path.join(__dirname, 'public', 'index.html'));
  }

  json(res, 404, { error: 'Not found' });
}

// ── Start ───────────────────────────────────────────────────────────
loadFromDisk();
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`✦ data2l.ink running on port ${PORT}`);
  console.log(`  ${Object.keys(accounts).length} accounts loaded`);
  console.log(`  ${Object.keys(dataStore).length} API key stores loaded`);
});
