# data2l.ink

A cloud-based virtual file system and key-value storage API designed to give AI language models persistent, structured storage across conversation turns.

## What It Does

AI models are stateless — they forget everything after each response. data2l.ink solves this by providing a named virtual workspace where files can be read, written, and edited using a simple REST API. AI agents can use it to maintain project state across multiple sessions without needing to paste entire codebases or rely on lossy summaries.

## Core Concepts

**JJFS (JavaScript Journaling File System)** — A virtual hierarchical file system stored as nested JSON. It supports file operations with Unix-like semantics: read, write, edit, delete, move, copy, chmod, chown, symlinks, and extended attributes. Writes are immediately durable.

**Workspaces** — Named virtual file systems. Each user can have multiple independent workspaces (e.g. `default`, `myproject`, `docs`).

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

On first run, the server creates persistent JSON files in the working directory (`store.json`, `accounts.json`, `workspaces.json`, etc.).

## API Overview

### Authentication

```
POST /auth/signup    { email, password }
POST /auth/login     { email, password }
POST /auth/logout
GET  /auth/me
```

### API Keys

```
POST /keys    { label, permissions }
GET  /keys
```

### File System

All file operations go through a single execute endpoint:

```
POST /api/fs/execute
Authorization: Bearer <api-key>

{
  "op": "read" | "write" | "edit" | "delete" | "move" | "copy" | "chmod" | "chown" | "symlink" | "xattr" | "browse",
  "target": "workspace:/path/to/file",
  ...op-specific fields
}
```

**Examples:**

```json
// Write a file
{ "op": "write", "target": "default:/notes.txt", "content": "Hello world" }

// Read a file
{ "op": "read", "target": "default:/notes.txt" }

// Edit in place (search and replace)
{ "op": "edit", "target": "default:/notes.txt", "search": "Hello", "replace": "Hi" }

// List a directory
{ "op": "read", "target": "default:/" }

// Move a file
{ "op": "move", "target": "default:/notes.txt", "destination": "default:/archive/notes.txt" }
```

### REST-Style File Access

```
GET    /api/fs/:workspace/*path    Read file or directory
PUT    /api/fs/:workspace/*path    Write file
PATCH  /api/fs/:workspace/*path    Edit file (search/replace)
DELETE /api/fs/:workspace/*path    Delete file
```

### Workspaces

```
GET    /api/fs/workspaces          List workspaces
POST   /api/fs/workspaces          { name }
DELETE /api/fs/workspaces/:name
```

### Public KV

```
GET /d2l/:publicId/:key    Read a public key-value pair
```

## Permissions

The permission system is POSIX-inspired:

- **Modes:** `ro` (read-only), `rw` (read-write), octal strings (`644`, `755`, `1755`)
- **ACLs:** Per-API-key access control
- **Inheritance:** Permissions propagate down the directory tree
- **Sticky bit:** Supported via octal modes

```json
// Set a path read-only
{ "op": "chmod", "target": "default:/sensitive/", "mode": "ro" }

// Grant a specific API key write access
{ "op": "chmod", "target": "default:/shared/", "mode": "rw", "keys": ["key-abc123"] }
```

## File Metadata

- **Timestamps:** `birthtime`, `mtime` (modified), `ctime` (changed) — tracked per file
- **Extended attributes:** Custom key-value metadata on any file or directory
- **Symlinks:** Virtual directory entries that point to other targets

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

## JJFS Library

`jjfs.js` can be used independently in any JavaScript environment. Key exports:

```js
import {
  jjfsRead, jjfsWrite, jjfsEdit, jjfsDelete,
  jjfsMove, jjfsCopy, jjfsChmod, jjfsChown,
  jjfsSetSymlink, jjfsSetXattr,
  checkReadAccess, checkWriteAccess,
  getEffectivePermission, touchTimestamps, getTimestamps
} from './jjfs.js'
```

See `jjfs-website-2-0.md` for full library documentation.
