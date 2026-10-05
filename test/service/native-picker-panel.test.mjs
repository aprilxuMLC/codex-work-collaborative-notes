import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// Execute the shipped panel code; only startup and unrelated renderers are replaced.
class Element {
  constructor(tag="div") { this.tag=tag;this.children=[];this.listeners={};this.value="";this.dataset={};this.classList={add(){},toggle(){},remove(){}}; }
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  setAttribute(){} focus(){} querySelector(){return null;}
}
async function panel({native=true,reply,instance=null}={}) {
  const elements=new Map(),events={},calls=[];let nonce=0;
  const document={documentElement:{dataset:instance?{cnPanel:instance}:{}},getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:tag=>new Element(tag),addEventListener(){}};
  const sandbox={crypto:{randomUUID:()=> (++nonce).toString(16).padStart(32,'0')},document,location:{pathname:"/t/thread-panel-fixture",reload(){}},AbortController,console,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},addEventListener:(name,fn)=>events[name]=fn};
  const beacons=[];sandbox.navigator={sendBeacon:(url,body)=>{beacons.push({url,body:JSON.parse(body)});return true;}};
  sandbox.window=sandbox;sandbox.globalThis=sandbox;
  sandbox.fetch=async(url,options={})=>{
    const call={url,method:options.method||"GET",body:options.body?JSON.parse(options.body):undefined,signal:options.signal,headers:options.headers||{}};calls.push(call);
    const result=await reply?.(call);
    if(result instanceof Error)throw result;
    const value=result||{status:200,data:{ok:true,status:"selected",path:"D:\\候选目录"}};
    return {ok:value.status<400,status:value.status,text:async()=>JSON.stringify(value.data)};
  };
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/i18n.js",import.meta.url),"utf8"),sandbox);
  let source=await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js",import.meta.url),"utf8");
  source=source.replace("loadContext().then(startPolling);",`
    renderAll = () => renderSetup();
    loadContext = async () => { const next=await api("/context");context=next;renderAll(); };
    loadLane = async () => null;
    global.testPanel={openPicker,completeSetup,renderSetup,
      get state(){return {context,nativeCandidate,nativeBusy,setupBusy,composerDraft,status,setupUncertain:typeof setupUncertain==='undefined'?false:setupUncertain};},
      fixture(value){context=value;locale='zh';namingNeeded=true;setupLabels=Object.fromEntries(LANE_KEYS.map(key=>[key,key]));composerDraft='隔离测试草稿';composerTouched=true;renderSetup();}
    };
  `);
  vm.runInContext(source,sandbox);
  sandbox.testPanel.fixture({nativeFolderPicker:native||undefined,projectPath:"C:\\project",setup:{state:"UNINITIALIZED",legacy:false}});
  return {app:sandbox.testPanel,calls,elements,events,beacons};
}
const configured=root=>({status:200,data:{ok:true,root,state:"INITIALIZED"}});
const context=root=>({status:200,data:{nativeFolderPicker:true,projectPath:"C:\\project",setup:{state:"INITIALIZED",root}}});

