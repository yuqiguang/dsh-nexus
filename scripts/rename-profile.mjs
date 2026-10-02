import { isMap, isSeq, parseDocument } from 'yaml';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = new Map([
  ['nexus-channels', 'nexus-next'],
  ['nexus-memory', 'nexus-next/memory'],
  ['nexus-mail', 'nexus-next/mail'],
  ['nexus-agenda', 'nexus-next/agenda'],
]);

export function renamedModuleName(id, name) {
  const old = modules.get(id);
  return old && name === old ? old.replace('nexus-next', 'dsh-nexus') : name;
}

/** Rename only known module-qualified rows. Never visit user configuration or data. */
export function renameProfilePatch(source) {
  const document = parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  });
  if (document.errors.length || !isSeq(document.contents)) throw new Error('invalid_profile_patch');
  let changed = 0;
  const change = row => {
    if (!isMap(row)) return;
    const name = row.get('name');
    const next = renamedModuleName(row.get('id'), name);
    if (next !== name) {
      row.set('name', next);
      changed++;
    }
  };
  for (const row of document.contents.items) {
    if (!isMap(row)) continue;
    const insert = row.get('insert');
    if (isSeq(insert)) insert.items.forEach(change);
    else change(row);
  }
  return { changed, text: changed ? String(document) : source };
}

/** Offline profile maintenance. The DSH host must be stopped before applying. */
export async function renameProfile(directory, apply = false) {
  const file = join(resolve(directory), 'cordis.patch.yml');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('invalid_profile_patch_file');
  const source = await readFile(file, 'utf8');
  const result = renameProfilePatch(source);
  if (!apply || !result.changed) return { changed: result.changed, applied: false };
  const suffix = randomUUID();
  const backup = `${file}.before-dsh-nexus-${suffix}`;
  const temporary = `${file}.${suffix}.tmp`;
  // The backup stays beside the original profile. It is never printed or uploaded.
  await writeFile(backup, source, { flag: 'wx', mode: 0o600 });
  if (await readFile(file, 'utf8') !== source) throw new Error('profile_changed_during_migration');
  await writeFile(temporary, result.text, { flag: 'wx', mode: info.mode & 0o777 });
  await rename(temporary, file);
  return { changed: result.changed, applied: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !['--check', '--apply'].includes(args[0])) {
    console.error('Usage: node scripts/rename-profile.mjs --check|--apply <profile-directory> (stop DSH before --apply)');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await renameProfile(args[1], args[0] === '--apply'))); }
    catch { console.error('Profile rename failed. Check the patch syntax, file permissions, and that DSH is stopped.'); process.exitCode = 1; }
  }
}
