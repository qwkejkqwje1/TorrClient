@echo off
setlocal
rem Сборка демона. Рядом с программой лежат только те кэши, которые обязаны
rem ехать вместе с проектом: GOENV, GOPATH и склад зависимостей. Кэш компиляции
rem к ним не относится — он восстанавливается из исходников на любой машине, и
rem поэтому уходит на локальный диск, где ввод-вывод быстрый. Проект лежит на
rem общей папке VirtualBox, и кэш компиляции рядом с exe раздувал портативную
rem папку на 400 МБ и замедлял каждую сборку. Кэш можно удалять в любой момент:
rem ничего, кроме времени следующей сборки, это не стоит. Перекрыть можно
rem переменной TC_GOCACHE.
rem GOENV должен называть файл, а не каталог: go пишет в него своё окружение.
cd /d "%~dp0"
set "GOENV=%~dp0.go\.goenv"
set "GOPATH=%~dp0.go"
set "GOMODCACHE=%~dp0.gomods"
if not defined TC_GOCACHE (
    if defined LOCALAPPDATA (
        set "TC_GOCACHE=%LOCALAPPDATA%\TorrClient\gocache"
    ) else (
        set "TC_GOCACHE=%TEMP%\TorrClient\gocache"
    )
)
set "GOCACHE=%TC_GOCACHE%"
if not exist "%GOCACHE%" mkdir "%GOCACHE%"
if not exist "%~dp0.gomods" mkdir "%~dp0.gomods"
if not exist "%~dp0.go" mkdir "%~dp0.go"

rem --- проверки до сборки: сломанный код не должен попадать в exe ---
echo [1/4] go vet
go vet ./...
if errorlevel 1 goto :fail

echo [2/4] go test
go test ./...
if errorlevel 1 goto :fail

rem --- версия: хэш коммита, если каталог под git; иначе local ---
set "GITREV=local"
for /f "delims=" %%i in ('git rev-parse --short HEAD 2^>nul') do set "GITREV=%%i"
set "VER=TorrClient 1.1 (%GITREV% %DATE%)"

echo [3/4] go build - version: %VER%
rem Значение версии содержит пробелы: внутри -ldflags его надо взять в
rem одиночные кавычки, иначе go разобьёт его на лишние аргументы линковщика.
go build -ldflags "-s -w -X 'main.version=%VER%'" -o torrclient.exe .
if errorlevel 1 goto :fail

echo [4/4] ready: torrclient.exe
echo       %VER%
exit /b 0

:fail
echo BUILD FAILED
pause
exit /b 1
