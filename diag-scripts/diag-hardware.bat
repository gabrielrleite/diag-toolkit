@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Diagnostico de Hardware - %COMPUTERNAME%
mode con: cols=90 lines=36 >nul 2>&1

rem ============================================================
rem  diag-hardware.bat
rem  Menu em texto para o diag-hardware.ps1
rem  O .bat, o .ps1 e o diag-servidor.cfg ficam na MESMA pasta.
rem ============================================================

rem Caminhos sempre via !VAR! (expansao atrasada): pastas com parenteses,
rem como "diag-coleta (1)" ao baixar o zip mais de uma vez, quebravam o .bat.
set "HERE=%~dp0"
set "SELF=%~f0"
set "PS1=%~dp0diag-hardware.ps1"
set "CFG=%~dp0diag-servidor.cfg"
if not exist "!PS1!" (
  echo.
  echo   ERRO: diag-hardware.ps1 nao encontrado em:
  echo   !HERE!
  echo.
  echo   Coloque o .bat e o .ps1 na mesma pasta.
  echo.
  pause
  exit /b 1
)

rem --- Eleva para administrador se precisar
net session >nul 2>&1
if errorlevel 1 (
  echo   Solicitando permissao de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath $env:SELF -WorkingDirectory $env:HERE -Verb RunAs"
  if errorlevel 1 (
    echo.
    echo   Nao foi possivel abrir como administrador - permissao negada ou cancelada.
    echo   Clique com o botao direito no diag-hardware.bat e escolha
    echo   "Executar como administrador".
    echo.
    pause
  )
  exit /b
)

rem --- Patrimonio a partir do nome do PC (padrao: PC + patrimonio)
set "PATR="
set "PATR_MANUAL=0"
if /i "%COMPUTERNAME:~0,2%"=="PC" set "PATR=%COMPUTERNAME:~2%"
if defined PATR if "!PATR:~0,1!"=="-" set "PATR=!PATR:~1!"
set "PATR_AUTO=0"
if defined PATR set "PATR_AUTO=1"
if not defined PATR (
  echo.
  echo   O nome deste computador - %COMPUTERNAME% - nao segue o padrao PC+patrimonio.
  call :pedirpatr
)

rem --- Servidor (diag-servidor.cfg)
set "SRV="
if exist "!CFG!" (
  for /f "usebackq tokens=1,* delims==" %%A in ("!CFG!") do (
    if /i "%%A"=="SERVIDOR" set "SRV=%%B"
  )
)

rem --- Valores padrao
set "DIAS=60"
set "TUDO=0"
set "DESTINO="
set "ENVIAR=0"
if defined SRV set "ENVIAR=1"

rem --- Ultima pasta usada (diag-menu.cfg ao lado do script)
set "MENUCFG=!HERE!diag-menu.cfg"
if exist "!MENUCFG!" (
  for /f "usebackq tokens=1,* delims==" %%A in ("!MENUCFG!") do (
    if /i "%%A"=="DESTINO" if exist "%%B\" set "DESTINO=%%B"
  )
)

:menu
cls
echo.
echo   ==========================================================
echo     DIAGNOSTICO DE REMOCAO DE HARDWARE
echo   ==========================================================
echo     Computador : %COMPUTERNAME%
if "!PATR_MANUAL!"=="1" (
  echo     Patrimonio : !PATR!  - informado manualmente
) else (
  echo     Patrimonio : !PATR!
)
echo     Usuario    : %USERDOMAIN%\%USERNAME%
echo   ----------------------------------------------------------
echo.
if "!DIAS!"=="0" (
  echo     [1] Dias de eventos ...... TODO o historico
) else (
  echo     [1] Dias de eventos ...... !DIAS!
)
if "!TUDO!"=="1" (
  echo     [2] Dispositivos ......... TODOS
) else (
  echo     [2] Dispositivos ......... Foco - video, disco, rede, audio, PCI removidos
)
if defined DESTINO (
  echo     [3] Salvar em ............ !DESTINO!
) else (
  echo     [3] Salvar em ............ Area de Trabalho - padrao
)
if not defined SRV (
  echo     [4] Enviar ao servidor ... nao configurado - falta diag-servidor.cfg
) else if "!ENVIAR!"=="1" (
  echo     [4] Enviar ao servidor ... SIM - !SRV!
) else (
  echo     [4] Enviar ao servidor ... NAO
)
echo.
echo     [5] EXECUTAR COLETA
echo     [6] Abrir ultima coleta
echo     [7] Reenviar ultima coleta ao servidor
echo     [8] Informar/alterar patrimonio
echo.
echo     [0] Sair
echo.
echo   ==========================================================
choice /c 123456780 /n /m "    Escolha uma opcao: "
set "OP=!errorlevel!"
if "!OP!"=="1" goto dias
if "!OP!"=="2" goto tudo
if "!OP!"=="3" goto destino
if "!OP!"=="4" goto enviar
if "!OP!"=="5" goto confirmar
if "!OP!"=="6" goto abrir
if "!OP!"=="7" goto reenviar
if "!OP!"=="8" (
  call :pedirpatr
  goto menu
)
if "!OP!"=="9" goto sair
goto menu

