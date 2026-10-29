/**
 * Plain-language guidance shown in the pairing panel and after an update. Kept apart from the
 * extension so the wording is tested and the same everywhere. Plain text: callers escape it.
 */

/** Command Palette shortcut as the user's keyboard shows it. */
function palette(platform: string): string {
  return platform === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';
}

/** "For best results" tips for the pairing panel. */
export function bestResultsTips(platform: string): string[] {
  return [
    `After installing or updating Antigravity Remote, reload every open Antigravity window (${palette(platform)} → Developer: Reload Window), or restart Antigravity. The phone talks to one window's copy of the extension, and a window that wasn't reloaded keeps the old version.`,
    'Keep Antigravity open on this computer. The phone controls the agent running here; nothing runs on the phone.',
    'Phone connected but no conversation? Open the project in Antigravity and start or continue a chat there. If it still shows nothing, run "Antigravity Remote: Copy Diagnostics" and include the report when you ask for help.'
  ];
}

/**
 * Message for the first window that starts a new version, or null. The window showing it already
 * runs the new version; other open windows don't until they are reloaded. Not shown on a first install.
 */
export function updateNotice(previousVersion: string | undefined, currentVersion: string): string | null {
  if (!previousVersion || previousVersion === currentVersion) return null;
  return `Antigravity Remote updated to ${currentVersion}. Reload every other open Antigravity window (Developer: Reload Window) so your phone uses the new version.`;
}
