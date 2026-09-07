#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for the body scale service on Windows.

.DESCRIPTION
  Creates a private Python virtual environment beside this script and installs
  bleak into it. The service finds .venv\Scripts\python.exe on its own, so
  nothing needs to be added to PATH and no system Python is modified.

  Safe to run repeatedly.

.PARAMETER Embed
  Also download the official Windows embeddable Python and install bleak into
  it, at python\. Use this when you intend to ship the app to machines that
  may not have Python at all. Roughly 25 MB on disk.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup-win.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup-win.ps1 -Embed
#>
[CmdletBinding()]
param([switch]$Embed)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EmbedVersion = '3.11.9'

function Say  ($m) { Write-Host "  $m" }
function Good ($m) { Write-Host "  $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host ""; Write-Host "  $m" -ForegroundColor Red; Write-Host ""; exit 1 }

Write-Host ""
Write-Host "  Body scale service - Windows setup" -ForegroundColor Cyan
Write-Host "  $Root"
Write-Host ""

# ---------------------------------------------------------------- 1. Windows
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
Say "Windows build $build"
if ($build -lt 16299) {
  Die "Windows 10 build 16299 (Fall Creators Update) or later is required. This machine is $build, whose Bluetooth API cannot reach a BLE scale."
}

# ------------------------------------------------------------------- 2. Node
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nv = (& node --version) -replace '^v',''
  if ([int]($nv -split '\.')[0] -lt 18) { Warn "Node $nv found, but 18+ is needed to run scale.js standalone." }
  else { Good "Node $nv" }
} else {
  Warn "Node.js not found on PATH."
  Warn "That is fine if you only run this inside Electron, which supplies its own Node."
  Warn "To use the command line directly, install Node 18+ from https://nodejs.org"
}

# ----------------------------------------------------------------- 3. Python
$py = $null
foreach ($probe in @(
    @{ Cmd = 'py';     Sw = @('-3') },
    @{ Cmd = 'python'; Sw = @() })) {
  $cmd = Get-Command $probe.Cmd -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  try { $out = & $probe.Cmd @($probe.Sw + @('--version')) 2>&1 } catch { continue }
  if ($out -match '(\d+)\.(\d+)\.(\d+)') {
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    if ($major -eq 3 -and $minor -ge 9) {
      # Resolve the real interpreter and use THAT from here on, rather than
      # carrying the launcher and its -3 around.
      #
      # `py -3 --version` reports a version happily and then `py -3 -m venv`
      # fails with "Unknown option: -3" on some installs — the launcher passes
      # its own switch through to python.exe, which has never heard of it. The
      # previous version of this script blamed the Microsoft Store for that,
      # which sent people to reinstall a Python that was working perfectly.
      #
      # sys.executable is unambiguous, needs no switches, and is the
      # interpreter the virtual environment should be built from anyway.
      $resolved = & $probe.Cmd @($probe.Sw + @(
        '-c', 'import sys; print(sys.executable)')) 2>&1 | Select-Object -Last 1
      if ($LASTEXITCODE -eq 0 -and $resolved -and (Test-Path $resolved)) {
        $pyExe  = "$resolved".Trim()
        $pyArgs = @()
        Good "Python $($Matches[0])  $pyExe"
      } else {
        # Could not resolve it: fall back to the command as found, switches and
        # all, which is what used to happen every time.
        $pyExe  = $probe.Cmd
        $pyArgs = $probe.Sw
        Good "Python $($Matches[0])"
        Warn "Could not resolve the interpreter path; using '$($probe.Cmd)' as found."
      }
      $py = $true
      break
    }
    Warn "Found Python $($Matches[0]), which is too old. 3.9+ is required."
  }
}
if (-not $py -and -not $Embed) {
  Die @"
Python 3.9 or later was not found.

Either install it from https://www.python.org/downloads/windows/
(tick "Add python.exe to PATH" in the installer), or re-run this script
with -Embed to download a private copy that ships with your app:

    powershell -ExecutionPolicy Bypass -File setup-win.ps1 -Embed
"@
}

