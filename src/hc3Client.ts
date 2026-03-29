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

export class Hc3Client {
    private readonly authHeader: string;
    private readonly baseUrl: string;

    constructor(baseUrl: string, user: string, password: string) {
        this.baseUrl = baseUrl;
        this.authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    }

    private request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
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
                        reject(new Error(`HC3 HTTP ${status}: ${raw}`));
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
}
