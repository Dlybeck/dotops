import { hostname } from 'node:os';
import { readFile, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Controller } from '../src/stage1/controller.mjs';
import { Native, uuid } from '../src/stage1/native.mjs';
import { executionIdentity } from '../src/stage1/execution.mjs';
import { validateWindows } from '../src/stage1/windows.mjs';
import { UserDirectoryScope, fail, Cursors } from '../src/safety.mjs';

const reads = new Set(['thread/read', 'thread/list', 'thread/turns/list', 'thread/backgroundTerminals/list',
  'thread/goal/get', 'thread/queue/list', 'thread/items/list']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function targetJournalFingerprint(state, threadId) {
  const record = state.threads?.[threadId];
  const operations = Object.fromEntries(Object.entries(state.operations ?? {}).filter(([id, op]) =>
    op.threadId === threadId || [record?.createdBy, record?.adoptedBy].includes(id)));
  const windows = Object.fromEntries(Object.entries(state.taskWindows ?? {}).filter(([, window]) => window.threadId === threadId));
  return hash(JSON.stringify({ version: state.version, liveTurns: state.liveTurns, record, operations, windows }));
}

export async function readOnlyPreflight({ state, backend, threadId, expectedCwd, expectedHost, stopAt }) {
  if (expectedHost !== hostname()) fail('HOST_MISMATCH');
  if (!uuid.safeParse(threadId).success || state.threads?.[threadId]?.cwd !== expectedCwd) fail('TARGET_MISMATCH');
  const copy = structuredClone(state); validateWindows(copy);
  const scope = new UserDirectoryScope();
  if (await scope.cwd(expectedCwd) !== expectedCwd) fail('TARGET_MISMATCH');
  const known = new Set([threadId]), counts = {};
  const c = Object.create(Controller.prototype);
  Object.assign(c, { expanded: true, evidenceKey: randomBytes(32), scope, controlScope: scope, execution: await executionIdentity(),
    now: () => Math.max(Date.now(), copy.clockFloor ?? 0), questions: new Map(), localRequests: new Map(), deferredRequests: new Map(),
    nativeReviews: new Map(), observedUsage: new Map(), statusCursors: new Cursors(), persistenceRetries: new Map(), context: { developer: '', tpm: '' } });
  // Controller reconciliation updates this in-memory copy only. Never acquire
  // the live journal's writer lock, start its pump or subscribe/resume a thread.
  c.store = { state: copy, tail: Promise.resolve(), async update(fn) {
    const next = structuredClone(this.state); fn(next); this.state = next;
  } };
  c.native = { get epoch() { return backend.epoch; }, get socket() { return backend.socket; }, async request(method, params) {
    if (!Number.isSafeInteger(stopAt) || Date.now() >= stopAt) fail('PREFLIGHT_DEADLINE_EXPIRED');
    if (!reads.has(method) || method === 'thread/list' && params.ancestorThreadId !== threadId ||
      params.threadId && !known.has(params.threadId)) fail('FORBIDDEN_PREFLIGHT_RPC');
    counts[method] = (counts[method] ?? 0) + 1;
    const result = await backend.request(method, params);
    if (method === 'thread/list') for (const node of result.data ?? []) if (uuid.safeParse(node?.id).success) known.add(node.id);
    return result;
  } };
  const status = await c.status(threadId);
  const reasons = [...status.admission.reasons];
  if (!status.terminalInventoryComplete || status.nativeTrackedTerminals !== 0) reasons.push('NATIVE_PROCESSES_UNVERIFIED');
  if (Date.now() >= stopAt) reasons.push('PREFLIGHT_DEADLINE_EXPIRED');
  const { assistantText, ...turn } = status.turn ?? {};
  return { observedAt: new Date().toISOString(), expectedHost, expectedCwd, candidateReader: c.execution,
    targetThreadId: threadId, readyForDeploymentReview: reasons.length === 0, blockers: [...new Set(reasons)],
    nativeMutations: 0, journalWrites: 0, nativeReads: counts, scope: 'Native recorded tree and tracked processes; detached OS descendants remain unverified.',
    status: { ...status, turn: status.turn ? turn : null },
    authorization: 'Read-only preflight is evidence, never deployment approval or live acceptance.' };
}

async function main() {
  const args = {}; const names = new Set(['state-file', 'thread-id', 'expected-cwd', 'expected-host', 'stop-at', 'output']);
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]?.slice(2), value = process.argv[i + 1];
    if (!process.argv[i]?.startsWith('--') || !names.has(name) || args[name] || !value) fail('INVALID_PREFLIGHT_INPUT');
    args[name] = value;
  }
  if (Object.keys(args).length !== names.size || !args['state-file'].startsWith('/') || !args.output.startsWith('/')) fail('INVALID_PREFLIGHT_INPUT');
  const file = await open(args['state-file'], constants.O_RDONLY | constants.O_NOFOLLOW);
  let before;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 2 * 1024 * 1024) fail('UNSAFE_STATE_FILE');
    before = await file.readFile('utf8');
  } finally { await file.close(); }
  const native = new Native({ timeoutMs: 4000 });
  let receipt;
  try { receipt = await readOnlyPreflight({ state: JSON.parse(before), backend: native, threadId: args['thread-id'],
    expectedCwd: args['expected-cwd'], expectedHost: args['expected-host'], stopAt: Date.parse(args['stop-at']) }); }
  catch (error) { receipt = { observedAt: new Date().toISOString(), readyForDeploymentReview: false,
    blockers: [error.code ?? 'PREFLIGHT_FAILED'], nativeMutations: 0, journalWrites: 0 }; }
  finally { native.close(); }
  const after = await readFile(args['state-file'], 'utf8');
  receipt.journalSnapshotUnchanged = hash(before) === hash(after);
  receipt.targetJournalSnapshotUnchanged = targetJournalFingerprint(JSON.parse(before), args['thread-id']) ===
    targetJournalFingerprint(JSON.parse(after), args['thread-id']);
  if (!receipt.targetJournalSnapshotUnchanged) {
    receipt.readyForDeploymentReview = false; receipt.blockers.push('TARGET_JOURNAL_CHANGED_DURING_PREFLIGHT');
  }
  await writeFile(args.output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ readyForDeploymentReview: receipt.readyForDeploymentReview, blockers: receipt.blockers,
    nativeMutations: 0, journalWrites: 0, receipt: args.output }));
  if (!receipt.readyForDeploymentReview) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.code ?? 'PREFLIGHT_FAILED'); process.exitCode = 1; });
}
