import * as vscode from 'vscode';
import * as fs from 'fs';

// ---------- helpers ----------

/** Synthetic file opening the shared QuickApp properties editor. */
const QA_META_FILE = '(QuickApp).hc3qa';

/** Tells the Lua Language Server not to index this virtual workspace root. */
const LUARC_FILE = '.luarc.json';
const LUARC_CONTENT = JSON.stringify({ workspace: { ignoreDir: ['**'], maxPreload: 0 } }, null, 2);

function toApiName(vsName: string): string {
    return vsName.replace(/\.lua$/, '');
}

function toVsName(apiName: string): string {
    return apiName.endsWith('.lua') ? apiName : apiName + '.lua';
}

// ---------- interfaces ----------

interface FqaFileEntry {
    name: string;
    type: string;
    isMain: boolean;
    isOpen?: boolean;
    content?: string;
}

interface FqaDoc {
    name?: string;
    type?: string;
    id?: number;
    initialProperties?: Record<string, unknown>;
    initialInterfaces?: string[];
    files: FqaFileEntry[];
    [key: string]: unknown;
}

// ---------- provider ----------

export class FqaFileSystemProvider implements vscode.FileSystemProvider {

    private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    /** authority (base64url of disk path) → absolute .fqa file path */
    private readonly _registry = new Map<string, string>();

    /** authority → in-memory working copy of the parsed .fqa */
    private readonly _cache = new Map<string, FqaDoc>();

    // -------- registration --------

    /**
     * Register a .fqa file path and return the URI authority key.
     * The authority is the base64url encoding of the absolute path,
     * so it can be decoded on VS Code restart to re-register without
     * any separate persistent storage.
     */
    register(fqaPath: string): string {
        const authority = Buffer.from(fqaPath).toString('hex');
        if (!this._registry.has(authority)) {
            this._registry.set(authority, fqaPath);
        }
        return authority;
    }

    /** Returns a display label for the fqa at the given authority. */
    label(authority: string): string {
        try {
            const doc = this._readDoc(authority);
            const name = doc.name ?? 'QuickApp';
            return doc.id !== undefined ? `${name} (${doc.id})` : name;
        } catch {
            const p = this._registry.get(authority) ?? authority;
            return require('path').basename(p, '.fqa');
        }
    }

    // -------- internal helpers --------

    private _diskPath(authority: string): string {
        const p = this._registry.get(authority);
        if (!p) {
            throw vscode.FileSystemError.Unavailable(
                `fqa: unknown file — try "HC3: Open .fqa File" to re-open it (authority: ${authority})`
            );
        }
        return p;
    }

    private _readDoc(authority: string): FqaDoc {
        const cached = this._cache.get(authority);
        if (cached) { return cached; }

        const fqaPath = this._diskPath(authority);
        let raw: string;
        try {
            raw = fs.readFileSync(fqaPath, 'utf-8');
        } catch {
            throw vscode.FileSystemError.FileNotFound(`Cannot read .fqa: ${fqaPath}`);
        }
        const doc = JSON.parse(raw) as FqaDoc;
        if (!Array.isArray(doc.files)) { doc.files = []; }
        this._cache.set(authority, doc);
        return doc;
    }

    private _writeDoc(authority: string, doc: FqaDoc): void {
        const fqaPath = this._diskPath(authority);
        fs.writeFileSync(fqaPath, JSON.stringify(doc, null, 2), 'utf-8');
        this._cache.set(authority, doc);
    }

    // -------- FileSystemProvider interface --------

