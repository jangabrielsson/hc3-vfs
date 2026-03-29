import * as vscode from 'vscode';
import { Hc3Client, DebugMessage } from './hc3Client';

function pollIntervalMs(): number {
    const seconds = vscode.workspace.getConfiguration('hc3vfs').get<number>('logPollInterval') ?? 4;
    return Math.max(1, seconds) * 1000;
}

/** Maps HC3 message type to a short prefix shown in the output channel. */
function typePrefix(type: string): string {
    switch (type) {
        case 'debug':   return '[DEBUG]';
        case 'warning': return '[WARN] ';
        case 'error':   return '[ERROR]';
        case 'trace':   return '[TRACE]';
        default:        return `[${type.toUpperCase()}]`;
    }
}

function formatMessage(msg: DebugMessage): string {
    const d = new Date(msg.timestamp * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss} ${typePrefix(msg.type)} [${msg.tag}] ${msg.message}`;
}

export class Hc3LogPoller {
    private readonly channel: vscode.OutputChannel;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private lastId = 0;
    private started = false;

    constructor() {
        this.channel = vscode.window.createOutputChannel('HC3 Log');
    }

    /** Call once after connecting. Grabs current tail id then starts polling. */
    async start(client: Hc3Client): Promise<void> {
        if (this.started) { this.stop(); }
        this.started = true;
        this.channel.clear();

        // Prime lastId to the most recent message so we don't flood old history.
        try {
            const resp = await client.getDebugMessages(0);
            const msgs = resp.messages ?? [];
            if (msgs.length > 0) {
                this.lastId = Math.max(...msgs.map(m => m.id));
            }
        } catch {
            // If the endpoint is unreachable just start from 0.
        }

        this.channel.show(true /* preserveFocus */);

        const schedule = () => {
            this.timer = setTimeout(async () => {
                if (!this.started) { return; }
                try {
                    const resp = await client.getDebugMessages(this.lastId + 1);
                    const msgs = resp.messages ?? [];
                    // Filter out anything at or below lastId (defensive, in case `from` is inclusive)
                    const fresh = msgs.filter(m => m.id > this.lastId);
                    if (fresh.length > 0) {
                        // Sort ascending so oldest prints first → newest at the bottom
                        fresh.sort((a, b) => a.id - b.id);
                        for (const msg of fresh) {
                            this.channel.appendLine(formatMessage(msg));
                        }
                        this.lastId = fresh[fresh.length - 1].id;
                    }
                } catch {
                    // Silently skip — the ping-based status bar already reports connectivity issues.
                }
                schedule(); // reschedule so the interval is re-read from settings each time
            }, pollIntervalMs());
        };
        schedule();
    }

    /** Stop polling (called on disconnect / deactivate). */
    stop(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.started = false;
    }

    /** Expose the channel so callers can dispose it with the extension context. */
    get outputChannel(): vscode.OutputChannel {
        return this.channel;
    }

    dispose(): void {
        this.stop();
        this.channel.dispose();
    }
}
