# JJFS — JavaScript Journaling File System

**Give any AI model a persistent, structured place to read and write files.**

---

## The Problem

AI language models are stateless by design. Every request arrives without memory of what
came before. You send a prompt, you get a response, and the model forgets everything.

This is fine for simple Q&A. It breaks down the moment you want the model to *build*
something across multiple turns — a codebase, a document, a configuration — because there
is nowhere for the work to live.

Common workarounds each have a cost:

| Workaround | Problem |
|------------|---------|
| Paste all files into every prompt | Context window fills fast; expensive |
| Store files server-side, summarize | Information is lost in translation |
| Ask the model to output a diff | Fragile; requires careful post-processing |
| Use a tool-call API | Locks you to one provider's function-calling format |

JJFS is a different answer: give the model a named virtual folder, teach it a simple
tagged syntax for reading and writing files inside that folder, and let it work.

---

## What JJFS Is

JJFS is a **virtual hierarchical file system** stored as a single nested JSON object.

```json
{
  "default": {
    "README.md": "# My Project\n\nA web app built with JJFS.",
    "src": {
      "index.js": "console.log('hello');",
      "utils.js": "export function add(a, b) { return a + b; }"
    }
  }
}
```

A workspace is a named root. A file is a string value. A directory is a nested object.
That is the entire data model.

The name "journaling" borrows from filesystem terminology: writes are immediately durable.
It does not mean append-only logs.

### In one sentence

> Give the AI a named folder, tell it how to read and write files using a simple tagged
> syntax, and let it get to work.

---

## The jjfs.js Library

JJFS ships as a single JavaScript file — `jjfs.js` — with **no dependencies and no
imports**. It is **universal**: it runs in any modern browser as an ES module, or in any
Node.js project via `import`.

```js
import {
  // Core file operations
  jjfsRead, jjfsWrite, jjfsEdit, jjfsDelete, jjfsMove, jjfsCopy,
  // Navigation and utilities
  jjfsNavigate, parseTarget, countFiles, normalizePath,
  // Permissions
  jjfsChmod, jjfsChown,
  getEffectivePermission, getPermBitsForKey,
  checkReadAccess, checkWriteAccess, checkOwnerAccess, checkStickyBit,
  setPermission, removePermissionsUnder,
  isValidMode, parseOctalBits, getStickyBit,
  // Timestamps
  touchTimestamps, getTimestamps, removeTimestampsUnder,
  // Symlinks
  jjfsSetSymlink, resolveSymlink, getSymlinksInDir, removeSymlinksUnder,
  // Extended attributes
  jjfsSetXattr, getXattrs, removeXattrsUnder, XATTR_NAME_RE,
  // Serialization
  hashPermForResponse,
} from './jjfs.js';
```

No `npm install`. No build step. Copy `jjfs.js` into your project and import it.

---

## Data Model

### Workspace map — `wsForKey`

All file operations take a `wsForKey` object as their first argument. It maps workspace
names to their directory trees:

```js
const wsForKey = {
  default: {
    'hello.txt': 'Hello, world!',
    src: {
      'index.js': 'console.log("hi");',
    },
  },
  docs: {
    'guide.md': '# Guide',
  },
};
```

- **File**: a string value at any key
- **Directory**: a nested plain object
- **Workspace root**: the top-level object for a workspace name

### Metadata stores

Permissions, timestamps, symlinks, and extended attributes are stored in separate
flat-keyed objects, always with the shape:

```js
{ email: { "wsName:/normalized/path": <value> } }
```

The `email` dimension scopes all metadata to a user account, matching the same namespace
as `wsForKey`. The path key is always a normalized absolute path (e.g. `default:/src/index.js`).

```js
// Permissions store
const fsPerms = {};      // { email: { "ws:/path": { mode, owner } } }

// Timestamps store
const fsTimestamps = {}; // { email: { "ws:/path": { birthtime, mtime, ctime } } }

// Symlinks store
const fsSymlinks = {};   // { email: { "ws:/path": "/target/path" } }

// Extended attributes store
const fsXattrs = {};     // { email: { "ws:/path": { "user.key": "value" } } }
```

All functions that operate on these stores take them as their **first parameter**. There
are no globals. Persistence is the caller's responsibility.

---

## Core File Operations

All mutating functions modify `wsForKey` in place and return `{ success, result }`. No
exceptions are thrown. On failure, `success` is `false` and `result` is a human-readable
error message.

### `jjfsRead(wsForKey, wsName, filePath, startLine?, endLine?)`

Read a file or list a directory.

- **File**: returns the full content string
- **File with line range**: returns only the specified lines (1-indexed, inclusive)
- **Directory**: returns newline-separated entry names; subdirectories have `/` appended
- **Root (`/`)**: lists all top-level entries in the workspace

```js
jjfsRead(wsForKey, 'default', '/hello.txt');
// → { success: true, result: 'Hello, world!' }

jjfsRead(wsForKey, 'default', '/src/index.js', 10, 20);
// → { success: true, result: '...lines 10–20...' }

jjfsRead(wsForKey, 'default', '/src');
// → { success: true, result: 'index.js\nutils.js' }

jjfsRead(wsForKey, 'default', '/');
// → { success: true, result: 'hello.txt\nsrc/' }
```

### `jjfsWrite(wsForKey, wsName, filePath, content)`

Create or fully overwrite a file. Intermediate directories are created automatically.
Returns `'Created: ...'` for new files and `'Overwrote: ...'` for existing ones.

```js
jjfsWrite(wsForKey, 'default', '/notes/todo.md', '- Buy milk');
// → { success: true, result: 'Created: default:/notes/todo.md' }
// Also creates /notes/ if it did not exist.

jjfsWrite(wsForKey, 'default', '/notes/todo.md', '- Buy milk\n- Buy eggs');
// → { success: true, result: 'Overwrote: default:/notes/todo.md' }
```

Cannot write to the workspace root (`/`). Fails if a file exists at a path that must be
a directory.

