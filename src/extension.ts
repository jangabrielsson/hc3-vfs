import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getCredentials } from './credentials';
import { Hc3Client } from './hc3Client';
import { Hc3FileSystemProvider } from './hc3FileSystem';
import { Hc3DecorationProvider } from './hc3Decorations';
import { Hc3CodeLensProvider } from './hc3CodeLens';
import { Hc3FileSearchProvider, Hc3TextSearchProvider } from './hc3SearchProviders';
import { Hc3LogPoller } from './hc3LogPoller';
import { Hc3BrowserProxy } from './hc3BrowserProxy';
import { QaPropertiesEditorProvider } from './hc3QaEditor';
import { FqaFileSystemProvider } from './fqaFileSystem';

let fqaProvider: FqaFileSystemProvider | undefined;

let provider: Hc3FileSystemProvider | undefined;
let providerPromise: Promise<Hc3FileSystemProvider> | undefined;
let statusBarItem: vscode.StatusBarItem;
let activeClient: Hc3Client | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let codeLensProvider: Hc3CodeLensProvider | undefined;
let logPoller: Hc3LogPoller | undefined;
let browserProxy: Hc3BrowserProxy | undefined;

export function activate(context: vscode.ExtensionContext): void {

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = 'hc3vfs.refresh';
    context.subscriptions.push(statusBarItem);

    // ── .fqa filesystem provider (no credentials needed — register unconditionally) ──
    fqaProvider = new FqaFileSystemProvider();
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('fqa', fqaProvider, {
            isCaseSensitive: true,
            isReadonly: false,
        })
    );
    // Re-register any fqa:// workspace folders persisted from a previous session.
    // The authority IS the base64url-encoded disk path, so no extra storage is needed.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === 'fqa') {
            try {
                const fqaPath = Buffer.from(folder.uri.authority, 'hex').toString('utf-8');
                fqaProvider.register(fqaPath);
            } catch { /* ignore malformed entries */ }
        }
    }

    // Register the QuickApp properties custom editor (must be registered early,
    // before any .hc3qa file is opened, so the activation event can pick it up)
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            QaPropertiesEditorProvider.viewType,
            new QaPropertiesEditorProvider(context, () => activeClient),
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    /**
     * Lazily creates the client + provider on first use.
     * Subsequent calls return the same instance.
     * Registering the FileSystemProvider a second time would throw, so we guard with providerPromise.
     */
    function ensureProvider(): Promise<Hc3FileSystemProvider> {
        if (provider) { return Promise.resolve(provider); }
        if (providerPromise) { return providerPromise; }

        providerPromise = (async () => {
            const creds = await getCredentials(context);
            const client = new Hc3Client(creds.baseUrl, creds.user, creds.password);

            // Smoke-test: will throw on bad credentials or unreachable host
            await client.listQuickApps();
            activeClient = client;

            const host = new URL(creds.baseUrl).hostname;

            const p = new Hc3FileSystemProvider(client);
            context.subscriptions.push(
                vscode.workspace.registerFileSystemProvider('hc3', p, {
                    isCaseSensitive: true,
                    isReadonly: false,
                })
            );

            // Register search providers (proposed API)
            const ws = vscode.workspace as any;
            if (typeof ws.registerFileSearchProvider === 'function') {
                context.subscriptions.push(
                    ws.registerFileSearchProvider('hc3', new Hc3FileSearchProvider(p))
                );
            }
            if (typeof ws.registerTextSearchProvider === 'function') {
                context.subscriptions.push(
                    ws.registerTextSearchProvider('hc3', new Hc3TextSearchProvider(p))
                );
            }

            // Register decoration provider
            context.subscriptions.push(
                vscode.window.registerFileDecorationProvider(new Hc3DecorationProvider(p))
            );

            // Save-status feedback in the status bar
            let saveTimer: ReturnType<typeof setTimeout> | undefined;
            p.onSaveResult = (uri, error) => {
                if (saveTimer) { clearTimeout(saveTimer); }
                if (error) {
                    statusBarItem.text = `$(error) HC3 save failed`;
                    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                } else {
                    statusBarItem.text = `$(check) HC3 saved`;
                    statusBarItem.backgroundColor = undefined;
                    saveTimer = setTimeout(() => {
                        statusBarItem.text = `$(plug) HC3 ${host}`;
                        statusBarItem.backgroundColor = undefined;
                    }, 3000);
                }
            };

            provider = p;

            // ── Debug log polling ─────────────────────────────────────────────
            if (!logPoller) {
                logPoller = new Hc3LogPoller();
                context.subscriptions.push(logPoller);
            }
            logPoller.start(client);

            // ── Browser proxy ───────────────────────────────────────────────
            const hc3Url = new URL(creds.baseUrl);
            const hc3ProxyPort = hc3Url.port ? parseInt(hc3Url.port) : 80;
            browserProxy = new Hc3BrowserProxy(
                hc3Url.hostname,
                hc3ProxyPort,
                'Basic ' + Buffer.from(`${creds.user}:${creds.password}`).toString('base64')
            );
            await browserProxy.start();
            context.subscriptions.push(browserProxy);

            // ── Connection polling ────────────────────────────────────────────
            if (pollTimer) { clearInterval(pollTimer); }
            pollTimer = setInterval(async () => {
                if (!activeClient) { return; }
                const ok = await activeClient.ping();
                if (!ok) {
                    statusBarItem.text = `$(warning) HC3 ${host} — offline`;
                    statusBarItem.backgroundColor =
                        new vscode.ThemeColor('statusBarItem.warningBackground');
                } else if (statusBarItem.text.includes('offline')) {
                    statusBarItem.text = `$(plug) HC3 ${host}`;
                    statusBarItem.backgroundColor = undefined;
                }
            }, 30_000);
            context.subscriptions.push({ dispose: () => { if (pollTimer) { clearInterval(pollTimer); } } });

            // ── CodeLens provider ─────────────────────────────────────────────
            codeLensProvider = new Hc3CodeLensProvider(() => activeClient);
            context.subscriptions.push(
                vscode.languages.registerCodeLensProvider(
                    { scheme: 'hc3', language: 'lua' },
                    codeLensProvider
                )
            );
            statusBarItem.text = `$(plug) HC3 ${host}`;
            statusBarItem.tooltip = `Connected to ${creds.baseUrl} — click to refresh`;
            statusBarItem.show();

            return p;
        })();

        // On failure reset so the next attempt tries again
        providerPromise.catch(() => { providerPromise = undefined; });
        return providerPromise;
    }

    // If a workspace folder with scheme "hc3" is already open (persisted workspace),
    // auto-connect so the explorer can render it immediately.
    if ((vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'hc3')) {
        ensureProvider().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`HC3 auto-connect failed: ${msg}`);
        });
    }

    // ── Suppress Lua LS scanning of virtual folders ───────────────────────────
    // Apply to any virtual folders already in the workspace on startup
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === 'hc3' || folder.uri.scheme === 'fqa') {
            suppressLuaLsForVirtualFolder(folder.uri);
        }
    }
    // Apply whenever a new virtual folder is added (timing-safe)
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(e => {
            for (const folder of e.added) {
                if (folder.uri.scheme === 'hc3' || folder.uri.scheme === 'fqa') {
                    suppressLuaLsForVirtualFolder(folder.uri);
                }
            }
        })
    );

    /**
     * Tells the Lua Language Server to skip indexing a virtual workspace folder.
     * Must be called from onDidChangeWorkspaceFolders (after folder is registered)
     * so that WorkspaceFolder-scoped config update actually targets the right folder.
     */
    function suppressLuaLsForVirtualFolder(folderUri: vscode.Uri): void {
        vscode.workspace.getConfiguration('Lua', folderUri)
            .update('workspace.ignoreDir', ['**'], vscode.ConfigurationTarget.WorkspaceFolder)
            .then(undefined, () => { /* Lua extension not installed — ignore */ });
    }

    // -------- Commands --------

    context.subscriptions.push(

        vscode.commands.registerCommand('hc3vfs.connect', async () => {
            try {
                const p = await ensureProvider();
                const creds = await getCredentials(context);
                const host = new URL(creds.baseUrl).hostname;
                const rootUri = vscode.Uri.parse(`hc3://${host}/`);
                const folderName = `HC3 — ${host}`;

                const alreadyOpen = (vscode.workspace.workspaceFolders ?? [])
                    .some(f => f.uri.scheme === 'hc3' && f.uri.authority === host);

                if (alreadyOpen) {
                    vscode.window.showInformationMessage(`HC3 (${host}) is already open in the Explorer.`);
                } else {
                    const idx = vscode.workspace.workspaceFolders?.length ?? 0;
                    vscode.workspace.updateWorkspaceFolders(idx, 0, { uri: rootUri, name: folderName });
                }
                p.refresh();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`HC3 Connect failed: ${msg}`);
            }
        }),

        vscode.commands.registerCommand('hc3vfs.configure', async () => {
            const cfg = vscode.workspace.getConfiguration('hc3vfs');

            const host = await vscode.window.showInputBox({
                title: 'HC3 Host',
                prompt: 'HC3 hostname or IP address',
                placeHolder: '192.168.1.100',
                value: cfg.get<string>('host') ?? '',
                validateInput: v => v.trim() ? undefined : 'Required',
            });
            if (!host) { return; }

            const user = await vscode.window.showInputBox({
                title: 'HC3 Username',
                prompt: 'HC3 username',
                value: cfg.get<string>('user') ?? 'admin',
                validateInput: v => v.trim() ? undefined : 'Required',
            });
            if (!user) { return; }

            const password = await vscode.window.showInputBox({
                title: 'HC3 Password',
                prompt: 'HC3 password',
                password: true,
                validateInput: v => v.trim() ? undefined : 'Required',
            });
            if (!password) { return; }

            await cfg.update('host', host.trim(), vscode.ConfigurationTarget.Global);
            await cfg.update('user', user.trim(), vscode.ConfigurationTarget.Global);
            await context.secrets.store('hc3vfs.password', password);

            // Reset provider so the next connect uses the new credentials
            provider = undefined;
            providerPromise = undefined;
            logPoller?.stop();
            browserProxy?.stop();
            browserProxy = undefined;

            vscode.window.showInformationMessage(
                'HC3 credentials saved. Run "HC3: Connect" to open the filesystem.'
            );
        }),

        vscode.commands.registerCommand('hc3vfs.disconnect', () => {
            const hc3Folders = (vscode.workspace.workspaceFolders ?? [])
                .filter(f => f.uri.scheme === 'hc3');

            if (hc3Folders.length === 0) {
                vscode.window.showInformationMessage('HC3: no HC3 filesystem is currently connected.');
                return;
            }

            for (const folder of hc3Folders) {
                const idx = vscode.workspace.workspaceFolders!.indexOf(folder);
                vscode.workspace.updateWorkspaceFolders(idx, 1);
            }

            // Reset provider so a subsequent Connect starts fresh
            provider = undefined;
            providerPromise = undefined;
            activeClient = undefined;
            codeLensProvider = undefined;
            logPoller?.stop();
            browserProxy?.stop();
            browserProxy = undefined;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
            statusBarItem.hide();
        }),

        vscode.commands.registerCommand('hc3vfs.refresh', () => {
            if (provider) {
                provider.refresh();
                codeLensProvider?.invalidate();
                vscode.window.showInformationMessage('HC3: filesystem cache cleared and refreshed.');
            } else {
                vscode.window.showWarningMessage('HC3: not connected. Run "HC3: Connect" first.');
            }
        }),

        vscode.commands.registerCommand('hc3vfs.openInBrowser', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target || target.scheme !== 'hc3') {
                vscode.window.showWarningMessage('HC3: no HC3 file or folder selected.');
                return;
            }
            const parts = target.path.split('/').filter(Boolean);
            const m = parts[0]?.match(/^(\d+)/);
            if (!m) {
                vscode.window.showWarningMessage('HC3: could not determine device ID from URI.');
                return;
            }
            const deviceId = m[1];
            if (!browserProxy) {
                vscode.window.showWarningMessage('HC3: not connected. Run "HC3: Connect" first.');
                return;
            }
            // Open via local reverse proxy — the proxy adds Basic Auth to every
            // request so the browser never needs to handle credentials directly.
            const url = browserProxy.urlFor(`/mobile/devices/${deviceId}`);
            await vscode.env.openExternal(vscode.Uri.parse(url));
        }),

        vscode.commands.registerCommand('hc3vfs.exportFqa', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target || target.scheme !== 'hc3') {
                vscode.window.showWarningMessage('HC3: no HC3 file or folder selected.');
                return;
            }
            if (!activeClient) {
                vscode.window.showWarningMessage('HC3: not connected.');
                return;
            }
            const parts   = target.path.split('/').filter(Boolean);
            const m       = parts[0]?.match(/^(\d+)-(.+)/);
            if (!m) { vscode.window.showWarningMessage('HC3: select a QuickApp folder to export.'); return; }
            const deviceId = parseInt(m[1], 10);
            const slug     = m[2];

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(require('os').homedir(), `${slug}.fqa`)),
                filters: { 'Fibaro QuickApp': ['fqa'] },
            });
            if (!saveUri) { return; }

            try {
                const data = await activeClient.exportFqa(deviceId);
                fs.writeFileSync(saveUri.fsPath, data);
                vscode.window.showInformationMessage(`Exported ${slug}.fqa successfully.`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`HC3 export failed: ${msg}`);
            }
        }),

        vscode.commands.registerCommand('hc3vfs.renameDevice', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target || target.scheme !== 'hc3') {
                vscode.window.showWarningMessage('HC3: no HC3 folder selected.');
                return;
            }
            if (!activeClient) {
                vscode.window.showWarningMessage('HC3: not connected.');
                return;
            }
            const parts = target.path.split('/').filter(Boolean);
            const m     = parts[0]?.match(/^(\d+)-(.+)/);
            if (!m) { vscode.window.showWarningMessage('HC3: select a QuickApp folder to rename.'); return; }
            const deviceId   = parseInt(m[1], 10);
            const currentDev = provider?.getCachedDevice(deviceId);

            const newName = await vscode.window.showInputBox({
                title:         'Rename QuickApp',
                prompt:        'New name for the QuickApp on the HC3',
                value:         currentDev?.name ?? '',
                validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
            });
            if (!newName) { return; }

            try {
                await activeClient.renameDevice(deviceId, newName.trim());
                provider?.refresh();
                codeLensProvider?.invalidate();
                vscode.window.showInformationMessage(`QuickApp renamed to "${newName.trim()}".`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`HC3 rename failed: ${msg}`);
            }
        }),

        vscode.commands.registerCommand('hc3vfs.statistics', () => {
            if (!activeClient) {
                vscode.window.showWarningMessage('HC3: not connected. Run "HC3: Connect" first.');
                return;
            }
            const text = activeClient.formatStats();
            // Show in a new untitled document so it's easy to read and copy
            vscode.workspace.openTextDocument({ content: text, language: 'plaintext' })
                .then(doc => vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false }));
        }),

        // hc3vfs.deleteFile — for agent/programmatic use; accepts a hc3:// URI string or Uri object.
        // Agents can call: vscode.commands.executeCommand('hc3vfs.deleteFile', 'hc3://host/42-myapp/foo.lua')
        vscode.commands.registerCommand('hc3vfs.deleteFile', async (uriArg?: vscode.Uri | string) => {
            let target: vscode.Uri | undefined;
            if (typeof uriArg === 'string') {
                target = vscode.Uri.parse(uriArg);
            } else if (uriArg instanceof vscode.Uri) {
                target = uriArg;
            } else {
                target = vscode.window.activeTextEditor?.document.uri;
            }

            if (!target || target.scheme !== 'hc3') {
                vscode.window.showWarningMessage('HC3: no HC3 file selected. Pass a hc3:// URI or open an HC3 file first.');
                return;
            }

            if (!provider) {
                vscode.window.showWarningMessage('HC3: not connected. Run "HC3: Connect" first.');
                return;
            }

            const fileName = target.path.split('/').filter(Boolean).pop() ?? target.path;
            const confirm = await vscode.window.showWarningMessage(
                `Delete "${fileName}" from HC3?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') { return; }

            try {
                await provider.delete(target, { recursive: false });
                vscode.window.showInformationMessage(`Deleted "${fileName}" from HC3.`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`HC3 delete failed: ${msg}`);
            }
        }),

        // ── Open .fqa file as a browseable/editable virtual filesystem ────────
        vscode.commands.registerCommand('hc3vfs.openFqa', async (uriArg?: vscode.Uri) => {
            let fqaUri: vscode.Uri | undefined;
            if (uriArg && uriArg.scheme === 'file' && uriArg.fsPath.endsWith('.fqa')) {
                fqaUri = uriArg;
            } else {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Fibaro QuickApp': ['fqa'] },
                    title: 'Open .fqa File',
                });
                if (!picked || picked.length === 0) { return; }
                fqaUri = picked[0];
            }

            const fsPath = fqaUri.fsPath;

            // Parse name for the workspace folder label
            let folderLabel = path.basename(fsPath, '.fqa');
            try {
                const raw = fs.readFileSync(fsPath, 'utf-8');
                const doc = JSON.parse(raw);
                if (doc.name) {
                    folderLabel = doc.id !== undefined ? `${doc.name} (${doc.id})` : doc.name;
                }
            } catch { /* fall back to filename */ }

            const authority = fqaProvider!.register(fsPath);
            const rootUri   = vscode.Uri.parse(`fqa://${authority}/`);

            const alreadyOpen = (vscode.workspace.workspaceFolders ?? [])
                .some(f => f.uri.toString() === rootUri.toString());
            if (alreadyOpen) {
                vscode.window.showInformationMessage(`"${folderLabel}" is already open in the Explorer.`);
                return;
            }

            const idx = vscode.workspace.workspaceFolders?.length ?? 0;
            vscode.workspace.updateWorkspaceFolders(idx, 0, {
                uri: rootUri,
                name: `\uD83D\uDCE6 ${folderLabel}`,
            });
        }),
    );
}

export function deactivate(): void {
    statusBarItem?.dispose();
}
