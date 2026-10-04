import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Discovery } from '../src/discovery.mjs';
import { ProjectScope, Cursors, SafeError, safeText } from '../src/safety.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const thread = (id, cwd, extra = {}) => ({ id, cwd, name: 'Example', source: 'cli', status: { type: 'idle' }, ...extra });
async function fixture(t, handler = () => ({})) {
  const base = await mkdtemp('/tmp/codex-dot-unit-');
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'Projects');
  const outside = path.join(base, 'Projects-escape');
  await mkdir(root); await mkdir(outside); await mkdir(path.join(root, 'Alpha')); await mkdir(path.join(root, 'Beta'));
  await mkdir(path.join(root, 'Alpha', '.git')); await writeFile(path.join(root, 'Beta', '.git'), 'gitdir: secret-not-read');
  await symlink(outside, path.join(root, 'escape')); await symlink(path.join(root, 'Alpha'), path.join(root, 'alias'));
  const calls = [];
  const backend = { async request(method, params) { calls.push({ method, params }); return handler(method, params, calls); }, close() {} };
  return { root, outside, calls, scope: new ProjectScope(root), service: new Discovery({ scope: new ProjectScope(root), backend }) };
}

test('shallow repositories, aliases deduplicated, signed pagination and dynamic changes', async t => {
  const { service, root } = await fixture(t);
  const first = await service.call('codex_repositories_list', { limit: 1 });
  assert.equal(first.repositories[0].repository, 'Alpha'); assert.ok(first.nextCursor);
  const second = await service.call('codex_repositories_list', { limit: 1, cursor: first.nextCursor });
  assert.equal(second.repositories[0].repository, 'Beta'); assert.equal(second.nextCursor, null);
  await mkdir(path.join(root, 'New')); await mkdir(path.join(root, 'New', '.git'));
  assert.equal((await service.call('codex_repositories_list', {})).repositories.length, 3);
  await assert.rejects(service.call('codex_repositories_list', { limit: 2, cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  await assert.rejects(service.call('codex_repositories_list', { cursor: first.nextCursor + 'x' }), { code: 'INVALID_CURSOR' });
});

test('scope rejects traversal, prefix tricks, symlink escapes, missing and ambiguous cwd', async t => {
  const { root, outside, scope } = await fixture(t);
  assert.equal(await scope.directory('alias'), path.join(root, 'Alpha'));
  for (const bad of ['../Projects/Alpha', 'Alpha/../Beta', outside, 'escape', '', null, 'missing', '/tmp', 'Alpha\0']) {
    await assert.rejects(scope.directory(bad), { code: 'OUT_OF_SCOPE' });
  }
  for (const bad of [undefined, null, 'Alpha', '../Alpha', path.join(root, 'escape')]) {
    await assert.rejects(scope.cwd(bad), { code: 'OUT_OF_SCOPE' });
  }
});

test('chat pages filter hostile cwd before publishing useful fields; no previews or raw config', async t => {
  const f = await fixture(t, (m, p) => ({ data: p.cursor ? [thread(B, path.join(f.root, 'Beta'))] : [
    thread(A, f.outside), thread(B, path.join(f.root, 'Alpha'), { name: 'api_key=sk-secretvalue123456', preview: 'secret', path: '/secret/store', config: { secret: true } }),
  ], nextCursor: p.cursor ? null : 'page2' }));
  const first = await f.service.call('codex_chats_list', { limit: 2 });
  assert.equal(first.chats.length, 1); assert.equal(first.chats[0].cwd, path.join(f.root, 'Alpha'));
  assert.ok(!JSON.stringify(first).includes('sk-secretvalue')); assert.equal(first.chats[0].titleRedacted, true);
  assert.equal(first.chats[0].preview, undefined); assert.equal(first.chats[0].config, undefined);
  const next = await f.service.call('codex_chats_list', { limit: 2, cursor: first.nextCursor });
  assert.equal(next.chats[0].threadId, B);
  await assert.rejects(f.service.call('codex_chats_list', { repository: 'Beta', limit: 2, cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  assert.ok(f.calls.every(c => c.method === 'thread/list' && c.params.useStateDbOnly === true));
});

test('empty filtered pages advance with a bounded scan and reject non-progressing backend cursors', async t => {
  const f = await fixture(t, (m, p, calls) => ({ data: [thread(A, f.outside)], nextCursor: 'page' + calls.length }));
  const page = await f.service.call('codex_chats_list', { limit: 1 });
  assert.deepEqual(page.chats, []); assert.ok(page.nextCursor); assert.equal(f.calls.length, 5);
  const stuck = await fixture(t, () => ({ data: [], nextCursor: 'stuck' }));
  await assert.rejects(stuck.service.call('codex_chats_list', {}), { code: 'INVALID_BACKEND_RESPONSE' });
});

test('history refuses out-of-scope metadata before any content dispatch', async t => {
  for (const kind of ['outside', 'missing', 'relative', 'symlink']) {
    const f = await fixture(t, () => ({ thread: thread(A, kind === 'outside' ? f.outside : kind === 'symlink' ? path.join(f.root, 'escape') : kind === 'relative' ? 'Alpha' : undefined) }));
    await assert.rejects(f.service.call('codex_chat_history', { threadId: A }), { code: 'OUT_OF_SCOPE' });
    assert.deepEqual(f.calls.map(c => c.method), ['thread/read']);
    assert.equal(f.calls[0].params.includeTurns, false);
  }
});

test('bounded history text, credential redaction, pagination binding and omitted unsafe item types', async t => {
  const f = await fixture(t, (m, p) => m === 'thread/read' ? { thread: thread(A, path.join(f.root, 'Alpha')) } : {
    data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'userMessage', content: [{ type: 'text', text: 'Bearer verysecret api_key=secretvalue' }, { type: 'localImage', path: '/private' }] } },
      { turnId: 'turn-1', item: { id: 'msg-2', type: 'reasoning', text: 'do-not-output' } },
      { turnId: 'turn-1', item: { id: 'msg-3', type: 'agentMessage', text: 'x'.repeat(20000) } },
    ], nextCursor: p.cursor ? null : 'native-history-cursor',
  });
  const page = await f.service.call('codex_chat_history', { threadId: A, limit: 3, maxChars: 200 });
  assert.equal(page.entries.length, 2); assert.equal(page.omittedNonMessageItems, 1);
  assert.ok(page.entries.reduce((n, e) => n + e.text.length, 0) <= 200); assert.equal(page.entries[1].truncated, true);
  assert.ok(!JSON.stringify(page).includes('verysecret')); assert.ok(!JSON.stringify(page).includes('/private'));
  assert.ok(!JSON.stringify(page).includes('do-not-output'));
  await assert.rejects(f.service.call('codex_chat_history', { threadId: B, limit: 3, maxChars: 200, cursor: page.nextCursor }), { code: 'INVALID_CURSOR' });
  const continued = await f.service.call('codex_chat_history', { threadId: A, limit: 3, maxChars: 200, cursor: page.nextCursor });
  assert.equal(f.calls[4].params.cursor, null); // Finish the truncated native page before advancing.
  assert.ok(continued.entries[0].textOffset > 0);
});

test('legacy history uses one-turn official pagination, never includeTurns true or full-thread hydration', async t => {
  const f = await fixture(t, m => {
    if (m === 'thread/read') return { thread: thread(A, path.join(f.root, 'Alpha')) };
    if (m === 'thread/items/list') throw new SafeError('HISTORY_UNAVAILABLE');
    return { data: [{ id: 'turn-1', items: [{ id: 'm1', type: 'agentMessage', text: 'answer' }] }], nextCursor: null };
  });
  const page = await f.service.call('codex_chat_history', { threadId: A });
  assert.equal(page.paginationUnit, 'turns'); assert.equal(page.entries[0].text, 'answer');
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'thread/items/list', 'thread/turns/list', 'thread/read']);
  assert.equal(f.calls[2].params.limit, 1); assert.ok(f.calls.every(c => c.params.includeTurns !== true));
});

test('long legacy turn exposes newest final first and complete text through bounded continuation', async t => {
  const final = 'LATEST RESULT ' + 'r'.repeat(700);
  const f = await fixture(t, m => {
    if (m === 'thread/read') return { thread: thread(A, path.join(f.root, 'Alpha')) };
    if (m === 'thread/items/list') throw new SafeError('HISTORY_UNAVAILABLE');
    return { data: [{ id: 'turn-1', items: [
      { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'p'.repeat(16000) }] },
      { id: 'commentary', type: 'agentMessage', text: 'EARLY UPDATE' },
      { id: 'final', type: 'agentMessage', phase: 'final_answer', text: final },
    ] }], nextCursor: null };
  });
  let page = await f.service.call('codex_chat_history', { threadId: A, maxChars: 200 });
  assert.equal(page.entries[0].itemId, 'final'); assert.equal(page.entries[0].phase, 'final_answer');
  let recovered = '';
  for (let i = 0; i < 5; i++) {
    recovered += page.entries.filter(e => e.itemId === 'final').map(e => e.text).join('');
    assert.ok(page.entries.reduce((n, e) => n + e.text.length, 0) <= 200);
    if (recovered.length === final.length) break;
    assert.ok(page.nextCursor); page = await f.service.call('codex_chat_history', { threadId: A, maxChars: 200, cursor: page.nextCursor });
  }
  assert.equal(recovered, final);
  assert.ok(f.calls.every(c => c.params.includeTurns !== true));
});

