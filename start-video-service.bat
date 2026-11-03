@echo off
title Video Watermark Remover Service (video-service-lite)
cd /d "%~dp0video-service-lite"
echo ============================================
echo   video service starting...
echo   addr: http://192.168.31.74:3100
echo   phone must use same WiFi as this PC
echo   close this window to stop service
echo ============================================
node server.js
pause
