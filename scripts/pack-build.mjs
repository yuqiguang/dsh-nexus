import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

/** Capture the build and its package metadata together, including for updater rollback. */
export async function packBuild(root, output, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error('Run the build through npm run build.');
  const stage = await mkdtemp(join(tmpdir(), 'nexus-build-package-'));
  try {
    const content = join(stage, 'package');
    await mkdir(join(content, 'dist'), { recursive: true });
    for (const name of ['src', 'client.js', 'build-info.json']) {
      await cp(join(output, name), join(content, 'dist', name), { recursive: true });
    }
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    // A local service uses the same distributable file set as a public installation.
    manifest.files = ['dist/src', 'dist/client.js', 'dist/build-info.json', 'cordis.patch.yml', 'locale',
      'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'RENAME.md', 'CONTRIBUTING.md', 'PUBLISHING.md'];
    for (const name of manifest.files.filter(name => !name.startsWith('dist/'))) {
      await cp(join(root, name), join(content, name), { recursive: true });
    }
    await writeFile(join(content, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const result = await exec(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', stage],
      { cwd: content, timeout: 60_000, maxBuffer: 1024 * 1024 });
    const packed = JSON.parse(result.stdout)[0];
    if (packed.name !== 'dsh-nexus' || packed.version !== manifest.version) throw new Error('Unexpected build package');
    // Same directory temporary file allows an atomic replacement even if tmpdir is on another volume.
    await cp(join(stage, packed.filename), join(output, 'plugin.tgz.next'));
    await rename(join(output, 'plugin.tgz.next'), join(output, 'plugin.tgz'));
  } finally { await rm(stage, { recursive: true, force: true }); }
}
