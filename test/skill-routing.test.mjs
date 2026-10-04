import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/stage1/controller.mjs';
import {fixture,A,R} from './stage1-fixture.mjs';
import {randomUUID} from 'node:crypto';

test('explicit installed skill reaches native input as a structured item beside unmodified text',async t=>{
 const f=await fixture(t), skill={name:'example:build',path:f.dir+'/skills/build/SKILL.md',enabled:true};
 f.handle=(socket,q)=>{if(q.method!=='skills/list')return;socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:f.cwd,skills:[skill],errors:[]}]}}));return true;};
 const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state'});t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Explicit skill fixture'});
 const r=await c.call('codex_chat_send',{requestId:randomUUID(),threadId:A,text:'$example:build Implement the task.',skills:[{name:skill.name,path:skill.path}]});
 assert.equal(r.phase,'accepted');
 assert.deepEqual(f.calls.find(q=>q.method==='turn/start').params.input,[{type:'text',text:'$example:build Implement the task.'},{type:'skill',name:skill.name,path:skill.path}]);
});

test('skill discovery is native, bounded and scoped to the enrolled chat',async t=>{
 const f=await fixture(t);const catalog=Array.from({length:50},(_,i)=>({name:'example:skill'+i,path:f.dir+'/skills/'+i+'/SKILL.md',enabled:i%2===0,description:'界'.repeat(600)}));
 f.handle=(socket,q)=>{if(q.method!=='skills/list')return;socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:f.cwd,skills:catalog,errors:[]}]}}));return true;};
 const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state'});t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Native catalog fixture'});
 let cursor,all=[];
 do{const page=await c.call('codex_chat_skills',{threadId:A,cursor,limit:20});assert.ok(Buffer.byteLength(JSON.stringify(page))<32768);assert.equal(page.skillCount,50);all.push(...page.skills);cursor=page.nextCursor;}while(cursor);
 assert.equal(all.length,50);assert.equal(new Set(all.map(s=>s.path)).size,50);
 assert.equal(f.calls.some(q=>q.method==='turn/start'),false);
});

for(const variant of ['disabled','missing','wrong-path','duplicate','unavailable','wrong-cwd'])test(`explicit skill ${variant} is not converted to a prose-only delivery`,async t=>{
 const f=await fixture(t),skill={name:'example:build',path:f.dir+'/skills/build/SKILL.md',enabled:variant!=='disabled'};
 f.handle=(socket,q)=>{if(q.method!=='skills/list')return;if(variant==='unavailable')socket.send(JSON.stringify({id:q.id,error:{code:-32601,message:'unsupported'}}));else socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:variant==='wrong-cwd'?'/different':f.cwd,skills:variant==='missing'?[]:[skill],errors:[]}]}}));return true;};
 const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state'});t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Skill validation fixture'});
 const selection={name:skill.name,path:variant==='wrong-path'?f.dir+'/secrets.txt':skill.path};
 const args={requestId:randomUUID(),threadId:A,text:'Invoke explicit skill.',skills:variant==='duplicate'?[selection,selection]:[selection]};
 const result=await c.call('codex_chat_send',args);assert.equal(result.phase,'notDispatched');
 assert.equal(f.calls.some(q=>q.method==='turn/start'||q.method==='turn/steer'),false);
});

test('literal slash text stays text; configured persona mentions never silently select native skills',async t=>{
 const f=await fixture(t);const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state'});t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Literal slash fixture'});
 const result=await c.call('codex_chat_send',{requestId:randomUUID(),threadId:A,text:'/build is a literal example.'});assert.equal(result.phase,'accepted');
 assert.deepEqual(f.calls.find(q=>q.method==='turn/start').params.input,[{type:'text',text:'/build is a literal example.'}]);
 assert.equal(f.calls.some(q=>q.method==='skills/list'),false);
});

test('catalog lookup cannot hide cwd drift immediately before dispatch',async t=>{
 const f=await fixture(t),skill={name:'example:build',path:f.dir+'/skills/build/SKILL.md',enabled:true};
 f.handle=(socket,q)=>{if(q.method!=='skills/list')return;f.threads.get(A).cwd='/tmp';socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:f.cwd,skills:[skill],errors:[]}]}}));return true;};
 const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state'});t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Catalog race fixture'});
 const result=await c.call('codex_chat_send',{requestId:randomUUID(),threadId:A,text:'Invoke explicit skill.',skills:[{name:skill.name,path:skill.path}]});
 assert.equal(result.phase,'notDispatched');assert.equal(result.code,'OUT_OF_SCOPE');assert.equal(f.calls.some(q=>q.method==='turn/start'),false);
});

import {writeFile} from 'node:fs/promises';
import {T} from './stage1-fixture.mjs';

