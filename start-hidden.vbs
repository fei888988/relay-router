' Runs the smart router in the background (no window). Logs go to data\router.log.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c node --disable-warning=ExperimentalWarning src\index.js >> data\router.log 2>&1", 0, False
