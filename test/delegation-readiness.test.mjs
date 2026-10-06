import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { A, T } from './stage1-fixture.mjs';
import { C, D, E, F, start, interaction, completion, setup, assertUnknownOutcomes } from './delegation-readiness-fixture.mjs';

const lifecycleCases = [
  { name: 'ordinary start/completion', receivers: [E], descendantCount: 1, open: 0,
    activities: [start('launch:worker', E), completion('turn-finished:worker', E)] },
  { name: 'single interaction/completion without a start', receivers: [F], descendantCount: 1, open: 0,
    activities: [interaction('message:worker', F), completion('turn-done:worker', F)] },
  { name: 'interleaved interaction-only lifecycles', receivers: [C, D], descendantCount: 2, open: 5 },
  { name: 'start plus one interaction', receivers: [E], descendantCount: 22, open: 2,
    activities: [start('job-start/1', E), interaction('message/1', E), completion('child-turn/1', E)] },
  { name: 'start plus multiple interactions', receivers: [F], descendantCount: 67, open: 4,
    activities: [start('run-80', F), interaction('input-81', F), interaction('input-82', F),
      interaction('input-83', F), completion('finished-84', F)] },
  { name: 'interleaved receivers with starts and multiple interactions', receivers: [E, F], descendantCount: 4, open: 6,
    activities: [start('launch-left', E), interaction('left-input-1', E), start('launch-right', F),
      interaction('right-input-1', F), interaction('left-input-2', E), completion('left-finished', E),
      interaction('right-input-2', F), completion('right-finished', F)] },
  { name: 'repeated completed follow-up cycles', receivers: [F], descendantCount: 3, open: 7,
    activities: [start('initial-launch', F), interaction('initial-input-1', F), interaction('initial-input-2', F), completion('initial-finished', F),
      interaction('next-input-1', F), interaction('next-input-2', F), completion('next-finished', F),
      interaction('final-input-1', F), interaction('final-input-2', F), completion('final-finished', F)] },
];

for (const scenario of lifecycleCases) test(`delegated-agent ${scenario.name} admits after reconnect with exact outcomes preserved`, async t => {
  const s = await setup(t, scenario);
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, true);
  assert.equal(status.admission.currentReadiness.delegationReadiness.unready, 0);
  if (scenario.open) assertUnknownOutcomes(s, status.admission, scenario.open);
  else assert.equal(status.admission.ownedDelegations.open, 0);
  await s.restart();
  const begin = s.f.calls.length;
  const reconciled = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(reconciled.phase, 'verified');
  assert.equal(reconciled.currentReadiness.ready, true);
  assert.equal(reconciled.historicalUnknowns.open, scenario.open);
  assert.deepEqual(reconciled.resumedDescendants, []);
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, scenario.open === 0);
  assert.equal(stopped.ownedDelegations.open, scenario.open);
  if (scenario.open) assertUnknownOutcomes(s, stopped, scenario.open);
  const childIds = new Set([...s.f.threads.keys()].filter(id => id !== A));
  assert.equal(s.f.calls.slice(begin).some(q => childIds.has(q.params?.threadId) &&
    ['thread/resume', 'thread/items/list', 'thread/turns/list', 'turn/start', 'turn/interrupt', 'thread/backgroundTerminals/terminate'].includes(q.method)), false);
  // A new send exercises dispatch and both fresh rechecks for every event shape.
  s.f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const turn = { id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: 'next', clientId: q.params.clientUserMessageId, content: q.params.input }] };
    s.root.turns.push(turn); s.root.status = { type: 'active' };
    socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  const sent = await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true });
  assert.equal(sent.phase, 'accepted');
  assert.notEqual(sent.turnId, T);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 2);
});

