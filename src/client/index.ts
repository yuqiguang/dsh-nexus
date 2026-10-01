import type { Context } from '@deepseek-ai/cordis';
import { createElement } from 'react';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { ChannelSettings } from './ChannelSettings.js';
import { CoderSettings } from './CoderSettings.js';
import { AssistantSettings } from './AssistantSettings.js';
import { MemorySettings } from './MemorySettings.js';
import { ConnectorSettings } from './ConnectorSettings.js';
import { DocumentSettings } from './DocumentSettings.js';
import { DataSettings } from './DataSettings.js';
import { ModuleBoundary, ModuleSettings } from './ModuleSettings.js';
import styles from './styles.css';
import { applyChatFold, readChatFold } from './chatFold.js';
import { TASK_RESOURCE, TASK_TAB_ID, TASK_TAB_KIND, coderTaskPanel, coderTaskRow, taskIdOf, taskAddress } from './CoderTasks.js';

/**
 * The right sidebar and the tool-row seat, typed by hand to the few members used here: importing the types of
 * dsh-client-ui-sidebar-right and dsh-client-ui-tool makes tsc outgrow the 384 MiB heap the build runs in.
 */
interface TaskSeats {
  sidebarRight: { openResource(address: string): void };
  sidebarRightTabs: { register(definition: { id: string; kind: string; patterns: string[]; priority: 'extension'; title(address: string): string }): () => void };
  slots: { inject(name: string, register: () => () => void): unknown; register(options: { name: string; key: string }, component: unknown): () => void };
}

export const inject = ['slots'];
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const element = document.createElement('style');
    element.dataset.plugin = 'nexus-next';
    element.textContent = styles;
    document.head.append(element);
    applyChatFold(readChatFold());
    return () => { element.remove(); document.documentElement.removeAttribute('data-nexus-chat-fold'); };
  });
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-channels', order: 12, label: '渠道连接',
  }, ChannelSettings));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-coders', order: 11, label: 'Nexus 编码',
  }, ({ close }: { close: () => void }) => createElement(CoderSettings, { close, navigation: () => {
    // Public client services, read lazily so settings still work in a minimal host.
    const ui = ctx.get('uiWorkspace') as { pickDirectory(): Promise<string | null>; openWorkspace(id: string): Promise<void> } | undefined;
    const workspaces = ctx.get('workspaces') as { create(input: { path: string }): Promise<{ workspaceId: string }> } | undefined;
    const sidebar = ctx.get('sidebarRight') as TaskSeats['sidebarRight'] | undefined;
    return ui && workspaces ? { pickDirectory: () => ui.pickDirectory(), openProject: async (path: string) => {
      const workspace = await workspaces.create({ path });
      await ui.openWorkspace(workspace.workspaceId);
    }, ...(sidebar ? { openTask: (id: string) => sidebar.openResource(taskAddress(id)) } : {}) } : undefined;
  } })));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-modules', order: 13, label: 'Nexus 扩展',
  }, ModuleSettings));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-assistant', order: 14, label: '助理',
  }, AssistantSettings));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-memory', order: 15, label: '记忆',
  }, MemorySettings));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-connectors', order: 16, label: '连接器',
  }, ConnectorSettings));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-documents', order: 17, label: '文档工具',
  }, () => createElement(ModuleBoundary, { module: 'documents', children: createElement(DocumentSettings) })));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'nexus-data', order: 18, label: '数据',
  }, DataSettings));
  // The coding-task card and its right-sidebar panel wait for the sidebar; without it the settings pages above still load.
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (inner: Context) => {
    const seats = inner as unknown as TaskSeats;
    inner.effect(() => seats.sidebarRightTabs.register({ id: TASK_TAB_ID, kind: TASK_TAB_KIND, patterns: [`${TASK_RESOURCE}**`], priority: 'extension',
      title: address => `编码任务 ${taskIdOf(address)}` }));
    const openSession = (id: string) => {
      const ui = inner.get('uiWorkspace') as { openSession(id: string): void } | undefined;
      ui?.openSession(id);
    };
    seats.slots.inject('sidebar.right.pane.tab', () => seats.slots.register({ name: 'sidebar.right.pane.tab', key: TASK_TAB_ID },
      coderTaskPanel(undefined, openSession, id => seats.sidebarRight.openResource(taskAddress(id)))));
    seats.slots.inject('tool.call.toolview', () => seats.slots.register({ name: 'tool.call.toolview', key: 'coder_task' },
      coderTaskRow(address => seats.sidebarRight.openResource(address))));
  });
}
