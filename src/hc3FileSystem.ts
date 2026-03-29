import * as vscode from 'vscode';
import { Hc3Client, QaDevice, QaFile } from './hc3Client';

// ---------- helpers ----------

function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device';
}

/** VS Code folder name for a QuickApp: "<id>-<slug>" */
function qaFolderName(dev: QaDevice): string {
    return `${dev.id}-${slugify(dev.name)}`;
}

/** Extract numeric device ID from a folder name segment like "42-my-app" */
function parseDeviceId(segment: string): number | undefined {
    const m = segment.match(/^(\d+)-/);
    return m ? parseInt(m[1], 10) : undefined;
}

/**
 * HC3 file names have no extension (e.g. "main").
 * In VS Code we show them with ".lua" for syntax highlighting.
 * These helpers convert between the two forms.
 */
function toApiName(vsName: string): string {
    return vsName.endsWith('.lua') ? vsName.slice(0, -4) : vsName;
}

function toVsName(apiName: string): string {
    return apiName.endsWith('.lua') ? apiName : apiName + '.lua';
}

// ---------- cache ----------

interface CacheEntry<T> {
    data: T;
    expiry: number;
}

const CACHE_TTL_MS = 5_000;

// ---------- provider ----------

export class Hc3FileSystemProvider implements vscode.FileSystemProvider {

    /** Fires when the provider changes file content or structure. */
    private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    /** Fires when decorations should be refreshed (refresh or after writes). */
    readonly onDidChangeDecorations = new vscode.EventEmitter<vscode.Uri[]>();

    /** Called after each writeFile with success/failure result. */
    onSaveResult: ((uri: vscode.Uri, error?: Error) => void) | undefined;

    private _devicesCache: CacheEntry<QaDevice[]> | undefined;
    private _filesCache   = new Map<number, CacheEntry<QaFile[]>>();
    // Cached meta (sans content) by device → file name
    private _fileMeta     = new Map<number, Map<string, QaFile>>();

    constructor(private readonly client: Hc3Client) {}

    /** Look up a device from the cache (undefined if not yet loaded). */
    getCachedDevice(id: number): QaDevice | undefined {
        return this._devicesCache?.data.find(d => d.id === id);
    }

    /** Look up file metadata from the cache (undefined if not yet loaded). */
    getCachedFileMeta(deviceId: number, apiName: string): QaFile | undefined {
        return this._fileMeta.get(deviceId)?.get(apiName);
    }

    // -------- cache helpers --------

    private async getDevices(): Promise<QaDevice[]> {
        const now = Date.now();
        if (this._devicesCache && now < this._devicesCache.expiry) {
            return this._devicesCache.data;
        }
        const data = await this.client.listQuickApps();
        this._devicesCache = { data, expiry: now + CACHE_TTL_MS };
        return data;
    }

    private async getFiles(deviceId: number): Promise<QaFile[]> {
        const now = Date.now();
        const cached = this._filesCache.get(deviceId);
        if (cached && now < cached.expiry) { return cached.data; }
        const data = await this.client.listFiles(deviceId);
        this._filesCache.set(deviceId, { data, expiry: now + CACHE_TTL_MS });
        const meta = new Map<string, QaFile>();
        for (const f of data) { meta.set(f.name, f); }
        this._fileMeta.set(deviceId, meta);
        return data;
    }

    /** Clears all caches and fires a root-level change event. */
    refresh(): void {
        this._devicesCache = undefined;
        this._filesCache.clear();
        this._fileMeta.clear();
        // Fire a change on a dummy URI to prompt VS Code to re-read the root
        this._emitter.fire([{
            type: vscode.FileChangeType.Changed,
            uri: vscode.Uri.parse('hc3:///'),
        }]);
        this.onDidChangeDecorations.fire([]);
    }

    // -------- FileSystemProvider interface --------

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        // HC3 has no push notifications — the user can run "HC3: Refresh" manually
        return new vscode.Disposable(() => { /* no-op */ });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const parts = uri.path.split('/').filter(Boolean);

        // Root
        if (parts.length === 0) {
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }

