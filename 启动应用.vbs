Option Explicit
' DeepSeek local app launcher.
' Kept pure ASCII on purpose: WScript reads .vbs as ANSI.
' 1) service already running -> bring its window to front (or open one if none)
' 2) not running -> start the packaged app; fall back to the node/Edge path
' The app is started with --no-sandbox: on this machine Chromium sandbox init
' makes the process exit silently (that is the "double click does nothing").
' The app only loads 127.0.0.1 pages and blocks every external navigation.
Dim fso, sh, here, exe, nodeExe, args, alive, xhr

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

exe = here & "\dist\DeepSeek-win32-x64\DeepSeek.exe"
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

alive = False
On Error Resume Next
Set xhr = CreateObject("MSXML2.XMLHTTP.6.0")
xhr.Open "GET", "http://127.0.0.1:8787/api/state", False
xhr.Send
If Err.Number = 0 Then
  If xhr.Status = 200 Then alive = True
End If
Err.Clear
On Error Goto 0

If alive Then
  On Error Resume Next
  If sh.AppActivate("DeepSeek Local") Then
    WScript.Quit 0
  End If
  Err.Clear
  On Error Goto 0
End If

If fso.FileExists(exe) Then
  sh.Run Chr(34) & exe & Chr(34) & " --no-sandbox", 1, False
  WScript.Quit 0
End If

args = Chr(34) & here & "\server.mjs" & Chr(34) & " --desktop"
sh.Run Chr(34) & nodeExe & Chr(34) & " " & args, 0, False