### `jjfsEdit(wsForKey, wsName, filePath, searchStr, replaceStr)`

Surgical search-and-replace within an existing file. `searchStr` must appear **exactly
once**. Returns an error if the search string is not found or appears more than once.

```js
jjfsEdit(wsForKey, 'default', '/src/math.js',
  'return a / b;',
  'if (b === 0) throw new Error("div by zero");\n  return a / b;'
);
// → { success: true, result: 'Edited: default:/src/math.js' }

jjfsEdit(wsForKey, 'default', '/src/math.js', 'nothere', 'x');
// → { success: false, result: 'Search text not found in: /src/math.js' }

jjfsEdit(wsForKey, 'default', '/src/math.js', 'return', 'x');
// → { success: false, result: 'Search text is not unique (3 matches) in: /src/math.js' }
```

Pass `''` as `replaceStr` to delete the matched section. The file must exist and be a
string (not a directory).

### `jjfsDelete(wsForKey, wsName, filePath)`

Remove a file or directory (including all contents). Cannot delete the workspace root.

```js
jjfsDelete(wsForKey, 'default', '/temp/scratch.txt');
// → { success: true, result: 'Deleted: default:/temp/scratch.txt' }
```

After a successful delete, clean up associated metadata using the cascade helpers:
`removePermissionsUnder`, `removeTimestampsUnder`, `removeSymlinksUnder`, `removeXattrsUnder`.

### `jjfsMove(wsForKey, wsName, srcPath, destPath)`

Relocate a file or directory within a workspace. Deep-copies the node, then deletes the
source. Intermediate destination directories are created automatically.

```js
jjfsMove(wsForKey, 'default', '/draft.html', '/published/index.html');
// → { success: true, result: 'Moved: default:/draft.html → /published/index.html' }
```

After a successful move, cascade-clean the source path's metadata and set new timestamps
on the destination.

### `jjfsCopy(wsForKey, wsName, srcPath, destPath)`

Deep-copy a file or directory to a new path within the same workspace.

```js
jjfsCopy(wsForKey, 'default', '/templates/base.html', '/pages/about.html');
// → { success: true, result: 'Created: default:/pages/about.html' }
```

---

## Navigation and Utilities

### `jjfsNavigate(workspace, pathStr)`

Resolve a POSIX path to `{ parent, name }` — the parent directory object and the final
path segment. Use this to implement custom operations on the tree without a full
read-modify-write cycle.

```js
const ws = wsForKey['default'];
const { parent, name } = jjfsNavigate(ws, '/src/index.js');
// parent === ws.src, name === 'index.js'
// parent[name] is the file's content

const nav = jjfsNavigate(ws, '/nonexistent/path');
// nav.error === 'Not a directory: /nonexistent'
```

Returns `{ error: string }` if a path component is not a directory, or if the path
refers to the workspace root.

### `parseTarget(target, forRead?)`

Parse a `"wsName:/path"` target string (as used in the AI action format) into its
components. Pass `forRead = true` to also parse an optional `":startLine:endLine"` suffix.

```js
parseTarget('default:/src/index.js');
// → { wsName: 'default', filePath: '/src/index.js' }

parseTarget('default:/src/index.js:10:30', true);
// → { wsName: 'default', filePath: '/src/index.js', startLine: 10, endLine: 30 }

parseTarget('');
// → { error: 'Invalid target — expected format: wsName:/path' }
```

### `countFiles(node)`

Recursively count all leaf files (string values) in a workspace tree or subtree.

```js
countFiles(wsForKey['default']);
// → 5 (if there are 5 files)

countFiles(wsForKey['default']['src']);
// → 2 (files under /src only)
```

### `normalizePath(p)`

Resolve a POSIX path: collapses multiple slashes, resolves `.` and `..`, always returns
a result starting with `/`.

```js
normalizePath('/src/../src/./index.js'); // → '/src/index.js'
normalizePath('src/index.js');           // → '/src/index.js'
normalizePath('');                       // → '/'
```

---

## Permissions

JJFS has a full POSIX-inspired permission system. Permissions are stored in a separate
`fsPerms` object and never touch the workspace tree.

### Permission entry shape

```js
{
  mode: "ro" | "rw" | "644" | "1755" | { callerId: "ro"|"rw"|"0"-"7", "*": ... },
  owner: "callerId" | ["id1", "id2"] | null
}
```

### Mode formats

| Format | Meaning |
|--------|---------|
| `"rw"` | Everyone can read and write (default — no entry needed) |
| `"ro"` | Everyone can only read |
| `"644"` | Owner: read+write, others: read-only |
| `"755"` | Owner: read+write+execute, others: read+execute |
| `"1755"` | Sticky bit + 755: only owner can delete files in this dir |
| `{ "keyA": "ro", "*": "rw" }` | ACL object: keyA gets read-only, everyone else read+write |

ACL object values are `"ro"`, `"rw"`, or a single octal digit (`"6"` = read+write,
`"4"` = read-only, `"7"` = read+write+execute). `null` in an ACL value removes that
key's entry.

### Permission inheritance

Permissions propagate down the tree. If `/src` has mode `"ro"` and `/src/index.js` has
no entry, `/src/index.js` is effectively read-only. The most specific ancestor wins.

### `callerId`

A `callerId` is an opaque string identifying the caller — typically an API key. Pass
`null` to bypass all permission checks (session auth / server-side operations always
pass).

---

### `getEffectivePermission(fsPerms, email, wsName, filePath)`

Find the most specific applicable permission for a path, searching from the path itself
up to the workspace root. Returns the entry augmented with `{ effectivePath, inherited }`,
or `null` if no permission is set anywhere in the chain.

```js
const perm = getEffectivePermission(fsPerms, 'alice@example.com', 'default', '/src/index.js');
// perm.mode       → e.g. "ro"
// perm.effectivePath → "/src"  (if the entry is on /src, not the file itself)
// perm.inherited  → true
```

### `getPermBitsForKey(perm, callerId)`

Decode the read/write/execute bits for a specific caller from a permission entry.

