param([Parameter(Mandatory)][string]$Id, [switch]$DemonstrateFrustration, [switch]$Cohort)
$ErrorActionPreference='Stop'
if ($Id -notmatch '^[a-z0-9][a-z0-9-]{0,47}$') { throw 'ID inválido' }
$sim=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $sim
try {
  $env:SIM_ADVISOR_EMAIL='advisor-fase4@example.test'
  $env:SIM_ADMIN_EMAIL='admin-fase4@example.test'
  $env:SIM_STAFF_APPROVAL='local-fixtures'
  $env:SIM_ALLOW_WRITES='true'
  $env:SIM_STAFF_FRUSTRATION = if ($DemonstrateFrustration) { 'true' } else { 'false' }
  foreach ($role in @('ADVISOR','ADMIN')) {
    $secret=Read-Host "Contraseña ficticia $role" -AsSecureString
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { [Environment]::SetEnvironmentVariable("SIM_$($role)_PASSWORD",[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr),'Process') }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secret.Dispose() }
  }
  $lab='reports/local-lab-ff989cc-4'
  if ($Cohort) {
    $env:SIM_COHORT_APPROVAL='atencion'
    $env:SIM_LOCAL_LAB='baseline'
    & node "--env-file=$lab/simulation.env" "--env-file=$lab/actors.env" "--env-file=$lab/channels.env" dist/local/cohort-run.js $Id atencion 10 120
  } else {
    & node "--env-file=$lab/simulation.env" "--env-file=$lab/actors.env" dist/local/staff.js $Id
  }
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
  Remove-Item Env:SIM_ADVISOR_PASSWORD,Env:SIM_ADMIN_PASSWORD,Env:SIM_STAFF_APPROVAL,Env:SIM_STAFF_FRUSTRATION -ErrorAction SilentlyContinue
  Pop-Location
}
