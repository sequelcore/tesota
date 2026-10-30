# Installs tesota on Windows from its GitHub Releases (#372), or updates it when run again:
#
#   irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1))) 0.1.0-alpha.1
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1))) dafny
#
# With no version it installs the newest release, prereleases included. It picks the binary for this system,
# checks it against the release's SHA256SUMS before installing it, puts it in TESOTA_INSTALL_DIR
# (~\.tesota\bin unless set), and adds that folder to your user PATH. TESOTA_DOWNLOAD replaces the release's
# download address, so CI installs the files it has just built. Runs in Windows PowerShell 5.1 and PowerShell 7.
#
# With `dafny` it installs Dafny 4.11.0 instead: Dafny's own self-contained release, which needs no .NET,
# checked against the SHA-256 below, in ~\.tesota\tools\dafny, which it adds to your user PATH.
param([string]$Version = $env:TESOTA_VERSION)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repository = 'sequelcore/tesota'
$installDir = if ($env:TESOTA_INSTALL_DIR) { $env:TESOTA_INSTALL_DIR } else { Join-Path $HOME '.tesota\bin' }

# Adds a folder to the user PATH as the registry holds it, unexpanded, so entries such as %USERPROFILE%\bin are
# written back as they were, and in the kind it has (REG_EXPAND_SZ when there is none yet).
function Add-UserPath([string]$folder, [string]$program) {
  $environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $userPath = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (-not (@($userPath -split ';') -contains $folder)) {
      $kind = if ($environment.GetValueNames() -contains 'Path') { $environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $environment.SetValue('Path', (@($folder) + @($userPath -split ';' | Where-Object { $_ })) -join ';', $kind)
      # Tells Explorer, and the terminals it starts, that the environment changed.
      if (-not ('Tesota.Environment' -as [type])) {
        Add-Type -Namespace Tesota -Name Environment -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
      }
      $result = [UIntPtr]::Zero
      [void][Tesota.Environment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
      Write-Host "Added $folder to your user PATH; open a new terminal to use $program."
    }
  } finally {
    $environment.Dispose()
  }
  if (-not (@($env:Path -split ';') -contains $folder)) { $env:Path = "$folder;$env:Path" }
}

$arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'

if ($Version -eq 'dafny') {
  $dafnyVersion = '4.11.0'
  # The digest from the release's own asset list. Dafny publishes no Windows arm64 build.
  if ($arm) { throw "tesota install: Dafny $dafnyVersion has no build for Windows on ARM; install Dafny 4 yourself from https://dafny.org" }
  $asset = "dafny-$dafnyVersion-x64-windows-2022.zip"
  $url = "https://github.com/dafny-lang/dafny/releases/download/v$dafnyVersion/$asset"
  $tools = Join-Path $HOME '.tesota\tools'
  $folder = Join-Path $tools 'dafny'
  New-Item -ItemType Directory -Force $tools | Out-Null
  $work = Join-Path $tools ".dafny.$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory $work | Out-Null
  try {
    Write-Host "Downloading Dafny $dafnyVersion from $url"
    Invoke-WebRequest -UseBasicParsing $url -OutFile "$work\dafny.zip"
    $actual = (Get-FileHash -Algorithm SHA256 "$work\dafny.zip").Hash.ToLowerInvariant()
    if ($actual -ne '3653f05a111ca21e234709ea7b25ce96083fd6c6f10484256ba54110dbc0654d') { throw "tesota install: $asset does not match its checksum, so it was not installed" }
    Expand-Archive "$work\dafny.zip" $work
    if (Test-Path $folder) { Remove-Item -Recurse -Force $folder }
    Move-Item "$work\dafny" $folder
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
  Write-Host "Installed Dafny $(& "$folder\Dafny.exe" --version) in $folder"
  Add-UserPath $folder 'dafny'
  return
}

$target = if ($arm) { 'windows-arm64' } else { 'windows-x64' }
if (-not $arm) {
  # x64 processors without AVX2 (feature 40) run the baseline build.
  if (-not ('Tesota.Cpu' -as [type])) { Add-Type -Namespace Tesota -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);' }
  if (-not [Tesota.Cpu]::IsProcessorFeaturePresent(40)) { $target = "$target-baseline" }
}

if ($env:TESOTA_DOWNLOAD) {
  $download = $env:TESOTA_DOWNLOAD
} else {
  if (-not $Version) {
    $newest = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repository/releases?per_page=1"
    if (-not $newest) { throw "tesota install: could not find the newest release of $repository" }
    $Version = @($newest)[0].tag_name
  }
  $download = "https://github.com/$repository/releases/download/v$($Version.TrimStart('v'))"
}

New-Item -ItemType Directory -Force $installDir | Out-Null
$program = Join-Path $installDir 'tesota.exe'
# Downloaded beside the install folder's tesota.exe, so the move that installs it is a rename.
$work = Join-Path $installDir ".download.$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $work | Out-Null
try {
  Write-Host "Downloading tesota-$target.exe from $download"
  Invoke-WebRequest -UseBasicParsing "$download/SHA256SUMS" -OutFile "$work\SHA256SUMS"
  Invoke-WebRequest -UseBasicParsing "$download/tesota-$target.exe" -OutFile "$work\tesota.exe"
  $listed = Get-Content "$work\SHA256SUMS" | Where-Object { $_ -match "^([0-9a-f]{64}) [ *]tesota-$([regex]::Escape($target))\.exe$" } | Select-Object -First 1
  if (-not $listed) { throw "tesota install: SHA256SUMS lists no tesota-$target.exe" }
  $expected = $listed.Substring(0, 64)
  $actual = (Get-FileHash -Algorithm SHA256 "$work\tesota.exe").Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "tesota install: tesota-$target.exe does not match its checksum, so it was not installed" }
  # Windows will not replace a running program but will rename it, so a tesota already running keeps its file.
  if (Test-Path $program) {
    Remove-Item -Force "$program.old" -ErrorAction SilentlyContinue
    Move-Item -Force $program "$program.old"
  }
  Move-Item "$work\tesota.exe" $program
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
Remove-Item -Force "$program.old" -ErrorAction SilentlyContinue
Write-Host "Installed tesota $(& $program --version) in $installDir"
Add-UserPath $installDir 'tesota'
