import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const runtimeHome = join(projectRoot, '.nexus');
/** Native reminder rows used by isolated smoke fixtures. Normal profiles use the official optional bundle. */
export const scheduleBundle = '@deepseek-ai/dsh-experimental-schedule-bundle';
export const assistantPlugins = [
  { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context', config: {} },
];

/**
 * Bring an existing profile's patch up to date, mutating and returning it. A patch DSH rewrote is YAML, not
 * the JSON this script first wrote, so it is parsed with `yaml` before it reaches here. Each rule is
 * idempotent: a profile that is already current is returned unchanged, which `setup` detects to skip the write.
 * @param patch - layers as parsed from `cordis.patch.yml`.
 * @param coderRoots - the development profile's project roots.
 */
export function backfillProfilePatch(patch, coderRoots) {
  if (!Array.isArray(patch)) return patch;
  const inserts = patch.flatMap(layer => layer.insert ?? []);
  const entry = inserts.find(item => item.id === 'nexus-channels' || item.id === 'nexus-feishu');
  if (entry?.config && !entry.config.coderRoots) { entry.config.coderRoots = coderRoots; }
  if (entry) {
    for (const component of ['documents', 'memory']) {
      const id = `nexus-${component}`;
      if (inserts.some(item => item.id === id)) continue;
      const name = entry.name?.startsWith('file:')
        ? new URL(`./${component}/plugin.js`, entry.name).href : `nexus-next/${component}`;
      patch.find(layer => Array.isArray(layer.insert)).insert.push({ id, name, disabled: true });
    }
    // The official bundle now owns these rows. Keep explicit configuration/disable overrides.
    const overrides = [];
    for (const layer of patch) {
      if (!Array.isArray(layer.insert)) continue;
      layer.insert = layer.insert.filter(item => {
        if (!assistantPlugins.some(plugin => plugin.id === item.id && plugin.name === item.name)) return true;
        const { id, name, ...settings } = item;
        if (Object.keys(settings).length) overrides.push({ id, name, ...settings });
        return false;
      });
    }
    patch.splice(1, 0, ...overrides);
  }
  return patch;
}

export async function setup() {
  const profile = join(runtimeHome, 'profiles', 'nexus');
  const workspace = join(projectRoot, 'workspace');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true });
  const files = {
    'package.json': {
      name: 'nexus-dsh-profile', private: true,
      dsh: { profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', scheduleBundle],
        patchReload: 'startup',
      } },
    },
    'cordis.patch.yml': [{ insert: [
      { id: 'nexus-channels',
        name: pathToFileURL(join(projectRoot, 'dist/src/plugin.js')).href,
        config: { workspaceRoot: workspace, configFile: join(projectRoot, '.env.local'), coderRoots: [dirname(projectRoot)] } },
    ] }],
  };
  for (const [name, data] of Object.entries(files)) {
    try {
      await writeFile(join(profile, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  // An existing profile keeps its patch; only missing pieces are back-filled (coderRoots, the native reminder plugins).
  // Parsed as YAML: from DSH 0.1.7 the profile's settings live in this file and DSH rewrites it as YAML, so the
  // JSON this script first wrote does not survive the first boot. JSON is still YAML, so a patch nothing has
  // touched reads the same.
  const patchPath = join(profile, 'cordis.patch.yml');
  const before = await readFile(patchPath, 'utf8');
  const patch = backfillProfilePatch(parse(before) ?? [], [dirname(projectRoot)]);
  const after = JSON.stringify(patch, null, 2) + '\n';
  if (after !== before) await writeFile(patchPath, after, { mode: 0o600 });
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  if (!manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app')) {
    throw new Error('The existing nexus profile does not include the official DSH Web application.');
  }
  if (!manifest.dsh.profile.bundles.includes(scheduleBundle)) {
    manifest.dsh.profile.bundles.push(scheduleBundle);
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  }
  return { projectRoot, runtimeHome, workspace };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await setup();
  console.log('Nexus profile ready. Run npm run build, then npm start.');
}
