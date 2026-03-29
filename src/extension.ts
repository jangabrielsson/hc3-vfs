import * as vscode from 'vscode';
import { getCredentials } from './credentials';
import { Hc3Client } from './hc3Client';
import { Hc3FileSystemProvider } from './hc3FileSystem';

let provider: Hc3FileSystemProvider | undefined;
let providerPromise: Promise<Hc3FileSystemProvider> | undefined;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = 'hc3vfs.refresh';
    context.subscriptions.push(statusBarItem);

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

            const p = new Hc3FileSystemProvider(client);
            context.subscriptions.push(
                vscode.workspace.registerFileSystemProvider('hc3', p, {
                    isCaseSensitive: true,
                    isReadonly: false,
                })
            );
            provider = p;

            const host = new URL(creds.baseUrl).hostname;
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

            vscode.window.showInformationMessage(
                'HC3 credentials saved. Run "HC3: Connect" to open the filesystem.'
            );
        }),

        vscode.commands.registerCommand('hc3vfs.refresh', () => {
            if (provider) {
                provider.refresh();
                vscode.window.showInformationMessage('HC3: filesystem cache cleared and refreshed.');
            } else {
                vscode.window.showWarningMessage('HC3: not connected. Run "HC3: Connect" first.');
            }
        }),
    );
}

export function deactivate(): void {
    statusBarItem?.dispose();
}
