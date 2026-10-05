import { lstat, readFile, realpath, stat, readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isInside, isProtectedPath } from './rules.js';

/** Evidence for routing a project pip request to review, never an execution grant.
 * The reviewer still sees the entire shell expression, requested permissions and startup effects. */
export async function projectPipEvidence(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<string[] | undefined> {
  if ((command.match(/\bpip(?:3)?\s+install\b/gi) ?? []).length !== 1
    || /(?:^|\s)-t(?:\s|=|[^\s])|--(?:target|prefix|root|user|python|break-system-packages)\b|\bPIP_[A-Z_]+\b/i.test(command)
    || Object.entries(env ?? {}).some(([key, value]) => value && /^(?:PIP_(?:TARGET|PREFIX|ROOT|USER|PYTHON|CONFIG_FILE)|PYTHONHOME|PYTHONPATH)$/i.test(key))) return;
  // Only explicit interpreter paths qualify; activation/PATH aliases and bare pip stay manual.
  const match = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"';|&]+))\s+-m\s+pip\s+install\b/i.exec(command);
  const word = match && (match[1] ?? match[2] ?? match[3]);
  if (!word || !/[\\/]+(?:bin[\\/]+python(?:3(?:\.\d+)?)?|Scripts[\\/]+python\.exe)$/i.test(word)) return;
  try {
    const executable = resolve(cwd, word);
    const venv = dirname(dirname(executable));
    const realRoot = await realpath(cwd), realVenv = await realpath(venv);
    if (!isInside(cwd, venv) || venv === resolve(cwd) || !isInside(realRoot, realVenv)
      || isProtectedPath(realVenv, [realRoot], true)) return;
    const config = resolve(venv, 'pyvenv.cfg');
    const info = await lstat(config);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) return;
    const text = await readFile(config, 'utf8');
    const settings = text.split(/\r?\n/).filter(line => /^include-system-site-packages\s*=/i.test(line));
    if (!/^home\s*=\s*\S.+$/mi.test(text) || settings.length !== 1 || !/^include-system-site-packages\s*=\s*false\s*$/i.test(settings[0]!)) return;
    const binary = await realpath(executable), binaryInfo = await stat(binary);
    if (!binaryInfo.isFile()) return;
    // Site directories must not redirect installation outside the virtual environment.
    for (const name of ['Lib', 'lib', 'lib64']) {
      const path = resolve(venv, name);
      try { if (!isInside(realVenv, await realpath(path))) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    }
    const sites = [resolve(venv, 'Lib', 'site-packages')];
    for (const name of ['lib', 'lib64']) {
      const entries = await readdir(resolve(venv, name)).catch(() => []);
      for (const entry of entries.filter(value => /^python[0-9.]+$/.test(value))) sites.push(resolve(venv, name, entry, 'site-packages'));
    }
    for (const site of sites) {
      try { if (!isInside(realVenv, await realpath(site))) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    }
    const identity = `${binaryInfo.dev}:${binaryInfo.ino}:${binaryInfo.size}:${binaryInfo.mtimeMs}:${binaryInfo.ctimeMs}`;
    return [`项目虚拟环境候选：${realVenv}${sep}；显式解释器 ${executable} -> ${binary}；身份 ${identity}；pyvenv.cfg SHA256 ${createHash('sha256').update(text).digest('hex')}。include-system-site-packages=false。仅允许进入审核，不证明整条命令安全；核对 shell、环境赋值、pip 配置、安装来源及安装钩子，无法确认实际安装目标时转人工。`];
  } catch { return; }
}
