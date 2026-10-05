import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ProjectScope, UserDirectoryScope, SafeError, fail, safeText, Cursors } from '../safety.mjs';
import { Native, uuid } from './native.mjs';
import { Store } from './store.mjs';
import { validateWindows } from './windows.mjs';
import { loadContext, contextDigest } from './context.mjs';
import { childEvidence, childItems, mergeChildItems, verifyChildren } from './children.mjs';
import { executionIdentity, requireLocalExecution, operationExecution, localLifetimeEnded } from './execution.mjs';
import { readDescendants } from './descendants.mjs';
import { loadCompletedDescendants } from './descendant-loading.mjs';
import { skillSelection, resolveSkills, readSkills } from './skills.mjs';
import { latestAssistantExcerpt, sanitizedMessagePage } from '../history-text.mjs';
import { captureOwnedTurn, validOwnershipId } from './owned-obligations.mjs';
import { ownedScopeProof, recheckOwnedScope, requireScopeCurrent, scopeSummary, localTurnLifetimeEnded } from './owned-scope.mjs';
import { goalMetadata, goalRequestFingerprint, migrateGoalRecords } from './goal-records.mjs';
export const CONTROL_ROOT = path.join(homedir(), 'Projects/codex-dot-connector');
const HISTORY_READ_BUDGET_MS = 5000;

function acceptedSendResult(requestId, op, turnId) {
  return { requestId, threadId: op.threadId, turnId, phase: 'accepted', developerContext: !!op.developerContext,
    ...(op.skills ? { nativeSkillInputs: op.skills } : {}) };
}

function requireSkillReceiptCapacity(requestId, op) {
  if (!op.skills) return;
  // Bound the largest allowed native turn ID (including JSON escaping), before
  // dispatch. IPC wraps the receipt once; MCP returns both structured and text.
  const result = acceptedSendResult(requestId, op, '\u0000'.repeat(200));
  const text = JSON.stringify(result);
  if (Buffer.byteLength(JSON.stringify({ id: requestId, result })) > 32000 ||
      Buffer.byteLength(JSON.stringify({ structuredContent: result, content: [{ type: 'text', text }] })) > 60000)
    fail('SKILL_RECEIPT_TOO_LARGE');
}

function mergeCommandObservations(...groups) {
  const observations = new Map();
  for (const item of groups.flatMap(group => group ?? [])) if (item.type === 'commandExecution') {
    const receipt = { type: 'commandExecution', id: item.id, processId: item.processId };
    observations.set(JSON.stringify(receipt), receipt);
  }
  return [...observations.values()];
}

