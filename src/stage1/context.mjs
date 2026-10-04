import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from '../safety.mjs';

const schema = z.object({ developer: z.string().max(8000).default(''), tpm: z.string().max(8000).default('') }).strict();
export function contextDigest(context) { return createHash('sha256').update(JSON.stringify(context)).digest('hex'); }
export async function loadContext(file) {
  if (!file) return Object.freeze(schema.parse({}));
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) fail('UNSAFE_CONTEXT_FILE');
    const parsed = schema.safeParse(JSON.parse(await f.readFile('utf8')));
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data.tpm)) > 24000) fail('INVALID_CONTEXT_CONFIG');
    return Object.freeze(parsed.data);
  } finally { await f.close(); }
}
