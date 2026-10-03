import type { Context } from '@deepseek-ai/cordis';
import type PluginManager from '@deepseek-ai/dsh-plugin-manager';
import type { PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager';
import type {} from '@deepseek-ai/dsh-app-boot';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ChannelError } from '../channels/types.js';
import { DshRecords } from '../dsh/records.js';
import { registerRpc } from '../dsh/rpc.js';
import { UpdatesManager, type UpdateInstaller } from './manager.js';
import { ReleasePackages, sha256, type UpdatePackage } from './package.js';

type InstallerService = Pick<PluginManager, 'listBundles' | 'installBundle' | 'cancelInstall'>;
async function installationCopy(pkg: UpdatePackage): Promise<string> {
  const bytes = await readFile(pkg.path);
  if (sha256(bytes) !== pkg.sha256) throw new ChannelError('update_checksum_invalid');
  const directory = join(dirname(pkg.path), 'requests');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Each transaction gets a durable immutable spec. Reusing the restored spec
  // makes the native manager report an ambiguous install during rollback.
  const path = join(directory, `${pkg.sha256}-${randomUUID()}.tgz`);
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); return path;
}
export function nativeInstaller(service: InstallerService, prepare = installationCopy): UpdateInstaller {
  return {
    async installed() { return (await service.listBundles()).find(bundle => bundle.name === 'dsh-nexus' && bundle.installed)?.version; },
    async install(pkg, signal) {
      if (signal.aborted) throw new ChannelError('update_cancelled');
      const path = await prepare(pkg);
      if (signal.aborted) throw new ChannelError('update_cancelled');
      const requestId = randomUUID() as PluginInstallRequestId;
      const cancel = () => { void service.cancelInstall(requestId).catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        // No removal or activation changes, and no new build-script approvals.
        const result = await service.installBundle(path, { requestId, enabled: false });
        if (result.application === 'cancelled') throw new ChannelError('update_cancelled');
        if (result.pendingBuilds?.length) throw new ChannelError('update_build_approval');
        if (result.error?.code === 'incompatible-version') throw new ChannelError('update_incompatible');
        if (result.bundle !== 'dsh-nexus' || result.application !== 'restart-required' || result.packageResult?.exitCode !== 0 || result.packageResult.timedOut) throw new ChannelError('update_install_failed');
        return 'restart-required';
      } finally { signal.removeEventListener('abort', cancel); }
    },
  };
}
export async function installUpdates(ctx: Context, options: { home: string; currentVersion: string; currentCommit?: string; dshVersion: string;
  isIdle(quiet: boolean): Promise<boolean>; waitReason?(quiet: boolean): Promise<string | undefined> }): Promise<UpdatesManager> {
  let installer: UpdateInstaller | undefined;
  const manager = new UpdatesManager({ ...options, records: new DshRecords(ctx.credentials, 'nexus-update'),
    packages: new ReleasePackages(options.home, options.dshVersion), installer: () => installer });
  await manager.load();
  // A source launcher owns its build and restart. Do not fight it or restore a removed plugin.
  ctx.inject(['pluginManager', 'profileContext'], inner => {
    if (process.platform !== 'win32' || inner.profileContext.name !== 'desktop') return;
    installer = nativeInstaller(inner.pluginManager);
    inner.effect(() => () => { installer = undefined; });
  });
  registerRpc(ctx, 'nexus-updates', ['status', 'save', 'check', 'install', 'cancel', 'rollback'], (method, payload) => manager.handle(method, payload));
  ctx.on('session/event', () => manager.activity());
  manager.start(); ctx.effect(() => () => manager.close());
  return manager;
}