    watch(_uri: vscode.Uri, _opts: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        return new vscode.Disposable(() => { /* no-op */ });
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const parts = uri.path.split('/').filter(Boolean);

        // Root directory
        if (parts.length === 0) {
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }

        if (parts.length === 1) {
            // Lua LS suppression file
            if (parts[0] === LUARC_FILE) {
                return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: Buffer.byteLength(LUARC_CONTENT) };
            }

            // Synthetic metadata file
            if (parts[0] === QA_META_FILE) {
                const doc = this._readDoc(uri.authority);
                const initProps = doc.initialProperties ?? {};
                const normalized = {
                    id: doc.id ?? 0, name: doc.name ?? '', type: doc.type ?? '',
                    interfaces: doc.initialInterfaces ?? [],
                    properties: { quickAppVariables: initProps.quickAppVariables ?? [], userDescription: initProps.userDescription ?? '' },
                };
                return {
                    type: vscode.FileType.File,
                    ctime: 0,
                    mtime: Date.now(),
                    size: Buffer.byteLength(JSON.stringify(normalized, null, 2), 'utf-8'),
                };
            }

            // Lua file
            const name = toApiName(parts[0]);
            const doc  = this._readDoc(uri.authority);
            const f    = doc.files.find(fl => fl.name === name);
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

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 0) { throw vscode.FileSystemError.FileNotFound(uri); }

