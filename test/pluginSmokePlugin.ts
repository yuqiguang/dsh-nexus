/** Installed tarball and desktop-style Fetch carrier; no real channel or model calls. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-modules';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-plugin-manager';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { until } from './helpers.js';

export const name = 'nexus-plugin-package-smoke';
export const inject = ['connection', 'clientModules', 'credentials', 'tools', 'pluginManager'];

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
    const rpc = async (family: string, method: string, payload: unknown = {}) => {
      const response = await carrier.fetch(new Request(`dsh-app://dsh/api/nexus-${family}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'modules-smoke', method, payload }) }));
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const legacyModules = { version: 4, revision: 2, enabled: { agenda: true } };
    const agendaTools = ['calendar', 'todo'];
    const memoryTools = ['memory_recall', 'memory_remember', 'memory_forget'];
    const documentTools = ['doc_read', 'doc_create', 'doc_edit', 'doc_convert'];
    const documentStatus = () => carrier.fetch(new Request('dsh-app://dsh/api/nexus-documents/list', { method: 'POST' }));
    const coderRequest = (method: string, payload: unknown = {}) => carrier.fetch(new Request(`dsh-app://dsh/api/nexus-coders/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'coders-smoke', method, payload }) }));
    if (config.phase === 10) {
      assert.equal((await request('list')).status, 404);
      assert.equal((await coderRequest('list')).status, 404);
      assert.equal((await carrier.fetch(new Request('dsh-app://dsh/api/nexus-modules/list', { method: 'POST' }))).status, 404);
      assert.equal(ctx.clientModules.clientPath('nexus-next'), undefined);
      assert.equal((await documentStatus()).status, 404);
      assert.ok(documentTools.every(name => !ctx.tools.get(name)));
      assert.ok(memoryTools.every(name => !ctx.tools.get(name)));
      assert.ok(!(await ctx.pluginManager.listPlugins()).some(row => row.moduleName.startsWith('nexus-next')));
      const saved = await ctx.credentials.readRecord(credentialKey('nexus-channels', 'feishu'));
      assert.ok(saved?.kind === 'grant' && (saved.payload as { enabled?: boolean }).enabled === false);
      checks.push('uninstall_removes_api', 'uninstall_removes_client', 'uninstall_preserves_credentials');
      const modules = await ctx.credentials.readRecord(credentialKey('nexus-modules', 'settings'));
      assert.ok(modules?.kind === 'grant' && (modules.payload as { revision: number }).revision === 2);
      checks.push('uninstall_preserves_module_settings');
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
      const rows = (await ctx.pluginManager.listPlugins()).filter(row => row.moduleName === 'nexus-next' || ['nexus-next/documents', 'nexus-next/memory', 'nexus-next/mail', 'nexus-next/agenda'].includes(row.moduleName));
      assert.equal(rows.length, 5, 'bundle exposes five native components');
      const bundleInfo = (await ctx.pluginManager.listBundles()).find(item => item.name === 'nexus-next');
      assert.deepEqual(bundleInfo?.rows.map(row => row.moduleName), ['nexus-next', 'nexus-next/documents', 'nexus-next/memory', 'nexus-next/mail', 'nexus-next/agenda']);
      const agendaRow = rows.find(row => row.moduleName === 'nexus-next/agenda')!;
      assert.equal((agendaRow.meta?.title as { zh?: string })?.zh, '日历与待办');
      const mailRow = rows.find(row => row.moduleName === 'nexus-next/mail')!;
      assert.equal((mailRow.meta?.title as { zh?: string })?.zh, '邮箱');
      const memoryRow = rows.find(row => row.moduleName === 'nexus-next/memory')!;
      assert.equal((memoryRow.meta?.title as { zh?: string })?.zh, '长期记忆');
      const docRow = rows.find(row => row.moduleName === 'nexus-next/documents')!;
      assert.equal((docRow.meta?.title as { zh?: string })?.zh, '文档兼容工具');
      assert.doesNotMatch(await readFile(client, 'utf8'), /nexus-modules|Nexus 扩展/);
      for (const method of ['list', 'save']) {
        assert.equal((await carrier.fetch(new Request(`dsh-app://dsh/api/nexus-modules/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'retired', method, payload: { revision: 2, enabled: { agenda: false } } }) }))).status, 404);
      }
      checks.push('legacy_module_ui_and_rpc_removed');
      assert.ok(ctx.tools.get('coder_task'), 'coding core stays available');
      assert.ok(ctx.get('schedule'), 'native reminder service stays available');
      if (config.phase === 7) {
        await ctx.credentials.modifyRecord(credentialKey('nexus-modules', 'settings'), async () => ({ kind: 'grant', payload: legacyModules }));
        assert.equal(agendaRow.enabled, false);
        assert.ok(agendaTools.every(name => !ctx.tools.get(name)));
        assert.equal((await rpc('connectors', 'list')).value.modules.agenda, false);
        assert.equal((await ctx.pluginManager.setPluginEnabled(agendaRow.entryId, true)).application, 'applied');
        assert.ok(agendaTools.every(name => ctx.tools.get(name)));
        const addedTodo = await ctx.tools.execute({ name: 'todo', callId: ToolCallId('native-agenda-fixture'),
          arguments: { action: 'add', title: 'native agenda restart fixture' }, signal: new AbortController().signal });
        assert.ok(!addedTodo.isError);
        const todo = (await rpc('connectors', 'list')).value.agenda.todos[0];
        assert.equal(todo.title, 'native agenda restart fixture');
        assert.equal((await ctx.pluginManager.setPluginEnabled(agendaRow.entryId, false)).application, 'applied');
        assert.ok(agendaTools.every(name => !ctx.tools.get(name)));
        const completed = await rpc('connectors', 'agenda/todo/done', { id: todo.id });
        assert.ok(completed.value.agenda.todos[0].doneAt);
        assert.equal((await ctx.pluginManager.setPluginEnabled(agendaRow.entryId, true)).application, 'applied');
        assert.ok((await rpc('connectors', 'list')).value.agenda.todos[0].doneAt);
        checks.push('agenda_default_off', 'agenda_native_live_toggle', 'agenda_data_management_survives_disable');
        assert.equal(mailRow.enabled, false);
        assert.equal((await rpc('connectors', 'list')).value.modules.mail, false);
        assert.equal((await rpc('connectors', 'mail/test')).error.code, 'module_disabled');
        assert.equal((await ctx.pluginManager.setPluginEnabled(mailRow.entryId, true)).application, 'applied');
        assert.equal((await rpc('connectors', 'list')).value.modules.mail, true);
        assert.equal((await rpc('connectors', 'list')).value.mail.phase, 'disabled', 'an enabled component without an account must not claim a connection');
        assert.ok(!ctx.tools.get('mail_send'));
        assert.equal((await ctx.pluginManager.setPluginEnabled(mailRow.entryId, false)).application, 'applied');
        assert.equal((await rpc('connectors', 'list')).value.modules.mail, false);
        assert.equal((await ctx.pluginManager.setPluginEnabled(mailRow.entryId, true)).application, 'applied');
        checks.push('mail_default_off', 'mail_native_live_toggle', 'mail_component_requires_configured_account');
        assert.equal(docRow.enabled, false);
        assert.ok(documentTools.every(name => !ctx.tools.get(name)));
        assert.equal((await documentStatus()).status, 404);
        const enabledDocs = await ctx.pluginManager.setPluginEnabled(docRow.entryId, true);
        assert.equal(enabledDocs.application, 'applied');
        await until(() => documentTools.every(name => !!ctx.tools.get(name)), 'document component did not activate');
        assert.equal((await rpc('documents', 'list')).ok, true);
        checks.push('five_localized_native_components', 'documents_default_off', 'native_live_enable');
        assert.ok(agendaTools.every(name => ctx.tools.get(name)), 'native agenda remains independent');
        assert.equal(memoryRow.enabled, false);
        assert.ok(memoryTools.every(name => !ctx.tools.get(name)));
        const memory = await rpc('memory', 'event/add', { text: 'module restart fixture' });
        assert.equal(memory.ok, true);
        assert.equal(memory.value.moduleEnabled, false);
        assert.equal((await ctx.pluginManager.setPluginEnabled(memoryRow.entryId, true)).application, 'applied');
        await until(() => memoryTools.every(name => !!ctx.tools.get(name)), 'memory did not activate');
        assert.equal((await rpc('memory', 'list')).value.moduleEnabled, true);
        assert.equal((await ctx.pluginManager.setPluginEnabled(memoryRow.entryId, false)).application, 'applied');
        assert.ok(memoryTools.every(name => !ctx.tools.get(name)));
        const policy = await rpc('memory', 'policy', { remember: 'off', inject: false });
        assert.equal(policy.ok, true, 'data remains writable while memory runtime is absent');
        assert.equal(policy.value.moduleEnabled, false);
        assert.equal((await ctx.pluginManager.setPluginEnabled(memoryRow.entryId, true)).application, 'applied');
        assert.ok(memoryTools.every(name => !!ctx.tools.get(name)));
        const restoredMemory = await rpc('memory', 'export');
        assert.equal(restoredMemory.value.policy.remember, 'off');
        assert.equal(restoredMemory.value.policy.inject, false);
        assert.match(restoredMemory.value.exportJson, /module restart fixture/);
        checks.push('memory_default_off_with_data_management', 'memory_live_toggle_preserves_store_and_policy');
      } else if (config.phase === 8) {
        assert.equal(mailRow.enabled, true);
        assert.equal((await rpc('connectors', 'list')).value.modules.mail, true);
        assert.equal((await ctx.pluginManager.setPluginEnabled(mailRow.entryId, false)).application, 'applied');
        assert.equal((await rpc('connectors', 'list')).value.modules.mail, false);
        checks.push('mail_enable_survives_restart', 'mail_live_disable_keeps_data_routes');
        assert.equal(agendaRow.enabled, true);
        assert.ok(agendaTools.every(name => ctx.tools.get(name)));
        assert.equal((await rpc('connectors', 'list')).value.agenda.todos[0].title, 'native agenda restart fixture');
        assert.ok((await rpc('connectors', 'list')).value.agenda.todos[0].doneAt);
        assert.equal((await ctx.pluginManager.setPluginEnabled(agendaRow.entryId, false)).application, 'applied');
        assert.ok(agendaTools.every(name => !ctx.tools.get(name)));
        assert.equal((await rpc('connectors', 'list')).value.modules.agenda, false);
        checks.push('agenda_enabled_and_data_survive_restart', 'agenda_disable_keeps_data_routes');
        assert.equal(docRow.enabled, true);
        assert.equal(docRow.fiberPhase, 'active');
        assert.ok(documentTools.every(name => ctx.tools.get(name)), 'native document enablement survives legacy modules off');
        assert.equal((await rpc('documents', 'list')).ok, true);
        const disabledDocs = await ctx.pluginManager.setPluginEnabled(docRow.entryId, false);
        assert.equal(disabledDocs.application, 'applied');
        await until(() => documentTools.every(name => !ctx.tools.get(name)), 'document component did not unload');
        assert.equal((await documentStatus()).status, 404);
        checks.push('native_live_disable_removes_tools_and_rpc');
        assert.equal(memoryRow.enabled, true);
        assert.ok(memoryTools.every(name => !!ctx.tools.get(name)));
        assert.equal((await rpc('memory', 'list')).value.moduleEnabled, true);
        assert.equal((await ctx.pluginManager.setPluginEnabled(memoryRow.entryId, false)).application, 'applied');
        assert.ok(memoryTools.every(name => !ctx.tools.get(name)));
        const memory = await rpc('memory', 'export');
        assert.equal(memory.ok, true);
        assert.equal(memory.value.moduleEnabled, false);
        assert.equal(memory.value.policy.remember, 'off');
        assert.equal(memory.value.policy.inject, false);
        checks.push('memory_enable_survives_restart', 'memory_disable_keeps_management_available');
        assert.match(memory.value.exportJson, /module restart fixture/);
        const saved = await rpc('connectors', 'save', { revision: 0, config: { mail: {
          enabled: true, address: 'fixture@example.com', imapHost: '127.0.0.1', smtpHost: '127.0.0.1', password: 'fixture-secret',
        }, agenda: { enabled: true } } });
        assert.equal(saved.ok, true);
        assert.equal(saved.value.settings.mail.enabled, true, 'account settings are retained separately');
        assert.equal(saved.value.mail.phase, 'disabled');
        assert.equal(saved.value.agenda.toolsRegistered, false);
        assert.ok(!ctx.tools.get('mail_send'));
        const tested = await rpc('connectors', 'mail/test');
        assert.equal(tested.error.code, 'module_disabled');
        assert.ok(agendaTools.every(name => !ctx.tools.get(name)));
        checks.push('disabled_modules_no_tools', 'native_document_enable_restored', 'disabled_mail_cannot_connect', 'disabled_memory_export_preserved', 'coding_and_native_reminders_unchanged');
      } else if (config.phase === 9) {
        assert.equal(mailRow.enabled, false);
        assert.equal((await ctx.pluginManager.setPluginEnabled(mailRow.entryId, true)).application, 'restart-required');
        assert.equal((await rpc('connectors', 'list')).value.modules.mail, false);
        checks.push('mail_disable_survives_restart', 'mail_without_hmr_waits_for_restart');
        assert.equal(agendaRow.enabled, false);
        assert.equal((await ctx.pluginManager.setPluginEnabled(agendaRow.entryId, true)).application, 'restart-required');
        assert.ok(agendaTools.every(name => !ctx.tools.get(name)));
        assert.equal((await rpc('connectors', 'list')).value.modules.agenda, false);
        assert.equal((await rpc('connectors', 'list')).value.agenda.todos[0].title, 'native agenda restart fixture');
        checks.push('agenda_disable_survives_restart', 'agenda_without_hmr_waits_for_restart');
        assert.equal(docRow.enabled, false);
        assert.ok(documentTools.every(name => !ctx.tools.get(name)));
        assert.equal((await documentStatus()).status, 404);
        checks.push('native_document_disable_restored');
        const pendingDocs = await ctx.pluginManager.setPluginEnabled(docRow.entryId, true);
        assert.equal(pendingDocs.application, 'restart-required');
        assert.ok(documentTools.every(name => !ctx.tools.get(name)));
        checks.push('native_enable_without_hmr_waits_for_restart');
        assert.ok(agendaTools.every(name => !ctx.tools.get(name)));
        assert.ok(!ctx.tools.get('mail_send'), 'mail remains independently disabled');
        const memory = await rpc('memory', 'list');
        assert.equal(memoryRow.enabled, false);
        assert.equal(memory.value.moduleEnabled, false);
        assert.ok(memoryTools.every(name => !ctx.tools.get(name)));
        assert.equal((await ctx.pluginManager.setPluginEnabled(memoryRow.entryId, true)).application, 'restart-required');
        assert.ok(memoryTools.every(name => !ctx.tools.get(name)));
        assert.equal((await rpc('memory', 'list')).value.moduleEnabled, false);
        checks.push('memory_disable_survives_restart', 'memory_enable_without_hmr_waits_for_restart');
        assert.ok(memory.value.events.some((event: { text: string }) => event.text === 'module restart fixture'));
        const deleted = await rpc('memory', 'event/delete', { id: memory.value.events.find((event: { text: string }) => event.text === 'module restart fixture').id });
        assert.equal(deleted.ok, true);
        checks.push('reenable_restores_tools_and_memory', 'modules_independent_on_restart');
      }
      const legacyRecord = await ctx.credentials.readRecord(credentialKey('nexus-modules', 'settings'));
      assert.equal(legacyRecord?.kind, 'grant');
      assert.deepEqual(legacyRecord?.kind === 'grant' ? legacyRecord.payload : undefined, legacyModules);
      checks.push('legacy_module_preferences_untouched_and_ignored');
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
        const selected = await (await coderRequest('project/select', { revision: 0, path: config.packageDir, allow: true })).json();
        assert.equal(selected.result.ok, true, selected.result.error?.code);
        assert.equal(selected.result.value.project.path, realpathSync(config.packageDir));
        assert.equal(selected.result.value.project.allowed, true);
        assert.ok(Array.isArray(selected.result.value.workspaces));
        checks.push('packaged_project_selection_without_im');
        checks.push('tarball_bundle_activates', 'host_module_identity', 'packaged_client_loads', 'packaged_settings_save_redacted', 'packaged_coder_settings_route');
      } else {
        assert.equal(result.result.value.connections.find((item: { channel: string }) => item.channel === 'feishu').revision, 1);
        const coders = await (await coderRequest('list')).json();
        assert.equal(coders.result.ok, true, coders.result.error?.code);
        assert.equal(coders.result.value.settings.revision, 1);
        assert.equal(coders.result.value.project.path, realpathSync(config.packageDir));
        assert.equal(coders.result.value.project.allowed, true);
        checks.push('project_selection_survives_restart');
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
