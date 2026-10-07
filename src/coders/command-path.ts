import { fileURLToPath } from 'node:url';

/** Shell/browser spellings of a local path. This is identification, never a permission grant. */
export function commandPath(value: string, platform = process.platform, wsl = false): string {
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return value;
      return fileURLToPath(url, { windows: platform === 'win32' });
    }
    catch { return value; }
  }
  if (platform === 'win32') {
    // Only interpret the default WSL drive mount in a WSL command, never in a native Windows command.
    if (wsl) return value.replace(/^\/mnt\/([a-z])(?=\/)/i, '$1:');
    return value.replace(/^\/([a-z])(?=\/)/i, '$1:');
  }
  return value;
}
