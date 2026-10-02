const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

let statusBarItem = null;
let cachedStatusPath = null;
let cachedMetaPath = null;

/**
 * Returns potential global telemetry paths.
 */
function getGlobalPaths() {
  const homeDir = os.homedir();
  const globalDir = path.join(homeDir, '.gemini', 'antigravity', 'telemetry');
  return {
    statusFile: path.join(globalDir, 'status.txt'),
    metaFile: path.join(globalDir, 'usage_metadata.json')
  };
}

/**
 * Finds the active status and metadata files by checking:
 * 1. Root of all workspace folders (.vscode/status.txt)
 * 2. Immediate subdirectories with .vscode/status.txt (for monorepos / parent folders)
 * 3. Global fallback (~/.gemini/antigravity/telemetry/status.txt)
 */
function findTelemetryFiles() {
  const folders = vscode.workspace.workspaceFolders || [];
  const config = vscode.workspace.getConfiguration('antigravity');
  const allowGlobal = config.get('statusBar.fallbackToGlobal', true);

  // 1. Check workspace folder roots
  for (const folder of folders) {
    const sFile = path.join(folder.uri.fsPath, '.vscode', 'status.txt');
    const mFile = path.join(folder.uri.fsPath, '.vscode', 'usage_metadata.json');
    if (fs.existsSync(sFile)) {
      return { statusFile: sFile, metaFile: fs.existsSync(mFile) ? mFile : null };
    }
  }

  // 2. Check 1-2 levels of subfolders if workspace root doesn't have it
  for (const folder of folders) {
    try {
      const root = folder.uri.fsPath;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subDir = path.join(root, entry.name);
          const sFile = path.join(subDir, '.vscode', 'status.txt');
          const mFile = path.join(subDir, '.vscode', 'usage_metadata.json');
          if (fs.existsSync(sFile)) {
            return { statusFile: sFile, metaFile: fs.existsSync(mFile) ? mFile : null };
          }
        }
      }
    } catch (_) {}
  }

  // 3. Fallback to global
  if (allowGlobal) {
    const globalPaths = getGlobalPaths();
    if (fs.existsSync(globalPaths.statusFile)) {
      return {
        statusFile: globalPaths.statusFile,
        metaFile: fs.existsSync(globalPaths.metaFile) ? globalPaths.metaFile : null
      };
    }
  }

  return { statusFile: null, metaFile: null };
}

/**
 * Reads telemetry data and updates the status bar item.
 */
