import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { mergeChildItems } from '../src/stage1/children.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';
const CHILD = '55555555-5555-4555-8555-555555555555';
async function setup(t) {
 const f = await fixture(t); let clock = Date.now();
 const options = { socketPath: f.socket, root: f.root, stateDir: f.dir + '/state', now: () => clock };
 let c = await Controller.open(options); t.after(() => c.close());
 await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Renewal children' });
 const approve = async () => { await c.preflight(A); return { phase: 'opened' }; };
 const window = await approve(); await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, windowId: window.windowId, text: 'Synthetic work' });
 const root = f.threads.get(A); root.turns[0].items.push({ type: 'subAgentActivity', id: 'child-item', agentThreadId: CHILD }); root.turns[0].status = 'completed'; root.status = { type: 'idle' };
 const child = f.thread(CHILD); child.parentThreadId = A; child.turns = [{ id: randomUUID(), status: 'completed', items: [] }]; f.threads.set(CHILD, child);
 return { f, child, root, approve, get c() { return c; }, expire() { clock += 10000; }, async restart() { await c.close(); c = await Controller.open(options); } };
}
test('completed children permit approved renewal after expiry/restart without erasing history', async t => {
 const s = await setup(t); await s.c.call('codex_chat_status', { threadId: A }); s.root.turns = []; s.expire(); await s.restart();
 assert.equal((await s.approve()).phase, 'opened'); assert.deepEqual(s.c.store.state.threads[A].childTurns, [T]);
 assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
for (const state of ['active','unknown','wrong-parent','missing-history','terminal-running','goal','queue','nested-unknown','legacy-unknown']) test(`blocks ${state} and recovers only on proof`, async t => {
 const s = await setup(t); const original = structuredClone(s.child);
 if (state === 'active') { s.child.status = { type: 'active' }; s.child.turns[0].status = 'inProgress'; }
 if (state === 'unknown') s.f.threads.delete(CHILD);
 if (state === 'wrong-parent') s.child.parentThreadId = R;
 if (state === 'missing-history') s.child.turns = [];
 if (state === 'nested-unknown') s.child.turns[0].items = [{ type: 'subAgentActivity', id: 'nested' }];
 if (state === 'legacy-unknown') { s.root.turns[0].items = []; await s.c.store.update(x => { x.threads[A].childTurns = [T]; }); }
 if (['terminal-running','goal','queue'].includes(state)) s.f.handle = (socket,q) => {
  if (q.params?.threadId !== CHILD) return;
  const result = state === 'terminal-running' && q.method === 'thread/backgroundTerminals/list' ? { data: [{ processId:'child-process' }], nextCursor:null }
   : state === 'goal' && q.method === 'thread/goal/get' ? { goal:{ objective:'Still running' } }
   : state === 'queue' && q.method === 'thread/queue/list' ? { data:[{}], nextCursor:null } : null;
  if (!result) return; socket.send(JSON.stringify({id:q.id,result})); return true;
 };
 s.expire(); await s.restart(); await assert.rejects(s.approve(), { code:'PREVIOUS_WORK_UNVERIFIED' });
 assert.ok(s.c.store.state.threads[A].childTurns.includes(T));
 assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD && /interrupt|terminate|resume|start|steer/.test(q.method)), false);
 if (state !== 'legacy-unknown') { s.f.handle=null; s.f.threads.set(CHILD,original); await s.restart(); assert.equal((await s.approve()).phase,'opened'); }
});
test('completed nested collaborators are verified recursively; cycles and truncated child history block', async t => {
 const s = await setup(t); const nested = '66666666-6666-4666-8666-666666666666';
 const child = s.f.thread(nested); child.parentThreadId = CHILD; child.turns = [{ id:randomUUID(), status:'completed', items:[] }]; s.f.threads.set(nested, child);
 s.child.turns[0].items = [{type:'collabAgentToolCall', id:'nested-collab', receiverThreadIds:[nested]}];
 s.root.turns[0].items.push({type:'collabAgentToolCall', id:'root-collab', receiverThreadIds:[CHILD]});
 s.expire(); await s.restart(); assert.equal((await s.approve()).phase,'opened');
 s.expire(); child.turns[0].items = [{type:'subAgentActivity', id:'cycle', agentThreadId:CHILD}];
 await assert.rejects(s.approve(), {code:'PREVIOUS_WORK_UNVERIFIED'});
 child.turns[0].items = [];
 s.f.handle = (socket,q) => { if(q.method !== 'thread/turns/list' || q.params.threadId !== CHILD) return;
  socket.send(JSON.stringify({id:q.id,result:{data:s.child.turns,nextCursor:'still-more'}})); return true; };
 await assert.rejects(s.approve(), {code:'PREVIOUS_WORK_UNVERIFIED'});
});
test('notification-only child identities survive restart, preserving unknown evidence', async t => {
 const s = await setup(t); s.root.turns[0].items = [];
 await s.c.event({method:'item/started',params:{threadId:A,turnId:T,item:{type:'subAgentActivity',id:'notified-child',agentThreadId:CHILD}}});
 await s.c.store.update(() => {}); s.expire(); await s.restart();
 assert.equal((await s.approve()).phase,'opened'); assert.ok(s.c.store.state.threads[A].childItems[T].length);
});
test('conflicting same-item child identities retain both observations and block active predecessor', async t => {
 const s = await setup(t); const second = '77777777-7777-4777-8777-777777777777';
 const child = s.f.thread(second); child.parentThreadId=A; child.turns=[{id:randomUUID(),status:'completed',items:[]}]; s.f.threads.set(second,child);
 await s.c.call('codex_chat_status',{threadId:A});
 s.root.turns[0].items.find(x => x.id === 'child-item').agentThreadId=second;
 s.child.status={type:'active'}; s.child.turns[0].status='inProgress'; s.expire();
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});
 assert.deepEqual(new Set(s.c.store.state.threads[A].terminalTurns[T].childItems[0].agentThreadIds),new Set([CHILD,second]));
 s.child.status={type:'idle'}; s.child.turns[0].status='completed'; await s.restart();
 assert.equal((await s.approve()).phase,'opened');
});
test('a child observation arriving during verification blocks renewal until reverified', async t => {
 const s = await setup(t); s.expire(); let injected = false;
 s.f.handle = async (socket,q) => {
  if (injected || q.method !== 'thread/read' || q.params.threadId !== CHILD) return;
  injected = true;
  await s.c.event({method:'item/started',params:{threadId:A,turnId:T,item:{type:'subAgentActivity',id:'new-unverified-child',agentThreadId:'88888888-8888-4888-8888-888888888888'}}});
  await s.c.store.update(() => {});
 };
 await assert.rejects(s.approve(), {code:'PREVIOUS_WORK_UNVERIFIED'}); assert.equal(injected,true);
 assert.ok(s.c.store.state.threads[A].childItems[T].some(item => item.id === 'new-unverified-child'));
});
test('new evidence during final root read cannot bypass atomic renewal admission', async t => {
 const s = await setup(t); s.expire(); let childRead=false, injected=false;
 s.f.handle = async (socket,q) => {
  if (q.method !== 'thread/read') return;
  if (q.params.threadId === CHILD) childRead=true;
  if (q.params.threadId !== A || !childRead || injected) return;
  injected=true;
  await s.c.event({method:'item/started',params:{threadId:A,turnId:T,item:{type:'subAgentActivity',id:'late-child',agentThreadId:'88888888-8888-4888-8888-888888888888'}}});
  await s.c.store.update(() => {});
 };
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'}); assert.equal(injected,true);
});
test('native reviewer interaction with its proven parent permits stop verification and renewal', async t => {
 const s=await setup(t);
 s.root.turns[0].items[1].kind='interacted';
 s.child.turns[0].items=[{type:'subAgentActivity',id:'reply-to-parent',kind:'interacted',agentThreadId:A}];
 s.expire();await s.restart();
 await s.c.store.update(x=>{x.threads[A].lastStop={turnId:T,acknowledged:true};});
 assert.equal((await s.c.call('codex_chat_status',{threadId:A})).stopVerification.verifiedStopped,true);
 assert.equal((await s.approve()).phase,'opened');
 assert.equal(s.f.calls.filter(q=>q.method==='turn/start').length,1);
});
for(const state of ['active','missing','wrong-parent','unknown-kind','missing-kind','started-kind','parent-active','parent-process','parent-goal','parent-queue'])test(`parent interaction preserves blocking ${state}`,async t=>{
 const s=await setup(t);
 s.child.turns[0].items=[{type:'subAgentActivity',id:'reply-to-parent',kind:'interacted',agentThreadId:A}];
 if(state==='active'){s.child.status={type:'active'};s.child.turns[0].status='inProgress';}
 if(state==='missing')s.f.threads.delete(CHILD);
 if(state==='wrong-parent')s.child.parentThreadId=R;
 if(state==='unknown-kind')s.child.turns[0].items[0].kind='unrecognized';
 if(state==='missing-kind')delete s.child.turns[0].items[0].kind;
 if(state==='started-kind')s.child.turns[0].items[0].kind='started';
 s.expire();await s.c.reconcile(A);
 if(state==='parent-active')s.root.status={type:'active'};
 if(['parent-process','parent-goal','parent-queue'].includes(state))s.f.handle=(socket,q)=>{
  if(q.params?.threadId!==A)return;
  const result=state==='parent-process'&&q.method==='thread/backgroundTerminals/list'?{data:[{processId:'parent-process'}],nextCursor:null}
   :state==='parent-goal'&&q.method==='thread/goal/get'?{goal:{objective:'Running'}}
   :state==='parent-queue'&&q.method==='thread/queue/list'?{data:[{}],nextCursor:null}:null;
  if(!result)return;socket.send(JSON.stringify({id:q.id,result}));return true;
 };
 await assert.rejects(s.approve());assert.equal(Object.keys(s.c.store.state.taskWindows).length,0);
 assert.equal(s.f.calls.some(q=>q.params?.threadId===CHILD&&/interrupt|terminate|resume|start|steer/.test(q.method)),false);
});
for(const state of ['completed','active','missing','wrong-parent'])test(`interacted genuine nested descendant remains checked: ${state}`,async t=>{
 const s=await setup(t);const nested='66666666-6666-4666-8666-666666666666';
 const n=s.f.thread(nested);n.parentThreadId=CHILD;n.turns=[{id:randomUUID(),status:'completed',items:[{type:'subAgentActivity',id:'nested-reply',kind:'interacted',agentThreadId:CHILD}]}];s.f.threads.set(nested,n);
 s.child.turns[0].items=[{type:'subAgentActivity',id:'parent-reply',kind:'interacted',agentThreadId:A},{type:'subAgentActivity',id:'nested-work',kind:'interacted',agentThreadId:nested}];
 if(state==='active'){n.status={type:'active'};n.turns[0].status='inProgress';}
 if(state==='missing')s.f.threads.delete(nested);
 if(state==='wrong-parent')n.parentThreadId=A;
 s.expire();await s.restart();
 if(state==='completed')assert.equal((await s.approve()).phase,'opened');else await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});
 assert.equal(s.f.calls.some(q=>q.params?.threadId===nested&&/interrupt|terminate|resume|start|steer/.test(q.method)),false);
});
test('unrelated interacted target is never mistaken for a parent reply',async t=>{
 const s=await setup(t);const unrelated='77777777-7777-4777-8777-777777777777';
 const n=s.f.thread(unrelated);n.parentThreadId=A;n.turns=[{id:randomUUID(),status:'completed',items:[]}];s.f.threads.set(unrelated,n);
 s.child.turns[0].items=[{type:'subAgentActivity',id:'sibling-interaction',kind:'interacted',agentThreadId:unrelated}];
 s.expire();await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});
});
test('known activity kinds survive same-item merge and cannot reclassify started work as a parent reply',async t=>{
 const s=await setup(t);
 await s.c.event({method:'item/started',params:{threadId:A,turnId:T,item:{type:'subAgentActivity',id:'conflicting-parent',kind:'started',agentThreadId:A}}});
 await s.c.event({method:'item/completed',params:{threadId:A,turnId:T,item:{type:'subAgentActivity',id:'conflicting-parent',kind:'interacted',agentThreadId:A}}});
 await s.c.store.update(()=>{});s.expire();await s.restart();
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});
 assert.deepEqual(new Set(s.c.store.state.threads[A].childItems[T][0].kinds),new Set(['started','interacted']));
});
for(const missingFirst of [true,false])test(`missing activity kind is preserved in both merge orders: ${missingFirst}`,()=>{
 const unknown={type:'subAgentActivity',id:'same-item',agentThreadId:A};
 const known={...unknown,kind:'interacted'};
 const merged=mergeChildItems(missingFirst?[unknown]:[known],missingFirst?[known]:[unknown]);
 assert.deepEqual(new Set(merged[0].kinds),new Set([null,'interacted']));
 assert.equal(merged[0].agentThreadId,A);
 assert.deepEqual(new Set(mergeChildItems(merged,[known])[0].kinds),new Set([null,'interacted']));
});
