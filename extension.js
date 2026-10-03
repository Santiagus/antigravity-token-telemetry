const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

let statusBarItem = null;
let cachedStatusPath = null;
let cachedMetaPath = null;
let lastOverallHealth = 'healthy';

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
 * Helper to format large token numbers compactly (e.g. 44.0k, 1.2M).
 * @param {number} count
 * @returns {string}
 */
function formatTokens(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return `${count}`;
}

/**
 * Parses metrics from status.txt if usage_metadata.json is not available.
 * @param {string} statusText
 */
function extractMetricsFromStatusText(statusText) {
  let model = 'Gemini';
  let totalTokens = 0;
  let deltaStr = '+0';
  let cachedTokens = 0;
  let cachePct = 0;
  let ttftStr = '~1.0s';
  let ttftSec = 1.0;

  if (statusText) {
    const parts = statusText.split('|').map((s) => s.trim());
    if (parts.length > 0 && parts[0]) {
      model = parts[0].replace(/[\$\(\)\w\-]+/g, (m) => m).trim();
    }
    const tokenMatch = statusText.match(/Tokens?\s+([0-9\.]+)(k|M)?\s*\(([^\)]+)\)/i) || statusText.match(/([0-9\.]+)(k|M)?\s*\(([^\)]+)\)/i) || statusText.match(/([0-9\.]+)(k|M)?/i);
    if (tokenMatch) {
      const val = parseFloat(tokenMatch[1]);
      const unit = (tokenMatch[2] || '').toLowerCase();
      totalTokens = unit === 'm' ? Math.round(val * 1000000) : unit === 'k' ? Math.round(val * 1000) : Math.round(val);
      if (tokenMatch[3]) deltaStr = tokenMatch[3];
    }
    const cacheMatch = statusText.match(/([0-9]+)%\s*(cache\s*hit|cached)?/i) || statusText.match(/([0-9\.]+)(k|M)?\s*\(([0-9]+)%\)/i);
    if (cacheMatch) {
      if (cacheMatch[3]) {
        const val = parseFloat(cacheMatch[1]);
        const unit = (cacheMatch[2] || '').toLowerCase();
        cachedTokens = unit === 'm' ? Math.round(val * 1000000) : unit === 'k' ? Math.round(val * 1000) : Math.round(val);
        cachePct = parseInt(cacheMatch[3], 10);
      } else {
        cachePct = parseInt(cacheMatch[1], 10);
      }
    }
    const ttftMatch = statusText.match(/TTFT\s*~?([0-9\.]+)s/i) || statusText.match(/~?([0-9\.]+)s/i);
    if (ttftMatch) {
      ttftSec = parseFloat(ttftMatch[1]);
      ttftStr = `~${ttftSec.toFixed(1)}s`;
    }
  }

  return { model, totalTokens, deltaStr, cachedTokens, cachePct, ttftStr, ttftSec };
}

/**
 * Evaluates independent metric states and generates combination-aware health advice.
 */