function updateStatusBar() {
  if (!statusBarItem) return;

  const { statusFile, metaFile } = findTelemetryFiles();
  cachedStatusPath = statusFile;
  cachedMetaPath = metaFile;

  let statusText = '';
  let metaData = null;

  if (statusFile && fs.existsSync(statusFile)) {
    try {
      statusText = fs.readFileSync(statusFile, 'utf8').trim();
    } catch (_) {}
  }

  if (metaFile && fs.existsSync(metaFile)) {
    try {
      metaData = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch (_) {}
  }

  if (statusText) {
    statusBarItem.text = statusText;

    if (metaData) {
      const usage = metaData.usageMetadata || {};
      const metrics = metaData.metrics || {};
      const model = metaData.model || metrics.model || 'Gemini';
      const prompt = (usage.promptTokenCount || 0).toLocaleString();
      const candidates = (usage.candidatesTokenCount || 0).toLocaleString();
      const cached = (usage.cachedContentTokenCount || 0).toLocaleString();
      const total = (usage.totalTokenCount || 0).toLocaleString();
      const cachePct = metrics.cachePercentage || '0%';
      const delta = metrics.turnDeltaFormatted || '+0';
      const ttft = metrics.ttft || '~1.0s';
      const steps = metrics.stepsCount || 0;
      const updated = metrics.updatedAt ? new Date(metrics.updatedAt).toLocaleTimeString() : 'Recent';

      const tooltip = new vscode.MarkdownString();
      tooltip.supportThemeIcons = true;
      tooltip.isTrusted = true;
      tooltip.appendMarkdown(
        `### $(sparkle) **Antigravity Telemetry**\n\n` +
        `* **Model:** \`${model}\`\n` +
        `* **Total Context:** \`${total}\` tokens (\`${delta}\`)\n` +
        `* **Prompt Tokens:** \`${prompt}\`\n` +
        `* **Candidate (Output) Tokens:** \`${candidates}\`\n` +
        `* **KV Cache Hit:** \`${cached}\` (\`${cachePct}\`)\n` +
        `* **Latency (TTFT):** \`${ttft}\`\n` +
        `* **Steps Executed:** \`${steps}\`\n` +
        `* **Last Turn:** \`${updated}\`\n\n` +
        `---\n` +
        `*Click to view full breakdown.*`
      );
      statusBarItem.tooltip = tooltip;
    } else {
      statusBarItem.tooltip = 'Antigravity Token Telemetry (Click for details)';
    }

    statusBarItem.show();
  } else {
    statusBarItem.text = '$(sparkle) Antigravity';
    statusBarItem.tooltip = 'Antigravity Telemetry: Waiting for first agent turn';
    statusBarItem.show();
  }
}

/**
 * Shows interactive QuickPick modal with detailed telemetry stats.
 */
async function showTelemetryModal() {
  const { metaFile } = findTelemetryFiles();
  const targetMeta = metaFile || cachedMetaPath;

  if (!targetMeta || !fs.existsSync(targetMeta)) {
    vscode.window.showInformationMessage('No Antigravity telemetry recorded yet for this workspace.');
    return;
  }

  try {
    const meta = JSON.parse(fs.readFileSync(targetMeta, 'utf8'));
    const usage = meta.usageMetadata || {};
    const metrics = meta.metrics || {};

    const items = [
      {
        label: `$(hubot) Model: ${meta.model || 'Gemini'}`,
        description: 'Active AI LLM engine'
      },
      {
        label: `$(database) KV Cache Hit: ${(usage.cachedContentTokenCount || 0).toLocaleString()} (${metrics.cachePercentage || '0%'})`,
        description: 'Direct prompt cache reuse'
      },
      {
        label: `$(sparkle) Total Context: ${(usage.totalTokenCount || 0).toLocaleString()} (${metrics.turnDeltaFormatted || '+0'})`,
        description: 'Cumulative conversation footprint'
      },
      {
        label: `$(arrow-right) Prompt Tokens: ${(usage.promptTokenCount || 0).toLocaleString()}`,
        description: 'Input tokens processed'
      },
      {
        label: `$(arrow-left) Candidate Tokens: ${(usage.candidatesTokenCount || 0).toLocaleString()}`,
        description: 'Generated output tokens (latest turn)'
      },
      {
        label: `$(watch) TTFT Latency: ${metrics.ttft || '~1.0s'}`,
        description: 'Time to first token'
      },
      {
        label: `$(sync) Refresh Status Bar`,
        description: 'Force re-read telemetry files'
      },
      {
        label: `$(file-code) Open ${path.basename(targetMeta)}`,
        description: `View raw JSON at ${targetMeta}`
      }
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Antigravity Session Telemetry',
      placeHolder: 'Select an action or inspection view'
    });

    if (selected) {
      if (selected.label.includes('Open')) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetMeta));
        await vscode.window.showTextDocument(doc);
      } else if (selected.label.includes('Refresh')) {
        updateStatusBar();
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to parse telemetry: ${err.message}`);
  }
}

/**
 * Activates the extension.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const config = vscode.workspace.getConfiguration('antigravity');
  const alignmentSetting = config.get('statusBar.alignment') === 'left'
    ? vscode.StatusBarAlignment.Left
    : vscode.StatusBarAlignment.Right;
  const priority = config.get('statusBar.priority') || 100;

  statusBarItem = vscode.window.createStatusBarItem(alignmentSetting, priority);
  statusBarItem.command = 'antigravity.showTelemetry';

  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.showTelemetry', showTelemetryModal),
    vscode.commands.registerCommand('antigravity.refreshTelemetry', updateStatusBar)
  );

  // File system watchers for .vscode/status.txt and .vscode/usage_metadata.json
  const statusWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/status.txt');
  statusWatcher.onDidChange(updateStatusBar);
  statusWatcher.onDidCreate(updateStatusBar);
  statusWatcher.onDidDelete(updateStatusBar);

  const metaWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/usage_metadata.json');
  metaWatcher.onDidChange(updateStatusBar);
  metaWatcher.onDidCreate(updateStatusBar);

  context.subscriptions.push(statusWatcher, metaWatcher);

  // Global watcher if directory exists
  const globalPaths = getGlobalPaths();
  const globalDir = path.dirname(globalPaths.statusFile);
  if (fs.existsSync(globalDir)) {
    try {
      fs.watch(globalDir, (eventType, filename) => {
        if (filename === 'status.txt' || filename === 'usage_metadata.json') {
          updateStatusBar();
        }
      });
    } catch (_) {}
  }

  updateStatusBar();
}

function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

module.exports = {
  activate,
  deactivate
};