# ------------------------------------------------------- 4. virtual environment
if ($py) {
  $venv = Join-Path $Root '.venv'
  $venvPy = Join-Path $venv 'Scripts\python.exe'

  if (Test-Path $venvPy) {
    Say "Reusing the existing environment at .venv"
  } else {
    Say "Creating .venv"
    Say "  using $pyExe"

    # Keep what Python said. The previous version discarded it and guessed at
    # the Microsoft Store, which is one cause among several and reads as a
    # diagnosis rather than the guess it was. venv failures are specific and
    # the message almost always names the real problem.
    $venvOut = & $pyExe @($pyArgs + @('-m', 'venv', $venv)) 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) {
      $hint = ''
      if ($pyExe -match 'WindowsApps') {
        $hint = @"

This Python came from the Microsoft Store ($pyExe). The Store build runs in a
sandbox that cannot create a working virtual environment here. Install Python
from https://www.python.org/downloads/windows/ instead, ticking
"Add python.exe to PATH", then run this script again.
"@
      } elseif ($venvOut -match 'ensurepip|No module named venv') {
        $hint = @"

This Python was built without the venv or ensurepip module. On a python.org
install both are present; a stripped or embedded build has neither. Install
from python.org, or re-run with -Embed for a private copy.
"@
      } elseif ($venvOut -match 'Access is denied|PermissionError|WinError 5') {
        $hint = @"

Windows refused to write into $Root. Either the folder is read-only, or an
antivirus is blocking it, or this is a protected location such as Program
Files. Clone the repository somewhere under your user folder and try again.
"@
      } elseif ($venvOut -match 'already exists|not empty') {
        $hint = @"

A .venv folder is already there but has no python.exe in it, so a previous run
was interrupted. Delete it and run this script again:

    Remove-Item -Recurse -Force "$venv"
"@
      }

      Die @"
Could not create the virtual environment.

What Python said:
$($venvOut.Trim())$hint
"@
    }
    Good "Created .venv"
  }

  Say "Installing bleak"
  & $venvPy -m pip install --quiet --upgrade pip 2>&1 | Out-Null
  & $venvPy -m pip install --quiet --upgrade bleak
  if ($LASTEXITCODE -ne 0) { Die "pip could not install bleak. Check the network, or a proxy that intercepts TLS." }

  # bleak has no __version__ attribute; asking for one turns a working install
  # into "bleak installed but will not import", which is both wrong and alarming.
  # importlib.metadata is where the version actually lives.
  $ver = & $venvPy -c "import bleak, importlib.metadata as m; print(m.version('bleak'))" 2>&1
  if ($LASTEXITCODE -ne 0) { Die "bleak installed but will not import:`n$ver" }
  Good "bleak $ver"

  # Prove the WinRT backend actually loads. An import that works on Linux can
  # still fail here if the pythonnet/WinRT bridge is missing.
  $probe = & $venvPy -c "from bleak import BleakScanner; print('winrt backend ok')" 2>&1
  if ($LASTEXITCODE -ne 0) { Die "The Windows Bluetooth backend failed to load:`n$probe" }
  Good "Windows Bluetooth backend loads"
}

# ------------------------------------------------------- 5. embeddable Python
if ($Embed) {
  $target = Join-Path $Root 'python'
  if (Test-Path (Join-Path $target 'python.exe')) {
    Say "Reusing the embedded runtime at python\"
  } else {
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { 'win32' }
    $url  = "https://www.python.org/ftp/python/$EmbedVersion/python-$EmbedVersion-embed-$arch.zip"
    $zip  = Join-Path $env:TEMP "python-embed-$EmbedVersion.zip"
    Say "Downloading embeddable Python $EmbedVersion ($arch)"
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    } catch { Die "Download failed: $_" }

    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Expand-Archive -Path $zip -DestinationPath $target -Force
    Remove-Item $zip -Force

    # The embeddable build ships with site-packages disabled. pip cannot work
    # until the ._pth file stops excluding it.
    Get-ChildItem -Path $target -Filter 'python*._pth' | ForEach-Object {
      (Get-Content $_.FullName) -replace '^#\s*import site', 'import site' |
        Set-Content $_.FullName
      if (-not (Select-String -Path $_.FullName -Pattern '^import site' -Quiet)) {
        Add-Content $_.FullName 'import site'
      }
    }

    $getpip = Join-Path $target 'get-pip.py'
    Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getpip -UseBasicParsing
    & (Join-Path $target 'python.exe') $getpip --quiet
    Remove-Item $getpip -Force
    Good "Embedded Python installed"
  }

  Say "Installing bleak into the embedded runtime"
  & (Join-Path $target 'python.exe') -m pip install --quiet --upgrade bleak
  if ($LASTEXITCODE -ne 0) { Die "Could not install bleak into the embedded runtime." }
  $ev = & (Join-Path $target 'python.exe') -c "import bleak; print(bleak.__version__)" 2>&1
  Good "Embedded bleak $ev"
}

# -------------------------------------------------------------- 6. permission
Write-Host ""
$svc = Get-Service -Name bthserv -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') {
  Warn "The Bluetooth Support Service is not running. Turn Bluetooth on in Settings."
}

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\bluetoothSync'
$consent = (Get-ItemProperty -Path $key -Name Value -ErrorAction SilentlyContinue).Value
if ($consent -eq 'Deny') {
  Warn "Desktop apps are currently DENIED access to Bluetooth devices."
  Warn "Turn it on: Settings > Privacy & security > Bluetooth devices >"
  Warn "  'Let desktop apps access your Bluetooth devices'"
  Warn "Without this the service reports PERMISSION_DENIED and never connects."
} elseif ($consent -eq 'Allow') {
  Good "Desktop apps may access Bluetooth devices"
}

# ------------------------------------------------------------ 7. end-to-end
Write-Host ""
Say "Running the offline end-to-end check"
if ($node) {
  $fixture = Join-Path $Root 'fixtures\ssw533-session.jsonl'
  if (Test-Path $fixture) {
    $out = & node (Join-Path $Root 'scale.js') --replay $fixture --quiet 2>$null
    try {
      $r = $out | ConvertFrom-Json
      if ($r.ok -and $r.measured.weightKg -gt 0) {
        Good "Replay produced $($r.measured.weightKg) kg and $($r.measured.impedanceOhm) ohm. The parser and the maths work on this machine."
      } else { Warn "Replay ran but produced no reading." }
    } catch { Warn "Replay output could not be parsed. Run it by hand to see why." }
  } else { Warn "Fixture missing; skipped." }
} else {
  Say "Skipped, because Node is not on PATH. Run it from inside Electron instead."
}

Write-Host ""
Good "Setup finished."
Write-Host ""
Write-Host "  Try it with the real scale (step on the scale first, then run):"
Write-Host "    node scale.js --serve" -ForegroundColor Gray
Write-Host ""
Write-Host "  Or with no hardware at all:"
Write-Host "    node scale.js --serve --replay fixtures\ssw533-session.jsonl" -ForegroundColor Gray
Write-Host ""
