# HC3 Virtual Filesystem

Browse and edit HC3 QuickApp Lua files directly in the VS Code Explorer — no manual downloading or uploading.
Also supports opening local `.fqa` archive files as editable virtual filesystems.

## Features

- **QuickApps appear as folders** in the VS Code Explorer under an `HC3 — <host>` workspace folder
- **Open any `.lua` file** — content is fetched live from the HC3
- **Save to HC3 on `⌘S`** — the file is written back via the HC3 REST API instantly
- **Create new files** — new Lua files appear on the HC3 immediately
- **Delete files** — removes the file from the HC3 (the main file of a QuickApp cannot be deleted)
- **Rename files** — rename a non-main Lua file by pressing F2 or right-clicking in the Explorer (implemented as create + delete)
- **Rename QuickApp** — rename a device directly from VS Code (right-click the QuickApp folder)
- **Export `.fqa`** — export a QuickApp as a `.fqa` archive (right-click the QuickApp folder)
- **Open in HC3 Web UI** — jump to the HC3 device page in the browser (right-click the QuickApp folder)
- **File & text search** — `Ctrl+P` quick-open and `Ctrl+Shift+F` Find in Files both search across all QuickApp files in the virtual filesystem
- **HC3 Log output channel** — the *HC3 Log* output panel polls the HC3 debug log every few seconds and streams new entries as they arrive, so you can see QuickApp output and errors without leaving VS Code
- **API traffic statistics** — run **HC3: Statistics** to see a breakdown of every API call made since connect, grouped by endpoint
- **Credentials from `.env`** — reuses the same `HC3_URL`/`HC3_USER`/`HC3_PASSWORD` variables as [plua](https://github.com/jangabrielsson/plua), with a fallback to VS Code settings + SecretStorage

### .fqa file browser

- **Open any `.fqa` file** as a virtual workspace folder — right-click a `.fqa` file in the Explorer and choose **Open .fqa File**, or run **HC3: Open .fqa File** from the Command Palette
- **Edit Lua files inside the archive** — each Lua file appears as a `.lua` file in the folder; saving writes directly back into the `.fqa` JSON on disk
- **Create and delete Lua files** — use the Explorer New File / Delete buttons as normal
- **Rename Lua files** — press F2 or right-click → Rename in the Explorer
- **Read-only metadata** — a synthetic `(QuickApp).json` file shows the QuickApp name, id, type, and initial properties but cannot be edited
- **Persisted across sessions** — the `fqa://` workspace folder is remembered and reconnected automatically when you reopen VS Code

## Explorer tree examples

**Live HC3 connection:**
```
HC3 — 192.168.1.100
  ├── 42-living-room-lights/
  │     ├── main.lua
  │     └── utils.lua
  └── 55-weather-station/
        └── main.lua
```

**Local .fqa archive:**
```
📦 living-room-lights (42)
  ├── main.lua
  ├── utils.lua
  └── (QuickApp).json   ← read-only metadata
```

## Getting started

### 1. Configure credentials

**Option A — `.env` file (recommended, works with plua)**

Create a `.env` file in your workspace root (or `~/.env`):
```ini
HC3_URL=http://192.168.1.100
HC3_USER=admin
HC3_PASSWORD=your-password
```

**Option B — VS Code settings + SecretStorage**

Run the command **HC3: Configure Credentials** (`Ctrl+Shift+P` → `HC3: Configure Credentials`) and enter your HC3 host, username, and password. The password is stored securely in VS Code's SecretStorage.

> **Note — precedence:** `.env` values always win over `HC3: Configure Credentials`. If you use plua and have `HC3_URL`/`HC3_USER`/`HC3_PASSWORD` in a workspace `.env` or `~/.env`, those credentials are used regardless of what you entered via the command. If writes fail with unexpected credentials, check for an existing `.env` file first.

### 2. Connect

Run **HC3: Connect** from the Command Palette. An `HC3 — <host>` workspace folder will appear in the Explorer containing all your QuickApps.

### 3. Edit & save

Open any `.lua` file, make changes, and save — the file is written back to the HC3 immediately.

### 4. Watch the log

The **HC3 Log** output channel opens automatically on connect and streams new debug, warning, trace, and error entries from `/api/debugMessages` as they arrive. Each line is formatted as:

```
HH:MM:SS [DEBUG] [QUICKAPP1234] your message here
```

## Commands

| Command | Description |
|---|---|
| `HC3: Connect` | Open the HC3 filesystem in the Explorer |
| `HC3: Configure Credentials` | Set HC3 host, username, and password |
| `HC3: Refresh` | Clear the cache and reload the file tree |
| `HC3: Disconnect` | Remove the HC3 workspace folder and stop polling |
| `HC3: Open in HC3 Web UI` | Open the selected QuickApp in the HC3 browser UI |
| `HC3: Export .fqa` | Export the selected QuickApp as a `.fqa` archive |
| `HC3: Rename QuickApp` | Rename the selected QuickApp on the HC3 |
| `HC3: Statistics` | Show a breakdown of API calls made since connect |
| `HC3: Open .fqa File` | Open a local `.fqa` file as a virtual workspace folder |

`Open in HC3 Web UI`, `Export .fqa`, and `Rename QuickApp` are also available via right-click on a QuickApp folder in the Explorer.

`Open .fqa File` is also available via right-click on any `.fqa` file in the Explorer.

## Settings

| Setting | Default | Description |
|---|---|---|
| `hc3vfs.host` | `` | HC3 hostname or IP. Overridden by `HC3_URL` in `.env`. |
| `hc3vfs.user` | `admin` | HC3 username. Overridden by `HC3_USER` in `.env`. |
| `hc3vfs.logPollInterval` | `4` | How often (in seconds) to poll the HC3 debug log output channel. |

Passwords are never stored in plain-text settings — they go to VS Code SecretStorage or are read from `.env`.

## Auto-save recommendation

Each save triggers a real HTTP PUT to the HC3, which may restart the QuickApp. **Auto-save is best turned off** for `hc3://` files so you only push code to the HC3 when it is in a valid state.

Add this to your workspace `.vscode/settings.json`:

```json
{
  "files.autoSave": "off"
}
```

`onFocusChange` is acceptable if you prefer convenience. Avoid `afterDelay` — it will push incomplete Lua while you type and cause constant QuickApp restarts.

## Limitations

- **Renaming the main file** is not supported — the HC3 API does not allow it
- **Creating new QuickApp devices** (new folders) is not supported — use the HC3 web interface
- **No live refresh** — the HC3 has no push notifications. Use **HC3: Refresh** if you made changes outside VS Code
- File names must be at least 3 characters and contain only `a-z`, `A-Z`, `0-9`
- **"Preloaded files limit" warning** — VS Code indexes the virtual filesystem for search and IntelliSense. If you have many QuickApps you may see a warning that the 500-file preload limit has been reached. This is a VS Code limit; all files are still fully accessible, editable, and searchable. The warning can be safely ignored.
- **`.fqa` metadata is read-only** — `(QuickApp).json` shows the current metadata but editing it has no effect. Use the HC3 web interface to change QuickApp properties.

## Related

- [plua](https://github.com/jangabrielsson/plua) — Local QuickApp development and testing tool for Fibaro HC3
