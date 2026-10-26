@echo off
echo ========================================================
echo Iniciando copia de arquivos para o servidor remoto...
echo ========================================================

REM Carregar configuracao local privada se existir (ex: deploy.local.bat)
if exist "%~dp0deploy.local.bat" call "%~dp0deploy.local.bat"

REM Definir servidor e caminho de destino padrao caso nao configurado
if "%DEST%"=="" set DEST=usuario@servidor-remoto:~/Conversor-MSSQL-Oracle/

REM Enviar pasta src e arquivos de configuracao em um unico comando scp
echo Enviando arquivos para %DEST%...
scp -r src package.json package-lock.json tsconfig.json Dockerfile docker-compose.yml README.md %DEST%

if %ERRORLEVEL% EQU 0 (
    echo ========================================================
    echo Copia concluida com sucesso!
    echo ========================================================
) else (
    echo ========================================================
    echo Erro durante a copia de arquivos. Codigo: %ERRORLEVEL%
    echo ========================================================
)

pause
