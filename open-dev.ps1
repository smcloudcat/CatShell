# CatShell 快捷启动器
# 从脚本所在目录启动，避免双击时工作目录不正确。

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:Path = $env:Path + ";" + "$env:USERPROFILE\.cargo\bin"

Write-Host '正在启动 CatShell 开发服务器...' -ForegroundColor Green
Write-Host "项目目录: $PWD" -ForegroundColor DarkGray
Write-Host '停止服务请按 Ctrl+C。' -ForegroundColor Cyan

try {
    npm run tauri dev
} catch {
    Write-Host "启动失败: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Read-Host '按 Enter 关闭此窗口'
