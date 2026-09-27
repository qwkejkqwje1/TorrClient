@echo off
setlocal
rem Все проверки проекта одним запуском. Логика — в tools\check-all.py, рядом с
rem остальными инструментами: батнику не хватило бы ни проверки «вывод пуст», на
rem которой держится gofmt, ни понятной причины отказа.
cd /d "%~dp0"
python tools\check-all.py
if errorlevel 1 (
    echo.
    echo ПРОВЕРКИ НЕ ПРОЙДЕНЫ
    pause
    exit /b 1
)
exit /b 0
