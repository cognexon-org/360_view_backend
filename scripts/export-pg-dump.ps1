# PropertyTour360: PostgreSQL Data Export & CockroachDB Import Script (PowerShell)
param(
  [string]$DumpFile = "postgres_data_export.sql",
  [string]$PgHost = "localhost",
  [int]$PgPort = 5432,
  [string]$PgUser = "propertytour",
  [string]$PgDb = "propertytour360",
  [string]$PgPassword = "propertytour_dev_password",
  [string]$CrHost = "localhost",
  [int]$CrPort = 26257,
  [string]$CrDb = "propertytour360",
  [string]$CrUser = "root"
)

$ErrorActionPreference = "Stop"

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  PropertyTour360 SQL Dump Exporter & Importer (PS)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "Source:  postgresql://${PgUser}@${PgHost}:${PgPort}/${PgDb}"
Write-Host "Target:  postgresql://${CrUser}@${CrHost}:${CrPort}/${CrDb}"
Write-Host "Output:  $DumpFile"
Write-Host "======================================================"

$env:PGPASSWORD = $PgPassword

Write-Host "[1/2] Exporting data from PostgreSQL (data-only, column inserts)..." -ForegroundColor Yellow
& pg_dump -h $PgHost -p $PgPort -U $PgUser -d $PgDb --data-only --column-inserts --no-owner --no-privileges -f $DumpFile

if ($LASTEXITCODE -eq 0 -and (Test-Path $DumpFile)) {
  $fileSize = (Get-Item $DumpFile).Length
  Write-Host "Export successful: $DumpFile ($([math]::Round($fileSize / 1KB, 2)) KB)" -ForegroundColor Green
} else {
  Write-Host "pg_dump encountered an issue or was not found in PATH." -ForegroundColor Red
}

Write-Host "`n[2/2] Import into CockroachDB:" -ForegroundColor Yellow
Write-Host "      cockroach sql --insecure --host=${CrHost}:${CrPort} --database=${CrDb} < $DumpFile"
Write-Host "      OR"
Write-Host "      psql `"postgresql://${CrUser}@${CrHost}:${CrPort}/${CrDb}?sslmode=disable`" -f $DumpFile"
Write-Host "======================================================" -ForegroundColor Cyan
