import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { jjfsNavigate, parseTarget, countFiles, jjfsRead, jjfsWrite, jjfsEdit, jjfsDelete, jjfsMove, jjfsCopy } from './jjfs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_FILE       = path.join(__dirname, 'store.json');
const ACCOUNTS_FILE   = path.join(__dirname, 'accounts.json');
const SESSIONS_FILE   = path.join(__dirname, 'sessions.json');
const WORKSPACES_FILE = path.join(__dirname, 'workspaces.json');

// ── In-memory stores ────────────────────────────────────────────────
let dataStore  = {};   // { email: { key: value, ... } }
let accounts   = {};   // { email: { passwordHash, salt, apiKeys: [{ key, label, created, lastUsed }] } }
let sessions   = {};   // { sessionToken: { email, created, expires } }
let workspaces = {};   // { email: { wsName: { path: content | dir } } }

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
  try {
    if (fs.existsSync(WORKSPACES_FILE)) workspaces = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load workspaces:', e.message); workspaces = {}; }
}

function saveData()       { fs.writeFileSync(DATA_FILE,       JSON.stringify(dataStore,  null, 2)); }
function saveAccounts()   { fs.writeFileSync(ACCOUNTS_FILE,   JSON.stringify(accounts,   null, 2)); }
function saveSessions()   { fs.writeFileSync(SESSIONS_FILE,   JSON.stringify(sessions,   null, 2)); }
function saveWorkspaces() { fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2)); }

// ── Generic helpers ──────────────────────────────────────────────────
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
  });
  res.end(JSON.stringify(data));
}

function text(res, status, content) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
  });
  res.end(content);
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
    if (account.apiKeys.some(k => k.key === apiKey)) return { email, account };
  }
  return null;
}

