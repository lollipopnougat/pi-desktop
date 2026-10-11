import { Notification, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from './provider-config';

export type SystemNotificationKind = 'turnEnd' | 'ask' | 'backgroundTask';

interface NotifyConfig {
  enabled: boolean;
  mode: 'always' | 'unfocused' | 'never';
  onTurnEnd: boolean;
  onAsk: boolean;
}

function readNotifyConfig(): NotifyConfig {
  try {
    const raw = fs.readFileSync(path.join(getAgentDir(), 'ui-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode =
      parsed.notifyMode === 'always' ||
      parsed.notifyMode === 'unfocused' ||
      parsed.notifyMode === 'never'
        ? parsed.notifyMode
        : 'unfocused';
    return {
      enabled: parsed.notifyEnabled !== false,
      mode,
      onTurnEnd: parsed.notifyOnTurnEnd !== false,
      onAsk: parsed.notifyOnAsk !== false
    };
  } catch {
    return { enabled: true, mode: 'unfocused', onTurnEnd: true, onAsk: true };
  }
}

/**
 * Electron 42+ delivers macOS notifications through UNUserNotificationCenter, which
 * refuses bundles without a real code signature: `show()` then emits `failed` with a
 * `UNErrorDomain` error and nothing is displayed. The AppleScript bridge has no such
 * requirement, so it backs up the native API (notification appears as "Script Editor").
 */
function showMacNotificationFallback(title: string, body: string): void {
  if (process.platform !== 'darwin') return;
  if (!title && !body) return;
  try {
    execFile('osascript', ['-e', buildMacFallbackScript(title, body)], () => {
      // Best-effort only: a failed fallback never affects task/session completion.
    });
  } catch {
    // ignore
  }
}

/**
 * AppleScript text for the fallback notification. Exported for tests: the title/body can
 * carry arbitrary user or model text, so escaping is the security-relevant part (the
 * script goes to `osascript` via `execFile`, so no shell is involved).
 */
export function buildMacFallbackScript(title: string, body: string): string {
  const quote = (value: string): string =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
  return body
    ? `display notification ${quote(body)} with title ${quote(title)} sound name "default"`
    : `display notification ${quote(title)} sound name "default"`;
}

/** Main-process notification gate shared by conversation and background-task events. */
export function showSystemNotification(
  win: BrowserWindow | null,
  kind: SystemNotificationKind,
  title: string,
  body = ''
): void {
  const config = readNotifyConfig();
  if (!config.enabled || config.mode === 'never') return;
  if (kind === 'turnEnd' && !config.onTurnEnd) return;
  if (kind === 'ask' && !config.onAsk) return;
  if (config.mode === 'unfocused' && win && win.isFocused() && !win.isMinimized()) return;
  if (!Notification.isSupported()) return;

  try {
    const notification = new Notification({ title, body: body || undefined });
    notification.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    notification.on('failed', () => {
      showMacNotificationFallback(title, body);
    });
    notification.show();
  } catch {
    // Notifications are best-effort and never affect task/session completion.
  }
}
