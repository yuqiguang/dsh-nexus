/** Plugin-owned, versioned records. The storage adapter owns serialization and atomic writes. */
export interface Records {
  read(key: string): Promise<unknown>;
  modify(key: string, update: (current: unknown) => Promise<unknown>): Promise<unknown>;
  /** Every record whose key starts with `prefix`; absent where the store cannot enumerate. */
  list?(prefix: string): Promise<{ key: string; value: unknown }[]>;
}
