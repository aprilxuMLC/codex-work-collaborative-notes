import assert from 'node:assert/strict';import {test} from 'node:test';import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {PanelService} from '../../plugins/collaborative-notes/server/service.mjs';
import {panelToken} from '../../plugins/collaborative-notes/server/lib/service-client.js';
import {createMcpServer} from '../../plugins/collaborative-notes/server/mcp.mjs';
import {runHook} from '../../plugins/collaborative-notes/server/hook.mjs';
const thread='thread-panel-fixture',secret='b'.repeat(64);
async function fixture(platform='win32',open=async()=>true){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'cn-panel-reuse-')),data=path.join(base,'data'),project=path.join(base,'project');await fs.mkdir(project);await fs.mkdir(data);
 const service=new PanelService({dataDir:data,secret,platform,preferredPort:0,env:{...process.env,CN_FORK_WATCH:'0'},threadContext:async id=>({holder:id,projectPath:project,title:'Panel fixture'}),appserver:{close(){}},openPanel:open});const info=await service.start(),root=`http://127.0.0.1:${info.port}`;
 const internal=async(body)=>{const response=await fetch(root+'/internal/panel/open',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
 const page=async()=>{const response=await fetch(root+'/t/'+thread,{headers:{cookie:'cn_t_'+thread+'='+panelToken(secret,thread)}});const text=await response.text();return {status:response.status,text,id:text.match(/data-cn-panel="([a-f0-9]{32})"/)?.[1]};};
 const closed=async id=>{const response=await fetch(root+'/api/t/'+thread+'/panel/closed',{method:'POST',headers:{'x-cn-token':panelToken(secret,thread),'content-type':'application/json'},body:JSON.stringify({panelId:id})});return {status:response.status,value:await response.json()};};
 return {service,data,root,internal,page,closed,cleanup:async()=>{await service.close();await fs.rm(base,{recursive:true,force:true});}};
}
test('Windows same-thread concurrent and repeated opening calls launch only once',async()=>{let calls=0,release;const gate=new Promise(r=>release=r);const f=await fixture('win32',async()=>{calls++;await gate;return true;});try{const first=f.internal({threadId:thread});const until=Date.now()+500;while(!calls&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.equal(calls,1);const second=f.internal({threadId:thread});release();for(const result of await Promise.all([first,second]))assert.equal(result.status,200);assert.equal(calls,1);const again=await f.internal({threadId:thread});assert.equal(again.value.pending,true);assert.equal(again.value.reused,undefined);assert.equal(calls,1);assert.equal(await fs.stat(path.join(f.data,'bindings.json')).catch(()=>null),null);}finally{await f.cleanup();}});
test('Windows host receives the same canonical address before and after pages close',async()=>{const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});try{const one=await f.page(),two=await f.page();assert.equal(one.status,200);assert.notEqual(one.id,two.id);assert.equal((await f.internal({threadId:thread})).value.opened,true);await f.closed(one.id);assert.equal((await f.internal({threadId:thread})).value.opened,true);await f.closed(two.id);assert.equal((await f.internal({threadId:thread})).value.opened,true);await f.closed(one.id);assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.deepEqual(urls,Array(4).fill(f.root+'/t/'+thread));}finally{await f.cleanup();}});
test('Windows failed launcher can retry; another conversation has a separate slot',async()=>{let calls=0;const f=await fixture('win32',async()=>++calls!==1);try{assert.notEqual((await f.internal({threadId:thread})).status,200);assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.equal((await f.internal({threadId:'thread-other-fixture'})).value.opened,true);assert.equal(calls,3);}finally{await f.cleanup();}});
test('Mac panel bytes retain no Windows presence attribute and native opening endpoint stays disabled',async()=>{let calls=0;const f=await fixture('darwin',async()=>{calls++;return true;});try{const page=await f.page();assert.equal(page.status,200);assert.equal(page.id,undefined);assert.equal((await f.internal({threadId:thread})).status,404);assert.equal(calls,0);}finally{await f.cleanup();}});
test('Windows MCP uses the service opening coordinator; Mac retains its existing opener',async()=>{for(const platform of ['win32','darwin']){let opens=0,requests=0;const server=createMcpServer({platform,resolveDataDirectory:async()=>'/fixture/data',contextResolver:async()=>({projectPath:'/fixture/project'}),desktop:async()=>true,ensure:async()=>({port:1,dataDir:'/fixture/data'}),secretReader:async()=>secret,open:async()=>{opens++;return true;},request:async(_info,route,options)=>{requests++;assert.equal(route,'/internal/panel/open');assert.deepEqual(options.body,{threadId:thread});return {status:200,value:{opened:true,reused:true}};}});const result=await server.callTool('notes-open-panel',{}, {threadId:thread});assert.notEqual(result.isError,true);assert.equal(opens,platform==='darwin'?1:0);assert.equal(requests,platform==='win32'?1:0);}});
test('Windows hook uses the same coordinator after consume; request failure does not open another tab',async()=>{for(const fail of [false,true]){const calls=[];await runHook({hook_event_name:'UserPromptSubmit',session_id:thread,turn_id:'turn-fixture'},{platform:'win32',env:{PLUGIN_DATA:'/fixture/data',CN_ASSUME_DESKTOP:'1'},ensure:async()=>({port:1,dataDir:'/fixture/data'}),secretReader:async()=>secret,open:async()=>{calls.push('direct-open');return true;},request:async(_info,route)=>{calls.push(route);if(route.startsWith('/internal/panel-seen?'))return {status:200,value:{recent:false}};if(route==='/internal/panel/open'&&fail)throw Error('Temporary outage');return {status:200,value:{ok:true,selected:false,opened:true,reused:true}};}});assert.ok(calls.indexOf('/internal/reference/consume')<calls.indexOf('/internal/panel/open'));assert.ok(!calls.includes('direct-open'));}});
test('Windows stale or missing close notifications never suppress a canonical reopen',async()=>{const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});try{const page=await f.page();await f.closed('0'.repeat(32));assert.equal((await f.internal({threadId:thread})).value.opened,true);f.service.panelInstances.get(thread).set(page.id,Date.now()-300001);f.service.panelSeen.set(thread,Date.now()-300001);assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.deepEqual(urls,[f.root+'/t/'+thread,f.root+'/t/'+thread]);}finally{await f.cleanup();}});
test('Windows MCP preserves desktop restriction and has no direct-open fallback on service failure',async()=>{let direct=0,requests=0;for(const desktop of [false,true]){const server=createMcpServer({platform:'win32',resolveDataDirectory:async()=>'/fixture/data',contextResolver:async()=>({projectPath:'/fixture/project'}),desktop:async()=>desktop,ensure:async()=>({port:1,dataDir:'/fixture/data'}),secretReader:async()=>secret,open:async()=>{direct++;return true;},request:async()=>{requests++;return {status:503,value:{opened:false}};}});const result=await server.callTool('notes-open-panel',{}, {threadId:thread});assert.equal(result.isError,true);}assert.equal(direct,0);assert.equal(requests,1);});
test('late heartbeat of a closed instance cannot revive it or refresh legacy seen time',async()=>{let opens=0;const f=await fixture('win32',async()=>{opens++;return true;});try{const page=await f.page();await f.closed(page.id);const response=await fetch(f.root+'/api/t/'+thread+'/context',{headers:{'x-cn-token':panelToken(secret,thread),'x-cn-panel-instance':page.id}});assert.equal(response.headers.get('x-cn-panel-refresh'),'1');assert.equal(f.service.panelSeen.has(thread),false);assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.equal(opens,1);}finally{await f.cleanup();}});
test('restored activation uses a new id; delayed old beacon cannot close it; preclosed renewal never becomes live',async()=>{let opens=0;const f=await fixture('win32',async()=>{opens++;return true;});try{const page=await f.page(),renew='a'.repeat(32);await f.closed(page.id);const present=async id=>{const response=await fetch(f.root+'/api/t/'+thread+'/panel/present',{method:'POST',headers:{'x-cn-token':panelToken(secret,thread),'content-type':'application/json'},body:JSON.stringify({previousId:page.id,panelId:id})});return response.json();};assert.equal((await present(renew)).closed,false);await f.closed(page.id);assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.equal(opens,1);const late='c'.repeat(32);await f.closed(late);assert.equal((await present(late)).closed,true);assert.equal(f.service.panelInstances.get(thread).has(late),false);}finally{await f.cleanup();}});
test('Windows bootstrap still requires token authentication and does not claim a live page',async()=>{
 const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});
 try{
  const result=await f.internal({threadId:thread});assert.deepEqual(result.value,{opened:true});
  assert.equal(urls[0],f.root+'/t/'+thread+'?k='+panelToken(secret,thread));
  assert.equal(f.service.panelAuthenticated.has(thread),false);
  const response=await fetch(urls[0],{redirect:'manual'});assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/t/'+thread);
  await f.page();assert.deepEqual((await f.internal({threadId:thread})).value,{opened:true});assert.equal(urls[1],f.root+'/t/'+thread);
 }finally{await f.cleanup();}
});
test('Windows remembered authentication never bypasses credentials; rejected canonical page allows reauthentication',async()=>{
 const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});
 try{
  await f.page();assert.equal(f.service.panelAuthenticated.has(thread),true);
  const response=await fetch(f.root+'/t/'+thread);assert.equal(response.status,403);assert.equal(f.service.panelAuthenticated.has(thread),false);
  assert.deepEqual((await f.internal({threadId:thread})).value,{opened:true});assert.equal(urls[0],f.root+'/t/'+thread+'?k='+panelToken(secret,thread));
 }finally{await f.cleanup();}
});
test('Windows restored page cookie establishes canonical opening after service restart without needing a presence id',async()=>{
 const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});
 try{
  const route=f.root+'/api/t/'+thread+'/context';
  const rejected=await fetch(route);assert.equal(rejected.status,403);assert.equal(f.service.panelAuthenticated.has(thread),false);
  const accepted=await fetch(route,{headers:{cookie:'cn_t_'+thread+'='+panelToken(secret,thread),'x-cn-panel-instance':'d'.repeat(32)}});
  assert.equal(accepted.status,200);assert.equal(accepted.headers.get('x-cn-panel-refresh'),'1');assert.equal(f.service.panelAuthenticated.has(thread),true);
  assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.deepEqual(urls,[f.root+'/t/'+thread]);
 }finally{await f.cleanup();}
});

