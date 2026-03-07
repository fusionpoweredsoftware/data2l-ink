# data2l.ink

A cloud-based virtual file system and key-value storage API designed to give AI language models persistent, structured storage across conversation turns.

## What It Does

AI models are stateless — they forget everything after each response. data2l.ink solves this by providing a named virtual workspace where files can be read, written, and edited using a simple REST API. AI agents can use it to maintain project state across multiple sessions without needing to paste entire codebases or rely on lossy summaries.

## Core Concepts

**JJFS (JavaScript Journaling File System)** — A virtual hierarchical file system stored as nested JSON. It supports file operations with Unix-like semantics: read, write, edit, delete, move, copy, chmod, chown, symlinks, and extended attributes. Writes are immediately durable.

**Workspaces** — Named virtual file systems. Each user can have multiple independent workspaces (e.g. `default`, `myproject`, `docs`). Workspace names must start with a letter or digit and contain only `a-z`, `0-9`, `_`, `-`. The `default` workspace is created automatically and cannot be deleted.

**Key-Value Storage** — Simple per-account KV pairs, with optional public read access via a public ID.

## Getting Started

**Requirements:** Node.js (ES modules support required)

```bash
git clone <repo-url>
cd data2l-ink
npm start
```

The server starts on port `3000` by default. Set the `PORT` environment variable to override.

```
npm run dev   # Auto-reload on file changes
```

On first run, the server creates persistent JSON files in the working directory:

`store.json`, `accounts.json`, `sessions.json`, `workspaces.json`, `visibility.json`, `permissions.json`, `timestamps.json`, `symlinks.json`, `xattrs.json`

---

## API Overview

### Authentication

Sessions are cookie-based (`d2l_session`), valid for 7 days.

```
POST /auth/signup    { email, password }        → { success, session, email }
POST /auth/login     { email, password }        → { success, session, email }
POST /auth/logout                               → { success }
GET  /auth/me                                  → { email, publicId, apiKeys, created }
```

Password must be at least 8 characters.

---

### API Keys

API keys are used to authenticate programmatic access. They are scoped with permissions.

```
POST   /keys    { label?, permissions? }    → { key, label }
GET    /keys                                → { publicId, availableWorkspaces, keys[] }
DELETE /keys/:key                           → { success }
```

**Permissions object** (all fields optional, default is full access):

```json
{
  "kv": true,
  "fs": true,
  "workspaces": "*",
  "paths": { "myworkspace": ["/allowed/path"] }
}
```

- `kv` — allow access to the KV store (default: `true`)
- `fs` — allow access to the file system (default: `true`)
- `workspaces` — `"*"` for all, or an array of workspace names
- `paths` — per-workspace path restrictions (array of allowed path prefixes)

API keys can be passed as an `X-API-Key` header or `?api_key=` query parameter.

---

### Key-Value Store

Simple flat key-value storage, authenticated with an API key.

```
GET    /api/data               List all keys           → { keys: [{ key, visibility }], count }
GET    /api/data/:key          Read a value            → { key, value, visibility }
PUT    /api/data/:key          Write a value           → { key, success }
POST   /api/data/:key          Write a value           → { key, success }
PATCH  /api/data/:key          Set visibility          → { key, visibility }
DELETE /api/data/:key          Delete a key            → { key, deleted }
```

**Write body** (PUT/POST): `{ "value": <any JSON> }` or just raw JSON. Also accepts `?value=` as a query parameter.

**PATCH body**: `{ "visibility": "public" | "private" }` — controls whether the key is readable via the public endpoint.

---

### Public KV Read (unauthenticated)

Read a KV entry that has been marked public, using the account's `publicId`:

```
GET /d2l/:publicId/:key    → { key, value }
```

Returns 404 if the key does not exist or is not marked public.

---

### File System — Execute Endpoint

All JJFS operations can be performed through a single execute endpoint:

```
POST /api/fs/execute
Authorization: X-API-Key: <api-key>

{
  "type": "<OPERATION>",
  "target": "wsName:/path/to/file",
  "content": <varies by operation>
}
```

**Target format:** `wsName:/path` — workspace name followed by a colon and POSIX path.
For `JJFS_READ`, the target can include a line range: `wsName:/path:startLine:endLine`.

**Operations:**

