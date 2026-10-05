import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {test} from 'node:test';
test('Windows owner uses useful bounds inside positive/negative multi-monitor work areas',{skip:process.platform!=='win32'},async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cn-owner-geometry-'));
 try{
  const cs=fileURLToPath(new URL('../../plugins/collaborative-notes/server/windows-folder-picker.cs',import.meta.url)).replaceAll("'","''");
  const script=`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
Add-Type -Path '${cs}' -ReferencedAssemblies @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll')
$results=@()
foreach($work in @([System.Drawing.Rectangle]::new(0,0,1920,1080),[System.Drawing.Rectangle]::new(-1920,0,1920,1080),[System.Drawing.Rectangle]::new(1920,-2160,3840,2160),[System.Drawing.Rectangle]::new(0,40,800,560))){
 $bounds=[CollaborativeNotes.Native.Picker]::OwnerBounds($work)
 $results+=@{contains=$work.Contains($bounds);width=$bounds.Width;height=$bounds.Height}
}
try{ $null=[CollaborativeNotes.Native.Picker]::OwnerBounds([System.Drawing.Rectangle]::Empty);throw 'unexpected accepted empty work area' }catch{if($_.Exception.ToString() -notlike '*PICKER_UNAVAILABLE*'){throw}}
$type=[CollaborativeNotes.Native.Picker]
$flags=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static
$null=$type.GetMethod('ConfigureUiDpi',$flags).Invoke($null,$null)
$present=$type.GetMethod('PresentDialog',$flags)
if($present.Invoke($null,[object[]]@([IntPtr]::Zero,[IntPtr]::Zero))){throw 'Missing dialog must not count as presented'}
$hidden=[System.Windows.Forms.Form]::new()
try{
 if($present.Invoke($null,[object[]]@($hidden.Handle,$hidden.Handle))){throw 'Hidden owner must not be activated in place of Shell dialog'}
}finally{$hidden.Dispose()}
$args=[object[]]@([IntPtr]::Zero,0)
$code=$type.GetMethod('GetProcessDpiAwareness',$flags).Invoke($null,$args)
if($code -ne 0 -or $args[1] -ne 2){throw 'Helper process must use per-monitor DPI awareness'}
ConvertTo-Json -Compress -InputObject $results
`;
  const file=path.join(temp,'geometry.ps1');await fs.writeFile(file,'\ufeff'+script);
  const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await promisify(execFile)(shell,['-NoLogo','-NoProfile','-NonInteractive','-STA','-File',file],{windowsHide:true,timeout:15000});
  const results=JSON.parse(stdout);assert.equal(results.length,4);for(const item of results){assert.equal(item.contains,true);assert.equal(item.width,640);assert.equal(item.height,480);}
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});