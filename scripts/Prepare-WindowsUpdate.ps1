param([Parameter(Mandatory)][string]$ReleasePath)
$ErrorActionPreference='Stop'
if($ReleasePath -notmatch '^C:\\ProgramData\\Mirea\\releases\\mirea-\d+\.\d+\.\d+(?:beta(?:\.\d+)?)?-server$'){throw 'Invalid prepared release path'}
$env:PATH='C:\ProgramData\Mirea\runtime;'+$env:PATH
Set-Location -LiteralPath $ReleasePath
& 'C:\ProgramData\Mirea\runtime\node.exe' 'C:\ProgramData\Mirea\maintenance\bin\pnpm\bin\pnpm.cjs' install --prod --frozen-lockfile --node-linker=hoisted --package-import-method=copy
exit $LASTEXITCODE
