import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {NativeFolderPicker} from '../plugins/collaborative-notes/server/lib/windows-folder-picker.js';
const root=process.env.CN_NATIVE_ARTIFACTS;
if(process.platform!=='win32' || !root){
 test('Windows native picker integration requires Windows and isolated artifacts',{skip:true},()=>{});
}else{
const base=await fs.mkdtemp(path.join(root,'native-real-'));
const data=path.join(base,'data'),folder=path.join(base,"中文 空格 ' &");await fs.mkdir(data);await fs.mkdir(folder);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function observed(options={}) {
 let readyResolve,startedResolve;
 const ready=new Promise(r=>readyResolve=r),started=new Promise(r=>startedResolve=r),children=[],diagnostics=[];
 const picker=new NativeFolderPicker({dataDir:data,...options,spawn:(exe,args,opts)=>{
   const child=spawn(exe,args,opts);child.pickerTemp=opts.env.TEMP;child.stderr.on('data',bytes=>diagnostics.push(bytes.toString('utf8')));child.on("close",()=>child.closedConfirmed=true);children.push(child);startedResolve(child);
   let output='';child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(output.includes('{"type":"ready"}'))readyResolve(child);});return child;
 }});
 return {picker,children,ready,started,diagnostics};
}
const title='目录选择清理测试 · 无需操作';
test('measures five real Windows helper startup-to-ready times',async()=>{
 const {performance}=await import('node:perf_hooks'),samples=[];
 for(let i=0;i<5;i++){
  const f=observed(),abort=new AbortController(),started=performance.now();
  const pending=f.picker.select({initialPath:folder,title,signal:abort.signal});let ready=false;
  try{
   await Promise.race([f.ready.then(()=>{ready=true;}),pending.then(()=>{throw Error('helper closed before ready');})]);
   samples.push(Number((performance.now()-started).toFixed(1)));
  }finally{if(ready)abort.abort();await pending.catch(()=>{});await f.picker.close();}
 }
 const sorted=[...samples].sort((a,b)=>a-b);
 console.log(JSON.stringify({metric:'node-winps-csharp-start-to-ready',samplesMs:samples,minMs:sorted[0],medianMs:sorted[2],maxMs:sorted[4]}));
});
test('real dialog stays open beyond 10 seconds; Mutex refuses second helper; EOF closes first',async()=>{
 const first=observed(),p=first.picker.select({initialPath:folder,title});await first.ready;await sleep(11000);
 assert.equal(first.children[0].exitCode,null);
 assert.equal((first.diagnostics.join('').match(/native_dialog_foreground=(?:activated|denied)/g)||[]).length,1);
 assert.doesNotMatch(first.diagnostics.join(''),/native_dialog_foreground=unavailable/);
 const second=observed();await assert.rejects(second.picker.select({initialPath:folder,title}),e=>e.code==='PICKER_BUSY');await second.picker.close();
  const closingAt=Date.now();first.children[0].stdin.end();
 const result=await p.catch(error=>({code:error.code}));
 assert.ok(result.status==='cancelled' || result.code==='PICKER_FAILED');
 assert.equal(first.children[0].closedConfirmed,true);assert.ok(Date.now()-closingAt<4000);
 assert.throws(()=>process.kill(first.children[0].pid,0),error=>error.code==='ESRCH');
 await first.picker.close();
 const next=observed(),abort=new AbortController(),again=next.picker.select({initialPath:folder,title,signal:abort.signal});await next.ready;abort.abort();assert.equal((await again).status,'cancelled');await next.picker.close();
});
test('real PowerShell helper load failure maps to unavailable and removes temp files',async()=>{
 const missing=path.join(base,'missing-picker-helper.ps1');let child,tempDirectory='',diagnostic='';
 const picker=new NativeFolderPicker({dataDir:data,spawn:(exe,args,opts)=>{tempDirectory=opts.env.TEMP;args[args.length-1]=missing;child=spawn(exe,args,opts);child.stderr.on('data',bytes=>diagnostic+=bytes.toString('utf8'));return child;}});
 try{
  await assert.rejects(picker.select({initialPath:folder,title}),error=>error.code==='PICKER_UNAVAILABLE');
  assert.ok(child.exitCode!==null || child.signalCode!==null);assert.ok(diagnostic.length>0);
  await assert.rejects(fs.stat(tempDirectory),error=>error.code==='ENOENT');
 }finally{await picker.close();}
});
test('real C# compilation failure maps to unavailable and removes invocation temp files',async()=>{
 const helperDir=path.join(base,'compile-failure');await fs.mkdir(helperDir);
 const helper=path.join(helperDir,'windows-folder-picker.ps1'),code=path.join(helperDir,'windows-folder-picker.cs');
 await fs.copyFile(new URL('../plugins/collaborative-notes/server/windows-folder-picker.ps1',import.meta.url),helper);
 await fs.writeFile(code,'this is intentionally invalid C#;');
 let child,tempDirectory='',diagnostic='';
 const picker=new NativeFolderPicker({dataDir:data,spawn:(exe,args,opts)=>{tempDirectory=opts.env.TEMP;args[args.length-1]=helper;child=spawn(exe,args,opts);child.stderr.on('data',bytes=>diagnostic+=bytes.toString('utf8'));return child;}});
 try{
  await assert.rejects(picker.select({initialPath:folder,title}),error=>error.code==='PICKER_UNAVAILABLE');
  assert.ok(child.exitCode!==null || child.signalCode!==null);assert.ok(diagnostic.length>0);
  await assert.rejects(fs.stat(tempDirectory),error=>error.code==='ENOENT');
 }finally{await picker.close();await fs.rm(helperDir,{recursive:true,force:true});}
});
test('simulated slow PowerShell cleanup after result preserves the selected candidate',async()=>{
 const helperDir=path.join(base,'slow-cleanup');await fs.mkdir(helperDir);
 const ps=await fs.readFile(new URL('../plugins/collaborative-notes/server/windows-folder-picker.ps1',import.meta.url),'utf8');
 const start=ps.indexOf("    Add-Type -Path "),end=ps.indexOf("\n} catch {",start);assert.ok(start>=0&&end>start);
 const resultBlock=[
  "    $state['readyAt']=$clock.ElapsedMilliseconds",
  "    $state['ready']=$true",
  "    [Console]::WriteLine((ConvertTo-Json -Compress @{type='ready'}))",
  "    $result=ConvertTo-Json -Compress @{type='result';status='selected';path='D:\\fixture'}",
  "    $exitCode=0",
  "    [Console]::WriteLine($result)",
  "    [Console]::Out.Flush()"
 ].join('\n');
 let instrumented=ps.slice(0,start)+resultBlock+ps.slice(end);
 const cleanup="    $state['done']=$true";assert.equal(instrumented.split(cleanup).length-1,1);
 instrumented=instrumented.replace(cleanup,"    Start-Sleep -Seconds 5\n"+cleanup);
 const helper=path.join(helperDir,'slow-cleanup.ps1');await fs.writeFile(helper,instrumented);
 let child,tempDirectory='';
 const picker=new NativeFolderPicker({dataDir:data,selectMs:10000,closeMs:100,spawn:(exe,args,opts)=>{tempDirectory=opts.env.TEMP;args[args.length-1]=helper;child=spawn(exe,args,opts);return child;}});
 const started=Date.now();
 try{
  const result=await picker.select({initialPath:folder,title});
  assert.deepEqual(result,{ok:true,status:'selected',path:'D:'+String.fromCharCode(92)+'fixture'});
  assert.ok(Date.now()-started<2000);assert.ok(child.exitCode!==null||child.signalCode!==null);
  await assert.rejects(fs.stat(tempDirectory),error=>error.code==='ENOENT');
 }finally{await picker.close();await fs.rm(helperDir,{recursive:true,force:true});}
});
test('real cancellation during initialization closes the helper and discards all paths',async()=>{
 const f=observed(),abort=new AbortController(),p=f.picker.select({initialPath:folder,title,signal:abort.signal});await f.started;abort.abort();assert.equal((await p).status,'cancelled');assert.equal(f.children[0].closedConfirmed,true);assert.ok(f.children[0].exitCode!==null || f.children[0].signalCode!==null);await assert.rejects(fs.stat(f.children[0].pickerTemp),error=>error.code==='ENOENT');await f.picker.close();
});
test('real selection deadline closes the window and a terminated helper fails closed',async()=>{
 const timeout=observed({selectMs:200}),p=timeout.picker.select({initialPath:folder,title});await assert.rejects(p,e=>e.code==='PICKER_TIMEOUT');assert.equal(timeout.children[0].closedConfirmed,true);assert.ok(timeout.children[0].exitCode!==null || timeout.children[0].signalCode!==null);await timeout.picker.close();
 const killed=observed(),pending=killed.picker.select({initialPath:folder,title});await killed.ready;killed.children[0].kill('SIGKILL');await assert.rejects(pending,e=>e.code==='PICKER_FAILED');await killed.picker.close();
});
async function parentDeath(afterReady) {
 const module=new URL('../plugins/collaborative-notes/server/lib/windows-folder-picker.js',import.meta.url).href;
 const code=`import {spawn} from 'node:child_process';import {NativeFolderPicker} from ${JSON.stringify(module)};
 const picker=new NativeFolderPicker({dataDir:${JSON.stringify(data)},spawn:(exe,args,opts)=>{const child=spawn(exe,args,opts);process.stdout.write(JSON.stringify({event:'spawn',pid:child.pid,tempDir:opts.env.TEMP})+'\\n');let out='';child.stdout.on('data',bytes=>{out+=bytes.toString();if(out.includes('{"type":"ready"}'))process.stdout.write(JSON.stringify({event:'ready',pid:child.pid})+'\\n');});return child;}});
 await picker.select({initialPath:${JSON.stringify(folder)},title:${JSON.stringify(title)}});await picker.close();`;
 const parent=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let helperPid,parentTemp,text='',diagnostic='';parent.stderr.on('data',b=>diagnostic+=b);
 const marker=await new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>reject(Error('No parent marker: '+diagnostic)),20000);
  parent.stdout.on('data',bytes=>{text+=bytes.toString();let at;while((at=text.indexOf('\n'))>=0){const line=text.slice(0,at);text=text.slice(at+1);if(!line)continue;const item=JSON.parse(line);helperPid=item.pid;if(item.tempDir)parentTemp=item.tempDir;if(item.event===(afterReady?'ready':'spawn')){clearTimeout(deadline);resolve(item);}}});
  parent.once('error',reject);parent.once('exit',()=>{clearTimeout(deadline);reject(Error('Parent ended before marker: '+diagnostic));});
 });
 assert.equal(marker.pid,helperPid);parent.kill('SIGKILL');await new Promise(resolve=>parent.once('close',resolve));
 let gone=false;for(let n=0;n<100;n++){try{process.kill(helperPid,0);}catch(error){if(error.code==='ESRCH'){gone=true;break;}throw error;}await sleep(50);}
 if(gone && parentTemp)await fs.rm(parentTemp,{recursive:true,force:true});
 assert.equal(gone,true,`Owned helper ${helperPid} must exit after parent death`);
}
test('parent death before ready leaves no helper',()=>parentDeath(false));
test('parent death after ready leaves no helper and next picker works',async()=>{
 await parentDeath(true);const f=observed(),p=f.picker.select({initialPath:folder,title});await f.ready;await f.picker.close();assert.equal((await p).status,'cancelled');
});
test('real abandoned Mutex ownership is recovered on the same STA thread without showing another UI',async()=>{
 const fixtureDir=path.join(base,'abandoned-fixture');await fs.mkdir(fixtureDir);
 const csUrl=new URL('../plugins/collaborative-notes/server/windows-folder-picker.cs',import.meta.url),psUrl=new URL('../plugins/collaborative-notes/server/windows-folder-picker.ps1',import.meta.url);
 // Actual acquisition/release code, instrumented only to log the abandoned
 // branch and cancel immediately after acquisition without displaying UI.
 let cs=await fs.readFile(csUrl,'utf8');cs=cs.replace('catch(AbandonedMutexException){owns=true;}','catch(AbandonedMutexException){owns=true;Console.Error.WriteLine("FIXTURE_ABANDONED_ACQUIRED");}');
 cs=cs.replace('if(!owns)return Result("failed","PICKER_BUSY");','if(!owns)return Result("failed","PICKER_BUSY");cancel.Set();');
 await fs.writeFile(path.join(fixtureDir,'windows-folder-picker.cs'),cs);
 let ps=await fs.readFile(psUrl,'utf8');
 const bootstrap=`    Add-Type @"
using System;using System.Threading;
public static class NativeMutexFixture {
 public static Mutex Keeper;
 public static void Abandon(string name){Keeper=new Mutex(false,name);var thread=new Thread(()=>{Keeper.WaitOne();});thread.Start();thread.Join();}
}
"@
    [NativeMutexFixture]::Abandon(('Local\\CollaborativeNotes.Picker.'+$init.mutexKey))
`;
 ps=ps.replace('    if($cancel.IsSet) {',bootstrap+'    if($cancel.IsSet) {');
 const helper=path.join(fixtureDir,'windows-folder-picker.ps1');await fs.writeFile(helper,ps);
 let diagnostic='';const picker=new NativeFolderPicker({dataDir:data,spawn:(exe,args,opts)=>{args[args.length-1]=helper;const c=spawn(exe,args,opts);c.stderr.on('data',b=>diagnostic+=b);return c;}});
 try{assert.equal((await picker.select({initialPath:folder,title})).status,'cancelled');assert.match(diagnostic,/FIXTURE_ABANDONED_ACQUIRED/);}finally{await picker.close();}
});
test('failed removal of temporary topmost state terminates only the helper and releases its Mutex',async()=>{
 const fixture=path.join(base,'restore-failure');await fs.mkdir(fixture);
 const csUrl=new URL('../plugins/collaborative-notes/server/windows-folder-picker.cs',import.meta.url),psUrl=new URL('../plugins/collaborative-notes/server/windows-folder-picker.ps1',import.meta.url);
 let cs=await fs.readFile(csUrl,'utf8');
 cs=cs.replace('bool activated=GetForegroundWindow()==window || SetForegroundWindow(window);','bool activated=false;');
 cs=cs.replace('restored=SetWindowPos(window,new IntPtr(-2),0,0,0,0,flags);','restored=false;');
 await fs.writeFile(path.join(fixture,'windows-folder-picker.cs'),cs);await fs.copyFile(psUrl,path.join(fixture,'windows-folder-picker.ps1'));
 let child,diagnostic='';const picker=new NativeFolderPicker({dataDir:data,spawn:(exe,args,opts)=>{args[args.length-1]=path.join(fixture,'windows-folder-picker.ps1');child=spawn(exe,args,opts);child.stderr.on('data',b=>diagnostic+=b);return child;}});
 await assert.rejects(picker.select({initialPath:folder,title}),error=>error.code==='PICKER_FAILED');assert.match(diagnostic,/restored=False remains_topmost=True/);assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');await picker.close();
 const next=observed(),abort=new AbortController(),pending=next.picker.select({initialPath:folder,title,signal:abort.signal});await next.ready;abort.abort();assert.equal((await pending).status,'cancelled');await next.picker.close();
});
test('blocked temporary-topmost restoration has an independent two-second self-exit guard',async()=>{
 const fixture=path.join(base,'restore-blocked');await fs.mkdir(fixture);
 let cs=await fs.readFile(new URL('../plugins/collaborative-notes/server/windows-folder-picker.cs',import.meta.url),'utf8');
 cs=cs.replace('bool activated=GetForegroundWindow()==window || SetForegroundWindow(window);','bool activated=false;').replace('restored=SetWindowPos(window,new IntPtr(-2),0,0,0,0,flags);','Thread.Sleep(Timeout.Infinite);');
 await fs.writeFile(path.join(fixture,'windows-folder-picker.cs'),cs);await fs.copyFile(new URL('../plugins/collaborative-notes/server/windows-folder-picker.ps1',import.meta.url),path.join(fixture,'windows-folder-picker.ps1'));
 let child;const picker=new NativeFolderPicker({dataDir:data,spawn:(exe,args,opts)=>{args[args.length-1]=path.join(fixture,'windows-folder-picker.ps1');child=spawn(exe,args,opts);return child;}});const started=Date.now();
 await assert.rejects(picker.select({initialPath:folder,title}),error=>error.code==='PICKER_FAILED');assert.ok(Date.now()-started<6000);assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');await picker.close();
});
}
