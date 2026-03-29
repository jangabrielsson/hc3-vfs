import * as vscode from 'vscode';
import { Hc3FileSystemProvider } from './hc3FileSystem';

// Local definitions for the proposed FileSearch / TextSearch API shapes.
// These mirror the types in vscode.proposed.fileSearchProvider.d.ts and
// vscode.proposed.textSearchProvider.d.ts so that we remain type-safe without
// pulling in the full proposed-API shim.

interface FileSearchQuery { pattern: string; }
interface FileSearchOptions { folder: vscode.Uri; maxResults?: number; }

interface TextSearchQuery {
    pattern: string;
    isRegExp?: boolean;
    isCaseSensitive?: boolean;
    isWordMatch?: boolean;
}
interface TextSearchOptions {
    folder: vscode.Uri;
    maxResults?: number;
    includes: string[];
    excludes: string[];
}
interface TextSearchMatchPreview { text: string; matches: vscode.Range | vscode.Range[]; }
interface TextSearchMatch { uri: vscode.Uri; ranges: vscode.Range | vscode.Range[]; preview: TextSearchMatchPreview; }
interface TextSearchComplete { limitHit?: boolean; }

// ---------- helpers ----------

/** Build a regex from a TextSearchQuery. */
function buildPattern(query: TextSearchQuery): RegExp {
    let src = query.isRegExp ? query.pattern : escapeRegExp(query.pattern);
    if (query.isWordMatch) { src = `\\b${src}\\b`; }
    const flags = query.isCaseSensitive ? 'gd' : 'gid';
    // 'd' flag (indices) may not be available in all runtimes; fall back silently.
    try { return new RegExp(src, flags); } catch { return new RegExp(src, 'gi'); }
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- FileSearchProvider ----------

/**
 * Provides file-name search results for the HC3 virtual filesystem.
 * Registered via `(vscode.workspace as any).registerFileSearchProvider('hc3', …)`.
 */
export class Hc3FileSearchProvider {
    constructor(private readonly fsp: Hc3FileSystemProvider) {}

    async provideFileSearchResults(
        query: FileSearchQuery,
        options: FileSearchOptions,
        token: vscode.CancellationToken,
    ): Promise<vscode.Uri[]> {
        const root = options.folder;
        const pattern = query.pattern.toLowerCase();
        const results: vscode.Uri[] = [];

        let qaFolders: [string, vscode.FileType][];
        try {
            qaFolders = await this.fsp.readDirectory(root);
        } catch {
            return [];
        }

        for (const [folderName, type] of qaFolders) {
            if (token.isCancellationRequested) { break; }
            if (type !== vscode.FileType.Directory) { continue; }

            const folderUri = root.with({ path: root.path.replace(/\/$/, '') + '/' + folderName });

            let files: [string, vscode.FileType][];
            try {
                files = await this.fsp.readDirectory(folderUri);
            } catch {
                continue;
            }

            for (const [fileName, fileType] of files) {
                if (token.isCancellationRequested) { break; }
                if (fileType !== vscode.FileType.File) { continue; }

                const fullRelPath = `${folderName}/${fileName}`;
                if (!pattern || fullRelPath.toLowerCase().includes(pattern)) {
                    results.push(folderUri.with({ path: folderUri.path + '/' + fileName }));
                }

                if (options.maxResults !== undefined && results.length >= options.maxResults) {
                    return results;
                }
            }
        }

        return results;
    }
}

// ---------- TextSearchProvider ----------

/**
 * Provides full-text search results for the HC3 virtual filesystem.
 * Registered via `(vscode.workspace as any).registerTextSearchProvider('hc3', …)`.
 */
export class Hc3TextSearchProvider {
    constructor(private readonly fsp: Hc3FileSystemProvider) {}

    async provideTextSearchResults(
        query: TextSearchQuery,
        options: TextSearchOptions,
        progress: vscode.Progress<TextSearchMatch>,
        token: vscode.CancellationToken,
    ): Promise<TextSearchComplete> {
        const root = options.folder;
        let totalMatches = 0;
        const re = buildPattern(query);

        let qaFolders: [string, vscode.FileType][];
        try {
            qaFolders = await this.fsp.readDirectory(root);
        } catch {
            return {};
        }

        for (const [folderName, type] of qaFolders) {
            if (token.isCancellationRequested) { break; }
            if (type !== vscode.FileType.Directory) { continue; }

            const folderUri = root.with({ path: root.path.replace(/\/$/, '') + '/' + folderName });

            let files: [string, vscode.FileType][];
            try {
                files = await this.fsp.readDirectory(folderUri);
            } catch {
                continue;
            }

            for (const [fileName, fileType] of files) {
                if (token.isCancellationRequested) { break; }
                if (fileType !== vscode.FileType.File) { continue; }

                const fileUri = folderUri.with({ path: folderUri.path + '/' + fileName });

                let bytes: Uint8Array;
                try {
                    bytes = await this.fsp.readFile(fileUri);
                } catch {
                    continue;
                }

                const text = Buffer.from(bytes).toString('utf-8');
                const lines = text.split('\n');

                for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                    if (token.isCancellationRequested) { break; }

                    const line = lines[lineIndex];
                    re.lastIndex = 0;
                    let m: RegExpExecArray | null;

                    while ((m = re.exec(line)) !== null) {
                        const matchStart = m.index;
                        const matchEnd   = m.index + m[0].length;
                        const range      = new vscode.Range(lineIndex, matchStart, lineIndex, matchEnd);

                        progress.report({
                            uri: fileUri,
                            ranges: range,
                            preview: {
                                text: line,
                                matches: new vscode.Range(0, matchStart, 0, matchEnd),
                            },
                        });

                        totalMatches++;
                        if (options.maxResults !== undefined && totalMatches >= options.maxResults) {
                            return { limitHit: true };
                        }
                    }
                }
            }
        }

        return {};
    }
}