```js
const bits = getPermBitsForKey(perm, 'myApiKey');
// → { read: true, write: false, execute: false }
```

Returns `{ read: true, write: true, execute: false }` when `perm` is null (no restriction).

### `checkReadAccess(fsPerms, email, wsName, filePath, callerId)`
### `checkWriteAccess(fsPerms, email, wsName, filePath, callerId)`

Check whether a caller has read or write access to a path. Pass `null` as `callerId` to
bypass (session auth). Returns `{ allowed: true }` or `{ allowed: false, error: string }`.

```js
const r = checkWriteAccess(fsPerms, 'alice@example.com', 'default', '/src/index.js', 'myKey');
if (!r.allowed) return respondWithError(403, r.error);
```

The error message includes the path that provided the restriction and whether it was
inherited — helpful for debugging permission issues.

### `checkOwnerAccess(fsPerms, email, wsName, filePath, callerId)`

Check whether a caller is permitted to change permissions on a path. A path with no
explicit owner allows anyone to modify it. Once an owner is set, only a listed owner can
modify permissions on that exact path (ownership is not inherited).

```js
const oc = checkOwnerAccess(fsPerms, 'alice@example.com', 'default', '/src', 'myKey');
if (!oc.allowed) return respondWithError(403, oc.error);
```

### `checkStickyBit(fsPerms, email, wsName, filePath, callerId)`

When a directory has the sticky bit set (octal mode `1xxx`, e.g. `"1755"`), only the
file's owner or the directory's owner may delete or rename that file. This mirrors
`/tmp` semantics on Linux.

```js
const sc = checkStickyBit(fsPerms, 'alice@example.com', 'default', '/shared/file.txt', 'myKey');
if (!sc.allowed) return respondWithError(403, sc.error);
```

### `setPermission(fsPerms, email, wsName, filePath, updates)`

Upsert a permission entry. `updates` may contain `mode` and/or `owner`.

- **String mode**: replaces the existing mode entirely
- **Object mode**: merges into the existing ACL (set a key to `null` to remove it)
- When the resulting entry has no meaningful mode and no owner, the entry is removed
  (keeping the store clean)

```js
// Set read-only for everyone
setPermission(fsPerms, 'alice@example.com', 'default', '/src', { mode: 'ro' });

// Grant a specific key write access while keeping everyone else read-only
setPermission(fsPerms, 'alice@example.com', 'default', '/src', {
  mode: { 'myApiKey': 'rw', '*': 'ro' }
});

// Remove a specific key from the ACL
setPermission(fsPerms, 'alice@example.com', 'default', '/src', {
  mode: { 'myApiKey': null }
});

// Set owner
setPermission(fsPerms, 'alice@example.com', 'default', '/src', { owner: 'myApiKey' });
```

### `removePermissionsUnder(fsPerms, email, wsName, filePath)`

Remove all permission entries at and below a path. Call this after `jjfsDelete` or
`jjfsMove` to prevent stale entries.

```js
removePermissionsUnder(fsPerms, 'alice@example.com', 'default', '/src');
```

### `jjfsChmod(fsPerms, email, wsName, filePath, mode, callerId)`

Set the mode on a path. Validates the mode string, checks ownership, then calls
`setPermission`. Returns `{ success, status, result }`.

```js
const r = jjfsChmod(fsPerms, 'alice@example.com', 'default', '/src', '755', 'myKey');
// → { success: true, status: 200, result: 'Mode set on default:/src' }

jjfsChmod(fsPerms, 'alice@example.com', 'default', '/src', 'invalid', 'myKey');
// → { success: false, status: 400, result: 'chmod must be "ro", "rw", ...' }
```

Does not save or update timestamps — the caller must do both after a successful result.

### `jjfsChown(fsPerms, email, wsName, filePath, owner, validOwners, callerId)`

Set the owner of a path. `owner` must be a caller ID (or array of IDs) from
`validOwners`, or `null` to remove ownership. Checks ownership before applying.
Returns `{ success, status, result }`.

```js
const validKeys = account.apiKeys.map(k => k.key);
const r = jjfsChown(fsPerms, 'alice@example.com', 'default', '/src', 'myKey', validKeys, 'myKey');
// → { success: true, status: 200, result: 'Owner set: default:/src' }

jjfsChown(fsPerms, 'alice@example.com', 'default', '/src', null, validKeys, 'myKey');
// → { success: true, status: 200, result: 'Owner removed: default:/src' }
```

Does not save or update timestamps — the caller must do both after a successful result.

### `isValidMode(mode)`

Returns `true` if `mode` is a valid permission value: `"ro"`, `"rw"`, a 3–4 digit octal
string, or an ACL object with valid values.

### `parseOctalBits(digit)`

Parse a single octal digit string into `{ read, write, execute }` booleans.

```js
parseOctalBits('6'); // → { read: true, write: true, execute: false }
parseOctalBits('5'); // → { read: true, write: false, execute: true }
```

### `getStickyBit(mode)`

Returns `true` if a 4-digit octal mode string has the sticky bit set (first digit has
bit 1 set, e.g. `"1755"`, `"1777"`).

---

## Timestamps

JJFS tracks POSIX-style timestamps per path. All timestamp functions take `fsTimestamps`
as their first parameter.

| Timestamp | When to set |
|-----------|-------------|
| `birthtime` | First creation of a file or directory |
| `mtime` | Any change to file content (`jjfsWrite`, `jjfsEdit`) |
| `ctime` | Any metadata change: content, permissions, ownership, xattr, rename |

Timestamps are ISO-8601 strings (e.g. `"2025-03-07T14:23:00.000Z"`).

### `touchTimestamps(fsTimestamps, email, wsName, filePath, fields)`

Set the given fields to the current time. `fields` is an array containing any combination
of `'birthtime'`, `'mtime'`, `'ctime'`.

