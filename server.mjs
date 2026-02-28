import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_FILE       = path.join(__dirname, 'store.json');
const ACCOUNTS_FILE   = path.join(__dirname, 'accounts.json');
const SESSIONS_FILE   = path.join(__dirname, 'sessions.json');
const WORKSPACES_FILE = path.join(__dirname, 'workspaces.json');

// ── In-memory stores ────────────────────────────────────────────────
let dataStore  = {};   // { apiKey: { key: value, ... } }
let accounts   = {};   // { email: { passwordHash, salt, apiKeys: [{ key, label, created, lastUsed }] } }
let sessions   = {};   // { sessionToken: { email, created, expires } }
let workspaces = {};   // { apiKey: { wsName: { path: content | dir } } }

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

// ── JJFS Core ────────────────────────────────────────────────────────
// Navigate a workspace tree to { parent, name } for an arbitrary POSIX path.
// workspace: the workspace object itself (e.g. workspaces[apiKey]['default'])
// pathStr:   POSIX path, leading slash optional — e.g. "/src/app.js" or "src/app.js"
function jjfsNavigate(workspace, pathStr) {
  const parts = (pathStr || '').replace(/^\//, '').split('/').filter(Boolean);
  if (parts.length === 0) return { error: 'Path refers to the workspace root' };
  let node = workspace;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof node[part] !== 'object' || node[part] === null) {
      return { error: `Not a directory: /${parts.slice(0, i + 1).join('/')}` };
    }
    node = node[part];
  }
  return { parent: node, name: parts[parts.length - 1] };
}

// Parse "wsName:/path" (or "wsName:/path:startLine:endLine" for JJFS_READ) from target.
function parseTarget(target, forRead) {
  const firstColon = target.indexOf(':');
  if (firstColon === -1) return { error: 'Invalid target — expected format: wsName:/path' };
  const wsName = target.slice(0, firstColon);
  if (!wsName) return { error: 'Workspace name cannot be empty' };
  const rest = target.slice(firstColon + 1) || '/';
  if (forRead) {
    const m = rest.match(/^(.*):(\d+):(\d+)$/);
    if (m) return { wsName, filePath: m[1] || '/', startLine: parseInt(m[2]), endLine: parseInt(m[3]) };
  }
  return { wsName, filePath: rest };
}

// Count all leaf files (strings) in a workspace tree.
function countFiles(node) {
  if (typeof node === 'string') return 1;
  if (typeof node !== 'object' || node === null) return 0;
  return Object.values(node).reduce((sum, v) => sum + countFiles(v), 0);
}

function jjfsRead(wsForKey, wsName, filePath, startLine, endLine) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  // Root listing
  const trimmed = (filePath || '').replace(/^\//, '');
  if (!trimmed) {
    const lines = Object.keys(ws).map(k => typeof ws[k] === 'object' ? k + '/' : k);
    return { success: true, result: lines.join('\n') || '(empty workspace)' };
  }

  const nav = jjfsNavigate(ws, filePath);
  if (nav.error) return { success: false, result: nav.error };
  const { parent, name } = nav;
  const node = parent[name];
  if (node === undefined) return { success: false, result: `Not found: ${filePath}` };

  if (typeof node === 'object' && node !== null) {
    // Directory listing — append '/' to subdirs for clarity
    const lines = Object.keys(node).map(k => typeof node[k] === 'object' ? k + '/' : k);
    return { success: true, result: lines.join('\n') || '(empty directory)' };
  }

  let content = String(node);
  if (startLine !== undefined && endLine !== undefined) {
    const allLines = content.split('\n');
    content = allLines.slice(Math.max(0, startLine - 1), Math.min(allLines.length, endLine)).join('\n');
  }
  return { success: true, result: content };
}

function jjfsWrite(wsForKey, wsName, filePath, content) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };
  if (!filePath || filePath === '/') return { success: false, result: 'Cannot write to workspace root' };

  const parts = filePath.replace(/^\//, '').split('/').filter(Boolean);
  if (parts.length === 0) return { success: false, result: 'Invalid path' };

  // Walk path, creating intermediate directories as needed.
  let node = ws;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (node[part] === undefined) {
      node[part] = {};
    } else if (typeof node[part] !== 'object' || node[part] === null) {
      return { success: false, result: `Path conflict: /${parts.slice(0, i + 1).join('/')} is a file, not a directory` };
    }
    node = node[part];
  }

  const name = parts[parts.length - 1];
  if (typeof node[name] === 'object' && typeof content !== 'object') {
    return { success: false, result: `Path conflict: ${filePath} is a directory` };
  }
  const existed = name in node;
  node[name] = content;
  return { success: true, result: `${existed ? 'Overwrote' : 'Created'}: ${wsName}:${filePath}` };
}