test('TPM preparation never dispatches skills; first context and explicit skills share one delivery and survive replay',async t=>{
 const f=await fixture(t),skill={name:'example:build',path:f.dir+'/skills/build/SKILL.md',enabled:true};
 f.handle=(socket,q)=>{if(q.method!=='skills/list')return;socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:f.cwd,skills:[skill],errors:[]}]}}));return true;};
 const contextFile=f.dir+'/context.json';await writeFile(contextFile,JSON.stringify({developer:'Configured developer text.',tpm:'Configured coordinator text.'}),{mode:0o600});
 const options={root:f.root,socketPath:f.socket,stateDir:f.dir+'/state',contextFile};let c=await Controller.open(options);t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Private context with explicit skill'});
 const selected={name:skill.name,path:skill.path};const args={requestId:randomUUID(),threadId:A,text:'$example:build Task.',skills:[selected]};
 const prep=await c.call('codex_chat_send',args);assert.equal(prep.delivery,'notAttempted');assert.equal(f.calls.some(q=>q.method==='skills/list'||q.method==='turn/start'),false);
 const follow={...args,requestId:randomUUID(),preparationId:prep.preparationId};const sent=await c.call('codex_chat_send',follow);assert.equal(sent.phase,'accepted');assert.deepEqual(sent.nativeSkillInputs,[selected]);
 assert.deepEqual(f.calls.find(q=>q.method==='turn/start').params.input,[{type:'text',text:'$example:build Task.\n\nConfigured developer text.'},{type:'skill',...selected}]);
 await c.close();c=await Controller.open(options);assert.deepEqual(await c.call('codex_chat_send',follow),sent);
 assert.equal(f.calls.filter(q=>q.method==='turn/start').length,1);
 await assert.rejects(c.call('codex_chat_send',{...follow,skills:[{...selected,name:'different'}]}),{code:'REQUEST_ID_CONFLICT'});
});

test('explicit skill steering remains bound to the recorded turn and native permissions',async t=>{
 const f=await fixture(t),skill={name:'example:build',path:f.dir+'/skills/build/SKILL.md',enabled:true};
 f.handle=(socket,q)=>{if(q.method!=='skills/list')return;socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:f.cwd,skills:[skill],errors:[]}]}}));return true;};
 const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state'});t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Explicit steering fixture'});await c.call('codex_chat_send',{requestId:randomUUID(),threadId:A,text:'Initial task.'});
 const sent=await c.call('codex_chat_send',{requestId:randomUUID(),threadId:A,text:'$example:build Continue.',expectedTurnId:T,skills:[{name:skill.name,path:skill.path}]});assert.equal(sent.phase,'accepted');
 const dispatch=f.calls.find(q=>q.method==='turn/steer');assert.equal(dispatch.params.expectedTurnId,T);assert.equal(dispatch.params.input[1].type,'skill');assert.equal(Object.hasOwn(dispatch.params,'approvalPolicy'),false);assert.equal(Object.hasOwn(dispatch.params,'sandboxPolicy'),false);
});

test('catalog changes invalidate continuations and never enable disabled skills',async t=>{
 const f=await fixture(t);let enabled=true;f.handle=(socket,q)=>{if(q.method!=='skills/list')return;socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:f.cwd,skills:[0,1].map(i=>({name:'example:skill'+i,path:f.dir+'/'+i+'/SKILL.md',enabled})),errors:[]}]}}));return true;};
 const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state'});t.after(()=>c.close());await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Changed catalog fixture'});
 const first=await c.call('codex_chat_skills',{threadId:A,limit:1});assert.ok(first.nextCursor);enabled=false;
 await assert.rejects(c.call('codex_chat_skills',{threadId:A,cursor:first.nextCursor,limit:1}),{code:'SKILLS_CHANGED'});
 const next=await c.call('codex_chat_skills',{threadId:A,forceReload:true});assert.equal(next.skills[0].enabled,false);assert.equal(f.calls.some(q=>q.method==='skills/config/write'),false);
});

test('oversized skill acceptance receipt fails before dispatch and releases preparation for a bounded follow-up', async t => {
 const f=await fixture(t);
 const skills=Array.from({length:9},(_,i)=>({name:'example:large'+i,path:'/'+String(i)+'x'.repeat(4094),enabled:true}));
 f.handle=(socket,q)=>{if(q.method!=='skills/list')return;socket.send(JSON.stringify({id:q.id,result:{data:[{cwd:f.cwd,skills,errors:[]}]}}));return true;};
 const contextFile=f.dir+'/context.json';await writeFile(contextFile,JSON.stringify({tpm:'Review request'}),{mode:0o600});
 const c=await Controller.open({root:f.root,socketPath:f.socket,stateDir:f.dir+'/state',contextFile});t.after(()=>c.close());
 await c.call('codex_chat_create',{requestId:R,repository:f.cwd,title:'Receipt bound fixture'});
 const args={threadId:A,requestId:randomUUID(),text:'Invoke selected skills.',skills:skills.map(({name,path})=>({name,path}))};
 const prep=await c.call('codex_chat_send',args);
 const rejected=await c.call('codex_chat_send',{...args,requestId:randomUUID(),preparationId:prep.preparationId});
 assert.equal(rejected.phase,'notDispatched');assert.equal(rejected.code,'SKILL_RECEIPT_TOO_LARGE');
 assert.equal(f.calls.some(q=>q.method==='turn/start'),false);
 const sent=await c.call('codex_chat_send',{...args,requestId:randomUUID(),skills:[args.skills[0]],preparationId:prep.preparationId});
 assert.equal(sent.phase,'accepted');assert.equal(f.calls.filter(q=>q.method==='turn/start').length,1);
});
