param([switch]$NoBump)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$appRoot = $PSScriptRoot
$pkgPath = Join-Path $appRoot "package.json"

if (-not (Test-Path $pkgPath)) {
    throw "package.json not found in app root."
}

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$appSlug = [string]$pkg.name
$currentVersion = [string]$pkg.version

if ([string]::IsNullOrWhiteSpace($appSlug)) {
    throw "package.json name is required."
}
if ([string]::IsNullOrWhiteSpace($currentVersion)) {
    throw "package.json version is required."
}

if ($NoBump) {
    $newVersion = $currentVersion
} else {
    $parts = $currentVersion -split '\.'
    if ($parts.Count -ne 3) {
        throw "Version must be in MAJOR.MINOR.PATCH format."
    }
    $parts[2] = ([int]$parts[2] + 1).ToString()
    $newVersion = $parts -join '.'
}

$pkgRaw = Get-Content $pkgPath -Raw
$pkgRaw = $pkgRaw -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($pkgPath, $pkgRaw, $utf8NoBom)

$zipName = "$appSlug-$newVersion.zip"
$zipPath = Join-Path $appRoot $zipName
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

$bs = [char]92
$fs = [char]47

$excludePatterns = @(
    '*.zip',
    'CLAUDE.md', 'chat.log', 'ai-instructions.md', '.instructions.md',
    '.claude/*', '.qwen/*', '.sixth/*',
    'package.ps1', 'package.json', 'package-lock.json',
    'data/*.sqlite', 'data/*.sqlite3', 'data/*.db',
    'node_modules/*', 'src/*',
    'plugin.md', 'packaging.md', 'CHANGELOG.md',
    '.git/*', '.gitignore', '.vscode*'
)

function Test-Excluded {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ($RelativePath -like $pattern) {
            return $true
        }
    }
    return $false
}

$allFiles = Get-ChildItem -Path $appRoot -Recurse -File
$includedFiles = @()

foreach ($file in $allFiles) {
    $relative = [System.IO.Path]::GetRelativePath($appRoot, $file.FullName)
    $relative = $relative.Replace($bs, $fs)
    if (Test-Excluded -RelativePath $relative -Patterns $excludePatterns) {
        continue
    }
    $includedFiles += [PSCustomObject]@{
        FullName = $file.FullName
        Relative = $relative
    }
}

if ($includedFiles.Count -eq 0) {
    throw "No files to package after exclusions."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("php-app-" + [Guid]::NewGuid().ToString('N'))
$tempAppRoot = Join-Path $tempRoot $appSlug
New-Item -Path $tempAppRoot -ItemType Directory -Force | Out-Null

foreach ($item in $includedFiles) {
    $dest = Join-Path $tempAppRoot $item.Relative
    $destDir = Split-Path $dest -Parent
    if (-not (Test-Path $destDir)) {
        New-Item -Path $destDir -ItemType Directory -Force | Out-Null
    }

    # Copy bytes and strip UTF-8 BOM if present to avoid "headers already sent"
    # issues in PHP files when this is deployed to a live server.
    $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        if ($bytes.Length -gt 3) {
            $clean = New-Object byte[] ($bytes.Length - 3)
            [Array]::Copy($bytes, 3, $clean, 0, $clean.Length)
            [System.IO.File]::WriteAllBytes($dest, $clean)
        } else {
            [System.IO.File]::WriteAllBytes($dest, [byte[]]@())
        }
    } else {
        [System.IO.File]::WriteAllBytes($dest, $bytes)
    }
}

try {
    Compress-Archive -Path $tempAppRoot -DestinationPath $zipPath -CompressionLevel Optimal -Force
} finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force
    }
}

$zipEntries = [System.IO.Compression.ZipFile]::OpenRead($zipPath).Entries
try {
    $roots = @($zipEntries |
        ForEach-Object {
            $name = $_.FullName.Replace($bs, $fs)
            if ($name.Contains($fs)) {
                $name.Split($fs)[0]
            } else {
                $name
            }
        } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Sort-Object -Unique)

    if ($roots.Count -ne 1 -or $roots[0] -ne $appSlug) {
        throw "ZIP root folder integrity check failed. Expected only '$appSlug', got: $($roots -join ', ')"
    }
} finally {
    $zipEntries.Archive.Dispose()
}

$zipInfo = Get-Item $zipPath
$sizeMB = [Math]::Round($zipInfo.Length / 1MB, 2)

Write-Host "App slug: $appSlug"
Write-Host "Old version: $currentVersion"
Write-Host "New version: $newVersion"
Write-Host "ZIP: $zipName"
Write-Host "Files included: $($includedFiles.Count)"
Write-Host "Size: $sizeMB MB"
Write-Host "Path: $zipPath"