function jjfsDelete(wsForKey, wsName, filePath) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };
  if (!filePath || filePath === '/') return { success: false, result: 'Cannot delete workspace root — use DELETE /api/fs/workspaces/:name' };

  const nav = jjfsNavigate(ws, filePath);
  if (nav.error) return { success: false, result: nav.error };
  const { parent, name } = nav;
  if (!(name in parent)) return { success: false, result: `Not found: ${filePath}` };
  delete parent[name];
  return { success: true, result: `Deleted: ${wsName}:${filePath}` };
}

function jjfsMove(wsForKey, wsName, srcPath, destPath) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  const srcNav = jjfsNavigate(ws, srcPath);
  if (srcNav.error) return { success: false, result: srcNav.error };
  const { parent: srcParent, name: srcName } = srcNav;
  if (!(srcName in srcParent)) return { success: false, result: `Not found: ${srcPath}` };

  const payload = JSON.parse(JSON.stringify(srcParent[srcName]));
  const writeResult = jjfsWrite(wsForKey, wsName, destPath, payload);
  if (!writeResult.success) return writeResult;

  delete srcParent[srcName];
  return { success: true, result: `Moved: ${wsName}:${srcPath} → ${destPath}` };
}

function jjfsCopy(wsForKey, wsName, srcPath, destPath) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  const srcNav = jjfsNavigate(ws, srcPath);
  if (srcNav.error) return { success: false, result: srcNav.error };
  const { parent: srcParent, name: srcName } = srcNav;
  if (!(srcName in srcParent)) return { success: false, result: `Not found: ${srcPath}` };

  const payload = JSON.parse(JSON.stringify(srcParent[srcName]));
  return jjfsWrite(wsForKey, wsName, destPath, payload);
}

// Surgical search-and-replace within a file. search must appear exactly once.
function jjfsEdit(wsForKey, wsName, filePath, searchStr, replaceStr) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  const nav = jjfsNavigate(ws, filePath);
  if (nav.error) return { success: false, result: nav.error };
  const { parent, name } = nav;
  if (!(name in parent)) return { success: false, result: `Not found: ${filePath}` };
  if (typeof parent[name] !== 'string') return { success: false, result: `Not a file: ${filePath}` };

  const occurrences = parent[name].split(searchStr).length - 1;
  if (occurrences === 0) return { success: false, result: `Search text not found in: ${filePath}` };
  if (occurrences > 1) return { success: false, result: `Search text is not unique (${occurrences} matches) in: ${filePath}` };

  parent[name] = parent[name].replace(searchStr, replaceStr);
  return { success: true, result: `Edited: ${wsName}:${filePath}` };
}

// Ensure a default workspace exists for an API key.
function provisionWorkspace(apiKey) {
  if (!workspaces[apiKey]) {
    workspaces[apiKey] = { default: {} };
    saveWorkspaces();
  }
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
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
      const { label } = JSON.parse(await readBody(req));
      const apiKey = generateKey();
      const account = accounts[session.email];
      account.apiKeys.push({ key: apiKey, label: label || 'Untitled', created: Date.now(), lastUsed: null });
      dataStore[apiKey] = {};
      workspaces[apiKey] = { default: {} };
      saveAccounts();
      saveData();
      saveWorkspaces();
      return json(res, 201, { key: apiKey, label: label || 'Untitled' });
    } catch { return json(res, 400, { error: 'Invalid request body' }); }
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
        wsCount: Object.keys(workspaces[k.key] || {}).length,
        fsFileCount: Object.values(workspaces[k.key] || {}).reduce((sum, ws) => sum + countFiles(ws), 0),
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
    delete workspaces[keyToDelete];
    saveAccounts();
    saveData();
    saveWorkspaces();
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

    if (!dataStore[apiKey]) dataStore[apiKey] = {};
    const store = dataStore[apiKey];
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

  // ── JJFS file system (API-key authenticated) ───────────────────────
  if (pathname.startsWith('/api/fs')) {
    const apiKey = getApiKeyFromReq(req);
    if (!apiKey) return json(res, 401, { error: 'X-API-Key header required' });

    const ownerInfo = findAccountByApiKey(apiKey);
    if (!ownerInfo) return json(res, 403, { error: 'Invalid API key' });

    const keyObj = ownerInfo.account.apiKeys.find(k => k.key === apiKey);
    if (keyObj) { keyObj.lastUsed = Date.now(); saveAccounts(); }

    provisionWorkspace(apiKey);
    const wsForKey = workspaces[apiKey];

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
          if (result.success) saveWorkspaces();
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
      const wsList = Object.entries(wsForKey).map(([name, tree]) => ({
        name,
        fileCount: countFiles(tree),
      }));
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

// ── Start ─────────────────────────────────────────────────────────────
loadFromDisk();
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  const totalFiles = Object.values(workspaces).reduce((sum, kw) =>
    sum + Object.values(kw).reduce((s, ws) => s + countFiles(ws), 0), 0);
  console.log(`✦ data2l.ink running on port ${PORT}`);
  console.log(`  ${Object.keys(accounts).length} accounts loaded`);
  console.log(`  ${Object.keys(dataStore).length} KV stores | ${Object.keys(workspaces).length} FS stores (${totalFiles} files)`);
});