function serveStatic(res, filePath) {
  const mimeTypes = {
    '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff',
  };
  const contentType = mimeTypes[path.extname(filePath)] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// Ensure a default workspace and KV store exist for an account.
function provisionAccount(email) {
  let dirty = false;
  if (!workspaces[email]) { workspaces[email] = { default: {} }; dirty = true; }
  if (!dataStore[email])  { dataStore[email]  = {};               dirty = true; }
  if (dirty) { saveWorkspaces(); saveData(); }
}

// ── Session GC ───────────────────────────────────────────────────────
setInterval(() => {
  let changed = false;
  for (const [token, session] of Object.entries(sessions)) {
    if (Date.now() > session.expires) { delete sessions[token]; changed = true; }
  }
  if (changed) saveSessions();
}, 60000);

// ── Router ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    });
    return res.end();
  }

  // ── Auth ───────────────────────────────────────────────────────────
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

      return json(res, 201, { success: true, session: sessionToken, email: normalizedEmail });
    } catch { return json(res, 400, { error: 'Invalid request body' }); }
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
    } catch { return json(res, 400, { error: 'Invalid request body' }); }
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    const session = getSessionFromReq(req);
    if (session) { delete sessions[session.token]; saveSessions(); }
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

  // ── API Key management (session-authenticated) ─────────────────────
  if (pathname === '/keys' && method === 'POST') {
    const session = getSessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Not authenticated' });
    try {
      const body = JSON.parse(await readBody(req));
      const { label, permissions: reqPerms } = body;
      const apiKey = generateKey();
      const account = accounts[session.email];
      const permissions = {
        kv: reqPerms?.kv !== false,
        fs: reqPerms?.fs !== false,
        workspaces: Array.isArray(reqPerms?.workspaces) ? reqPerms.workspaces : '*',
        paths: (reqPerms?.paths && typeof reqPerms.paths === 'object') ? reqPerms.paths : {},
      };
      account.apiKeys.push({ key: apiKey, label: label || 'Untitled', created: Date.now(), lastUsed: null, permissions });
      provisionAccount(session.email);
      saveAccounts();
      return json(res, 201, { key: apiKey, label: label || 'Untitled' });
    } catch { return json(res, 400, { error: 'Invalid request body' }); }
  }

  if (pathname === '/keys' && method === 'GET') {
    const session = getSessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Not authenticated' });
    const account = accounts[session.email];
    return json(res, 200, {
      availableWorkspaces: Object.keys(workspaces[session.email] || {}),
      keys: (account.apiKeys || []).map(k => ({
        key: k.key,
        label: k.label,
        created: k.created,
        lastUsed: k.lastUsed,
        permissions: k.permissions ?? { kv: true, fs: true, workspaces: '*', paths: {} },
        entryCount: Object.keys(dataStore[session.email] || {}).length,
        wsCount: Object.keys(workspaces[session.email] || {}).length,
        fsFileCount: Object.values(workspaces[session.email] || {}).reduce((sum, ws) => sum + countFiles(ws), 0),
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
    saveAccounts();
    return json(res, 200, { success: true });
  }

  // ── Flat KV store (API-key authenticated) ──────────────────────────
  if (pathname.startsWith('/api/data')) {
    const apiKey = getApiKeyFromReq(req);
    if (!apiKey) return json(res, 401, { error: 'X-API-Key header required' });

    const ownerInfo = findAccountByApiKey(apiKey);
    if (!ownerInfo) return json(res, 403, { error: 'Invalid API key' });

    const keyObj = ownerInfo.account.apiKeys.find(k => k.key === apiKey);
    if (keyObj) { keyObj.lastUsed = Date.now(); saveAccounts(); }

    const permsKv = keyObj?.permissions ?? { kv: true };
    if (!permsKv.kv) return json(res, 403, { error: 'This API key does not have KV store access' });

    provisionAccount(ownerInfo.email);
    const store = dataStore[ownerInfo.email];
    const dataPath = pathname.replace('/api/data', '').replace(/^\//, '');

    if (!dataPath && method === 'GET')
      return json(res, 200, { keys: Object.keys(store), count: Object.keys(store).length });

    if (dataPath && method === 'GET') {
      const key = decodeURIComponent(dataPath);
      if (!(key in store)) return json(res, 404, { error: 'Key not found' });
      return json(res, 200, { key, value: store[key] });
    }

    if (dataPath && (method === 'PUT' || method === 'POST')) {
      try {
        const key = decodeURIComponent(dataPath);
        const body = JSON.parse(await readBody(req));
        store[key] = body.value !== undefined ? body.value : body;
        saveData();
        return json(res, 200, { key, success: true });
      } catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    }

    if (dataPath && method === 'DELETE') {
      const key = decodeURIComponent(dataPath);
      if (!(key in store)) return json(res, 404, { error: 'Key not found' });
      delete store[key];
      saveData();
      return json(res, 200, { key, deleted: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  // ── JJFS file system (API-key or session authenticated) ────────────
  if (pathname.startsWith('/api/fs')) {
    const apiKey = getApiKeyFromReq(req);
    let wsForKey, perms;

    if (apiKey) {
      const ownerInfo = findAccountByApiKey(apiKey);
      if (!ownerInfo) return json(res, 403, { error: 'Invalid API key' });
      const keyObj = ownerInfo.account.apiKeys.find(k => k.key === apiKey);
      if (keyObj) { keyObj.lastUsed = Date.now(); saveAccounts(); }
      perms = keyObj?.permissions ?? { kv: true, fs: true, workspaces: '*', paths: {} };
      if (!perms.fs) return json(res, 403, { error: 'This API key does not have filesystem access' });
      provisionAccount(ownerInfo.email);
      wsForKey = workspaces[ownerInfo.email];
    } else {
      const session = getSessionFromReq(req);
      if (!session) return json(res, 401, { error: 'X-API-Key header required' });
      provisionAccount(session.email);
      wsForKey = workspaces[session.email];
      perms = { kv: true, fs: true, workspaces: '*', paths: {} };
    }

    // POST /api/fs/execute — perform a JJFS operation
    if (pathname === '/api/fs/execute' && method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const { type, target, content } = body;
      if (!type || !target) return json(res, 400, { error: 'type and target are required' });

      const parsed = parseTarget(target, type === 'JJFS_READ');
      if (parsed.error) return json(res, 400, { error: parsed.error });
      const { wsName, filePath, startLine, endLine } = parsed;

      let result;
      switch (type) {
        case 'JJFS_READ':
          result = jjfsRead(wsForKey, wsName, filePath, startLine, endLine);
          break;

        case 'JJFS_WRITE':
          if (content === undefined || content === null)
            return json(res, 400, { error: 'content is required for JJFS_WRITE' });
          if (!wsForKey[wsName]) wsForKey[wsName] = {};
          result = jjfsWrite(wsForKey, wsName, filePath, content);
          if (result.success) saveWorkspaces();
          break;

        case 'JJFS_EDIT': {
          let op;
          try { op = typeof content === 'string' ? JSON.parse(content) : content; }
          catch { return json(res, 400, { error: 'content must be JSON with {search, replace} for JJFS_EDIT' }); }
          if (!op || op.search === undefined || op.replace === undefined)
            return json(res, 400, { error: 'JJFS_EDIT content must have search and replace fields' });
          result = jjfsEdit(wsForKey, wsName, filePath, op.search, op.replace);
          if (result.success) saveWorkspaces();
          break;
        }

        case 'JJFS_DELETE':
          result = jjfsDelete(wsForKey, wsName, filePath);
          if (result.success) {
            if (wsName !== 'default' && Object.keys(wsForKey[wsName] || {}).length === 0)
              delete wsForKey[wsName];
            saveWorkspaces();
          }
          break;

        case 'JJFS_MOVE':
          if (!content) return json(res, 400, { error: 'content (destination path) is required for JJFS_MOVE' });
          result = jjfsMove(wsForKey, wsName, filePath, content);
          if (result.success) saveWorkspaces();
          break;

        case 'JJFS_COPY':
          if (!content) return json(res, 400, { error: 'content (destination path) is required for JJFS_COPY' });
          result = jjfsCopy(wsForKey, wsName, filePath, content);
          if (result.success) saveWorkspaces();
          break;

        default:
          return json(res, 400, { error: `Unknown operation type: ${type}` });
      }

      return json(res, result.success ? 200 : 400, result);
    }

    // GET /api/fs/workspaces — list workspaces for this API key
    if (pathname === '/api/fs/workspaces' && method === 'GET') {
      const wsList = Object.entries(wsForKey)
        .filter(([name]) => perms.workspaces === '*' || perms.workspaces.includes(name))
        .map(([name, tree]) => ({ name, fileCount: countFiles(tree) }));
      return json(res, 200, { workspaces: wsList, count: wsList.length });
    }

    // POST /api/fs/workspaces — create a new workspace
    if (pathname === '/api/fs/workspaces' && method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }
      const { name } = body;
      if (!name) return json(res, 400, { error: 'name is required' });
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
        return json(res, 400, { error: 'Workspace name must start with a letter or digit and contain only: a-z 0-9 _ -' });
      if (wsForKey[name]) return json(res, 409, { error: `Workspace already exists: ${name}` });
      wsForKey[name] = {};
      saveWorkspaces();
      return json(res, 201, { success: true, name });
    }

    // DELETE /api/fs/workspaces/:name — delete a workspace (default is protected)
    if (pathname.startsWith('/api/fs/workspaces/') && method === 'DELETE') {
      const wsName = decodeURIComponent(pathname.slice('/api/fs/workspaces/'.length));
      if (wsName === 'default') return json(res, 403, { error: 'Cannot delete the default workspace' });
      if (!wsForKey[wsName]) return json(res, 404, { error: `Workspace not found: ${wsName}` });
      delete wsForKey[wsName];
      saveWorkspaces();
      return json(res, 200, { success: true });
    }

    // GET /api/fs/browse?workspace=name&path=/dir — structured directory browse
    if (pathname === '/api/fs/browse' && method === 'GET') {
      const wsName = url.searchParams.get('workspace') || 'default';
      const browsePath = url.searchParams.get('path') || '/';
      const ws = wsForKey[wsName];
      if (!ws) return json(res, 404, { error: `Workspace not found: ${wsName}` });

      const trimmed = browsePath.replace(/^\//, '');
      let targetNode = ws;

      if (trimmed) {
        const nav = jjfsNavigate(ws, browsePath);
        if (nav.error) return json(res, 400, { error: nav.error });
        const { parent, name } = nav;
        if (!(name in parent)) return json(res, 404, { error: `Not found: ${browsePath}` });
        targetNode = parent[name];
        if (typeof targetNode === 'string') {
          return json(res, 200, {
            success: true, workspace: wsName, path: browsePath,
            type: 'file', content: targetNode,
          });
        }
      }

      const entries = Object.entries(targetNode).map(([n, v]) => ({
        name: n,
        type: typeof v === 'object' ? 'directory' : 'file',
        ...(typeof v === 'string' ? { size: v.length } : { fileCount: countFiles(v) }),
      }));
      return json(res, 200, {
        success: true, workspace: wsName, path: browsePath,
        type: 'directory', entries,
      });
    }

    // REST: GET|PUT|PATCH|DELETE|POST /api/fs/:workspace/*path
    if (pathname.startsWith('/api/fs/')) {
      const fsSubpath = pathname.slice('/api/fs/'.length);
      const slashIdx  = fsSubpath.indexOf('/');
      const wsName    = slashIdx === -1 ? fsSubpath : fsSubpath.slice(0, slashIdx);
      const filePath  = slashIdx === -1 ? '/' : fsSubpath.slice(slashIdx);
      if (!wsName) return json(res, 404, { error: 'Not found' });

      if (perms.workspaces !== '*' && !perms.workspaces.includes(wsName))
        return json(res, 403, { error: `This API key does not have access to workspace: ${wsName}` });
      const pathRestriction = (perms.paths || {})[wsName];
      if (pathRestriction) {
        const allowed = (Array.isArray(pathRestriction) ? pathRestriction : [pathRestriction])
          .map(p => p.replace(/\/$/, ''))
          .filter(p => p && p !== '');
        if (allowed.length > 0 && !allowed.some(a => filePath === a || filePath.startsWith(a + '/')))
          return json(res, 403, { error: `This API key is restricted to specific paths in workspace: ${wsName}` });
      }

      if (method === 'GET') {
        if (!wsForKey[wsName]) return json(res, 404, { error: `Workspace not found: ${wsName}` });
        const ws = wsForKey[wsName];
        const trimmed = filePath.replace(/^\//, '');
        let targetNode;
        if (!trimmed) {
          targetNode = ws;
        } else {
          const nav = jjfsNavigate(ws, filePath);
          if (nav.error) return json(res, 404, { error: nav.error });
          const { parent, name } = nav;
          if (!(name in parent)) return json(res, 404, { error: `Not found: ${filePath}` });
          targetNode = parent[name];
        }
        if (typeof targetNode === 'object') {
          const entries = Object.entries(targetNode).map(([n, v]) => ({
            name: n, type: typeof v === 'object' ? 'directory' : 'file',
            ...(typeof v === 'string' ? { size: v.length } : { fileCount: countFiles(v) }),
          }));
          return json(res, 200, { type: 'directory', workspace: wsName, path: filePath, entries });
        }
        let content = String(targetNode);
        const start = url.searchParams.get('start');
        const end   = url.searchParams.get('end');
        if (start && end) {
          const lines = content.split('\n');
          content = lines.slice(Math.max(0, parseInt(start) - 1), Math.min(lines.length, parseInt(end))).join('\n');
        }
        return text(res, 200, content);
      }

      if (method === 'PUT') {
        if (!wsForKey[wsName]) wsForKey[wsName] = {};
        const content = await readBody(req);
        const r = jjfsWrite(wsForKey, wsName, filePath, content);
        if (r.success) saveWorkspaces();
        return json(res, r.success ? 200 : 400, r);
      }

      if (method === 'DELETE') {
        const r = jjfsDelete(wsForKey, wsName, filePath);
        if (r.success) {
          if (wsName !== 'default' && Object.keys(wsForKey[wsName] || {}).length === 0)
            delete wsForKey[wsName];
          saveWorkspaces();
        }
        return json(res, r.success ? 200 : 404, r);
      }

      if (method === 'PATCH') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'Invalid JSON body' }); }
        const { search, replace } = body;
        if (search === undefined || replace === undefined)
          return json(res, 400, { error: 'search and replace are required' });
        const r = jjfsEdit(wsForKey, wsName, filePath, search, replace);
        if (r.success) saveWorkspaces();
        return json(res, r.success ? 200 : 400, r);
      }

      if (method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'Invalid JSON body' }); }
        const { op, destination } = body;
        if (!op || !destination) return json(res, 400, { error: 'op and destination are required' });
        let r;
        if (op === 'move')      r = jjfsMove(wsForKey, wsName, filePath, destination);
        else if (op === 'copy') r = jjfsCopy(wsForKey, wsName, filePath, destination);
        else return json(res, 400, { error: `Unknown op: ${op}. Use 'move' or 'copy'` });
        if (r.success) saveWorkspaces();
        return json(res, r.success ? 200 : 400, r);
      }

      return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
  }

  // ── Static files ──────────────────────────────────────────────────
  if (method === 'GET') {
    const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveStatic(res, filePath);
    }
    return serveStatic(res, path.join(__dirname, 'index.html'));
  }

  json(res, 404, { error: 'Not found' });
}

// ── Migrate legacy per-API-key data to per-account ────────────────────
function migrateToAccountScoped() {
  let dirty = false;
  for (const [k, v] of Object.entries(dataStore)) {
    if (!k.startsWith('d2l_')) continue;
    const owner = findAccountByApiKey(k);
    if (!owner) { delete dataStore[k]; dirty = true; continue; }
    const email = owner.email;
    if (!dataStore[email]) dataStore[email] = {};
    Object.assign(dataStore[email], v);
    delete dataStore[k];
    dirty = true;
  }
  for (const [k, v] of Object.entries(workspaces)) {
    if (!k.startsWith('d2l_')) continue;
    const owner = findAccountByApiKey(k);
    if (!owner) { delete workspaces[k]; dirty = true; continue; }
    const email = owner.email;
    if (!workspaces[email]) workspaces[email] = {};
    for (const [ws, tree] of Object.entries(v)) {
      if (!workspaces[email][ws]) workspaces[email][ws] = tree;
    }
    delete workspaces[k];
    dirty = true;
  }
  if (dirty) { saveData(); saveWorkspaces(); }
}

// ── Start ─────────────────────────────────────────────────────────────
loadFromDisk();
migrateToAccountScoped();
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  const totalFiles = Object.values(workspaces).reduce((sum, kw) =>
    sum + Object.values(kw).reduce((s, ws) => s + countFiles(ws), 0), 0);
  console.log(`✦ data2l.ink running on port ${PORT}`);
  console.log(`  ${Object.keys(accounts).length} accounts loaded`);
  console.log(`  ${Object.keys(dataStore).length} KV stores | ${Object.keys(workspaces).length} FS stores (${totalFiles} files)`);
});
