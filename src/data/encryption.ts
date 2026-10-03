import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const MAGIC = Buffer.from('NEXUS-ENC-1\n');
export const ENCRYPTION_OVERHEAD = MAGIC.length + 16 + 12 + 16;
export const encryptedArchive = (bytes: Buffer) => bytes.subarray(0, MAGIC.length).equals(MAGIC);

export async function encryptArchive(bytes: Buffer, password: string): Promise<Buffer> {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await derive(password, salt, 32) as Buffer;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(MAGIC);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
  } finally { key.fill(0); }
}

export async function decryptArchive(bytes: Buffer, password: string): Promise<Buffer> {
  const offset = MAGIC.length;
  if (bytes.length < ENCRYPTION_OVERHEAD) throw new Error('archive_decrypt_failed');
  const key = await derive(password, bytes.subarray(offset, offset + 16), 32) as Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(offset + 16, offset + 28));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(bytes.subarray(offset + 28, offset + 44));
    return Buffer.concat([decipher.update(bytes.subarray(ENCRYPTION_OVERHEAD)), decipher.final()]);
  } finally { key.fill(0); }
}