```js
// New file: set all three
touchTimestamps(fsTimestamps, 'alice@example.com', 'default', '/notes.md',
  ['birthtime', 'mtime', 'ctime']);

// Content updated: mtime and ctime
touchTimestamps(fsTimestamps, 'alice@example.com', 'default', '/notes.md',
  ['mtime', 'ctime']);

// Metadata change only (chmod, chown, xattr): ctime only
touchTimestamps(fsTimestamps, 'alice@example.com', 'default', '/notes.md',
  ['ctime']);
```

### `getTimestamps(fsTimestamps, email, wsName, filePath)`

Return the timestamp object for a path, or `null` if none recorded.

```js
getTimestamps(fsTimestamps, 'alice@example.com', 'default', '/notes.md');
// → { birthtime: '2025-03-01T...', mtime: '2025-03-07T...', ctime: '2025-03-07T...' }
// → null (if not recorded)
```

### `removeTimestampsUnder(fsTimestamps, email, wsName, filePath)`

Remove all timestamp entries at and below a path. Call this after `jjfsDelete` or the
source side of `jjfsMove`.

```js
removeTimestampsUnder(fsTimestamps, 'alice@example.com', 'default', '/temp');
```

---

## Symbolic Links

Symlinks are stored as metadata alongside the tree — the JJFS tree itself is never
modified. A symlink maps one path to a target path within the same workspace.

All symlink functions take `fsSymlinks` as their first parameter.

### `jjfsSetSymlink(fsSymlinks, email, wsName, filePath, target)`

Create or remove a single symlink. Pass `null` or an empty string as `target` to remove.

```js
// Create
jjfsSetSymlink(fsSymlinks, 'alice@example.com', 'default', '/current', '/releases/v2');
// → { success: true, result: 'Symlink created: default:/current -> /releases/v2' }

// Remove
jjfsSetSymlink(fsSymlinks, 'alice@example.com', 'default', '/current', null);
// → { success: true, result: 'Symlink removed: default:/current' }
```

Does not update timestamps — the caller must call `touchTimestamps` after.

### `resolveSymlink(fsSymlinks, email, wsName, filePath, depth?)`

Follow a symlink chain, returning `{ path }` when the chain ends at a real path, or
`{ error }` if the chain exceeds 8 hops (matching Linux `MAXSYMLINKS`).

```js
// /current → /releases/v2 → /releases/2025-03-07
resolveSymlink(fsSymlinks, 'alice@example.com', 'default', '/current');
// → { path: '/releases/2025-03-07' }

// Circular symlink detected
resolveSymlink(fsSymlinks, 'alice@example.com', 'default', '/loop');
// → { error: 'Too many levels of symbolic links' }
```

### `getSymlinksInDir(fsSymlinks, email, wsName, dirPath)`

Return a `{ name: "/target" }` map of all symlinks whose source is a **direct child** of
`dirPath` (one segment below it, not deeper). Use this to overlay symlinks onto a
directory listing.

```js
getSymlinksInDir(fsSymlinks, 'alice@example.com', 'default', '/');
// → { current: '/releases/v2', latest: '/releases/v2' }
```

### `removeSymlinksUnder(fsSymlinks, email, wsName, filePath)`

Remove all symlink entries at and below a path. Call this after `jjfsDelete` or the
source side of `jjfsMove`.

---

## Extended Attributes

Extended attributes are arbitrary key-value string pairs attached to any path. They
follow the Linux xattr namespace convention.

Valid attribute names must match: **`user.<name>`** or **`trusted.<name>`**, where
`<name>` contains only alphanumeric characters, `.`, `_`, or `-`.

```js
XATTR_NAME_RE; // /^(user|trusted)\.[a-zA-Z0-9._-]+$/
```

All xattr functions take `fsXattrs` as their first parameter.

### `jjfsSetXattr(fsXattrs, email, wsName, filePath, op)`

Apply a set/remove operation to a path's xattrs. `op` has the shape:

```js
{
  set:    { "user.color": "blue", "user.tag": "important" },  // optional
  remove: ["user.old-key"]                                     // optional; string or array
}
```

Returns `{ success: false, status: 400, result: errorMessage }` if any key in `set` is
invalid. Returns `{ success: true, status: 200 }` otherwise.

```js
jjfsSetXattr(fsXattrs, 'alice@example.com', 'default', '/notes.md', {
  set: { 'user.color': 'blue' },
  remove: ['user.old-tag'],
});
// → { success: true, status: 200, result: 'xattrs updated: default:/notes.md' }

jjfsSetXattr(fsXattrs, 'alice@example.com', 'default', '/notes.md', {
  set: { 'system.reserved': 'x' },
});
// → { success: false, status: 400, result: 'Invalid xattr name: "system.reserved". Must match user.* or trusted.*' }
```

Does not update timestamps — the caller must call `touchTimestamps` after.

### `getXattrs(fsXattrs, email, wsName, filePath)`

Return the xattr map for a path, or `{}` if none recorded.

```js
getXattrs(fsXattrs, 'alice@example.com', 'default', '/notes.md');
// → { 'user.color': 'blue', 'user.tag': 'important' }
```

### `removeXattrsUnder(fsXattrs, email, wsName, filePath)`

Remove all xattr entries at and below a path. Call this after `jjfsDelete` or the source
side of `jjfsMove`.

---

## Permission Serialization

### `hashPermForResponse(perm, hashFn)`

Convert a stored permission entry into a **response-safe** form by replacing raw caller
IDs (API keys) with opaque tokens via `hashFn`. This ensures that raw key values are
never exposed in API responses — callers identify themselves by computing
`hashFn(theirKey)` and matching against the output.

```js
// In a Node.js server using SHA-256:
import crypto from 'crypto';
const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');

hashPermForResponse(perm, hashKey);
// → {
//     mode: { "a3f4...": "rw", "*": "ro" },  // keys are SHA-256 hashes
//     owner: ["a3f4..."],
//     effectivePath: "/src",
//     inherited: true
//   }

// In a browser, use SubtleCrypto, or pass identity to skip hashing:
hashPermForResponse(perm, k => k);
```

Returns `null` when `perm` is null. Preserves `effectivePath` and `inherited` fields
from `getEffectivePermission`.