        const doc = this._readDoc(uri.authority);
        const entries: [string, vscode.FileType][] = [
            [LUARC_FILE, vscode.FileType.File],
            [QA_META_FILE, vscode.FileType.File],
            ...doc.files.map(f => [toVsName(f.name), vscode.FileType.File] as [string, vscode.FileType]),
        ];
        return entries;
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 1) { throw vscode.FileSystemError.FileNotFound(uri); }

        if (parts[0] === LUARC_FILE) {
            return Buffer.from(LUARC_CONTENT, 'utf-8');
        }

        if (parts[0] === QA_META_FILE) {
            const doc = this._readDoc(uri.authority);
            const initProps = doc.initialProperties ?? {};
            const normalized = {
                id: doc.id ?? 0,
                name: doc.name ?? '',
                type: doc.type ?? '',
                interfaces: doc.initialInterfaces ?? [],
                properties: {
                    quickAppVariables: initProps.quickAppVariables ?? [],
                    userDescription: (initProps.userDescription ?? '') as string,
                },
            };
            return Buffer.from(JSON.stringify(normalized, null, 2), 'utf-8');
        }

        const name = toApiName(parts[0]);
        const doc  = this._readDoc(uri.authority);
        const f    = doc.files.find(fl => fl.name === name);
        if (!f) { throw vscode.FileSystemError.FileNotFound(uri); }
        return Buffer.from(f.content ?? '', 'utf-8');
    }

    writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { readonly create: boolean; readonly overwrite: boolean }
    ): void {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 1) { throw vscode.FileSystemError.NoPermissions(uri); }

        if (parts[0] === QA_META_FILE) {
            // The webview editor writes normalized QaDevice-like JSON back here.
            // Merge only the editable fields into the on-disk .fqa document.
            let incoming: { name?: string; interfaces?: string[]; properties?: { quickAppVariables?: unknown[]; userDescription?: string } };
            try {
                incoming = JSON.parse(Buffer.from(content).toString('utf-8'));
            } catch {
                throw vscode.FileSystemError.NoPermissions(`"${QA_META_FILE}": invalid JSON`);
            }
            const doc = this._readDoc(uri.authority);
            if (incoming.name !== undefined) { doc.name = incoming.name; }
            if (incoming.interfaces !== undefined) { doc.initialInterfaces = incoming.interfaces; }
            const initProps: Record<string, unknown> = doc.initialProperties ?? {};
            if (incoming.properties?.quickAppVariables !== undefined) {
                initProps.quickAppVariables = incoming.properties.quickAppVariables;
            }
            if (incoming.properties?.userDescription !== undefined) {
                initProps.userDescription = incoming.properties.userDescription;
            }
            doc.initialProperties = initProps;
            this._writeDoc(uri.authority, doc);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            return;
        }

        const name = toApiName(parts[0]);
        const doc  = this._readDoc(uri.authority);
        const idx  = doc.files.findIndex(f => f.name === name);

        if (idx === -1 && !options.create) { throw vscode.FileSystemError.FileNotFound(uri); }
        if (idx !== -1 && !options.overwrite) { throw vscode.FileSystemError.FileExists(uri); }

        const contentStr = Buffer.from(content).toString('utf-8');

        if (idx === -1) {
            // Creating a new file
            if (name.length < 3) {
                throw vscode.FileSystemError.NoPermissions(
                    `File name "${name}" is too short — must be at least 3 characters.`
                );
            }
            if (!/^[a-zA-Z0-9_]+$/.test(name)) {
                throw vscode.FileSystemError.NoPermissions(
                    `File name "${name}" is invalid — only letters, digits, and underscores are allowed.`
                );
            }
            doc.files.push({ name, type: 'lua', isMain: false, content: contentStr });
            this._writeDoc(uri.authority, doc);
            this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
        } else {
            // Overwriting existing
            doc.files[idx] = { ...doc.files[idx], content: contentStr };
            this._writeDoc(uri.authority, doc);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        }
    }

    delete(uri: vscode.Uri, _opts: { readonly recursive: boolean }): void {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 1) { throw vscode.FileSystemError.NoPermissions(uri); }

        if (parts[0] === QA_META_FILE) {
            throw vscode.FileSystemError.NoPermissions(`Cannot delete "${QA_META_FILE}" — it is a virtual file.`);
        }

        const name = toApiName(parts[0]);
        const doc  = this._readDoc(uri.authority);
        const idx  = doc.files.findIndex(f => f.name === name);
        if (idx === -1) { throw vscode.FileSystemError.FileNotFound(uri); }

        if (doc.files[idx].isMain) {
            throw vscode.FileSystemError.NoPermissions(
                `Cannot delete "${parts[0]}" — it is the main file of this QuickApp.`
            );
        }

        doc.files.splice(idx, 1);
        this._writeDoc(uri.authority, doc);
        this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    createDirectory(_uri: vscode.Uri): never {
        throw vscode.FileSystemError.NoPermissions('Creating directories is not supported for .fqa files.');
    }

    rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        options: { readonly overwrite: boolean }
    ): void {
        const oldParts = oldUri.path.split('/').filter(Boolean);
        const newParts = newUri.path.split('/').filter(Boolean);

        if (oldParts.length !== 1 || newParts.length !== 1) {
            throw vscode.FileSystemError.NoPermissions('Renaming across .fqa files is not supported.');
        }

        if (oldParts[0] === QA_META_FILE || newParts[0] === QA_META_FILE) {
            throw vscode.FileSystemError.NoPermissions(`Cannot rename "${QA_META_FILE}".`);
        }

        const oldName = toApiName(oldParts[0]);
        const newName = toApiName(newParts[0]);
        if (oldName === newName) { return; }

        if (newName.length < 3 || !/^[a-zA-Z0-9_]+$/.test(newName)) {
            throw vscode.FileSystemError.NoPermissions(
                `Invalid file name "${newName}" — only letters, digits, and underscores allowed (min 3 chars).`
            );
        }

        const doc    = this._readDoc(oldUri.authority);
        const srcIdx = doc.files.findIndex(f => f.name === oldName);
        if (srcIdx === -1) { throw vscode.FileSystemError.FileNotFound(oldUri); }

        if (doc.files[srcIdx].isMain) {
            throw vscode.FileSystemError.NoPermissions(
                `Cannot rename "${oldParts[0]}" — it is the main file of this QuickApp.`
            );
        }

        const dstIdx = doc.files.findIndex(f => f.name === newName);
        if (dstIdx !== -1 && !options.overwrite) { throw vscode.FileSystemError.FileExists(newUri); }
        if (dstIdx !== -1) { doc.files.splice(dstIdx, 1); }

        doc.files[srcIdx] = { ...doc.files[srcIdx], name: newName };
        this._writeDoc(oldUri.authority, doc);
        this._emitter.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        ]);
    }
}
