Option Explicit
' 双击这个文件：停掉后台的本地服务
Dim fso, sh, here, nodeExe

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

sh.Run """" & nodeExe & """ """ & here & "\server.mjs"" --stop", 0, False