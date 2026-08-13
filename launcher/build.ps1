param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin')
)

$ErrorActionPreference = 'Stop'

function Find-CSharpCompiler {
  $roots = @($env:WINDIR, $env:SystemRoot) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
  foreach ($root in $roots) {
    foreach ($relativePath in @('Microsoft.NET\Framework64\v4.0.30319\csc.exe', 'Microsoft.NET\Framework\v4.0.30319\csc.exe')) {
      $candidate = Join-Path $root $relativePath
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  throw 'The .NET Framework C# compiler was not found. Run this script on Windows with .NET Framework 4.x installed.'
}

$compiler = Find-CSharpCompiler
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$targets = @(
  @{ Source = 'CardRenderer.cs'; Output = 'CardRenderer.exe'; References = @('System.Drawing.dll', 'System.Windows.Forms.dll') },
  @{ Source = 'ContentOpsLauncher.cs'; Output = '图文爆款Agent.exe'; References = @('System.Windows.Forms.dll') },
  @{ Source = 'ContentOpsWatchdog.cs'; Output = 'ContentOpsWatchdog-v2.exe'; References = @() }
)

foreach ($target in $targets) {
  $source = Join-Path $PSScriptRoot $target.Source
  $output = Join-Path $outputRoot $target.Output
  $arguments = @('/nologo', '/target:winexe', "/out:$output")
  foreach ($reference in $target.References) { $arguments += "/r:$reference" }
  $arguments += $source
  & $compiler @arguments
  if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $($target.Source)" }
}

Write-Output "Built Windows launchers in $outputRoot"
