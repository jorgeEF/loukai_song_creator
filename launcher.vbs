Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Obtiene la ruta de la carpeta donde reside este archivo .vbs
scriptPath = fso.GetParentFolderName(WScript.ScriptFullName)

' Ejecuta npm start dentro de esa carpeta de forma invisible
WshShell.Run "cmd /c cd /d """ & scriptPath & """ && npm start", 0, False