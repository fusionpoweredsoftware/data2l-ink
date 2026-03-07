// ── JJFS Core ────────────────────────────────────────────────────────
// JavaScript Journaling File System — universal library.
// No imports. No Node.js. Works in any browser (ES modules) or in Node.js.
//
// All functions take a wsForKey object — a map of workspace names to their
// directory trees (e.g. { default: {}, myapp: { "src/": {...} } }).
// Mutating functions modify wsForKey in place and return { success, result }.
// Persistence (saving to disk, etc.) is the caller's responsibility.

// Navigate a workspace tree to { parent, name } for an arbitrary POSIX path.
// workspace: the workspace object itself (e.g. wsForKey['default'])
// pathStr:   POSIX path, leading slash optional — e.g. "/src/app.js" or "src/app.js"
export function jjfsNavigate(workspace, pathStr) {
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
export function parseTarget(target, forRead) {
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
export function countFiles(node) {
  if (typeof node === 'string') return 1;
  if (typeof node !== 'object' || node === null) return 0;
  return Object.values(node).reduce((sum, v) => sum + countFiles(v), 0);
}

// Read a file or list a directory.
// Returns { success: true, result: string } or { success: false, result: errorMessage }.
export function jjfsRead(wsForKey, wsName, filePath, startLine, endLine) {
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

// Create or overwrite a file. Creates intermediate directories automatically.
export function jjfsWrite(wsForKey, wsName, filePath, content) {
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

// Surgical search-and-replace within a file. search must appear exactly once.
export function jjfsEdit(wsForKey, wsName, filePath, searchStr, replaceStr) {
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

// Remove a file or directory.
export function jjfsDelete(wsForKey, wsName, filePath) {
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

// Move (relocate) a file or directory within a workspace.
export function jjfsMove(wsForKey, wsName, srcPath, destPath) {
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

// Duplicate a file or directory within a workspace.
export function jjfsCopy(wsForKey, wsName, srcPath, destPath) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  const srcNav = jjfsNavigate(ws, srcPath);
  if (srcNav.error) return { success: false, result: srcNav.error };
  const { parent: srcParent, name: srcName } = srcNav;
  if (!(srcName in srcParent)) return { success: false, result: `Not found: ${srcPath}` };

  const payload = JSON.parse(JSON.stringify(srcParent[srcName]));
  return jjfsWrite(wsForKey, wsName, destPath, payload);
}