for (const startedLifecycle of [false, true]) for (const check of ['status', 'reconcile', 'send']) test(`consumed completion blocks ${startedLifecycle ? 'started/interacted' : 'interaction-only'} ${check} after reconnect`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  s.turn.items = s.turn.items.filter(x => x.id !== 'c2');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.ownedDelegations.open, 0);
  const originalClosure = structuredClone(s.c.store.state.threads[A].ownedObligations.turns[T].delegationClosures.c1);
  assert.equal(originalClosure.completionId, 'c-done');
  // Omit the closed launch, then present two unresolved activities before its consumed receipt.
  s.turn.items.splice(1, s.turn.items.length - 1,
    startedLifecycle ? start('new-start', C) : interaction('new-input-1', C),
    interaction('new-input-2', C), completion('c-done', C));
  await s.restart();
  if (check === 'status') {
    const status = await s.c.call('codex_chat_status', { threadId: A });
    assert.equal(status.admission.currentReadiness.ready, false);
    assert.equal(status.admission.currentReadiness.delegationReadiness.unready, 2);
    assert.equal(status.admission.ownedDelegations.open, 2);
    const unresolved = status.admission.ownedDelegations.items.filter(x => x.itemId !== 'c1');
    assert.equal(unresolved.length, 2);
    assert.ok(unresolved.every(x => x.state === 'unknown' && !x.childStopAuthorized));
  } else if (check === 'reconcile') {
    const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
    assert.equal(result.phase, 'unverified');
    assert.equal(result.code, 'PREVIOUS_WORK_UNVERIFIED');
    assert.equal(result.modelTurnStarted, false);
  } else {
    await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  }
  assert.deepEqual(s.c.store.state.threads[A].ownedObligations.turns[T].delegationClosures, { c1: originalClosure });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const startedLifecycle of [false, true]) for (const variant of ['active', 'goal', 'queue', 'process', 'later interaction', 'incomplete history', 'unavailable history']) test(`${startedLifecycle ? 'started/interacted' : 'interacted'} send recheck rejects ${variant} after readiness snapshot`, async t => {
  const s = await setup(t, { startedLifecycle });
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'verified');
  const request = s.c.native.request.bind(s.c.native); let reads = 0;
  s.c.native.request = async (method, params, options) => {
    if (method === 'thread/read' && params.threadId === C) reads++;
    if (reads >= 2 && variant === 'unavailable history' && method === 'thread/turns/list') throw Object.assign(new Error('History unavailable'), { code: 'UNSUPPORTED_RPC' });
    if (reads >= 2 && params.threadId === C) {
      if (variant === 'active' && method === 'thread/read') return { thread: { ...s.f.threads.get(C), status: { type: 'active' } } };
      if (variant === 'goal' && method === 'thread/goal/get') return { goal: { status: 'active' } };
      if (variant === 'queue' && method === 'thread/queue/list') return { data: [{ id: 'new' }], nextCursor: null };
      if (variant === 'process') {
        s.f.threads.get(C).status = { type: 'idle' };
        if (method === 'thread/backgroundTerminals/list') return { data: [{ itemId: 'live', processId: '42', cwd: s.f.cwd }], nextCursor: null };
      }
      if (variant === 'later interaction' && !s.turn.items.some(x => x.id === 'later')) s.turn.items.push(interaction('later', C));
      if (variant === 'incomplete history') s.turn.itemsView = 'summary';
    }
    return request(method, params, options);
  };
  const sent = await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true });
  assert.equal(sent.phase, 'notDispatched');
  assert.equal(sent.code, 'PREVIOUS_WORK_UNVERIFIED');
  assert.ok(reads >= 2);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const startedLifecycle of [false, true]) test(`${startedLifecycle ? 'started/interacted' : 'interacted'} unloaded delegated agents need no inventory RPC or reattachment; readiness is not a durable closure`, async t => {
  const s = await setup(t, { startedLifecycle });
  s.f.handle = (socket, q) => {
    if ([C, D].includes(q.params?.threadId) && q.method === 'thread/backgroundTerminals/list') {
      socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Not loaded' } })); return true;
    }
  };
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  assert.equal(s.f.calls.some(q => [C, D].includes(q.params?.threadId) && q.method === 'thread/backgroundTerminals/list'), false);
  await s.restart();
  s.f.threads.get(C).status = { type: 'active' };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, false);
  assert.equal(status.admission.runtimeProof.durableUnloadedChildClosureAvailable, false);
  if (startedLifecycle) assert.equal(status.admission.ownedDelegations.open, 2);
  else assertUnknownOutcomes(s, status.admission);
});

