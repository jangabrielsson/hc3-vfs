import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface QaDevice {
    id: number;
    name: string;
    type: string;
    roomID?: number;
}

export interface QaFile {
    name: string;
    type: string;
    isMain: boolean;
    isOpen: boolean;
    content?: string;
}

export interface DebugMessage {
    id: number;
    timestamp: number;
    type: string;
    tag: string;
    message: string;
}

export interface ApiStats {
    /** Total number of HTTP requests made since connect (or last reset). */
    total: number;
    /** Per-endpoint counts keyed as "METHOD /api/path" with numeric IDs normalised to {id}. */
    byEndpoint: Record<string, number>;
    /** Timestamp (Date) when stats were last reset. */
    since: Date;
}

/** Normalise variable path segments so stats group nicely, e.g. /api/quickApp/42/files/main → /api/quickApp/{id}/files/{name} */
function normaliseApiPath(raw: string): string {
    return raw
        .replace(/\/api\/quickApp\/\d+\/files\/[^?/]+/, '/api/quickApp/{id}/files/{name}')
        .replace(/\/api\/quickApp\/\d+\/files/, '/api/quickApp/{id}/files')
        .replace(/\/api\/quickApp\/export\/\d+/, '/api/quickApp/export/{id}')
        .replace(/\/api\/devices\/\d+/, '/api/devices/{id}')
        .replace(/\/api\/debugMessages.*/, '/api/debugMessages');
}

export class Hc3Client {
    private readonly authHeader: string;
    private readonly baseUrl: string;
    private _stats: ApiStats = { total: 0, byEndpoint: {}, since: new Date() };

    constructor(baseUrl: string, user: string, password: string) {
        this.baseUrl = baseUrl;
        this.authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    }

    getStats(): Readonly<ApiStats> { return this._stats; }

    resetStats(): void {
        this._stats = { total: 0, byEndpoint: {}, since: new Date() };
    }

    private request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
        const key = `${method} ${normaliseApiPath(apiPath.split('?')[0])}`;
        this._stats.total++;
        this._stats.byEndpoint[key] = (this._stats.byEndpoint[key] ?? 0) + 1;
        return new Promise((resolve, reject) => {
            const url = new URL(this.baseUrl + apiPath);
            const isHttps = url.protocol === 'https:';

            const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
            const headers: Record<string, string> = {
                'Authorization': this.authHeader,
                'Accept': 'application/json',
            };
            if (bodyStr) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
            }

            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers,
            };

            const transport = isHttps ? https : http;
            const req = transport.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf-8');
                    const status = res.statusCode ?? 0;
                    if (status >= 400) {
                        const hint =
                            status === 401 ? ' — check your credentials' :
                            status === 403 ? ' — HC3 user lacks write permission (admin role required)' :
                            status === 404 ? ' — resource not found on HC3' : '';
                        reject(new Error(`HC3 HTTP ${status}${hint}: ${raw}`));
                        return;
                    }
                    try {
                        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
                    } catch {
                        resolve(raw as unknown as T);
                    }
                });
            });

            req.on('error', reject);
            if (bodyStr) { req.write(bodyStr); }
            req.end();
        });
    }

    /** GET /api/devices?interface=quickApp — lists all QuickApp devices */
    listQuickApps(): Promise<QaDevice[]> {
        return this.request<QaDevice[]>('GET', '/api/devices?interface=quickApp');
    }

    /** GET /api/quickApp/{id}/files — lists files (no content) */
    listFiles(deviceId: number): Promise<QaFile[]> {
        return this.request<QaFile[]>('GET', `/api/quickApp/${deviceId}/files`);
    }

    /** GET /api/quickApp/{id}/files/{name} — fetch a single file with content */
    readFile(deviceId: number, name: string): Promise<QaFile> {
        return this.request<QaFile>('GET', `/api/quickApp/${deviceId}/files/${encodeURIComponent(name)}`);
    }

    /** PUT /api/quickApp/{id}/files/{name} — save a file (must include all fields + content) */
    writeFile(deviceId: number, file: QaFile): Promise<void> {
        return this.request<void>(
            'PUT',
            `/api/quickApp/${deviceId}/files/${encodeURIComponent(file.name)}`,
            file
        );
    }

    /** POST /api/quickApp/{id}/files — create a new (empty) file */
    createFile(deviceId: number, name: string): Promise<QaFile> {
        return this.request<QaFile>('POST', `/api/quickApp/${deviceId}/files`, {
            name,
            type: 'lua',
            isMain: false,
            isOpen: false,
            content: '',
        });
    }

    /** DELETE /api/quickApp/{id}/files/{name} — remove a file */
    deleteFile(deviceId: number, name: string): Promise<void> {
        return this.request<void>(
            'DELETE',
            `/api/quickApp/${deviceId}/files/${encodeURIComponent(name)}`
        );
    }

    /** GET /api/quickApp/export/{id} — export device as .fqa (returns raw Buffer) */
    exportFqa(deviceId: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const url = new URL(this.baseUrl + `/api/quickApp/export/${deviceId}`);
            const isHttps = url.protocol === 'https:';
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'GET',
                headers: { 'Authorization': this.authHeader, 'Accept': 'application/json' },
            };
            const transport = isHttps ? https : http;
            const req = transport.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    const buf = Buffer.concat(chunks);
                    if (status >= 400) {
                        reject(new Error(`HC3 HTTP ${status}: ${buf.toString('utf-8')}`));
                    } else {
                        resolve(buf);
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    /** PUT /api/devices/{id} — rename a QuickApp device */
    renameDevice(deviceId: number, newName: string): Promise<void> {
        return this.request<void>('PUT', `/api/devices/${deviceId}`, { name: newName });
    }

    /** GET /api/devices/{id} — get full device details including properties */
    getDevice(deviceId: number): Promise<QaDevice & { properties: Record<string, unknown> }> {
        return this.request<QaDevice & { properties: Record<string, unknown> }>(
            'GET', `/api/devices/${deviceId}`
        );
    }

    /** GET /api/debugMessages?from={from} — fetch debug log entries after a given message id */
    getDebugMessages(from: number): Promise<{ messages: DebugMessage[] }> {
        return this.request<{ messages: DebugMessage[] }>(
            'GET', `/api/debugMessages?from=${from}`
        );
    }

    /** Lightweight ping — just checks the HC3 is reachable */
    ping(): Promise<boolean> {
        return this.listQuickApps().then(() => true).catch(() => false);
    }

    /** Format current stats as a human-readable string for display. */
    formatStats(): string {
        const s = this._stats;
        const age = Math.round((Date.now() - s.since.getTime()) / 1000);
        const duration = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age/60)}m ${age%60}s` : `${Math.floor(age/3600)}h ${Math.floor((age%3600)/60)}m`;
        const lines = [
            `Total API calls: ${s.total}  (since connect, ${duration} ago)`,
            '',
            'Calls by endpoint:',
        ];
        const sorted = Object.entries(s.byEndpoint).sort((a, b) => b[1] - a[1]);
        for (const [endpoint, count] of sorted) {
            lines.push(`  ${String(count).padStart(5)}  ${endpoint}`);
        }
        return lines.join('\n');
    }
}
