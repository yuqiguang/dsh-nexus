/** Minimal shared configuration for optional components; DSH owns their lifecycle. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    nexusWorkspace: { readonly root: string };
  }
}
export {};