function evaluateTelemetryHealth(data, config) {
  const enableColors = config.get('statusBar.enableHealthColors', true);

  // 1. Context Tokens
  const totalTokens = data.totalTokens || 0;
  const warnTokens = config.get('statusBar.warningThreshold', 100000);
  const critTokens = config.get('statusBar.criticalThreshold', 200000);

  let tokensState = 'healthy';
  let tokensDot = '🟢';
  let tokensLabel = 'Optimal Context';
  if (totalTokens >= critTokens) {
    tokensState = 'critical';
    tokensDot = '🔴';
    tokensLabel = 'Critical Load';
  } else if (totalTokens >= warnTokens) {
    tokensState = 'warning';
    tokensDot = '🟡';
    tokensLabel = 'Heavy Context';
  }

  // 2. KV Cache Hit %
  const cachePct = typeof data.cachePct === 'number' ? data.cachePct : 0;
  const warnCache = config.get('statusBar.cacheWarningThreshold', 70);
  const critCache = config.get('statusBar.cacheCriticalThreshold', 40);

  let cacheState = 'healthy';
  let cacheDot = '🟢';
  let cacheLabel = 'Optimal Reuse';
  if (totalTokens >= 8192) {
    if (cachePct < critCache) {
      cacheState = 'critical';
      cacheDot = '🔴';
      cacheLabel = 'Low Cache Hit';
    } else if (cachePct < warnCache) {
      cacheState = 'warning';
      cacheDot = '🟡';
      cacheLabel = 'Moderate Cache';
    }
  }

  // 3. TTFT Latency
  const ttftSec = typeof data.ttftSec === 'number' ? data.ttftSec : 1.0;
  const warnTtft = config.get('statusBar.ttftWarningThreshold', 2.5);
  const critTtft = config.get('statusBar.ttftCriticalThreshold', 4.5);

  let ttftState = 'healthy';
  let ttftDot = '🟢';
  let ttftLabel = 'Fast Response';
  if (ttftSec > critTtft) {
    ttftState = 'critical';
    ttftDot = '🔴';
    ttftLabel = 'Elevated Latency';
  } else if (ttftSec > warnTtft) {
    ttftState = 'warning';
    ttftDot = '🟡';
    ttftLabel = 'Moderate Latency';
  }

  // Overall Severity (worst-case among metrics)
  let overallState = 'healthy';
  let backgroundColor = undefined;
  if (tokensState === 'critical' || cacheState === 'critical' || ttftState === 'critical') {
    overallState = 'critical';
    backgroundColor = enableColors ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  } else if (tokensState === 'warning' || cacheState === 'warning' || ttftState === 'warning') {
    overallState = 'warning';
    backgroundColor = enableColors ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  // Combination-Aware Diagnosis & Advice
  const formattedTotal = formatTokens(totalTokens);
  const formattedCached = data.cachedTokens > 0 ? `${formatTokens(data.cachedTokens)} (${cachePct}%)` : `${cachePct}%`;
  const formattedTtft = data.ttftStr || `~${ttftSec.toFixed(1)}s`;

  let headline = 'Context & Performance Optimal';
  let advice = 'All telemetry metrics are optimal. Prompt cache reuse is strong, response latency is low, and context size is healthy.';

  if (tokensState === 'critical') {
    if (cacheState === 'healthy' && ttftState === 'healthy') {
      headline = 'High Context Footprint (Cache & TTFT Optimal)';
      advice = `Context is large (${formattedTotal}), but TTFT (${formattedTtft}) and KV cache (${cachePct}%) remain optimal. Prompt caching mitigates cost and latency; your primary risk is attention dilution across complex instructions. Consider starting a new chat if reasoning degrades.`;
    } else {
      const issues = [];
      if (cacheState !== 'healthy') issues.push(`low cache reuse (${cachePct}%)`);
      if (ttftState !== 'healthy') issues.push(`high latency (${formattedTtft})`);
      headline = 'Critical Context Footprint';
      advice = `Heavy conversation context (${formattedTotal}) combined with ${issues.join(' and ')}. Substantial cost and latency penalties per turn. Strongly recommended: start a fresh chat session (/clear or new session).`;
    }
  } else if (tokensState === 'warning') {
    if (cacheState === 'healthy' && ttftState === 'healthy') {
      headline = 'Heavy Context Session (Cache & TTFT Optimal)';
      advice = `Context is expanding (${formattedTotal}), but prompt cache is serving ${cachePct}% with fast TTFT (${formattedTtft}). Safe to continue current task, but plan to start a fresh chat soon.`;
    } else {
      headline = 'Heavy Context & Suboptimal Performance';
      advice = `Context is expanding (${formattedTotal}) with ${cacheState !== 'healthy' ? 'suboptimal cache hit (' + cachePct + '%)' : 'elevated latency (' + formattedTtft + ')'}. Consider concluding current tasks and resetting conversation history.`;
    }
  } else if (cacheState === 'critical') {
    headline = 'Low KV Cache Hit Rate';
    advice = `Prompt cache reuse is low (${cachePct}%) despite sufficient prompt tokens (${formattedTotal}). Prompt prefix invalidation detected (e.g. system instructions, dynamic files, or timestamps changing at the beginning of prompts).`;
  } else if (ttftState === 'critical') {
    headline = 'Elevated Response Latency (TTFT)';
    advice = `High latency to first token (${formattedTtft}) with compact context (${formattedTotal}). Delay is caused by backend queueing, reasoning model thinking budget, or network latency rather than context bloat.`;
  } else if (cacheState === 'warning') {
    headline = 'Moderate KV Cache Hit Rate';
    advice = `KV cache reuse is moderate (${cachePct}%). Check whether instructions or files are being modified between turns.`;
  } else if (ttftState === 'warning') {
    headline = 'Moderate Response Latency';
    advice = `Response latency is slightly elevated (${formattedTtft}). Normal for complex tasks or reasoning models.`;
  }

  return {
    tokens: { state: tokensState, dot: tokensDot, label: tokensLabel, formatted: formattedTotal, raw: totalTokens },
    cache: { state: cacheState, dot: cacheDot, label: cacheLabel, formatted: formattedCached, pct: cachePct },
    ttft: { state: ttftState, dot: ttftDot, label: ttftLabel, formatted: formattedTtft, sec: ttftSec },
    overallState,
    backgroundColor,
    headline,
    advice
  };
}

/**
 * Reads telemetry data and updates the status bar item.
 */
function updateStatusBar() {
  if (!statusBarItem) return;

  const config = vscode.workspace.getConfiguration('antigravity');
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

  if (statusText || metaData) {
    let model = 'Gemini';
    let totalTokens = 0;
    let deltaStr = '+0';
    let cachedTokens = 0;
    let cachePct = 0;
    let ttftStr = '~1.0s';
    let ttftSec = 1.0;
    let promptCount = 0;
    let candidateCount = 0;
    let stepsCount = 0;
    let updatedAtStr = 'Recent';

    if (metaData) {
      const usage = metaData.usageMetadata || {};
      const metrics = metaData.metrics || {};
      model = metaData.model || metrics.model || 'Gemini';
      totalTokens = usage.totalTokenCount || 0;
      promptCount = usage.promptTokenCount || 0;
      candidateCount = usage.candidatesTokenCount || 0;
      cachedTokens = usage.cachedContentTokenCount || 0;
      stepsCount = metrics.stepsCount || 0;
      deltaStr = metrics.turnDeltaFormatted || '+0';
      ttftStr = metrics.ttft || '~1.0s';
      ttftSec = parseFloat(ttftStr.replace(/[^0-9\.]/g, '')) || 1.0;
      cachePct = parseInt((metrics.cachePercentage || '0%').replace('%', ''), 10) || 0;
      updatedAtStr = metrics.updatedAt ? new Date(metrics.updatedAt).toLocaleTimeString() : 'Recent';
    } else {
      const extracted = extractMetricsFromStatusText(statusText);
      model = extracted.model;
      totalTokens = extracted.totalTokens;
      deltaStr = extracted.deltaStr;
      cachedTokens = extracted.cachedTokens;
      cachePct = extracted.cachePct;
      ttftStr = extracted.ttftStr;
      ttftSec = extracted.ttftSec;
    }

    const health = evaluateTelemetryHealth(
      { totalTokens, cachePct, cachedTokens, ttftSec, ttftStr },
      config
    );

    // Format status bar text according to user specification:
    // Example: Gemini 3.8 Flash | 🟢 Tokens 44.0k (+4.3k) | 🟢 90% cache hit | 🟢 TTFT ~1.0s
    const cleanTtft = (health.ttft.formatted || '~1.0s').replace(/^TTFT\s*/i, '').trim();
    const statusLine = `${model} | ${health.tokens.dot} Tokens ${health.tokens.formatted} (${deltaStr}) | ${health.cache.dot} ${cachePct}% cache hit | ${health.ttft.dot} TTFT ${cleanTtft}`;

    statusBarItem.text = statusLine;
    statusBarItem.backgroundColor = health.backgroundColor;

    // Rich hover tooltip with combination-aware advice on mouseover
    const tooltip = new vscode.MarkdownString();
    tooltip.supportThemeIcons = true;
    tooltip.isTrusted = true;
    tooltip.appendMarkdown(
      `### 📊 Antigravity Telemetry\n\n` +
      `> 💡 **Health Diagnosis:**\n` +
      `> ${health.advice}\n\n` +
      `---\n\n` +
      `#### Health Scorecard\n` +
      `* **Tokens:** ${health.tokens.dot} \`${totalTokens.toLocaleString()}\` (${deltaStr}) — *${health.tokens.label}*\n` +
      `* **Cache Hit:** ${health.cache.dot} \`${cachePct}% cache hit\` — *${health.cache.label}*\n` +
      `* **Latency:** ${health.ttft.dot} \`TTFT ${cleanTtft}\` — *${health.ttft.label}*\n\n` +
      `---\n\n` +
      `* **Model:** \`${model}\`\n` +
      `* **Prompt Tokens:** \`${promptCount.toLocaleString()}\`\n` +
      `* **Candidate (Output) Tokens:** \`${candidateCount.toLocaleString()}\`\n` +
      `* **Steps Executed:** \`${stepsCount}\`\n` +
      `* **Last Turn:** \`${updatedAtStr}\`\n\n` +
      `---\n` +
      `*Click to view actions & threshold settings.*`
    );
    statusBarItem.tooltip = tooltip;
    statusBarItem.show();

    // Notification alert popup when entering critical state
    const enablePopup = config.get('statusBar.enableCriticalAlertPopup', true);
    if (enablePopup && health.overallState === 'critical' && lastOverallHealth !== 'critical') {
      vscode.window.showWarningMessage(
        `Antigravity Telemetry Alert: ${health.headline}\n\n${health.advice}`,
        'Configure Thresholds',
        'Dismiss'
      ).then((choice) => {
        if (choice === 'Configure Thresholds') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'antigravity.statusBar');
        }
      });
    }
    lastOverallHealth = health.overallState;
  } else {
    statusBarItem.text = '$(sparkle) Antigravity';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = 'Antigravity Telemetry: Waiting for first agent turn';
    statusBarItem.show();
  }
}

