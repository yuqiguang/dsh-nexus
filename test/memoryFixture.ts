import { memoryDomain, type MemoryDomain, type MemoryDomainOpener, type MemoryPolicy } from '../src/memory/store.js';

/** In-memory stand-in for the native storage domain, with the same table and global semantics. */
export function fakeMemoryDomain(policy?: MemoryPolicy): { opener: MemoryDomainOpener; tables: Map<string, Map<string, unknown>> } {
  const tables = new Map<string, Map<string, unknown>>();
  const domains = new Map<string, MemoryDomain>();
  const opener: MemoryDomainOpener = { async open(spec) {
    if (domains.has(spec.name)) return domains.get(spec.name)!;
    const local = spec.name === memoryDomain.name ? tables : new Map<string, Map<string, unknown>>();
    let global: MemoryPolicy = structuredClone(policy ?? spec.global.initial);
    if (policy && spec.name !== memoryDomain.name) global.scopeVersion = 1;
    const tableOf = (name: string) => {
      if (!local.has(name)) local.set(name, new Map());
      const records = local.get(name)!;
      return { get: (key: string) => records.get(key), entries: () => [...records.entries()][Symbol.iterator](), keys: () => [...records.keys()][Symbol.iterator](),
        get size() { return records.size; }, async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
        async delete(key: string) { return records.delete(key); },
        async update(key: string, fn: (current: unknown) => unknown) { const next = structuredClone(fn(records.get(key))); records.set(key, next); return next; } };
    };
    const domain = { name: spec.name, global: { get: () => global, async set(value: MemoryPolicy) { global = structuredClone(value); } }, table: tableOf, async close() {} } as unknown as MemoryDomain;
    domains.set(spec.name, domain); return domain;
  } };
  return { opener, tables };
}
