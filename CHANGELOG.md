# Change Log

## 0.1.0

- Initial release
- Virtual filesystem provider for `hc3://` scheme
- List, read, write, and delete QuickApp Lua files on a Fibaro HC3
- Credentials loaded from `.env` (plua-compatible) with fallback to VS Code settings + SecretStorage
- Commands: HC3: Connect, HC3: Configure Credentials, HC3: Refresh
- File name validation (min 3 chars, alphanumeric only)
