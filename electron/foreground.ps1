# Foreground window: print "L2D:" + base64(UTF-8) of "title|process".
# Why base64: powershell.exe stdout uses the console code page (GBK/936 on this host),
# so a Chinese title would be mojibake when Node decodes it as UTF-8.
# Do NOT set [Console]::OutputEncoding here: with redirected stdout it throws IOException
# and the script exits silently.
# Keep this file ASCII-only (no BOM): Windows PowerShell 5.1 reads BOM-less files as ANSI.

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class L2DFW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h = [L2DFW]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][L2DFW]::GetWindowText($h, $sb, 512)
$procId = 0
[void][L2DFW]::GetWindowThreadProcessId($h, [ref]$procId)
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
$payload = "$($sb.ToString())|$($p.ProcessName)"
"L2D:" + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload))
