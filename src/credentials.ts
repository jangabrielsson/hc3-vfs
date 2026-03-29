import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Credentials {
    baseUrl: string;
    user: string;
    password: string;
}

function parseEnvFile(filePath: string): Record<string, string> {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const map: Record<string, string> = {};
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) { continue; }
            const eq = trimmed.indexOf('=');
            if (eq < 0) { continue; }
            const key = trimmed.slice(0, eq).trim();
            // Strip optional surrounding quotes from value
            let val = trimmed.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            map[key] = val;
        }
        return map;
    } catch {
        return {};
    }
}

function loadEnv(): Record<string, string> {
    // 1. Search workspace folder .env files
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') { continue; }
        const candidate = path.join(folder.uri.fsPath, '.env');
        const env = parseEnvFile(candidate);
        if (env['HC3_URL'] || env['HC3_USER'] || env['HC3_PASSWORD']) {
            return env;
        }
    }
    // 2. Home directory ~/.env
    const homeEnv = parseEnvFile(path.join(os.homedir(), '.env'));
    if (homeEnv['HC3_URL'] || homeEnv['HC3_USER'] || homeEnv['HC3_PASSWORD']) {
        return homeEnv;
    }
    return {};
}

export async function getCredentials(context: vscode.ExtensionContext): Promise<Credentials> {
    const env = loadEnv();
    const cfg = vscode.workspace.getConfiguration('hc3vfs');

    const rawUrl = env['HC3_URL'] ?? cfg.get<string>('host') ?? '';
    const user   = env['HC3_USER'] ?? cfg.get<string>('user') ?? '';
    const password = env['HC3_PASSWORD'] ?? (await context.secrets.get('hc3vfs.password')) ?? '';

    // Normalise URL — prepend http:// if bare IP/hostname, strip trailing slash
    let baseUrl = rawUrl.trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        baseUrl = 'http://' + baseUrl;
    }
    baseUrl = baseUrl.replace(/\/$/, '');

    if (!baseUrl || !user || !password) {
        throw new Error(
            'HC3 credentials incomplete. ' +
            'Run "HC3: Configure Credentials" or add HC3_URL/HC3_USER/HC3_PASSWORD to a .env file.'
        );
    }
    return { baseUrl, user, password };
}
