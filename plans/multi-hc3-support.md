# Plan: Multi-HC3 Support

## TL;DR
Extend the extension to manage multiple HC3 instances by: adding `hc3vfs.instances` config array, replacing the single `activeClient` global with a `Map<host, Hc3Client>`, refactoring `Hc3FileSystemProvider` to route by `uri.authority`, and updating all commands to omit selection prompts when only 1 HC3 is involved (backward compat).

**User decisions:**
- Status bar: single combined item — `$(plug) HC3 192.168.50.57` (1 connected) / `$(plug) HC3 (2 connected)` (>1)
- Log: single "HC3 Log" channel, prefix `[host] ` only when >1 connected
- Connect: require explicit `Connect` per HC3; auto-reconnect only for HC3 workspace folders already in the workspace
- Configure: list existing + Add / Edit / Remove inline

---

## Phase 1 — Credentials Layer (`src/credentials.ts`)
1. Add `InstanceConfig` interface: `{ host: string, user: string, label?: string }`
2. Add `loadInstances(context)` → `InstanceConfig[]`:
   - Reads `hc3vfs.instances` array from settings
   - If empty, falls back to `hc3vfs.host` + `hc3vfs.user` (backward compat)
   - ENV vars `HC3_URL`/`HC3_USER` override for matched host
3. Add `getCredentialsForHost(host, context)` → `Promise<Credentials>`:
   - Password key: `hc3vfs.password.${host}` in secret storage
   - Backward compat: if instances array empty AND host matches `hc3vfs.host`, also try old `hc3vfs.password` key
4. Add `saveInstance(host, user, password, cfg, context)` — saves to `hc3vfs.instances` + secret storage
5. Add `removeInstance(host, cfg, context)` — removes from instances array + deletes `hc3vfs.password.${host}` secret
6. Keep `getCredentials(context)` working (read single-instance) for any callers that remain

## Phase 2 — package.json
7. Add `hc3vfs.instances`: array schema `{ items: { type: object, properties: { host, user, label? } } }`
8. Add deprecation descriptions to `hc3vfs.host` / `hc3vfs.user` (still read for backward compat)

## Phase 3 — Multi-client Map (`src/extension.ts`) — *depends on 1, 2*
9. Replace module globals:
   - `activeClient → activeClients: Map<string, Hc3Client>`
   - `pollTimer → pollTimers: Map<string, ReturnType<setInterval>>`
   - `browserProxy → browserProxies: Map<string, Hc3BrowserProxy>`
   - `logPoller` stays single (shared channel)
   - Add `logChannel: vscode.OutputChannel` created once in `activate()`
10. New helper `connectHost(host, context)`:
    - Creates `Hc3Client`, smoke-tests it
    - Stores in `activeClients`
    - Starts log poller for that host on the shared channel (prefix = `[host] ` if >1 connected)
    - Creates and starts `Hc3BrowserProxy` for that host
    - Starts poll interval for that host
    - Adds workspace folder `hc3://${host}/`
    - Calls `updateStatusBar()`
11. New helper `disconnectHost(host)`:
    - Stops poll timer, browser proxy, and log for that host
    - Removes from all Maps
    - Removes workspace folder
    - Calls `updateStatusBar()`
12. New helper `updateStatusBar()`:
    - 0 connected → `statusBarItem.hide()`
    - 1 connected → `$(plug) HC3 {host}`
    - N connected → `$(plug) HC3 ({N} connected)`
13. `ensureProviderRegistered()` — registers FS provider once (guarded by flag), constructed with `(host) => activeClients.get(host)` factory
14. Auto-reconnect: scan existing workspace folders with `scheme === 'hc3'`, call `connectHost(folder.uri.authority)` lazily for each

## Phase 4 — FileSystem Provider (`src/hc3FileSystem.ts`) — *depends on 3*
15. Constructor: `(getClient: (host: string) => Hc3Client | undefined)`
16. Refactor all cache Maps to be host-prefixed:
    - `_devicesCache: Map<string, {ts, data}>` keyed by `host`
    - `_filesCache: Map<string, {ts, data}>` keyed by `${host}:${deviceId}`
    - `_fileMeta: Map<string, QaFile>` keyed by `${host}:${deviceId}:${name}`
    - `_contentCache: Map<string, {ts, data}>` keyed by `${host}:${deviceId}:${name}`
