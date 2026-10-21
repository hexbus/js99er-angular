@echo off
cd /d "%~dp0"
node tools\start-local.cjs --open
if errorlevel 1 pause
