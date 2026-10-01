import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { OutboundFile } from './protocol.js';

export const MAX_DELIVERY_BYTES = 10 * 1024 * 1024;

/** Explicit `present` declarations grant delivery only inside the channel workspace. */
export async function readDelivery(workspace: string, path: string): Promise<OutboundFile> {
  const root = await realpath(workspace);
  const target = await realpath(resolve(root, path));
  const inside = relative(root, target);
  if (!inside || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) {
    throw new Error('delivery_outside_workspace');
  }
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_DELIVERY_BYTES) throw new Error('delivery_file_unsupported');
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = file.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_DELIVERY_BYTES) throw new Error('delivery_file_too_large');
      chunks.push(chunk as Buffer);
    }
    const after = await file.stat();
    if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) throw new Error('delivery_file_changed');
    return { name: basename(target), bytes: Buffer.concat(chunks, size), path };
  } finally {
    await file.close();
  }
}
