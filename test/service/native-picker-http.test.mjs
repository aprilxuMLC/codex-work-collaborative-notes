
import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";import path from "node:path";
import {test} from "node:test";
import {PanelService} from "../../plugins/collaborative-notes/server/service.mjs";
import {panelToken} from "../../plugins/collaborative-notes/server/lib/service-client.js";
const holder="thread-native-fixture";
async function fixture({platform="win32",select,driveEnumerator}={}){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),"cn-native-http-")),project=path.join(base,"project"),data=path.join(base,"data"),target=path.join(base,"target");
 await fs.mkdir(project);await fs.mkdir(target);await fs.mkdir(data);let created=0,selected=0;
 const provider={active:false,select:async options=>{selected++;provider.active=true;try{return await(select?.(options)||Promise.resolve({ok:true,status:"selected",path:target}));}finally{provider.active=false;}},close:async()=>{}};
 const service=new PanelService({dataDir:data,secret:"a".repeat(64),platform,driveEnumerator,nativePickerFactory:()=>{created++;return provider;},threadContext:async()=>({holder,projectPath:project,title:"Fixture"}),env:{...process.env,CODEX_HOME:base,CN_FORK_WATCH:"0"},idleMs:60000,preferredPort:0});
 const running=await service.start(),url="http://127.0.0.1:"+running.port+"/api/t/"+holder,headers={"x-cn-token":panelToken(service.secret,holder),"content-type":"application/json"};
 const post=(suffix,body={},options={})=>fetch(url+suffix,{method:"POST",headers,body:JSON.stringify(body),...options});
 return {base,project,data,target,service,post,url,headers,counts:()=>({created,selected}),close:async()=>{await service.close();await fs.rm(base,{recursive:true,force:true});}};
}
test("real HTTP selection returns only a candidate; explicit native confirmation uses old setup",async()=>{
 const f=await fixture();try{
 const context=await(await fetch(f.url+"/context",{headers:f.headers})).json();assert.equal(context.nativeFolderPicker,true);
 const response=await f.post("/fs/native-picker",{title:"选择目录"});assert.equal(response.status,200);assert.equal((await response.json()).path,f.target);
 assert.equal(await fs.access(path.join(f.data,"bindings.json")).then(()=>true,()=>false),false);
 const configured=await f.post("/setup/native",{action:"custom",customPath:f.target});assert.equal(configured.status,200);assert.equal((await configured.json()).root,await fs.realpath(f.target));
 assert.deepEqual(f.counts(),{created:1,selected:1});
 const second=await f.post("/fs/native-picker",{title:"Notes"});assert.equal(second.status,409);assert.equal((await second.json()).code,"ALREADY_INITIALIZED");assert.equal(f.counts().selected,1);
 }finally{await f.close();}
});
test("Windows folder listing includes injected drive roots and breadcrumbs",{skip:process.platform!=="win32"},async()=>{
 const roots=["C:","D:"].map(root=>root+path.win32.sep);
 const f=await fixture({driveEnumerator:async()=>({drives:roots})});try{
  const response=await fetch(f.url+"/fs?path="+encodeURIComponent(f.project),{headers:f.headers});assert.equal(response.status,200);
  const result=await response.json();assert.deepEqual(result.drives,roots);assert.equal(result.breadcrumbs.at(-1).path,f.project);
 }finally{await f.close();}
 const unavailable=await fixture({driveEnumerator:async()=>({drives:[],drivesError:"DRIVE_LIST_UNAVAILABLE"})});try{
  const response=await fetch(unavailable.url+"/fs?path="+encodeURIComponent(path.win32.join(unavailable.project,"missing")),{headers:unavailable.headers});assert.equal(response.status,400);
  const result=await response.json();assert.equal(result.drivesError,"DRIVE_LIST_UNAVAILABLE");
 }finally{await unavailable.close();}
});
test("Mac does not advertise/load native support and old setup remains available",async()=>{
 const f=await fixture({platform:"darwin"});try{
 const context=await(await fetch(f.url+"/context",{headers:f.headers})).json();assert.equal(Object.hasOwn(context,"nativeFolderPicker"),false);
 assert.equal((await f.post("/fs/native-picker",{title:"Notes"})).status,404);assert.equal((await f.post("/setup/native",{customPath:f.target})).status,404);
 assert.deepEqual(f.counts(),{created:0,selected:0});
 const old=await f.post("/setup",{action:"custom",customPath:f.target});assert.equal(old.status,200);assert.equal((await old.json()).root,await fs.realpath(f.target));
 }finally{await f.close();}
});
test("unauthorized/cross-origin/foreign fields never initialize the native helper",async()=>{
 const f=await fixture();try{
 assert.equal((await f.post("/fs/native-picker",{title:"Notes"},{headers:{"content-type":"application/json"}})).status,403);
 assert.equal((await f.post("/fs/native-picker",{title:"Notes"},{headers:{...f.headers,origin:"https://fixture.invalid"}})).status,403);
 assert.equal((await f.post("/fs/native-picker",{title:"Notes",parentPid:7})).status,400);assert.equal(f.counts().created,0);
 }finally{await f.close();}
});
test("disconnect cancels its real HTTP operation but completed response does not cancel",async()=>{
 let start;const started=new Promise(r=>start=r);let aborted=0;
 const f=await fixture({select:({signal})=>new Promise(resolve=>{signal.addEventListener("abort",()=>{aborted++;resolve({ok:true,status:"cancelled"});},{once:true});start();})});
 try{const abort=new AbortController();const pending=f.post("/fs/native-picker",{title:"Notes"},{signal:abort.signal});await started;abort.abort();await assert.rejects(pending);for(let i=0;i<20 && !aborted;i++)await new Promise(r=>setTimeout(r,10));assert.equal(aborted,1);}
 finally{await f.close();}
 const normal=await fixture({select:async({signal})=>{signal.addEventListener("abort",()=>aborted++);return {ok:true,status:"cancelled"};}});
 try{const reply=await normal.post("/fs/native-picker",{title:"Notes"});assert.equal(reply.status,200);await reply.json();await new Promise(r=>setTimeout(r,20));assert.equal(aborted,1);}finally{await normal.close();}
});
test("Windows custom confirmation uses the original setup path without a second native validator",async()=>{
 const f=await fixture();
 try{
  const res=await f.post("/setup/native",{action:"custom",customPath:f.target});
  assert.equal(res.status,200);assert.equal((await res.json()).root,await fs.realpath(f.target));
  assert.deepEqual(f.counts(),{created:0,selected:0});
  assert.equal(await fs.readFile(path.join(f.data,"bindings.json"),"utf8").then(async text=>JSON.parse(text).bindings[await fs.realpath(f.project)].path),await fs.realpath(f.target));
 }finally{await f.close();}
});
test("native confirm keeps original refusal of deleted, occupied and linked folders",async()=>{
 for(const scenario of ['deleted','occupied','linked','unwritable']) {
  const f=await fixture();const originalOpen=fs.open;
  try{
   let target=f.target;
   if(scenario==='deleted')await fs.rmdir(target);
   if(scenario==='occupied'){await fs.mkdir(path.join(target,'conversation_todo'));await fs.writeFile(path.join(target,'conversation_todo','fixture.md'),'fixture');}
   if(scenario==='linked'){target=path.join(f.base,'link');await fs.symlink(f.target,target,process.platform==='win32'?'junction':'dir');}
   if(scenario==='unwritable'){const resolvedTarget=await fs.realpath(target);fs.open=async(file,...args)=>{if(String(file).startsWith(path.join(resolvedTarget,'.codex-notes-probe-')))throw Object.assign(Error('fixture access denied'),{code:'EACCES'});return originalOpen(file,...args);};}
   const res=await f.post('/setup/native',{action:'custom',customPath:target});assert.equal(res.status,400);assert.equal((await res.json()).code,scenario==='occupied'?'LOCATION_OCCUPIED':scenario==='unwritable'?'LOCATION_UNUSABLE':'LOCATION_INVALID');
   assert.equal(await fs.access(path.join(f.data,'bindings.json')).then(()=>true,()=>false),false);
  }finally{fs.open=originalOpen;await f.close();}
 }
});
test("Windows default/adopt keep old setup semantics and do not load the helper",async()=>{
 const f=await fixture();try{
  const response=await f.post('/setup',{action:'default'});assert.equal(response.status,200);assert.equal((await response.json()).root,path.join(await fs.realpath(f.project),'notes'));assert.equal(await fs.access(path.join(f.project,'notes')).then(()=>true,()=>false),false);assert.equal(f.counts().created,0);
 }finally{await f.close();}
 const legacy=await fixture();try{
  const lane=path.join(legacy.project,'notes','conversation_todo');await fs.mkdir(lane,{recursive:true});await fs.writeFile(path.join(lane,'fixture.md'),'legacy');
  assert.equal((await legacy.post('/fs/native-picker',{title:'Notes'})).status,400);assert.equal(legacy.counts().created,0);
  const adopted=await legacy.post('/setup',{action:'adopt'});assert.equal(adopted.status,200);assert.equal((await adopted.json()).root,path.join(await fs.realpath(legacy.project),'notes'));assert.equal(await fs.readFile(path.join(lane,'fixture.md'),'utf8'),'legacy');
 }finally{await legacy.close();}
});
test("the native setup alias accepts only an explicit custom candidate",async()=>{
 const f=await fixture();try{
  const missing=await f.post("/setup/native",{customPath:f.target});assert.equal(missing.status,400);assert.equal((await missing.json()).code,"BAD_ACTION");
  const defaultAction=await f.post("/setup/native",{action:"default",customPath:f.target});assert.equal(defaultAction.status,400);assert.equal((await defaultAction.json()).code,"BAD_ACTION");
  assert.equal(await fs.access(path.join(f.data,"bindings.json")).then(()=>true,()=>false),false);
 }finally{await f.close();}
});
