
import { spawn as defaultSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { performance } from "node:perf_hooks";

const HELPER = fileURLToPath(new URL("../windows-folder-picker.ps1", import.meta.url));
const CODES = new Set(["PICKER_BUSY","PICKER_UNAVAILABLE","PICKER_TIMEOUT","PICKER_FAILED","LOCATION_INVALID"]);
const failure = code => Object.assign(new Error(code), { code });
async function removePickerTempDirectory(directory, removeDirectory=fs.rm) {
  let reported=false,timer;
  const report=code=>{if(reported)return;reported=true;console.error("PICKER_TEMP_CLEANUP_FAILED",code||"UNKNOWN");};
  const removal=Promise.resolve().then(()=>removeDirectory(directory,{recursive:true,force:true})).then(()=>true,error=>{report(error.code);return true;});
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{report("TIMEOUT");resolve(false);},1000);});
  await Promise.race([removal,deadline]);
  clearTimeout(timer);
}
export const nativePickerCapability = platform => platform === "win32" ? { nativeFolderPicker: true } : {};

export class NativeFolderPicker {
  constructor({ dataDir, platform=process.platform, spawn=defaultSpawn, realpath=fs.realpath, env=process.env,
    initMs=15000, selectMs=300000, closeMs=2000, removeTempDirectory=fs.rm }={}) {
    this.dataDir=dataDir;this.platform=platform;this.spawn=spawn;this.realpath=realpath;this.env=env;this.removeTempDirectory=removeTempDirectory;
    this.initMs=initMs;this.selectMs=selectMs;this.closeMs=closeMs;
    this.picker=null;this.jobs=new Set();this.closed=false;this.keyPromise=null;
  }
  get active(){return this.picker!==null;}
  async key(){
    if(!this.keyPromise)this.keyPromise=this.realpath(this.dataDir).then(p=>createHash("sha256").update(path.win32.normalize(p).toLowerCase()).digest("hex")).catch(e=>{this.keyPromise=null;throw e;});
    return this.keyPromise;
  }
  async prepareKey(budget,signal){
    // Filesystem preparation can stall too. It owns no child, but must be
    // cancellable so HTTP shutdown never waits on a lookup that cannot finish.
    return new Promise((resolve,reject)=>{
      let finished=false,done;
      const job={done:new Promise(r=>done=r)};
      const finish=(error,key)=>{
        if(finished)return;
        finished=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);
        this.jobs.delete(job);done();
        if(error)reject(error);else resolve(key);
      };
      const abort=()=>finish(null,null);
      const timer=setTimeout(()=>finish(failure("PICKER_TIMEOUT")),budget);
      job.cancel=()=>finish(failure("SERVICE_CLOSING"));
      this.jobs.add(job);
      signal?.addEventListener("abort",abort,{once:true});
      if(this.closed){job.cancel();return;}
      if(signal?.aborted){abort();return;}
      this.key().then(key=>finish(null,key),()=>finish(failure("PICKER_UNAVAILABLE")));
    });
  }
  async select({initialPath,title,signal}={}){
    if(this.closed)throw failure("SERVICE_CLOSING");
    if(this.platform!=="win32")throw failure("PICKER_UNAVAILABLE");
    if(this.picker)throw failure("PICKER_BUSY");
    const reservation={};this.picker=reservation;
    try{return await this.run({initialPath,title,signal});}
    finally{if(this.picker===reservation)this.picker=null;}
  }
  async run({initialPath,title,signal}={}){
    if(this.closed)throw failure("SERVICE_CLOSING");
    if(this.platform!=="win32")throw failure("PICKER_UNAVAILABLE");
    if(signal?.aborted)return {ok:true,status:"cancelled"};
    if(typeof title!=="string" || !title.trim() || title.length>200 || /[\u0000-\u001f]/.test(title))throw failure("PICKER_FAILED");
    if(initialPath!==undefined && (typeof initialPath!=="string" || initialPath.length>32767 || /[\u0000-\u001f]/.test(initialPath)))throw failure("LOCATION_INVALID");
    const key=await this.prepareKey(this.initMs,signal);
    if(this.closed)throw failure("SERVICE_CLOSING");
    if(key===null || signal?.aborted)return {ok:true,status:"cancelled"};
    const shell=path.join(this.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    let child,tempDirectory,spawnedAt;
    try{
      tempDirectory=mkdtempSync(path.join(os.tmpdir(),"cn-notes-picker-"));
      spawnedAt=performance.now();
      child=this.spawn(shell,["-NoLogo","-NoProfile","-NonInteractive","-STA","-File",HELPER],{
      windowsHide:true,cwd:this.env.USERPROFILE||process.cwd(),env:{...this.env,TEMP:tempDirectory,TMP:tempDirectory},stdio:["pipe","pipe","pipe"]
      });
    }catch{
      if(tempDirectory)await removePickerTempDirectory(tempDirectory,this.removeTempDirectory);
      throw failure("PICKER_UNAVAILABLE");
    }
    return new Promise((resolve,reject)=>{
      const decoder=new TextDecoder("utf-8",{fatal:true}),job={child,cancelled:false,error:null,cancel:null};
      let buffer="",bytes=0,ready=false,terminal=null,stderrBytes=0,stderrChunks=[],readyAt=null,resultAt=null,closed=false,exitSeen=false,cancelAt=null,initTimer,selectionTimer,cleanupTimer,killTimer;let cleanupTimedOut=false;
      const clear=()=>{clearTimeout(initTimer);clearTimeout(selectionTimer);clearTimeout(cleanupTimer);clearTimeout(killTimer);signal?.removeEventListener("abort",abort);};
      const exited=()=>exitSeen || child.exitCode!==null || child.signalCode!==null;
      const closeOwnedPipes=()=>{
        if(closed || (!job.cancelled && !cleanupTimedOut) || !exited())return;
        // A descendant may retain inherited handles after this child exits.
        // Truncate only our pipe ends, discard the selected result, and never
        // terminate another PID. Acceptance still waits for child.close.
        for(const stream of [child.stdin,child.stdout,child.stderr])stream.destroy();
      };
      child.once("exit",()=>{
        exitSeen=true;
        if((job.cancelled || cleanupTimedOut) && performance.now()-cancelAt>=this.closeMs)closeOwnedPipes();
      });
      const cancel=(reason,error)=>{
        if(error && !job.error)job.error=error;
        if(closed)return;
        if(job.cancelled)return;
        job.cancelled=true;cancelAt=performance.now();clearTimeout(initTimer);clearTimeout(selectionTimer);clearTimeout(cleanupTimer);
        try{if(child.stdin.writable)child.stdin.end(JSON.stringify({type:"cancel",reason})+"\n");}catch{}
        killTimer=setTimeout(()=>{
          if(exited())closeOwnedPipes();
          else try{child.kill("SIGKILL");}catch{}
        },this.closeMs);
      };
      job.cancel=()=>cancel("service_closing");this.jobs.add(job);
      const abort=()=>cancel("client_closed");
      const bad=()=>cancel("protocol_error",failure(ready?"PICKER_FAILED":"PICKER_UNAVAILABLE"));
      const message=line=>{
        if(!line.trim())return;
        let value;try{value=JSON.parse(line);}catch{bad();return;}
        if(terminal){bad();return;}
        if(value?.type==="ready"){
          if(ready || Object.keys(value).some(k=>k!=="type")){bad();return;}
          const now=performance.now();
          const remaining=this.initMs-(now-spawnedAt);
          if(remaining<=0){cancel("timeout",failure("PICKER_TIMEOUT"));return;}
          ready=true;readyAt=now;clearTimeout(initTimer);
          selectionTimer=setTimeout(()=>cancel("timeout",failure("PICKER_TIMEOUT")),this.selectMs);
        }else if(value?.type==="result" && ["selected","cancelled","failed"].includes(value.status)){
          if(value.status==="selected" && !ready){bad();return;}
          const fields=value.status==="selected"?["type","status","path"]:value.status==="failed"?["type","status","code"]:["type","status"];
          if(Object.keys(value).some(key=>!fields.includes(key))){bad();return;}
          if(value.status==="selected" && (typeof value.path!=="string" || !path.win32.isAbsolute(value.path) || /[\u0000-\u001f]/.test(value.path) || value.path.length>32767)){bad();return;}
          if(value.status==="failed" && !CODES.has(value.code)){bad();return;}
          terminal=value;resultAt=performance.now();clearTimeout(selectionTimer);
          cleanupTimer=setTimeout(()=>{
            if(closed || job.cancelled)return;
            cleanupTimedOut=true;cancelAt=performance.now();
            try{child.kill("SIGKILL");}catch{}
            killTimer=setTimeout(()=>{if(exited())closeOwnedPipes();},this.closeMs);
          },this.closeMs);
        }else bad();
      };
      child.stdout.on("data",chunk=>{
        bytes+=chunk.length;if(bytes>128*1024){bad();return;}
        try{buffer+=decoder.decode(chunk,{stream:true});}catch{bad();return;}
        let at;while((at=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);message(line);}
      });
      child.stderr.on("data",chunk=>{
        if(stderrBytes<8192){const kept=Buffer.from(chunk).subarray(0,8192-stderrBytes);stderrChunks.push(kept);stderrBytes+=kept.length;}
      });
      // Pipe errors are asynchronous events; a failed write must never crash
      // the shared service. Cancellation may race the helper's normal exit.
      child.stdin.on("error",()=>{
        if(!closed && !job.cancelled)cancel("spawn_error",failure(ready?"PICKER_FAILED":"PICKER_UNAVAILABLE"));
      });
      child.stdout.on("error",bad);
      child.stderr.on("error",bad);
      child.on("error",()=>cancel("spawn_error",failure("PICKER_UNAVAILABLE")));
      signal?.addEventListener("abort",abort,{once:true});
      initTimer=setTimeout(()=>cancel("timeout",failure("PICKER_TIMEOUT")),this.initMs);
      job.done=new Promise(done=>child.once("close",(code,signalCode)=>{
        if(closed)return;closed=true;clear();
        try{buffer+=decoder.decode();if(buffer.trim())message(buffer);}catch{job.error=job.error||failure("PICKER_FAILED");}
        const finish=()=>{
        this.jobs.delete(job);done();
        const stderr=Buffer.concat(stderrChunks).toString("utf8");
        // Timers can run late if the event loop stalls. A selected result must
        // also satisfy the actual monotonic deadline at the acceptance boundary.
        if(!job.cancelled && terminal?.status==="selected" && readyAt!==null && resultAt!==null && resultAt-readyAt>=this.selectMs)job.error=failure("PICKER_TIMEOUT");
        if(job.error){job.error.diagnostic=stderr;reject(job.error);return;}
        if(job.cancelled){resolve({ok:true,status:"cancelled"});return;}
        if(!terminal){const error=failure(ready?"PICKER_FAILED":"PICKER_UNAVAILABLE");error.diagnostic=stderr;reject(error);return;}
        if(terminal.status==="failed"){
          if(!cleanupTimedOut && (typeof code!=="number" || code===0 || signalCode)){reject(failure("PICKER_FAILED"));return;}
          const error=failure(terminal.code);error.diagnostic=stderr;reject(error);return;
        }
        if(!cleanupTimedOut && (code!==0 || signalCode)){reject(failure("PICKER_FAILED"));return;}
        resolve(terminal.status==="selected"?{ok:true,status:"selected",path:terminal.path}:{ok:true,status:"cancelled"});
        };
        if(tempDirectory)removePickerTempDirectory(tempDirectory,this.removeTempDirectory).then(finish);else finish();
      }));
      try{
        child.stdin.write(JSON.stringify({type:"init",mode:"picker",initialPath:initialPath||"",title,tempDirectory,
          parentPid:process.pid,parentExecutable:process.execPath,mutexKey:key,
          initMs:this.initMs,selectMs:this.selectMs,closeMs:this.closeMs})+"\n");
      }catch{cancel("spawn_error",failure("PICKER_UNAVAILABLE"));}
      if(signal?.aborted)abort();
    });
  }
  async close(){
    this.closed=true;
    const jobs=[...this.jobs];for(const job of jobs)job.cancel();
    await Promise.all(jobs.map(job=>job.done));
  }
}