for (const variant of ['summary', 'unavailable', 'missing turn', 'missing status', 'unknown status']) test(`reconnect cannot recycle cached started/interacted readiness with ${variant} history`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  await s.restart();
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const turn = { ...s.turn };
    if (variant === 'summary') turn.itemsView = 'summary';
    if (variant === 'missing status') delete turn.status;
    if (variant === 'unknown status') turn.status = 'unknown';
    const response = variant === 'unavailable' ? { error: { code: -32601, message: 'Unsupported' } }
      : { result: { data: variant === 'missing turn' ? [] : [turn], nextCursor: null } };
    socket.send(JSON.stringify({ id: q.id, ...response })); return true;
  };
  const reconciled = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(reconciled.phase, 'unverified');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.ownedDelegations.open, 2);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const lateInteraction of [false, true]) test(`unavailable later history page blocks cached lifecycle readiness${lateInteraction ? ' with new interaction' : ''}`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  if (lateInteraction) s.turn.items.push(interaction('late', C));
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const response = q.params.cursor ? { error: { code: -32601, message: 'Unsupported history page' } }
      : { result: { data: [s.turn], nextCursor: 'unavailable-page' } };
    socket.send(JSON.stringify({ id: q.id, ...response })); return true;
  };
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'unverified');
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const variant of ['terminal summary', 'missing status', 'unknown status', 'unavailable history', 'malformed cursor']) test(`repaired lifecycle readiness requires fresh terminal evidence: ${variant}`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  s.turn.itemsView = 'summary';
  await s.c.turns(A);
  assert.equal(s.c.store.state.threads[A].ownedObligations.turns[T].fullItemsObserved, false);
  await s.restart();
  s.f.handle = (socket, q) => {
    if (q.method === 'turn/start') {
      const turn = { id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: 'next', clientId: q.params.clientUserMessageId, content: q.params.input }] };
      s.root.turns.push(turn); s.root.status = { type: 'active' };
      socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
    }
    if (q.method === 'thread/items/list') {
      socket.send(JSON.stringify({ id: q.id, result: { data: s.turn.items.map(item => ({ turnId: T, item })), nextCursor: null } })); return true;
    }
    if (q.method !== 'thread/turns/list' || s.root.turns.length > 1) return;
    const turn = { ...s.turn };
    if (variant === 'missing status') delete turn.status;
    if (variant === 'unknown status') turn.status = 'unknown';
    const response = variant === 'unavailable history' ? { error: { code: -32601, message: 'Unsupported' } }
      : { result: { data: [turn], ...(variant === 'malformed cursor' ? {} : { nextCursor: null }) } };
    socket.send(JSON.stringify({ id: q.id, ...response })); return true;
  };
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(result.phase, variant === 'terminal summary' ? 'verified' : 'unverified');
  assert.equal(result.modelTurnStarted, false);
  assert.ok(s.f.calls.some(q => q.method === 'thread/items/list'), 'The complete item-repair path must be exercised');
  assert.equal(s.c.store.state.threads[A].ownedObligations.turns[T].fullItemsObserved, true);
  assert.equal(Object.keys(s.c.store.state.threads[A].ownedObligations.turns[T].delegationClosures ?? {}).length, 0);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  if (variant === 'terminal summary') {
    for (let pass = 0; pass < 2; pass++)
      assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
    await s.restart();
    assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'verified');
    const before = s.f.calls.filter(q => q.method === 'thread/items/list').length;
    const sent = await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true });
    assert.equal(sent.phase, 'accepted');
    assert.ok(s.f.calls.filter(q => q.method === 'thread/items/list').length >= before + 2, 'Both send rechecks obtain fresh item proof');
    assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 2);
  }
});

for (const variant of ['missing cursor', 'unsupported later page', 'repeated cursor']) test(`partial history retains newly observed obligations: ${variant}`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  s.turn.items = s.turn.items.filter(x => x.id !== 'c2');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.ownedDelegations.open, 0);
  const closure = structuredClone(s.c.store.state.threads[A].ownedObligations.turns[T].delegationClosures.c1);
  s.turn.items.push(interaction('late-input', C));
  await s.restart();
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const response = q.params.cursor && variant === 'unsupported later page' ? { error: { code: -32601, message: 'Unsupported page' } }
      : { result: { data: q.params.cursor ? [] : [s.turn], ...(variant === 'missing cursor' ? {} : { nextCursor: 'later' }) } };
    socket.send(JSON.stringify({ id: q.id, ...response })); return true;
  };
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(result.phase, 'unverified');
  assert.equal(result.modelTurnStarted, false);
  const owned = s.c.store.state.threads[A].ownedObligations.turns[T];
  assert.equal(owned.items['late-input'].kind, 'interacted');
  assert.deepEqual(owned.delegationClosures, { c1: closure });
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const variant of ['missing', 'empty', 'false', 'oversized', 'repeated']) test(`malformed root history cursor blocks started/interacted readiness: ${variant}`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const nextCursor = { empty: '', false: false, oversized: 'x'.repeat(2049), repeated: 'repeat' }[variant];
    const result = { data: variant === 'repeated' && q.params.cursor ? [] : [s.turn], ...(variant === 'missing' ? {} : { nextCursor }) };
    socket.send(JSON.stringify({ id: q.id, result })); return true;
  };
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'unverified');
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
