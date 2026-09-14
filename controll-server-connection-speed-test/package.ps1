param([switch]$NoBump)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$pluginRoot = $PSScriptRoot
$pkgPath = Join-Path $pluginRoot "package.json"

if (-not (Test-Path $pkgPath)) {
    throw "package.json not found in plugin root."
}

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pluginSlug = [string]$pkg.name
$currentVersion = [string]$pkg.version

if ([string]::IsNullOrWhiteSpace($pluginSlug)) {
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

$pkgRaw = Get-Content $pkgPath -Raw -Encoding UTF8
$pkgRaw = $pkgRaw -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($pkgPath, $pkgRaw, $utf8NoBom)

$phpMain = Get-ChildItem -Path $pluginRoot -Filter "*.php" -File |
    Where-Object { (Get-Content $_.FullName -Raw -Encoding UTF8) -match 'Plugin Name:' } |
    Select-Object -First 1

if ($null -ne $phpMain) {
    $php = Get-Content $phpMain.FullName -Raw -Encoding UTF8
    $php = $php -replace '(?m)^(\s*\*\s*Version:\s*)[\d.]+', "`${1}$newVersion"
    $php = $php -replace "(define\(\s*'[A-Z_]+VERSION',\s*')[^']+(')", "`${1}$newVersion`${2}"
    [System.IO.File]::WriteAllText($phpMain.FullName, $php, $utf8NoBom)
}

$readmePath = Join-Path $pluginRoot "readme.txt"
if (Test-Path $readmePath) {
    $readme = Get-Content $readmePath -Raw -Encoding UTF8
    $readme = $readme -replace '(?m)^(Stable tag:\s*)[\d.]+', "`${1}$newVersion"
    [System.IO.File]::WriteAllText($readmePath, $readme, $utf8NoBom)
}

$changelogPath = Join-Path $pluginRoot "CHANGELOG.md"
if (Test-Path $changelogPath) {
    $today = Get-Date -Format "yyyy-MM-dd"
    $entry = "## [$newVersion] - $today`n`n- (describe changes here)`n`n"
    $existing = Get-Content $changelogPath -Raw -Encoding UTF8
    if ($existing -notmatch [regex]::Escape("## [$newVersion]")) {
        [System.IO.File]::WriteAllText($changelogPath, $entry + $existing, $utf8NoBom)
    }
}

$zipName = "$pluginSlug-$newVersion.zip"
$zipPath = Join-Path $pluginRoot $zipName
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

$excludePatterns = @(
    '*.zip',
    'CLAUDE.md', 'chat.log', 'ai-instructions.md', '.instructions.md',
    '.claude/*', '.qwen/*', '.sixth/*',
    'package.ps1', 'package.json', 'package-lock.json',
    'keep-alive.ps1', 'keep-alive.log',
    'webpack.config.js', 'node_modules/*', 'src/*',
    'plugin.md', 'packaging.md', 'CHANGELOG.md', 'TODO-diagnostics.md',
    'raw-ping.key',
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

$allFiles = Get-ChildItem -Path $pluginRoot -Recurse -File
$includedFiles = @()

$pluginRootUri = New-Object System.Uri(($pluginRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar))

foreach ($file in $allFiles) {
    # [System.IO.Path]::GetRelativePath doesn't exist in the .NET Framework
    # that Windows PowerShell 5.1 runs on (only .NET Core/5+) — Uri-based
    # relative-path computation works on both.
    $fileUri = New-Object System.Uri($file.FullName)
    $relative = [System.Uri]::UnescapeDataString($pluginRootUri.MakeRelativeUri($fileUri).ToString())
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

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Written entry-by-entry with an explicitly forward-slash entry name, rather
# than via Compress-Archive or ZipFile.CreateFromDirectory against a temp
# copy of the files: both of those write backslash path separators inside
# the ZIP on this .NET Framework runtime (a long-standing, still-unfixed
# quirk of Windows PowerShell 5.1, not something later fixed in .NET Core) —
# which violates the ZIP spec and isn't what WordPress or the root-folder
# check just below expects (it makes e.g. 'plugin-slug\assets\' look like
# its own separate "root"). Controlling the entry name ourselves sidesteps
# the question of what separator any given helper feels like using.
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($item in $includedFiles) {
            # Strip a UTF-8 BOM if present to avoid "headers already sent"
            # issues in PHP files after plugin installation.
            $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
            if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
                if ($bytes.Length -gt 3) {
                    $clean = New-Object byte[] ($bytes.Length - 3)
                    [Array]::Copy($bytes, 3, $clean, 0, $clean.Length)
                    $bytes = $clean
                } else {
                    $bytes = [byte[]]@()
                }
            }

            $entryName = "$pluginSlug/$($item.Relative)"
            $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $entryStream.Write($bytes, 0, $bytes.Length)
            } finally {
                $entryStream.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
    }
} finally {
    $zipStream.Dispose()
}

$zipEntries = [System.IO.Compression.ZipFile]::OpenRead($zipPath).Entries
try {
    $roots = @($zipEntries |
        ForEach-Object {
            $name = $_.FullName.Replace('\\', '/')
            if ($name.Contains('/')) {
                $name.Split('/')[0]
            } else {
                $name
            }
        } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Sort-Object -Unique)

    if ($roots.Count -ne 1 -or $roots[0] -ne $pluginSlug) {
        throw "ZIP root folder integrity check failed. Expected only '$pluginSlug', got: $($roots -join ', ')"
    }
} finally {
    $zipEntries.Archive.Dispose()
}

$zipInfo = Get-Item $zipPath
$sizeMB = [Math]::Round($zipInfo.Length / 1MB, 2)

Write-Host "Plugin slug: $pluginSlug"
Write-Host "Old version: $currentVersion"
Write-Host "New version: $newVersion"
Write-Host "ZIP: $zipName"
Write-Host "Files included: $($includedFiles.Count)"
Write-Host "Size: $sizeMB MB"
Write-Host "Path: $zipPath"