17. All methods: derive `host = uri.authority`; call `this.getClient(host)`; throw `FileSystemError.Unavailable` if not found
18. `refresh(host?: string)` — if host given, clear that host's cache entries; if undefined, clear all
19. `getCachedDevice(host, deviceId)` — add host param

## Phase 5 — Log Poller (`src/hc3LogPoller.ts`) — *parallel with 4*
20. Constructor: `(channel: vscode.OutputChannel, getPrefix: () => string)`
    - `getPrefix()` returns `[host] ` if `activeClients.size > 1`, else `''`
21. `start(client)` no longer creates/clears channel — just starts polling and appending
22. In extension.ts: create one `logChannel` in `activate()`; pass to each poller with a getPrefix closure
23. `channel.show()` called on first new log message, only if not already visible

## Phase 6 — CodeLens & QA Editor — *parallel with 4*
24. `Hc3CodeLensProvider(getClient: (uri: vscode.Uri) => Hc3Client | undefined)`:
    - In `provideCodeLenses(document)`: call `this.getClient(document.uri)`
25. `QaPropertiesEditorProvider(context, getClient: (uri: vscode.Uri) => Hc3Client | undefined)`:
    - In `resolveCustomTextEditor(document, ...)`: call `this.getClient(document.uri)` using `uri.authority` = host

## Phase 7 — Command UX (`src/extension.ts`) — *depends on 3*

**`hc3vfs.configure`:**
26. Show QuickPick of configured instances + "$(plus) Add new HC3…"
    - Pick existing → sub-pick "Edit credentials" | "Remove"
    - Edit: re-prompt host/user/password pre-filled, call `saveInstance`
    - Remove: confirmation, call `removeInstance`; if connected, call `disconnectHost`
    - Add: prompt host → user → password, call `saveInstance` + ask "Connect now?"

**`hc3vfs.connect`:**
27. Load `loadInstances(context)`, filter to not-yet-connected
    - 0 remaining → info "All HC3s connected" or "No HC3 configured — run Configure"
    - 1 remaining → connect directly, no prompt (single-HC3 parity)
    - N remaining → QuickPick (shows label or host), then connect chosen

**`hc3vfs.disconnect`:**
28. Collect `activeClients` keys
    - 0 → info "no HC3 connected"
    - 1 → disconnect directly, no prompt (parity)
    - N → QuickPick, then `disconnectHost(chosen)`

**`hc3vfs.refresh`:**
29. If nothing connected → warning
    - If ≥1 connected → refresh all connected (clear all caches, invalidate codelens); no prompt

**Context-menu commands** (`openInBrowser`, `exportFqa`, `renameDevice`):
30. Derive `host = uri.authority`, look up `activeClients.get(host)` / `browserProxies.get(host)`

**`hc3vfs.statistics`:**
31. 1 connected → show directly; N → QuickPick to choose which HC3

---

## Relevant Files
- `src/credentials.ts` — add `InstanceConfig`, `loadInstances`, `getCredentialsForHost`, `saveInstance`, `removeInstance`
- `src/extension.ts` — multi-client Maps, `connectHost`, `disconnectHost`, `updateStatusBar`, updated commands
- `src/hc3FileSystem.ts` — client factory, host-keyed caches
- `src/hc3LogPoller.ts` — shared channel + `getPrefix` callback
- `src/hc3CodeLens.ts` — URI-based client lookup
- `src/hc3QaEditor.ts` — URI-based client lookup
- `package.json` — add `hc3vfs.instances` config

## Verification
1. Single HC3 (`hc3vfs.host` only, no `hc3vfs.instances`) — all commands work identically to 0.4.5
2. Two HC3s configured — Connect shows pick; both open as separate workspace folders; log shows `[host]` prefixes; status bar shows `$(plug) HC3 (2 connected)`
3. Disconnect one → status bar reverts to single-host format; log entries for that host stop
4. `exportFqa` / `renameDevice` context menu → correct HC3 by `uri.authority`
5. QA properties editor opens and saves against the correct HC3
6. `npm run compile` — zero errors

## Decisions
- Single-HC3 UX is identical to today (no selection prompts, no prefix in logs)
- `.env` / env vars still override per-host for development
- `hc3vfs.host` / `hc3vfs.user` remain readable indefinitely (not removed, just deprecated)
- Old `hc3vfs.password` secret used as fallback during migration (instances array empty)