test("panel selection changes only candidate; polling retains controls; cancellation preserves draft",async()=>{
 const p=await panel();await p.app.openPicker();assert.equal(p.calls.length,1);assert.ok(p.calls[0].url.endsWith('/fs/native-picker'));assert.equal(p.app.state.nativeCandidate,'D:\\候选目录');
 const gate=p.elements.get('setup-gate'),first=gate.children[0];p.app.renderSetup();assert.equal(gate.children[0],first);
 const cancel=gate.children.find(el=>el.textContent==='取消本次选择');cancel.listeners.click();assert.equal(p.app.state.nativeCandidate,null);assert.equal(p.app.state.composerDraft,'隔离测试草稿');assert.equal(p.calls.length,1);
});
test("system cancel and failed reselect preserve the prior candidate",async()=>{
 let count=0;const p=await panel({reply:()=>++count===1?undefined:count===2?{status:200,data:{ok:true,status:'cancelled'}}:{status:503,data:{code:'PICKER_UNAVAILABLE'}}});
 await p.app.openPicker();await p.app.openPicker();await p.app.openPicker();assert.equal(p.app.state.nativeCandidate,'D:\\候选目录');assert.equal(p.app.state.composerDraft,'隔离测试草稿');
});
test("native confirmation keeps naming success separate from refused binding",async()=>{
 const p=await panel({reply:call=>call.url==='/api/lane-config'?{status:200,data:{laneOverrides:{}}}:{status:400,data:{code:'LOCATION_INVALID'}}});
 await p.app.completeSetup('custom','D:\\candidate',{native:true});assert.equal(p.calls.length,2);assert.ok(p.calls[1].url.endsWith('/setup/native'));
 assert.equal(p.app.state.status.key,'setup.namesOnly');assert.equal(p.app.state.composerDraft,'隔离测试草稿');assert.equal(p.app.state.context.setup.state,'UNINITIALIZED');
});
test("lost binding response reconciles root without repeating setup or saving the draft",async()=>{
 const p=await panel({reply:call=>call.url==='/api/lane-config'?{status:200,data:{}}:call.url.endsWith('/context')?context('D:\\candidate'):new TypeError('lost response')});
 await p.app.completeSetup('custom','D:\\candidate',{native:true});assert.equal(p.app.state.status.key,'setup.resultUnknown');assert.equal(p.app.state.context.setup.root,'D:\\candidate');assert.equal(p.app.state.composerDraft,'隔离测试草稿');
 await p.app.completeSetup('custom','D:\\candidate',{native:true});assert.equal(p.calls.filter(c=>c.method==='POST').length,1);
});
test("another page wins binding; this page never auto-saves into that location",async()=>{
 const p=await panel({reply:call=>call.url==='/api/lane-config'?{status:200,data:{}}:call.url.endsWith('/context')?context('D:\\other'):{status:409,data:{code:'ALREADY_INITIALIZED'}}});
 await p.app.completeSetup('custom','D:\\candidate',{native:true});assert.equal(p.app.state.status.key,'setup.configuredElsewhere');assert.equal(p.app.state.context.setup.root,'D:\\other');assert.equal(p.app.state.composerDraft,'隔离测试草稿');assert.equal(p.calls.filter(c=>c.method==='POST').length,1);
});
test("confirmed binding continues saving; failed save reports configured root and preserves draft",async()=>{
 for(const saved of [true,false]){
 const p=await panel({reply:call=>call.url==='/api/lane-config'?{status:200,data:{}}:call.url.endsWith('/setup/native')?configured('D:\\candidate'):call.url.endsWith('/context')?context('D:\\candidate'):{status:saved?200:500,data:saved?{ok:true}:{code:'WRITE_FAILED'}}});
 await p.app.completeSetup('custom','D:\\candidate',{native:true});assert.equal(p.app.state.context.setup.state,'INITIALIZED');assert.equal(p.app.state.composerDraft,saved?'':'隔离测试草稿');assert.equal(p.app.state.status.key,saved?'status.savedNote':'setup.draftPending');
 }
});
test("pagehide aborts the owned picker, while focus does not cancel it",async()=>{
 let resolve;const p=await panel({reply:()=>new Promise(r=>resolve=r)});const pending=p.app.openPicker();await new Promise(r=>setImmediate(r));const signal=p.calls[0].signal;assert.equal(signal.aborted,false);p.events.pagehide();assert.equal(signal.aborted,true);resolve({status:200,data:{status:'selected',path:'D:\\late'}});await pending;assert.equal(p.app.state.nativeCandidate,null);
});
test("Mac opens the original in-panel picker and original setup endpoint",async()=>{
 const p=await panel({native:false,reply:call=>call.url.includes('/fs?')?{status:200,data:{path:'/tmp/project',entries:[],parent:'/tmp'}}:call.url==='/api/lane-config'?{status:200,data:{}}:call.url.endsWith('/setup')?configured('/tmp/notes'):call.url.endsWith('/context')?context('/tmp/notes'):{status:200,data:{ok:true}}});
 await p.app.openPicker();assert.ok(p.calls[0].url.includes('/fs?'));await p.app.completeSetup('custom','/tmp/notes');assert.equal(p.calls.some(c=>c.url.endsWith('/setup/native')),false);assert.equal(p.calls.some(c=>c.url.endsWith('/setup')),true);
});
test("once setup is executing, cancellation and naming controls are disabled",async()=>{
 let release;const p=await panel({reply:call=>call.url.endsWith('/fs/native-picker')?undefined:call.url==='/api/lane-config'?new Promise(r=>release=r):{status:400,data:{code:'LOCATION_INVALID'}}});
 await p.app.openPicker();const confirming=p.app.completeSetup('custom','D:\\candidate',{native:true});await new Promise(r=>setImmediate(r));
 const children=p.elements.get('setup-gate').children;assert.equal(children.find(el=>el.textContent==='取消本次选择').disabled,true);assert.equal(children.find(el=>el.textContent==='确认使用此位置').disabled,true);
 release({status:200,data:{}});await confirming;assert.equal(p.app.state.composerDraft,'隔离测试草稿');
});
test("native picker failure opens fallback and a later cancellation preserves the draft",async()=>{
 let nativeCount=0;const p=await panel({reply:call=>{
  if(call.url.endsWith('/fs/native-picker'))return ++nativeCount===1?{status:503,data:{code:'PICKER_UNAVAILABLE'}}:{status:200,data:{ok:true,status:'cancelled'}};
  if(call.url.includes('/fs?'))return {status:200,data:{ok:true,path:'C:\\\\project',parent:'C:\\\\',entries:[],breadcrumbs:[{name:'C:\\\\',path:'C:\\\\'},{name:'project',path:'C:\\\\project'}],drives:['C:\\\\']}};
 }});
 await p.app.openPicker();assert.equal(p.app.state.status.key,'setup.nativeFallback');assert.ok(p.calls.some(call=>call.url.includes('/fs?path=')));
 assert.equal(p.app.state.composerDraft,'隔离测试草稿');
 const gate=p.elements.get('setup-gate'),all=[];const visit=node=>{all.push(node);for(const child of node.children||[])visit(child);};visit(gate);const again=all.find(el=>el.textContent==='选择其他位置');assert.ok(again);await again.listeners.click();
 assert.equal(nativeCount,2);assert.equal(p.app.state.status.key,'setup.nativeCancelled');assert.equal(p.app.state.composerDraft,'隔离测试草稿');
});
test("native cancel invalidates a late fallback browse response",async()=>{
 let release;const p=await panel({reply:call=>call.url.endsWith("/fs/native-picker")?{status:503,data:{code:"PICKER_UNAVAILABLE"}}:call.url.includes("/fs?")?new Promise(r=>release=r):undefined});
 const opening=p.app.openPicker();await new Promise(r=>setImmediate(r));
 const gate=p.elements.get("setup-gate"),cancel=gate.children.find(el=>el.textContent==="取消本次选择");assert.ok(cancel);cancel.listeners.click();
 release({status:200,data:{ok:true,path:"C:"+String.fromCharCode(92)+"late",parent:"C:"+String.fromCharCode(92),entries:[],drives:["C:"+String.fromCharCode(92)]}});await opening;
 const items=[];const visit=node=>{items.push(node);for(const child of node.children||[])visit(child);};visit(gate);
 assert.equal(items.some(el=>el.className==="picker"),false);assert.equal(p.app.state.status.key,"setup.nativeCancelled");assert.equal(p.app.state.composerDraft,"隔离测试草稿");
});
test("native timeout and helper failure both open the same folder fallback",async()=>{
 for(const [code,status] of [["PICKER_TIMEOUT",504],["PICKER_FAILED",502]]){
  const p=await panel({reply:call=>call.url.endsWith("/fs/native-picker")?{status,data:{code}}:call.url.includes("/fs?")?{status:200,data:{ok:true,path:"C:"+String.fromCharCode(92)+"project",parent:"C:"+String.fromCharCode(92),entries:[],breadcrumbs:[{name:"C:",path:"C:"+String.fromCharCode(92) }],drives:["C:"+String.fromCharCode(92)]}}:undefined});
  await p.app.openPicker();assert.equal(p.app.state.status.key,"setup.nativeFallback");assert.ok(p.calls.some(call=>call.url.includes("/fs?path=")));
 }
});
test("busy and invalid native picker failures open the in-panel fallback",async()=>{
 for(const [code,status] of [["PICKER_BUSY",409],["LOCATION_INVALID",400]]){
  const p=await panel({reply:call=>call.url.endsWith("/fs/native-picker")?{status,data:{code}}:call.url.includes("/fs?")?{status:200,data:{ok:true,path:"C:"+String.fromCharCode(92)+"project",parent:"C:"+String.fromCharCode(92),entries:[],breadcrumbs:[{name:"C:",path:"C:"+String.fromCharCode(92)}],drives:["C:"+String.fromCharCode(92)]}}:undefined});
  await p.app.openPicker();assert.equal(p.app.state.status.key,"setup.nativeFallback");assert.ok(p.calls.some(call=>call.url.includes("/fs?path=")));
 }
});
test("native cancellation and service closing do not open the in-panel fallback",async()=>{
 const cancelled=await panel({reply:call=>call.url.endsWith("/fs/native-picker")?{status:200,data:{ok:true,status:"cancelled"}}:undefined});
 await cancelled.app.openPicker();assert.equal(cancelled.app.state.status.key,"setup.nativeCancelled");assert.equal(cancelled.calls.some(call=>call.url.includes("/fs?path=")),false);
 const closing=await panel({reply:call=>call.url.endsWith("/fs/native-picker")?{status:503,data:{code:"SERVICE_CLOSING"}}:undefined});
 await closing.app.openPicker();assert.equal(closing.app.state.status.key,"status.folderFailed");assert.equal(closing.calls.some(call=>call.url.includes("/fs?path=")),false);
});
test("Windows page instance accompanies API calls; pagehide closes only its instance and pageshow checks in",async()=>{
 const instance='f'.repeat(32),p=await panel({instance});await p.app.openPicker();assert.equal(p.calls[0].headers['x-cn-panel-instance'],instance);
 p.events.pagehide();assert.deepEqual(p.beacons.map(x=>({url:x.url,panelId:x.body.panelId})),[{url:'/api/t/thread-panel-fixture/panel/closed',panelId:instance}]);
 p.events.pageshow();assert.equal(p.calls.at(-1).url,'/api/t/thread-panel-fixture/context');assert.equal(p.calls.at(-1).headers['x-cn-panel-instance'],instance);
});
test("Mac pages send no new presence header or close beacon",async()=>{
 const p=await panel({native:false,reply:()=>({status:200,data:{path:'/fixture',entries:[],breadcrumbs:[]}})});await p.app.openPicker();assert.equal(p.calls[0].headers['x-cn-panel-instance'],undefined);p.events.pagehide();assert.equal(p.beacons.length,0);
});
test('BFCache activates a fresh presence id; old delayed close targets only the prior id',async()=>{
 const old='f'.repeat(32),p=await panel({instance:old,reply:call=>call.url.endsWith('/panel/present')?{status:200,data:{panelId:call.body.panelId}}:undefined});p.events.pagehide();await p.events.pageshow({persisted:true});await p.app.openPicker();const present=p.calls.find(x=>x.url.endsWith('/panel/present'));assert.notEqual(present.body.panelId,old);assert.equal(p.calls.at(-1).headers['x-cn-panel-instance'],present.body.panelId);assert.equal(p.beacons[0].body.panelId,old);
});
test('a renewal reply after pagehide closes only its own nonce and cannot leave a live restored page',async()=>{
 let release;const gate=new Promise(r=>release=r);const p=await panel({instance:'f'.repeat(32),reply:async call=>{if(call.url.endsWith('/panel/present')){await gate;return {status:200,data:{panelId:call.body.panelId}};}}});p.events.pagehide();const restoring=p.events.pageshow({persisted:true});const id=p.calls.at(-1).body.panelId;p.events.pagehide();release();await restoring;assert.ok(p.beacons.some(x=>x.body.panelId===id));
});
test('Windows native setup falls back to the in-panel drive picker and confirms through original setup',async()=>{
 const calls=[];
 const p=await panel({reply:call=>{
  calls.push(call);
  if(call.url.endsWith('/fs/native-picker'))return {status:503,data:{code:'PICKER_UNAVAILABLE'}};
  if(call.url.includes('/fs?'))return {status:200,data:{ok:true,path:'D:\\fixture',parent:'D:\\',entries:[{name:'测试 folder',path:'D:\\fixture\\测试 folder'}],breadcrumbs:[{name:'D:\\',path:'D:\\'},{name:'fixture',path:'D:\\fixture'}],drives:['C:\\','D:\\']}};
  if(call.url==='/api/lane-config')return {status:200,data:{}};
  if(call.url==='/api/t/thread-panel-fixture/setup')return {status:200,data:{ok:true,root:'D:\\fixture\\测试 folder',state:'INITIALIZED'}};
  if(call.url.endsWith('/context'))return {status:200,data:{nativeFolderPicker:true,projectPath:'C:\\project',setup:{state:'INITIALIZED',root:'D:\\fixture\\测试 folder'}}};
  return undefined;
 }});
 await p.app.openPicker();
 assert.ok(calls.some(call=>call.url.includes('/fs?path=')),'fallback lists the original filesystem');
 const gate=p.elements.get('setup-gate'),all=[];
 const visit=node=>{all.push(node);for(const child of node.children||[])visit(child);};visit(gate);
 const rootC='C:'+String.fromCharCode(92),rootD='D:'+String.fromCharCode(92);
 assert.ok(all.some(el=>el.textContent===rootC));assert.ok(all.some(el=>el.textContent===rootD));
 const folder=all.find(el=>el.textContent==='📁 测试 folder');assert.ok(folder);folder.listeners.click();await new Promise(r=>setImmediate(r));
 const displayed=()=>{const items=[];const visitNode=node=>{items.push(node);for(const child of node.children||[])visitNode(child);};visitNode(gate);return items.find(el=>el.className==='picker-path')?.textContent;};
 await p.app.completeSetup('custom','D:\\fixture\\测试 folder',{native:false});
 assert.equal(calls.some(call=>call.url.endsWith('/setup/native')),false);assert.equal(calls.filter(call=>call.url.endsWith('/setup')).length,1);
 assert.equal(p.app.state.context.setup.state,'INITIALIZED');
});
