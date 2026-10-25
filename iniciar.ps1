# Abre un túnel SSH hacia el PostgreSQL del servidor y arranca el visor.
# El puerto 5432 del servidor está cerrado a internet; la conexión viaja
# cifrada por SSH y PostgreSQL se ve en este equipo como 127.0.0.1:<puerto local>.
# Uso: .\iniciar.ps1   (desde C:\Proyectos\DRONES)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
    Write-Host "Falta el archivo .env. Copia .env.example a .env y complétalo." -ForegroundColor Red
    exit 1
}

$cfg = @{}
foreach ($line in Get-Content ".env") {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}

$sshHost   = $cfg["DRONES_SSH_HOST"]
$sshUser   = $cfg["DRONES_SSH_USER"]
$sshKey    = $cfg["DRONES_SSH_KEY"] -replace '^~', $HOME
$localPort = if ($cfg["DRONES_PGPORT"]) { $cfg["DRONES_PGPORT"] } else { "5433" }

if (-not $sshHost -or -not $sshUser) {
    Write-Host "Configura DRONES_SSH_HOST y DRONES_SSH_USER en .env." -ForegroundColor Red
    exit 1
}

$sshArgs = @("-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
             "-L", "${localPort}:127.0.0.1:5432")
if ($sshKey) { $sshArgs += @("-i", $sshKey) }
$sshArgs += "$sshUser@$sshHost"

Write-Host "Abriendo túnel SSH $sshUser@$sshHost (local $localPort -> servidor 5432)..."
$tunnel = Start-Process ssh -ArgumentList $sshArgs -PassThru -NoNewWindow

# Esperar a que el puerto local responda
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
    if ($tunnel.HasExited) { break }
    if ((Test-NetConnection 127.0.0.1 -Port $localPort -WarningAction SilentlyContinue).TcpTestSucceeded) { $ok = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ok) {
    Write-Host "No se pudo abrir el túnel SSH. Revisa usuario, clave y acceso al servidor." -ForegroundColor Red
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id }
    exit 1
}

Write-Host "Túnel listo. Visor en http://127.0.0.1:5000 (Ctrl+C para salir)" -ForegroundColor Green
try {
    python server.py
}
finally {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id }
    Write-Host "Túnel SSH cerrado."
}
