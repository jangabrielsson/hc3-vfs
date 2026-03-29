import * as vscode from 'vscode';
import { Hc3Client } from './hc3Client';

/**
 * Shows a CodeLens at the top of every hc3:// lua file with live device properties:
 *   HC3 · MyQuickApp  [id:42]  type: binarySwitch  value: false  enabled: true
 *
 * Clicking the lens opens the device in the HC3 web UI.
 */
export class Hc3CodeLensProvider implements vscode.CodeLensProvider {

    private readonly _emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses: vscode.Event<void> = this._emitter.event;

    // Simple per-device cache so we don't hammer the HC3 on every keystroke
    private _cache = new Map<number, { data: string; expiry: number }>();
    private readonly TTL = 15_000;

    constructor(private readonly getClient: () => Hc3Client | undefined) {}

    invalidate(): void { this._cache.clear(); this._emitter.fire(); }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        if (document.uri.scheme !== 'hc3') { return []; }

        const parts = document.uri.path.split('/').filter(Boolean);
        if (parts.length !== 2) { return []; }
        const m = parts[0].match(/^(\d+)-/);
        if (!m) { return []; }
        const id = parseInt(m[1], 10);

        const client = this.getClient();
        if (!client) { return []; }

        let label: string;
        const now = Date.now();
        const cached = this._cache.get(id);
        if (cached && now < cached.expiry) {
            label = cached.data;
        } else {
            try {
                const dev = await client.getDevice(id);
                const shortType = dev.type.split('.').pop() ?? dev.type;
                const props = dev.properties ?? {};
                const value   = props['value']   !== undefined ? `value: ${props['value']}` : '';
                const enabled = props['enabled']  !== undefined ? `enabled: ${props['enabled']}` : '';
                const dead    = props['dead']     === true      ? '  ⚠ dead' : '';
                const parts   = [`HC3 · ${dev.name}`, `[id:${id}]`, `type: ${shortType}`, value, enabled, dead]
                    .filter(Boolean);
                label = parts.join('  ');
                this._cache.set(id, { data: label, expiry: now + this.TTL });
            } catch {
                return [];
            }
        }

        const range = new vscode.Range(0, 0, 0, 0);
        return [
            new vscode.CodeLens(range, {
                title: label,
                command: 'hc3vfs.openInBrowser',
                arguments: [document.uri],
                tooltip: 'Click to open in HC3 web UI',
            }),
        ];
    }
}
