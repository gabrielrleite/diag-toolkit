@echo off
rem Instala o Agente diag para o usuario atual (nao precisa de administrador).
rem Registra o link diagassina: usado pelo site para assinar laudos com o
rem certificado instalado no Windows (A1 ou A3/token).
setlocal
set "DEST=%LOCALAPPDATA%\DiagAgente"
for %%F in (assinador.ps1) do if not exist "%~dp0%%F" (
  echo ERRO: %%F nao encontrado ao lado deste arquivo.
  pause & exit /b 1
)
mkdir "%DEST%" 2>nul
copy /y "%~dp0assinador.ps1" "%DEST%\assinador.ps1" >nul
powershell -NoProfile -Command "Get-ChildItem '%DEST%\*.ps1' | Unblock-File" >nul 2>&1
call :registra diagassina "Assinador diag" assinador.ps1
reg delete "HKCU\Software\Classes\diagcoleta" /f >nul 2>&1
rem versao anterior (so assinador)
reg delete "HKCU\Software\Classes\diagassina\DefaultIcon" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\DiagAssinador" 2>nul
echo.
echo   Agente diag instalado em %DEST%
echo   Use o botao "Assinar" no laudo.
echo   Na primeira vez o navegador pergunta se pode abrir o programa:
echo   marque "Sempre permitir" e confirme.
echo.
pause
exit /b 0

:registra
reg add "HKCU\Software\Classes\%~1" /ve /d "URL:%~2" /f >nul
reg add "HKCU\Software\Classes\%~1" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\%~1\shell\open\command" /ve /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%DEST%\%~3\" -Url \"%%1\"" /f >nul
exit /b 0