---

## Full Function Reference

### Core operations

| Function | Signature | Returns |
|----------|-----------|---------|
| `jjfsRead` | `(wsForKey, wsName, filePath, startLine?, endLine?)` | `{ success, result }` |
| `jjfsWrite` | `(wsForKey, wsName, filePath, content)` | `{ success, result }` |
| `jjfsEdit` | `(wsForKey, wsName, filePath, searchStr, replaceStr)` | `{ success, result }` |
| `jjfsDelete` | `(wsForKey, wsName, filePath)` | `{ success, result }` |
| `jjfsMove` | `(wsForKey, wsName, srcPath, destPath)` | `{ success, result }` |
| `jjfsCopy` | `(wsForKey, wsName, srcPath, destPath)` | `{ success, result }` |

### Navigation and utilities

| Function | Signature | Returns |
|----------|-----------|---------|
| `jjfsNavigate` | `(workspace, pathStr)` | `{ parent, name }` or `{ error }` |
| `parseTarget` | `(target, forRead?)` | `{ wsName, filePath, startLine?, endLine? }` or `{ error }` |
| `countFiles` | `(node)` | `number` |
| `normalizePath` | `(p)` | `string` (always starts with `/`) |

### Permissions

| Function | Signature | Returns |
|----------|-----------|---------|
| `jjfsChmod` | `(fsPerms, email, wsName, filePath, mode, callerId)` | `{ success, status, result }` |
| `jjfsChown` | `(fsPerms, email, wsName, filePath, owner, validOwners, callerId)` | `{ success, status, result }` |
| `getEffectivePermission` | `(fsPerms, email, wsName, filePath)` | `{ mode, owner, effectivePath, inherited }` or `null` |
| `getPermBitsForKey` | `(perm, callerId)` | `{ read, write, execute }` |
| `checkReadAccess` | `(fsPerms, email, wsName, filePath, callerId)` | `{ allowed }` or `{ allowed, error }` |
| `checkWriteAccess` | `(fsPerms, email, wsName, filePath, callerId)` | `{ allowed }` or `{ allowed, error }` |
| `checkOwnerAccess` | `(fsPerms, email, wsName, filePath, callerId)` | `{ allowed }` or `{ allowed, error }` |
| `checkStickyBit` | `(fsPerms, email, wsName, filePath, callerId)` | `{ allowed }` or `{ allowed, error }` |
| `setPermission` | `(fsPerms, email, wsName, filePath, updates)` | `void` |
| `removePermissionsUnder` | `(fsPerms, email, wsName, filePath)` | `void` |
| `isValidMode` | `(mode)` | `boolean` |
| `parseOctalBits` | `(digit)` | `{ read, write, execute }` |
| `getStickyBit` | `(mode)` | `boolean` |

### Timestamps

| Function | Signature | Returns |
|----------|-----------|---------|
| `touchTimestamps` | `(fsTimestamps, email, wsName, filePath, fields)` | `void` |
| `getTimestamps` | `(fsTimestamps, email, wsName, filePath)` | `{ birthtime, mtime, ctime }` or `null` |
| `removeTimestampsUnder` | `(fsTimestamps, email, wsName, filePath)` | `void` |

### Symlinks

| Function | Signature | Returns |
|----------|-----------|---------|
| `jjfsSetSymlink` | `(fsSymlinks, email, wsName, filePath, target)` | `{ success, result }` |
| `resolveSymlink` | `(fsSymlinks, email, wsName, filePath, depth?)` | `{ path }` or `{ error }` |
| `getSymlinksInDir` | `(fsSymlinks, email, wsName, dirPath)` | `{ name: "/target", ... }` |
| `removeSymlinksUnder` | `(fsSymlinks, email, wsName, filePath)` | `void` |

### Extended attributes

| Function / constant | Signature | Returns |
|---------------------|-----------|---------|
| `jjfsSetXattr` | `(fsXattrs, email, wsName, filePath, op)` | `{ success, status, result }` |
| `getXattrs` | `(fsXattrs, email, wsName, filePath)` | `{ "user.key": "value", ... }` |
| `removeXattrsUnder` | `(fsXattrs, email, wsName, filePath)` | `void` |
| `XATTR_NAME_RE` | — | `RegExp` |

### Serialization

| Function | Signature | Returns |
|----------|-----------|---------|
| `hashPermForResponse` | `(perm, hashFn)` | Safe permission object or `null` |

---

## Cascade Pattern

Any operation that removes or relocates a path must clean up all four metadata stores.
The standard cascade is:

```js
// After jjfsDelete or the source side of jjfsMove:
removePermissionsUnder(fsPerms,      email, wsName, path);
removeTimestampsUnder(fsTimestamps,  email, wsName, path);
removeSymlinksUnder(fsSymlinks,      email, wsName, path);
removeXattrsUnder(fsXattrs,          email, wsName, path);
```

Then save all four stores. After a move or copy, set new timestamps on the destination:

```js
// After jjfsMove — destination gets mtime + ctime (not a new birthtime)
touchTimestamps(fsTimestamps, email, wsName, destPath, ['mtime', 'ctime']);

// After jjfsCopy — destination is brand new, gets all three
touchTimestamps(fsTimestamps, email, wsName, destPath, ['birthtime', 'mtime', 'ctime']);
```

---

## Adding Persistence and a Server

The library operates on in-memory objects. To persist data between server restarts, load
from disk on startup and save after each mutation:

