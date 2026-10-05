#requires -version 5.1
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$state = [Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
$state['ready'] = $false
$state['done'] = $false
$state['reason'] = ''
$cancel = [Threading.ManualResetEventSlim]::new($false)
$monitor = $null
$monitorRunspace = $null
$pending = $null
$reader = $null
$readerRunspace = $null
$compilerParameters = $null
$result = $null
$exitCode = 1
try {
    $line = [Console]::ReadLine()
    $init = ConvertFrom-Json $line
    if ($init.type -ne 'init' -or $init.mode -ne 'picker' -or
        $init.mutexKey -notmatch '^[a-f0-9]{64}$' -or
        $init.parentPid -le 0 -or
        $init.initMs -le 0 -or $init.selectMs -le 0 -or $init.closeMs -le 0) { throw 'Invalid initialization' }
    $parent = [Diagnostics.Process]::GetProcessById([int]$init.parentPid)
    $null = $parent.Handle
    if ($parent.HasExited -or -not [string]::Equals($parent.MainModule.FileName,[string]$init.parentExecutable,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Parent identity unavailable'
    }
    $tempDirectory = [IO.Path]::GetFullPath([string]$init.tempDirectory)
    if (-not [IO.Directory]::Exists($tempDirectory) -or
        -not [string]::Equals($tempDirectory,[string]$init.tempDirectory,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($env:TEMP,$tempDirectory,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($env:TMP,$tempDirectory,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid temporary directory' }
    $tempInfo = [IO.DirectoryInfo]::new($tempDirectory)
    if (($tempInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Temporary directory is a reparse point' }
    # The independent runspace watches even while the main STA compiles C#.
    $monitorRunspace = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $monitorRunspace.ApartmentState = 'MTA'
    $monitorRunspace.ThreadOptions = 'ReuseThread'
    $monitorRunspace.Open()
    $monitor = [Management.Automation.PowerShell]::Create()
    $monitor.Runspace = $monitorRunspace
    $readerRunspace = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $readerRunspace.ApartmentState = 'MTA'
    $readerRunspace.ThreadOptions = 'ReuseThread'
    $readerRunspace.Open()
    $reader = [Management.Automation.PowerShell]::Create()
    $reader.Runspace = $readerRunspace
    $readControl = @'
param($state,$cancel)
while (-not [bool]$state['done']) {
    $reason=''
    try {
        $line=[Console]::ReadLine()
        if ($null -eq $line) { $reason='pipe_closed' }
        else {
            $message=ConvertFrom-Json $line
            if ($message.type -ne 'cancel' -or $message.reason -notin @('client_closed','service_closing','timeout','protocol_error','spawn_error')) { $reason='protocol_error' }
            else { $reason=[string]$message.reason }
        }
    } catch { $reason='protocol_error' }
    if ($reason) { $null=$state.TryUpdate('reason',$reason,'');$cancel.Set();break }
}
'@
    $null=$reader.AddScript($readControl).AddArgument($state).AddArgument($cancel)
    $readerPending=$reader.BeginInvoke()
    $watch = @'
param($parent,$state,$cancel,$clock,$initMs,$selectMs,$closeMs)
$cancelAt = -1L
while (-not [bool]$state['done']) {
    $reason = ''
    if ($parent.WaitForExit(50)) { $reason='parent_exit' }
    $elapsed=$clock.ElapsedMilliseconds
    if (-not [bool]$state['ready']) {
        if ($elapsed -ge $initMs) { $reason='timeout' }
    } elseif ($elapsed-[long]$state['readyAt'] -ge $selectMs) { $reason='timeout' }
    if ($reason -and -not $cancel.IsSet) {
        $null=$state.TryUpdate('reason',$reason,'')
        $cancelAt=$elapsed
        $cancel.Set()
    }
    if ($cancel.IsSet -and $cancelAt -lt 0) { $cancelAt=$elapsed }
    if ($cancelAt -ge 0 -and $elapsed-$cancelAt -ge $closeMs) {
        [Diagnostics.Process]::GetCurrentProcess().Kill()
        break
    }
}
'@
    $null=$monitor.AddScript($watch)
    foreach($value in @($parent,$state,$cancel,$clock,[long]$init.initMs,[long]$init.selectMs,[long]$init.closeMs)) {
        $null=$monitor.AddArgument($value)
    }
    $pending=$monitor.BeginInvoke()
    $compilerParameters = [System.CodeDom.Compiler.CompilerParameters]::new()
    $compilerParameters.GenerateInMemory = $true
    $compilerParameters.TempFiles = [System.CodeDom.Compiler.TempFileCollection]::new($tempDirectory,$false)
    foreach ($assembly in @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll')) { [void]$compilerParameters.ReferencedAssemblies.Add($assembly) }
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-folder-picker.cs') -CompilerParameters $compilerParameters
    if($cancel.IsSet) {
        if($state['reason'] -eq 'timeout') { $result='{"type":"result","status":"failed","code":"PICKER_TIMEOUT"}' }
        else { $result='{"type":"result","status":"cancelled"}' }
    } else {
        $result=[CollaborativeNotes.Native.Picker]::Run([string]$init.initialPath,[string]$init.title,[string]$init.mutexKey,$state,$cancel,$clock)
    }
    $parsed=ConvertFrom-Json $result
    if($parsed.status -in @('selected','cancelled')) { $exitCode=0 }
    [Console]::WriteLine($result)
    [Console]::Out.Flush()
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $result='{"type":"result","status":"failed","code":"PICKER_UNAVAILABLE"}'
    [Console]::WriteLine($result)
    [Console]::Out.Flush()
} finally {
    $state['done']=$true
    if($compilerParameters -and $compilerParameters.TempFiles) {
        try { $compilerParameters.TempFiles.Delete() } catch { }
    }
    if($pending) {
        if($pending.AsyncWaitHandle.WaitOne(1000)) {
            try { $null=$monitor.EndInvoke($pending) } catch {}
        } else { try { $monitor.Stop() } catch {} }
    }
    if($monitor) { $monitor.Dispose() }
    if($monitorRunspace) { $monitorRunspace.Dispose() }
    if($parent) { $parent.Dispose() }
    $cancel.Dispose()
}
# The control reader may be blocked in Console.ReadLine. All GUI/COM/Mutex work
# is already disposed; exiting the process closes that private reader thread.
[Environment]::Exit($exitCode)