test('Windows lost page cookie at API polling clears authentication before the next authorized opening',async()=>{
 const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});
 try{
  const route=f.root+'/api/t/'+thread+'/context',cookie='cn_t_'+thread+'='+panelToken(secret,thread);
  assert.equal((await fetch(route,{headers:{cookie}})).status,200);
  await f.internal({threadId:thread});assert.equal(urls[0],f.root+'/t/'+thread);
  assert.equal((await fetch(route)).status,403);assert.equal(f.service.panelAuthenticated.has(thread),false);
  assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.equal(urls[1],f.root+'/t/'+thread+'?k='+panelToken(secret,thread));
 }finally{await f.cleanup();}
});

test('Windows preserves the existing branch-back address when focusing its authenticated page',async()=>{
 const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});
 try{
  const address=f.root+'/t/'+thread+'?from=thread-parent-fixture';
  assert.equal((await fetch(address,{headers:{cookie:'cn_t_'+thread+'='+panelToken(secret,thread)}})).status,200);
  assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.deepEqual(urls,[address]);
 }finally{await f.cleanup();}
});
test('Windows restored branch page learns its canonical address from an authenticated same-origin referrer',async()=>{
 const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});
 try{
  const address=f.root+'/t/'+thread+'?from=thread-parent-fixture';
  assert.equal((await fetch(f.root+'/api/t/'+thread+'/context',{headers:{cookie:'cn_t_'+thread+'='+panelToken(secret,thread),referer:address}})).status,200);
  assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.deepEqual(urls,[address]);
 }finally{await f.cleanup();}
});

test('Windows rejects foreign, other-thread, or invalid branch referrers when choosing its panel address',async()=>{
 for(const kind of ['foreign','other-thread','invalid-parent']){
  const urls=[];const f=await fixture('win32',async url=>{urls.push(url);return true;});
  try{
   const referrer=kind==='foreign'?'https://example.invalid/t/'+thread+'?from=thread-parent-fixture':kind==='other-thread'?f.root+'/t/thread-other-fixture?from=thread-parent-fixture':f.root+'/t/'+thread+'?from=%2Finvalid';
   assert.equal((await fetch(f.root+'/api/t/'+thread+'/context',{headers:{cookie:'cn_t_'+thread+'='+panelToken(secret,thread),referer:referrer}})).status,200);
   assert.equal((await f.internal({threadId:thread})).value.opened,true);assert.deepEqual(urls,[f.root+'/t/'+thread]);
  }finally{await f.cleanup();}
 }
});
