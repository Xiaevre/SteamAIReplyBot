' Steam Community Reply Assistant - Background Silent Launcher
' Starts SteamAIReplyBot completely silently in the background without CMD window
Option Explicit
Dim fso, wshShell, currentDir, exePath

Set fso = CreateObject("Scripting.FileSystemObject")
Set wshShell = CreateObject("WScript.Shell")

currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
wshShell.CurrentDirectory = currentDir

exePath = currentDir & "\SteamAIReplyBot.exe"
If Not fso.FileExists(exePath) Then
    exePath = currentDir & "\release\SteamAIReplyBot.exe"
End If

If fso.FileExists(exePath) Then
    wshShell.Run """" & exePath & """ --background --headless", 0, False
Else
    Dim nodeExe, bootstrapJs
    nodeExe = currentDir & "\bin\node.exe"
    If Not fso.FileExists(nodeExe) Then
        nodeExe = currentDir & "\release\bin\node.exe"
    End If
    bootstrapJs = currentDir & "\bootstrap.js"
    If Not fso.FileExists(bootstrapJs) Then
        bootstrapJs = currentDir & "\release\bootstrap.js"
    End If

    If fso.FileExists(nodeExe) And fso.FileExists(bootstrapJs) Then
        wshShell.Run """" & nodeExe & """ """ & bootstrapJs & """ --background --headless", 0, False
    Else
        MsgBox "Cannot find SteamAIReplyBot.exe or node runtime in " & currentDir, 16, "SteamAIReplyBot Launch Error"
    End If
End If
