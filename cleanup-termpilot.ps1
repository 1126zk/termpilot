# Clean local TermPilot data and context-menu registration.
# Does not remove the code-signing private key in Cert:\CurrentUser\My.
param([switch]$CertsOnly)

$ErrorActionPreference = 'Stop'

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Remove-TermPilotCerts([string]$scope) {
    foreach ($storeName in @('Root', 'TrustedPeople')) {
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, $scope)
        $store.Open('ReadWrite')
        try {
            $seen = @{}
            $found = @($store.Certificates | Where-Object { $_.Subject -match 'TermPilot' })
            if ($found.Count -eq 0) {
                Write-Output "none $scope\$storeName"
                continue
            }
            foreach ($cert in $found) {
                # The same cert can show up twice. Removing the second copy throws.
                if ($seen.ContainsKey($cert.Thumbprint)) { continue }
                $seen[$cert.Thumbprint] = $true
                try {
                    $store.Remove($cert)
                    Write-Output "removed $scope\$storeName $($cert.Thumbprint) $($cert.Subject)"
                } catch {
                    Write-Output "skip $scope\$storeName $($cert.Thumbprint) $($_.Exception.Message)"
                }
            }
        } finally {
            $store.Close()
        }
    }
}

if (-not $CertsOnly) {
    Get-Process TermPilot -ErrorAction SilentlyContinue | Stop-Process -Force

    $packages = @(Get-AppxPackage -Name 'TermPilot.ContextMenu' -ErrorAction SilentlyContinue)
    if ($packages.Count -gt 0) {
        $packages | Remove-AppxPackage
        Write-Output 'removed package TermPilot.ContextMenu'
    } else {
        Write-Output 'package not installed'
    }

    $dirs = @(
        (Join-Path $env:APPDATA 'TermPilot'),
        (Join-Path $env:APPDATA 'termpilot')
    )
    $explorerStopped = $false
    foreach ($dir in $dirs) {
        if (-not (Test-Path $dir)) { continue }
        try {
            Remove-Item $dir -Recurse -Force
        } catch {
            if (-not $explorerStopped) {
                Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 400
                Stop-Process -Name dllhost -Force -ErrorAction SilentlyContinue
                $explorerStopped = $true
            }
            Remove-Item $dir -Recurse -Force
        }
        Write-Output "removed $dir"
    }
    if ($explorerStopped) { Start-Process explorer.exe }

    $stray = Join-Path $env:APPDATA 'TermPilot.exe'
    if (Test-Path -LiteralPath $stray -PathType Leaf) {
        Remove-Item -LiteralPath $stray -Force
        Write-Output "removed $stray"
    }

    $bin = Join-Path $env:APPDATA 'TermPilot\bin'
    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($path) {
        $norm = $bin.TrimEnd('\')
        $items = New-Object System.Collections.Generic.List[string]
        foreach ($item in $path.Split(';')) {
            if (-not $item) { continue }
            if ($item.TrimEnd('\').Equals($norm, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $items.Add($item)
        }
        [Environment]::SetEnvironmentVariable('Path', ($items -join ';'), 'User')
        Write-Output "removed PATH $norm"
    }

    Remove-TermPilotCerts 'CurrentUser'
}

if (Test-Admin) {
    Remove-TermPilotCerts 'LocalMachine'
    Write-Output 'done'
} elseif (-not $CertsOnly) {
    try {
        Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-CertsOnly'
        )
    } catch {
        Write-Output "machine certs were not removed: $($_.Exception.Message)"
        exit 1
    }
    Write-Output 'done'
}
