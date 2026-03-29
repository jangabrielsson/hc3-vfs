# Fibaro HC3 Virtual Filesystem

Browse and edit Fibaro HC3 QuickApp Lua files directly in the VS Code Explorer — no manual downloading or uploading.

## Features

- **QuickApps appear as folders** in the VS Code Explorer under an `HC3 — <host>` workspace folder
- **Open any `.lua` file** — content is fetched live from the HC3
- **Save to HC3 on `⌘S`** — the file is written back via the HC3 REST API instantly
- **Create new files** — new Lua files appear on the HC3 immediately
- **Delete files** — removes the file from the HC3
- **Credentials from `.env`** — reuses the same `HC3_URL`/`HC3_USER`/`HC3_PASSWORD` variables as [plua](https://github.com/jangabrielsson/plua), with a fallback to VS Code settings + SecretStorage

## Explorer tree example

```
HC3 — 192.168.1.100
  ├── 42-living-room-lights/
  │     ├── main.lua
  │     └── utils.lua
  └── 55-weather-station/
        └── main.lua
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

### 2. Connect

Run **HC3: Connect** from the Command Palette. An `HC3 — <host>` workspace folder will appear in the Explorer containing all your QuickApps.

### 3. Edit & save

Open any `.lua` file, make changes, and save — the file is written back to the HC3 immediately.

## Commands

| Command | Description |
|---|---|
| `HC3: Connect` | Open the HC3 filesystem in the Explorer |
| `HC3: Configure Credentials` | Set HC3 host, username, and password |
| `HC3: Refresh` | Clear the cache and reload the file tree |

## Settings

| Setting | Default | Description |
|---|---|---|
| `hc3vfs.host` | `` | HC3 hostname or IP. Overridden by `HC3_URL` in `.env`. |
| `hc3vfs.user` | `admin` | HC3 username. Overridden by `HC3_USER` in `.env`. |

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

- **File rename** is not supported (the HC3 REST API has no rename endpoint)
- **Creating new QuickApp devices** (new folders) is not supported — use the HC3 web interface
- **No live refresh** — the HC3 has no push notifications. Use **HC3: Refresh** if you made changes outside VS Code
- File names must be at least 3 characters and contain only `a-z`, `A-Z`, `0-9`

## Related

- [plua](https://github.com/jangabrielsson/plua) — Local QuickApp development and testing tool for Fibaro HC3