test('text continuations redact before slicing and reject changed message evidence', async t => {
  let text = 'Bearer secretvalue123 ' + 'x'.repeat(600);
  const f = await fixture(t, m => m === 'thread/read' ? { thread: thread(A, path.join(f.root, 'Alpha')) } : {
    data: [{ turnId: 'turn-1', item: { id: 'final', type: 'agentMessage', text } }], nextCursor: null,
  });
  const first = await f.service.call('codex_chat_history', { threadId: A, maxChars: 200 });
  assert.ok(first.nextCursor); assert.ok(!JSON.stringify(first).includes('secretvalue123'));
  const second = await f.service.call('codex_chat_history', { threadId: A, maxChars: 200, cursor: first.nextCursor });
  assert.ok(!JSON.stringify(second).includes('secretvalue123')); assert.equal(second.entries[0].textOffset, 200);
  text += 'changed';
  await assert.rejects(f.service.call('codex_chat_history', { threadId: A, maxChars: 200, cursor: first.nextCursor }), { code: 'HISTORY_CHANGED' });
});

test('public cursor evidence cannot verify guessed redacted secrets; secret changes invalidate offsets', async t => {
  let secret = 'guessable-password';
  const suffix = ' ' + 'x'.repeat(600);
  const f = await fixture(t, m => m === 'thread/read' ? { thread: thread(A, path.join(f.root, 'Alpha')) } : {
    data: [{ turnId: 'turn-1', item: { id: 'final', type: 'agentMessage', text: `password=${secret}${suffix}` } }], nextCursor: null,
  });
  const page = await f.service.call('codex_chat_history', { threadId: A, maxChars: 200 });
  assert.ok(page.nextCursor); assert.ok(!JSON.stringify(page).includes(secret));
  const { position } = JSON.parse(Buffer.from(page.nextCursor.split('.')[0], 'base64url').toString());
  for (const guess of ['guessable-password', 'wrong-password']) {
    const rawDigest = createHash('sha256').update(JSON.stringify([[['turn-1', 'final', 'agentMessage', null, `password=${guess}${suffix}`]], null])).digest('hex');
    assert.notEqual(position.fingerprint, rawDigest);
  }
  secret = 'changed-password';
  await assert.rejects(f.service.call('codex_chat_history', { threadId: A, maxChars: 200, cursor: page.nextCursor }), { code: 'HISTORY_CHANGED' });
  assert.equal((await f.service.call('codex_chat_history', { threadId: A, maxChars: 200 })).entries[0].text, page.entries[0].text);
});

