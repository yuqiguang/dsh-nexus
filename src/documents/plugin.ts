import type { Context } from '@deepseek-ai/cordis';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import type {} from '../dsh/nexus.js';
import { registerRpc } from '../dsh/rpc.js';
import { DocumentService, type DocumentServiceDeps } from './index.js';

export const name = 'nexus-documents';
export const inject = ['nexusWorkspace', 'connection', 'tools', 'sandboxPolicy', 'systemPrompt'];

/** Optional compatibility tools. Native profile enablement is the only switch. */
export async function apply(ctx: Context): Promise<void> {
  await installDocuments(ctx, ctx.nexusWorkspace.root);
}

export async function installDocuments(ctx: Context, workspace: string,
  seams: Partial<Omit<DocumentServiceDeps, 'ctx' | 'workspace'>> = {}): Promise<DocumentService> {
  const service = new DocumentService({ ctx, workspace, managedRoot: dshHomePath('nexus-tools'), ...seams });
  await service.start();
  registerRpc(ctx, 'nexus-documents', ['list', 'detect', 'pandoc/install'], (method, payload) => service.handle(method, payload));
  return service;
}
