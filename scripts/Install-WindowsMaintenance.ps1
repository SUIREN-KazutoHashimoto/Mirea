param([Parameter(Mandatory)][string]$PnpmDirectory)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ine 'WINVAI01'){throw 'Initial implementation is restricted to WinVAI01'}
if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this installer explicitly as Administrator'}
$installation='C:\ProgramData\Mirea';$target=$installation+'\maintenance'
if(Test-Path -LiteralPath $target){throw 'Maintenance directory already exists; inspect it instead of overwriting'}
$package=Get-Content -LiteralPath (Join-Path $PnpmDirectory 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($package.name -ne 'pnpm' -or $package.version -ne '11.25.0' -or -not (Test-Path -LiteralPath (Join-Path $PnpmDirectory 'bin\pnpm.cjs'))){throw 'Provide an explicitly trusted pnpm 11.25.0 distribution directory'}
if((Get-Item -LiteralPath $installation).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installation must not be a link'}
$repository=Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Path $target|Out-Null
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $target -AclObject $acl
foreach($name in @('requests','status','work','rollback','logs','bin','bin\scripts','bin\server')){New-Item -ItemType Directory -Path (Join-Path $target $name)|Out-Null}
$requestAcl=Get-Acl -LiteralPath (Join-Path $target 'requests')
$requestAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),'Modify','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath (Join-Path $target 'requests') -AclObject $requestAcl
foreach($private in @('work','rollback','logs')){
  $privateAcl=[Security.AccessControl.DirectorySecurity]::new();$privateAcl.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){$privateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  Set-Acl -LiteralPath (Join-Path $target $private) -AclObject $privateAcl
}
foreach($name in @('Windows-UpdateAgent.ps1','Prepare-WindowsUpdate.ps1','verify-server-release.mjs','download-server-release.mjs','verify-server-archive.mjs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $target ('bin\scripts\'+$name))}
foreach($name in @('server-updates.js','admin.js','database.js','security.js')){Copy-Item -LiteralPath (Join-Path $repository ('server\'+$name)) -Destination (Join-Path $target ('bin\server\'+$name))}
Copy-Item -LiteralPath (Join-Path $repository 'package.json') -Destination (Join-Path $target 'bin\package.json')
Copy-Item -LiteralPath $PnpmDirectory -Destination (Join-Path $target 'bin\pnpm') -Recurse
[IO.File]::WriteAllText((Join-Path $target 'helper-config.json'),(@{protocol=1;installation=$installation}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$arguments='-NoProfile -NonInteractive -File "'+$target+'\bin\scripts\Windows-UpdateAgent.ps1" -Configuration "'+$target+'\helper-config.json"'
$action=New-ScheduledTaskAction -Execute ($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments -WorkingDirectory $target
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
Register-ScheduledTask -TaskName 'Mirea-Maintenance-v1' -Action $action -Trigger $trigger -Principal $principal -Settings $settings|Out-Null
[IO.File]::WriteAllText((Join-Path $target 'capabilities.json'),(@{protocol=1;platform='win32';installed=$true}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output 'Installed maintenance helper. Set WINDOWS_MAINTENANCE_DIR=C:/ProgramData/Mirea/maintenance in the server environment and restart the reviewed release. The web task remains LOCAL SERVICE.'