```js
import fs from 'fs';
import { jjfsWrite, jjfsRead } from './jjfs.js';

const WORKSPACES_FILE  = './workspaces.json';
const PERMISSIONS_FILE = './permissions.json';
const TIMESTAMPS_FILE  = './timestamps.json';
const SYMLINKS_FILE    = './symlinks.json';
const XATTRS_FILE      = './xattrs.json';

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

const wsForKey    = load(WORKSPACES_FILE);
const fsPerms     = load(PERMISSIONS_FILE);
const fsTimestamps = load(TIMESTAMPS_FILE);
const fsSymlinks  = load(SYMLINKS_FILE);
const fsXattrs    = load(XATTRS_FILE);

if (!wsForKey.default) wsForKey.default = {};

// Write a file, then persist
const result = jjfsWrite(wsForKey, 'default', '/notes.md', '# Notes');
if (result.success) {
  touchTimestamps(fsTimestamps, 'alice@example.com', 'default', '/notes.md',
    ['birthtime', 'mtime', 'ctime']);
  fs.writeFileSync(WORKSPACES_FILE,  JSON.stringify(wsForKey,    null, 2));
  fs.writeFileSync(TIMESTAMPS_FILE,  JSON.stringify(fsTimestamps, null, 2));
}
```

---

## Wiring into an HTTP server: POST /api/fs/execute

The standard integration point is a single POST endpoint that dispatches all JJFS
operations. The AI (or any client) sends `{ type, target, content }` and gets back
`{ success, result }`.

```js
// type:    one of the JJFS operation types below
// target:  'wsName:/path'  (or 'wsName:/path:startLine:endLine' for READ)
// content: depends on type (see table)
```

| `type` | `content` |
|--------|-----------|
| `JJFS_READ` | not used |
| `JJFS_WRITE` | file content string |
| `JJFS_EDIT` | `{"search":"...","replace":"..."}` |
| `JJFS_DELETE` | not used |
| `JJFS_MOVE` | destination path string |
| `JJFS_COPY` | destination path string |
| `JJFS_CHMOD` | mode string or ACL object |
| `JJFS_CHOWN` | caller ID string, array of IDs, or `null` |
| `JJFS_SYMLINK` | target path string |
| `JJFS_GETXATTR` | not used |
| `JJFS_SETXATTR` | `{"set":{...},"remove":[...]}` |

The `parseTarget` export handles the `target` string format:

```js
import { parseTarget } from './jjfs.js';
const { wsName, filePath, startLine, endLine } = parseTarget(target, type === 'JJFS_READ');
```

---

## The Hosted Option: data2l.ink

Running your own server is optional. **data2l.ink** provides JJFS as a cloud service.

- **No server to maintain** — create an account, generate an API key, start writing files
- **Multi-tenant** — each API key has its own isolated workspace partition
- **API key auth** — pass your key in the `X-API-Key` header
- **Automatic `default` workspace** — provisioned for every new key

```bash
# Write a file
curl -X POST https://data2l.ink/api/fs/execute \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"JJFS_WRITE","target":"default:/hello.txt","content":"Hello!"}'

# Read it back
curl -X POST https://data2l.ink/api/fs/execute \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"JJFS_READ","target":"default:/hello.txt"}'
```

Both return `{ success: true, result: "..." }`.

---

## AI System Prompt Template

Copy this block into any AI model's system prompt. Substitute workspace names as needed.
This is the only thing you need to add to make a model JJFS-aware.

```
You have access to JJFS (JavaScript Journaling File System) — a persistent virtual
file system. Use it to create, read, and edit files. Actions are embedded directly
in your response using the formats below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE WORKSPACES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  default    — General purpose workspace for all files

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE ACTIONS (embed in your response)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

READ a file:
  [ACTION:JJFS_READ]workspace:/path[/ACTION:JJFS_READ]

READ with line range:
  [ACTION:JJFS_READ]workspace:/path:30:50[/ACTION:JJFS_READ]

WRITE (create or overwrite) a file:
  [ACTION:JJFS_WRITE:workspace:/path:file content here[/ACTION]

EDIT (surgical search-and-replace) an existing file:
  [ACTION:JJFS_EDIT:workspace:/path:{"search":"exact text","replace":"new text"}[/ACTION]

DELETE a file or directory:
  [ACTION:JJFS_DELETE:workspace:/path[/ACTION]

MOVE a file:
  [ACTION:JJFS_MOVE:workspace:/old/path:/new/path[/ACTION]

COPY a file:
  [ACTION:JJFS_COPY:workspace:/src/path:/dest/path[/ACTION]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. NEVER paste file content directly in your response text. Always use JJFS_WRITE or
   JJFS_EDIT to deliver file content.

2. PREFER JJFS_EDIT over JJFS_WRITE for existing files.
   - JJFS_WRITE replaces the entire file.
   - JJFS_EDIT replaces only the section you specify. It is safer and shows intent.

3. To edit an existing file:
   a. Read the relevant section first.
   b. Identify exactly what needs to change.
   c. Edit only that section with a search string that appears exactly once.

4. JJFS_WRITE is correct for new files or when the user explicitly requests a full rewrite.

5. JJFS_EDIT rules:
   - The "search" text must appear EXACTLY ONCE in the file.
   - Include enough surrounding context to be unique (function signature + a few lines).
   - Whitespace in "search" must match exactly.
   - Use "" (empty string) for "replace" to delete the matched section.

6. Always wait for the result of a READ before issuing an EDIT.

7. Do not output code blocks in your prose. Put all code in JJFS files.
```

---

## Action Reference

The AI embeds JJFS operations as tagged strings in its response. The host application
parses these tags from the response stream and executes them against the JJFS backend.

### JJFS_READ

```
[ACTION:JJFS_READ]workspace:/path[/ACTION:JJFS_READ]
[ACTION:JJFS_READ]workspace:/path:30:50[/ACTION:JJFS_READ]
```

For a file: returns the content string. With a line range: returns lines prefixed with
line numbers (`30→content`). For a directory: returns newline-separated names with `/`
appended to subdirectories.

### JJFS_WRITE

```
[ACTION:JJFS_WRITE:workspace:/path:file content goes here[/ACTION]
```

Creates or fully overwrites a file. Creates intermediate directories automatically.
Use for new files only — prefer `JJFS_EDIT` for modifying existing files.

### JJFS_EDIT

```
[ACTION:JJFS_EDIT:workspace:/path:{"search":"exact text to find","replace":"new text"}[/ACTION]
```

