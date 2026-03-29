# Plan: HC3 Web UI Deep-link for QuickApp Popup

## Current State
`HC3: Open in HC3 Web UI` opens `/mobile/devices/{id}` via the local reverse proxy.
This hits the old/deprecated mobile web UI — functional but visually outdated.

## Goal
Open the new Yubii Home UI directly to the QuickApp popup/dialog (the eye-button view
shown in Settings → Devices), so users get the polished native UI without navigating manually.

## Investigation Findings (2026-03-29)
- The new Yubii Home UI is a single-page Angular app — URL never changes during navigation
- Clicking the eye icon on a QA row does NOT trigger any network requests (pure in-memory state)
- There is no discoverable deep-link URL for the popup dialog
- JS injection to auto-click is technically possible but too fragile for a production extension
  (click path: Settings menu → Devices section → find row by ID → click eye button — any
  firmware DOM change silently breaks this)

## Options

### Option A — Land on root URL (minimal, stable)
Open `http://{host}/` via proxy instead of `/mobile/devices/{id}`.
User is authenticated and navigates themselves. One-line change.

### Option B — Improve the built-in QA properties editor
The `(QuickApp).hc3qa` webview already covers the common cases (name, enabled, visible,
interfaces, variables). Extend it to make opening the browser unnecessary for most workflows:
- Device action/value display
- Child device list
- UI element preview

### Option C — Wait for Fibaro to add URL routing (future)
If Fibaro ever implements proper Angular route-per-dialog (common improvement),
deep-linking becomes trivial. The proxy + auth injection is already in place.

### Option D — Hidden endpoint (under investigation)
**Ask on the Fibaro forum** whether there is a hidden/undocumented API endpoint or URL
that opens the QA UI panel directly. Some firmware versions expose endpoints not in
official docs. If found, this is the cleanest solution.

## Decision
- Keep `/mobile/devices/{id}` as-is for now (still functional, harmless)
- Pursue Option D (forum inquiry) — if a hidden endpoint exists, it's a trivial fix
- Option B is the best long-term investment regardless
- Revisit A/C if D yields nothing

## Action Items
- [ ] Ask Fibaro community forum if there is a URL/endpoint that opens the QA UI popup
- [ ] If found: update `hc3vfs.openInBrowser` command to use it
- [ ] If not found: evaluate whether Option B covers enough use cases to deprecate the browser command
