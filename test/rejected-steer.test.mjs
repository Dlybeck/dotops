import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, A, B, R, T } from './stage1-fixture.mjs';
import { taskSend } from './task-window-fixture.mjs';
import { Controller } from '../src/stage1/controller.mjs';
const REJECTED='da30d30d-01dc-4a33-8fdb-04cab442a9a4';
const NEXT='c34d6b92-4b6f-4ae7-9c9c-f61140398d1e';
async function setup(t, options={}) {
  const f=await fixture(t);
  const config={socketPath:f.socket,root:f.root,stateDir:f.dir+'/state',timeoutMs:100,...options};
  const c=await Controller.open(config);t.after(()=>c.close());
  await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Rejection fixture'});
  const first=await taskSend(c,{requestId:B,threadId:A,text:'contract'});
  const args={requestId:REJECTED,threadId:A,expectedTurnId:first.turnId,text:'repair'};
  const finish=()=>{f.threads.get(A).status={type:'idle'};Object.assign(f.threads.get(A).turns[0],{status:'completed',itemsView:'full'});};
  const reject=(error={code:-32600,message:'no active turn to steer'})=>{f.handle=(socket,q)=>{
    if(q.method!=='turn/steer')return false;finish();
    if(error)socket.send(JSON.stringify({id:q.id,error}));return true;
  };};
  const receipt={requestId:REJECTED,threadId:A,expectedTurnId:T,code:'BACKEND_REJECTED',approvalRef:'Synthetic_operator_approval'};
  return {f,c,config,args,finish,reject,receipt};
}

test('verified no-active-turn rejection releases lock without replaying and survives restart',async t=>{
 const x=await setup(t);x.reject();
 const result=await taskSend(x.c,x.args);assert.equal(result.phase,'unknown');assert.equal(result.code,'BACKEND_REJECTED');
 await x.c.close();const c=await Controller.open(x.config);t.after(()=>c.close());
 const status=await c.call('codex_chat_status',{threadId:A});
 const op=status.operations.find(o=>o.requestId===REJECTED);assert.equal(op.phase,'rejected');assert.equal(op.deadlineEnforcement,'disabled');
 assert.equal((await taskSend(c,x.args)).phase,'rejected');
 assert.equal(x.f.calls.filter(q=>q.method==='turn/steer').length,1);
 assert.equal((await taskSend(c,{requestId:NEXT,threadId:A,text:'next'})).phase,'accepted');
 assert.equal(c.store.state.operations[REJECTED].rejectionVerification.source,'nativeNoActiveTurn');
});

test('unclassified native errors retain sanitized evidence and remain unresolved',async t=>{
 for(const error of [{code:-32603,message:'no active turn to steer',data:{token:'SECRET_DATA'}},{code:-32600,message:'expected active turn id `one` but found `two`'},{code:-32600,message:'SECRET_ERROR'}]) {
  const x=await setup(t);x.reject(error);await taskSend(x.c,x.args);
  assert.equal((await x.c.call('codex_chat_status',{threadId:A})).operations.find(o=>o.requestId===REJECTED).phase,'unknown');
  assert.deepEqual(x.c.store.state.operations[REJECTED].nativeRejection,{rpcCode:error.code,reason:'unclassified'});
  assert.equal(JSON.stringify(x.c.store.state).includes('SECRET'),false);
  await assert.rejects(taskSend(x.c,{requestId:NEXT,threadId:A,text:'next'}),{code:'SEND_UNRESOLVED'});
 }
});

test('transport uncertainty remains blocked even with a terminal full target',async t=>{
 const x=await setup(t);x.reject(null);await taskSend(x.c,x.args);
 assert.equal(x.c.store.state.operations[REJECTED].failureCode,'DAEMON_UNAVAILABLE');
 assert.equal((await x.c.call('codex_chat_status',{threadId:A})).operations.find(o=>o.requestId===REJECTED).phase,'unknown');
 await assert.rejects(x.c.recoverRejectedSteer(x.receipt),{code:'REJECTION_UNVERIFIED'});
 await assert.rejects(taskSend(x.c,{requestId:NEXT,threadId:A,text:'next'}),{code:'SEND_UNRESOLVED'});
});

