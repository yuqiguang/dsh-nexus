import { chmod, rename, writeFile } from 'node:fs/promises';

/**
 * DSH announces its web address with the login token in the query string. Under systemd that line lands in
 * the journal, which keeps it for weeks; the address is split so the journal gets the bare origin and the full
 * address goes to a file only this user can read.
 * @param {string} line - one line of DSH's standard output.
 * @returns {{ shown: string, saved: string } | undefined} what to print and what to save, or undefined for any other line.
 */
export function splitWebUrl(line) {
  const match = /^dsh web: (\S*[?&]token=\S*)(.*)$/.exec(line);
  if (!match) return undefined;
  let origin;
  try { origin = new URL(match[1]).origin; } catch { return undefined; }
  return { shown: `dsh web: ${origin}/（带登录令牌的地址在 .nexus/web-url，只有本机这个用户能读）`, saved: `${match[1]}${match[2]}\n` };
}

/**
 * Replace the saved address atomically, readable by this user only.
 * @param {string} path - where the address is kept.
 * @param {string} content - the address line.
 */
export async function saveWebUrl(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