rem ------------------------------------------------------------
:dias
echo.
set "IN="
echo    0 = todo o historico disponivel nos logs
set /p "IN=    Quantos dias de eventos coletar? (0-36500, Enter mantem !DIAS!): "
if not defined IN goto menu
echo !IN!| findstr /r /x "0 [1-9][0-9]*" >nul
if errorlevel 1 (
  echo    Valor invalido. Digite apenas numeros.
  timeout /t 2 >nul
  goto menu
)
if !IN! GTR 36500 (
  echo    Maximo 36500 dias. Use 0 para todo o historico.
  timeout /t 2 >nul
  goto menu
)
set "DIAS=!IN!"
goto menu

rem ------------------------------------------------------------
:tudo
if "!TUDO!"=="1" (set "TUDO=0") else (set "TUDO=1")
goto menu

rem ------------------------------------------------------------
:destino
cls
echo.
echo   ==========================================================
echo     ONDE SALVAR A COLETA
echo   ==========================================================
if defined DESTINO (echo     Atual: !DESTINO!) else (echo     Atual: Area de Trabalho)
echo.
echo     [1] Escolher pasta...          abre a janela do Windows
echo     [2] Area de Trabalho           padrao
echo     [3] Pasta Coletas do script    !HERE!Coletas
echo     [4] Pendrive / disco removivel
echo     [5] Digitar o caminho
echo.
echo     [0] Voltar
echo.
choice /c 123450 /n /m "    Escolha: "
set "OP=!errorlevel!"
if "!OP!"=="1" goto dest_janela
if "!OP!"=="2" (
  set "DESTINO="
  call :salvadest
  goto menu
)
if "!OP!"=="3" goto dest_script
if "!OP!"=="4" goto dest_pendrive
if "!OP!"=="5" goto dest_digitar
goto menu

:dest_janela
echo.
echo    Abrindo a janela de selecao (pode aparecer atras desta)...
set "IN="
set "INI=!DESTINO!"
if not defined INI set "INI=%USERPROFILE%\Desktop"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -STA -ExecutionPolicy Bypass -File "!PS1!" -EscolherPasta -Destino "!INI!"`) do set "IN=%%P"
if not defined IN goto destino
goto dest_validar

:dest_script
set "IN=!HERE!Coletas"
goto dest_validar

:dest_pendrive
echo.
set "N=0"
for /f "usebackq tokens=1,* delims=|" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!PS1!" -ListarRemoviveis`) do (
  set /a N+=1
  set "RD!N!=%%A"
  echo     [!N!] %%A  %%B
)
if "!N!"=="0" (
  echo    Nenhum pendrive ou disco removivel encontrado.
  timeout /t 3 >nul
  goto destino
)
echo.
set "IN="
set /p "IN=    Numero da unidade (Enter = voltar): "
if not defined IN goto destino
echo !IN!| findstr /r /x "[1-9][0-9]*" >nul
if errorlevel 1 goto dest_pendrive
if !IN! GTR !N! goto dest_pendrive
for %%I in (!IN!) do set "IN=!RD%%I!\Coletas"
goto dest_validar

:dest_digitar
echo.
echo    Digite o caminho completo. Enter = voltar.
echo.
set "IN="
set /p "IN=    Pasta: "
if not defined IN goto destino
goto dest_validar

:dest_validar
set "IN=!IN:"=!"
rem remove barra final, que quebra as aspas na chamada do PowerShell
if "!IN:~-1!"=="\" set "IN=!IN:~0,-1!"
if "!IN:~-1!"==":" set "IN=!IN!\."
if not exist "!IN!\" (
  echo.
  echo    !IN!
  choice /c SN /n /m "    A pasta nao existe. Criar? [S/N] "
  if errorlevel 2 goto destino
  mkdir "!IN!" 2>nul
  if not exist "!IN!\" (
    echo    Nao foi possivel criar a pasta.
    timeout /t 3 >nul
    goto destino
  )
)
rem testa se da para gravar
set "TESTE=!IN!\.diag_teste_%RANDOM%.tmp"
(echo teste) > "!TESTE!" 2>nul
if not exist "!TESTE!" (
  echo.
  echo    Sem permissao de gravacao em !IN!
  timeout /t 3 >nul
  goto destino
)
del "!TESTE!" >nul 2>&1
set "DESTINO=!IN!"
call :salvadest
goto menu

:salvadest
if defined DESTINO (
  >"!MENUCFG!" echo DESTINO=!DESTINO!
) else (
  del "!MENUCFG!" >nul 2>&1
)
exit /b 0

rem ------------------------------------------------------------
:enviar
if not defined SRV (
  echo.
  echo    Para enviar, crie o arquivo diag-servidor.cfg nesta pasta:
  echo.
  echo      SERVIDOR=http://IP-DO-SERVIDOR:8080
  echo      TOKEN=token-de-envio
  echo.
  pause
  goto menu
)
if "!ENVIAR!"=="1" (set "ENVIAR=0") else (set "ENVIAR=1")
goto menu

