param([Parameter(Mandatory)][string]$Configuration)
$ErrorActionPreference='Stop'
# Installed copy and configuration must be writable only by SYSTEM/Administrators.
# Never run a script, command line, path or download URL supplied by the web app.
$config=Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
$installation='C:\ProgramData\Mirea'
$maintenance='C:\ProgramData\Mirea\maintenance'
if($env:COMPUTERNAME -ine 'WINVAI01' -or $config.installation -ine $installation -or [IO.Path]::GetFullPath($Configuration) -ine ($maintenance+'\helper-config.json')){throw 'Unexpected maintenance host/configuration'}
$admin=([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){throw 'The maintenance agent must run as SYSTEM/Administrator'}
$taskName='Mirea-0.1.0beta';$node=$installation+'\runtime\node.exe'
$requestRoot=$maintenance+'\requests';$statusRoot=$maintenance+'\status'
$mutex=[Threading.Mutex]::new($false,'Global\Mirea-UpdateAgent-v1')
if(-not $mutex.WaitOne(0)){exit 0}
function SafeChild([string]$Path,[string]$Root){
  $full=[IO.Path]::GetFullPath($Path);$parent=[IO.Path]::GetFullPath($Root)
  if(-not $full.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path outside configured maintenance directory'}
  $candidate=$full
  while($candidate.Length -ge $parent.Length){if((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse points are forbidden'};$candidate=Split-Path $candidate -Parent;if(-not $candidate){break}}
  return $full
}
function Status([string]$Id,[string]$Tag,[string]$State,[string]$Stage,[string]$ErrorText=''){
  $path=SafeChild (Join-Path $statusRoot ($Id+'.json')) $statusRoot
  $json=@{state=$State;stage=$Stage;tag=$Tag;error=$ErrorText;updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
  $temporary=$path+'.tmp'
  [IO.File]::WriteAllText($temporary,$json,[Text.UTF8Encoding]::new($false))
  if(Test-Path -LiteralPath $path){[IO.File]::Replace($temporary,$path,$null)}else{[IO.File]::Move($temporary,$path)}
}
function StopMirea {
  Disable-ScheduledTask -TaskName $taskName -TaskPath '\'|Out-Null;Stop-ScheduledTask -TaskName $taskName -TaskPath '\'
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while(Get-NetTCPConnection -State Listen -LocalAddress '10.21.110.1' -LocalPort 3443 -ErrorAction SilentlyContinue){if([DateTime]::UtcNow -gt $deadline){throw 'Server did not stop; no unrelated process was killed'};Start-Sleep -Milliseconds 250}
}
function StartMirea {Enable-ScheduledTask -TaskName $taskName -TaskPath '\'|Out-Null;Start-ScheduledTask -TaskName $taskName -TaskPath '\'}
function SetReleaseAccess([string]$Directory,[string]$ServiceRights){
  [void](SafeChild $Directory ($installation+'\releases'))
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),$ServiceRights,'ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $Directory -AclObject $acl
}
function CopyVerified([string]$Source,[string]$Destination){
  # The protected rollback directory keeps secrets inaccessible to the web user.
  New-Item -ItemType Directory -Path $Destination -Force|Out-Null
  & ($env:SystemRoot+'\System32\robocopy.exe') $Source $Destination /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
  if($LASTEXITCODE -ge 8){throw 'Data copy failed'}
  foreach($f in Get-ChildItem -LiteralPath $Source -Recurse -File -Force){
    $relative=$f.FullName.Substring($Source.Length+1);$copy=Join-Path $Destination $relative
    if((Get-FileHash -LiteralPath $f.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash){throw 'Rollback backup checksum mismatch'}
  }
}
function Health([string]$Version,[bool]$RequireMaintenance=$false){
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  while([DateTime]::UtcNow -lt $deadline){try{$r=Invoke-RestMethod -Uri 'https://10.21.110.1:3443/api/health' -TimeoutSec 5;if($r.status -eq 'ok' -and $r.version -eq $Version -and (-not $RequireMaintenance -or $r.maintenanceLocked -eq $true)){return}}catch{};Start-Sleep -Milliseconds 500}
  throw 'HTTPS health check failed (certificate validation remains enabled)'
}
try{
  foreach($file in Get-ChildItem -LiteralPath $requestRoot -File -Filter '*.json'){
    $id=$file.BaseName;if($id -notmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'){continue}
    if(Test-Path -LiteralPath (Join-Path $statusRoot ($id+'.json'))){continue}
    $stopped=$false;$switched=$false;$dataBackedUp=$false;$rollback=$null;$originalAction=$null;$depsTask=$null;$tag=''
    try{
      [void](SafeChild $file.FullName $requestRoot)
      if($file.Length -gt 2048){throw 'Oversized update request'}
      $request=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
      if($request.protocol -ne 1 -or $request.id -ne $id -or $request.tag -notmatch '^v\d+\.\d+\.\d+(?:beta(?:\.\d+)?)?$' -or $request.sha256 -notmatch '^[a-f0-9]{64}$' -or $request.assetId -isnot [long] -and $request.assetId -isnot [int]){throw 'Invalid update request'}
      if([Math]::Abs([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[long]$request.requestedAt) -gt 120000){throw 'Update request expired before agent acknowledgement'}
      $tag=$request.tag;Status $id $tag 'running' 'verifying-release'
      $task=Get-ScheduledTask -TaskName $taskName -TaskPath '\'
      $oldRelease=SafeChild $task.Actions[0].WorkingDirectory ($installation+'\releases')
      if($task.Actions.Count -ne 1 -or $task.Principal.UserId -notin @('LOCAL SERVICE','NT AUTHORITY\LOCAL SERVICE','S-1-5-19') -or -not $task.Settings.Enabled -or $task.Actions[0].Execute -ine ($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe') -or -not $task.Actions[0].Arguments.Contains($oldRelease) -or -not $task.Actions[0].Arguments.Contains($node)){throw 'Unexpected existing server task'}
      $originalAction=$task.Actions[0]
      $oldPackage=Get-Content -LiteralPath (Join-Path $oldRelease 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json
      Health $oldPackage.version $true
      # Revalidate GitHub's publisher-controlled asset digest; ignore any URL/path
      # in the request. The installed Node verifier also rejects downgrades.
      $verify=& $node (Join-Path $maintenance 'bin\scripts\verify-server-release.mjs') $tag $oldPackage.version
      if($LASTEXITCODE -ne 0){throw 'Official release verification failed'}
      $candidate=$verify|ConvertFrom-Json
      if($candidate.sha256 -ne $request.sha256 -or $candidate.assetId -ne $request.assetId){throw 'Release changed since admin confirmation'}
      $work=SafeChild (Join-Path ($maintenance+'\work') $id) ($maintenance+'\work');New-Item -ItemType Directory -Path $work|Out-Null
      $archive=Join-Path $work 'server.tar.gz'
      # This fixed API endpoint redirects only to GitHub release-asset storage.
      & $node (Join-Path $maintenance 'bin\scripts\download-server-release.mjs') $tag $oldPackage.version $archive
      if($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $archive).Hash -ine $candidate.sha256){throw 'Package download/hash verification failed'}
      $folder='mirea-'+$tag.Substring(1)+'-server';$newRelease=SafeChild (Join-Path ($installation+'\releases') $folder) ($installation+'\releases')
      if(Test-Path -LiteralPath $newRelease){throw 'Target release already exists; refusing overwrite'}
      # Validate raw tar entries (including link types and traversal) before tar
      # is allowed to extract anything under the installation directory.
      & $node (Join-Path $maintenance 'bin\scripts\verify-server-archive.mjs') $archive $folder
      if($LASTEXITCODE -ne 0){throw 'Unsafe server archive'}
      & ($env:SystemRoot+'\System32\tar.exe') -xf $archive --no-same-owner --no-same-permissions -C ($installation+'\releases');if($LASTEXITCODE -ne 0){throw 'Package extraction failed'}
      $manifest=Get-Content -LiteralPath (Join-Path $newRelease 'release-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
      $newPackage=Get-Content -LiteralPath (Join-Path $newRelease 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json
      if($manifest.release -ne $tag.Substring(1) -or $manifest.version -ne $newPackage.version -or $manifest.commit -notmatch '^[a-f0-9]{40}$'){throw 'Release manifest mismatch'}
      # Dependency lifecycle scripts execute as LOCAL SERVICE, never SYSTEM.
      Status $id $tag 'running' 'installing-dependencies'
      SetReleaseAccess $newRelease 'Modify'
      $depsTask='Mirea-PrepareUpdate-'+$id
      $dependencyArguments='-NoProfile -NonInteractive -File "'+$maintenance+'\bin\scripts\Prepare-WindowsUpdate.ps1" -ReleasePath "'+$newRelease+'"'
      $action=New-ScheduledTaskAction -Execute ($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $dependencyArguments -WorkingDirectory $newRelease
      $principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount
      $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
      Register-ScheduledTask -TaskName $depsTask -Action $action -Principal $principal -Settings $settings | Out-Null
      Start-ScheduledTask -TaskName $depsTask
      $deadline=[DateTime]::UtcNow.AddMinutes(10)
      do{Start-Sleep -Seconds 1;$deps=Get-ScheduledTask -TaskName $depsTask;if([DateTime]::UtcNow -gt $deadline){throw 'Dependency preparation timed out'}}while($deps.State -eq 'Running')
      if((Get-ScheduledTaskInfo -TaskName $depsTask).LastTaskResult -ne 0){throw 'Dependency installation failed'}
      # Lock the completed release against writes by the web identity.
      SetReleaseAccess $newRelease 'ReadAndExecute'
      if(@(Get-ChildItem -LiteralPath $newRelease -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Prepared release contains links'}
      # CreateNew refuses an existing file/link; never overwrite a path created
      # by the unprivileged dependency-preparation process as Administrator.
      $newEnvironment=[IO.File]::Open((Join-Path $newRelease '.env'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try{$environmentBytes=[IO.File]::ReadAllBytes((Join-Path $oldRelease '.env'));$newEnvironment.Write($environmentBytes,0,$environmentBytes.Length);$newEnvironment.Flush($true)}finally{$newEnvironment.Dispose();if($environmentBytes){[Array]::Clear($environmentBytes,0,$environmentBytes.Length)}}
      Status $id $tag 'running' 'backing-up-data'
      # A server restart or interrupted handoff must not silently remove the
      # write barrier while dependency preparation is in progress.
      Health $oldPackage.version $true
      $stopped=$true;StopMirea
      $data=SafeChild ($installation+'\data') $installation
      if(@(Get-ChildItem -LiteralPath $data -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Data links are not supported by rollback backup'}
      $rollback=SafeChild (Join-Path ($maintenance+'\rollback') $id) ($maintenance+'\rollback')
      CopyVerified $data (Join-Path $rollback 'data');Copy-Item -LiteralPath (Join-Path $oldRelease '.env') -Destination (Join-Path $rollback 'server.env')
      [IO.File]::WriteAllText((Join-Path $rollback 'task.xml'),(Export-ScheduledTask -TaskName $taskName))
      $dataBackedUp=$true
      Status $id $tag 'running' 'switching-release'
      $nextAction=New-ScheduledTaskAction -Execute $originalAction.Execute -Argument $originalAction.Arguments.Replace($oldRelease,$newRelease) -WorkingDirectory $newRelease
      Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $nextAction|Out-Null;$switched=$true
      StartMirea;Health $newPackage.version;$stopped=$false
      Status $id $tag 'complete' 'healthy'
    }catch{
      $failureDetail=$_.Exception.Message
      $message='Update failed; inspect the protected helper log.';$state='failed'
      try{
        if($switched -and $dataBackedUp){
          StopMirea
          $data=SafeChild ($installation+'\data') $installation
          $quarantine=SafeChild (Join-Path ($maintenance+'\rollback') ($id+'-failed-data')) ($maintenance+'\rollback')
          if(Test-Path -LiteralPath $quarantine){throw 'Rollback quarantine exists'}
          Move-Item -LiteralPath $data -Destination $quarantine
          CopyVerified (Join-Path $rollback 'data') $data
          & ($env:SystemRoot+'\System32\icacls.exe') $data /grant '*S-1-5-19:(OI)(CI)M' /T /Q | Out-Null;if($LASTEXITCODE -ne 0){throw 'Cannot restore data permissions'}
          Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $originalAction|Out-Null
          StartMirea;Health $oldPackage.version;$state='rolled_back';$message='Update failed; previous release and data restored.'
        }elseif($stopped){StartMirea;Health $oldPackage.version}
      }catch{$message='Update and automatic recovery failed. Administrator intervention is required.'}
      # Detailed errors stay in the admin-only log, never in the web response.
      [IO.File]::AppendAllText((Join-Path $maintenance 'logs\helper.log'),([DateTime]::UtcNow.ToString('o')+' '+$id+' '+$failureDetail+"`n"))
      Status $id $tag $state 'finished' $message
    }finally{if($depsTask){Stop-ScheduledTask -TaskName $depsTask -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $depsTask -Confirm:$false -ErrorAction SilentlyContinue}}
  }
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
