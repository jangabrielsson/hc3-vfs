import * as vscode from 'vscode';
import { Hc3Client, QaDevice, QaVariable } from './hc3Client';

/**
 * Custom editor for *.hc3qa files — shows a properties panel for a QuickApp.
 * The underlying "document" is the JSON returned by GET /api/devices/{id}.
 * Saving calls PUT /api/devices/{id} with the changed fields.
 */
export class QaPropertiesEditorProvider implements vscode.CustomTextEditorProvider {

    static readonly viewType = 'hc3vfs.qaProperties';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly getClient: () => Hc3Client | undefined,
    ) {}

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: true };

        const updateWebview = () => {
            let dev: QaDevice;
            try {
                dev = JSON.parse(document.getText()) as QaDevice;
            } catch {
                webviewPanel.webview.html = `<html><body><p>Could not parse device data.</p></body></html>`;
                return;
            }
            webviewPanel.webview.html = this._buildHtml(webviewPanel.webview, dev);
        };

        // Initial render
        updateWebview();

        // Re-render if the underlying document changes
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                updateWebview();
            }
        });
        webviewPanel.onDidDispose(() => changeSubscription.dispose());

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(async (msg: {
            type: string;
            name?: string;
            enabled?: boolean;
            visible?: boolean;
            userDescription?: string;
            quickAppVariables?: QaVariable[];
            interfaces?: string[];
        }) => {
            if (msg.type !== 'save') { return; }

            const client = this.getClient();
            if (!client) {
                vscode.window.showErrorMessage('HC3: not connected.');
                return;
            }

            let dev: QaDevice;
            try {
                dev = JSON.parse(document.getText()) as QaDevice;
            } catch {
                vscode.window.showErrorMessage('HC3: could not parse device data.');
                return;
            }

            const changes: Partial<QaDevice> = {};
            if (msg.name !== undefined && msg.name !== dev.name) {
                changes.name = msg.name;
            }
            if (msg.enabled !== undefined && msg.enabled !== dev.enabled) {
                changes.enabled = msg.enabled;
            }
            if (msg.visible !== undefined && msg.visible !== dev.visible) {
                changes.visible = msg.visible;
            }
            if (msg.interfaces !== undefined) {
                // Always send interfaces — order may differ, compare by sorted content
                const current = [...(dev.interfaces ?? [])].sort().join(',');
                const updated = [...msg.interfaces].sort().join(',');
                if (current !== updated) {
                    changes.interfaces = msg.interfaces;
                }
            }

            // quickAppVariables and userDescription live inside properties
            const newVars = msg.quickAppVariables;
            const newDesc = msg.userDescription;
            const propChanges: QaDevice['properties'] = {};
            let hasPropertyChange = false;
            if (newVars !== undefined) {
                propChanges.quickAppVariables = newVars;
                hasPropertyChange = true;
            }
            if (newDesc !== undefined && newDesc !== (dev.properties?.userDescription ?? '')) {
                propChanges.userDescription = newDesc;
                hasPropertyChange = true;
            }
            if (hasPropertyChange) {
                changes.properties = propChanges;
            }

            if (Object.keys(changes).length === 0) {
                vscode.window.showInformationMessage('HC3: no changes to save.');
                return;
            }

            try {
                await client.updateDevice(dev.id, changes);

                // Refresh the document with updated data from HC3
                const updated = await client.getDevice(dev.id);
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                edit.replace(document.uri, fullRange, JSON.stringify(updated, null, 2));
                await vscode.workspace.applyEdit(edit);

                webviewPanel.webview.postMessage({ type: 'saved' });
            } catch (err) {
                const msg2 = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`HC3 save failed: ${msg2}`);
                webviewPanel.webview.postMessage({ type: 'error', message: msg2 });
            }
        });
    }

    private _buildHtml(_webview: vscode.Webview, dev: QaDevice): string {
        const vars: QaVariable[] = dev.properties?.quickAppVariables ?? [];
        const userDesc = dev.properties?.userDescription ?? '';
        const interfaces = dev.interfaces ?? [];

        const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const escHtml = (s: string) => s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const fmtTs = (ts: number | undefined) => {
            if (!ts) { return '—'; }
            return new Date(ts * 1000).toLocaleString();
        };

        const varRows = vars.map((v, idx) => `
            <tr>
                <td><input class="var-name" data-idx="${idx}" value="${escAttr(String(v.name))}" /></td>
                <td><input class="var-value" data-idx="${idx}" value="${escAttr(String(v.value))}" /></td>
                <td><button class="del-var" data-idx="${idx}" title="Remove">\u2715</button></td>
            </tr>`).join('');

        const ifaceTags = interfaces.map((i, idx) => `
            <span class="iface-tag">${escHtml(i)}<button class="del-iface" data-idx="${idx}" title="Remove interface">\u2715</button></span>`
        ).join('');

        const nonce = Math.random().toString(36).slice(2);

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>QuickApp Properties</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; max-width: 600px; }
  h2 { margin: 0 0 4px 0; font-size: 1.2em; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 4px; }
  .timestamps { color: var(--vscode-descriptionForeground); font-size: 0.78em; margin-bottom: 20px; }
  .section { margin-bottom: 20px; }
  .section-label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  input[type=text], textarea {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); padding: 4px 8px;
    border-radius: 3px; font-family: inherit; font-size: inherit;
  }
  input[type=text] { width: 320px; }
  textarea { width: 320px; height: 60px; resize: vertical; }
  input[type=checkbox] { width: 16px; height: 16px; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; max-width: 500px; }
  th { text-align: left; font-size: 0.8em; color: var(--vscode-descriptionForeground); padding: 0 8px 4px 0; }
  td { padding: 3px 8px 3px 0; }
  td input[type=text] { width: 180px; }
  .del-var, .del-iface { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; font-size: 0.9em; padding: 0 4px; opacity: 0.7; }
  .del-var:hover, .del-iface:hover { opacity: 1; }
  .add-btn { margin-top: 6px; background: none; border: 1px solid var(--vscode-button-border, #555); color: var(--vscode-button-secondaryForeground); padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 0.85em; }
  .add-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .iface-tag { display: inline-flex; align-items: center; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 2px 4px 2px 10px; font-size: 0.85em; margin: 2px 4px 2px 0; }
  .iface-add-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .iface-add-row input[type=text] { width: 200px; }
  #save-btn { margin-top: 8px; padding: 6px 20px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-size: 1em; }
  #save-btn:hover { background: var(--vscode-button-hoverBackground); }
  #save-btn:disabled { opacity: 0.5; cursor: default; }
  #status { margin-top: 10px; font-size: 0.85em; min-height: 1.2em; }
  .ok { color: var(--vscode-charts-green, #4caf50); }
  .err { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<h2>${escHtml(dev.name)}</h2>
<div class="subtitle">${escHtml(dev.type)}  ·  id: ${dev.id}</div>
<div class="timestamps">Created: ${fmtTs(dev.created)}  &nbsp;·&nbsp;  Modified: ${fmtTs(dev.modified)}</div>

<div class="section">
  <div class="section-label">Name</div>
  <input type="text" id="qa-name" value="${escAttr(dev.name)}" />
</div>

<div class="section">
  <div class="section-label">State</div>
  <label><input type="checkbox" id="qa-enabled" ${dev.enabled ? 'checked' : ''} /> Enabled</label>
  <label><input type="checkbox" id="qa-visible" ${dev.visible ? 'checked' : ''} /> Visible in dashboard</label>
</div>

<div class="section">
  <div class="section-label">Description</div>
  <textarea id="qa-desc">${escHtml(userDesc)}</textarea>
</div>

<div class="section">
  <div class="section-label">Interfaces</div>
  <div id="ifaces-container">${ifaceTags || '<span style="opacity:0.5;font-size:0.85em">none</span>'}</div>
  <div class="iface-add-row">
    <input type="text" id="iface-input" placeholder="e.g. energy" />
    <button class="add-btn" id="add-iface">+ Add</button>
  </div>
</div>

<div class="section">
  <div class="section-label">QuickApp Variables</div>
  <table>
    <thead><tr><th>Name</th><th>Value</th><th></th></tr></thead>
    <tbody id="vars-body">${varRows}</tbody>
  </table>
  <button class="add-btn" id="add-var">+ Add variable</button>
</div>

<button id="save-btn">Save</button>
<div id="status"></div>

<script nonce="${nonce}">
(function() {
    const vscode = acquireVsCodeApi();
    let vars = ${JSON.stringify(vars)};
    let ifaces = ${JSON.stringify(interfaces)};

    // ---- helpers ----
    function escAttr(s) {
        return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ---- vars ----
    function renderVars() {
        const tbody = document.getElementById('vars-body');
        tbody.innerHTML = vars.map((v, i) =>
            '<tr>' +
            '<td><input class="var-name" data-idx="' + i + '" value="' + escAttr(v.name) + '" /></td>' +
            '<td><input class="var-value" data-idx="' + i + '" value="' + escAttr(v.value) + '" /></td>' +
            '<td><button class="del-var" data-idx="' + i + '" title="Remove">\u2715</button></td>' +
            '</tr>'
        ).join('');
        tbody.querySelectorAll('.var-name').forEach(el =>
            el.addEventListener('input', e => { vars[+e.target.dataset.idx].name = e.target.value; }));
        tbody.querySelectorAll('.var-value').forEach(el =>
            el.addEventListener('input', e => { vars[+e.target.dataset.idx].value = e.target.value; }));
        tbody.querySelectorAll('.del-var').forEach(el =>
            el.addEventListener('click', e => { vars.splice(+e.target.dataset.idx, 1); renderVars(); }));
    }
    renderVars();

    document.getElementById('add-var').addEventListener('click', () => {
        vars.push({ name: 'newVar', value: '' });
        renderVars();
    });

    // ---- interfaces ----
    function renderIfaces() {
        const c = document.getElementById('ifaces-container');
        if (ifaces.length === 0) {
            c.innerHTML = '<span style="opacity:0.5;font-size:0.85em">none</span>';
            return;
        }
        c.innerHTML = ifaces.map((iface, i) =>
            '<span class="iface-tag">' + escAttr(iface) +
            '<button class="del-iface" data-idx="' + i + '" title="Remove interface">\u2715</button></span>'
        ).join('');
        c.querySelectorAll('.del-iface').forEach(el =>
            el.addEventListener('click', e => { ifaces.splice(+e.target.dataset.idx, 1); renderIfaces(); }));
    }
    // wire initial del buttons
    document.querySelectorAll('.del-iface').forEach(el =>
        el.addEventListener('click', e => { ifaces.splice(+e.target.dataset.idx, 1); renderIfaces(); }));

    document.getElementById('add-iface').addEventListener('click', () => {
        const input = document.getElementById('iface-input');
        const val = input.value.trim();
        if (val && !ifaces.includes(val)) { ifaces.push(val); renderIfaces(); }
        input.value = '';
    });
    document.getElementById('iface-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { document.getElementById('add-iface').click(); }
    });

    // ---- save ----
    document.getElementById('save-btn').addEventListener('click', () => {
        const btn = document.getElementById('save-btn');
        const status = document.getElementById('status');
        btn.disabled = true;
        status.textContent = 'Saving\u2026';
        status.className = '';

        // Collect var inputs (may have changed since last render)
        const nameInputs = document.querySelectorAll('.var-name');
        const valueInputs = document.querySelectorAll('.var-value');
        const currentVars = vars.map((v, i) => ({
            name: nameInputs[i] ? nameInputs[i].value : v.name,
            value: valueInputs[i] ? valueInputs[i].value : v.value,
            type: v.type,
        }));

        vscode.postMessage({
            type: 'save',
            name: document.getElementById('qa-name').value,
            enabled: document.getElementById('qa-enabled').checked,
            visible: document.getElementById('qa-visible').checked,
            userDescription: document.getElementById('qa-desc').value,
            quickAppVariables: currentVars,
            interfaces: ifaces,
        });
    });

    window.addEventListener('message', e => {
        const msg = e.data;
        const btn = document.getElementById('save-btn');
        const status = document.getElementById('status');
        if (msg.type === 'saved') {
            btn.disabled = false;
            status.textContent = 'Saved \u2713';
            status.className = 'ok';
            setTimeout(() => { status.textContent = ''; }, 3000);
        } else if (msg.type === 'error') {
            btn.disabled = false;
            status.textContent = 'Error: ' + msg.message;
            status.className = 'err';
        }
    });
})();
</script>
</body>
</html>`;
    }
}
