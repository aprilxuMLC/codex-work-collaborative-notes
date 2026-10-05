import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('Windows selection and OK events refresh the directory path while the dialog remains open', { skip: process.platform !== 'win32' }, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-picker-selection-'));
  try {
    const source = await fs.readFile(new URL('../../plugins/collaborative-notes/server/windows-folder-picker.cs', import.meta.url), 'utf8');
    const fixture = String.raw`
namespace CollaborativeNotes.Native {
    public static class SelectionRegression {
        [System.Runtime.InteropServices.DllImport("shell32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(string path,IntPtr context,ref Guid iid,out IShellItem item);
        static IShellItem Item(string path) {
            IShellItem item;Guid iid=new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            System.Runtime.InteropServices.Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path,IntPtr.Zero,ref iid,out item));
            return item;
        }
        static void Check(bool condition,string name){if(!condition)throw new InvalidOperationException(name);}
        public static string Run(string root) {
            root=System.IO.Path.GetFullPath(root);
            string oldPath=System.IO.Path.Combine(root,"New Folder"),newPath=System.IO.Path.Combine(root,"中文便签");
            System.IO.Directory.CreateDirectory(oldPath);
            IShellItem oldItem=Item(oldPath),currentItem=null;IFileDialog dialog=null;uint cookie=0;bool advised=false;
            try {
                currentItem=Item(oldPath);int currentReads=0,resultReads=0;
                var selection=new PickerSelection(d=>{currentReads++;return Picker.ReadShellItemPath(currentItem);},d=>{resultReads++;return Picker.ReadShellItemPath(oldItem);});
                selection.OnSelectionChange(null);Check(selection.SelectedPath==oldPath,"initial click updates path");
                System.IO.Directory.Move(oldPath,newPath);
                Check(Picker.ReadShellItemPath(oldItem)==oldPath,"retained Shell object caches old path");
                System.Runtime.InteropServices.Marshal.ReleaseComObject(currentItem);currentItem=Item(newPath);
                selection.OnSelectionChange(null);Check(selection.SelectedPath==newPath,"next click updates Chinese path");
                int beforeOk=currentReads;
                Check(selection.OnFileOk(null)==0 && currentReads==beforeOk+1,"OK rereads current selection");
                Check(selection.ConfirmedPath==newPath && resultReads==0,"fresh current path wins over old result");
                selection.OnFolderChange(null);Check(selection.SelectedPath==null && selection.ConfirmedPath==newPath,"navigation clears selection without changing accepted result");
                var noRow=new PickerSelection(d=>{throw new InvalidOperationException();},d=>newPath);
                Check(noRow.OnFileOk(null)==0 && noRow.ConfirmedPath==newPath,"no row uses confirmed current folder");
                bool readable=true;
                var failed=new PickerSelection(d=>{if(!readable)throw new InvalidOperationException();return newPath;},d=>{throw new InvalidOperationException();});
                failed.OnSelectionChange(null);readable=false;failed.OnFileOk(null);
                Check(failed.SelectedPath==null && failed.ConfirmedPath==null,"read failure cannot reuse an earlier path");
                dialog=(IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7")));
                dialog.Advise(selection,out cookie);advised=true;
                dialog.Unadvise(cookie);advised=false;
                return new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new {clickRefresh=true,okRefresh=true,freshChinesePath=true,navigationClears=true,currentFolderFallback=true,failedReadClears=true,eventSinkRegistered=true});
            }finally{
                if(advised)try{dialog.Unadvise(cookie);}catch{}
                if(dialog!=null)System.Runtime.InteropServices.Marshal.ReleaseComObject(dialog);
                if(currentItem!=null)System.Runtime.InteropServices.Marshal.ReleaseComObject(currentItem);
                System.Runtime.InteropServices.Marshal.ReleaseComObject(oldItem);
            }
        }
    }
}`;
    const cs = path.join(base, 'selection.cs'), ps = path.join(base, 'selection.ps1');
    await fs.writeFile(cs, '\ufeff' + source + '\n' + fixture);
    const quote = value => value.replaceAll("'", "''");
    await fs.writeFile(ps, '\ufeff' + `$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\nAdd-Type -Path '${quote(cs)}' -ReferencedAssemblies @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll')\n[CollaborativeNotes.Native.SelectionRegression]::Run('${quote(base)}')\n`);
    const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(shell, ['-NoLogo','-NoProfile','-NonInteractive','-STA','-File',ps], { windowsHide: true, timeout: 15000 });
    const result = JSON.parse(stdout);
    for (const key of ['clickRefresh','okRefresh','freshChinesePath','navigationClears','currentFolderFallback','failedReadClears','eventSinkRegistered']) assert.equal(result[key], true, key);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});