
# WordPress Plugin Packaging Instructions

Use these instructions whenever asked to package, release, or version-bump a WordPress plugin.

---

## What to do

1. Create `package.json` if missing (first run only)
2. Create `package.ps1` if missing (first run only)
3. Bump the patch version in all version-bearing files
4. Sync the version across every file that holds it
5. Run `package.ps1` to create the distributable ZIP

---

## Step 0 — Create missing files on first run

### If `package.json` is missing

Create a minimal one in the plugin root. Starting version is always `0.0.1` (alpha). The developer manually bumps to `1.0.0` when the plugin is considered release-ready.

```json
{
  "name": "plugin-slug-here",
  "version": "0.0.1"
}
```

Derive the slug from the plugin folder name or the `Plugin Name:` value in the main PHP file (lowercase, hyphens instead of spaces).

### If `package.ps1` is missing

Create it using the reference implementation in the **"If `package.ps1` is missing"** section below. It is fully generic — no values need to be changed per project.

---

## Versioning convention

| Range | Stage | Meaning |
|---|---|---|
| `0.0.x` | Alpha / Canary | Active development, not ready for production |
| `0.x.x` | Beta | Feature-complete but still being tested |
| `1.0.0`+ | Release | Developer has signed off as production-ready |

Always start new projects at `0.0.1`. Never auto-bump to `1.0.0` — only do that when explicitly asked.

---

## Step 1 — Find the current version

Read `package.json` in the plugin root. The `"version"` field is the **source of truth**.

```json
{
  "name": "my-plugin-slug",
  "version": "0.0.4"
}
```

---

## Step 2 — Bump the patch version

Increment only the **last** number (`MAJOR.MINOR.PATCH`):

```
0.0.3  →  0.0.4
0.1.9  →  0.1.10
1.0.3  →  1.0.4
```

Never bump minor or major automatically — only do that when explicitly asked.
Never auto-bump from `0.x.x` to `1.0.0` — that is a deliberate developer decision.

---

## Step 3 — Sync the new version to every file

Update **all** of the following in one pass. Do not leave any file out of sync.

| File | What to update |
|---|---|
| `package.json` | `"version": "x.x.x"` |
| Main plugin `.php` file | ` * Version: x.x.x` inside the plugin header comment block |
| Main plugin `.php` file | `define( 'PLUGIN_VERSION', 'x.x.x' )` constant (if present) |
| `readme.txt` | `Stable tag: x.x.x` line (only if the file exists) |
| `CHANGELOG.md` | Prepend `## [x.x.x] - YYYY-MM-DD` with today's date (only if the file exists) |

Use targeted replacements — do not rewrite files from scratch.

The main PHP file is identified by containing `Plugin Name:` in its header comment block.

---

## Step 4 — Run the package script

```powershell
cd "<plugin-root>"
.\package.ps1
```

To skip the version bump and re-package the current version:

```powershell
.\package.ps1 -NoBump
```

### What `package.ps1` does

- Reads the plugin slug and version from `package.json` automatically
- Removes any existing ZIP for the same version before creating a new one
- Adds all included files under `<slug>/` as the ZIP root folder (required for WordPress)
- Verifies that the ZIP has exactly one root folder matching the plugin slug
- Reports file count, size, and full path on success

### Files excluded from the ZIP

```
*.zip
CLAUDE.md  chat.log  ai-instructions.md  .instructions.md
.claude/  .qwen/  .sixth/
package.ps1  package.json  package-lock.json
webpack.config.js  node_modules/  src/
plugin.md  packaging.md  CHANGELOG.md
.git/  .gitignore  .vscode*/
```

Runtime docs (`README.md`, `readme.txt`) **are** included.

---

## Step 5 — Confirm and report

Tell the user:
- Old version → new version
- ZIP filename
- File count and size
- Full path to the ZIP file

---

## If `package.ps1` is missing or hardcodes the version

Rewrite it to match this pattern — the script must read slug and version from `package.json`, not hardcode them:

```powershell
param([switch]$NoBump)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Read slug and version from package.json
$pkg = Get-Content (Join-Path $PSScriptRoot "package.json") -Raw | ConvertFrom-Json
$pluginSlug  = $pkg.name
$currentVersion = $pkg.version

# Bump patch version
if ($NoBump) {
    $newVersion = $currentVersion
} else {
    $parts = $currentVersion -split '\.'
    $parts[2] = [int]$parts[2] + 1
    $newVersion = $parts -join '.'
}

# Sync package.json
$pkgRaw = Get-Content (Join-Path $PSScriptRoot "package.json") -Raw
$pkgRaw = $pkgRaw -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "package.json"), $pkgRaw, [System.Text.Encoding]::UTF8)

# Sync PHP plugin header and version constant
$phpMain = Get-ChildItem -Path $PSScriptRoot -Filter "*.php" -File |
    Where-Object { (Get-Content $_.FullName -Raw) -match 'Plugin Name:' } |
    Select-Object -First 1

if ($phpMain) {
    $php = Get-Content $phpMain.FullName -Raw
    $php = $php -replace '(?m)^(\s*\*\s*Version:\s*)[\d.]+', "`${1}$newVersion"
    $php = $php -replace "(define\(\s*'[A-Z_]+VERSION',\s*')[^']+(')", "`${1}$newVersion`${2}"
    [System.IO.File]::WriteAllText($phpMain.FullName, $php, [System.Text.Encoding]::UTF8)
}

# Sync readme.txt Stable tag
$readmePath = Join-Path $PSScriptRoot "readme.txt"
if (Test-Path $readmePath) {
    $r = Get-Content $readmePath -Raw
    $r = $r -replace '(?m)^(Stable tag:\s*)[\d.]+', "`${1}$newVersion"
    [System.IO.File]::WriteAllText($readmePath, $r, [System.Text.Encoding]::UTF8)
}

# Prepend CHANGELOG.md entry
$clPath = Join-Path $PSScriptRoot "CHANGELOG.md"
if (Test-Path $clPath) {
    $today = Get-Date -Format "yyyy-MM-dd"
    $entry = "## [$newVersion] - $today`n`n- (describe changes here)`n`n"
    $existing = Get-Content $clPath -Raw
    if ($existing -notmatch [regex]::Escape("## [$newVersion]")) {
        [System.IO.File]::WriteAllText($clPath, $entry + $existing, [System.Text.Encoding]::UTF8)
    }
}

# Create ZIP (excluded patterns, single root folder, integrity check)
# ... (full ZIP logic as per the project's existing package.ps1)
```

---

## Checklist before marking done

- [ ] `package.json` exists (created at `0.0.1` if new project)
- [ ] `package.ps1` exists (created from reference implementation if new project)
- [ ] `package.json` version is bumped
- [ ] PHP plugin header `Version:` matches new version
- [ ] PHP `*_VERSION` constant matches (if present)
- [ ] `readme.txt` `Stable tag:` matches (if present)
- [ ] `CHANGELOG.md` has new entry at top with today's date (if present)
- [ ] ZIP created with no errors
- [ ] ZIP verified: single root folder equals the plugin slug
- [ ] Output reported to user (version, filename, size, path)
