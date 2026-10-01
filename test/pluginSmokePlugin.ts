/** Installed tarball and desktop-style Fetch carrier; no real channel or model calls. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-modules';
import type {} from '@deepseek-ai/dsh-client-connection';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { until } from './helpers.js';

export const name = 'nexus-plugin-package-smoke';
export const inject = ['connection', 'clientModules', 'credentials'];

export function apply(ctx: Context, config: { phase: number; triggerFile: string; reportFile: string; packageDir: string }): void {
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true; clearInterval(timer);
      void run().catch(async error => { await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error) })); });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));
  console.log('Nexus package fixture ready.');

  async function run() {
    const carrier = ctx.connection.createSharedFetchHandler('/api');
    async function request(method: string, payload: unknown = {}) {
      return carrier.fetch(new Request(`dsh-app://dsh/api/nexus-channels/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'package-smoke', method, payload }),
      }));
    }
    const checks: string[] = [];
    const coderRequest = (method: string) => carrier.fetch(new Request(`dsh-app://dsh/api/nexus-coders/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'coders-smoke', method, payload: {} }) }));
    if (config.phase === 10) {
      assert.equal((await request('list')).status, 404);
      assert.equal((await coderRequest('list')).status, 404);
      assert.equal(ctx.clientModules.clientPath('nexus-next'), undefined);
      const saved = await ctx.credentials.readRecord(credentialKey('nexus-channels', 'feishu'));
      assert.ok(saved?.kind === 'grant' && (saved.payload as { enabled?: boolean }).enabled === false);
      checks.push('uninstall_removes_api', 'uninstall_removes_client', 'uninstall_preserves_credentials');
    } else {
      await until(async () => (await request('list')).status === 200, 'installed bundle did not activate', 10_000);
      const client = ctx.clientModules.clientPath('nexus-next');
      assert.ok(client);
      assert.ok(realpathSync(client).startsWith(realpathSync(config.packageDir) + sep), 'client must come from the installed tarball');
      const installed = createRequire(client);
      const host = createRequire(import.meta.url);
      for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-schedule', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-client-connection', 'react']) {
        assert.equal(realpathSync(installed.resolve(name)), realpathSync(host.resolve(name)), `${name} must use the host module instance`);
      }
      const entry = ctx.clientModules.graph().entries.find(item => item.id === 'nexus-next');
      assert.ok(entry);
      const bundle = await ctx.clientModules.fetchBundle(new Request(new URL(entry.url, 'dsh-app://dsh')));
      assert.equal(bundle.status, 200);
      assert.ok((await bundle.text()).includes('settings.section'), 'packaged script must register the settings entry');
      const capabilities = () => carrier.fetch(new Request('dsh-app://dsh/api/nexus-data/capabilities'));
      await until(async () => (await capabilities()).status === 200, 'data capability route missing', 10_000);
      assert.deepEqual(await (await capabilities()).json(), { importEnabled: false });
      const upload = await carrier.fetch(new Request('dsh-app://dsh/api/nexus-data/import', {
        method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: 'fixture' }));
      assert.equal(upload.status, 409, 'installed plugins cannot stage an import without a launcher');
      checks.push('installed_import_refused_without_launcher');
      let result = await (await request('list')).json();
      assert.equal(result.result.ok, true);
      assert.ok(result.result.value.connections.every((item: { enabled: boolean }) => !item.enabled));
      if (config.phase === 7) {
        const response = await request('save', { channel: 'feishu', revision: 0, connect: false,
          config: { accountId: 'cli_0123456789abcdef', ownerId: 'ou_package_fixture', secret: 'package-secret-fixture' } });
        assert.equal(response.status, 200);
        result = await response.json();
        assert.equal(result.result.ok, true);
        assert.ok(!JSON.stringify(result).includes('package-secret-fixture'));
        const codersResponse = await coderRequest('list');
        assert.equal(codersResponse.status, 200);
        const coders = await codersResponse.json();
        assert.equal(coders.result.ok, true, coders.result.error?.code);
        // The system source depends on the machine; a fresh runtime never has a managed install.
        assert.deepEqual([coders.result.value.claude.managed.installed, coders.result.value.codex.managed.installed], [false, false]);
        assert.equal(coders.result.value.settings.revision, 0);
        checks.push('tarball_bundle_activates', 'host_module_identity', 'packaged_client_loads', 'packaged_settings_save_redacted', 'packaged_coder_settings_route');
      } else {
        assert.equal(result.result.value.connections.find((item: { channel: string }) => item.channel === 'feishu').revision, 1);
        checks.push(config.phase === 9 ? 'desktop_carrier_settings_restored' : 'installed_plugin_restart_restores_settings');
      }
      if (config.phase === 9) {
        assert.equal(ctx.get('webServer'), undefined);
        checks.push('desktop_carrier_no_webserver', 'desktop_carrier_client_bundle');
      }
    }
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, checks }, null, 2));
  }
}
