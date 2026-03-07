import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { jjfsNavigate, parseTarget, countFiles, jjfsRead, jjfsWrite, jjfsEdit, jjfsDelete, jjfsMove, jjfsCopy, normalizePath, getEffectivePermission, checkWriteAccess, checkReadAccess, checkOwnerAccess, checkStickyBit, removePermissionsUnder, jjfsChmod, jjfsChown, touchTimestamps, getTimestamps, removeTimestampsUnder, resolveSymlink, getSymlinksInDir, removeSymlinksUnder, jjfsSetSymlink, getXattrs, removeXattrsUnder, jjfsSetXattr, hashPermForResponse } from './jjfs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_FILE        = path.join(__dirname, 'store.json');
const ACCOUNTS_FILE    = path.join(__dirname, 'accounts.json');
const SESSIONS_FILE    = path.join(__dirname, 'sessions.json');
const WORKSPACES_FILE  = path.join(__dirname, 'workspaces.json');
const VISIBILITY_FILE  = path.join(__dirname, 'visibility.json');
const PERMISSIONS_FILE = path.join(__dirname, 'permissions.json');
const TIMESTAMPS_FILE  = path.join(__dirname, 'timestamps.json');
const SYMLINKS_FILE    = path.join(__dirname, 'symlinks.json');
const XATTRS_FILE      = path.join(__dirname, 'xattrs.json');

