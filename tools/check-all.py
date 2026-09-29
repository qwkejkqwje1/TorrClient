"""Все проверки проекта одним запуском.

Прежде их было семь, и каждая жила только в памяти: перед сдачей достаточно
забыть одну — и сломанный код уедет в exe. Здесь они выстроены от быстрого к
медленному: разметка, разбор, тесты демона, интерфейс, тесты оболочки.

Проверки интерфейса (`check-series.js`) не требуют ни сети, ни запущенного
демона, поэтому скрипт годится и на машине без интернета.

`prove-fix.py` сюда не входит нарочно: он портит файлы и возвращает их на место,
и запускать его надо отдельно, до конца, не прерывая.

Запуск из корня проекта:

    python tools/check-all.py

Переменные: `TC_GO`, `TC_NODE`, `TC_GOCACHE` перекрывают найденное.
"""

import glob
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Те же каталоги, что у build_daemon.bat и make-release.py: рядом с программой
# лежат только те кэши, которые обязаны ехать вместе с проектом.
GO = os.environ.get("TC_GO") or shutil.which("go") or r"C:\Users\1\.workbuddy-ai\binaries\go\go\bin\go.exe"
NODE = os.environ.get("TC_NODE") or shutil.which("node") or "node"


# gofmt лежит рядом с go и отдельной переменной обычно не требует: `go fmt`
# ключа -l не знает, а без него не отличить «отформатировано» от «проверка не
# запустилась» — оба случая дают пустой вывод.
def gofmt_path():
    if os.environ.get("TC_GOFMT"):
        return os.environ["TC_GOFMT"]
    sibling = os.path.join(os.path.dirname(GO), "gofmt.exe" if os.name == "nt" else "gofmt")
    if os.path.exists(sibling):
        return sibling
    return shutil.which("gofmt") or "gofmt"


GOFMT = gofmt_path()

ENV = dict(
    os.environ,
    GOENV=os.path.join(ROOT, ".go", ".goenv"),
    GOPATH=os.path.join(ROOT, ".go"),
    GOMODCACHE=os.path.join(ROOT, ".gomods"),
    GOCACHE=os.environ.get("TC_GOCACHE") or os.path.join(
        os.environ.get("LOCALAPPDATA", os.environ.get("TEMP", "C:/tmp")), "TorrClient", "gocache"),
)

# (заголовок, команда, каталог)
STEPS = [
    ("gofmt: разметка исходников демона", [GOFMT, "-l"] + sorted(glob.glob(os.path.join(ROOT, "*.go"))), ROOT),
    ("gofmt: разметка исходников оболочки", [GOFMT, "-l"] + sorted(glob.glob(os.path.join(ROOT, "app", "*.go"))), ROOT),
    ("go vet: демон", [GO, "vet", "."], ROOT),
    ("go test: демон", [GO, "test", "."], ROOT),
    ("node --check: интерфейс", [NODE, "--check", os.path.join("web", "app.js")], ROOT),
    ("проверки интерфейса на образцах", [NODE, os.path.join("tools", "check-series.js")], ROOT),
    ("оценка качества раздач и вердикт ffprobe", [NODE, os.path.join("tools", "check-quality.cjs")], ROOT),
    ("go vet: оболочка", [GO, "vet", "./..."], os.path.join(ROOT, "app")),
    ("go test: оболочка", [GO, "test", "./..."], os.path.join(ROOT, "app")),
]

TOTAL = len(STEPS)


def run(num, title, cmd, cwd):
    """Одна проверка. Пустой вывод считается успехом, любой вывод — провалом:
    так ведёт себя gofmt, у которого «всё в порядке» — это пустой список."""
    print("[%d/%d] %s" % (num, TOTAL, title), flush=True)
    empty_is_ok = os.path.basename(cmd[0]).startswith("gofmt")
    try:
        done = subprocess.run(cmd, cwd=cwd, env=ENV, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
    except OSError as err:
        print("    не удалось запустить %s: %s" % (cmd[0], err))
        return False
    if done.returncode != 0 or (done.stdout.strip() and empty_is_ok):
        for stream in (done.stdout, done.stderr):
            for line in stream.strip().splitlines():
                print("    %s" % line)
        print("    проверка не пройдена (код %d)" % done.returncode)
        return False
    return True


def main():
    if not os.path.exists(GO):
        print("Go не найден: %s" % GO)
        print("Задайте TC_GO или положите go в PATH.")
        return 1
    for num, (title, cmd, cwd) in enumerate(STEPS, 1):
        if not run(num, title, cmd, cwd):
            print("\nПРОВЕРКИ НЕ ПРОЙДЕНЫ")
            return 1
    print("\nВсе проверки пройдены.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
