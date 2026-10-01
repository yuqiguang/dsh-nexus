import type { Connectors } from '../connectors/index.js';
import type { MemoryService, MemoryRuntime } from '../memory/index.js';

/** Minimal shared configuration for optional components; DSH owns their lifecycle. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    nexusConnectors: Connectors;
    nexusWorkspace: { readonly root: string };
    nexusMemoryData: MemoryService;
    nexusMemoryRuntime: MemoryRuntime;
  }
}
export {};
