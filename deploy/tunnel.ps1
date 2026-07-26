# Keep a local port forwarded to the homeserver through the VPS.
#
#   powershell -ExecutionPolicy Bypass -File deploy\tunnel.ps1
#
# Then in the CLI:
#   /endpoint add   → splitllm → 127.0.0.1:18080 → <token>
#
# Why a loop rather than a one-shot `ssh -f -N -L`: the tunnel dies whenever the
# laptop sleeps, the WireGuard peer re-handshakes, or the VPS drops the
# connection. A dead forward looks exactly like a dead backend from the client
# side — connection refused on localhost — which is a confusing way to spend an
# afternoon. This reconnects and says so.

param(
  [string]$JumpHost   = 'user@your-vps',
  [string]$KeyFile    = "$env:USERPROFILE\.ssh\your_deploy_key",
  [string]$RemoteHost = '10.0.0.2',
  [int]$RemotePort    = 8080,
  [int]$LocalPort     = 18080
)

if (-not (Test-Path $KeyFile)) {
  Write-Error "key not found: $KeyFile"
  exit 1
}

Write-Host "tunnel: localhost:$LocalPort -> $RemoteHost`:$RemotePort via $JumpHost" -ForegroundColor Cyan
Write-Host "Ctrl+C to stop`n" -ForegroundColor DarkGray

while ($true) {
  $started = Get-Date
  # -N no command, -T no tty, ExitOnForwardFailure so a port already in use
  # fails loudly instead of silently connecting with no forward at all.
  # ServerAlive* detects a half-open link that TCP would otherwise keep for
  # hours after the laptop wakes up.
  & ssh -i $KeyFile `
        -o BatchMode=yes `
        -o ExitOnForwardFailure=yes `
        -o ServerAliveInterval=20 `
        -o ServerAliveCountMax=3 `
        -N -T `
        -L "${LocalPort}:${RemoteHost}:${RemotePort}" `
        $JumpHost

  $lasted = [int]((Get-Date) - $started).TotalSeconds
  Write-Host "tunnel closed after ${lasted}s (exit $LASTEXITCODE)" -ForegroundColor Yellow

  # A connection that dies immediately is a configuration error — a wrong key,
  # a port already bound. Retrying that every 5 seconds forever just hides it.
  if ($lasted -lt 5) {
    Write-Host "died immediately; backing off 30s. Check the key, or whether port $LocalPort is already in use." -ForegroundColor Red
    Start-Sleep -Seconds 30
  } else {
    Start-Sleep -Seconds 3
  }
}
