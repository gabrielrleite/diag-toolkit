@echo off
reg delete "HKCU\Software\Classes\diagassina" /f >nul 2>&1
reg delete "HKCU\Software\Classes\diagcoleta" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\DiagAgente" 2>nul
rmdir /s /q "%LOCALAPPDATA%\DiagAssinador" 2>nul
echo Agente diag removido.
pause
