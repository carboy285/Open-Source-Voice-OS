# Builds the Windows installer: the WPF shell (self-contained), the bundled core and a pinned Node runtime,
# packed with Inno Setup into build\installers\Murmur-<version>-windows-x64-setup.exe.
# Signing runs only when WINDOWS_CERT_PFX (base64 .pfx) and WINDOWS_CERT_PASSWORD are set.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$runtime = @{}
Get-Content "scripts/node-runtime.env" | Where-Object { $_ -match "^\s*([A-Z0-9_]+)=(.+)$" } | ForEach-Object {
    $runtime[$Matches[1]] = $Matches[2].Trim()
}
$NodeVersion = $runtime["NODE_VERSION"]
$NodeSha = $runtime["NODE_SHA256_WIN_X64"]
$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version

$Work = Join-Path $Root "build/windows"
$App = Join-Path $Work "app"
$Out = Join-Path $Root "build/installers"
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Work, $App, (Join-Path $App "core"), $Out | Out-Null

Write-Host "==> Bundling the core"
npm run --silent bundle:core
if ($LASTEXITCODE -ne 0) { throw "bundle:core failed" }

Write-Host "==> Fetching Node $NodeVersion (win-x64) and verifying checksums"
$base = "https://nodejs.org/dist/v$NodeVersion"
$zipName = "node-v$NodeVersion-win-x64.zip"
$zip = Join-Path $Work $zipName
$sums = Join-Path $Work "SHASUMS256.txt"
Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $sums -UseBasicParsing
Invoke-WebRequest -Uri "$base/$zipName" -OutFile $zip -UseBasicParsing
if (-not (Select-String -Path $sums -SimpleMatch "$NodeSha  $zipName" -Quiet)) { throw "Pinned hash for $zipName is not in SHASUMS256.txt" }
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
if ($actual -ne $NodeSha) { throw "Checksum mismatch for $zipName" }
Expand-Archive -Path $zip -DestinationPath $Work -Force
$nodeDir = Join-Path $Work "node-v$NodeVersion-win-x64"
Copy-Item (Join-Path $nodeDir "node.exe") (Join-Path $App "core/node.exe")
Copy-Item (Join-Path $nodeDir "LICENSE") (Join-Path $App "core/NODE-LICENSE.txt")

Write-Host "==> Publishing the WPF shell (self-contained)"
dotnet publish native/windows/Murmur/Murmur.csproj -c Release -r win-x64 --self-contained true -p:Version=$Version -o $App
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

Copy-Item build/core/murmur-core.mjs (Join-Path $App "core/murmur-core.mjs")
if (Test-Path build/core/murmur-core.mjs.LEGAL.txt) { Copy-Item build/core/murmur-core.mjs.LEGAL.txt (Join-Path $App "core/THIRD-PARTY.txt") }
Copy-Item LICENSE (Join-Path $App "LICENSE.txt")
Copy-Item NOTICE (Join-Path $App "NOTICE.txt")
Set-Content -Path (Join-Path $App "murmur.cmd") -Encoding ascii -Value '@"%~dp0core\node.exe" --disable-warning=ExperimentalWarning "%~dp0core\murmur-core.mjs" %*'

$signing = $env:WINDOWS_CERT_PFX -and $env:WINDOWS_CERT_PASSWORD
$pfx = Join-Path $Work "cert.pfx"
function Find-SignTool {
    $kits = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\" } | Sort-Object FullName -Descending
    if (-not $kits) { throw "signtool.exe not found" }
    return $kits[0].FullName
}
function Sign-File([string]$path) {
    & $script:SignTool sign /f $pfx /p $env:WINDOWS_CERT_PASSWORD /fd sha256 /tr http://timestamp.digicert.com /td sha256 $path
    if ($LASTEXITCODE -ne 0) { throw "Signing failed for $path" }
}
if ($signing) {
    Write-Host "==> Signing the app"
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX))
    $script:SignTool = Find-SignTool
    Sign-File (Join-Path $App "Murmur.exe")
} else {
    Write-Host "    WINDOWS_CERT_PFX is not set: building an unsigned installer"
}

Write-Host "==> Building the installer"
$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) {
    choco install innosetup -y --no-progress | Out-Null
}
if (-not (Test-Path $iscc)) { throw "Inno Setup (ISCC.exe) is not installed" }
& $iscc "/DAppVersion=$Version" "/DSourceDir=$App" "/DOutputDir=$Out" installer/windows/murmur.iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }

$setup = Join-Path $Out "Murmur-$Version-windows-x64-setup.exe"
if ($signing) {
    Sign-File $setup
    Remove-Item $pfx -Force
}
Write-Host "==> Done: $setup"
