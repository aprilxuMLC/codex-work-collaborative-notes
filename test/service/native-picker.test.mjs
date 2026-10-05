import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { NativeFolderPicker } from "../../plugins/collaborative-notes/server/lib/windows-folder-picker.js";
function fixture(opts={}){
 const children=[];
 const spawn=(exe,args,options)=>{const c=new EventEmitter();c.spawnOptions=options;c.pid=123;c.exitCode=null;c.signalCode=null;c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.sent="";c.stdin.on("data",b=>c.sent+=b);c.kill=()=>{c.signalCode="SIGKILL";queueMicrotask(()=>c.emit("close",null,"SIGKILL"));return true;};children.push(c);return c;};
 const picker=new NativeFolderPicker({dataDir:"fixture-data",platform:"win32",spawn,realpath:async()=>"C:\\fixture-data",initMs:100,selectMs:100,closeMs:10,...opts});
 const frame=(c,x)=>c.stdout.write(JSON.stringify(x)+"\n");
 const complete=(c,status="selected",path="D:\\中文 空格 ' &")=>{frame(c,{type:"ready"});frame(c,{type:"result",status,...(status==="selected"?{path}:{})});c.exitCode=0;c.emit("exit",0,null);};
 return {picker,children,frame,complete};
}
test("each helper invocation uses one private temp directory removed after helper close",async()=>{
 const f=fixture(),pending=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const c=f.children[0];
 const init=JSON.parse(c.sent.split(String.fromCharCode(10))[0]);f.complete(c,"cancelled");c.emit("close",0,null);await pending;
 assert.equal(typeof init.tempDirectory,"string");assert.ok(path.isAbsolute(init.tempDirectory));
 assert.equal(c.spawnOptions.env.TEMP,init.tempDirectory);assert.equal(c.spawnOptions.env.TMP,init.tempDirectory);
 await assert.rejects(fs.stat(init.tempDirectory),error=>error.code==="ENOENT");
});
test("temporary directory cleanup failure logs once and does not alter selection",async()=>{
 let cleanupCalls=0,tempDirectory=null;const logs=[],originalLog=console.error;console.error=(...args)=>logs.push(args);
 const f=fixture({removeTempDirectory:async(directory)=>{cleanupCalls++;tempDirectory=directory;throw Object.assign(new Error("fixture"),{code:"EACCES"});}});
 try{
  const pending=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const c=f.children[0];
  const init=JSON.parse(c.sent.split(String.fromCharCode(10))[0]);tempDirectory=init.tempDirectory;
  const chosen="D:"+String.fromCharCode(92,92)+"notes";f.complete(c,"selected",chosen);c.emit("close",0,null);
  const result=await pending;assert.equal(result.status,"selected");assert.equal(result.path,chosen);
  assert.equal(cleanupCalls,1);assert.deepEqual(logs,[["PICKER_TEMP_CLEANUP_FAILED","EACCES"]]);
 }finally{console.error=originalLog;if(tempDirectory)await fs.rm(tempDirectory,{recursive:true,force:true});}
});
test("stalled temp cleanup is bounded and cannot change the selected result",async()=>{
 const {performance}=await import("node:perf_hooks");let tempDirectory=null;const logs=[],originalLog=console.error;console.error=(...args)=>logs.push(args);
 const f=fixture({removeTempDirectory:()=>new Promise(()=>{})});
 try{
  const pending=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const c=f.children[0];
  const init=JSON.parse(c.sent.split(String.fromCharCode(10))[0]);tempDirectory=init.tempDirectory;
  f.complete(c,"selected");c.emit("close",0,null);const started=performance.now(),closing=f.picker.close();
  const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error("cleanup blocked selection")),1400))]);
  await closing;assert.equal(result.status,"selected");assert.ok(performance.now()-started<1300);assert.deepEqual(logs,[["PICKER_TEMP_CLEANUP_FAILED","TIMEOUT"]]);
 }finally{console.error=originalLog;if(tempDirectory)await fs.rm(tempDirectory,{recursive:true,force:true});}
});
test("PowerShell spawn failure reports unavailable and removes its private directory",async()=>{
 let tempDirectory=null;const f=fixture({spawn:(exe,args,options)=>{tempDirectory=options.env.TEMP;throw Object.assign(Error("PowerShell missing"),{code:"ENOENT"});}});
 await assert.rejects(f.picker.select({title:"Notes"}),error=>error.code==="PICKER_UNAVAILABLE");
 assert.equal(typeof tempDirectory,"string");await assert.rejects(fs.stat(tempDirectory),error=>error.code==="ENOENT");
});
test("selected path is accepted only after the real close event and preserves UTF-8",async()=>{
 const f=fixture(),promise=f.picker.select({title:"选择便签目录"});await new Promise(r=>setImmediate(r));const c=f.children[0];f.complete(c);
 let settled=false;promise.then(()=>settled=true);await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(f.picker.active,true);
 c.emit("close",0,null);assert.deepEqual(await promise,{ok:true,status:"selected",path:"D:\\中文 空格 ' &"});assert.equal(f.picker.active,false);
});
test("UNC selection remains a candidate for the original setup path",async()=>{
 const networkPath=String.fromCharCode(92,92)+"fixture-server"+String.fromCharCode(92)+"share"+String.fromCharCode(92)+"notes";
 const f=fixture(),pending=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const child=f.children[0];f.complete(child,"selected",networkPath);child.emit("close",0,null);
 assert.deepEqual(await pending,{ok:true,status:"selected",path:networkPath});
});
test("parallel requests reserve the picker before awaiting path normalization",async()=>{
 let release;const f=fixture({realpath:()=>new Promise(r=>release=r)});const first=f.picker.select({title:"Notes"});await assert.rejects(f.picker.select({title:"Notes"}),e=>e.code==="PICKER_BUSY");release("C:\\fixture-data");await new Promise(r=>setImmediate(r));f.complete(f.children[0],"cancelled");f.children[0].emit("close",0,null);assert.equal((await first).status,"cancelled");
});
test("aborted request ignores a late selected path and sends cancellation only to its child",async()=>{
 const f=fixture(),abort=new AbortController(),p=f.picker.select({title:"Notes",signal:abort.signal});await new Promise(r=>setImmediate(r));const c=f.children[0];abort.abort();f.complete(c);c.emit("close",0,null);assert.equal((await p).status,"cancelled");assert.match(c.sent,/client_closed/);assert.equal(f.picker.active,false);
});
test("duplicate terminal and malformed UTF-8 outputs fail closed",async()=>{
 for(const malformed of [false,true]){const f=fixture(),p=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const c=f.children[0];f.frame(c,{type:"ready"});if(malformed)c.stdout.write(Buffer.from([0xc3,0x28]));else{f.frame(c,{type:"result",status:"cancelled"});f.frame(c,{type:"result",status:"selected",path:"D:\\bad"});}c.exitCode=0;c.emit("close",0,null);await assert.rejects(p,e=>e.code==="PICKER_FAILED");assert.equal(f.picker.active,false);}
});
test("a successful terminal with a failed exit is never accepted",async()=>{const f=fixture(),p=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));f.complete(f.children[0]);f.children[0].emit("close",1,null);await assert.rejects(p,e=>e.code==="PICKER_FAILED");});
test("initialization timeout cancels, kills only its own process and waits close",async()=>{const f=fixture({initMs:5}),p=f.picker.select({title:"Notes"});await assert.rejects(p,e=>e.code==="PICKER_TIMEOUT");assert.equal(f.children.length,1);assert.match(f.children[0].sent,/timeout/);assert.equal(f.picker.active,false);});
test("closing refuses new requests and drains the owned picker",async()=>{const f=fixture(),p=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const closing=f.picker.close();await assert.rejects(f.picker.select({title:"Notes"}),e=>e.code==="SERVICE_CLOSING");await p;await closing;assert.equal(f.picker.active,false);});
test("non-Windows never invokes the native process",async()=>{const f=fixture({platform:"darwin"});await assert.rejects(f.picker.select({title:"Notes"}),e=>e.code==="PICKER_UNAVAILABLE");assert.equal(f.children.length,0);});