/**
 * Shows interactive QuickPick modal with detailed telemetry stats and health advice.
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
    const totalTokens = usage.totalTokenCount || 0;
    const cachedTokens = usage.cachedContentTokenCount || 0;
    const ttftStr = metrics.ttft || '~1.0s';
    const ttftSec = parseFloat(ttftStr.replace(/[^0-9\.]/g, '')) || 1.0;
    const cachePct = parseInt((metrics.cachePercentage || '0%').replace('%', ''), 10) || 0;
    const config = vscode.workspace.getConfiguration('antigravity');

    const health = evaluateTelemetryHealth(
      { totalTokens, cachePct, cachedTokens, ttftSec, ttftStr },
      config
    );

    const cleanTtft = (health.ttft.formatted || '~1.0s').replace(/^TTFT\s*/i, '').trim();

    const items = [
      {
        label: `${health.overallState === 'critical' ? '🔴' : health.overallState === 'warning' ? '🟡' : '🟢'} ${health.headline}`,
        description: health.advice,
        action: 'health'
      },
      {
        label: `${health.tokens.dot} Tokens: ${totalTokens.toLocaleString()} (${metrics.turnDeltaFormatted || '+0'})`,
        description: `Thresholds: ${config.get('statusBar.warningThreshold', 100000).toLocaleString()} (warn) / ${config.get('statusBar.criticalThreshold', 200000).toLocaleString()} (crit)`
      },
      {
        label: `${health.cache.dot} Cache: ${cachePct}% cache hit`,
        description: `Thresholds: <${config.get('statusBar.cacheWarningThreshold', 70)}% (warn) / <${config.get('statusBar.cacheCriticalThreshold', 40)}% (crit)`
      },
      {
        label: `${health.ttft.dot} TTFT: ${cleanTtft}`,
        description: `Thresholds: >${config.get('statusBar.ttftWarningThreshold', 2.5)}s (warn) / >${config.get('statusBar.ttftCriticalThreshold', 4.5)}s (crit)`
      },
      {
        label: `$(hubot) Model: ${meta.model || 'Gemini'}`,
        description: 'Active AI LLM engine'
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
        label: `$(sync) Refresh Status Bar`,
        description: 'Force re-read telemetry files',
        action: 'refresh'
      },
      {
        label: `$(gear) Configure Telemetry Settings`,
        description: 'Adjust warning/critical thresholds and alerts',
        action: 'settings'
      },
      {
        label: `$(file-code) Open ${path.basename(targetMeta)}`,
        description: `View raw JSON at ${targetMeta}`,
        action: 'open'
      }
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: `Antigravity Session Telemetry — ${health.tokens.dot} ${health.cache.dot} ${health.ttft.dot}`,
      placeHolder: 'Select an action or inspection view'
    });

    if (selected) {
      if (selected.action === 'health') {
        if (health.overallState === 'critical' || health.overallState === 'warning') {
          const choice = await vscode.window.showWarningMessage(
            `Context Diagnosis: ${health.headline}\n\n${health.advice}`,
            'Configure Thresholds',
            'OK'
          );
          if (choice === 'Configure Thresholds') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'antigravity.statusBar');
          }
        } else {
          vscode.window.showInformationMessage(
            `Telemetry Health: Optimal (${totalTokens.toLocaleString()} tokens, ${cachePct}% cached, ${ttftStr} TTFT). Everything is running smoothly.`
          );
        }
      } else if (selected.action === 'open') {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetMeta));
        await vscode.window.showTextDocument(doc);
      } else if (selected.action === 'refresh') {
        updateStatusBar();
      } else if (selected.action === 'settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'antigravity.statusBar');
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to parse telemetry: ${err.message}`);
  }
}

/**
 * Creates or re-creates the status bar item based on settings.
 */
function initStatusBarItem(context) {
  if (statusBarItem) {
    statusBarItem.dispose();
  }

  const config = vscode.workspace.getConfiguration('antigravity');
  const alignmentSetting = config.get('statusBar.alignment') === 'left'
    ? vscode.StatusBarAlignment.Left
    : vscode.StatusBarAlignment.Right;
  const priority = config.get('statusBar.priority') || 100;

  statusBarItem = vscode.window.createStatusBarItem(alignmentSetting, priority);
  statusBarItem.command = 'antigravity.showTelemetry';

  context.subscriptions.push(statusBarItem);
  updateStatusBar();
}

/**
 * Activates the extension.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  initStatusBarItem(context);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.showTelemetry', showTelemetryModal),
    vscode.commands.registerCommand('antigravity.refreshTelemetry', updateStatusBar)
  );

  // Re-render when configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravity')) {
        if (e.affectsConfiguration('antigravity.statusBar.alignment') || e.affectsConfiguration('antigravity.statusBar.priority')) {
          initStatusBarItem(context);
        } else {
          updateStatusBar();
        }
      }
    })
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
