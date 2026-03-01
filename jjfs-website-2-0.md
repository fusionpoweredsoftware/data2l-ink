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

JJFS ships as a single JavaScript file — `jjfs.js` — with no dependencies and no imports.
It is **universal**: it runs in any modern browser as an ES module, or in any Node.js
project via `import`.

```js
import {
  jjfsRead,
  jjfsWrite,
  jjfsEdit,
  jjfsDelete,
  jjfsMove,
  jjfsCopy,
  jjfsNavigate,
  parseTarget,
  countFiles,
} from './jjfs.js';
```

No `npm install`. No build step. Copy `jjfs.js` into your project and import it.

### What the library does

All JJFS functions operate on a plain JavaScript object — the workspace map. They read
from it, mutate it in place, and return a `{ success, result }` object. Persistence
(saving to disk, a database, or wherever) is the caller's responsibility. This keeps the
library itself free of any environment assumptions.

```js
// Create a workspace map in memory
const wsForKey = { default: {} };

// Write a file
jjfsWrite(wsForKey, 'default', '/hello.txt', 'Hello, world!');
// → { success: true, result: 'Created: default:/hello.txt' }

// Read it back
jjfsRead(wsForKey, 'default', '/hello.txt');
// → { success: true, result: 'Hello, world!' }

// Edit a section
jjfsEdit(wsForKey, 'default', '/hello.txt', 'world', 'JJFS');
// → { success: true, result: 'Edited: default:/hello.txt' }

// List a directory
jjfsRead(wsForKey, 'default', '/');
// → { success: true, result: 'hello.txt' }
```

### Function reference

| Function | Signature | What it does |
|----------|-----------|--------------|
| `jjfsRead` | `(wsForKey, wsName, filePath, startLine?, endLine?)` | Read a file or list a directory |
| `jjfsWrite` | `(wsForKey, wsName, filePath, content)` | Create or overwrite a file |
| `jjfsEdit` | `(wsForKey, wsName, filePath, searchStr, replaceStr)` | Surgical search-and-replace (search must be unique) |
| `jjfsDelete` | `(wsForKey, wsName, filePath)` | Delete a file or directory |
| `jjfsMove` | `(wsForKey, wsName, srcPath, destPath)` | Move a file or directory |
| `jjfsCopy` | `(wsForKey, wsName, srcPath, destPath)` | Deep-copy a file or directory |
| `jjfsNavigate` | `(workspace, pathStr)` | Resolve a POSIX path to `{ parent, name }` |
| `parseTarget` | `(target, forRead?)` | Parse `"wsName:/path"` action target strings |
| `countFiles` | `(node)` | Recursively count leaf files in a tree |

All mutating functions (`jjfsWrite`, `jjfsEdit`, `jjfsDelete`, `jjfsMove`) return
`{ success: true, result: string }` on success or `{ success: false, result: errorMessage }`
on failure. No exceptions are thrown.

---

## Adding Persistence and a Server

The library operates on in-memory objects. To persist data between server restarts, load
from disk on startup and save after each mutation:

```js
import fs from 'fs';
import { jjfsWrite, jjfsRead } from './jjfs.js';

const WORKSPACES_FILE = './workspaces.json';

function load() {
  try { return JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8')); } catch { return {}; }
}

function save(wsForKey) {
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(wsForKey, null, 2));
}

const wsForKey = load();
if (!wsForKey.default) wsForKey.default = {};

// Write a file, then persist
const result = jjfsWrite(wsForKey, 'default', '/notes.md', '# Notes');
if (result.success) save(wsForKey);
```

### Wiring into an HTTP server: POST /api/fs/execute

The standard integration point is a single POST endpoint that dispatches all six JJFS
operations. The AI (or any client) sends `{ type, target, content }` and gets back
`{ success, result }`.

```js
// type:    'JJFS_READ' | 'JJFS_WRITE' | 'JJFS_EDIT' |
//          'JJFS_DELETE' | 'JJFS_MOVE' | 'JJFS_COPY'
// target:  'wsName:/path'  (or 'wsName:/path:startLine:endLine' for READ)
// content: file content for WRITE, JSON {search,replace} for EDIT,
//          destination path for MOVE/COPY, unused for DELETE
```

The `parseTarget` export handles the `target` string format:

```js
import { parseTarget, jjfsRead, jjfsWrite } from './jjfs.js';

const { wsName, filePath, startLine, endLine } = parseTarget(target, type === 'JJFS_READ');
```

