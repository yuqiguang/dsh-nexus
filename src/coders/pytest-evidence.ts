import { opendir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redact } from './normalize.js';

const SKIP = ['node_modules', '__pycache__', 'venv', 'env', 'site-packages', 'dist', 'build'];

/** Common in-project testpaths only narrow our scanned superset. Unknown discovery settings remain explicit. */
export function customPytestDiscovery(source: string): boolean {
  if (/\b(?:python_files|pythonpath|pytest_plugins)\s*=/.test(source)) return true;
  for (const match of source.matchAll(/(?:^|\n)\s*testpaths\s*=\s*(\[[^\]]*\]|[^\r\n]*(?:\r?\n[ \t]+[^\r\n=]+)*)/g)) {
    const paths = match[1]!.replace(/[\[\]"',]/g, ' ').trim().split(/\s+/);
    if (!paths.length || paths.some(path => !/^[A-Za-z0-9_/-]+$/.test(path) || path.startsWith('/')
      || path.split('/').some(part => SKIP.includes(part)))) return true;
  }
  return false;
}

/** Bounded static discovery of default pytest candidates, without importing tests or following directory links. */
export async function pytestSources(cwd: string, within: (path: string) => Promise<string>): Promise<{ paths: string[]; evidence: string[]; complete: boolean }> {
  const paths: string[] = [], evidence: string[] = [];
  let complete = true, entries = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (entries >= 256 || depth > 6) { complete = false; return; }
    let directory;
    try { directory = await opendir(await within(path)); }
    catch { complete = false; evidence.push(`${redact(path)}: 测试目录未读取，不能确认审核边界或目录状态`); return; }
    const children = [];
    for await (const entry of directory) {
      if (++entries > 256) { complete = false; break; }
      children.push(entry);
    }
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP.includes(entry.name)) continue;
      const child = resolve(path, entry.name);
      if (entry.isSymbolicLink()) { complete = false; evidence.push(`${redact(child)}: 测试发现跳过符号链接，不能推断其内容`); continue; }
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.isFile() && (/^(?:test_.*|.*_test)\.py$/.test(entry.name) || entry.name === 'conftest.py')) paths.push(child);
    }
  };
  await visit(cwd, 0);
  if (!complete) evidence.push('pytest 测试发现不完整或超过目录/条目上限，不得假定未读取的代码安全。');
  return { paths, evidence, complete };
}