rem ------------------------------------------------------------
:confirmar
cls
echo.
echo   ==========================================================
echo     CONFIRMAR COLETA
echo   ==========================================================
echo.
echo     Patrimonio      : !PATR!
if "!DIAS!"=="0" (echo     Dias de eventos : TODO o historico) else (echo     Dias de eventos : !DIAS!)
if "!TUDO!"=="1" (echo     Dispositivos    : TODOS) else (echo     Dispositivos    : Foco)
if defined DESTINO (echo     Salvar em       : !DESTINO!) else (echo     Salvar em       : Area de Trabalho)
if "!ENVIAR!"=="1" (echo     Enviar para     : !SRV!) else (echo     Enviar para     : nao enviar)
echo.
echo     A coleta apenas LE o sistema. Nada e alterado.
echo     Pode levar alguns minutos se o log de Seguranca for grande.
echo.
choice /c SN /n /m "    Iniciar agora? [S/N] "
if errorlevel 2 goto menu
if defined DESTINO if not exist "!DESTINO!\" (
  echo.
  echo    A pasta !DESTINO! nao esta disponivel - pendrive removido?
  echo    Escolha outro local.
  timeout /t 3 >nul
  goto destino
)

set "ARGS=-Dias !DIAS!"
call :argpatr
set "ARGS=!ARGS! !PARG!"
if "!TUDO!"=="1" set "ARGS=!ARGS! -Tudo"
if "!ENVIAR!"=="1" set "ARGS=!ARGS! -Enviar"
if defined DESTINO set "ARGS=!ARGS! -Destino "!DESTINO!""

cls
echo.
echo   Executando coleta...
echo   ----------------------------------------------------------
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "!PS1!" !ARGS!
set "RC=!errorlevel!"
echo.
echo   ----------------------------------------------------------
if "!RC!"=="2" (
  echo   Coleta SALVA, mas o envio ao servidor FALHOU.
  echo   Verifique a rede/servidor e use a opcao [7] para reenviar.
  echo.
  pause
  goto menu
)
if not "!RC!"=="0" (
  echo   A coleta terminou com erro - codigo !RC!. Veja as mensagens acima.
  echo.
  pause
  goto menu
)
echo.
choice /c SN /n /m "    Abrir o resumo e a pasta agora? [S/N] "
if errorlevel 2 goto menu
goto abrir

rem ------------------------------------------------------------
:base
set "BASE=!DESTINO!"
if not defined BASE (
  for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "BASE=%%D"
)
exit /b 0

rem ------------------------------------------------------------
:abrir
call :base
set "ULT="
for /f "delims=" %%F in ('dir /b /ad /o-d "!BASE!\diag_%COMPUTERNAME%_*" 2^>nul') do (
  if not defined ULT set "ULT=%%F"
)
if not defined ULT (
  echo.
  echo    Nenhuma coleta encontrada em !BASE!
  timeout /t 3 >nul
  goto menu
)
if exist "!BASE!\!ULT!\00_RESUMO.txt" start "" notepad "!BASE!\!ULT!\00_RESUMO.txt"
start "" explorer "!BASE!\!ULT!"
goto menu

rem ------------------------------------------------------------
:reenviar
if not defined SRV goto enviar
call :base
set "ZIP="
for /f "delims=" %%F in ('dir /b /a-d /o-d "!BASE!\diag_%COMPUTERNAME%_*.zip" 2^>nul') do (
  if not defined ZIP set "ZIP=%%F"
)
if not defined ZIP (
  echo.
  echo    Nenhum .zip de coleta encontrado em !BASE!
  timeout /t 3 >nul
  goto menu
)
echo.
echo    Arquivo : !ZIP!
echo    Servidor: !SRV!
echo.
choice /c SN /n /m "    Enviar agora? [S/N] "
if errorlevel 2 goto menu
echo.
call :argpatr
powershell -NoProfile -ExecutionPolicy Bypass -File "!PS1!" -EnviarArquivo "!BASE!\!ZIP!" !PARG!
echo.
pause
goto menu

rem ------------------------------------------------------------
:argpatr
rem Monta o parametro -Patrimonio: valor digitado, ou vazio se o nome nao segue o padrao
set "PARG="
if "!PATR_MANUAL!"=="1" (
  set "PARG=-Patrimonio "!PATR!""
) else if "!PATR_AUTO!"=="0" (
  set "PARG=-Patrimonio NAO_INFORMADO"
)
exit /b 0

:pedirpatr
echo.
set "IN="
set /p "IN=    Numero do patrimonio (Enter = nao informar): "
if defined IN set "IN=!IN:"=!"
if not defined IN (
  if "!PATR_MANUAL!"=="1" exit /b 0
  if not defined PATR set "PATR=NAO INFORMADO"
  exit /b 0
)
echo !IN!| findstr /r /x "[A-Za-z0-9][A-Za-z0-9./-]*" >nul
if errorlevel 1 (
  echo    Use letras, numeros, ponto, barra ou hifen - comecando por letra ou numero.
  goto pedirpatr
)
set "PATR=!IN!"
set "PATR_MANUAL=1"
exit /b 0

rem ------------------------------------------------------------
:sair
endlocal
exit /b 0
