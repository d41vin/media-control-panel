# Plan 017: Serve the test fixtures on loopback only, with real path containment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- serve.mjs README.md scripts/harness.mjs scripts/e2e.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (the rigs already use `127.0.0.1`; Chrome resolves `localhost` to it)
- **Depends on**: none
- **Category**: security (dev-tooling hygiene)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: S2 (serve.mjs binds all interfaces; prefix-based path check, LOW)

## Why this matters

`serve.mjs` is the local fixture server every suite and the README's manual
instructions rely on. Two hygiene issues:

1. **All interfaces**: `.listen(port)` with no host binds every interface
   (IPv4 + IPv6). On a LAN, any peer can read the served tree over HTTP
   while the server runs (Windows firewall may or may not prompt/block).
   For a personal dev server the correct posture is loopback.
2. **Prefix path check**: `file.startsWith(root)` is the classic weak
   containment test — a sibling directory whose name extends the root string
   (e.g. repo `…\media-control-panel` and sibling `…\media-control-panel-2`)
   satisfies the prefix, and a crafted `..%5C`-style path can land there.
   The right primitive is `path.relative` + rejection of any result that
   escapes.

## Current state

Files and roles:
- `serve.mjs` — the server (spawned by `scripts/harness.mjs`, `scripts/e2e.mjs`, and run manually via `npm run serve`).
- `README.md:180-184` — the "Try it" instructions (localhost URLs).

Excerpts (verified at `f6101d2`):

`serve.mjs:22-35`:
```js
createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) throw new Error('forbidden');
    if (file.endsWith('/') || file.endsWith(path.sep)) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`serving ${root} at http://localhost:${port}/test/media-page.html`));
```

The rigs' expectations (verified in the runners): `scripts/harness.mjs:108`
and `scripts/e2e.mjs:136` poll `http://127.0.0.1:8080/...`; the CDP-rigged
pages themselves are loaded on `127.0.0.1:8080`. Binding `127.0.0.1` keeps
every rig working. The README/manual URL `http://localhost:8080` keeps
working in Chrome (it resolves `localhost` to `::1` and/or `127.0.0.1` and
falls through to the bound IPv4 address). The cross-origin testing trick
documented in the repo's research (localhost vs 127.0.0.1 being different
ORIGINS) is URL-string-based and is unaffected by the bind address.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|-----------------------------|----------------------|
| Static checks | `npm test` | exit 0 |
| Mock harness (uses the server) | `npm run harness` | exit 0 |
| Full e2e (uses the server) | `npm run e2e` | exit 0; 122/122 |
| Manual server probe | `node serve.mjs` + curl checks below | loopback + containment hold |

## Scope

**In scope**:
- `serve.mjs`
- `README.md` (only if a URL or note must change)

**Out of scope**:
- All rig scripts (they already target `127.0.0.1` and spawn `serve.mjs` unchanged).
- Any `extension/` file.
- MIME/security headers beyond scope (a local fixture server; no caching/CDN concerns).

## Git workflow
- Branch: `advisor/017-serve-loopback`
- One conventional commit (`fix(serve): loopback bind and real path containment`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Bind loopback and fix containment
`serve.mjs:22-35` becomes:
```js
createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.join(root, decodeURIComponent(url.pathname));
    // real containment: a prefix startsWith would let a sibling directory
    // whose name extends the root through (…\media-control-panel-2)
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
    if (file.endsWith('/') || file.endsWith(path.sep)) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://localhost:${port}/test/media-page.html (loopback only)`));
```
Note: the relative check must run BEFORE the index.html append (a directory
request resolves `rel` under the root either way; keeping it first preserves
the 404-on-escape behavior). Keep the `listen` callback URL text pointing at
`localhost` — Chrome reaches the bound IPv4 address via name resolution.

**Verify**: `npm test` → exit 0 (static suite checks referenced files parse — `serve.mjs` is included in the parse list? Verify: `check.mjs` parses `test/mock-chrome.js` and `scripts/make-icons.mjs` explicitly; serve.mjs is not in the list. The gate is Step 2's runs.)

### Step 2: Behavioral verification (loopback + containment + rigs)
1. Start the server: `node serve.mjs &` (background), then from Git Bash:
   - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/test/media-page.html` → `200`
   - `curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080/%2e%2e%2fpackage.json"` → `404`
   - Sibling-prefix probe (create nothing; use an existing sibling if present, else skip with a note): `curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080/..%5C..%5CDesktop"` → `404`
2. Kill the background server (kill the PID you started — never a browser).
3. `npm run harness` → exit 0 (the rig's `127.0.0.1:8080` polling and page loads prove the bind).
4. `npm run e2e` → exit 0, 122/122 (the full rig path, including cross-origin steps that rely on the localhost/127.0.0.1 origin split — those must still pass).

**Verify**: all four outcomes above.

### Step 3: README check
`README.md`'s "Try it" section keeps its `http://localhost:8080` URLs (still
correct for a human browser). Add nothing unless a sentence implies the
server is network-exposed (it does not at `f6101d2` — verify with
`grep -n "8080" README.md` and adjust only if needed).

**Verify**: `git status --short` → only `serve.mjs` (and `README.md` if touched).

## Test plan
- The curl probes in Step 2 are the manual verification (a dev-server change; no suite asserts server internals today — adding one would test the test server, which is deliberately out of scope).
- The rigs are the regression gate (harness + full e2e).

## Done criteria
- [ ] `serve.mjs` binds `127.0.0.1` and rejects paths via `path.relative` escape detection
- [ ] Traversal/sibling probes return 404; normal fixture URLs return 200
- [ ] `npm run harness` and `npm run e2e` exit 0 (the e2e's cross-origin steps included)
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- A rig fails to reach the server (any rig hard-coding `localhost` in a page-load path rather than `127.0.0.1`) — re-check the poll/load URLs; if a genuine `localhost`-only dependency exists, bind BOTH `127.0.0.1` and `::1` (two listeners, error-tolerant) and note it — do not revert to all-interfaces.
- The e2e cross-origin steps fail after the change — the bind must not affect origins; a failure means a URL in a fixture used a non-loopback host — report the fixture line.
- A corporate/AV policy blocks loopback binds for node (unlikely) — report the error.

## Maintenance notes
- Any future rig or doc URL should use `127.0.0.1` (rig convention already) or accept the localhost name-resolution behavior documented here.
- If the server ever grows proxy/redirect behavior, the containment check must move ahead of it.
- Reviewers should scrutinize: `decodeURIComponent` happens before `path.relative` (so encoded escapes are caught), and the `rel` check runs before `index.html` resolution.