test('Unicode history obeys encoded output bound while retaining a continuation', async t => {
  const f = await fixture(t, m => m === 'thread/read' ? { thread: thread(A, path.join(f.root, 'Alpha')) } : {
    data: [{ turnId: 'turn-1', item: { id: 'final', type: 'agentMessage', text: '界'.repeat(12000) } }], nextCursor: null,
  });
  const page = await f.service.call('codex_chat_history', { threadId: A, maxChars: 12000 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768); assert.ok(page.nextCursor);
});

test('text continuation completes current message before advancing native page cursor', async t => {
  const f = await fixture(t, (m, p) => m === 'thread/read' ? { thread: thread(A, path.join(f.root, 'Alpha')) } : {
    data: [{ turnId: 'turn-1', item: { id: p.cursor ? 'older' : 'final', type: 'agentMessage', text: p.cursor ? 'older result' : 'r'.repeat(600) } }],
    nextCursor: p.cursor ? null : 'native-page2',
  });
  let cursor; let final = '';
  for (let i = 0; i < 3; i++) {
    const page = await f.service.call('codex_chat_history', { threadId: A, maxChars: 200, ...(cursor ? { cursor } : {}) });
    final += page.entries[0].text; cursor = page.nextCursor;
  }
  assert.equal(final, 'r'.repeat(600));
  const older = await f.service.call('codex_chat_history', { threadId: A, maxChars: 200, cursor });
  assert.equal(older.entries[0].itemId, 'older'); assert.equal(older.nextCursor, null);
  assert.deepEqual(f.calls.filter(c => c.method === 'thread/items/list').map(c => c.params.cursor ?? null), [null, null, null, 'native-page2']);
});

test('history discards fetched data if cwd changes during request; aliases rechecked', async t => {
  let reads = 0;
  const f = await fixture(t, m => m === 'thread/read' ? { thread: thread(A, ++reads === 1 ? path.join(f.root, 'Alpha') : f.outside) } : { data: [], nextCursor: null });
  await assert.rejects(f.service.call('codex_chat_history', { threadId: A }), { code: 'OUT_OF_SCOPE' });
});

test('strict schemas enforce sizes, types, unknown fields and reject arbitrary controls', async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ['codex_chats_list', { limit: 0 }], ['codex_chats_list', { limit: 21 }], ['codex_chats_list', { repository: null }],
    ['codex_chat_history', { threadId: '../secret' }], ['codex_chat_history', { threadId: A, maxChars: 12001 }],
    ['codex_chat_history', { threadId: A, includeTurns: true }], ['codex_chat_history', { threadId: A, method: 'turn/start' }],
    ['codex_repositories_list', { cursor: 'x'.repeat(4097) }], ['codex_chats_list', { archived: 'yes' }],
  ]) await assert.rejects(f.service.call(name, args), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.calls, []);
});