test("cancelled during initialization is a valid terminal without ready",async()=>{
 const f=fixture(),a=new AbortController(),p=f.picker.select({title:'Notes',signal:a.signal});await new Promise(r=>setImmediate(r));a.abort();f.frame(f.children[0],{type:'result',status:'cancelled'});f.children[0].emit('close',0,null);assert.equal((await p).status,'cancelled');
});
test("unexpected fields, truncated frames and excessive output fail closed",async()=>{
 for(const variant of ['field','truncated','limit','before-ready']){
 const f=fixture(),p=f.picker.select({title:'Notes'});await new Promise(r=>setImmediate(r));const c=f.children[0];
 if(variant==='field'){f.frame(c,{type:'ready'});f.frame(c,{type:'result',status:'cancelled',command:'forbidden'});}else if(variant==='truncated')c.stdout.write('{"type":"ready');else if(variant==='limit')c.stdout.write(' '.repeat(128*1024+1));else f.frame(c,{type:'result',status:'selected',path:'C:\\invalid'});
 c.emit('close',0,null);await assert.rejects(p,e=>e.code===(variant==='field'?'PICKER_FAILED':'PICKER_UNAVAILABLE'));
 }
});
test("an old abort cannot cancel a new picker",async()=>{
 const f=fixture(),old=new AbortController(),p=f.picker.select({title:'Notes',signal:old.signal});await new Promise(r=>setImmediate(r));f.complete(f.children[0],'cancelled');f.children[0].emit('close',0,null);await p;
 const fresh=f.picker.select({title:'Notes'});await new Promise(r=>setImmediate(r));old.abort();f.complete(f.children[1]);f.children[1].emit('close',0,null);assert.equal((await fresh).status,'selected');assert.doesNotMatch(f.children[1].sent,/client_closed/);
});
test("closing during path preparation never starts a child",async()=>{
 let release;const f=fixture({realpath:()=>new Promise(r=>release=r)}),p=f.picker.select({title:'Notes'});await f.picker.close();release('C:\\fixture-data');await assert.rejects(p,e=>e.code==='SERVICE_CLOSING');assert.equal(f.children.length,0);
});
test("a selected candidate survives a helper cleanup timeout after result delivery",async()=>{
 const f=fixture({selectMs:50,closeMs:10}),pending=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const child=f.children[0];
 f.frame(child,{type:"ready"});f.frame(child,{type:"result",status:"selected",path:"D:"+String.fromCharCode(92)+"candidate"});
 const result=await pending;assert.deepEqual(result,{ok:true,status:"selected",path:"D:"+String.fromCharCode(92)+"candidate"});
 assert.equal(child.signalCode,"SIGKILL");assert.equal(f.picker.active,false);
});
test("selection deadline starts at ready and excludes compilation time",async()=>{
 const f=fixture({initMs:100,selectMs:5}),p=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));f.frame(f.children[0],{type:"ready"});await assert.rejects(p,e=>e.code==="PICKER_TIMEOUT");
});
test("asynchronous stdin errors cannot crash the shared service or release a live child",async()=>{
 for(const cancelled of [false,true]){
 const f=fixture(),abort=new AbortController(),p=f.picker.select({title:'Notes',signal:abort.signal});await new Promise(r=>setImmediate(r));const c=f.children[0];if(cancelled)abort.abort();
 assert.doesNotThrow(()=>c.stdin.emit('error',Object.assign(Error('write EPIPE'),{code:'EPIPE'})));assert.equal(f.picker.active,true);c.emit('close',1,null);
 if(cancelled)assert.equal((await p).status,'cancelled');else await assert.rejects(p,e=>e.code==='PICKER_UNAVAILABLE');
 }
});
test("shutdown and abort drain path preparation even if filesystem lookup never returns",async()=>{
 const f=fixture({realpath:()=>new Promise(()=>{})});const p=f.picker.select({title:'Notes'});const closing=f.picker.close();
 const outcome=await Promise.race([p.catch(e=>e.code),new Promise(r=>setTimeout(()=>r('STUCK'),100))]);assert.equal(outcome,'SERVICE_CLOSING');await closing;assert.equal(f.children.length,0);
 const a=fixture({realpath:()=>new Promise(()=>{})}),abort=new AbortController(),pending=a.picker.select({title:'Notes',signal:abort.signal});abort.abort();assert.equal((await pending).status,'cancelled');assert.equal(a.children.length,0);
});
test("delayed event-loop timers cannot admit a late dialog or selected path",async()=>{
 const {performance}=await import("node:perf_hooks");
 for(const phase of ["ready","select-close"]){
  const f=fixture({initMs:20,selectMs:20}),p=f.picker.select({title:"Notes"});await new Promise(r=>setImmediate(r));const c=f.children[0];
  if(phase==="select-close")f.frame(c,{type:"ready"});
  const until=performance.now()+35;while(performance.now()<until){}
  if(phase==="ready")f.frame(c,{type:"ready"});
  f.frame(c,{type:"result",status:"selected",path:"C:\\late"});c.emit("close",0,null);await assert.rejects(p,e=>e.code==="PICKER_TIMEOUT");
 }
});
test("shutdown drains owned pipes after actual exit without accepting the selected path",async()=>{
 const f=fixture(),p=f.picker.select({title:'Notes'});await new Promise(r=>setImmediate(r));const c=f.children[0];let kills=0;c.kill=()=>{kills++;return false;};
 let streamCloses=0;for(const stream of [c.stdin,c.stdout,c.stderr])stream.once('close',()=>{if(++streamCloses===3)c.emit('close',0,null);});
 f.complete(c);const closing=f.picker.close();assert.equal((await p).status,'cancelled');await closing;assert.equal(kills,0);assert.equal(c.stdout.destroyed,true);assert.equal(c.stderr.destroyed,true);assert.equal(f.picker.active,false);
});
test("forced cleanup waits for actual exit before destroying its owned pipe ends",async()=>{
 const f=fixture(),abort=new AbortController(),p=f.picker.select({title:'Notes',signal:abort.signal});await new Promise(r=>setImmediate(r));const c=f.children[0];let killed=false;
 let streamCloses=0;for(const stream of [c.stdin,c.stdout,c.stderr])stream.once('close',()=>{if(++streamCloses===3)c.emit('close',null,'SIGKILL');});
 c.kill=()=>{killed=true;assert.equal(c.stdout.destroyed,false);setTimeout(()=>{c.signalCode='SIGKILL';c.emit('exit',null,'SIGKILL');},5);return true;};
 abort.abort();assert.equal((await p).status,'cancelled');assert.equal(killed,true);assert.equal(c.stdout.destroyed,true);assert.equal(f.picker.active,false);
});