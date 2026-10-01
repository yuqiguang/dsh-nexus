import { execFileSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { projectRoot } from './setup.mjs';

// The updater builds into dist.next and swaps it in only after the tests pass, so the
// service can be restarted at any moment and still find a complete dist.
const outName = process.env.NEXUS_DIST ?? 'dist';
if (!/^dist(\.[a-z0-9-]+)?$/.test(outName)) {
  console.error(`NEXUS_DIST must be "dist" or "dist.<name>", not ${JSON.stringify(outName)}`);
  process.exit(1);
}

const compilation = spawnSync(process.execPath, ['--max-old-space-size=640', 'node_modules/typescript/bin/tsc', '--outDir', outName], {
  cwd: projectRoot, stdio: 'inherit',
});
if (compilation.status !== 0) process.exit(compilation.status ?? 1);
const result = await build({ entryPoints: ['src/client/index.ts'], absWorkingDir: projectRoot, bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['react', 'react/jsx-runtime'],
  loader: { '.css': 'text' }, write: false });
await writeFile(`${projectRoot}/${outName}/client.js`,
  'window.__ModuleLoader__.load({ id: "nexus-next", factory(require) { const module = { exports: {} }; const exports = module.exports;\n' +
  result.outputFiles[0].text + '\nreturn module.exports; } });\n');
// What this build was made from, so the running service and the updater can tell whether HEAD moved on.
const git = args => { try { return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const commit = git(['rev-parse', 'HEAD']);
await writeFile(`${projectRoot}/${outName}/build-info.json`, JSON.stringify({ commit: commit || undefined, subject: commit ? git(['log', '-1', '--format=%s']) : undefined,
  dirty: commit ? git(['status', '--porcelain', '--untracked-files=no']).length > 0 : undefined, builtAt: Date.now() }, null, 2) + '\n');
console.log(`Channels settings client bundle built${commit ? ` from ${commit.slice(0, 7)}` : ''}.`);