export const inputs = {
  codex_chat_create: z.object({ requestId: uuid, repository: z.string().min(1).max(512), title: z.string().min(1).max(160) }).strict(),
  codex_chat_adopt: z.object({ requestId: uuid, threadId: uuid, expectedCwd: z.string().min(1).max(512) }).strict(),
  codex_chat_reconcile: z.object({ requestId: uuid, threadId: uuid }).strict(),
  codex_chat_goal: z.object({ requestId: uuid, threadId: uuid, expectedGoalHash: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(['set', 'pause', 'resume', 'clear']), objective: z.string().min(1).max(16000).optional(),
    tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict(),
  codex_chat_status: z.object({ threadId: uuid, cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(10).default(10) }).strict(),
  codex_chat_skills: z.object({ threadId: uuid, cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(20).default(20), forceReload: z.boolean().default(false) }).strict(),
  codex_chat_send: z.object({ requestId: uuid, threadId: uuid, windowId: uuid.optional(), preparationId: uuid.optional(), text: z.string().min(1).max(8000), skills: z.array(skillSelection).min(1).max(16).optional(), expectedTurnId: z.string().min(1).max(200).optional(), expectedLastTurnId: z.string().min(1).max(200).nullable().optional(), acknowledgeConcurrentStartRisk: z.literal(true).optional() }).strict(),
  codex_chat_stop: z.object({ requestId: uuid, threadId: uuid, turnId: z.string().min(1).max(200) }).strict(),
  codex_chat_questions: z.object({ threadId: uuid, questionRef: uuid.optional(), cursor: z.string().min(1).max(4096).optional() }).strict(),
  codex_chat_answer: z.object({ requestId: uuid, threadId: uuid, questionRef: uuid, answers: z.record(z.string().min(1).max(100), z.array(z.string().min(1).max(2000)).min(1).max(4)).refine(x => Object.keys(x).length > 0 && Object.keys(x).length <= 5) }).strict(),
};

export class Controller {
  static async open({ stateDir, root, controlRoot = root ?? CONTROL_ROOT, socketPath, timeoutMs, accessMode = 'stage1', now, contextFile } = {}) {
    if (!['stage1', 'user-directories'].includes(accessMode)) fail('INVALID_ACCESS_MODE');
    const c = new Controller(); c.evidenceKey = randomBytes(32); c.expanded = accessMode === 'user-directories';
    c.scope = c.expanded ? new UserDirectoryScope() : new ProjectScope(root);
    c.controlScope = c.expanded ? c.scope : new ProjectScope(controlRoot);
    c.execution = await executionIdentity(); c.context = await loadContext(contextFile); c.contextHash = contextDigest(c.context);
    c.store = await Store.open(stateDir);
    try {
      validateWindows(c.store.state);
      const wallStart = Math.max(Date.now(), c.store.state.clockFloor ?? 0), monotonicStart = performance.now();
      c.now = now ?? (() => Math.max(Date.now(), wallStart + Math.floor(performance.now() - monotonicStart), c.store.state.clockFloor ?? 0));
      c.historyReads = new AsyncLocalStorage();
      c.native = new Native({ socketPath, timeoutMs }); c.jobs = new Map(); c.chatJobs = new Map(); c.completionJobs = new Map(); c.subscribed = new Map(); c.descendantSubscriptions = new Map(); c.closing = false; c.questions = new Map(); c.localRequests = new Map(); c.deferredRequests = new Map();
      c.statusCursors = new Cursors(); c.observedUsage = new Map(); c.persistenceRetries = new Map(); c.nativeReviews = new Map(); c.native.now = c.now;
      c.store.onLost = () => { c.failed = true; c.native.close(); };
      c.native.on('event', event => c.historyReads.run(undefined, () => { try { c.event(event); } catch { /* Malformed notifications never grant control. */ } })); c.native.on('disconnect', () => { c.questions.clear(); c.localRequests.clear(); c.deferredRequests.clear(); c.nativeReviews.clear(); });
      await c.store.update(s => { s.ownedContinuationKey ??= randomBytes(32).toString('hex'); migrateGoalRecords(s);
        for (const op of Object.values(s.operations)) if (op.phase === 'dispatching') op.phase = 'unknown'; });
      return c;
    } catch (e) { c.native?.close(); await c.store.close(); throw e; }
  }
  async call(name, raw) {
    // All history traversal/repair in one control request shares a time budget
    // below the IPC reply timeout. Concurrent requests and later native events
    // must not inherit one another's deadlines.
    return this.historyReads.run(this.now() + HISTORY_READ_BUDGET_MS, () => this.callWithHistoryBudget(name, raw));
  }
  async callWithHistoryBudget(name, raw) {
    if (this.failed) fail('STATE_LOCK_LOST');
    if (this.closing) fail('WATCHDOG_UNAVAILABLE');
    const parsed = inputs[name]?.safeParse(raw); if (!parsed?.success) fail('INVALID_INPUT'); const args = parsed.data;
    if (name === 'codex_chat_adopt' && !this.expanded) fail('EXPANDED_ACCESS_DISABLED');
    if (name === 'codex_chat_status') return this.status(args.threadId, args);
    if (name === 'codex_chat_skills') return this.listSkills(args);
    if (name === 'codex_chat_questions') return this.listQuestions(args.threadId, args);
    const digest = createHash('sha256').update(JSON.stringify([name, args])).digest('hex');
    const fingerprint = name === 'codex_chat_goal' ? goalRequestFingerprint(this.store.state.ownedContinuationKey, digest) : digest;
    const old = this.store.state.operations[args.requestId];
    if (old && old.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT');
    if (this.jobs.has(args.requestId)) { const job = this.jobs.get(args.requestId); if (job.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT'); return job.promise; }
    if (old?.kind === 'preparation') return { requestId: args.requestId, preparationId: args.requestId, threadId: old.threadId, phase: 'prepared', delivery: 'notAttempted', modelTurnStarted: false, tpmContext: old.contextHash === this.contextHash ? this.context.tpm : '', consumedBy: old.consumedBy ?? null, notice: 'Review before sending; use a new requestId and this preparationId. Same text is allowed.' };
    if (old) return old.result ?? { requestId: args.requestId, phase: old.phase, threadId: old.threadId ?? null };
    const job = name === 'codex_chat_create' ? this.create(args, fingerprint) : this.serial(args.threadId, () => name === 'codex_chat_adopt' ? this.adopt(args, fingerprint) : name === 'codex_chat_send' ? this.send(args, fingerprint) : name === 'codex_chat_answer' ? this.answer(args, fingerprint) : name === 'codex_chat_goal' ? this.goalControl(args, fingerprint) : name === 'codex_chat_reconcile' ? this.reconcileLoadedWork(args, fingerprint) : this.stop(args, fingerprint)); this.jobs.set(args.requestId, { fingerprint, promise: job });
    try { return await job; } finally { this.jobs.delete(args.requestId); }
  }
  async serial(threadId, fn) {
    const previous = this.chatJobs.get(threadId) ?? Promise.resolve(); const job = previous.catch(() => {}).then(fn); this.chatJobs.set(threadId, job);
    try { return await job; } finally { if (this.chatJobs.get(threadId) === job) this.chatJobs.delete(threadId); }
  }
  async listSkills({ threadId, cursor, limit, forceReload }) {
    const thread = await this.owned(threadId);
    const catalog = await readSkills(this.native, thread.cwd, forceReload);
    await this.owned(threadId);
    const binding = JSON.stringify(['skills', threadId, thread.cwd]);
    const position = this.statusCursors.decode(cursor, binding), hash = this.goalHash(catalog);
    if (position && position.hash !== hash) fail('SKILLS_CHANGED');
    const offset = position?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > catalog.skills.length) fail('INVALID_CURSOR');
    const result = { threadId, cwd: thread.cwd, skills: [], skillCount: catalog.skills.length,
      catalogErrorCount: catalog.errorCount, nextCursor: null,
      invocation: 'Pass exact name/path pairs in codex_chat_send.skills; literal slash text is not a native skill selection.' };
    let next = offset;
    for (const skill of catalog.skills.slice(offset, offset + limit)) {
      const description = safeText(skill.description, 600);
      const entry = { name: skill.name, path: skill.path, enabled: skill.enabled,
        description: description.text, descriptionTruncated: description.truncated };
      result.skills.push(entry);
      if (Buffer.byteLength(JSON.stringify(result)) > 24000 && result.skills.length > 1) { result.skills.pop(); break; }
      next++;
    }
    result.nextCursor = next < catalog.skills.length ? this.statusCursors.encode(binding, { hash, offset: next }) : null;
    return result;
  }
  async create(args, fingerprint) {
    const cwd = await this.scope.directory(args.repository);
    await this.controlScope.cwd(cwd);
    await this.store.update(s => { s.operations[args.requestId] = { fingerprint, kind: 'create', phase: 'dispatching', cwd }; });
    try {
      // Installed app-server supports a persisted legacy rollout for blank
      // chats; its default paginated creation can lack a source rollout.
      const { thread } = await this.native.request('thread/start', { cwd, historyMode: 'legacy' });
      if (!uuid.safeParse(thread?.id).success || await this.scope.cwd(thread.cwd) !== cwd || thread.parentThreadId) fail('INVALID_BACKEND_RESPONSE');
      await this.store.update(s => { s.threads[thread.id] = { cwd, createdBy: args.requestId }; s.operations[args.requestId].threadId = thread.id; }); this.subscribed.set(thread.id, this.native.epoch);
      await this.native.request('thread/name/set', { threadId: thread.id, name: args.title });
      // Native creation can acknowledge a blank chat whose persisted lineage is
      // unavailable. Do not present that acknowledgement as send-ready history.
      if (this.expanded) await this.startSnapshot({ threadId: thread.id, expectedLastTurnId: null });
      const result = { requestId: args.requestId, phase: 'accepted', threadId: thread.id, cwd, title: args.title, modelTurnStarted: false };
      await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: 'accepted', result }); }); return result;
    } catch (e) {
      const result = { requestId: args.requestId, phase: 'unknown', threadId: this.store.state.operations[args.requestId].threadId ?? null, code: e instanceof SafeError ? e.code : 'CONTROL_FAILED', retry: 'Do not resend with a new request ID.' };
      await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: 'unknown', result }); }); return result;
    }
  }
  async owned(threadId) {
    const record = this.store.state.threads[threadId]; if (!record) fail('CHAT_NOT_OWNED');
    const { thread } = await this.readNative('thread/read', { threadId, includeTurns: false });
    if (!thread || thread.id !== threadId || thread.parentThreadId) fail('OUT_OF_SCOPE');
    const observedCwd = await this.scope.cwd(thread.cwd).catch(() => null);
    if (observedCwd !== record.cwd) throw new SafeError('OUT_OF_SCOPE', { threadId, expectedCwd: record.cwd,
      observedCwd: safeText(thread.cwd, 512).text, reason: observedCwd ? 'CWD_DRIFT' : 'CWD_UNAVAILABLE',
      controlAllowed: false, execution: this.execution });
    await this.controlScope.cwd(thread.cwd);
    return thread;
  }
  async adopt(args, fingerprint) {
    const cwd = await this.scope.cwd(args.expectedCwd);
    if (cwd !== args.expectedCwd) fail('EXPECTED_CWD_MISMATCH');
    const check = async () => {
      const { thread } = await this.native.request('thread/read', { threadId: args.threadId, includeTurns: false });
      if (thread?.id !== args.threadId || thread.parentThreadId || !['cli', 'vscode', 'exec', 'appServer'].includes(thread.source)) fail('INVALID_CHAT_TARGET');
      if (await this.scope.cwd(thread.cwd) !== cwd) fail('EXPECTED_CWD_MISMATCH');
      if (!['idle', 'notLoaded'].includes(thread.status?.type)) fail('CHAT_ACTIVE');
      return thread;
    };
    await check(); await this.requireClearWork(args.threadId); await check();
    const result = { requestId: args.requestId, phase: 'accepted', threadId: args.threadId, cwd, modelTurnStarted: false, existingTurnsAdopted: false };
    await this.store.update(s => {
      const record = s.threads[args.threadId];
      if (record && record.cwd !== cwd) fail('EXPECTED_CWD_MISMATCH');
      s.threads[args.threadId] = record ?? { cwd, adoptedBy: args.requestId };
      s.operations[args.requestId] = { fingerprint, kind: 'adopt', phase: 'accepted', threadId: args.threadId, result };
    });
    return result;
  }
  async requireClearWork(threadId) {
    const goal = await this.optional('thread/goal/get', { threadId });
    const queue = await this.optional('thread/queue/list', { threadId, limit: 1 });
    if (queue?.data?.length || queue?.nextCursor) fail('UNMANAGED_QUEUE');
    if (this.expanded && (!goal || !Array.isArray(queue?.data))) fail('WORK_STATE_UNVERIFIED');
  }
  async reconcileLoadedWork(args, fingerprint) {
    const thread = await this.owned(args.threadId);
    if (!['idle', 'notLoaded'].includes(thread.status?.type)) fail('CHAT_ACTIVE');
    await this.requireClearWork(args.threadId);
    if (!await this.optional('thread/goal/get', { threadId: args.threadId })) fail('WORK_STATE_UNVERIFIED');
    if (Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === args.threadId &&
        ['unknown', 'dispatching'].includes(op.phase) && (!this.expanded || !localLifetimeEnded(op, this.execution)))) fail('SEND_UNRESOLVED');
    await this.store.update(s => { s.operations[args.requestId] = { fingerprint, kind: 'reconcile',
      phase: 'dispatching', threadId: args.threadId }; });
    let result;
    try {
      const resumed = await this.subscribe(args.threadId);
      await requireLocalExecution(resumed.thread, this.scope, this.store.state.threads[args.threadId].cwd);
      const loaded = this.expanded ? { epoch: this.native.epoch, resumed: [] } : await loadCompletedDescendants(this, args.threadId);
      const proof = await this.preflight(args.threadId);
      if (this.native.epoch !== loaded.epoch || !this.native.socket) fail('PREVIOUS_WORK_UNVERIFIED');
      result = { requestId: args.requestId, threadId: args.threadId, phase: 'verified',
        resumedDescendants: loaded.resumed, descendantInventory: proof.descendants,
        ...(this.expanded ? { verificationScope: 'currentLocalReadiness', currentReadiness: proof.currentReadiness,
          historicalUnknowns: scopeSummary(proof).unknownOwnedObligations } : {}),
        modelTurnStarted: false, goalChanged: false, existingTurnsAdopted: false,
        snapshotOnly: true, observedAt: this.now() };
    } catch (e) {
      result = { requestId: args.requestId, threadId: args.threadId, phase: 'unverified',
        code: e instanceof SafeError ? e.code : 'CONTROL_FAILED', modelTurnStarted: false,
        goalChanged: false, subscriptionsMayHaveChanged: true,
        ...(e instanceof SafeError && e.code === 'NATIVE_SUBAGENT_RESUME_UNAVAILABLE' &&
          uuid.safeParse(e.blockedDescendantId).success ? { blockedDescendantId: e.blockedDescendantId,
          recovery: { kind: 'nativeCapabilityBlocked', terminalInventoryVerified: false, automaticRetryRecommended: false,
            notice: 'Completed history is not process proof. Native descendant attachment is unavailable; preserve the chat and use a supported native recovery before retrying.' } } : {}),
        retry: 'Inspect fresh status; this receipt is not current proof and never grants work ownership.' };
    }
    await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: result.phase, result }); });
    return result;
  }
  goalHash(goal) { return createHmac('sha256', this.evidenceKey).update(JSON.stringify(goal)).digest('hex'); }
  nativeGoalHash(goal) { return this.goalHash(goal ? { threadId: goal.threadId ?? null, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget ?? null, createdAt: goal.createdAt ?? null } : null); }
  goalOwnershipHash(goal) {
    const key = this.store.state.ownedContinuationKey;
    if (!key) return null; // Legacy continuation without a durable fingerprint stays unknown.
    return createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(goal ? {
      threadId: goal.threadId ?? null, objective: goal.objective, tokenBudget: goal.tokenBudget ?? null,
      createdAt: goal.createdAt ?? null } : null)).digest('hex');
  }
  goalPreview(goal) { return goal ? { status: goal.status, objective: safeText(goal.objective, 1000), tokenBudget: goal.tokenBudget ?? null, tokensUsed: goal.tokensUsed ?? null } : null; }
  async goalControl(args, fingerprint) {
    await this.owned(args.threadId);
    const observed = await this.optional('thread/goal/get', { threadId: args.threadId });
    if (!observed || this.nativeGoalHash(observed.goal) !== args.expectedGoalHash) fail('GOAL_CHANGED');
    if (args.action !== 'set' && (args.objective !== undefined || args.tokenBudget !== undefined)) fail('INVALID_INPUT');
    if (args.action === 'set' && !args.objective) fail('INVALID_INPUT');
    if (['pause', 'resume'].includes(args.action) && !observed.goal) fail('GOAL_NOT_FOUND');
    const method = args.action === 'clear' ? 'thread/goal/clear' : 'thread/goal/set';
    const params = args.action === 'set' ? { threadId: args.threadId, objective: args.objective,
      ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}) }
      : args.action === 'clear' ? { threadId: args.threadId }
      : { threadId: args.threadId, status: args.action === 'pause' ? 'paused' : 'active' };
    await this.store.update(s => { s.operations[args.requestId] = { fingerprint, goalFingerprintVersion: 1, kind: 'goal',
      phase: 'dispatching', threadId: args.threadId, action: args.action, priorGoal: goalMetadata(observed.goal), priorOwnedGoalHash: this.goalOwnershipHash(observed.goal) }; });
    let dispatched = false;
    try {
      await this.owned(args.threadId);
      const final = await this.optional('thread/goal/get', { threadId: args.threadId });
      if (!final || this.nativeGoalHash(final.goal) !== args.expectedGoalHash) fail('GOAL_CHANGED');
      dispatched = true;
      await this.native.request(method, params);
      const after = await this.optional('thread/goal/get', { threadId: args.threadId });
      const observedDesiredState = !!after && (args.action === 'clear' ? after.goal === null
        : args.action === 'set' ? after.goal?.objective === args.objective &&
          (args.tokenBudget === undefined || after.goal.tokenBudget === args.tokenBudget)
        : after.goal?.status === params.status);
      const result = { requestId: args.requestId, threadId: args.threadId, phase: 'accepted',
        nativeAcknowledged: true, observedDesiredState, goal: this.goalPreview(after?.goal), goalHash: after ? this.nativeGoalHash(after.goal) : null,
        atomicCompareAndSetAvailable: false, modelTurnStartedByConnector: false };
      await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: 'accepted', result: { ...result, goal: goalMetadata(after?.goal) },
        ownedGoalHash: observedDesiredState && after ? this.goalOwnershipHash(after.goal) : null }); });
      return result;
    } catch (e) {
      const result = { requestId: args.requestId, threadId: args.threadId, phase: dispatched ? 'unknown' : 'notDispatched',
        code: e instanceof SafeError ? e.code : 'CONTROL_FAILED', retry: 'Inspect native goal status; do not blindly replay.' };
      await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: result.phase, result }); });
      return result;
    }
  }
  async preflight(threadId) {
    await this.recoverPersistence(threadId);
    const thread = await this.owned(threadId);
    if (!['idle', 'notLoaded'].includes(thread.status?.type)) fail('CHAT_ACTIVE');
    await this.requireClearWork(threadId);
    if (this.expanded) {
      const proof = await ownedScopeProof(this, threadId);
      if (proof.targetBusy || proof.initialTargetBusy) fail('CHAT_ACTIVE');
      requireScopeCurrent(this, threadId, proof);
      return proof;
    }
    const proof = {};
    const turns = Object.values(this.store.state.operations).filter(op => op.kind === 'send' && op.threadId === threadId).map(op => op.turnId);
    if (await verifyChildren(this, threadId, turns, proof) === 'unverified' || this.persistenceRetries.has(threadId)) fail('PREVIOUS_WORK_UNVERIFIED');
    const terminals = await this.terminals(threadId);
    if (!terminals.available || !terminals.complete || terminals.data.length) fail('PREVIOUS_WORK_UNVERIFIED');
    const final = await this.owned(threadId);
    if (!['idle', 'notLoaded'].includes(final.status?.type)) fail('CHAT_ACTIVE');
    const inventory = await readDescendants(this, threadId);
    await this.store.tail;
    if (!inventory || inventory.fingerprint !== proof.descendants?.fingerprint ||
        proof.evidence !== childEvidence(this.store.state.threads[threadId]) || this.persistenceRetries.has(threadId)) fail('PREVIOUS_WORK_UNVERIFIED');
    return proof;
  }
  persistEvent(threadId, fn) {
    this.store.update(fn).catch(() => {
      const pending = this.persistenceRetries.get(threadId) ?? [];
      this.persistenceRetries.set(threadId, [...pending, fn]);
    });
  }
  async recoverPersistence(threadId) {
    await this.store.tail;
    const pending = this.persistenceRetries.get(threadId);
    if (!pending) return;
    // Replay retained observations transactionally. Contradictory identities are
    // merged conservatively by the same event handlers, never discarded.
    await this.store.update(s => { for (const fn of pending) fn(s); });
    const current = this.persistenceRetries.get(threadId);
    if (current === pending) this.persistenceRetries.delete(threadId);
    else if (current?.slice(0, pending.length).every((fn, i) => fn === pending[i])) {
      this.persistenceRetries.set(threadId, current.slice(pending.length));
    }
  }
  async prepareContext(args, fingerprint) {
    if (!this.context.tpm) {
      if (args.preparationId) fail('PREPARATION_UNAVAILABLE');
      return null;
    }
    if (args.preparationId) {
      const receipt = this.store.state.operations[args.preparationId];
      if (!receipt || receipt.kind !== 'preparation' || receipt.threadId !== args.threadId ||
          receipt.contextHash !== this.contextHash || receipt.consumedBy) fail('PREPARATION_UNAVAILABLE');
      return null;
    }
    const result = { requestId: args.requestId, preparationId: args.requestId, threadId: args.threadId,
      phase: 'prepared', delivery: 'notAttempted', modelTurnStarted: false, tpmContext: this.context.tpm,
      notice: 'Review the request against this context; revise if needed. Follow up with a new requestId and this preparationId. The same text is allowed.' };
    // Private instruction bodies are returned to the caller but never journaled.
    await this.store.update(s => { s.operations[args.requestId] = { fingerprint, kind: 'preparation',
      threadId: args.threadId, phase: 'prepared', contextHash: this.contextHash }; });
    return result;
  }
  async send(args, fingerprint) {
    const thread = await this.owned(args.threadId);
    const preparation = await this.prepareContext(args, fingerprint);
    if (preparation) return preparation;
    if (this.expanded && !args.expectedTurnId && (args.expectedLastTurnId === undefined || !args.acknowledgeConcurrentStartRisk)) fail('EXPLICIT_START_REQUIRED');
    if (Object.values(this.store.state.operations).some(op => op.threadId === args.threadId && op.kind === 'send' && ['unknown', 'dispatching'].includes(op.phase) && (!this.expanded || !localLifetimeEnded(op, this.execution)))) fail('SEND_UNRESOLVED');
    if (!args.expectedTurnId && !['idle', 'notLoaded'].includes(thread.status?.type)) fail('CHAT_ACTIVE');
    if (args.expectedTurnId) this.steerable(args.threadId, args.expectedTurnId);
    // Capture completed owned turns before later sends move them out of bounded history.
    if (Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === args.threadId)) await this.turns(args.threadId);
    await this.requireClearWork(args.threadId);
    const resumed = await this.subscribe(args.threadId);
    if (await this.scope.cwd(resumed.thread?.cwd) !== this.store.state.threads[args.threadId].cwd || resumed.thread.parentThreadId) fail('OUT_OF_SCOPE');
    if (!args.expectedTurnId && resumed.thread.status?.type !== 'idle') fail('CHAT_ACTIVE');
    await requireLocalExecution(resumed.thread, this.scope, this.store.state.threads[args.threadId].cwd);
    const loaded = !this.expanded && !args.expectedTurnId ? await loadCompletedDescendants(this, args.threadId) : null;
    const childProof = !args.expectedTurnId ? await this.preflight(args.threadId) : {};
    if (this.expanded) childProof.ignoreRequestId = args.requestId;
    if (loaded && (this.native.epoch !== loaded.epoch || !this.native.socket)) fail('PREVIOUS_WORK_UNVERIFIED');
    const previousTurnIds = this.expanded && !args.expectedTurnId ? await this.startSnapshot(args) : null;
    const initialHistory = this.context.developer && !args.expectedTurnId ? await this.turns(args.threadId) : null;
    if (initialHistory && !initialHistory.data.length && !initialHistory.complete) fail('TURN_STATE_UNVERIFIED');
    const developerContext = !!initialHistory && initialHistory.complete && !initialHistory.data.length;
    const deliveredText = developerContext ? args.text + '\n\n' + this.context.developer : args.text;
    if (deliveredText.length > 16000 || Buffer.byteLength(deliveredText) > 48000) fail('CONTEXT_DELIVERY_TOO_LARGE');
    await this.store.update(s => {
      if (args.expectedTurnId) this.steerable(args.threadId, args.expectedTurnId);
      if (!args.expectedTurnId) {
        if (this.expanded) requireScopeCurrent(this, args.threadId, childProof);
        else if (childEvidence(s.threads[args.threadId]) !== childProof.evidence) fail('PREVIOUS_WORK_UNVERIFIED');
      }
      if (args.preparationId) {
        const prepared = s.operations[args.preparationId];
        if (!prepared || prepared.kind !== 'preparation' || prepared.threadId !== args.threadId || prepared.contextHash !== this.contextHash || prepared.consumedBy) fail('PREPARATION_UNAVAILABLE');
        prepared.consumedBy = args.requestId;
      }
      s.clockFloor = Math.max(s.clockFloor ?? 0, this.now());
      s.operations[args.requestId] = { fingerprint, kind: 'send', phase: 'dispatching', threadId: args.threadId, developerContext,
        ...(args.skills ? { skills: args.skills } : {}),
        originProofRequired: !args.expectedTurnId, dispatchBinding: { ...this.execution, cwd: s.threads[args.threadId].cwd,
          threadId: args.threadId }, expectedTurnId: args.expectedTurnId ?? null, ...(previousTurnIds ? { previousTurnIds } : {}) };
    });
    let dispatched = false;
    try {
      if (previousTurnIds) { await this.requireClearWork(args.threadId); await this.startSnapshot(args); }
      requireSkillReceiptCapacity(args.requestId, this.store.state.operations[args.requestId]);
      await this.requireClearWork(args.threadId);
      if (!args.expectedTurnId && this.expanded) {
        await recheckOwnedScope(this, args.threadId, childProof);
      } else if (!args.expectedTurnId) {
        const inventory = await readDescendants(this, args.threadId);
        if (!inventory || inventory.fingerprint !== childProof.descendants?.fingerprint) fail('PREVIOUS_WORK_UNVERIFIED');
        const terminals = await this.terminals(args.threadId);
        if (!terminals.available || !terminals.complete || terminals.data.length) fail('PREVIOUS_WORK_UNVERIFIED');
      }
      const skills = await resolveSkills(this.native, this.store.state.threads[args.threadId].cwd, args.skills);
      if (skills.length) await this.requireClearWork(args.threadId);
      if (this.expanded && !args.expectedTurnId) {
        await recheckOwnedScope(this, args.threadId, childProof);
      }
      const finalThread = await this.owned(args.threadId);
      if (!args.expectedTurnId && finalThread.status?.type !== 'idle') fail('CHAT_ACTIVE');
      await requireLocalExecution(finalThread, this.scope, this.store.state.threads[args.threadId].cwd);
      await this.store.tail;
      if (!args.expectedTurnId) {
        if (this.expanded) requireScopeCurrent(this, args.threadId, childProof);
        else if (childEvidence(this.store.state.threads[args.threadId]) !== childProof.evidence) fail('PREVIOUS_WORK_UNVERIFIED');
      }
      if (developerContext) {
        const fresh = await this.turns(args.threadId);
        if (!fresh.complete || fresh.data.length) fail('CHAT_CHANGED');
      }
      const params = { threadId: args.threadId, input: [{ type: 'text', text: deliveredText }, ...skills], clientUserMessageId: args.requestId };
      if (Buffer.byteLength(JSON.stringify(params)) > 60000) fail('INPUT_TOO_LARGE');
      if (loaded && (this.native.epoch !== loaded.epoch || !this.native.socket)) fail('PREVIOUS_WORK_UNVERIFIED');
      dispatched = true;
      const reply = args.expectedTurnId ? await this.native.request('turn/steer', { ...params, expectedTurnId: args.expectedTurnId }) : await this.native.request('turn/start', params);
      const turnId = reply.turn?.id ?? reply.turnId;
      if (typeof turnId !== 'string' || !turnId || turnId.length > 200) fail('INVALID_BACKEND_RESPONSE');
      let originVerified = !!args.expectedTurnId;
      if (!args.expectedTurnId) {
        // A start acknowledgement may carry partial items. Only full native history
        // can show that our message initiated the turn rather than steering UI work.
        const observed = await this.turns(args.threadId);
        originVerified = observed.data.some(t => t.id === turnId && this.turnOrigin(t, args.requestId));
        if (developerContext && (!observed.complete || observed.data.length !== 1 || observed.data[0]?.id !== turnId))
          fail('CONTEXT_FIRST_REQUEST_UNVERIFIED');
      }
      return await this.accept(args.requestId, turnId, originVerified);
    } catch (e) {
      if (!dispatched) {
        const result = { requestId: args.requestId, threadId: args.threadId, phase: 'notDispatched', code: e instanceof SafeError ? e.code : 'CONTROL_FAILED' };
        await this.store.update(s => {
          Object.assign(s.operations[args.requestId], { phase: 'notDispatched', deadlineEnforcement: 'notDispatched', result });
          if (args.preparationId && s.operations[args.preparationId]?.consumedBy === args.requestId) delete s.operations[args.preparationId].consumedBy;
        });
        return result;
      }
      const known = this.store.state.operations[args.requestId]; if (known.turnId && known.result) return known.result;
      const result = { requestId: args.requestId, threadId: args.threadId, phase: 'unknown',
        code: e instanceof SafeError ? e.code : 'CONTROL_FAILED', retry: 'Reconcile status; never blindly resend.' };
      await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: 'unknown', result,
        failureCode: result.code, ...(e.nativeRejection ? { nativeRejection: e.nativeRejection } : {}) }); });
      return result;
    }
  }
  async subscribe(threadId) {
    const thread = await this.owned(threadId);
    if (this.subscribed.get(threadId) === this.native.epoch && this.native.socket && thread.status?.type !== 'notLoaded') return { thread };
    // Resume is a control operation: only a recorded owned root is eligible, with no overrides.
    const r = await this.native.request('thread/resume', { threadId, excludeTurns: true });
    if (r.thread?.id !== threadId || await this.scope.cwd(r.thread?.cwd) !== this.store.state.threads[threadId].cwd || r.thread.parentThreadId) fail('OUT_OF_SCOPE');
    await this.controlScope.cwd(r.thread.cwd);
    this.subscribed.set(threadId, this.native.epoch); return r;
  }
  turnOrigin(turn, requestId) {
    return Array.isArray(turn?.items) && turn.items[0]?.type === 'userMessage' && turn.items[0].clientId === requestId &&
      turn.items.filter(item => item.type === 'userMessage' && item.clientId === requestId).length === 1;
  }
  async accept(requestId, turnId, originVerified = false) {
    const op = this.store.state.operations[requestId];
    if (op.previousTurnIds?.includes(turnId) || op.expectedTurnId && op.expectedTurnId !== turnId) {
      await this.store.update(s => { Object.assign(s.operations[requestId], { phase: 'unknown', unexpectedNativeTurn: true }); });
      fail('UNEXPECTED_NATIVE_TURN');
    }
    if ((op.previousTurnIds || op.originProofRequired) && !originVerified) fail('TURN_ORIGIN_UNVERIFIED');
    if (op.developerContext) {
      const observed = await this.turns(op.threadId);
      // Later requests may exist after a positively acknowledged first send.
      // For unresolved sends, complete oldest history must prove ours was first.
      if (!observed.complete || observed.data.at(-1)?.id !== turnId || !this.turnOrigin(observed.data.at(-1), requestId))
        fail('CONTEXT_FIRST_REQUEST_UNVERIFIED');
    }
    const result = acceptedSendResult(requestId, op, turnId);
    await this.store.update(s => { Object.assign(s.operations[requestId], { phase: 'accepted', turnId, result }); });
    for (const [key, event] of this.deferredRequests) if (event.params.threadId === op.threadId &&
        (event.params.turnId === turnId || event.method === 'turn/completed' && event.params.turn?.id === turnId)) {
      this.deferredRequests.delete(key);
      if (event.epoch === this.native.epoch) this.event(event);
    }
    return result;
  }
  requireHistoryBudget() {
    const deadlineAt = this.historyReads?.getStore();
    if (deadlineAt !== undefined && this.now() >= deadlineAt) fail('HISTORY_READ_BUDGET_EXHAUSTED');
  }
  async readNative(method, params, options) {
    this.requireHistoryBudget();
    const deadlineAt = Math.min(this.historyReads?.getStore() ?? Infinity, options?.deadlineAt ?? Infinity);
    try {
      const result = await this.native.request(method, params, Number.isFinite(deadlineAt) ? { ...options, deadlineAt } : options);
      this.requireHistoryBudget();
      return result;
    }
    catch (e) {
      this.requireHistoryBudget();
      if (Number.isFinite(deadlineAt) && e.code === 'DEADLINE_EXPIRED') fail('HISTORY_READ_BUDGET_EXHAUSTED');
      throw e;
    }
  }
  async optional(method, params, options) {
    try { return await this.readNative(method, params, options); }
    catch (e) {
      if (['UNSUPPORTED_RPC', 'BACKEND_REJECTED'].includes(e.code)) return null; throw e;
    }
  }
  async startSnapshot(args) {
    const thread = await this.owned(args.threadId);
    if (thread.status?.type !== 'idle') fail('CHAT_ACTIVE');
    const history = await this.turns(args.threadId);
    if (!history.data.length && !history.complete) fail('TURN_STATE_UNVERIFIED');
    if (history.data.some(t => t.status === 'inProgress' &&
        (!this.expanded || !localTurnLifetimeEnded(this.store.state, args.threadId, t.id, this.execution)))) fail('CHAT_ACTIVE');
    if ((history.data[0]?.id ?? null) !== args.expectedLastTurnId) fail('CHAT_CHANGED');
    if (history.data.some(t => typeof t.id !== 'string' || !t.id || t.id.length > 200)) fail('INVALID_BACKEND_RESPONSE');
    const finalThread = await this.owned(args.threadId);
    if (finalThread.status?.type !== 'idle') fail('CHAT_ACTIVE');
    await requireLocalExecution(finalThread, this.scope, this.store.state.threads[args.threadId].cwd);
    return history.data.map(t => t.id);
  }
  ownTurn(threadId, turnId) {
    if (!Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === threadId && op.turnId === turnId)) fail('TURN_NOT_OWNED');
  }
  steerable(threadId, turnId) {
    this.ownTurn(threadId, turnId);
    if (Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === threadId && op.turnId === turnId && (op.stopRequested))) fail('TURN_STOP_REQUESTED');
  }
  async turns(threadId) {
    const result = [], cursors = new Set(), ids = new Set(); let cursor;
    const deadlineAt = this.historyReads?.getStore() ?? this.now() + HISTORY_READ_BUDGET_MS;
    // Native may shrink an oversized page. Preserve the existing 60-turn
    // evidence budget rather than treating three smaller pages as all history.
    for (let page = 0; page < 60 && result.length < 60; page++) {
      const limit = Math.min(20, 60 - result.length);
      const r = await this.optional('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) }, { deadlineAt });
      if (!r) return { data: result, complete: false };
      if (!Array.isArray(r.data) || r.data.length > limit || r.data.some(t =>
        !validOwnershipId(t?.id) || ids.has(t.id))) fail('INVALID_BACKEND_RESPONSE');
      for (const turn of r.data) { if (ids.has(turn.id)) fail('INVALID_BACKEND_RESPONSE'); ids.add(turn.id); result.push(turn); }
      cursor = r.nextCursor;
      if (cursor === null) { await this.recordTerminalTurns(threadId, result); return { data: result, complete: true }; }
      if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    await this.recordTerminalTurns(threadId, result);
    return { data: result, complete: false };
  }
  async recordTerminalTurns(threadId, turns) {
    const record = this.store.state.threads[threadId];
    // Reading a descendant for legacy verification does not enroll or own it.
    if (!record) return;
    const owned = new Set(Object.values(this.store.state.operations).filter(op => op.kind === 'send' && op.threadId === threadId).map(op => op.turnId));
    const updates = {};
    const captured = turns.filter(turn => owned.has(turn.id));
    const capturedRecord = { ownedObligations: structuredClone(record.ownedObligations) };
    for (const turn of captured) captureOwnedTurn(capturedRecord, turn);
    const captureChanged = JSON.stringify(capturedRecord.ownedObligations) !== JSON.stringify(record.ownedObligations);
    for (const turn of turns) {
      if (!owned.has(turn.id) || !['completed', 'interrupted', 'failed'].includes(turn.status)) continue;
      const previous = record.terminalTurns?.[turn.id];
      if (previous && !Array.isArray(turn.items)) continue;
      const items = Array.isArray(turn.items) ? turn.items : [];
      // Persist ownership metadata only, never transcript or command output.
      const receipt = { id: turn.id, status: turn.status,
        items: mergeCommandObservations(previous?.items, items),
        childItems: mergeChildItems(previous?.childItems, record.childItems?.[turn.id], childItems(items)),
        childActivityObserved: !!previous?.childActivityObserved || items.some(item => item.type === 'subAgentActivity' ||
          item.type === 'collabAgentToolCall' && (item.receiverThreadIds?.length ?? 0) > 0) };
      if (JSON.stringify(receipt) !== JSON.stringify(previous)) updates[turn.id] = receipt;
    }
    if (!Object.keys(updates).length && !captureChanged) return;
    await this.store.update(s => {
      const current = s.threads[threadId]; current.terminalTurns ??= {};
      for (const turn of captured) captureOwnedTurn(current, turn);
      for (const [id, receipt] of Object.entries(updates)) {
        // Ownership observations are conservative across concurrent reads/events.
        receipt.items = mergeCommandObservations(current.terminalTurns[id]?.items, receipt.items);
        receipt.childActivityObserved ||= !!current.terminalTurns[id]?.childActivityObserved;
        receipt.childItems = mergeChildItems(receipt.childItems, current.terminalTurns[id]?.childItems, current.childItems?.[id]);
        current.terminalTurns[id] = receipt;
        if (receipt.childActivityObserved) {
          current.childTurns ??= []; if (!current.childTurns.includes(id)) current.childTurns.push(id);
        }
      }
    });
  }
  async repairOwnedTurn(threadId, turnId) {
    this.ownTurn(threadId, turnId);
    await this.owned(threadId);
    const items = [], itemIds = new Set(), cursors = new Set();
    const deadlineAt = this.historyReads?.getStore() ?? this.now() + HISTORY_READ_BUDGET_MS;
    let cursor, complete = false;
    for (let page = 0; page < 400 && items.length < 400; page++) {
      const limit = Math.min(20, 400 - items.length);
      const result = await this.optional('thread/items/list', { threadId, turnId, limit,
        sortDirection: 'asc', ...(cursor ? { cursor } : {}) }, { deadlineAt });
      if (!result) break;
      if (!Array.isArray(result.data) || result.data.length > limit || result.data.some(entry =>
        entry?.turnId !== turnId || !validOwnershipId(entry.item?.id) || itemIds.has(entry.item.id))) fail('INVALID_BACKEND_RESPONSE');
      for (const entry of result.data) {
        if (itemIds.has(entry.item.id)) fail('INVALID_BACKEND_RESPONSE');
        itemIds.add(entry.item.id); items.push(entry.item);
      }
      cursor = result.nextCursor;
      if (cursor === null) { complete = true; break; }
      if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    // Items prove command/delegation evidence, never model terminality. Native
    // turn status must come from its own observation or retained receipt.
    const status = this.store.state.threads[threadId].ownedObligations?.turns?.[turnId]?.modelStatus
      ?? this.store.state.threads[threadId].terminalTurns?.[turnId]?.status;
    await this.store.update(s => {
      if (!Object.values(s.operations).some(op => op.kind === 'send' && op.threadId === threadId && op.turnId === turnId)) fail('TURN_NOT_OWNED');
      captureOwnedTurn(s.threads[threadId], { id: turnId, status, items, ...(complete ? { itemsView: 'full' } : {}) });
    });
    return { turnId, complete, itemCount: items.length };
  }
  async terminals(threadId) {
    const data = []; const seen = new Set(); let cursor;
    for (let page = 0; page < 5; page++) {
      const r = await this.optional('thread/backgroundTerminals/list', { threadId, limit: 20, ...(cursor ? { cursor } : {}) });
      if (!r) return { data, available: false, complete: false };
      if (!Array.isArray(r.data) || r.data.length > 20 || r.data.some(x => !x || typeof x.itemId !== 'string' || typeof x.processId !== 'string' || typeof x.cwd !== 'string')) fail('INVALID_BACKEND_RESPONSE');
      data.push(...r.data.map(({ itemId, processId, cwd }) => ({ itemId, processId, cwd })));
      cursor = r.nextCursor; if (cursor === null) return { data, available: true, complete: true };
      if (typeof cursor !== 'string' || !cursor || cursor.length > 2048) return { data, available: true, complete: false };
      if (seen.has(cursor)) return { data, available: true, complete: false }; seen.add(cursor);
    }
    return { data, available: true, complete: false };
  }
  async rejectSteer(requestId, history, receipt) {
    const op = this.store.state.operations[requestId];
    if (!op || op.kind !== 'send' || op.phase !== 'unknown' || op.turnId || !op.expectedTurnId ||
      !history.complete || !['nativeNoActiveTurn', 'approvedLegacyRecovery'].includes(receipt.source)) return false;
    if (receipt.source === 'nativeNoActiveTurn' && (op.failureCode !== 'BACKEND_REJECTED' ||
      op.nativeRejection?.rpcCode !== -32600 || op.nativeRejection.reason !== 'noActiveTurn')) return false;
    if (history.data.some(t => (t.items ?? []).some(i => i.type === 'userMessage' && i.clientId === requestId))) return false;
    const targets = history.data.filter(t => t.id === op.expectedTurnId);
    if (targets.length !== 1) return false;
    const target = targets[0];
    if (!['completed', 'interrupted', 'failed'].includes(target.status) || target.itemsView !== 'full' ||
      !Array.isArray(target.items) || target.items.some(i => !i || typeof i.type !== 'string')) return false;
    const owners = Object.entries(this.store.state.operations).filter(([, prior]) => prior.kind === 'send' &&
      prior.threadId === op.threadId && prior.turnId === op.expectedTurnId && prior.phase === 'accepted');
    if (!owners.some(([id]) => this.turnOrigin(target, id))) return false;
    const thread = await this.owned(op.threadId);
    if (thread.status?.type !== 'idle') return false;
    await this.requireClearWork(op.threadId);
    const result = { requestId, threadId: op.threadId, phase: 'rejected', code: 'NATIVE_STEER_REJECTED',
      expectedTurnId: op.expectedTurnId, modelTurnStarted: false };
    let resolved = false;
    await this.store.update(s => {
      const current = s.operations[requestId];
      // Do not overwrite an acceptance that raced the native evidence reads.
      if (current.phase !== 'unknown' || current.turnId || current.expectedTurnId !== op.expectedTurnId ||
        current.threadId !== op.threadId || current.fingerprint !== op.fingerprint ||
        current.failureCode !== op.failureCode || JSON.stringify(current.nativeRejection) !== JSON.stringify(op.nativeRejection)) return;
      Object.assign(current, { phase: 'rejected', deadlineEnforcement: 'notDispatched', result,
        rejectionVerification: { ...receipt, expectedTurnId: target.id, status: target.status,
          itemsView: 'full', itemCount: target.items.length, observedAt: this.now() } });
      resolved = true;
    });
    return resolved;
  }
  // Local recovery only; not exposed in MCP or watchdog IPC. The caller must
  // supply a captured BACKEND_REJECTED receipt and explicit operator approval.
  async recoverRejectedSteer({ requestId, threadId, expectedTurnId, code, approvalRef }) {
    const op = this.store.state.operations[requestId];
    if (!uuid.safeParse(requestId).success || !uuid.safeParse(threadId).success || code !== 'BACKEND_REJECTED' ||
      typeof approvalRef !== 'string' || !/^[A-Za-z0-9_-]{1,240}$/.test(approvalRef) ||
      !op || op.threadId !== threadId || op.expectedTurnId !== expectedTurnId || op.phase !== 'unknown' ||
      op.turnId || op.failureCode || op.nativeRejection) fail('REJECTION_UNVERIFIED');
    await this.owned(threadId); this.ownTurn(threadId, expectedTurnId);
    const history = await this.turns(threadId);
    if (!await this.rejectSteer(requestId, history, { source: 'approvedLegacyRecovery', code, approvalRef })) fail('REJECTION_UNVERIFIED');
    return this.store.state.operations[requestId].result;
  }
  async reconcile(threadId) {
    const unknown = Object.entries(this.store.state.operations).filter(([, op]) => op.kind === 'send' && op.threadId === threadId && (op.phase === 'unknown' || op.phase === 'dispatching'));
    if (!unknown.length) return;
    await this.owned(threadId); const history = await this.turns(threadId);
    for (const [requestId, op] of unknown) {
      const matches = history.data.filter(t => (t.items ?? []).some(i => i.type === 'userMessage' && i.clientId === requestId));
      const occurrences = history.data.flatMap(t => (t.items ?? []).filter(i => i.type === 'userMessage' && i.clientId === requestId));
      if (matches.length === 1 && occurrences.length === 1 && !op.previousTurnIds?.includes(matches[0].id) &&
        (!(op.previousTurnIds || op.originProofRequired) || this.turnOrigin(matches[0], requestId)) &&
        (!op.expectedTurnId || matches[0].id === op.expectedTurnId)) {
        if (op.developerContext && (!history.complete || history.data.at(-1)?.id !== matches[0].id)) continue;
        await this.accept(requestId, matches[0].id, true);
      }
      else if (!matches.length && op.nativeRejection?.reason === 'noActiveTurn') await this.rejectSteer(requestId, history, { source: 'nativeNoActiveTurn' });
      // An absent match in bounded history is not proof that the send failed.
    }
  }
  reconcileCompletion(threadId, turn, epoch) {
    if (this.closing || this.native.epoch !== epoch ||
        !Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === threadId && ['dispatching', 'unknown'].includes(op.phase))) return;
    const running = this.completionJobs.get(threadId);
    if (running) { running.pending = { turn, epoch }; return; }
    // A completion notification is a reason to read fresh history, never proof
    // of ownership. Serialize behind the send acknowledgement; do not retry,
    // poll, dispatch model input, or accept from the event's summary alone.
    const job = this.serial(threadId, async () => {
      let signal = { turn, epoch };
      try {
        while (signal) {
          if (this.closing || !this.native.socket) return;
          if (this.native.epoch === signal.epoch) {
            try {
              await this.reconcile(threadId);
              await this.recordTerminalTurns(threadId, [signal.turn]);
            } catch { /* Preserve unknown delivery; only a new event warrants another read. */ }
          }
          signal = job.pending;
          job.pending = null;
        }
      } finally {
        // Remove the gate before exposing settlement to other event handlers.
        if (this.completionJobs.get(threadId) === job) this.completionJobs.delete(threadId);
      }
    });
    this.completionJobs.set(threadId, job);
    job.catch(() => { /* Unknown delivery remains recoverable through fresh status. */ });
  }
  event(event) {
    const p = event.params; if (!p || !this.store.state.threads[p.threadId]) return;
    if (['item/started', 'item/completed'].includes(event.method) &&
        ['commandExecution', 'subAgentActivity', 'collabAgentToolCall'].includes(p.item?.type) &&
        !Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turnId) &&
        Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && ['dispatching', 'unknown'].includes(op.phase))) {
      // Native items can precede the acknowledgement. Replay only after accept()
      // proves this exact turn belongs to the request; never infer from cwd.
      if (this.deferredRequests.size < 32 && Buffer.byteLength(JSON.stringify(event)) <= 32000)
        this.deferredRequests.set(JSON.stringify(['ownership', event.epoch, p.threadId, p.turnId, p.item.id, event.method]), event);
      return;
    }
    if (['item/autoApprovalReview/started', 'item/autoApprovalReview/completed'].includes(event.method)) {
      if (!Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turnId) ||
          typeof p.reviewId !== 'string' || !p.reviewId || p.reviewId.length > 200 ||
          !['inProgress', 'approved', 'denied', 'timedOut', 'aborted'].includes(p.review?.status)) return;
      const key = JSON.stringify([p.threadId, p.turnId, p.reviewId]);
      if (this.nativeReviews.size >= 32 && !this.nativeReviews.has(key)) return;
      this.nativeReviews.set(key, { threadId: p.threadId, turnId: p.turnId, reviewId: p.reviewId,
        status: p.review.status, targetItemId: typeof p.targetItemId === 'string' ? p.targetItemId.slice(0, 200) : null,
        actionFingerprint: createHash('sha256').update(JSON.stringify(p.action ?? null)).digest('hex'),
        observedAt: this.now() });
      return;
    }
    if (['item/started', 'item/completed'].includes(event.method) && (p.item?.type === 'subAgentActivity' || p.item?.type === 'collabAgentToolCall' && (p.item.receiverThreadIds?.length ?? 0) > 0) && Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turnId)) {
      this.persistEvent(p.threadId, s => { const record = s.threads[p.threadId];
        captureOwnedTurn(record, { id: p.turnId, items: [p.item] }, { eventItem: true });
        record.childTurns ??= []; if (!record.childTurns.includes(p.turnId)) record.childTurns.push(p.turnId); record.childItems ??= {}; record.childItems[p.turnId] = mergeChildItems(record.childItems[p.turnId], childItems([p.item])); }); return;
    }
    if (['item/started', 'item/completed'].includes(event.method) && p.item?.type === 'commandExecution' && typeof p.item.id === 'string' && p.item.id.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(p.item.id) && Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turnId)) {
      const item = p.item; const processId = typeof item.processId === 'string' && item.processId.length <= 200 ? item.processId : null;
      this.persistEvent(p.threadId, s => {
        const record = s.threads[p.threadId]; record.commandItems ??= {};
        captureOwnedTurn(record, { id: p.turnId, items: [p.item] }, { eventItem: true });
        const old = record.commandItems[item.id];
        const identityConflict = !!old?.identityConflict || !!old && (old.turnId !== p.turnId ||
          typeof old.processId === 'string' && processId !== null && old.processId !== processId);
        const observations = new Map();
        for (const observation of [...(old?.observations ?? (old ? [{ turnId: old.turnId, processId: old.processId }] : [])),
          { turnId: p.turnId, processId }]) if (typeof observation.processId === 'string') {
          observations.set(JSON.stringify(observation), observation);
        }
        record.commandItems[item.id] = { turnId: p.turnId, processId: processId ?? old?.processId ?? null,
          observations: [...observations.values()], identityConflict,
          status: typeof item.status === 'string' ? item.status.slice(0, 30) : 'unknown' };
      }); return;
    }
    if (event.method === 'thread/tokenUsage/updated' && Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turnId)) {
      const allowed = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens'];
      const pick = value => Object.fromEntries(allowed.filter(k => Number.isSafeInteger(value?.[k]) && value[k] >= 0).map(k => [k, value[k]]));
      this.observedUsage.set(p.threadId, { turnId: p.turnId, total: pick(p.tokenUsage?.total), last: pick(p.tokenUsage?.last), observedAt: Date.now(), hardTokenCap: false }); return;
    }
    if (event.method === 'serverRequest/resolved') {
      this.deferredRequests.delete(JSON.stringify([event.epoch, p.threadId, p.requestId]));
      for (const [ref, q] of this.questions) if (q.threadId === p.threadId && q.nativeId === p.requestId) this.questions.delete(ref);
      const key = JSON.stringify([event.epoch, p.threadId, p.requestId]);
      if (this.localRequests.get(key)?.threadId === p.threadId) this.localRequests.delete(key); return;
    }
    if (event.method === 'turn/completed') {
      if (validOwnershipId(p.turn?.id) &&
          ['completed', 'interrupted', 'failed'].includes(p.turn.status) &&
          !Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turn.id) &&
          Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && ['dispatching', 'unknown'].includes(op.phase)) &&
          this.deferredRequests.size < 32) {
        // Retain model-only terminal evidence until exact origin acceptance.
        // No transcript is needed, and this grants no ownership by itself.
        this.deferredRequests.set(JSON.stringify(['ownershipCompletion', event.epoch, p.threadId, p.turn.id]), {
          method: 'turn/completed', epoch: event.epoch, params: { threadId: p.threadId,
            turn: { id: p.turn.id, status: p.turn.status } } });
      }
      for (const [key, q] of this.deferredRequests) if ('id' in q && q.params.threadId === p.threadId && q.params.turnId === p.turn?.id) this.deferredRequests.delete(key);
      for (const [ref, q] of this.questions) if (q.threadId === p.threadId && q.turnId === p.turn?.id) this.questions.delete(ref);
      for (const [key, q] of this.localRequests) if (q.threadId === p.threadId && q.turnId === p.turn?.id) this.localRequests.delete(key);
      if (p.turn) this.recordTerminalTurns(p.threadId, [p.turn]).catch(() => {
        // Terminal history is reread on the next status/preflight; missed command
        // events retain their own retry functions.
        this.persistenceRetries.set(p.threadId, this.persistenceRetries.get(p.threadId) ?? []);
      });
      if (typeof p.turn?.id === 'string' && p.turn.id.length <= 200 && ['completed', 'interrupted', 'failed'].includes(p.turn.status))
        this.reconcileCompletion(p.threadId, p.turn, event.epoch);
      return;
    }
    if (!('id' in event) || !['string', 'number'].includes(typeof event.id)) return;
    if (!Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turnId) &&
        Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && ['dispatching', 'unknown'].includes(op.phase))) {
      // Requests may precede the start acknowledgement. Retain them only on this
      // connection; answerability still requires positively verified ownership.
      if (this.deferredRequests.size < 32 && Buffer.byteLength(JSON.stringify(event)) <= 32000)
        this.deferredRequests.set(JSON.stringify([event.epoch, p.threadId, event.id]), event);
      return;
    }
    if (!Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === p.threadId && op.turnId === p.turnId && !op.stopRequested)) return;
    const key = JSON.stringify([event.epoch, p.threadId, event.id]);
    if (event.method !== 'item/tool/requestUserInput') {
      if (this.localRequests.size < 32) this.localRequests.set(key, { threadId: p.threadId, turnId: p.turnId, kind: 'approval' }); return;
    }
    const questions = p.questions;
    if (!Array.isArray(questions) || !questions.length || questions.length > 5) return;
    if (questions.some(q => !q || q.isSecret !== undefined && typeof q.isSecret !== 'boolean')) return;
    if (questions.some(q => q.isSecret === true)) { if (this.localRequests.size < 32) this.localRequests.set(key, { threadId: p.threadId, turnId: p.turnId, kind: 'secret' }); return; }
    if (questions.some(q => typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(q.id) || ['__proto__', 'constructor', 'prototype'].includes(q.id))) return;
    if (this.questions.size >= 32 || [...this.questions.values()].some(q => q.threadId === p.threadId && q.epoch === event.epoch && q.nativeId === event.id)) return;
    const questionRef = randomUUID();
    this.questions.set(questionRef, { questionRef, nativeId: event.id, epoch: event.epoch, threadId: p.threadId, turnId: p.turnId, isBlocking: p.isBlocking !== false, questions: questions.map(q => ({ id: q.id, header: safeText(q.header, 80).text, question: safeText(q.question, 1200).text, options: (q.options ?? []).slice(0, 4).map(o => ({ label: safeText(o.label, 200).text, description: safeText(o.description, 300).text })) })) });
  }
  pruneRequests(threadId, history) {
    for (const [ref, q] of this.questions) if (q.threadId === threadId && (!history.data.some(t => t.id === q.turnId && t.status === 'inProgress') || !Object.values(this.store.state.operations).some(op => op.turnId === q.turnId && !op.stopRequested))) this.questions.delete(ref);
    for (const [key, q] of this.localRequests) if (q.threadId === threadId &&
      (!history.data.some(t => t.id === q.turnId && t.status === 'inProgress') ||
       !Object.values(this.store.state.operations).some(op => op.threadId === threadId && op.turnId === q.turnId && !op.stopRequested))) this.localRequests.delete(key);
  }
  async listQuestions(threadId, { cursor, questionRef } = {}) {
    await this.owned(threadId);
    const history = await this.turns(threadId);
    this.pruneRequests(threadId, history);
    const binding = JSON.stringify(['questions', threadId]);
    const position = this.statusCursors.decode(cursor, binding);
    const ref = questionRef ?? position?.questionRef;
    if (questionRef && position?.questionRef && questionRef !== position.questionRef) fail('INVALID_CURSOR');
    if (ref) {
      const q = this.questions.get(ref);
      if (!q || q.threadId !== threadId || q.epoch !== this.native.epoch) fail('STALE_QUESTION');
      const hash = this.goalHash(q);
      if (position && position.hash !== hash) fail('QUESTION_CHANGED');
      const page = sanitizedMessagePage([{ turnId: q.turnId, item: { id: ref, type: 'userMessage',
        content: [{ type: 'text', text: JSON.stringify(q.questions) }] } }],
        { index: position?.index ?? 0, offset: position?.offset ?? 0, maxChars: 6000 });
      return { threadId, questionRef: ref, turnId: q.turnId, details: page.entries,
        encoding: 'Concatenate text slices to recover the sanitized questions JSON.',
        nextCursor: page.continuation ? this.statusCursors.encode(binding, { questionRef: ref, hash, ...page.continuation }) : null };
    }
    const all = [...this.questions.values()].filter(q => q.threadId === threadId);
    const hash = this.goalHash(all);
    if (position && position.hash !== hash) fail('QUESTION_CHANGED');
    const offset = position?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > all.length) fail('INVALID_CURSOR');
    const result = { threadId, questions: [], questionCount: all.length, nextCursor: null,
      localSecretRequests: [...this.localRequests.values()].filter(q => q.threadId === threadId && q.kind === 'secret').length,
      localApprovalRequests: [...this.localRequests.values()].filter(q => q.threadId === threadId && q.kind === 'approval').length,
      permissionPolicy: 'Native approvals and secrets require a supported owner UI; no connector approval responses.' };
    let next = offset;
    for (const q of all.slice(offset, offset + 10)) {
      const { nativeId, epoch, ...display } = q;
      if (Buffer.byteLength(JSON.stringify(display)) > 12000) {
        display.questions = q.questions.map(question => ({ id: question.id,
          header: safeText(question.header, 24).text, question: safeText(question.question, 80).text }));
        display.truncated = true;
        display.detailsCursor = this.statusCursors.encode(binding, { questionRef: q.questionRef, hash: this.goalHash(q), index: 0, offset: 0 });
      }
      result.questions.push(display);
      if (Buffer.byteLength(JSON.stringify(result)) > 24000 && result.questions.length > 1) { result.questions.pop(); break; }
      next++;
    }
    result.nextCursor = next < all.length ? this.statusCursors.encode(binding, { hash, offset: next }) : null;
    return result;
  }
  async answer(args, fingerprint) {
    await this.listQuestions(args.threadId);
    const q = this.questions.get(args.questionRef);
    if (!q || q.threadId !== args.threadId || q.epoch !== this.native.epoch) fail('STALE_QUESTION');
    if (q.questions.map(x => x.id).sort().join('|') !== Object.keys(args.answers).sort().join('|')) fail('INVALID_ANSWERS');
    await this.store.update(s => { s.operations[args.requestId] = { fingerprint, kind: 'answer', phase: 'dispatching', threadId: args.threadId }; });
    try {
      if (this.questions.get(args.questionRef) !== q || q.epoch !== this.native.epoch || !Object.values(this.store.state.operations).some(op => op.threadId === q.threadId && op.turnId === q.turnId && !op.stopRequested)) fail('STALE_QUESTION');
      this.questions.delete(args.questionRef);
      this.native.ordinaryAnswer(q.epoch, q.nativeId, Object.fromEntries(Object.entries(args.answers).map(([id, answers]) => [id, { answers }])));
      const result = { requestId: args.requestId, phase: 'answeredUnconfirmed', threadId: args.threadId, turnId: q.turnId };
      await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: result.phase, result }); }); return result;
    } catch (e) { await this.store.update(s => { s.operations[args.requestId].phase = e.code === 'STALE_QUESTION' ? 'rejectedStale' : 'unknown'; }); throw e; }
  }
  async stop(args, fingerprint, reason = 'requested') {
    await this.owned(args.threadId); this.ownTurn(args.threadId, args.turnId);
    await this.store.update(s => {
      s.operations[args.requestId] = { fingerprint, kind: 'stop', phase: 'dispatching', threadId: args.threadId, turnId: args.turnId };
      s.threads[args.threadId].lastStop = { turnId: args.turnId, reason, requestedAt: Date.now(), acknowledged: false };
      for (const op of Object.values(s.operations)) if (op.kind === 'send' && op.threadId === args.threadId && op.turnId === args.turnId) op.stopRequested = true;
    });
    const history = await this.turns(args.threadId); const turn = history.data.find(t => t.id === args.turnId) ?? this.store.state.threads[args.threadId].terminalTurns?.[args.turnId];
    let acknowledged = false;
    if (turn && ['completed', 'interrupted', 'failed'].includes(turn.status)) acknowledged = true;
    else {
      try { await this.native.request('turn/interrupt', { threadId: args.threadId, turnId: args.turnId }); acknowledged = true; }
      catch { /* The subsequent read, not this acknowledgement, determines completion. */ }
    }
    const terminals = await this.terminals(args.threadId);
    for (const terminal of terminals.data) if (this.ownsTerminal(args.threadId, args.turnId, terminal, turn) && await this.scope.cwd(terminal.cwd) === this.store.state.threads[args.threadId].cwd && await this.controlScope.cwd(terminal.cwd) === this.store.state.threads[args.threadId].cwd) {
      await this.native.request('thread/backgroundTerminals/terminate', { threadId: args.threadId, processId: terminal.processId }).catch(() => {});
    }
    await this.store.update(s => { s.threads[args.threadId].lastStop.acknowledged = acknowledged; });
    const verification = await this.verifyStop(args.threadId);
    const result = { requestId: args.requestId, threadId: args.threadId, turnId: args.turnId, phase: verification.verifiedStopped ? 'stopped' : 'stopPending', ...verification };
    await this.store.update(s => { Object.assign(s.operations[args.requestId], { phase: result.phase, result }); if (verification.turnTerminal && verification.terminalsComplete && verification.ownedTerminals === 0) for (const op of Object.values(s.operations)) if (op.kind === 'send' && op.threadId === args.threadId && op.turnId === args.turnId) op.deadlineEnforcement = 'terminalObserved'; }); return result;
  }
  ownsTerminal(threadId, turnId, terminal, turn) {
    const record = this.store.state.threads[threadId];
    const commands = mergeCommandObservations(turn?.items, record.terminalTurns?.[turnId]?.items).map(i => [i.id, i]);
    const persisted = Object.entries(record.commandItems ?? {}).flatMap(([id, item]) =>
      (item.observations?.length ? item.observations : [item]).map(observation => [id, { ...observation, identityConflict: item.identityConflict }]))
      .filter(([, item]) => item.turnId === turnId || item.identityConflict);
    const observations = [...commands, ...persisted].filter(([itemId, item]) => terminal.itemId === itemId || terminal.processId === item.processId);
    // Both native identities must agree with every retained observation. One
    // matching half or conflicting old/new evidence never grants termination.
    return observations.length > 0 && observations.every(([itemId, item]) => terminal.itemId === itemId &&
      !item.identityConflict && typeof item.processId === 'string' && terminal.processId === item.processId);
  }
  async verifyStop(threadId) {
    const stop = this.store.state.threads[threadId].lastStop; if (!stop) return null;
    if (this.expanded) return this.verifyOwnedStop(threadId, stop);
    const thread = await this.owned(threadId); const history = await this.turns(threadId); const turn = history.data.find(t => t.id === stop.turnId) ?? this.store.state.threads[threadId].terminalTurns?.[stop.turnId];
    const terminal = !!turn && ['completed', 'interrupted', 'failed'].includes(turn.status);
    const terminals = await this.terminals(threadId);
    const ownedTerminals = terminals.available ? terminals.data.filter(x => this.ownsTerminal(threadId, stop.turnId, x, turn)).length : null;
    const unrelatedTerminals = terminals.available ? terminals.data.length - ownedTerminals : null;
    const proof = {};
    const ownedTurnIds = Object.values(this.store.state.operations).filter(op => op.kind === 'send' && op.threadId === threadId).map(op => op.turnId);
    const children = turn ? await verifyChildren(this, threadId, [stop.turnId, ...ownedTurnIds], proof) : 'unverified';
    const goal = await this.optional('thread/goal/get', { threadId }); const queue = await this.optional('thread/queue/list', { threadId, limit: 1 });
    const goalsClear = goal ? goal.goal === null : null; const goalContinuationStopped = goal ? goal.goal === null || ['paused', 'complete'].includes(goal.goal.status) : null; const queueClear = queue ? queue.data?.length === 0 && !queue.nextCursor : null;
    const finalThread = await this.owned(threadId);
    await this.store.tail;
    return { acknowledged: stop.acknowledged, turnTerminal: terminal, turnStatus: turn?.status ?? 'unknown', ownedTerminals, unrelatedTerminals, terminalsComplete: terminals.complete, children, goalsClear, goalContinuationStopped, queueClear, verifiedStopped: !this.persistenceRetries.has(threadId) && terminal && thread.status?.type === 'idle' && finalThread.status?.type === 'idle' && terminals.complete && terminals.data.length === 0 && children !== 'unverified' && proof.evidence === childEvidence(this.store.state.threads[threadId]) && goalContinuationStopped === true && queueClear === true, scope: 'Recorded connector turn and native tracked processes only; detached descendants are unverified.', observedAt: this.now() };
  }
  async verifyOwnedStop(threadId, stop) {
    const proof = await ownedScopeProof(this, threadId);
    const owned = this.store.state.threads[threadId].ownedObligations?.turns?.[stop.turnId];
    const terminal = proof.models.find(item => item.turnId === stop.turnId)?.state === 'closed';
    const live = proof.processes.filter(item => item.state === 'live');
    const summary = scopeSummary(proof);
    return { acknowledged: stop.acknowledged, turnTerminal: terminal, turnStatus: owned?.modelStatus ?? 'unknown',
      ownedTerminals: live.length, unrelatedTerminals: proof.inventory.available ? proof.inventory.data.length - live.length : null,
      terminalsComplete: proof.inventory.complete, children: proof.children,
      goalsClear: proof.goal ? proof.goal.goal === null : null,
      goalContinuationStopped: proof.continuations.filter(item => item.kind === 'goal').every(item => item.state === 'closed'),
      queueClear: Array.isArray(proof.queue?.data) ? !proof.queue.data.length && !proof.queue.nextCursor : null,
      ...summary, verifiedStopped: terminal && proof.verifiedStopped,
      scope: 'Exact accepted connector operations and native tracked command leaders; detached processes are not guaranteed stopped.', observedAt: this.now() };
  }
  async ownedAdmissionSnapshot(thread) {
    const threadId = thread.id, reasons = [];
    const proof = await ownedScopeProof(this, threadId);
    if (thread.status?.type !== 'idle' || proof.targetBusy) reasons.push(thread.status?.type === 'notLoaded' ? 'CHAT_NOT_LOADED' : 'CHAT_NOT_IDLE');
    if (Object.values(this.store.state.operations).some(op => op.kind === 'send' && op.threadId === threadId && ['unknown', 'dispatching'].includes(op.phase) && !localLifetimeEnded(op, this.execution))) reasons.push('SEND_UNRESOLVED');
    try { await requireLocalExecution(thread, this.scope, this.store.state.threads[threadId].cwd); }
    catch { reasons.push('EXECUTION_ENVIRONMENT_UNVERIFIED'); }
    if (!proof.currentReadiness.ready) reasons.push('PREVIOUS_WORK_UNVERIFIED');
    if (proof.currentReadiness.ownedProcesses.open) reasons.push('NATIVE_PROCESSES_UNVERIFIED');
    if (!proof.goal || !Array.isArray(proof.queue?.data)) reasons.push('WORK_STATE_UNVERIFIED');
    else if (proof.queue.data.length || proof.queue.nextCursor) reasons.push('UNMANAGED_QUEUE');
    return { newStart: thread.status?.type === 'notLoaded' && !reasons.includes('SEND_UNRESOLVED') && !reasons.includes('UNMANAGED_QUEUE')
        ? 'resumeThenPreflightRequired' : reasons.length ? 'blocked' : 'preflightRequired', reasons: [...new Set(reasons)],
      ...scopeSummary(proof), currentReadiness: proof.currentReadiness, children: proof.children,
      reconciliation: { tool: 'codex_chat_reconcile', explicitActionRequired: true, mayLoadCompletedDescendants: false },
      descendantInventory: null,
      runtimeProof: { childObservation: proof.children, durableUnloadedChildClosureAvailable: false, authorizesStart: false },
      startGuarantee: 'nonAtomicPreflight', nativeGoal: this.goalPreview(proof.goal?.goal),
      nativeGoalHash: proof.goal ? this.nativeGoalHash(proof.goal.goal) : null, snapshotOnly: true, nativeAtomicStartAvailable: false };
  }
  async admissionSnapshot(thread, ops, terminals) {
    if (this.expanded) return this.ownedAdmissionSnapshot(thread);
    const threadId = thread.id, reasons = [];
    if (thread.status?.type !== 'idle') reasons.push(thread.status?.type === 'notLoaded' ? 'CHAT_NOT_LOADED' : 'CHAT_NOT_IDLE');
    if (ops.some(([, op]) => ['unknown', 'dispatching'].includes(op.phase))) reasons.push('SEND_UNRESOLVED');
    try { await requireLocalExecution(thread, this.scope, this.store.state.threads[threadId].cwd); }
    catch { reasons.push('EXECUTION_ENVIRONMENT_UNVERIFIED'); }
    if (ops.length && (!terminals?.available || !terminals.complete || terminals.data.length)) reasons.push('NATIVE_PROCESSES_UNVERIFIED');
    const proof = {};
    const children = await verifyChildren(this, threadId, ops.map(([, op]) => op.turnId), proof);
    if (children === 'unverified' || this.persistenceRetries.has(threadId)) reasons.push('PREVIOUS_WORK_UNVERIFIED');
    const goal = await this.optional('thread/goal/get', { threadId });
    const queue = await this.optional('thread/queue/list', { threadId, limit: 1 });
    if (!goal) reasons.push('WORK_STATE_UNVERIFIED');
    if (!Array.isArray(queue?.data)) reasons.push('WORK_STATE_UNVERIFIED');
    else if (queue.data.length || queue.nextCursor) reasons.push('UNMANAGED_QUEUE');
    return { newStart: thread.status?.type === 'notLoaded' && !reasons.includes('SEND_UNRESOLVED') && !reasons.includes('UNMANAGED_QUEUE') ? 'resumeThenPreflightRequired' : reasons.length ? 'blocked' : 'preflightRequired', reasons: [...new Set(reasons)], children,
      reconciliation: { tool: 'codex_chat_reconcile', explicitActionRequired: true, mayLoadCompletedDescendants: true },
      descendantInventory: proof.descendants ?? null,
      runtimeProof: { childObservation: children, durableUnloadedChildClosureAvailable: false, authorizesStart: false },
      startGuarantee: 'nonAtomicPreflight',
      nativeGoal: this.goalPreview(goal?.goal), nativeGoalHash: goal ? this.nativeGoalHash(goal.goal) : null, snapshotOnly: true, nativeAtomicStartAvailable: false };
  }
  async status(threadId, { cursor, limit = 10 } = {}) {
    await this.recoverPersistence(threadId).catch(() => {});
    const thread = await this.owned(threadId);
    await this.reconcile(threadId);
    const ops = Object.entries(this.store.state.operations).filter(([, op]) => op.threadId === threadId && op.kind === 'send');
    const binding = JSON.stringify(['status', threadId]);
    const position = this.statusCursors.decode(cursor, binding);
    const opsHash = this.goalHash(ops);
    if (position && position.hash !== opsHash) fail('STATUS_CHANGED');
    const offset = position?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ops.length) fail('INVALID_CURSOR');
    const selected = [...ops].reverse().slice(offset, offset + limit);
    const history = this.expanded || ops.length ? await this.turns(threadId) : null;
    const latest = this.expanded ? history : null;
    let progress = null;
    if (ops.length) {
      const ownedIds = new Set(ops.map(([, op]) => op.turnId)); const turn = history.data.find(t => ownedIds.has(t.id));
      if (turn) progress = { turnId: turn.id, status: turn.status, ...latestAssistantExcerpt(turn.items), commandsInProgress: (turn.items ?? []).filter(i => i.type === 'commandExecution' && i.status === 'inProgress').length, childActivityObserved: (this.store.state.threads[threadId].childTurns ?? []).includes(turn.id) || (turn.items ?? []).some(i => i.type === 'subAgentActivity' || i.type === 'collabAgentToolCall') };
    }
    const terminals = await this.terminals(threadId);
    const trackedOwnedTerminals = terminals?.available ? terminals.data.filter(x => ops.some(([, op]) => this.ownsTerminal(threadId, op.turnId, x, null))).length : null;
    if (history) this.pruneRequests(threadId, history);
    const admission = await this.admissionSnapshot(thread, ops, terminals);
    const result = { threadId, cwd: this.store.state.threads[threadId].cwd, execution: this.execution, admission,
      nativeApprovals: { ownerControlAvailable: false, observation: 'currentConnectionOnly', requestsMayBeUnobserved: true,
        pendingRequests: [...this.localRequests.values()].filter(q => q.threadId === threadId && q.kind === 'approval').length,
        reviews: [...this.nativeReviews.values()].filter(q => q.threadId === threadId).slice(-8),
        reviewCount: [...this.nativeReviews.values()].filter(q => q.threadId === threadId).length,
        requiredIntegration: 'Authenticated owner callback; native approvals remain unavailable through model tools.' },
      title: safeText(thread.name, 160).text, nativeStatus: thread.status?.type ?? 'unknown', historicalTestSends: this.store.state.liveTurns, persistenceRecovery: { pendingObservations: this.persistenceRetries.get(threadId)?.length ?? 0, state: this.persistenceRetries.has(threadId) ? 'unverified' : 'clear' }, contextDelivery: { developerConfigured: !!this.context.developer, tpmConfigured: !!this.context.tpm }, legacyWindowsEnforced: false, ...(latest ? { latestTurnId: latest.data[0]?.id ?? null, latestTurnStateKnown: latest.data.length > 0 || latest.complete } : {}), turn: progress, trackedOwnedTerminals, nativeTrackedTerminals: terminals?.available ? terminals.data.length : null, terminalInventoryComplete: terminals?.complete ?? false, tokenUsage: this.observedUsage.get(threadId) ?? null, operations: selected.map(([requestId, op]) => ({ requestId, phase: op.phase, executionState: operationExecution(op, history, this.store.state.threads[threadId].terminalTurns?.[op.turnId]), dispatchBinding: op.dispatchBinding ?? null, localExecutionLifetime: localLifetimeEnded(op, this.execution) ? 'endedByHostReboot' : 'currentOrUnestablished', turnId: op.turnId ?? null, windowId: op.windowId ?? null, deadlineAt: op.deadlineAt, deadlineEnforcement: 'disabled', ...(op.unexpectedNativeTurn ? { unexpectedNativeTurn: true } : {}),
      ...(op.nativeRejection ? { nativeRejection: op.nativeRejection } : {}),
      ...(op.rejectionVerification ? { rejectionVerification: op.rejectionVerification } : {}) })), operationCount: ops.length, nextCursor: null, stopVerification: await this.verifyStop(threadId) };
    // Fit IPC without discarding newest output. Continue older operation receipts
    // with a signed snapshot cursor rather than returning RESULT_TOO_LARGE.
    while (result.operations.length > 1 && Buffer.byteLength(JSON.stringify(result)) > 26000) result.operations.pop();
    const next = offset + result.operations.length;
    result.operationsTruncated = next < ops.length;
    result.nextCursor = next < ops.length ? this.statusCursors.encode(binding, { hash: opsHash, offset: next }) : null;
    return result;
  }
  async close() { this.closing = true; await Promise.allSettled([...this.jobs.values()].map(j => j.promise).concat([...this.completionJobs.values()])); this.native.close(); await this.store.close(); }
}