| `type` | `content` | Description |
|--------|-----------|-------------|
| `JJFS_READ` | — | Read a file or list a directory |
| `JJFS_WRITE` | string (file content) | Create or overwrite a file |
| `JJFS_EDIT` | `{ "search": "...", "replace": "..." }` | Search-and-replace within a file (search must be unique) |
| `JJFS_DELETE` | — | Remove a file or directory |
| `JJFS_MOVE` | destination path string | Move file/directory to destination |
| `JJFS_COPY` | destination path string | Copy file/directory to destination |
| `JJFS_CHMOD` | mode string or ACL object | Set permissions on a path |
| `JJFS_CHOWN` | API key ID or array | Set owner of a path |
| `JJFS_SYMLINK` | target path string | Create a symlink |
| `JJFS_GETXATTR` | — | Get extended attributes of a path |
| `JJFS_SETXATTR` | `{ "set": { "user.key": "val" }, "remove": ["user.old"] }` | Set/remove extended attributes |

**Response:** `{ success: boolean, result: string | object }`

**Examples:**

```json
// Read a file
{ "type": "JJFS_READ", "target": "default:/notes.txt" }

// Read lines 10–20 of a file
{ "type": "JJFS_READ", "target": "default:/notes.txt:10:20" }

// Write a file
{ "type": "JJFS_WRITE", "target": "default:/notes.txt", "content": "Hello world" }

// Edit in place (search must appear exactly once)
{ "type": "JJFS_EDIT", "target": "default:/notes.txt", "content": { "search": "Hello", "replace": "Hi" } }

// List a directory
{ "type": "JJFS_READ", "target": "default:/" }

// Move a file
{ "type": "JJFS_MOVE", "target": "default:/notes.txt", "content": "/archive/notes.txt" }

// Copy a file
{ "type": "JJFS_COPY", "target": "default:/notes.txt", "content": "/backup/notes.txt" }

// Set a path read-only
{ "type": "JJFS_CHMOD", "target": "default:/sensitive/", "content": "ro" }

// Set extended attributes
{ "type": "JJFS_SETXATTR", "target": "default:/file.txt", "content": { "set": { "user.author": "alice" } } }
```

---

### File System — REST Endpoints

Files and directories can also be accessed with REST-style routes:

```
GET    /api/fs/:workspace/*path    Read file or list directory
PUT    /api/fs/:workspace/*path    Write file (plain text body)
PATCH  /api/fs/:workspace/*path    Edit file or update metadata
DELETE /api/fs/:workspace/*path    Delete file or directory
POST   /api/fs/:workspace/*path    Move or copy a file
```

**GET query parameters:**
- `?all=1` — include hidden entries (names starting with `.`)
- `?nofollow=1` — return symlink metadata instead of following the link
- `?start=N&end=N` — return only lines N through N (1-indexed)

**GET file response headers:**
- `X-JJFS-Permission` — effective permission JSON
- `X-JJFS-Mode` — mode string (e.g. `rw`, `ro`, `644`)
- `X-JJFS-Owner` — SHA-256 hashed owner key(s)
- `X-JJFS-Timestamps` — `{ birthtime, mtime, ctime }` JSON

**PATCH body options** (mutually exclusive per request):

```json
// Search and replace
{ "search": "old text", "replace": "new text" }

// Set permissions
{ "chmod": "ro" }
{ "chmod": "644" }
{ "chmod": { "key-abc": "ro", "*": "rw" } }

// Set owner
{ "chown": "key-abc" }
{ "chown": ["key-abc", "key-xyz"] }
{ "chown": null }

// Create/remove symlink
{ "symlink": "/target/path" }
{ "symlink": null }

// Set extended attributes
{ "xattr": { "set": { "user.tag": "value" }, "remove": ["user.old"] } }
```

**POST body** (move or copy):

```json
{ "op": "move", "destination": "/new/path" }
{ "op": "copy", "destination": "/backup/path" }
```

---

### File System — Browse Endpoint

Structured directory listing with full metadata:

```
GET /api/fs/browse?workspace=<name>&path=<path>&all=1
```

Returns entries with `name`, `type` (`file` | `directory` | `symlink`), `size` or `fileCount`, `timestamps`, and for symlinks a `target` field. Also includes the directory's own `timestamps`, `permission`, and `xattrs`.

---

### Workspaces

```
GET    /api/fs/workspaces          List workspaces      → { workspaces: [{ name, fileCount }], count }
POST   /api/fs/workspaces          { name }             → { success, name }
DELETE /api/fs/workspaces/:name                         → { success }
```

The `default` workspace cannot be deleted. Workspace names must match `^[a-z0-9][a-z0-9_-]*$`.

---

## Permissions

The permission system is POSIX-inspired:

- **Modes:** `"ro"` (read-only), `"rw"` (read-write, default), octal strings (`"644"`, `"755"`, `"1755"`)
- **ACLs:** Per-API-key access control — an object mapping key IDs to `"ro"` | `"rw"` | single octal digit; `"*"` is the fallback
- **Inheritance:** Permissions propagate down the directory tree (most specific path wins)
- **Ownership:** A path can have one or more owner keys; only owners may run `chmod`/`chown` on it
- **Sticky bit:** When set on a directory (e.g. `"1755"`), only file/directory owners may delete or rename files within it
- **Session auth:** Browser sessions bypass all permission checks