test('summary, absent, active, duplicate and unowned-origin target histories cannot prove rejection',async t=>{
 for(const change of [t=>{t.itemsView='summary';},t=>{t.id='different-target';},t=>{t.status='inProgress';},t=>{t.items[0].clientId=NEXT;}]) {
  const x=await setup(t);x.reject();await taskSend(x.c,x.args);change(x.f.threads.get(A).turns[0]);
  assert.equal((await x.c.call('codex_chat_status',{threadId:A})).operations.find(o=>o.requestId===REJECTED).phase,'unknown');
 }
 const x=await setup(t);x.reject();await taskSend(x.c,x.args);
 x.f.threads.get(A).turns.push(structuredClone(x.f.threads.get(A).turns[0]));
 assert.equal((await x.c.call('codex_chat_status',{threadId:A})).operations.find(o=>o.requestId===REJECTED).phase,'unknown');
});

test('incomplete thread history and unmanaged work keep the send lock',async t=>{
 for(const mode of ['incomplete','queue','active']) {
  const x=await setup(t);x.reject();await taskSend(x.c,x.args);const prior=x.f.handle;
  if(mode==='incomplete')x.f.handle=(socket,q)=>{if(q.method==='thread/turns/list'){socket.send(JSON.stringify({id:q.id,result:{data:[x.f.threads.get(A).turns[0]],nextCursor:'more'}}));return true;}return prior(socket,q);};
  if(mode==='goal')x.f.goal={status:'active'};
  if(mode==='queue')x.f.queue=[{id:'queued'}];
  if(mode==='active')x.f.threads.get(A).status={type:'active'};
  if(mode==='queue')await assert.rejects(x.c.call('codex_chat_status',{threadId:A}));
  else assert.equal((await x.c.call('codex_chat_status',{threadId:A})).operations.find(o=>o.requestId===REJECTED).phase,'unknown');
  assert.equal(x.c.store.state.operations[REJECTED].phase,'unknown');
 }
});

test('lost acceptance reply is positively reconciled, never classified as rejection',async t=>{
 const x=await setup(t);x.f.handle=(socket,q)=>{if(q.method!=='turn/steer')return false;x.finish();
  x.f.threads.get(A).turns[0].items.push({type:'userMessage',id:'repair',clientId:REJECTED,content:q.params.input});socket.terminate();return true;};
 await taskSend(x.c,x.args);
 const status=await x.c.call('codex_chat_status',{threadId:A});assert.equal(status.operations.find(o=>o.requestId===REJECTED).phase,'accepted');
 assert.equal(x.f.calls.filter(q=>q.method==='turn/steer').length,1);
});

test('local approved legacy recovery verifies exact target and preserves records without native sends',async t=>{
 const x=await setup(t);x.reject({code:-32603,message:'legacy generic rejection'});await taskSend(x.c,x.args);
 await x.c.store.update(s=>{for(const field of ['nativeRejection','failureCode','result'])delete s.operations[REJECTED][field];});
 const before=structuredClone(x.c.store.state);const mutations=x.f.calls.filter(q=>q.method==='turn/start'||q.method==='turn/steer').length;
 await assert.rejects(x.c.recoverRejectedSteer({...x.receipt,expectedTurnId:'wrong-target'}),{code:'REJECTION_UNVERIFIED'});
 await assert.rejects(x.c.recoverRejectedSteer({...x.receipt,code:'DAEMON_UNAVAILABLE'}),{code:'REJECTION_UNVERIFIED'});
 assert.equal((await x.c.recoverRejectedSteer(x.receipt)).phase,'rejected');
 assert.equal(x.f.calls.filter(q=>q.method==='turn/start'||q.method==='turn/steer').length,mutations);
 assert.deepEqual(x.c.store.state.taskWindows,before.taskWindows);
 for(const [id,op] of Object.entries(before.operations))if(id!==REJECTED)assert.deepEqual(x.c.store.state.operations[id],op);
 assert.equal(x.c.store.state.operations[REJECTED].fingerprint,before.operations[REJECTED].fingerprint);
 assert.equal(x.c.store.state.operations[REJECTED].expectedTurnId,T);
 assert.equal(x.c.store.state.operations[REJECTED].rejectionVerification.source,'approvedLegacyRecovery');
});

test('acceptance racing negative evidence is never overwritten',async t=>{
 const x=await setup(t);x.reject();await taskSend(x.c,x.args);
 const history=await x.c.turns(A),owned=x.c.owned.bind(x.c);
 x.c.owned=async id=>{const result=await owned(id);await x.c.store.update(s=>{Object.assign(s.operations[REJECTED],{phase:'accepted',turnId:T});});return result;};
 assert.equal(await x.c.rejectSteer(REJECTED,history,{source:'nativeNoActiveTurn'}),false);
 assert.equal(x.c.store.state.operations[REJECTED].phase,'accepted');
});



