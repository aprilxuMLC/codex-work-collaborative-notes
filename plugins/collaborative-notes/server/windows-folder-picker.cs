
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CollaborativeNotes.Native {
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr types);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise([MarshalAs(UnmanagedType.Interface)] IFileDialogEvents events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint name, out IntPtr value);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
    [ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOleWindow {
        [PreserveSig] int GetWindow(out IntPtr window);
        [PreserveSig] int ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool enter);
    }
    [ComImport, ComVisible(true), Guid("973510DB-7D7F-452B-8975-74A85828D354"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialogEvents {
        [PreserveSig] int OnFileOk(IFileDialog dialog);
        [PreserveSig] int OnFolderChanging(IFileDialog dialog, IShellItem folder);
        [PreserveSig] int OnFolderChange(IFileDialog dialog);
        [PreserveSig] int OnSelectionChange(IFileDialog dialog);
        [PreserveSig] int OnShareViolation(IFileDialog dialog, IShellItem item, out uint response);
        [PreserveSig] int OnTypeChange(IFileDialog dialog);
        [PreserveSig] int OnOverwrite(IFileDialog dialog, IShellItem item, out uint response);
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    sealed class PickerSelection : IFileDialogEvents {
        readonly Func<IFileDialog,string> readCurrent;
        readonly Func<IFileDialog,string> readResult;
        public string SelectedPath { get; private set; }
        public string ConfirmedPath { get; private set; }
        public PickerSelection(Func<IFileDialog,string> readCurrent,Func<IFileDialog,string> readResult) {
            this.readCurrent=readCurrent;this.readResult=readResult;
        }
        public int OnSelectionChange(IFileDialog dialog) {
            SelectedPath=null;
            try{SelectedPath=readCurrent(dialog);}catch{}
            return 0;
        }
        public int OnFileOk(IFileDialog dialog) {
            ConfirmedPath=null;
            // Read a fresh current selection while the dialog is still open.
            // With no selected row, GetResult supplies the confirmed folder.
            OnSelectionChange(dialog);
            if(String.IsNullOrWhiteSpace(SelectedPath))try{SelectedPath=readResult(dialog);}catch{}
            ConfirmedPath=SelectedPath;
            return 0;
        }
        public int OnFolderChange(IFileDialog dialog){SelectedPath=null;return 0;}
        public int OnFolderChanging(IFileDialog dialog,IShellItem folder){return 0;}
        public int OnShareViolation(IFileDialog dialog,IShellItem item,out uint response){response=0;return 0;}
        public int OnTypeChange(IFileDialog dialog){return 0;}
        public int OnOverwrite(IFileDialog dialog,IShellItem item,out uint response){response=0;return 0;}
    }
    sealed class PickerException : Exception {
        public readonly string Code;
        public PickerException(string code) : base(code) { Code=code; }
    }
    public static class Picker {
        const int Cancelled=unchecked((int)0x800704C7);
        [DllImport("user32.dll", SetLastError=true)]
        static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError=true)]
        static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("shcore.dll")]
        static extern int GetProcessDpiAwareness(IntPtr process,out int awareness);
        static IntPtr ConfigureUiDpi() {
            // Shell can create additional UI threads. A thread-only switch leaves
            // those threads with PowerShell's DPI-unaware process default.
            if(!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
                int awareness;
                if(GetProcessDpiAwareness(IntPtr.Zero,out awareness)!=0 || awareness!=2)
                    throw new PickerException("PICKER_UNAVAILABLE");
            }
            IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
            if(previous==IntPtr.Zero)throw new PickerException("PICKER_UNAVAILABLE");
            return previous;
        }
        [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();
        [StructLayout(LayoutKind.Sequential)]
        struct FlashInfo {
            public uint size;public IntPtr window;public uint flags;public uint count;public uint timeout;
        }
        [DllImport("user32.dll")]
        static extern bool FlashWindowEx(ref FlashInfo info);
        // Only attempt normal activation once the actual Shell dialog exists.
        // A background host may not grant foreground rights; notify instead of
        // using foreign owners, synthetic input, or repeatedly stealing focus.
        [DllImport("user32.dll",SetLastError=true)]
        static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
        [DllImport("user32.dll",EntryPoint="GetWindowLongW")]
        static extern int GetWindowLong(IntPtr window,int index);
        static bool PresentDialog(IntPtr window,IntPtr taskbar) {
            uint process;
            if(window==IntPtr.Zero || !IsWindowVisible(window) ||
                GetWindowThreadProcessId(window,out process)==0 || process!=(uint)Process.GetCurrentProcess().Id)return false;
            bool activated=GetForegroundWindow()==window || SetForegroundWindow(window);
            Console.Error.WriteLine(activated ? "native_dialog_foreground=activated" : "native_dialog_foreground=denied");
            if(!activated) {
                // A detached service can be denied foreground rights. Present
                // only our dialog once, without taking keyboard input or moving it.
                const uint flags=0x213;
                bool raised=false,restored=false;
                int presentationState=0;
                using(var guard=new System.Threading.Timer(delegate {
                    if(Interlocked.CompareExchange(ref presentationState,2,0)==0)Process.GetCurrentProcess().Kill();
                },null,2000,Timeout.Infinite)) {
                    try{raised=SetWindowPos(window,new IntPtr(-1),0,0,0,0,flags);}
                    finally{restored=SetWindowPos(window,new IntPtr(-2),0,0,0,0,flags);}
                    Interlocked.CompareExchange(ref presentationState,1,0);
                }
                bool remainsTopmost=(GetWindowLong(window,-20)&8)!=0;
                Console.Error.WriteLine("native_dialog_visible raised="+raised+" restored="+restored+" remains_topmost="+remainsTopmost);
                // A failed restoration must never leave a permanently topmost
                // window. Only this helper is terminated; its owner is its own.
                if(!restored || remainsTopmost)Process.GetCurrentProcess().Kill();
            }
            if(!activated && taskbar!=IntPtr.Zero &&
                GetWindowThreadProcessId(taskbar,out process)!=0 && process==(uint)Process.GetCurrentProcess().Id) {
                var flash=new FlashInfo{size=(uint)Marshal.SizeOf(typeof(FlashInfo)),window=taskbar,flags=3,count=3,timeout=0};
                FlashWindowEx(ref flash);
            }
            return true;
        }
        static string Result(string status, string value) {
            var result=new Dictionary<string,object>{{"type","result"},{"status",status}};
            if(status=="selected")result["path"]=value;
            if(status=="failed")result["code"]=value;
            return new JavaScriptSerializer().Serialize(result);
        }
        static string CancelResult(ConcurrentDictionary<string,object> state) {
            object reason;
            return state.TryGetValue("reason",out reason) && (string)reason=="timeout"
                ? Result("failed","PICKER_TIMEOUT") : Result("cancelled",null);
        }
        static string Initial(string requested) {
            foreach(string candidate in new string[]{requested,Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),Path.GetPathRoot(Environment.SystemDirectory)}) {
                try{if(!String.IsNullOrWhiteSpace(candidate) && Directory.Exists(candidate))return candidate;}catch{}
            }
            return null;
        }
        internal static string ReadShellItemPath(IShellItem item) {
            IntPtr text;item.GetDisplayName(0x80058000,out text);
            try{return Marshal.PtrToStringUni(text);}finally{Marshal.FreeCoTaskMem(text);}
        }
        static string ReadCurrentSelection(IFileDialog dialog) {
            IShellItem item;dialog.GetCurrentSelection(out item);
            try{return ReadShellItemPath(item);}finally{Marshal.ReleaseComObject(item);}
        }
        static string ReadConfirmedResult(IFileDialog dialog) {
            IShellItem item;dialog.GetResult(out item);
            try{return ReadShellItemPath(item);}finally{Marshal.ReleaseComObject(item);}
        }
        public static Rectangle OwnerBounds(Rectangle work) {
            if(work.Width<320 || work.Height<240)throw new PickerException("PICKER_UNAVAILABLE");
            int width=Math.Min(640,work.Width),height=Math.Min(480,work.Height);
            return new Rectangle(work.Left+(work.Width-width)/2,work.Top+(work.Height-height)/2,width,height);
        }
        public static string Run(string initial,string title,string key,
            ConcurrentDictionary<string,object> state,ManualResetEventSlim cancel,Stopwatch clock) {
            if(Thread.CurrentThread.GetApartmentState()!=ApartmentState.STA)return Result("failed","PICKER_UNAVAILABLE");
            Mutex mutex=null;bool owns=false;Form owner=null;IFileDialog dialog=null;System.Windows.Forms.Timer timer=null;
            IntPtr previousDpi=IntPtr.Zero;
            PickerSelection selection=null;uint adviseCookie=0;bool advised=false;
            try {
                if(cancel.IsSet)return CancelResult(state);
                // Shell dialogs and their popup menus must use one coordinate
                // basis across monitors. Change only this helper's process and UI thread.
                previousDpi=ConfigureUiDpi();
                mutex=new Mutex(false,@"Local\CollaborativeNotes.Picker."+key);
                try{owns=mutex.WaitOne(0);}catch(AbandonedMutexException){owns=true;}
                if(!owns)return Result("failed","PICKER_BUSY");
                dialog=(IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7")));
                uint options;dialog.GetOptions(out options);
                dialog.SetOptions(options|0x20|0x40|0x800|0x02000000);
                dialog.SetTitle(title);
                selection=new PickerSelection(ReadCurrentSelection,ReadConfirmedResult);
                dialog.Advise(selection,out adviseCookie);advised=true;
                string folder=Initial(initial);
                if(folder!=null){
                    IShellItem item;Guid iid=new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                    if(SHCreateItemFromParsingName(folder,IntPtr.Zero,ref iid,out item)>=0){
                        try{dialog.SetFolder(item);}finally{Marshal.ReleaseComObject(item);}
                    }
                }
                if(cancel.IsSet)return CancelResult(state);
                owner=new Form();
                owner.Text=title;owner.Opacity=0;
                // A one-pixel modal owner can give Shell popups unusable bounds
                // on another monitor. Keep ordinary bounds on the cursor's screen.
                owner.AutoScaleMode=AutoScaleMode.None;
                owner.StartPosition=FormStartPosition.Manual;
                owner.Bounds=OwnerBounds(Screen.FromPoint(Cursor.Position).WorkingArea);
                owner.ShowInTaskbar=true;owner.ShowIcon=true;owner.Icon=SystemIcons.Application;
                owner.FormBorderStyle=FormBorderStyle.FixedDialog;
                owner.MinimizeBox=false;owner.MaximizeBox=false;
                owner.Show();owner.Activate();
                timer=new System.Windows.Forms.Timer();timer.Interval=50;
                bool presented=false;
                timer.Tick+=delegate {
                    if(cancel.IsSet){try{dialog.Close(Cancelled);}catch{};return;}
                    if(!presented)try{
                        IntPtr window;
                        if(((IOleWindow)dialog).GetWindow(out window)>=0)presented=PresentDialog(window,owner.Handle);
                    }catch{presented=true;Console.Error.WriteLine("native_dialog_foreground=unavailable");}
                };
                timer.Start();
                state["readyAt"]=clock.ElapsedMilliseconds;state["ready"]=true;
                Console.WriteLine("{\"type\":\"ready\"}");
                int hr=dialog.Show(owner.Handle);
                if(cancel.IsSet || hr==Cancelled)return CancelResult(state);
                if(hr<0)Marshal.ThrowExceptionForHR(hr);
                if(cancel.IsSet)return CancelResult(state);
                if(String.IsNullOrWhiteSpace(selection.ConfirmedPath))throw new PickerException("LOCATION_INVALID");
                return Result("selected",selection.ConfirmedPath);
            }catch(PickerException e){return Result("failed",e.Code);}
             catch{return Result("failed","PICKER_UNAVAILABLE");}
            finally{
                if(timer!=null){timer.Stop();timer.Dispose();}
                if(advised)try{dialog.Unadvise(adviseCookie);}catch{}
                if(dialog!=null)Marshal.ReleaseComObject(dialog);
                if(owner!=null){owner.Close();owner.Dispose();}
                if(owns)mutex.ReleaseMutex();
                if(mutex!=null)mutex.Dispose();
                if(previousDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(previousDpi);
            }
        }
    }
}