```json
// Read-only for everyone
{ "type": "JJFS_CHMOD", "target": "default:/sensitive/", "content": "ro" }

// Read-only for everyone except key-abc (which gets rw)
{ "type": "JJFS_CHMOD", "target": "default:/shared/", "content": { "key-abc": "rw", "*": "ro" } }

// Octal: owner gets rw (6), others get ro (4)
{ "type": "JJFS_CHMOD", "target": "default:/shared/", "content": "644" }

// Sticky bit + standard permissions
{ "type": "JJFS_CHMOD", "target": "default:/uploads/", "content": "1755" }
```

In responses, raw API key IDs are replaced with their SHA-256 hashes.

---

## File Metadata

- **Timestamps:** `birthtime` (created), `mtime` (content modified), `ctime` (any change including metadata) — ISO-8601 strings
- **Extended attributes:** Custom key-value metadata on any path, namespaced as `user.*` or `trusted.*`
- **Symlinks:** Virtual directory entries stored alongside the JJFS tree, resolved transparently on read

---

## Architecture

The project has no external runtime dependencies.

| File | Purpose |
|------|---------|
| `server.mjs` | HTTP server, routing, auth, session management |
| `jjfs.js` | Core JJFS library (runs in Node.js or browser) |
| `index.html` | Web UI frontend |
| `random-name-gen.js` | Workspace name generator utility |

**Persistent data** is stored across 9 JSON files created at runtime:

`store.json`, `accounts.json`, `sessions.json`, `workspaces.json`, `visibility.json`, `permissions.json`, `timestamps.json`, `symlinks.json`, `xattrs.json`

---

## JJFS Library

`jjfs.js` can be used independently in any JavaScript environment (Node.js or browser). It has no imports or dependencies. All mutating functions take `wsForKey` or a dedicated metadata map as their first argument and mutate it in place; persistence is the caller's responsibility.

### Full export list

```js
import {
  // Core file system
  jjfsNavigate,         // Navigate workspace tree to { parent, name }
  parseTarget,          // Parse "wsName:/path[:start:end]" target string
  countFiles,           // Count all leaf files in a workspace tree
  jjfsRead,             // Read a file or list a directory (supports line range)
  jjfsWrite,            // Create or overwrite a file (auto-creates directories)
  jjfsEdit,             // Search-and-replace within a file (must be unique)
  jjfsDelete,           // Remove a file or directory
  jjfsMove,             // Move a file or directory
  jjfsCopy,             // Duplicate a file or directory

  // Binary file helpers
  jjfsWriteBinary,      // Write binary data (Uint8Array/Buffer) as base64
  jjfsReadBinary,       // Read base64-stored file back as Buffer/Uint8Array

  // Permissions
  normalizePath,         // Resolve . and .. in a POSIX path
  isValidMode,           // Validate a mode value (ro, rw, octal, ACL object)
  parseOctalBits,        // Decode a single octal digit into { read, write, execute }
  getStickyBit,          // Check if a 4-digit octal mode has the sticky bit set
  getEffectivePermission,// Most specific permission entry for a path (walks up tree)
  getPermBitsForKey,     // Decode read/write/execute bits for a specific caller
  checkReadAccess,       // Returns { allowed } or { allowed: false, error }
  checkWriteAccess,      // Returns { allowed } or { allowed: false, error }
  checkOwnerAccess,      // Check if caller is the owner of the exact path
  checkStickyBit,        // Check sticky-bit constraint for delete/move
  setPermission,         // Upsert a permission entry (merges ACL objects)
  removePermissionsUnder,// Remove all permission entries for a path and subtree
  jjfsChmod,             // Set mode on a path; returns { success, status, result }
  jjfsChown,             // Set owner on a path; returns { success, status, result }

  // Timestamps
  touchTimestamps,       // Update birthtime/mtime/ctime fields to now
  getTimestamps,         // Return { birthtime, mtime, ctime } for a path or null
  removeTimestampsUnder, // Remove all timestamp entries for a path and subtree

  // Symlinks
  resolveSymlink,        // Follow symlink chain up to 8 hops; returns { path } or { error }
  getSymlinksInDir,      // Map of symlinks that are direct children of a directory
  removeSymlinksUnder,   // Remove all symlink entries for a path and subtree
  jjfsSetSymlink,        // Create or remove a symlink

  // Extended attributes
  XATTR_NAME_RE,         // Regex validating xattr names (user.* or trusted.*)
  getXattrs,             // Return xattr map for a path or {}
  removeXattrsUnder,     // Remove all xattr entries for a path and subtree
  jjfsSetXattr,          // Apply { set, remove } xattr operation to a path

  // Serialization
  hashPermForResponse,   // Replace raw key IDs with hashed tokens in a perm entry
} from './jjfs.js'
```

