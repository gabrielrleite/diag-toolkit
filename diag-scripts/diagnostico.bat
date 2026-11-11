@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Diagnostico do computador - %COMPUTERNAME%
mode con: cols=90 lines=42 >nul 2>&1

rem ============================================================
rem  diagnostico.bat
rem  Menu em texto para o diagnostico.ps1 (manutencao: saude do
rem  equipamento, erros, drivers, rede). Para remocao de hardware use
rem  o diag-hardware.bat.
rem  O .bat, o .ps1 e o diag-servidor.cfg ficam na MESMA pasta.
rem ============================================================

rem Caminhos sempre via !VAR! (expansao atrasada): pastas com parenteses,
rem como "diag-coleta (1)" ao baixar o zip mais de uma vez, quebravam o .bat.
set "HERE=%~dp0"
set "SELF=%~f0"
set "PS1=%~dp0diagnostico.ps1"
set "CFG=%~dp0diag-servidor.cfg"
if not exist "!PS1!" (
  echo.
  echo   ERRO: diagnostico.ps1 nao encontrado em:
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
    echo   Clique com o botao direito no diagnostico.bat e escolha
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
set "DIAS=30"
set "DESTINO="
set "ENVIAR=0"
if defined SRV set "ENVIAR=1"
rem testes profundos: 0 = nao, 1 = sim (superficie e antivirus: 0/1/2)
set "T_SIS=0" & set "T_DSK=0" & set "T_SUP=0" & set "T_WIN=0" & set "T_MEM=0"
set "T_CPU=0" & set "T_REDE=0" & set "T_AV=0" & set "T_ENE=0" & set "T_LOG=0" & set "T_BEN=0"
set "MIN=10"

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
echo     DIAGNOSTICO DO COMPUTADOR - MANUTENCAO
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
if defined DESTINO (
  echo     [2] Salvar em ............ !DESTINO!
) else (
  echo     [2] Salvar em ............ Area de Trabalho - padrao
)
if not defined SRV (
  echo     [3] Enviar ao servidor ... nao configurado - falta diag-servidor.cfg
) else if "!ENVIAR!"=="1" (
  echo     [3] Enviar ao servidor ... SIM - !SRV!
) else (
  echo     [3] Enviar ao servidor ... NAO
)
call :resumotestes
if "!NT!"=="0" (
  echo     [4] Testes profundos ..... nenhum - so o diagnostico rapido
) else (
  echo     [4] Testes profundos ..... !NT! marcados - cerca de !EST! min!ESTSUP!
)
echo.
echo     [5] EXECUTAR DIAGNOSTICO
echo     [6] Abrir ultimo diagnostico
echo     [7] Reenviar ultimo diagnostico ao servidor
echo     [8] Informar/alterar patrimonio
echo.
echo     [0] Sair
echo.
echo   ==========================================================
choice /c 123456780 /n /m "    Escolha uma opcao: "
set "OP=!errorlevel!"
if "!OP!"=="1" goto dias
if "!OP!"=="2" goto destino
if "!OP!"=="3" goto enviar
if "!OP!"=="4" goto profundo
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
:profundo
cls
call :resumotestes
echo.
echo   ==========================================================
echo     TESTES PROFUNDOS - opcionais
echo     Temperaturas, tensoes e ventoinhas sao gravadas durante os testes
echo   ==========================================================
call :mk !T_SIS!
echo     [1] !MK! Integridade do Windows - DISM + SFC ....... 15-40 min
if "!T_DSK!"=="0" echo     [2] [ ] Verificar unidades - chkdsk
if "!T_DSK!"=="1" echo     [2] [X] Verificar unidades ............. SO ANALISA, nada e alterado
if "!T_DSK!"=="2" echo     [2] [X] Verificar unidades ............. analisa e CORRIGE sozinho os erros
if "!T_SUP!"=="0" echo     [3] [ ] Superficie do disco - leitura completa .... SSD 10-30 min / HD 1-4 h
if "!T_SUP!"=="1" echo     [3] [X] Superficie do disco ............ disco do sistema
if "!T_SUP!"=="2" echo     [3] [X] Superficie do disco ............ TODOS os discos internos
call :mk !T_WIN!
echo     [4] !MK! Desempenho - WinSAT ....................... cerca de 5 min
call :mk !T_MEM!
echo     [5] !MK! Memoria RAM - padroes na memoria livre .... !MIN! min
call :mk !T_CPU!
echo     [6] !MK! Estresse do processador + temperatura ..... !MIN! min
call :mk !T_REDE!
echo     [7] !MK! Rede prolongada - perda e latencia ........ !MIN! min
if "!T_AV!"=="0" echo     [8] [ ] Antivirus Defender
if "!T_AV!"=="1" echo     [8] [X] Antivirus Defender ................. verificacao rapida, 5-15 min
if "!T_AV!"=="2" echo     [8] [X] Antivirus Defender ................. verificacao COMPLETA, 1-3 h
call :mk !T_ENE!
echo     [9] !MK! Relatorio de energia - powercfg ........... 1 min
call :mk !T_LOG!
echo     [L] !MK! Copiar logs do Windows - .evtx
call :mk !T_BEN!
echo     [B] !MK! Benchmark - CPU, memoria e disco ........... 1 min
echo.
echo     [D] Duracao de memoria, estresse e rede ..... !MIN! min
echo.
echo     Perfis prontos:
echo     [A] Basico ...... benchmark, estresse, memoria, chkdsk - 3 min cada
echo     [R] Recomendado . + integridade, WinSAT, rede, antivirus - 10 min cada
echo     [C] Completo .... + superficie do disco do sistema, logs - 20 min cada
echo     [T] Burn-in ..... tudo, todos os discos, antivirus completo - 60 min cada
echo     [N] Desmarcar todos
echo     Os perfis so analisam as unidades; para corrigir, aperte [2] de novo.
echo     [M] Agendar teste de memoria do Windows - reinicia o PC
echo.
if "!NT!"=="0" (echo     Total: nenhum teste marcado) else (echo     Total estimado: cerca de !EST! min!ESTSUP!)
echo.
echo     [0] Voltar
echo   ==========================================================
choice /c 123456789LBADRCTNM0 /n /m "    Escolha: "
set "OP=!errorlevel!"
if "!OP!"=="1" call :tg T_SIS
if "!OP!"=="2" set /a "T_DSK=(T_DSK+1)%%3"
if "!OP!"=="3" set /a "T_SUP=(T_SUP+1)%%3"
if "!OP!"=="4" call :tg T_WIN
if "!OP!"=="5" call :tg T_MEM
if "!OP!"=="6" call :tg T_CPU
if "!OP!"=="7" call :tg T_REDE
if "!OP!"=="8" set /a "T_AV=(T_AV+1)%%3"
if "!OP!"=="9" call :tg T_ENE
if "!OP!"=="10" call :tg T_LOG
if "!OP!"=="11" call :tg T_BEN
if "!OP!"=="12" (
  set "T_SIS=0" & set "T_DSK=1" & set "T_SUP=0" & set "T_WIN=0" & set "T_MEM=1"
  set "T_CPU=1" & set "T_REDE=0" & set "T_AV=0" & set "T_ENE=0" & set "T_LOG=0" & set "T_BEN=1"
  set "MIN=3"
)
if "!OP!"=="13" goto duracao
if "!OP!"=="14" (
  set "T_SIS=1" & set "T_DSK=1" & set "T_SUP=0" & set "T_WIN=1" & set "T_MEM=1"
  set "T_CPU=1" & set "T_REDE=1" & set "T_AV=1" & set "T_ENE=1" & set "T_LOG=0" & set "T_BEN=1"
  set "MIN=10"
)
if "!OP!"=="15" (
  set "T_SIS=1" & set "T_DSK=1" & set "T_SUP=1" & set "T_WIN=1" & set "T_MEM=1"
  set "T_CPU=1" & set "T_REDE=1" & set "T_AV=1" & set "T_ENE=1" & set "T_LOG=1" & set "T_BEN=1"
  set "MIN=20"
)
if "!OP!"=="16" (
  set "T_SIS=1" & set "T_DSK=1" & set "T_SUP=2" & set "T_WIN=1" & set "T_MEM=1"
  set "T_CPU=1" & set "T_REDE=1" & set "T_AV=2" & set "T_ENE=1" & set "T_LOG=1" & set "T_BEN=1"
  set "MIN=60"
)
if "!OP!"=="17" (
  set "T_SIS=0" & set "T_DSK=0" & set "T_SUP=0" & set "T_WIN=0" & set "T_MEM=0"
  set "T_CPU=0" & set "T_REDE=0" & set "T_AV=0" & set "T_ENE=0" & set "T_LOG=0" & set "T_BEN=0"
)
if "!OP!"=="18" goto memboot
if "!OP!"=="19" goto menu
goto profundo

:duracao
echo.
set "IN="
set /p "IN=    Minutos para memoria, estresse e rede (1-600, Enter mantem !MIN!): "
if not defined IN goto profundo
echo !IN!| findstr /r /x "[1-9][0-9]*" >nul
if errorlevel 1 goto profundo
if !IN! GTR 600 goto profundo
set "MIN=!IN!"
goto profundo

:memboot
cls
echo.
echo   Teste de memoria do Windows (fora do Windows, mais completo)
echo   ----------------------------------------------------------
echo   Vai abrir a janela "Diagnostico de Memoria do Windows".
echo   Escolha "Reiniciar agora e verificar se ha problemas" ou
echo   "Verificar se ha problemas na proxima vez que eu iniciar".
echo   O teste leva de 15 a 60 min. Depois, rode este diagnostico de
echo   novo: o resultado aparece em "Teste de memoria do Windows".
echo.
choice /c SN /n /m "    Abrir agora? [S/N] "
if errorlevel 2 goto profundo
start "" mdsched.exe
goto profundo

:tg
if "!%1!"=="1" (set "%1=0") else (set "%1=1")
exit /b 0

:mk
if "%1"=="1" (set "MK=[X]") else (set "MK=[ ]")
exit /b 0

:resumotestes
set /a "NT=T_SIS+T_WIN+T_MEM+T_CPU+T_REDE+T_ENE+T_LOG+T_BEN"
if not "!T_DSK!"=="0" set /a "NT+=1"
if not "!T_SUP!"=="0" set /a "NT+=1"
if not "!T_AV!"=="0" set /a "NT+=1"
set /a "EST=T_SIS*25+T_WIN*5+T_MEM*MIN+T_CPU*MIN+T_REDE*MIN+T_ENE+T_LOG+T_BEN+1"
if not "!T_DSK!"=="0" set /a "EST+=10"
if "!T_AV!"=="1" set /a "EST+=10"
if "!T_AV!"=="2" set /a "EST+=90"
set "ESTSUP="
if not "!T_SUP!"=="0" set "ESTSUP= + superficie do disco"
exit /b 0

rem ------------------------------------------------------------
:dias
echo.
set "IN="
echo    0 = todo o historico disponivel nos logs
set /p "IN=    Quantos dias de eventos analisar? (0-36500, Enter mantem !DIAS!): "
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
:destino
cls
echo.
echo   ==========================================================
echo     ONDE SALVAR O DIAGNOSTICO
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
echo     CONFIRMAR DIAGNOSTICO
echo   ==========================================================
echo.
echo     Patrimonio      : !PATR!
if "!DIAS!"=="0" (echo     Dias de eventos : TODO o historico) else (echo     Dias de eventos : !DIAS!)
if defined DESTINO (echo     Salvar em       : !DESTINO!) else (echo     Salvar em       : Area de Trabalho)
if "!ENVIAR!"=="1" (echo     Enviar para     : !SRV!) else (echo     Enviar para     : nao enviar)
echo.
call :resumotestes
if "!NT!"=="0" (
  echo     Testes profundos: nenhum
  echo.
  echo     O diagnostico apenas LE o sistema. Nada e alterado.
  echo     Leva de 1 a 3 minutos. Inclui teste de rede - gateway, DNS, internet.
) else (
  echo     Testes profundos: !NT! - cerca de !EST! min!ESTSUP!
  echo.
  echo     Os testes so leem o sistema - o benchmark grava um arquivo
  echo     temporario de ate 1 GB e apaga. Durante o estresse e o teste de
  echo     memoria o PC fica lento. Notebook: deixe na tomada.
  if "!T_DSK!"=="2" echo     ATENCAO: o chkdsk vai CORRIGIR os erros que encontrar nas unidades.
  echo     O antivirus pode colocar em quarentena o que encontrar.
  echo     Nao feche esta janela ate terminar.
)
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
if "!ENVIAR!"=="1" set "ARGS=!ARGS! -Enviar"
if defined DESTINO set "ARGS=!ARGS! -Destino "!DESTINO!""
set "TL="
if "!T_SIS!"=="1" set "TL=!TL!,sistema"
if "!T_DSK!"=="1" set "TL=!TL!,disco"
if "!T_DSK!"=="2" set "TL=!TL!,disco-corrigir"
if "!T_WIN!"=="1" set "TL=!TL!,desempenho"
if "!T_BEN!"=="1" set "TL=!TL!,benchmark"
if "!T_MEM!"=="1" set "TL=!TL!,memoria"
if "!T_CPU!"=="1" set "TL=!TL!,estresse"
if "!T_REDE!"=="1" set "TL=!TL!,rede"
if "!T_AV!"=="1" set "TL=!TL!,antivirus"
if "!T_AV!"=="2" set "TL=!TL!,antivirus-completo"
if "!T_ENE!"=="1" set "TL=!TL!,energia"
if "!T_LOG!"=="1" set "TL=!TL!,logs"
if not "!T_SUP!"=="0" set "TL=!TL!,superficie"
if defined TL set "ARGS=!ARGS! -Testes !TL:~1! -Minutos !MIN!"
if "!T_SUP!"=="2" set "ARGS=!ARGS! -SuperficieTodos"

cls
echo.
echo   Executando diagnostico...
echo   ----------------------------------------------------------
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "!PS1!" !ARGS!
set "RC=!errorlevel!"
echo.
echo   ----------------------------------------------------------
if "!RC!"=="2" (
  echo   Diagnostico SALVO, mas o envio ao servidor FALHOU.
  echo   Verifique a rede/servidor e use a opcao [7] para reenviar.
  echo.
  pause
  goto menu
)
if not "!RC!"=="0" (
  echo   O diagnostico terminou com erro - codigo !RC!. Veja as mensagens acima.
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
for /f "delims=" %%F in ('dir /b /ad /o-d "!BASE!\diagnostico_%COMPUTERNAME%_*" 2^>nul') do (
  if not defined ULT set "ULT=%%F"
)
if not defined ULT (
  echo.
  echo    Nenhum diagnostico encontrado em !BASE!
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
for /f "delims=" %%F in ('dir /b /a-d /o-d "!BASE!\diagnostico_%COMPUTERNAME%_*.zip" 2^>nul') do (
  if not defined ZIP set "ZIP=%%F"
)
if not defined ZIP (
  echo.
  echo    Nenhum .zip de diagnostico encontrado em !BASE!
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
