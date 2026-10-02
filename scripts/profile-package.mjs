import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const names = new Map([
  ['nexus-channels', ['src/plugin.js', 'dsh-nexus']],
  ['nexus-memory', ['src/memory/plugin.js', 'dsh-nexus/memory']],
  ['nexus-mail', ['src/connectors/mail/plugin.js', 'dsh-nexus/mail']],
  ['nexus-agenda', ['src/connectors/agenda/plugin.js', 'dsh-nexus/agenda']],
]);

/** Keep override order and every setting; remove only this checkout's known file insertions. */
export function bundleProfilePatch(patch, root) {
  if (!Array.isArray(patch)) throw new Error('invalid_profile_patch');
  const output = [];
  let converted = 0;
  const match = row => {
    const pair = names.get(row?.id);
    if (!pair) return undefined;
    const file = pathToFileURL(join(root, 'dist', pair[0])).href;
    return row.name === file ? pair[1] : undefined;
  };
  for (const layer of structuredClone(patch)) {
    if (!layer || typeof layer !== 'object') throw new Error('invalid_profile_patch');
    if (Array.isArray(layer.insert)) {
      const kept = [];
      const overrides = [];
      for (const row of layer.insert) {
        if (names.has(row?.id) && !match(row)) throw new Error('conflicting_nexus_insertion');
        if (!match(row)) { kept.push(row); continue; }
        const { name, ...settings } = row;
        overrides.push(settings);
        converted++;
      }
      if (kept.length) output.push({ ...layer, insert: kept });
      else if (Object.keys(layer).some(key => key !== 'insert')) {
        const { insert, ...rest } = layer;
        output.push(rest);
      }
      output.push(...overrides);
    } else {
      const name = match(layer);
      output.push(name ? { ...layer, name } : layer);
    }
  }
  return { patch: output, converted };
}

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function atomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

async function installPackage({ profile, home, root, archive, offline }) {
  const { runPluginCommand } = await import('@deepseek-ai/dsh-plugin-manager/operations');
  const result = await runPluginCommand({ profile: 'nexus', dir: profile, home,
    installAnchor: require.resolve('@deepseek-ai/dsh/package.json'), cwd: root },
  ['add', archive, '--ignore-scripts', '--config.auto-install-peers=false', '--node-linker=hoisted',
    '--network-concurrency=1', '--child-concurrency=1', ...(offline ? ['--offline'] : [])],
  { execution: 'service', outputBytes: 16384, lockWaitMs: 120_000, idleTimeoutMs: 120_000,
    env: { ...process.env, DSH_HOME: home, NODE_OPTIONS: '--max-old-space-size=384' } });
  if (result.exitCode !== 0) throw new Error('nexus_package_install_failed');
}

/** Called by the source launcher before the host starts. No sessions or credentials are opened. */
export async function ensureProfilePackage({ root, home, offline = false, install = installPackage }) {
  const profile = join(home, 'profiles', 'nexus');
  const patchPath = join(profile, 'cordis.patch.yml');
  const original = await readFile(patchPath, 'utf8');
  const converted = bundleProfilePatch(parse(original), root);
  const manifest = await json(join(profile, 'package.json'));
  const statePath = join(profile, '.nexus-package.json');
  const state = await json(statePath);
  const dependency = manifest?.dependencies?.['dsh-nexus'];
  // A deliberate uninstall in the manager must not be undone at the next restart.
  if (state && !dependency && !converted.converted) return { status: 'uninstalled', converted: 0 };
  const bytes = await readFile(join(root, 'dist', 'plugin.tgz'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const info = await json(join(root, 'dist', 'build-info.json'));
  if (!info || !Number.isFinite(info.builtAt)) throw new Error('missing_build_metadata');
  const installed = await json(join(profile, 'node_modules', 'dsh-nexus', 'dist', 'build-info.json'));
  const matches = state?.sha256 === sha256 && dependency && installed?.builtAt === info?.builtAt && installed?.commit === info?.commit;
  if (!matches) {
    // Each content gets an immutable spec. Reusing dist/plugin.tgz as the dependency
    // would let a package-manager cache hide a rebuild with the same package version.
    const cache = join(home, 'packages');
    const archive = join(cache, `${sha256}.tgz`);
    await mkdir(cache, { recursive: true, mode: 0o700 });
    try { await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (createHash('sha256').update(await readFile(archive)).digest('hex') !== sha256) throw new Error('corrupt_package_cache');
    }
    await install({ profile, home, root, archive, offline });
    const actual = await json(join(profile, 'node_modules', 'dsh-nexus', 'dist', 'build-info.json'));
    if (!info || actual?.builtAt !== info.builtAt || actual?.commit !== info.commit) throw new Error('installed_build_mismatch');
  }
  if (converted.converted || JSON.stringify(converted.patch) !== JSON.stringify(parse(original))) {
    if (await readFile(patchPath, 'utf8') !== original) throw new Error('profile_changed_during_install');
    // Commit only after successful installation. A failed install leaves the original file entries usable.
    await atomic(patchPath, JSON.stringify(converted.patch, null, 2) + '\n');
  }
  await atomic(statePath, JSON.stringify({ sha256, commit: info?.commit, builtAt: info?.builtAt }) + '\n');
  return { status: matches ? 'current' : 'installed', converted: converted.converted };
}
