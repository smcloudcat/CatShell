@echo off
setlocal
cd /d "%~dp0"
set "PATH=%PATH%;%USERPROFILE%\.cargo\bin"

title CatShell Development
echo Starting CatShell development app...
echo Project: %CD%
echo.

call npm run tauri dev

echo.
echo The development process has stopped.
pause