Surgically replaces one specific section of an existing file. The search text must appear
exactly once in the file. Fails safely — if the text is not found or not unique, nothing
is changed.

**Rules:**
- Include enough surrounding context to make the search text unique
- Whitespace must match exactly — spaces, tabs, and newlines are significant
- Both `search` and `replace` should be syntactically complete
- Set `replace` to `""` to delete the matched section

### JJFS_DELETE

```
[ACTION:JJFS_DELETE:workspace:/path[/ACTION]
```

### JJFS_MOVE

```
[ACTION:JJFS_MOVE:workspace:/old/path:/new/path[/ACTION]
```

### JJFS_COPY

```
[ACTION:JJFS_COPY:workspace:/src/path:/dest/path[/ACTION]
```

---

## Frontend Action Parser

The frontend parses JJFS action tags from the AI's response text and calls
`/api/fs/execute` for each one. Since `jjfs.js` has no Node.js dependencies,
future integrations could skip the round-trip and execute operations locally in the
browser — but the HTTP path works universally with any backend.

```js
// Parse all complete JJFS actions from model output text.
const ACTION_TYPES = 'JJFS_WRITE|JJFS_EDIT|JJFS_DELETE|JJFS_MOVE|JJFS_COPY';
const ACTION_RE = new RegExp(
  `\\[ACTION:(${ACTION_TYPES}):([\\s\\S]+?)\\[/ACTION\\]`,
  'g'
);
const READ_RE = /\[ACTION:JJFS_READ\]([\s\S]+?)\[\/ACTION:JJFS_READ\]/g;

function parseActions(text) {
  const actions = [];
  let m;

  // JJFS_READ uses a different closing tag
  while ((m = READ_RE.exec(text)) !== null) {
    actions.push({ type: 'JJFS_READ', target: m[1].trim(), content: null });
  }

  // All other operations: [ACTION:TYPE:target:content[/ACTION]
  while ((m = ACTION_RE.exec(text)) !== null) {
    const [, type, rest] = m;

    if (type === 'JJFS_EDIT') {
      const jsonStart = rest.lastIndexOf(':{');
      if (jsonStart === -1) continue;
      actions.push({ type, target: rest.slice(0, jsonStart), content: rest.slice(jsonStart + 1) });
    } else if (type === 'JJFS_MOVE' || type === 'JJFS_COPY') {
      const lastColon = rest.lastIndexOf(':');
      actions.push({
        type,
        target: lastColon > -1 ? rest.slice(0, lastColon) : rest,
        content: lastColon > -1 ? rest.slice(lastColon + 1) : null,
      });
    } else {
      // JJFS_WRITE / JJFS_DELETE
      const firstColon = rest.indexOf(':');
      actions.push({
        type,
        target: firstColon > -1 ? rest.slice(0, firstColon) : rest,
        content: firstColon > -1 ? rest.slice(firstColon + 1) : null,
      });
    }
  }

  return actions;
}

async function executeAction(action, apiKey, baseUrl = '') {
  const resp = await fetch(`${baseUrl}/api/fs/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(action),
  });
  return resp.json(); // { success, result }
}

// Usage: process AI response text
async function processAIResponse(text, apiKey) {
  const actions = parseActions(text);
  const results = [];
  for (const action of actions) {
    results.push(await executeAction(action, apiKey));
  }
  return results;
}
```

---

## HTTP API Reference

All endpoints require an `X-API-Key` header with a valid API key (or a session cookie
for browser sessions). All responses follow `{ success: boolean, result: string }`.

### POST /api/fs/execute

The primary entry point for all file operations.

**Request body:**

```json
{
  "type":    "JJFS_READ",
  "target":  "workspace:/path",
  "content": "..."
}
```

| `type` | `target` | `content` |
|--------|----------|-----------|
| `JJFS_READ` | `ws:/path` or `ws:/path:start:end` | not used |
| `JJFS_WRITE` | `ws:/path` | file content string |
| `JJFS_EDIT` | `ws:/path` | `{"search":"...","replace":"..."}` |
| `JJFS_DELETE` | `ws:/path` | not used |
| `JJFS_MOVE` | `ws:/srcpath` | `/destpath` string |
| `JJFS_COPY` | `ws:/srcpath` | `/destpath` string |
| `JJFS_CHMOD` | `ws:/path` | mode string or ACL object |
| `JJFS_CHOWN` | `ws:/path` | caller ID, array of IDs, or `null` |
| `JJFS_SYMLINK` | `ws:/path` | target path string |
| `JJFS_GETXATTR` | `ws:/path` | not used |
| `JJFS_SETXATTR` | `ws:/path` | `{"set":{...},"remove":[...]}` |

---

### Workspace Management

```
GET  /api/fs/workspaces
     Response: { workspaces: [{ name, fileCount }], count }

POST /api/fs/workspaces
     Body: { "name": "myworkspace" }
     Response: { success: true, name }

DELETE /api/fs/workspaces/:name
     (cannot delete "default")
     Response: { success: true }

GET  /api/fs/browse?workspace=name&path=/dir[&all=1]
     Response: { success, workspace, path, type, entries | content,
                 timestamps, permission, xattrs }
