import * as http from 'http';
import * as net from 'net';

/**
 * A minimal reverse-proxy that forwards every browser request to the HC3,
 * automatically adding the Authorization header.
 *
 * The browser points to http://127.0.0.1:{port}/mobile/... — the HC3's SPA
 * uses only relative URLs for its API calls, so all XHR traffic flows through
 * this proxy too and gets authenticated transparently.
 */
export class Hc3BrowserProxy {
    private server: http.Server | undefined;
    private _port: number | undefined;

    constructor(
        private readonly hc3Host: string,
        private readonly hc3Port: number,
        private readonly authHeader: string,
    ) {}

    async start(): Promise<void> {
        if (this.server) { return; } // already running

        this.server = http.createServer((clientReq, clientRes) => {
            const reqHeaders: Record<string, string | string[] | undefined> = {};
            for (const [k, v] of Object.entries(clientReq.headers)) {
                reqHeaders[k] = v;
            }
            // Override host and credentials for every forwarded request
            reqHeaders['host'] = this.hc3Host;
            reqHeaders['authorization'] = this.authHeader;

            const proxyOpts: http.RequestOptions = {
                hostname: this.hc3Host,
                port: this.hc3Port,
                path: clientReq.url ?? '/',
                method: clientReq.method,
                headers: reqHeaders,
            };

            const proxyReq = http.request(proxyOpts, (proxyRes) => {
                const respHeaders: http.OutgoingHttpHeaders = {};
                let isHtml = false;
                for (const [k, v] of Object.entries(proxyRes.headers)) {
                    const lower = k.toLowerCase();
                    // Remove headers that would prevent the browser rendering the page
                    if (lower === 'x-frame-options') { continue; }
                    if (lower === 'content-security-policy') { continue; }
                    if (lower === 'content-length') { continue; } // will be wrong after injection
                    if (lower === 'content-type' && String(v).includes('text/html')) { isHtml = true; }
                    respHeaders[k] = v as string | string[];
                }

                if (!isHtml) {
                    clientRes.writeHead(proxyRes.statusCode ?? 200, respHeaders);
                    proxyRes.pipe(clientRes, { end: true });
                    return;
                }

                // Buffer the HTML so we can inject the localStorage seed script
                const chunks: Buffer[] = [];
                proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
                proxyRes.on('end', () => {
                    let html = Buffer.concat(chunks).toString('utf8');
                    // Extract just the token part from "Basic <token>"
                    const token = this.authHeader.replace(/^Basic\s+/i, '').trim();
                    const seedScript =
                        `<script>` +
                        `try{localStorage.setItem('fibaro.token','${token}');}` +
                        `catch(e){}` +
                        `</script>`;
                    // Inject before the first <script tag so Angular picks up the token
                    html = html.replace('<script ', seedScript + '<script ');
                    const body = Buffer.from(html, 'utf8');
                    respHeaders['content-length'] = String(body.length);
                    clientRes.writeHead(proxyRes.statusCode ?? 200, respHeaders);
                    clientRes.end(body);
                });
                proxyRes.on('error', () => {
                    if (!clientRes.headersSent) { clientRes.writeHead(502); }
                    clientRes.end();
                });
            });

            proxyReq.on('error', () => {
                if (!clientRes.headersSent) { clientRes.writeHead(502); }
                clientRes.end();
            });

            clientReq.pipe(proxyReq, { end: true });
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.listen(0, '127.0.0.1', () => resolve());
            this.server!.on('error', reject);
        });

        this._port = (this.server.address() as net.AddressInfo).port;
    }

    /** Returns the localhost URL for a given HC3 path. */
    urlFor(path: string): string {
        if (this._port === undefined) { throw new Error('Proxy not started'); }
        return `http://127.0.0.1:${this._port}${path}`;
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
        this._port = undefined;
    }

    dispose(): void {
        this.stop();
    }
}
