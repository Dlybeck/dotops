import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R } from './stage1-fixture.mjs';
const SPEC='55555555-5555-4555-8555-555555555555';
const STANDARDS='66666666-6666-4666-8666-666666666666';
const NESTED='77777777-7777-4777-8777-777777777777';
const OWNED='00000000-0000-4000-8000-000000000002';
const COPIED='00000000-0000-4000-8000-00000000003f';
const captured=JSON.parse(await readFile(new URL('./fixtures/synthetic-agent-graph.json',import.meta.url),'utf8'));
const mapping=new Map([[captured.rootId,A],['00000000-0000-4000-8000-00000000001b',SPEC],['00000000-0000-4000-8000-00000000001c',STANDARDS]]);
async function setup(t){
 const f=await fixture(t);let clock=Date.now();let c;
 const options={socketPath:f.socket,root:f.root,stateDir:f.dir+'/state',now:()=>clock};
 c=await Controller.open(options);t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Fork provenance fixture'});
 const approve = async () => { await c.preflight(A); return { phase: 'opened' }; };
 const window=await approve();
 for(const node of captured.nodes){
  const id=mapping.get(node.thread.id);const thread=f.thread(id);
  Object.assign(thread,{sessionId:A,parentThreadId:mapping.get(node.thread.parentThreadId)??null,forkedFromId:mapping.get(node.thread.forkedFromId)??null});
  thread.turns=[...node.turns].reverse().map(turn=>({id:turn.id,status:turn.status,itemsView:'full',items:turn.items.map(item=>{
   const relation=turn.relationships.find(r=>r.id===item.id);
   return {type:item.type,id:item.id,fixtureContentFingerprint:item.sha256,...(relation?{...relation,agentThreadId:mapping.get(relation.agentThreadId),...(relation.receiverThreadIds?{receiverThreadIds:relation.receiverThreadIds.map(x=>mapping.get(x))}:{})}:{})};
  })}));
  f.threads.set(id,thread);
 }
 const sendId=randomUUID();await c.store.update(s=>{
  s.operations[sendId]={fingerprint:'isolated-synthetic-receipt',kind:'send',phase:'accepted',threadId:A,turnId:OWNED,windowId:window.windowId,deadlineAt:window.deadlineAt,deadlineEnforcement:'terminalObserved'};
  s.threads[A].lastStop={turnId:OWNED,acknowledged:true};
 });
 return {f,approve,get c(){return c;},root:f.threads.get(A),spec:f.threads.get(SPEC),standards:f.threads.get(STANDARDS),expire(){clock+=10000;},async restart(){await c.close();c=await Controller.open(options);}};
}
test('synthetic three-thread fork graph verifies stop and explicitly approved renewal after restart',async t=>{
 const s=await setup(t);s.expire();await s.restart();
 const status=await s.c.call('codex_chat_status',{threadId:A});
 assert.equal(status.stopVerification.children,'verifiedCompleted');assert.equal(status.stopVerification.verifiedStopped,true);
 const original=structuredClone(s.c.store.state.threads[A]);assert.equal((await s.approve()).phase,'opened');
 assert.deepEqual(s.c.store.state.threads[A].childTurns,original.childTurns);
 assert.deepEqual(s.c.store.state.threads[A].terminalTurns,original.terminalTurns);
 assert.equal(s.f.calls.some(q=>/turn\/(start|steer)|terminate|interrupt/.test(q.method)),false);
 assert.equal(s.root.turns.length,9);assert.equal(s.spec.turns.length,8);assert.equal(s.standards.turns.length,8);
});
for(const state of ['active','missing','wrong-parent','wrong-cwd','process','goal','queue','incomplete'])test(`explained copied launch still blocks reviewer ${state}`,async t=>{
 const s=await setup(t);s.expire();
 if(state==='active'){s.spec.status={type:'active'};s.spec.turns.at(-1).status='inProgress';}
 if(state==='missing')s.f.threads.delete(SPEC);
 if(state==='wrong-parent')s.spec.parentThreadId=STANDARDS;
 if(state==='wrong-cwd')s.spec.cwd='/tmp/unrelated';
 if(['process','goal','queue','incomplete'].includes(state))s.f.handle=(socket,q)=>{
  if(q.params?.threadId!==SPEC)return;
  const result=state==='process'&&q.method==='thread/backgroundTerminals/list'?{data:[{processId:'active'}],nextCursor:null}
   :state==='goal'&&q.method==='thread/goal/get'?{goal:{objective:'Active'}}
   :state==='queue'&&q.method==='thread/queue/list'?{data:[{}],nextCursor:null}
   :state==='incomplete'&&q.method==='thread/turns/list'?{data:s.spec.turns.slice().reverse(),nextCursor:'more'}:null;
  if(!result)return;socket.send(JSON.stringify({id:q.id,result}));return true;
 };
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});assert.equal(Object.keys(s.c.store.state.taskWindows).length,0);
 assert.equal(s.f.calls.some(q=>q.params?.threadId===SPEC&&/resume|start|steer|interrupt|terminate/.test(q.method)),false);
});
for(const state of ['absent-fork','wrong-fork','wrong-session','altered-item','changed-kind','changed-target','non-prefix','summary','incomplete-source','missing-source-turn','duplicate-turn','duplicate-item','local-sibling'])test(`copied-launch attribution fails closed: ${state}`,async t=>{
 const s=await setup(t);s.expire();const copy=s.standards.turns.find(x=>x.id===COPIED);
 if(state==='absent-fork')delete s.standards.forkedFromId;
 if(state==='wrong-fork')s.standards.forkedFromId=SPEC;
 if(state==='wrong-session')s.standards.sessionId=STANDARDS;
 if(state==='altered-item')copy.items[0].fixtureContentFingerprint='changed';
 if(state==='changed-kind')copy.items.at(-1).kind='completed';
 if(state==='changed-target')copy.items.at(-1).agentThreadId=NESTED;
 if(state==='non-prefix')copy.items.shift();
 if(state==='summary')copy.itemsView='summary';
 if(state==='incomplete-source')s.f.handle=(socket,q)=>{if(q.method!=='thread/turns/list'||q.params.threadId!==A)return;socket.send(JSON.stringify({id:q.id,result:{data:s.root.turns.slice().reverse(),nextCursor:'more'}}));return true;};
 if(state==='missing-source-turn')s.root.turns=s.root.turns.filter(x=>x.id!==COPIED);
 if(state==='duplicate-turn')s.standards.turns.push(structuredClone(copy));
 if(state==='duplicate-item')copy.items.push(structuredClone(copy.items.at(-1)));
 if(state==='local-sibling')s.standards.turns.push({id:randomUUID(),status:'completed',itemsView:'full',items:[{type:'subAgentActivity',id:'real-local-sibling-launch',kind:'started',agentThreadId:SPEC}]});
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});
});
for(const state of ['completed','active','missing','wrong-parent'])test(`real nested descendant in historical graph: ${state}`,async t=>{
 const s=await setup(t);s.expire();
 const nested=s.f.thread(NESTED);Object.assign(nested,{parentThreadId:SPEC,forkedFromId:SPEC,sessionId:A,turns:[{id:randomUUID(),status:'completed',itemsView:'full',items:[{type:'subAgentActivity',id:'nested-parent-reply',kind:'interacted',agentThreadId:SPEC}]}]});
 s.spec.turns.at(-1).items.push({type:'subAgentActivity',id:'genuine-nested-launch',kind:'started',agentThreadId:NESTED});s.f.threads.set(NESTED,nested);
 if(state==='active'){nested.status={type:'active'};nested.turns[0].status='inProgress';}
 if(state==='missing')s.f.threads.delete(NESTED);
 if(state==='wrong-parent')nested.parentThreadId=A;
 if(state==='completed')assert.equal((await s.approve()).phase,'opened');else await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});
});
test('legacy identity-free activity remains blocked even when fork history is explained',async t=>{
 const s=await setup(t);s.root.turns.find(x=>x.id===OWNED).items=s.root.turns.find(x=>x.id===OWNED).items.filter(x=>x.type!=='subAgentActivity');
 await s.c.store.update(x=>{x.threads[A].childTurns=[OWNED];});s.expire();await s.restart();
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});assert.deepEqual(s.c.store.state.threads[A].childTurns,[OWNED]);
});
test('fork lineage changing during final proof blocks admission',async t=>{
 const s=await setup(t);s.expire();let reads=0;
 s.f.handle=(socket,q)=>{if(q.method==='thread/read'&&q.params.threadId===STANDARDS&&++reads===2)s.standards.forkedFromId=SPEC;};
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});assert.ok(reads>=2);
});
test('new nested work arriving during final history proof is not hidden by idle status',async t=>{
 const s=await setup(t);s.expire();let reads=0;
 s.f.handle=(socket,q)=>{if(q.method==='thread/turns/list'&&q.params.threadId===STANDARDS&&++reads===2)s.standards.turns.at(-1).items.push({type:'subAgentActivity',id:'late-unknown',kind:'started',agentThreadId:NESTED});};
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});assert.ok(reads>=2);
});
test('a real nested fork retains recursively inherited root and parent origins, without fictitious ownership cycles',async t=>{
 const s=await setup(t);s.expire();
 const turn={id:randomUUID(),status:'completed',itemsView:'full',items:[{type:'userMessage',id:'new-parent-user',text:'Safe synthetic nested fork'},{type:'agentMessage',id:'new-parent-message',text:'Safe copied prefix'}]};
 s.spec.turns.push(turn);
 const nested=s.f.thread(NESTED);Object.assign(nested,{parentThreadId:SPEC,forkedFromId:SPEC,sessionId:A,turns:structuredClone(s.spec.turns)});
 nested.turns.at(-1).status='interrupted';turn.items.push({type:'subAgentActivity',id:'new-nested-launch',kind:'started',agentThreadId:NESTED});
 nested.turns.push({id:randomUUID(),status:'completed',itemsView:'full',items:[{type:'subAgentActivity',id:'nested-reply',kind:'interacted',agentThreadId:SPEC}]});
 s.f.threads.set(NESTED,nested);assert.equal((await s.approve()).phase,'opened');
 s.expire();nested.status={type:'active'};await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});
});
test('source content arriving during final proof invalidates an earlier matching fork prefix',async t=>{
 const s=await setup(t);s.expire();let reads=0;
 s.f.handle=(socket,q)=>{if(q.method==='thread/turns/list'&&q.params.threadId===A&&++reads===2)s.root.turns.find(x=>x.id===COPIED).items.push({type:'agentMessage',id:'changed-source',text:'Safe synthetic change'});};
 await assert.rejects(s.approve(),{code:'PREVIOUS_WORK_UNVERIFIED'});assert.ok(reads>=2);
});
test('root notLoaded renewal behavior remains intact when complete persisted fork and child state are verified',async t=>{
 const s=await setup(t);s.expire();s.root.status={type:'notLoaded'};assert.equal((await s.approve()).phase,'opened');
});