```

---

### REST File Endpoints

```
GET    /api/fs/:workspace/*path          Read file (text) or list directory (JSON)
                                         ?start=N&end=M  — line range
                                         ?nofollow=1     — return symlink metadata, don't follow
                                         ?all=1          — include dot-files in directory listings

PUT    /api/fs/:workspace/*path          Write file (raw body)

DELETE /api/fs/:workspace/*path          Delete file or directory

POST   /api/fs/:workspace/*path          Move or copy
                                         Body: { "op": "move"|"copy", "destination": "/path" }

PATCH  /api/fs/:workspace/*path          One of the following body shapes:
                                         { "search": "...", "replace": "..." }   — edit file
                                         { "chmod": "ro"|"rw"|"644"|ACL }        — set mode
                                         { "chown": "keyId"|["k1","k2"]|null }   — set owner
                                         { "symlink": "/target"|null }           — create/remove symlink
                                         { "xattr": { "set": {...}, "remove": [...] } }
```

#### Response headers on GET (file)

When `GET /api/fs/:workspace/*path` returns a file, the following headers are included:

| Header | Value |
|--------|-------|
| `X-JJFS-Permission` | JSON — effective permission entry (owner IDs are SHA-256 hashed) |
| `X-JJFS-Mode` | The raw mode string (e.g. `"ro"`, `"644"`) |
| `X-JJFS-Owner` | Comma-separated SHA-256 hashes of owner IDs (empty if unowned) |
| `X-JJFS-Timestamps` | JSON — `{ birthtime, mtime, ctime }` (omitted if not recorded) |

---

## Design Decisions

### Why a flat JSON file instead of a real database?

JJFS is designed for AI workloads, not high-throughput production traffic. The
in-memory + single-JSON-file model means zero setup, a fully inspectable state,
trivial backup, and the ability to serialize the entire workspace in one operation.

For high-write scenarios, swap the persistence layer (SQLite, Redis) while keeping
the same `jjfs.js` functions and API.

### Why a universal JS library with no Node.js dependency?

Making `jjfs.js` dependency-free means:

- It can run in the browser — useful for offline-first or local-only applications
- It can be embedded in any JavaScript environment without adaptation
- The persistence strategy is decoupled from the data logic, so callers choose their own

### Why tagged action syntax instead of tool calls?

Tool-call APIs (OpenAI function calling, Anthropic tool use) are model-specific and
require specific API support. The tagged action syntax works with any model that can
follow instructions — including local models via Ollama and models that do not support
structured tool use.

It also makes actions visible in the response stream immediately, which improves the
user experience during streaming.

### Why is JJFS_EDIT preferred over JJFS_WRITE?

Writing an entire file to fix a two-line bug is a blunt instrument. JJFS_EDIT:
- Makes intent explicit — the model shows what it changed and why
- Limits blast radius — only the matched section is touched
- Fails safely — if the search text is ambiguous or not found, nothing is overwritten

### Why do permission functions take the store as an argument?

Rather than operating on global state, every function takes its store as the first
parameter. This keeps `jjfs.js` universal — there are no globals and no hidden
dependencies. It also makes testing trivial: pass in a plain object, check the result.

### Why are owner IDs hashed in responses?

Raw API keys must never appear in responses — a key that can write files can also be
used to overwrite them. All external permission responses pass owner and ACL keys
through `hashPermForResponse(perm, hashFn)`. Callers identify themselves by computing
`hashFn(theirKey)` and matching against the hashed values. The hash function is provided
by the caller, keeping `jjfs.js` environment-agnostic.

---

## Integration Checklist

### Self-hosted

- [ ] Copy `jjfs.js` into your project
- [ ] In your server, initialize all five stores from disk on startup:
  `wsForKey`, `fsPerms`, `fsTimestamps`, `fsSymlinks`, `fsXattrs`
- [ ] Wire `POST /api/fs/execute` using the dispatch pattern above
- [ ] Apply the cascade pattern (clean all four metadata stores) after delete and move
- [ ] Use `touchTimestamps` after every mutation with the appropriate fields
- [ ] Use `hashPermForResponse` before returning any permission data to clients
- [ ] Add workspace management endpoints as needed
- [ ] Add the frontend action parser to your streaming handler
- [ ] Inject the AI System Prompt Template into your model's system prompt
- [ ] Decide on persistence: JSON files for simple use, SQLite/Redis for multi-tenant

### Using data2l.ink

- [ ] Sign up at data2l.ink and generate an API key
- [ ] Add the frontend action parser to your app (pass your API key + base URL)
- [ ] Inject the AI System Prompt Template into your model's system prompt
- [ ] Done — no server to run or maintain

---

## Frequently Asked Questions

**Can JJFS handle binary files?**
No. Files are stored as JSON strings, so content is text-only. Binary data would need
to be base64-encoded before writing.

**Can multiple users share a workspace?**
Yes — use the permission system. Set a mode on the workspace root (e.g. `"ro"`) and
grant write access to specific API keys via an ACL object. The sticky bit (`"1755"`)
on shared directories prevents users from deleting each other's files.

**What happens if two requests write simultaneously?**
Last write wins. There is no locking. For single-user or low-concurrency applications
this is fine. For multi-user production use, replace the JSON file persistence with
SQLite (WAL mode) or a key-value store with compare-and-swap.

**Can the AI create workspaces?**
Not by default — workspace creation is a management operation. If you want the AI to
create workspaces, expose a `WORKSPACE_CREATE` action in your execute handler.

**Is JJFS_EDIT safe with minified files?**
No. Minified files are typically a single long line, making a unique search string
nearly impossible. Always keep non-minified source in JJFS workspaces.

**Can I use jjfs.js directly in the browser without a server?**
Yes. Import it via `<script type="module">`, create your store objects in memory,
and call the functions directly. Wire persistence to `localStorage`, `IndexedDB`,
or a remote API as needed. For `hashPermForResponse`, pass the Web Crypto API's
`SubtleCrypto.digest` (async) or an identity function `k => k` if hashing is not
required.

**Does JJFS support file watching?**
No. It is a synchronous, request-driven system. To notify your application when the AI
writes a file, wrap the mutating functions with an event emitter or callback on your
server layer.

**What does `callerId = null` mean?**
All access-check functions (`checkReadAccess`, `checkWriteAccess`, `checkOwnerAccess`,
`checkStickyBit`) treat `null` as a trusted caller that bypasses all permission checks.
Use this for server-side or session-authenticated operations where no API key is involved.

**How do I read which permissions apply to a path?**
Call `getEffectivePermission(fsPerms, email, wsName, filePath)`. The result includes
`effectivePath` (where the permission was set) and `inherited: true` if the permission
came from an ancestor path rather than the path itself.

---

## License

JJFS is a free concept. The `jjfs.js` library is released into the public domain.
Use it, fork it, adapt it, ship products with it. No attribution required.
