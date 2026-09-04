param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$DeploySha,
  [Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$WebPort,
  [Parameter(Mandatory = $true)][ValidatePattern('^mysql@sha256:[0-9a-f]{64}$')][string]$MysqlImage,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputPath) {
  throw "Refusing to overwrite existing environment file: $OutputPath"
}

function New-HexSecret([int]$Bytes) {
  $buffer = [byte[]]::new($Bytes)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
}

$directory = Split-Path -Parent $OutputPath
[System.IO.Directory]::CreateDirectory($directory) | Out-Null
$adminUsername = 'kr-admin-' + (New-HexSecret 6)
$lines = @(
  'COMPOSE_PROJECT_NAME=aimasker-adobe2api-plus',
  "DEPLOY_SHA=$DeploySha",
  "WEB_PORT=$WebPort",
  "WEB_IMAGE=aimasker/adobe2api-plus-web:$DeploySha",
  "MINT_IMAGE=aimasker/adobe2api-plus-mint:$DeploySha",
  "MYSQL_IMAGE=$MysqlImage",
  'MYSQL_DATABASE=adobe2api_plus',
  'MYSQL_USER=adobe2api',
  ('MYSQL_ROOT_PASSWORD=' + (New-HexSecret 32)),
  ('MYSQL_PASSWORD=' + (New-HexSecret 32)),
  ('SESSION_SECRET=' + (New-HexSecret 48)),
  ('ENCRYPTION_KEY=' + (New-HexSecret 32)),
  "ADMIN_BOOTSTRAP_USERNAME=$adminUsername",
  ('ADMIN_BOOTSTRAP_PASSWORD=' + (New-HexSecret 32))
)

[System.IO.File]::WriteAllLines($OutputPath, $lines, [System.Text.UTF8Encoding]::new($false))

Write-Output "Created private environment file at $OutputPath"
