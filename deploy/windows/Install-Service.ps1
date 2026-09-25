#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory=$true)][string]$AppPath,
  [Parameter(Mandatory=$true)][string]$WinSWPath,
  [string]$NodePath = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$AppPath = (Resolve-Path $AppPath).Path
if (!(Test-Path "$AppPath\.env")) { throw 'Configure the production hub .env before registering its service.' }
if (!(Test-Path "$AppPath\node_modules\pm2\bin\pm2-runtime")) { throw 'Run npm ci, generate and build first.' }
if (!(Test-Path $WinSWPath) -or !(Test-Path $NodePath)) { throw 'Node or WinSW executable not found.' }
if (Get-Service HotelHub -ErrorAction SilentlyContinue) { throw 'HotelHub already exists. Use the upgrade/rollback runbook.' }
$State = Join-Path $env:ProgramData 'HotelHub'
New-Item -ItemType Directory -Force -Path "$State\pm2", "$State\logs", "$State\backups" | Out-Null
# LocalService gets read access to application/config and write access only to state.
icacls $AppPath /grant '*S-1-5-19:(OI)(CI)RX' /T /Q | Out-Null
icacls $State /inheritance:r /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' /T /Q | Out-Null
$ServiceExe = Join-Path $AppPath 'HotelHubService.exe'
Copy-Item $WinSWPath $ServiceExe
$EscApp = [System.Security.SecurityElement]::Escape($AppPath)
$EscNode = [System.Security.SecurityElement]::Escape($NodePath)
$EscState = [System.Security.SecurityElement]::Escape($State)
@"
<service>
  <id>HotelHub</id><name>Hotel Hub</name>
  <description>Offline hotel hub managed by PM2</description>
  <executable>$EscNode</executable>
  <arguments>&quot;$EscApp\node_modules\pm2\bin\pm2-runtime&quot; start &quot;$EscApp\ecosystem.config.cjs&quot;</arguments>
  <workingdirectory>$EscApp</workingdirectory>
  <env name="PM2_HOME" value="$EscState\pm2" />
  <serviceaccount><username>NT AUTHORITY\LocalService</username></serviceaccount>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec" />
  <logpath>$EscState\logs</logpath><log mode="roll" />
  <stoptimeout>30 sec</stoptimeout>
</service>
"@ | Set-Content -Encoding UTF8 "$AppPath\HotelHubService.xml"
& $ServiceExe install
if ($LASTEXITCODE -ne 0) { throw 'Windows service registration failed.' }
& $ServiceExe start
if ($LASTEXITCODE -ne 0) { throw 'Service failed to start. Inspect ProgramData\HotelHub\logs.' }
New-NetFirewallRule -DisplayName 'Hotel Hub LAN' -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow -Profile Private -RemoteAddress LocalSubnet | Out-Null
Write-Host 'Service registered. Verify reboot startup before accepting this hub.'
