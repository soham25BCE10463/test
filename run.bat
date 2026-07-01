@echo off
title NEON ARENA MULTIPLAYER
echo ===================================================
echo   NEON ARENA: WiFi Multiplayer Game Launcher
echo ===================================================
echo.
echo [1/2] Starting game server...
start "Neon Arena Server" cmd /c "npm start"

echo [2/2] Waiting for server to initialize...
timeout /t 2 /nobreak > nul

echo Opening browser...
start http://localhost:3000
echo.
echo ===================================================
echo   Server is running in a separate command window.
echo   Other players can join using the WiFi QR code 
echo   shown in the game lobby.
echo ===================================================
pause