        // QuickApp folder: /<id>-<slug>/
        if (parts.length === 1) {
            const id = parseDeviceId(parts[0]);
            if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }
            const devices = await this.getDevices();
            const dev = devices.find(d => d.id === id);
            if (!dev) { throw vscode.FileSystemError.FileNotFound(uri); }
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }

        // File: /<id>-<slug>/<filename>.lua
        if (parts.length === 2) {
            const id = parseDeviceId(parts[0]);
            if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }
            const name = toApiName(parts[1]);
            const files = await this.getFiles(id);
            const f = files.find(fl => fl.name === name);
            if (!f) { throw vscode.FileSystemError.FileNotFound(uri); }
            return {
                type: vscode.FileType.File,
                ctime: 0,
                mtime: Date.now(),
                size: f.content ? Buffer.byteLength(f.content, 'utf-8') : 0,
            };
        }

        throw vscode.FileSystemError.FileNotFound(uri);
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const parts = uri.path.split('/').filter(Boolean);

        // Root → list QuickApp folders
        if (parts.length === 0) {
            const devices = await this.getDevices();
            return devices.map(d => [qaFolderName(d), vscode.FileType.Directory]);
        }

        // QA folder → list .lua files
        if (parts.length === 1) {
            const id = parseDeviceId(parts[0]);
            if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }
            const files = await this.getFiles(id);
            return files.map(f => [toVsName(f.name), vscode.FileType.File]);
        }

        throw vscode.FileSystemError.FileNotFound(uri);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 2) { throw vscode.FileSystemError.FileNotFound(uri); }

        const id = parseDeviceId(parts[0]);
        if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }

        const name = toApiName(parts[1]);
        const file = await this.client.readFile(id, name);
        return Buffer.from(file.content ?? '', 'utf-8');
    }

    async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { readonly create: boolean; readonly overwrite: boolean }
    ): Promise<void> {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 2) { throw vscode.FileSystemError.NoPermissions(uri); }

        const id = parseDeviceId(parts[0]);
        if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }

        const name = toApiName(parts[1]);

        if (options.create) {
            if (name.length < 3) {
                throw vscode.FileSystemError.NoPermissions(
                    `File name "${name}" is too short — HC3 file names must be at least 3 characters.`
                );
            }
            if (!/^[a-zA-Z0-9]+$/.test(name)) {
                throw vscode.FileSystemError.NoPermissions(
                    `File name "${name}" is invalid — HC3 file names may only contain letters (a-z, A-Z) and digits (0-9).`
                );
            }
        }

        const files = await this.getFiles(id);
        const existing = files.find(f => f.name === name);

        if (!existing && !options.create) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (existing && !options.overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }

        const contentStr = Buffer.from(content).toString('utf-8');

        try {
            if (!existing) {
                // Create an empty file first, then write content into it
                const created = await this.client.createFile(id, name);
                await this.client.writeFile(id, { ...created, content: contentStr });
                // Invalidate file list cache for this device
                this._filesCache.delete(id);
                this._fileMeta.delete(id);
                this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
            } else {
                // Preserve all existing metadata, only update content
                const meta = this._fileMeta.get(id)?.get(name) ?? existing;
                await this.client.writeFile(id, { ...meta, content: contentStr });
                this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            }
            this.onSaveResult?.(uri);
        } catch (err) {
            this.onSaveResult?.(uri, err instanceof Error ? err : new Error(String(err)));
            throw err;
        }
    }

    async delete(uri: vscode.Uri, _options: { readonly recursive: boolean }): Promise<void> {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 2) {
            throw vscode.FileSystemError.NoPermissions(uri);
        }

        const id = parseDeviceId(parts[0]);
        if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }
        const name = toApiName(parts[1]);

        await this.client.deleteFile(id, name);
        this._filesCache.delete(id);
        this._fileMeta.delete(id);
        this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    createDirectory(_uri: vscode.Uri): never {
        // Creating QuickApp devices as directories is not supported in this version
        throw vscode.FileSystemError.NoPermissions(
            'Creating new QuickApp devices is not supported. Use the HC3 web interface.'
        );
    }

    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean }): never {
        // HC3 does not expose a rename endpoint for QuickApp files
        throw vscode.FileSystemError.NoPermissions(
            'Renaming HC3 QuickApp files is not supported by the HC3 API.'
        );
    }
}
