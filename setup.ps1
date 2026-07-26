# SplitLLM V2 — Windows setup.
# Installs Ollama if missing, starts it, pulls the default model, installs npm deps.
# Everything stays in this one folder — no Docker, no build step.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = 'Stop'
$Model = if ($env:SPLITLLM_MODEL) { $env:SPLITLLM_MODEL } else { 'huihui_ai/qwen3.5-abliterated:4B' }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# 1. Node 24+ — the app runs TypeScript via Node's built-in type stripping.
Write-Step "Checking Node.js"
$nodeOk = $false
try {
  $v = (node --version) -replace '^v', ''
  if ([int]($v.Split('.')[0]) -ge 24) { $nodeOk = $true; Write-Host "node v$v" }
} catch {}
if (-not $nodeOk) {
  Write-Host "Node.js 24+ is required." -ForegroundColor Red
  Write-Host "Install it with:  winget install OpenJS.NodeJS   then re-run this script."
  exit 1
}

# 2. Ollama
Write-Step "Checking Ollama"
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "Ollama not found — installing via winget..."
  winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
  # Refresh PATH for this session so we can find ollama.exe.
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Ollama installed but is not on PATH yet — open a new terminal and re-run this script." -ForegroundColor Red
    exit 1
  }
}
ollama --version

# 3. Make sure the Ollama server answers, start it if not.
Write-Step "Ensuring Ollama is running"
$up = $false
try { Invoke-RestMethod -Uri http://localhost:11434/api/tags -TimeoutSec 3 | Out-Null; $up = $true } catch {}
if (-not $up) {
  Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    Start-Sleep -Seconds 1
    try { Invoke-RestMethod -Uri http://localhost:11434/api/tags -TimeoutSec 2 | Out-Null; $up = $true } catch {}
  }
}
if (-not $up) {
  Write-Host "Ollama did not start — open the Ollama app once, then re-run this script." -ForegroundColor Red
  exit 1
}

# 4. The model the CLI defaults to. Override with: $env:SPLITLLM_MODEL = 'qwen3:4b'
Write-Step "Pulling model $Model (multi-GB on first run)"
ollama pull $Model

# 5. npm dependencies (only used for tests/build; the CLI itself needs none).
Write-Step "Installing npm dependencies"
npm install

Write-Step "Done. Start the CLI with:  .\splitllm.cmd"
