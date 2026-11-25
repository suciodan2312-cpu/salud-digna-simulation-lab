param([Parameter(Mandatory)][switch]$ApproveNewLocalLab, [ValidateRange(1,9)][int]$Attempt = 1, [switch]$AllowRegistry, [switch]$ResumeCluster, [switch]$LargeCorpus, [switch]$MillionCorpus, [switch]$FiveMillionCorpus,
  [ValidatePattern('^[0-9a-f]{40}$')][string]$ServiceRevision='ff989ccd6e1062a5508e8f92cefbf17b7830896b', [switch]$CloneSynthetic5M)
$ErrorActionPreference = 'Stop'
if (-not $ApproveNewLocalLab) { throw 'Preparación local no autorizada' }
$corpusRevision = 'ff989ccd6e1062a5508e8f92cefbf17b7830896b'
$sim = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $env:SIM_SERVICES_REPO -or -not [IO.Path]::IsPathRooted($env:SIM_SERVICES_REPO)) { throw 'Configure SIM_SERVICES_REPO con la ruta absoluta del repositorio privado de servicios' }
$repo = (Resolve-Path -LiteralPath $env:SIM_SERVICES_REPO).Path
$base = $ServiceRevision
$integration = $base -ne $corpusRevision
if ($integration -and ($base -ne 'bff1f5890a6929719a241fe7ed8c40efd4b95860' -or -not $FiveMillionCorpus -or -not $CloneSynthetic5M)) { throw 'Combinación de revisión y corpus no habilitada' }
if ($CloneSynthetic5M -and -not $integration) { throw 'La copia requiere un destino de integración independiente' }
$postgresPort = if ($integration) { 55436 } elseif ($FiveMillionCorpus) { 55435 } elseif ($MillionCorpus) { 55434 } elseif ($LargeCorpus) { 55433 } else { 55432 }
$centralPort = if ($integration) { 13104 } elseif ($FiveMillionCorpus) { 13103 } elseif ($MillionCorpus) { 13102 } elseif ($LargeCorpus) { 13101 } else { 13100 }
$orchestratorPort = if ($integration) { 13304 } elseif ($FiveMillionCorpus) { 13303 } elseif ($MillionCorpus) { 13302 } elseif ($LargeCorpus) { 13301 } else { 13300 }
$datasetId = if ($FiveMillionCorpus) { '83c9d0aa989ec6d1d2ea1e17' } elseif ($MillionCorpus) { '503f4ea4414832b71280a1c5' } elseif ($LargeCorpus) { 'ceadf10e490e4791b1168eb9' } else { '3ec1448fee9783a2150ccefc' }
$suffix = if ($FiveMillionCorpus) { "-5m-$Attempt" } elseif ($MillionCorpus) { "-1m-$Attempt" } elseif ($LargeCorpus) { "-100k-$Attempt" } elseif ($Attempt -eq 1) { '' } else { "-$Attempt" }
$lab = Join-Path $sim "reports/local-lab-$($base.Substring(0,7))$suffix"
if ((Test-Path -LiteralPath $lab) -and -not $ResumeCluster) { throw 'El laboratorio ya existe. Comprueba su estado antes de continuar' }
function Require-Success([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "Falló la etapa $step. Revisa los logs privados del laboratorio" }
}
function Run-Logged([string]$file, [string[]]$arguments, [string]$log, [string]$step) {
  # Windows PowerShell 5 treats redirected native stderr as an error record.
  $ErrorActionPreference = 'Continue'
  & $file @arguments *> (Join-Path $lab $log)
  Require-Success $step
}
foreach ($port in $(if ($ResumeCluster) { @($centralPort,$orchestratorPort) } else { @($postgresPort,$centralPort,$orchestratorPort) })) {
  $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
  try { $probe.Start() } catch { throw "Puerto local ocupado: $port" } finally { $probe.Stop() }
}
if ((& git -c "safe.directory=$repo" -C $repo rev-parse --verify "${base}^{commit}") -ne $base) { throw 'Se requiere la revisión auditada' }
if (-not $ResumeCluster) {
New-Item -ItemType Directory -Path $lab | Out-Null
$acl = Get-Acl -LiteralPath $lab
$acl.SetAccessRuleProtection($true, $false)
$who = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [Security.AccessControl.FileSystemAccessRule]::new($who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $lab -AclObject $acl
$runtime = Join-Path $lab 'runtime'
New-Item -ItemType Directory -Path $runtime | Out-Null
$archive = Join-Path $lab 'audited.tar'
& git -c "safe.directory=$repo" -C $repo archive --format=tar --output=$archive $base
Require-Success 'archivo auditado'
& tar -xf $archive -C $runtime
Require-Success 'extracción de fuentes'
Push-Location $runtime
try {
  $cacheMode = if ($AllowRegistry) { '--prefer-offline' } else { '--offline' }
  Run-Logged 'corepack.cmd' @('pnpm','--filter','@salud-digna/api','--filter','@salud-digna/orchestrator','install',$cacheMode,'--frozen-lockfile') 'install.log' 'dependencias'
  $env:OPENAPI_EXPORT = 'true'
  Run-Logged 'corepack.cmd' @('pnpm','--filter','@salud-digna/api','prisma:generate') 'api-generate.log' 'Prisma generate api'
  Run-Logged 'corepack.cmd' @('pnpm','--filter','@salud-digna/api','exec','tsc') 'api-build.log' 'compilación API'
  Require-Success 'compilación API'
  Remove-Item Env:OPENAPI_EXPORT,Env:DATABASE_URL -ErrorAction SilentlyContinue
  Run-Logged 'corepack.cmd' @('pnpm','--filter','@salud-digna/orchestrator','prisma:generate') 'orchestrator-generate.log' 'Prisma generate orchestrator'
  Run-Logged 'corepack.cmd' @('pnpm','--filter','@salud-digna/orchestrator','exec','tsc') 'orchestrator-build.log' 'compilación orquestador'
  Require-Success 'compilación orquestador'
} finally { Pop-Location }
}
function New-Secret {
  $secret = (& node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
  if ($secret -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'No se pudo generar secreto local' }
  $secret
}
if (-not $ResumeCluster) {
$admin = New-Secret
$central = New-Secret
$orchestrator = New-Secret
$adminFile = Join-Path $lab 'cluster-admin.pw'
Set-Content -LiteralPath $adminFile -Value $admin -Encoding Ascii
$cluster = Join-Path $lab 'pgdata'
Run-Logged 'initdb' @('-D',$cluster,'-U','sim_cluster_admin','--auth=scram-sha-256',"--pwfile=$adminFile",'--encoding=UTF8') 'initdb.log' 'initdb'
Require-Success 'initdb'
Add-Content -LiteralPath (Join-Path $cluster 'postgresql.conf') -Value @"

listen_addresses = '127.0.0.1'
port = $postgresPort
"@
$pgLog = Join-Path $lab 'postgres.log'
$ctl = Start-Process -WindowStyle Hidden -PassThru -FilePath (Get-Command pg_ctl).Source -ArgumentList @('-D', ('"' + $cluster + '"'), '-l', ('"' + $pgLog + '"'), '-w', 'start')
if (-not $ctl.WaitForExit(65000) -or $ctl.ExitCode -ne 0) { throw 'PostgreSQL privado no confirmó el arranque' }

} else {
  if (Test-Path -LiteralPath (Join-Path $lab 'database-prepare.log')) { throw 'Ya comenzó la etapa de creación de bases' }
  $cluster = Join-Path $lab 'pgdata'
  $adminFile = Join-Path $lab 'cluster-admin.pw'
  $pidInfo = Get-Content -LiteralPath (Join-Path $cluster 'postmaster.pid') -TotalCount 8
  if ($pidInfo[1].Replace('/','\') -ne $cluster -or $pidInfo[3] -ne "$postgresPort" -or $pidInfo[5] -ne '127.0.0.1' -or $pidInfo[7].Trim() -ne 'ready') {
    throw 'El clúster activo no coincide con el laboratorio exclusivo'
  }
  $admin = (Get-Content -LiteralPath $adminFile -TotalCount 1).Trim()
  if ($admin -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Credencial local de clúster inválida' }
  $central = New-Secret
  $orchestrator = New-Secret
  $runtime = Join-Path $lab 'runtime'
}
$env:PGPASSWORD = $admin
try {
  @"
CREATE ROLE sim_central_app LOGIN PASSWORD '$central';
CREATE ROLE salud_digna_orchestrator_app LOGIN PASSWORD '$orchestrator';
CREATE DATABASE salud_digna_simulation OWNER sim_central_app;
CREATE DATABASE salud_digna_orchestrator OWNER salud_digna_orchestrator_app;
COMMENT ON DATABASE salud_digna_simulation IS 'salud-digna:synthetic-only';
COMMENT ON DATABASE salud_digna_orchestrator IS 'salud-digna:synthetic-only';
"@ | & psql -X -q -h 127.0.0.1 -p $postgresPort -U sim_cluster_admin -d postgres -v ON_ERROR_STOP=1 *> (Join-Path $lab 'database-prepare.log')
  Require-Success 'creación de bases sintéticas'
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
$centralUrl = "postgresql://sim_central_app:$central@127.0.0.1:$postgresPort/salud_digna_simulation"
$orchestratorUrl = "postgresql://salud_digna_orchestrator_app:$orchestrator@127.0.0.1:$postgresPort/salud_digna_orchestrator"
if ($CloneSynthetic5M) {
  $source = Join-Path $sim 'reports/local-lab-ff989cc-5m-1'
  $meta = Get-Content -Raw (Join-Path $source 'processes.json') | ConvertFrom-Json
  if ($meta.base -ne $corpusRevision -or $meta.postgresPort -ne 55435 -or $postgresPort -ne 55436) { throw 'Origen de copia inesperado' }
  foreach ($db in @('salud_digna_simulation','salud_digna_orchestrator')) {
    $dump = Join-Path $lab "$db.dump"
    try {
      $env:PGPASSWORD = (Get-Content (Join-Path $source 'cluster-admin.pw') -TotalCount 1).Trim()
      $marker = & psql -X -At -h 127.0.0.1 -p 55435 -U sim_cluster_admin -d $db -c "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()"
      if ($LASTEXITCODE -or $marker -ne 'salud-digna:synthetic-only') { throw 'Origen no sintético' }
      Run-Logged 'pg_dump' @('-h','127.0.0.1','-p','55435','-U','sim_cluster_admin','-Fc','-f',$dump,$db) "$db-dump.log" 'snapshot en lectura'
      $role = if ($db -eq 'salud_digna_simulation') { 'sim_central_app' } else { 'salud_digna_orchestrator_app' }
      $env:PGPASSWORD = if ($db -eq 'salud_digna_simulation') { $central } else { $orchestrator }
      Run-Logged 'pg_restore' @('-h','127.0.0.1','-p','55436','-U',$role,'-d',$db,'--no-owner','--no-acl','--single-transaction',$dump) "$db-restore.log" 'restauración en base nueva'
    } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  }
}
$apiPath = Join-Path $runtime 'apps/api'
$orchPath = Join-Path $runtime 'apps/orchestrator'
Set-Content -LiteralPath (Join-Path $apiPath '.env') -Encoding Ascii -Value @"
DATABASE_URL=$centralUrl
JWT_SECRET=$(New-Secret)
API_HOST=127.0.0.1
API_PORT=$centralPort
NODE_ENV=development
WHATSAPP_ENABLED=false
OPENAI_ENABLED=false
CONVERSATION_SIMULATOR_ENABLED=true
IDENTITY_SIMULATOR_ENABLED=false
TRUST_LOCAL_PROXY=false
"@
Set-Content -LiteralPath (Join-Path $orchPath '.env') -Encoding Ascii -Value @"
DATABASE_URL=$orchestratorUrl
ORCHESTRATOR_DB_HOST=127.0.0.1
ORCHESTRATOR_DB_PORT=$postgresPort
ORCHESTRATOR_PORT=$orchestratorPort
ORCHESTRATOR_CONTINUITY_HMAC_KEY=$(New-Secret)
ORCHESTRATOR_PATIENT_IDENTITY_KEY=$(New-Secret)
"@
Push-Location $runtime
try {
  $env:DATABASE_URL = $centralUrl
  Run-Logged 'corepack.cmd' @('pnpm','--filter','@salud-digna/api','prisma:migrate:deploy') 'api-migrate.log' 'migraciones centrales'
  Require-Success 'migraciones centrales'
  $env:DATABASE_URL = $orchestratorUrl
  $env:ORCHESTRATOR_DB_HOST = '127.0.0.1'
  $env:ORCHESTRATOR_DB_PORT = "$postgresPort"
  Run-Logged 'corepack.cmd' @('pnpm','--filter','@salud-digna/orchestrator','prisma:migrate:deploy') 'orchestrator-migrate.log' 'migraciones del orquestador'
  Require-Success 'migraciones del orquestador'
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Pop-Location
}
$node = (Get-Command node).Source
function Start-LocalApp($path, $name) {
  $parameters = @{ PassThru=$true; WindowStyle='Hidden'; FilePath=$node; ArgumentList='dist/main.js'; WorkingDirectory=$path
    RedirectStandardOutput=(Join-Path $lab "$name.stdout.log"); RedirectStandardError=(Join-Path $lab "$name.stderr.log") }
  Start-Process @parameters
}
$env:API_HOST = '127.0.0.1'
$env:API_PORT = "$centralPort"
$env:ORCHESTRATOR_PORT = "$orchestratorPort"
$env:WHATSAPP_ENABLED = 'false'
$env:OPENAI_ENABLED = 'false'
$env:CONVERSATION_SIMULATOR_ENABLED = 'true'
$env:IDENTITY_SIMULATOR_ENABLED = 'false'
$env:NODE_ENV = 'development'
$env:DATABASE_URL = $centralUrl
$api = Start-LocalApp $apiPath 'api'
$env:DATABASE_URL = $orchestratorUrl
$orch = Start-LocalApp $orchPath 'orchestrator'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Set-Content -LiteralPath (Join-Path $lab 'simulation.env') -Encoding Ascii -Value @"
SIM_ENV=local
SIM_CENTRAL_URL=http://127.0.0.1:$centralPort
SIM_ORCHESTRATOR_URL=http://127.0.0.1:$orchestratorPort
SIM_CENTRAL_DATABASE_URL=$centralUrl
SIM_ORCHESTRATOR_DATABASE_URL=$orchestratorUrl
SIM_DATASET_ID=$datasetId
SIM_CODE_REVISION=$base
SIM_CONVERSATION=true
"@
[pscustomobject]@{base=$base; corpusRevision=$corpusRevision; postgresPort=$postgresPort; centralPort=$centralPort; orchestratorPort=$orchestratorPort; centralPid=$api.Id; orchestratorPid=$orch.Id} |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lab 'processes.json') -Encoding Ascii
Get-Content -LiteralPath (Join-Path $lab 'processes.json')
