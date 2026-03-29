import * as vscode from 'vscode';
import { Hc3FileSystemProvider } from './hc3FileSystem';

/**
 * Provides Explorer decorations for hc3:// URIs:
 *  - QA folder: tooltip showing the device type
 *  - Main lua file: badge "M" + tooltip "Main file"
 */
export class Hc3DecorationProvider implements vscode.FileDecorationProvider {

    private readonly _emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> =
        this._emitter.event;

    constructor(private readonly fsProvider: Hc3FileSystemProvider) {
        // Re-fire when the FS provider refreshes (cache cleared, new data incoming)
        fsProvider.onDidChangeDecorations.event(() => {
            // Pass undefined to invalidate all hc3:// decorations at once
            this._emitter.fire(undefined);
        });
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== 'hc3') { return undefined; }

        const parts = uri.path.split('/').filter(Boolean);

        // ── QA folder: /<id>-<slug>  ──────────────────────────────────────
        if (parts.length === 1) {
            const m = parts[0].match(/^(\d+)-/);
            if (!m) { return undefined; }
            const id = parseInt(m[1], 10);
            const dev = this.fsProvider.getCachedDevice(id);
            if (!dev) { return undefined; }

            // Shorten type: "com.fibaro.binarySwitch" → "binarySwitch"
            const shortType = dev.type.split('.').pop() ?? dev.type;
            return {
                tooltip: `Type: ${shortType}`,
            };
        }

        // ── Lua file: /<id>-<slug>/<file>.lua  ───────────────────────────
        if (parts.length === 2) {
            const m = parts[0].match(/^(\d+)-/);
            if (!m) { return undefined; }
            const id       = parseInt(m[1], 10);
            const apiName  = parts[1].endsWith('.lua') ? parts[1].slice(0, -4) : parts[1];
            const fileMeta = this.fsProvider.getCachedFileMeta(id, apiName);
            if (!fileMeta?.isMain) { return undefined; }

            return {
                badge:   'M',
                tooltip: 'Main file',
            };
        }

        return undefined;
    }
}