### Function signatures

```js
// Navigation
jjfsNavigate(workspace, pathStr)                          // → { parent, name } | { error }
parseTarget(target, forRead?)                             // → { wsName, filePath, startLine?, endLine? } | { error }
countFiles(node)                                          // → number

// File operations (wsForKey = { wsName: tree, ... })
jjfsRead(wsForKey, wsName, filePath, startLine?, endLine?) // → { success, result }
jjfsWrite(wsForKey, wsName, filePath, content)            // → { success, result }
jjfsEdit(wsForKey, wsName, filePath, searchStr, replaceStr)// → { success, result }
jjfsDelete(wsForKey, wsName, filePath)                    // → { success, result }
jjfsMove(wsForKey, wsName, srcPath, destPath)             // → { success, result }
jjfsCopy(wsForKey, wsName, srcPath, destPath)             // → { success, result }

// Binary
jjfsWriteBinary(wsForKey, wsName, filePath, bytes)        // → { success, result }
jjfsReadBinary(wsForKey, wsName, filePath)                // → { success, result: Buffer|Uint8Array }

// Permissions (fsPerms = { email: { "wsName:/path": { mode, owner } } })
normalizePath(p)                                          // → "/normalized/path"
isValidMode(mode)                                         // → boolean
parseOctalBits(digit)                                     // → { read, write, execute }
getStickyBit(mode)                                        // → boolean
getEffectivePermission(fsPerms, email, wsName, filePath)  // → perm | null
getPermBitsForKey(perm, callerId)                         // → { read, write, execute }
checkReadAccess(fsPerms, email, wsName, filePath, callerId)  // → { allowed } | { allowed, error }
checkWriteAccess(fsPerms, email, wsName, filePath, callerId) // → { allowed } | { allowed, error }
checkOwnerAccess(fsPerms, email, wsName, filePath, callerId) // → { allowed } | { allowed, error }
checkStickyBit(fsPerms, email, wsName, filePath, callerId)   // → { allowed } | { allowed, error }
setPermission(fsPerms, email, wsName, filePath, updates)  // mutates fsPerms
removePermissionsUnder(fsPerms, email, wsName, filePath)  // mutates fsPerms
jjfsChmod(fsPerms, email, wsName, filePath, mode, callerId)  // → { success, status, result }
jjfsChown(fsPerms, email, wsName, filePath, owner, validOwners, callerId) // → { success, status, result }

// Timestamps (fsTimestamps = { email: { "wsName:/path": { birthtime, mtime, ctime } } })
touchTimestamps(fsTimestamps, email, wsName, filePath, fields) // mutates fsTimestamps
getTimestamps(fsTimestamps, email, wsName, filePath)       // → { birthtime, mtime, ctime } | null
removeTimestampsUnder(fsTimestamps, email, wsName, filePath) // mutates fsTimestamps

// Symlinks (fsSymlinks = { email: { "wsName:/path": "/target" } })
resolveSymlink(fsSymlinks, email, wsName, filePath, depth?) // → { path } | { error }
getSymlinksInDir(fsSymlinks, email, wsName, dirPath)       // → { name: "/target", ... }
removeSymlinksUnder(fsSymlinks, email, wsName, filePath)   // mutates fsSymlinks
jjfsSetSymlink(fsSymlinks, email, wsName, filePath, target)// → { success, result }

// Extended attributes (fsXattrs = { email: { "wsName:/path": { "user.key": "value" } } })
getXattrs(fsXattrs, email, wsName, filePath)              // → { "user.key": "value" } | {}
removeXattrsUnder(fsXattrs, email, wsName, filePath)      // mutates fsXattrs
jjfsSetXattr(fsXattrs, email, wsName, filePath, op)       // → { success, status, result }

// Serialization
hashPermForResponse(perm, hashFn)                         // → hashed perm object | null
```

### Data model

```
wsForKey  = { [wsName]: workspace }
workspace = { [name]: file | directory }
file      = string
directory = { [name]: file | directory }
```

A file is a string. A directory is a nested plain object. Binary files are stored as base64 strings via `jjfsWriteBinary`/`jjfsReadBinary`. All metadata (permissions, timestamps, symlinks, xattrs) is stored in separate maps keyed by `"wsName:/normalized/path"`, scoped per email. No modification to the JJFS tree itself is needed for metadata.

See `jjfs-website-2-0.md` for extended library documentation.
