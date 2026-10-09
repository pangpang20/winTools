@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Desktop Toolbox - Windows Build

cd /d "%~dp0"
set "LOG_FILE=%CD%\build-windows.log"

echo Desktop Toolbox Windows Build > "%LOG_FILE%"
echo Start: %DATE% %TIME% >> "%LOG_FILE%"
echo Project: %CD% >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

echo ========================================
echo   Desktop Toolbox Windows Build
echo   Log: %LOG_FILE%
echo ========================================
echo.

set "ELECTRON_VERSION=38.8.6"
set "ELECTRON_MIRROR=https://mirrors.huaweicloud.com/repository/toolkit/electron/"
set "ELECTRON_CUSTOM_DIR=v%ELECTRON_VERSION%"
set "NPM_CONFIG_REGISTRY=https://repo.huaweicloud.com/repository/npm/"

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found. Install Node.js first.
    echo [ERROR] npm was not found. Install Node.js first.>> "%LOG_FILE%"
    goto :failed
)

echo [1/3] Install Electron %ELECTRON_VERSION%...
echo [1/3] Install Electron %ELECTRON_VERSION%...>> "%LOG_FILE%"
call npm install electron@%ELECTRON_VERSION% --save-dev --registry=%NPM_CONFIG_REGISTRY% --foreground-scripts >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :failed

echo [2/3] Install project dependencies...
echo [2/3] Install project dependencies...>> "%LOG_FILE%"
call npm install --registry=%NPM_CONFIG_REGISTRY% --foreground-scripts >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :failed

echo [3/3] Build portable Windows EXE...
echo [3/3] Build portable Windows EXE...>> "%LOG_FILE%"
echo Build output is shown below. Full setup logs are in %LOG_FILE%.
call npm run dist:dir
if errorlevel 1 goto :failed

echo.
echo Build complete: %CD%\release\win-unpacked\*.exe
echo Build complete: %CD%\release\win-unpacked\*.exe>> "%LOG_FILE%"
echo Log saved: %LOG_FILE%
pause
exit /b 0

:failed
echo.
echo Build failed. See log: %LOG_FILE%
echo Press any key to close.
pause
exit /b 1
