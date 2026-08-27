# publish.ps1 — 一键打包发布 ui-cw-fileexplorer 到 dsh profile
#
# 流程：pnpm build → pnpm test → npm pack → 复制罐头到 profile/vendor
#      → 更新 profile package.json 依赖（相对路径 file:./vendor/...）
#      → pnpm install → 提示重启 dsh。
#
# 用法：
#   .\publish.ps1                    # 发布到默认正式 profile（%USERPROFILE%\.dsh\profiles\web）
#   .\publish.ps1 -ProfileDir <dir>  # 发布到指定 profile 目录
#   .\publish.cmd                    # 双击运行（等价于上面的默认用法，出错时窗口停留）
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\web"
)

$ErrorActionPreference = 'Stop'
$pluginRoot = $PSScriptRoot
# 所有 pnpm/npm 步骤都应在插件目录内执行（pnpm 按当前目录向上找 manifest）。
Push-Location $pluginRoot

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "==> $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$Name 失败（exit $LASTEXITCODE）" }
}

if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) {
    throw "找不到 profile 清单：$ProfileDir\package.json"
}

# 1. 构建 + 测试（任一失败即中止，不产出坏罐头）
Invoke-Step '构建 lib 产物' { pnpm build }
Invoke-Step '运行测试' { pnpm test }

# 2. 打包：npm pack --json 输出 [{ filename, ... }]，文件名含版本号
$packJson = npm pack --json | ConvertFrom-Json
$tgzName = $packJson[0].filename
$tgz = Join-Path $pluginRoot $tgzName
Write-Host "    打包产物：$tgzName"

# 3. 上架：清掉 vendor 里旧罐头，放入新罐头
$vendor = Join-Path $ProfileDir 'vendor'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
Get-ChildItem -Path $vendor -Filter 'dsh-plugins-ui-cw-fileexplorer-*.tgz' -ErrorAction SilentlyContinue |
    Remove-Item -Force
Copy-Item -Path $tgz -Destination $vendor
Write-Host "    已放入：$vendor\$tgzName"

# 4. 更新 profile 菜单：替换该依赖行为相对路径 tarball（正则保证任何缩进都能命中）
$manifest = Join-Path $ProfileDir 'package.json'
$text = [System.IO.File]::ReadAllText($manifest)
if ($text -notmatch '"@dsh-plugins/ui-cw-fileexplorer"') {
    throw "profile 清单里没有 @dsh-plugins/ui-cw-fileexplorer 依赖行，请先手动加上"
}
$text = [regex]::Replace(
    $text,
    '"@dsh-plugins/ui-cw-fileexplorer"\s*:\s*"[^"]*"',
    ('"@dsh-plugins/ui-cw-fileexplorer": "file:./vendor/' + $tgzName + '"'))
[System.IO.File]::WriteAllText($manifest, $text, (New-Object System.Text.UTF8Encoding $false))
Write-Host "    已更新：$manifest"

# 5. 安装：先删掉旧安装（pnpm 对同名同 spec 的依赖会跳过，不删不更新）
Invoke-Step '安装到 profile' {
    Remove-Item -Path (Join-Path $ProfileDir 'node_modules\@dsh-plugins') -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $ProfileDir
    try { pnpm install } finally { Pop-Location }
}

# 6. 清理插件目录里的临时罐头
Remove-Item -Path $tgz -Force -ErrorAction SilentlyContinue
Pop-Location

Write-Host ''
Write-Host "完成：$tgzName 已发布到 $ProfileDir"
Write-Host '请重启 dsh 后生效（客户端改动刷新页面即可看到部分更新）。'