// ── In-memory stores ────────────────────────────────────────────────
let dataStore    = {};   // { email: { key: value, ... } }
let accounts     = {};   // { email: { passwordHash, salt, publicId, apiKeys: [...] } }
let sessions     = {};   // { sessionToken: { email, created, expires } }
let workspaces   = {};   // { email: { wsName: { path: content | dir } } }
let kvVisibility = {};   // { email: { kvKey: 'public' } }  — absence means private
let fsPermissions = {};  // { email: { "wsName:/path": { mode: "ro"|"rw"|octal, owner: apiKey|null } } }
let fsTimestamps  = {};  // { email: { "wsName:/path": { birthtime, mtime, ctime } } }
let fsSymlinks    = {};  // { email: { "wsName:/path": "/target/path" } }
let fsXattrs      = {};  // { email: { "wsName:/path": { "user.key": "value" } } }

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
  try {
    if (fs.existsSync(VISIBILITY_FILE)) kvVisibility = JSON.parse(fs.readFileSync(VISIBILITY_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load visibility:', e.message); kvVisibility = {}; }
  try {
    if (fs.existsSync(PERMISSIONS_FILE)) fsPermissions = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load permissions:', e.message); fsPermissions = {}; }
  try {
    if (fs.existsSync(TIMESTAMPS_FILE)) fsTimestamps = JSON.parse(fs.readFileSync(TIMESTAMPS_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load timestamps:', e.message); fsTimestamps = {}; }
  try {
    if (fs.existsSync(SYMLINKS_FILE)) fsSymlinks = JSON.parse(fs.readFileSync(SYMLINKS_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load symlinks:', e.message); fsSymlinks = {}; }
  try {
    if (fs.existsSync(XATTRS_FILE)) fsXattrs = JSON.parse(fs.readFileSync(XATTRS_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load xattrs:', e.message); fsXattrs = {}; }
}

function saveData()        { fs.writeFileSync(DATA_FILE,        JSON.stringify(dataStore,     null, 2)); }
function saveAccounts()    { fs.writeFileSync(ACCOUNTS_FILE,    JSON.stringify(accounts,      null, 2)); }
function saveSessions()    { fs.writeFileSync(SESSIONS_FILE,    JSON.stringify(sessions,      null, 2)); }
function saveWorkspaces()  { fs.writeFileSync(WORKSPACES_FILE,  JSON.stringify(workspaces,    null, 2)); }
function saveVisibility()  { fs.writeFileSync(VISIBILITY_FILE,  JSON.stringify(kvVisibility,  null, 2)); }
function savePermissions() { fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(fsPermissions, null, 2)); }
function saveTimestamps()  { fs.writeFileSync(TIMESTAMPS_FILE,  JSON.stringify(fsTimestamps,  null, 2)); }
function saveSymlinks()    { fs.writeFileSync(SYMLINKS_FILE,    JSON.stringify(fsSymlinks,    null, 2)); }
function saveXattrs()      { fs.writeFileSync(XATTRS_FILE,      JSON.stringify(fsXattrs,      null, 2)); }

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

// SHA-256 hex of an API key — used in all external responses to avoid leaking raw keys.
function hashKey(k) {
  return crypto.createHash('sha256').update(String(k)).digest('hex');
}

// Normalise a POSIX path: resolve `.` and `..`, collapse multiple slashes.
// Result always starts with `/`. Does not validate existence.

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
  });
  res.end(JSON.stringify(data));
}

function text(res, status, content, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    ...extraHeaders,
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
  if (req.headers['x-api-key']) return req.headers['x-api-key'];
  try { return new URL(req.url, 'http://x').searchParams.get('api_key') || null; }
  catch { return null; }
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
      accounts[normalizedEmail] = { passwordHash: hash, salt, apiKeys: [], publicId: crypto.randomBytes(32).toString('hex'), created: Date.now() };
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
      publicId: account.publicId,
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
      publicId: account.publicId,
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
    if (!apiKey) return json(res, 401, { error: 'API key required (X-API-Key header or ?api_key= param)' });

    const ownerInfo = findAccountByApiKey(apiKey);
    if (!ownerInfo) return json(res, 403, { error: 'Invalid API key' });

    const keyObj = ownerInfo.account.apiKeys.find(k => k.key === apiKey);
    if (keyObj) { keyObj.lastUsed = Date.now(); saveAccounts(); }

    const permsKv = keyObj?.permissions ?? { kv: true };
    if (!permsKv.kv) return json(res, 403, { error: 'This API key does not have KV store access' });

    provisionAccount(ownerInfo.email);
    const store = dataStore[ownerInfo.email];
    const dataPath = pathname.replace('/api/data', '').replace(/^\//, '');

    const visMap = kvVisibility[ownerInfo.email] || {};

    if (!dataPath && method === 'GET')
      return json(res, 200, {
        keys: Object.keys(store).map(k => ({ key: k, visibility: visMap[k] || 'private' })),
        count: Object.keys(store).length,
      });

    if (dataPath && method === 'GET') {
      const key = decodeURIComponent(dataPath);
      if (!(key in store)) return json(res, 404, { error: 'Key not found' });
      return json(res, 200, { key, value: store[key], visibility: visMap[key] || 'private' });
    }

    if (dataPath && (method === 'PUT' || method === 'POST')) {
      try {
        const key = decodeURIComponent(dataPath);
        const rawBody = await readBody(req);
        let value;
        if (rawBody.trim()) {
          const body = JSON.parse(rawBody);
          value = body.value !== undefined ? body.value : body;
        } else {
          const qv = url.searchParams.get('value');
          if (qv === null) return json(res, 400, { error: 'value required (JSON body or ?value= param)' });
          value = qv;
        }
        store[key] = value;
        saveData();
        return json(res, 200, { key, success: true });
      } catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    }

    if (dataPath && method === 'PATCH') {
      try {
        const key = decodeURIComponent(dataPath);
        if (!(key in store)) return json(res, 404, { error: 'Key not found' });
        const body = JSON.parse(await readBody(req));
        const { visibility } = body;
        if (visibility !== 'public' && visibility !== 'private')
          return json(res, 400, { error: 'visibility must be "public" or "private"' });
        if (!kvVisibility[ownerInfo.email]) kvVisibility[ownerInfo.email] = {};
        if (visibility === 'public') {
          kvVisibility[ownerInfo.email][key] = 'public';
        } else {
          delete kvVisibility[ownerInfo.email][key];
        }
        saveVisibility();
        return json(res, 200, { key, visibility });
      } catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    }

    if (dataPath && method === 'DELETE') {
      const key = decodeURIComponent(dataPath);
      if (!(key in store)) return json(res, 404, { error: 'Key not found' });
      delete store[key];
      if (kvVisibility[ownerInfo.email]) delete kvVisibility[ownerInfo.email][key];
      saveData();
      saveVisibility();
      return json(res, 200, { key, deleted: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  // ── JJFS file system (API-key or session authenticated) ────────────
  if (pathname.startsWith('/api/fs')) {
    const apiKey = getApiKeyFromReq(req);
    let wsForKey, perms, email, apiKeyString;

    if (apiKey) {
      const ownerInfo = findAccountByApiKey(apiKey);
      if (!ownerInfo) return json(res, 403, { error: 'Invalid API key' });
      const keyObj = ownerInfo.account.apiKeys.find(k => k.key === apiKey);
      if (keyObj) { keyObj.lastUsed = Date.now(); saveAccounts(); }
      perms = keyObj?.permissions ?? { kv: true, fs: true, workspaces: '*', paths: {} };
      if (!perms.fs) return json(res, 403, { error: 'This API key does not have filesystem access' });
      provisionAccount(ownerInfo.email);
      wsForKey = workspaces[ownerInfo.email];
      email = ownerInfo.email;
      apiKeyString = apiKey;
    } else {
      const session = getSessionFromReq(req);
      if (!session) return json(res, 401, { error: 'X-API-Key header required' });
      provisionAccount(session.email);
      wsForKey = workspaces[session.email];
      perms = { kv: true, fs: true, workspaces: '*', paths: {} };
      email = session.email;
      apiKeyString = null; // session auth = full access, bypasses permission checks
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
      const { wsName, startLine, endLine } = parsed;
      const filePath = normalizePath(parsed.filePath);

      let result;
      switch (type) {
        case 'JJFS_READ': {
          const ra = checkReadAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!ra.allowed) {
            const perm = getEffectivePermission(fsPermissions, email, wsName, filePath);
            return json(res, 403, { success: false, error: ra.error, permission: hashPermForResponse(perm, hashKey) });
          }
          result = jjfsRead(wsForKey, wsName, filePath, startLine, endLine);
          break;
        }

        case 'JJFS_WRITE': {
          if (content === undefined || content === null)
            return json(res, 400, { error: 'content is required for JJFS_WRITE' });
          const ww = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!ww.allowed) return json(res, 403, { error: ww.error });
          if (!wsForKey[wsName]) wsForKey[wsName] = {};
          const isNew = !jjfsNavigate(wsForKey[wsName], filePath).name ||
            !(jjfsNavigate(wsForKey[wsName], filePath).name in (jjfsNavigate(wsForKey[wsName], filePath).parent || {}));
          result = jjfsWrite(wsForKey, wsName, filePath, content);
          if (result.success) {
            const tsFields = isNew ? ['birthtime', 'mtime', 'ctime'] : ['mtime', 'ctime'];
            touchTimestamps(fsTimestamps, email, wsName, filePath, tsFields);
            saveTimestamps();
            saveWorkspaces();
          }
          break;
        }

        case 'JJFS_EDIT': {
          const ew = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!ew.allowed) return json(res, 403, { error: ew.error });
          let op;
          try { op = typeof content === 'string' ? JSON.parse(content) : content; }
          catch { return json(res, 400, { error: 'content must be JSON with {search, replace} for JJFS_EDIT' }); }
          if (!op || op.search === undefined || op.replace === undefined)
            return json(res, 400, { error: 'JJFS_EDIT content must have search and replace fields' });
          result = jjfsEdit(wsForKey, wsName, filePath, op.search, op.replace);
          if (result.success) {
            touchTimestamps(fsTimestamps, email, wsName, filePath, ['mtime', 'ctime']);
            saveTimestamps();
            saveWorkspaces();
          }
          break;
        }

        case 'JJFS_DELETE': {
          const dw = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!dw.allowed) return json(res, 403, { error: dw.error });
          const ds = checkStickyBit(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!ds.allowed) return json(res, 403, { error: ds.error });
          result = jjfsDelete(wsForKey, wsName, filePath);
          if (result.success) {
            removePermissionsUnder(fsPermissions, email, wsName, filePath);
            removeTimestampsUnder(fsTimestamps, email, wsName, filePath);
            removeSymlinksUnder(fsSymlinks, email, wsName, filePath);
            removeXattrsUnder(fsXattrs, email, wsName, filePath);
            savePermissions(); saveTimestamps(); saveSymlinks(); saveXattrs();
            if (wsName !== 'default' && Object.keys(wsForKey[wsName] || {}).length === 0)
              delete wsForKey[wsName];
            saveWorkspaces();
          }
          break;
        }

        case 'JJFS_MOVE': {
          if (!content) return json(res, 400, { error: 'content (destination path) is required for JJFS_MOVE' });
          const destPath = normalizePath(String(content));
          const msw = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!msw.allowed) return json(res, 403, { error: msw.error });
          const ms2 = checkStickyBit(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!ms2.allowed) return json(res, 403, { error: ms2.error });
          const mdw = checkWriteAccess(fsPermissions, email, wsName, destPath, apiKeyString);
          if (!mdw.allowed) return json(res, 403, { error: mdw.error });
          result = jjfsMove(wsForKey, wsName, filePath, destPath);
          if (result.success) {
            removePermissionsUnder(fsPermissions, email, wsName, filePath);
            removeTimestampsUnder(fsTimestamps, email, wsName, filePath);
            removeSymlinksUnder(fsSymlinks, email, wsName, filePath);
            removeXattrsUnder(fsXattrs, email, wsName, filePath);
            touchTimestamps(fsTimestamps, email, wsName, destPath, ['mtime', 'ctime']);
            savePermissions(); saveTimestamps(); saveSymlinks(); saveXattrs();
            saveWorkspaces();
          }
          break;
        }

        case 'JJFS_COPY': {
          if (!content) return json(res, 400, { error: 'content (destination path) is required for JJFS_COPY' });
          const cpDest = normalizePath(String(content));
          const cw = checkWriteAccess(fsPermissions, email, wsName, cpDest, apiKeyString);
          if (!cw.allowed) return json(res, 403, { error: cw.error });
          result = jjfsCopy(wsForKey, wsName, filePath, cpDest);
          if (result.success) {
            touchTimestamps(fsTimestamps, email, wsName, cpDest, ['birthtime', 'mtime', 'ctime']);
            saveTimestamps();
            saveWorkspaces();
          }
          break;
        }

        case 'JJFS_CHMOD': {
          const cr = jjfsChmod(fsPermissions, email, wsName, filePath, content, apiKeyString);
          if (!cr.success) return json(res, cr.status, { error: cr.result });
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['ctime']);
          savePermissions(); saveTimestamps();
          const stored = (fsPermissions[email] || {})[`${wsName}:${normalizePath(filePath)}`];
          result = { success: true, result: cr.result, permission: hashPermForResponse(stored, hashKey) };
          break;
        }

        case 'JJFS_CHOWN': {
          const acctKeys = (accounts[email]?.apiKeys || []).map(k => k.key);
          const or = jjfsChown(fsPermissions, email, wsName, filePath, content, acctKeys, apiKeyString);
          if (!or.success) return json(res, or.status, { error: or.result });
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['ctime']);
          savePermissions(); saveTimestamps();
          const ownerStored = (fsPermissions[email] || {})[`${wsName}:${normalizePath(filePath)}`];
          result = { success: true, result: or.result, permission: hashPermForResponse(ownerStored, hashKey) };
          break;
        }

        case 'JJFS_SYMLINK': {
          if (!content) return json(res, 400, { error: 'content (target path) is required for JJFS_SYMLINK' });
          const ww = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!ww.allowed) return json(res, 403, { error: ww.error });
          result = jjfsSetSymlink(fsSymlinks, email, wsName, filePath, content);
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['birthtime', 'mtime', 'ctime']);
          saveSymlinks(); saveTimestamps();
          break;
        }

        case 'JJFS_GETXATTR': {
          result = { success: true, result: getXattrs(fsXattrs, email, wsName, filePath) };
          break;
        }

        case 'JJFS_SETXATTR': {
          const xw = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!xw.allowed) return json(res, 403, { error: xw.error });
          let xop;
          try { xop = typeof content === 'string' ? JSON.parse(content) : content; }
          catch { return json(res, 400, { error: 'content must be JSON { set: {...}, remove: [...] }' }); }
          const xr = jjfsSetXattr(fsXattrs, email, wsName, filePath, xop);
          if (!xr.success) return json(res, xr.status, { error: xr.result });
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['ctime']);
          saveXattrs(); saveTimestamps();
          result = { success: true, result: getXattrs(fsXattrs, email, wsName, filePath) };
          break;
        }

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
      const browsePath = normalizePath(url.searchParams.get('path') || '/');
      const showAll = url.searchParams.get('all') === '1';
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
          const ra = checkReadAccess(fsPermissions, email, wsName, browsePath, apiKeyString);
          if (!ra.allowed) {
            const perm = getEffectivePermission(fsPermissions, email, wsName, browsePath);
            return json(res, 403, { error: ra.error, permission: hashPermForResponse(perm, hashKey) });
          }
          return json(res, 200, {
            success: true, workspace: wsName, path: browsePath,
            type: 'file', content: targetNode,
            timestamps: getTimestamps(fsTimestamps, email, wsName, browsePath),
            xattrs: getXattrs(fsXattrs, email, wsName, browsePath),
            permission: hashPermForResponse(getEffectivePermission(fsPermissions, email, wsName, browsePath), hashKey),
          });
        }
      }

      // Directory listing — check read access
      const ra = checkReadAccess(fsPermissions, email, wsName, browsePath, apiKeyString);
      if (!ra.allowed) {
        const perm = getEffectivePermission(fsPermissions, email, wsName, browsePath);
        return json(res, 403, { error: ra.error, permission: hashPermForResponse(perm, hashKey) });
      }

      const rawEntries = Object.entries(targetNode);
      const filtered = showAll ? rawEntries : rawEntries.filter(([n]) => !n.startsWith('.'));
      const entries = filtered.map(([n, v]) => ({
        name: n,
        type: typeof v === 'object' ? 'directory' : 'file',
        ...(typeof v === 'string' ? { size: v.length } : { fileCount: countFiles(v) }),
        timestamps: getTimestamps(fsTimestamps, email, wsName, normalizePath(browsePath + '/' + n)),
      }));
      // Overlay symlinks defined in this directory
      const symlinksHere = getSymlinksInDir(fsSymlinks, email, wsName, browsePath);
      for (const [name, target] of Object.entries(symlinksHere)) {
        if (!showAll && name.startsWith('.')) continue;
        entries.push({ name, type: 'symlink', target, timestamps: getTimestamps(fsTimestamps, email, wsName, normalizePath(browsePath + '/' + name)) });
      }
      return json(res, 200, {
        success: true, workspace: wsName, path: browsePath,
        type: 'directory', entries,
        timestamps: getTimestamps(fsTimestamps, email, wsName, browsePath),
        permission: hashPermForResponse(getEffectivePermission(fsPermissions, email, wsName, browsePath), hashKey),
      });
    }

    // REST: GET|PUT|PATCH|DELETE|POST /api/fs/:workspace/*path
    if (pathname.startsWith('/api/fs/')) {
      const fsSubpath = pathname.slice('/api/fs/'.length);
      const slashIdx  = fsSubpath.indexOf('/');
      const wsName    = slashIdx === -1 ? fsSubpath : fsSubpath.slice(0, slashIdx);
      const filePath  = normalizePath(slashIdx === -1 ? '/' : fsSubpath.slice(slashIdx));
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
        const showAll = url.searchParams.get('all') === '1';
        const nofollow = url.searchParams.get('nofollow') === '1';

        // Symlink check (for ?nofollow=1 — return symlink metadata without following)
        const symlinkTarget = (fsSymlinks[email] || {})[`${wsName}:${filePath}`];
        if (symlinkTarget && nofollow) {
          const perm = getEffectivePermission(fsPermissions, email, wsName, filePath);
          return json(res, 200, {
            type: 'symlink', workspace: wsName, path: filePath, target: symlinkTarget,
            permission: hashPermForResponse(perm, hashKey),
            timestamps: getTimestamps(fsTimestamps, email, wsName, filePath),
            xattrs: getXattrs(fsXattrs, email, wsName, filePath),
          });
        }

        const trimmed = filePath.replace(/^\//, '');
        let targetNode;
        if (!trimmed) {
          targetNode = ws;
        } else {
          const nav = jjfsNavigate(ws, filePath);
          if (nav.error) return json(res, 404, { error: nav.error });
          const { parent, name } = nav;
          if (!(name in parent)) {
            // Path might exist only as a symlink (not in JJFS tree)
            if (symlinkTarget) {
              const resolved = resolveSymlink(fsSymlinks, email, wsName, filePath);
              if (resolved.error) return json(res, 400, { error: resolved.error });
              const rNav = jjfsNavigate(ws, resolved.path);
              if (rNav.error || !(rNav.name in (rNav.parent || {})))
                return json(res, 404, { error: `Not found: ${filePath}` });
              targetNode = rNav.parent[rNav.name];
            } else {
              return json(res, 404, { error: `Not found: ${filePath}` });
            }
          } else {
            targetNode = parent[name];
          }
        }

        if (typeof targetNode === 'object') {
          // Directory — check read access
          const ra = checkReadAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!ra.allowed) {
            const perm = getEffectivePermission(fsPermissions, email, wsName, filePath);
            return json(res, 403, { error: ra.error, permission: hashPermForResponse(perm, hashKey) });
          }
          const rawEntries = Object.entries(targetNode);
          const filtered = showAll ? rawEntries : rawEntries.filter(([n]) => !n.startsWith('.'));
          const entries = filtered.map(([n, v]) => ({
            name: n, type: typeof v === 'object' ? 'directory' : 'file',
            ...(typeof v === 'string' ? { size: v.length } : { fileCount: countFiles(v) }),
            timestamps: getTimestamps(fsTimestamps, email, wsName, normalizePath(filePath + '/' + n)),
          }));
          const symlinksHere = getSymlinksInDir(fsSymlinks, email, wsName, filePath);
          for (const [name, target] of Object.entries(symlinksHere)) {
            if (!showAll && name.startsWith('.')) continue;
            entries.push({ name, type: 'symlink', target, timestamps: getTimestamps(fsTimestamps, email, wsName, normalizePath(filePath + '/' + name)) });
          }
          const dp = getEffectivePermission(fsPermissions, email, wsName, filePath);
          return json(res, 200, {
            type: 'directory', workspace: wsName, path: filePath, entries,
            permission: hashPermForResponse(dp, hashKey) ?? { mode: 'rw', owner: null },
            timestamps: getTimestamps(fsTimestamps, email, wsName, filePath),
            xattrs: getXattrs(fsXattrs, email, wsName, filePath),
          });
        }

        // File — check read access
        const ra = checkReadAccess(fsPermissions, email, wsName, filePath, apiKeyString);
        if (!ra.allowed) {
          const perm = getEffectivePermission(fsPermissions, email, wsName, filePath);
          return json(res, 403, { error: ra.error, permission: hashPermForResponse(perm, hashKey) });
        }

        let content = String(targetNode);
        const start = url.searchParams.get('start');
        const end   = url.searchParams.get('end');
        if (start && end) {
          const lines = content.split('\n');
          content = lines.slice(Math.max(0, parseInt(start) - 1), Math.min(lines.length, parseInt(end))).join('\n');
        }
        const fp = getEffectivePermission(fsPermissions, email, wsName, filePath);
        const ts = getTimestamps(fsTimestamps, email, wsName, filePath);
        return text(res, 200, content, {
          'X-JJFS-Permission': JSON.stringify(hashPermForResponse(fp, hashKey)),
          'X-JJFS-Mode': fp?.mode || 'rw',
          'X-JJFS-Owner': fp?.owner ? [].concat(fp.owner).map(hashKey).join(',') : '',
          ...(ts ? { 'X-JJFS-Timestamps': JSON.stringify(ts) } : {}),
        });
      }

      if (method === 'PUT') {
        const wc = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
        if (!wc.allowed) return json(res, 403, { error: wc.error });
        if (!wsForKey[wsName]) wsForKey[wsName] = {};
        const content = await readBody(req);
        const nav = jjfsNavigate(wsForKey[wsName], filePath);
        const isNew = !nav.error && nav.name && !(nav.name in (nav.parent || {}));
        const r = jjfsWrite(wsForKey, wsName, filePath, content);
        if (r.success) {
          touchTimestamps(fsTimestamps, email, wsName, filePath, isNew ? ['birthtime', 'mtime', 'ctime'] : ['mtime', 'ctime']);
          saveTimestamps();
          saveWorkspaces();
        }
        return json(res, r.success ? 200 : 400, r);
      }

      if (method === 'DELETE') {
        const wc = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
        if (!wc.allowed) return json(res, 403, { error: wc.error });
        const sc = checkStickyBit(fsPermissions, email, wsName, filePath, apiKeyString);
        if (!sc.allowed) return json(res, 403, { error: sc.error });
        const r = jjfsDelete(wsForKey, wsName, filePath);
        if (r.success) {
          removePermissionsUnder(fsPermissions, email, wsName, filePath);
          removeTimestampsUnder(fsTimestamps, email, wsName, filePath);
          removeSymlinksUnder(fsSymlinks, email, wsName, filePath);
          removeXattrsUnder(fsXattrs, email, wsName, filePath);
          savePermissions(); saveTimestamps(); saveSymlinks(); saveXattrs();
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
        const { search, replace, chmod, chown, symlink, xattr } = body;

        if (chmod !== undefined) {
          const cr = jjfsChmod(fsPermissions, email, wsName, filePath, chmod, apiKeyString);
          if (!cr.success) return json(res, cr.status, { error: cr.result });
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['ctime']);
          savePermissions(); saveTimestamps();
          const stored = (fsPermissions[email] || {})[`${wsName}:${normalizePath(filePath)}`];
          return json(res, 200, {
            success: true, workspace: wsName, path: filePath,
            permission: hashPermForResponse(stored, hashKey) ?? { mode: 'rw', owner: null },
          });
        }

        if (chown !== undefined) {
          const acctKeys = (accounts[email]?.apiKeys || []).map(k => k.key);
          const or = jjfsChown(fsPermissions, email, wsName, filePath, chown, acctKeys, apiKeyString);
          if (!or.success) return json(res, or.status, { error: or.result });
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['ctime']);
          savePermissions(); saveTimestamps();
          const stored = (fsPermissions[email] || {})[`${wsName}:${normalizePath(filePath)}`];
          return json(res, 200, {
            success: true, workspace: wsName, path: filePath,
            permission: hashPermForResponse(stored, hashKey) ?? { mode: 'rw', owner: null },
          });
        }

        if (symlink !== undefined) {
          const wc = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!wc.allowed) return json(res, 403, { error: wc.error });
          jjfsSetSymlink(fsSymlinks, email, wsName, filePath, symlink || null);
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['mtime', 'ctime']);
          saveSymlinks(); saveTimestamps();
          return json(res, 200, {
            success: true, workspace: wsName, path: filePath,
            symlink: symlink ? normalizePath(String(symlink)) : null,
          });
        }

        if (xattr !== undefined) {
          const wc = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!wc.allowed) return json(res, 403, { error: wc.error });
          const xr = jjfsSetXattr(fsXattrs, email, wsName, filePath, xattr);
          if (!xr.success) return json(res, xr.status, { error: xr.result });
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['ctime']);
          saveXattrs(); saveTimestamps();
          return json(res, 200, { success: true, workspace: wsName, path: filePath, xattrs: getXattrs(fsXattrs, email, wsName, filePath) });
        }

        if (search === undefined || replace === undefined)
          return json(res, 400, { error: 'body must contain search+replace, chmod, chown, symlink, or xattr' });
        const wc = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
        if (!wc.allowed) return json(res, 403, { error: wc.error });
        const r = jjfsEdit(wsForKey, wsName, filePath, search, replace);
        if (r.success) {
          touchTimestamps(fsTimestamps, email, wsName, filePath, ['mtime', 'ctime']);
          saveTimestamps();
          saveWorkspaces();
        }
        return json(res, r.success ? 200 : 400, r);
      }

      if (method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'Invalid JSON body' }); }
        const { op, destination } = body;
        if (!op || !destination) return json(res, 400, { error: 'op and destination are required' });
        const destPath = normalizePath(String(destination));
        let r;
        if (op === 'move') {
          const sw = checkWriteAccess(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!sw.allowed) return json(res, 403, { error: sw.error });
          const sc = checkStickyBit(fsPermissions, email, wsName, filePath, apiKeyString);
          if (!sc.allowed) return json(res, 403, { error: sc.error });
          const dw = checkWriteAccess(fsPermissions, email, wsName, destPath, apiKeyString);
          if (!dw.allowed) return json(res, 403, { error: dw.error });
          r = jjfsMove(wsForKey, wsName, filePath, destPath);
          if (r.success) {
            removePermissionsUnder(fsPermissions, email, wsName, filePath);
            removeTimestampsUnder(fsTimestamps, email, wsName, filePath);
            removeSymlinksUnder(fsSymlinks, email, wsName, filePath);
            removeXattrsUnder(fsXattrs, email, wsName, filePath);
            touchTimestamps(fsTimestamps, email, wsName, destPath, ['mtime', 'ctime']);
            savePermissions(); saveTimestamps(); saveSymlinks(); saveXattrs();
          }
        } else if (op === 'copy') {
          const dw = checkWriteAccess(fsPermissions, email, wsName, destPath, apiKeyString);
          if (!dw.allowed) return json(res, 403, { error: dw.error });
          r = jjfsCopy(wsForKey, wsName, filePath, destPath);
          if (r.success) {
            touchTimestamps(fsTimestamps, email, wsName, destPath, ['birthtime', 'mtime', 'ctime']);
            saveTimestamps();
          }
        } else {
          return json(res, 400, { error: `Unknown op: ${op}. Use 'move' or 'copy'` });
        }
        if (r.success) saveWorkspaces();
        return json(res, r.success ? 200 : 400, r);
      }

      return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
  }

  // ── Public KV read: GET /d2l/:publicId/:key ───────────────────────
  // No authentication — only serves entries explicitly marked public.
  if (method === 'GET' && pathname.startsWith('/d2l/')) {
    const parts = pathname.slice('/d2l/'.length).split('/');
    const publicId = parts[0];
    const kvKey = decodeURIComponent(parts.slice(1).join('/'));
    if (!publicId || !kvKey) return json(res, 404, { error: 'Not found' });
    const accountEntry = Object.entries(accounts).find(([, a]) => a.publicId === publicId);
    if (!accountEntry) return json(res, 404, { error: 'Not found' });
    const [email] = accountEntry;
    const isPublic = (kvVisibility[email] || {})[kvKey] === 'public';
    if (!isPublic) return json(res, 404, { error: 'Not found' });
    const store = dataStore[email] || {};
    if (!(kvKey in store)) return json(res, 404, { error: 'Not found' });
    return json(res, 200, { key: kvKey, value: store[kvKey] });
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

  // Ensure every account has a publicId
  for (const [, account] of Object.entries(accounts)) {
    if (!account.publicId) {
      account.publicId = crypto.randomBytes(32).toString('hex');
      dirty = true;
    }
  }
  if (dirty) saveAccounts();
  dirty = false;

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
