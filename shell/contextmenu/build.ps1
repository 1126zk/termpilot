# Build the context-menu DLL, host exe, and signed sparse package.
# Output: internal/app/resources/shell (embedded into TermPilot.exe).
# The private key stays in shell/contextmenu/.cert and is gitignored.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$out = Join-Path $root 'internal\app\resources\shell'
New-Item -ItemType Directory -Force -Path $out | Out-Null

function Find-KitTool([string]$name) {
    $bin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (-not (Test-Path $bin)) { throw "Windows SDK not found: $bin" }
    $hit = Get-ChildItem $bin -Directory | Where-Object { $_.Name -match '^10\.' } | Sort-Object Name -Descending | ForEach-Object {
        $path = Join-Path $_.FullName "x64\$name"
        if (Test-Path $path) { $path }
    } | Select-Object -First 1
    if (-not $hit) { throw "tool not found: $name" }
    return $hit
}

Write-Host "compile dll"
& gcc -shared -O2 -std=c11 -Wall -Wextra -DUNICODE -D_UNICODE `
    -o (Join-Path $out 'TermPilotContextMenu.dll') `
    (Join-Path $here 'command.c') `
    (Join-Path $here 'exports.def') `
    -lole32 -lshell32 -loleaut32 -luuid -lshlwapi -luser32
if ($LASTEXITCODE -ne 0) { throw 'dll compile failed' }

Write-Host "compile host"
& gcc -O2 -std=c11 -Wall -Wextra -DUNICODE -D_UNICODE -municode -mwindows `
    -o (Join-Path $out 'TermPilotShellHost.exe') `
    (Join-Path $here 'host.c') `
    -lshell32 -lshlwapi -luser32
if ($LASTEXITCODE -ne 0) { throw 'host compile failed' }

$deps = & objdump -p (Join-Path $out 'TermPilotContextMenu.dll') | Select-String 'DLL Name:'
$bad = $deps | Where-Object { $_.Line -match 'libstdc|libgcc|libwinpthread|mingw' }
if ($bad) { throw "dll depends on a non-system runtime: $($bad.Line)" }

$probe = Join-Path $env:TEMP 'termpilot-contextmenu-probe.exe'
& gcc -O2 -std=c11 -Wall -Wextra -DUNICODE -D_UNICODE `
    -o $probe (Join-Path $here 'probe.c') -lole32 -luuid -lshlwapi -lshell32
if ($LASTEXITCODE -ne 0) { throw 'probe compile failed' }
Push-Location $out
& $probe
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'dll probe failed' }

Add-Type -AssemblyName System.Drawing
function Save-Logo([string]$path, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(255, 32, 122, 140))
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}
Save-Logo (Join-Path $out 'logo_150x150.png') 150
Save-Logo (Join-Path $out 'logo_44x44.png') 44

$certDir = Join-Path $here '.cert'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$pfx = Join-Path $certDir 'termpilot.pfx'
$pwdFile = Join-Path $certDir 'password.txt'
if (-not (Test-Path $pfx)) {
    $password = [guid]::NewGuid().ToString('n')
    Set-Content -Path $pwdFile -Value $password -NoNewline -Encoding ascii
    $secure = ConvertTo-SecureString -String $password -Force -AsPlainText
    $root = New-SelfSignedCertificate -Type Custom -Subject 'CN=TermPilot Root' `
        -KeyUsage CertSign,CRLSign,DigitalSignature `
        -KeyExportPolicy Exportable -FriendlyName 'TermPilot Context Menu Root' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -TextExtension @('2.5.29.19={critical}{text}cA=true') `
        -NotAfter (Get-Date).AddYears(10)
    $signer = New-SelfSignedCertificate -Type Custom -Subject 'CN=TermPilot' `
        -KeyUsage DigitalSignature `
        -KeyExportPolicy Exportable -FriendlyName 'TermPilot Context Menu' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -Signer $root `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
        -NotAfter (Get-Date).AddYears(5)
    Export-PfxCertificate -Cert $signer -FilePath $pfx -Password $secure -ChainOption BuildChain | Out-Null
    Export-Certificate -Cert $root -FilePath (Join-Path $certDir 'root.cer') -Force | Out-Null
}
$password = (Get-Content -Raw -Encoding ascii $pwdFile).Trim()
$secure = ConvertTo-SecureString -String $password -Force -AsPlainText
$collection = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
$collection.Import($pfx, $password, 'Exportable')
$cert = $collection | Where-Object { $_.Subject -eq 'CN=TermPilot' -and $_.HasPrivateKey } | Select-Object -First 1
if (-not $cert) { throw 'signing cert CN=TermPilot not found in pfx' }
Copy-Item (Join-Path $certDir 'root.cer') (Join-Path $out 'ContextMenu.cer') -Force

$layout = Join-Path $env:TEMP 'termpilot-appx-layout'
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Path $layout | Out-Null
$manifestText = Get-Content -Raw -Encoding utf8 (Join-Path $here 'AppxManifest.xml')
$manifestText = $manifestText.Replace('Publisher="CN=TermPilot"', "Publisher=`"$($cert.Subject)`"")
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $layout 'AppxManifest.xml'), $manifestText, $utf8)

$makeappx = Find-KitTool 'makeappx.exe'
$signtool = Find-KitTool 'signtool.exe'
$msix = Join-Path $out 'ContextMenu.msix'
& $makeappx pack /d $layout /p $msix /o /nv
if ($LASTEXITCODE -ne 0) { throw 'makeappx failed' }

& $signtool sign /fd SHA256 /f $pfx /p $password /sha1 $cert.Thumbprint /tr http://timestamp.digicert.com /td SHA256 $msix
if ($LASTEXITCODE -ne 0) {
    Write-Host 'timestamp failed, signing without it'
    & $signtool sign /fd SHA256 /f $pfx /p $password /sha1 $cert.Thumbprint $msix
    if ($LASTEXITCODE -ne 0) { throw 'signtool failed' }
}

Write-Host "done $out"
