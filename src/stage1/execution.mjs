import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fail } from '../safety.mjs';
import { z } from 'zod';

export const controlDiagnostic = z.object({
  threadId: z.string().uuid(), expectedCwd: z.string().max(512), observedCwd: z.string().max(512),
  reason: z.enum(['CWD_DRIFT', 'CWD_UNAVAILABLE']), controlAllowed: z.literal(false),
  execution: z.object({ host: z.string().max(200), connectorSource: z.string().max(512),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), pid: z.number().int().positive(),
    nativeExecutionVerification: z.literal('selectionOnly'), bootId: z.string().uuid().nullable().optional() }).strict(),
}).strict();

// Identity of the connector process, not an attestation of every native process.
export async function executionIdentity() {
  const connectorSource = await realpath(fileURLToPath(new URL('../..', import.meta.url)));
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(name);
      else fail('UNSAFE_SOURCE_TREE');
    }
  }
  await visit(path.join(connectorSource, 'src'));
  const source = createHash('sha256');
  for (const file of files.sort()) source.update(JSON.stringify([path.relative(connectorSource, file),
    createHash('sha256').update(await readFile(file)).digest('hex')]));
  const bootId = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(value => value.trim()).catch(() => null);
  return Object.freeze({ host: hostname(), connectorSource, sourceSha256: source.digest('hex'),
    bootId: z.string().uuid().safeParse(bootId).success ? bootId : null,
    pid: process.pid, nativeExecutionVerification: 'selectionOnly' });
}

// A configured local dispatch from a previous host boot cannot still execute
// locally. This says nothing about its result or external side effects.
export function localLifetimeEnded(op, execution) {
  const binding = op?.dispatchBinding;
  return binding?.host === execution?.host && binding?.nativeExecutionVerification === 'selectionOnly' &&
    z.string().uuid().safeParse(binding.bootId).success && z.string().uuid().safeParse(execution?.bootId).success &&
    binding.bootId.toLowerCase() !== execution.bootId.toLowerCase();
}

export async function requireLocalExecution(thread, scope, expectedCwd) {
  const selections = thread?.environments;
  if (!Array.isArray(selections) || selections.length !== 1 || selections[0]?.environmentId !== 'local' ||
      selections[0].cwd !== expectedCwd || await scope.cwd(selections[0].cwd).catch(() => null) !== expectedCwd) {
    fail('EXECUTION_ENVIRONMENT_UNVERIFIED');
  }
}

export function operationExecution(op, history, receipt) {
  if (['rejected', 'notDispatched'].includes(op.phase)) return 'notDispatched';
  if (op.phase !== 'accepted' || !op.turnId) return 'unverified';
  const matches = history?.data.filter(turn => turn.id === op.turnId) ?? [];
  if (matches.length > 1) return 'unverified';
  const turn = matches[0] ?? receipt;
  return ({ inProgress: 'running', completed: 'completed', failed: 'failed', interrupted: 'interrupted' })[turn?.status] ?? 'unverified';
}