See the [HTTP API Reference](#http-api-reference) section for the full endpoint listing
used by data2l.ink.

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
[ACTION:JJFS_READ]workspace:/path:100:[/ACTION:JJFS_READ]
```

For a file: returns the content string. With a line range: returns lines prefixed with
line numbers (`30→content`). For a directory: returns newline-separated names with `/`
appended to subdirectories.

**Examples:**

```
[ACTION:JJFS_READ]default:/src/index.js[/ACTION:JJFS_READ]
[ACTION:JJFS_READ]default:/src/index.js:1:40[/ACTION:JJFS_READ]
[ACTION:JJFS_READ]default:/[/ACTION:JJFS_READ]
```

---

### JJFS_WRITE

```
[ACTION:JJFS_WRITE:workspace:/path:file content goes here[/ACTION]
```

Creates or fully overwrites a file. Creates intermediate directories automatically.
Use for new files only — prefer `JJFS_EDIT` for modifying existing files.

**Examples:**

```
[ACTION:JJFS_WRITE:default:/index.html:<!DOCTYPE html>
<html><body><h1>Hello</h1></body></html>[/ACTION]
```

```
[ACTION:JJFS_WRITE:myapp:/src/utils.js:export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}[/ACTION]
```

**Response:**

```json
{ "success": true, "result": "Created: default:/index.html" }
{ "success": true, "result": "Overwrote: default:/index.html" }
```

---

### JJFS_EDIT

```
[ACTION:JJFS_EDIT:workspace:/path:{"search":"exact text to find","replace":"new text"}[/ACTION]
```

Surgically replaces one specific section of an existing file. The search text must appear
exactly once.

**Examples:**

```
[ACTION:JJFS_EDIT:default:/src/math.js:{"search":"function divide(a, b) {\n  return a / b;\n}","replace":"function divide(a, b) {\n  if (b === 0) throw new Error('Division by zero');\n  return a / b;\n}"}[/ACTION]
```

**Response (success):**

```json
{ "success": true, "result": "Edited: default:/src/math.js" }
```

**Response (not found):**

```json
{ "success": false, "result": "Search text not found in: /src/math.js" }
```

**Response (not unique):**

```json
{ "success": false, "result": "Search text is not unique (3 matches) in: /src/math.js" }
```

**Rules:**
- Include enough surrounding context to make the search text unique
- Whitespace must match exactly — spaces, tabs, and newlines are significant
- Both `search` and `replace` should be syntactically complete
- Set `replace` to `""` to delete the matched section

---

### JJFS_DELETE

```
[ACTION:JJFS_DELETE:workspace:/path[/ACTION]
```

**Example:**

```
[ACTION:JJFS_DELETE:default:/temp/scratch.txt[/ACTION]
```

**Response:**

```json
{ "success": true, "result": "Deleted: default:/temp/scratch.txt" }
```

---

### JJFS_MOVE

```
[ACTION:JJFS_MOVE:workspace:/old/path:/new/path[/ACTION]
```

**Example:**

```
[ACTION:JJFS_MOVE:default:/draft.html:/published/index.html[/ACTION]
```

---

### JJFS_COPY

```
[ACTION:JJFS_COPY:workspace:/src/path:/dest/path[/ACTION]
```

**Example:**

```
[ACTION:JJFS_COPY:default:/templates/base.html:/pages/about.html[/ACTION]
```

---

## Frontend Action Parser

The frontend parses JJFS action tags from the AI's response text and calls
`/api/fs/execute` for each one. Since `jjfs.js` itself has no Node.js dependencies,
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

All endpoints require an `X-API-Key` header with a valid API key.
All responses follow `{ success: boolean, result: string }`.

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
| `JJFS_EDIT` | `ws:/path` | `{"search":"...","replace":"..."}` as string |
| `JJFS_DELETE` | `ws:/path` | not used |
| `JJFS_MOVE` | `ws:/srcpath` | `/destpath` |
| `JJFS_COPY` | `ws:/srcpath` | `/destpath` |

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

GET  /api/fs/browse?workspace=name&path=/dir
     Response: { success, workspace, path, type, entries | content }
```

---

### REST File Endpoints

```
GET    /api/fs/:workspace/*path          Read file (text) or list directory (JSON)
                                         ?start=N&end=M for line range
PUT    /api/fs/:workspace/*path          Write file (raw body)
PATCH  /api/fs/:workspace/*path          Edit: body { search, replace }
DELETE /api/fs/:workspace/*path          Delete file or directory
POST   /api/fs/:workspace/*path          Move/copy: body { op, destination }
                                         op = 'move' | 'copy'
```

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

---

## Integration Checklist

### Self-hosted

- [ ] Copy `jjfs.js` into your project
- [ ] In your server, load workspace state from disk on startup
- [ ] Wire `POST /api/fs/execute` using the dispatch pattern above
- [ ] Add workspace management endpoints as needed
- [ ] Add the frontend action parser to your streaming handler
- [ ] Inject the AI System Prompt Template into your model's system prompt
- [ ] Decide on persistence: JSON file for simple use, SQLite/Redis for multi-tenant

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
Not with the base implementation. Add per-user workspace prefixing (e.g. `userid_default`)
and thread your auth through the execute handler to scope access.

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
Yes. Import it via `<script type="module">`, create a workspace object in memory,
and call the functions directly. You lose persistence across page reloads unless you
wire it to `localStorage`, `IndexedDB`, or a remote API.

**Does JJFS support file watching?**
No. It is a synchronous, request-driven system. To notify your application when the AI
writes a file, wrap the mutating functions with an event emitter or callback on your
server layer.

---

## License

JJFS is a free concept. The `jjfs.js` library is released into the public domain.
Use it, fork it, adapt it, ship products with it. No attribution required.