test('private key blocks, token patterns and labeled credentials are scrubbed before clipping', () => {
  const value = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\npassword="shhh" ghp_12345678901234567890';
  const result = safeText(value, 1000); assert.equal(result.redacted, true);
  for (const secret of ['abc', 'shhh', 'ghp_']) assert.ok(!result.text.includes(secret));
  const c = new Cursors(); assert.throws(() => c.decode('malformed', 'binding'), { code: 'INVALID_CURSOR' });
  assert.throws(() => new Cursors().decode(c.encode('a', 1), 'a'), { code: 'INVALID_CURSOR' });
});

test('changing a listing alias to outside during pagination prevents publication', async t => {
  const f = await fixture(t, async () => {
    // Root validation is awaitable after the first scoped row; interleave another row's check.
    return { data: [thread(A, path.join(f.root, 'alias')), thread(B, path.join(f.root, 'Beta'))] };
  });
  const original = f.service.scope.cwd.bind(f.service.scope);
  let calls = 0;
  f.service.scope.cwd = async value => {
    if (++calls === 2) { await rm(path.join(f.root, 'alias')); await symlink(f.outside, path.join(f.root, 'alias')); }
    return original(value);
  };
  const page = await f.service.call('codex_chats_list', { limit: 2 });
  assert.deepEqual(page.chats.map(c => c.threadId), [B]);
});

test('oversized native pages, mismatched thread identity and missing cwd fail closed', async t => {
  const f = await fixture(t, () => ({ data: Array.from({ length: 21 }, () => thread(A, f.root)) }));
  await assert.rejects(f.service.call('codex_chats_list', {}), { code: 'INVALID_BACKEND_RESPONSE' });
  const wrong = await fixture(t, () => ({ thread: thread(B, wrong.root) }));
  await assert.rejects(wrong.service.call('codex_chat_history', { threadId: A }), { code: 'INVALID_BACKEND_RESPONSE' });
  assert.equal(wrong.calls.length, 1);
});

test('cursor expiration and quoted JSON credential redaction', () => {
  const c = new Cursors(); const token = c.encode('scope', 1);
  const now = Date.now; Date.now = () => now() + 1800001;
  try { assert.throws(() => c.decode(token, 'scope'), { code: 'INVALID_CURSOR' }); } finally { Date.now = now; }
  assert.ok(!safeText('{"api_key":"unmarked-private-value"}', 1000).text.includes('unmarked-private-value'));
});
