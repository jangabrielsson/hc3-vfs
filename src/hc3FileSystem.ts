import * as vscode from 'vscode';
import { Hc3Client, QaDevice, QaFile } from './hc3Client';

// ---------- helpers ----------

/** Synthetic file shown at the top of every QA folder — opens the properties editor */
const QA_PROPS_FILE = '(QuickApp).hc3qa';

/** Tells the Lua Language Server not to index this virtual workspace root. */
const LUARC_FILE = '.luarc.json';
const LUARC_CONTENT = JSON.stringify({ workspace: { ignoreDir: ['**'], maxPreload: 0 } }, null, 2);

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
    // Cached file content by device → api file name
    private _contentCache = new Map<number, Map<string, CacheEntry<string>>>();

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
        this._contentCache.clear();
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

        // Synthetic Lua LS suppression file at root
        if (parts.length === 1 && parts[0] === LUARC_FILE) {
            return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: Buffer.byteLength(LUARC_CONTENT) };
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

        // File: /<id>-<slug>/<filename>.lua  OR  /<id>-<slug>/(QuickApp).hc3qa
        if (parts.length === 2) {
            const id = parseDeviceId(parts[0]);
            if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }

            // Synthetic properties file
            if (parts[1] === QA_PROPS_FILE) {
                return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: 0 };
            }

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
            return [
                [LUARC_FILE, vscode.FileType.File],
                ...devices.map(d => [qaFolderName(d), vscode.FileType.Directory] as [string, vscode.FileType]),
            ];
        }

        // QA folder → list .lua files + synthetic properties file at top
        if (parts.length === 1) {
            const id = parseDeviceId(parts[0]);
            if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }
            const files = await this.getFiles(id);
            const entries: [string, vscode.FileType][] = [
                [QA_PROPS_FILE, vscode.FileType.File],
                ...files.map(f => [toVsName(f.name), vscode.FileType.File] as [string, vscode.FileType]),
            ];
            return entries;
        }

        throw vscode.FileSystemError.FileNotFound(uri);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 2 && parts.length !== 1) { throw vscode.FileSystemError.FileNotFound(uri); }

        // Synthetic Lua LS suppression file at root
        if (parts.length === 1 && parts[0] === LUARC_FILE) {
            return Buffer.from(LUARC_CONTENT, 'utf-8');
        }

        if (parts.length !== 2) { throw vscode.FileSystemError.FileNotFound(uri); }

        const id = parseDeviceId(parts[0]);
        if (id === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }

        // Synthetic properties file — return full device JSON
        if (parts[1] === QA_PROPS_FILE) {
            const dev = await this.client.getDevice(id);
            return Buffer.from(JSON.stringify(dev, null, 2), 'utf-8');
        }

        const name = toApiName(parts[1]);
        const now = Date.now();
        const devContentCache = this._contentCache.get(id);
        const cached = devContentCache?.get(name);
        if (cached && now < cached.expiry) {
            return Buffer.from(cached.data, 'utf-8');
        }
        const file = await this.client.readFile(id, name);
        const content = file.content ?? '';
        if (!this._contentCache.has(id)) { this._contentCache.set(id, new Map()); }
        this._contentCache.get(id)!.set(name, { data: content, expiry: now + CACHE_TTL_MS });
        return Buffer.from(content, 'utf-8');
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
            // .hc3qa is a synthetic file, not createable by the user
            if (name === QA_PROPS_FILE || parts[1] === QA_PROPS_FILE) {
                throw vscode.FileSystemError.NoPermissions(uri);
            }
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
                await this.client.writeFile(id, { name: created.name, type: created.type, isMain: created.isMain, content: contentStr } as typeof created);
                // Invalidate file list cache for this device
                this._filesCache.delete(id);
                this._fileMeta.delete(id);
                this._contentCache.get(id)?.delete(name);
                this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
            } else {
                // Preserve existing metadata (name, type, isMain) but do NOT
                // send isOpen — let the HC3 manage that flag itself.
                // Sending isOpen:false caused 403 on some firmware; sending
                // isOpen:true caused 403 on others. Omitting it is safest.
                const meta = this._fileMeta.get(id)?.get(name) ?? existing;
                const putBody = { name: meta.name, type: meta.type, isMain: meta.isMain, content: contentStr };
                await this.client.writeFile(id, putBody as typeof meta);
                this._contentCache.get(id)?.delete(name);
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

        // Synthetic properties file cannot be deleted
        if (parts[1] === QA_PROPS_FILE) {
            throw vscode.FileSystemError.NoPermissions(
                `Cannot delete "${QA_PROPS_FILE}" — it is a virtual file managed by the extension.`
            );
        }

        // The HC3 API does not allow deleting the main file
        const files = await this.getFiles(id);
        const f = files.find(fl => fl.name === name);
        if (f?.isMain) {
            throw vscode.FileSystemError.NoPermissions(
                `Cannot delete "${parts[1]}" — the main file of a QuickApp cannot be removed.`
            );
        }

        await this.client.deleteFile(id, name);
        this._filesCache.delete(id);
        this._fileMeta.delete(id);
        this._contentCache.delete(id);
        this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    createDirectory(_uri: vscode.Uri): never {
        // Creating QuickApp devices as directories is not supported in this version
        throw vscode.FileSystemError.NoPermissions(
            'Creating new QuickApp devices is not supported. Use the HC3 web interface.'
        );
    }

    async rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        options: { readonly overwrite: boolean }
    ): Promise<void> {
        const oldParts = oldUri.path.split('/').filter(Boolean);
        const newParts = newUri.path.split('/').filter(Boolean);

        // Only file-level renames within the same QuickApp are supported
        if (oldParts.length !== 2 || newParts.length !== 2 || oldParts[0] !== newParts[0]) {
            throw vscode.FileSystemError.NoPermissions(
                'Renaming across QuickApps or renaming QuickApp folders is not supported.'
            );
        }

        const id = parseDeviceId(oldParts[0]);
        if (id === undefined) { throw vscode.FileSystemError.FileNotFound(oldUri); }

        const oldName = toApiName(oldParts[1]);
        const newName = toApiName(newParts[1]);

        // Synthetic properties file cannot be renamed
        if (oldParts[1] === QA_PROPS_FILE || newParts[1] === QA_PROPS_FILE) {
            throw vscode.FileSystemError.NoPermissions(
                `Cannot rename "${QA_PROPS_FILE}" — it is a virtual file managed by the extension.`
            );
        }

        if (oldName === newName) { return; }

        if (newName.length < 3 || !/^[a-zA-Z0-9]+$/.test(newName)) {
            throw vscode.FileSystemError.NoPermissions(
                `New file name "${newName}" is invalid — must be at least 3 alphanumeric characters.`
            );
        }

        const files = await this.getFiles(id);
        const src = files.find(f => f.name === oldName);
        if (!src) { throw vscode.FileSystemError.FileNotFound(oldUri); }

        if (src.isMain) {
            throw vscode.FileSystemError.NoPermissions(
                `Cannot rename "${oldParts[1]}" — the main file of a QuickApp cannot be renamed.`
            );
        }

        const destExists = files.some(f => f.name === newName);
        if (destExists && !options.overwrite) {
            throw vscode.FileSystemError.FileExists(newUri);
        }

        // Fetch current content
        const srcFile = await this.client.readFile(id, oldName);

        // Create the new file and write content into it
        const created = await this.client.createFile(id, newName);
        await this.client.writeFile(id, { name: created.name, type: created.type, isMain: created.isMain, content: srcFile.content ?? '' } as typeof created);

        // Delete the old file
        await this.client.deleteFile(id, oldName);

        // Invalidate caches for this device
        this._filesCache.delete(id);
        this._fileMeta.delete(id);
        this._contentCache.delete(id);

        this._emitter.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        ]);
    }
}
