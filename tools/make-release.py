"""Сборка чистой портативной папки релиза.

Рядом с программой за время разработки накопилось то, чего в релизе быть не
должно: исходники (`*.go`), склад зависимостей (`.gomods`, `.go`), инструменты
(`tools/`), образцы страниц (`testdata/`), память проекта (`.workbuddy-ai/`),
данные самого TorrServer (`config.db`, `settings.json`), закачки, наблюдение — и
`torrclient.json` с ключом TMDB в открытом виде. Копировать папку целиком поэтому
нельзя: вместе с программой уехал бы и ключ.

Что делает скрипт:

1. прогоняет `go vet` и `go test` — сломанный код в exe не попадает;
2. собирает демон в папку релиза с версией из `--version`;
3. копирует только нужное: демон, движок TorrServer, оболочку, три `.bat` и README;
4. проверяет, что в папке нет ни запрещённых файлов, ни ключа TMDB;
5. запускает собранный демон на отдельном порту и сверяет **вшитый** в него
   интерфейс с `web/app.js` байт в байт, а версию — с заказанной: так ловится
   сборка из устаревших исходников;
6. убирает следы проверки, печатает состав и делает zip.

Отдельно про удаление: папка проекта лежит на портативном диске, где нет корзины,
и удаление там заведомо проваливается — окружение отказывает в необратимой
операции, а массовое удаление к тому же обрывает процесс. Поэтому скрипт не
удаляет ничего: папку прошлой сборки он перезаписывает (в ней ровно тот же
состав), чужую — отводит в сторону переименованием, архив пишет поверх прежнего.

Запуск из корня проекта:

    python tools/make-release.py                 # версия 1.1
    python tools/make-release.py --version 1.2
"""

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GO = os.environ.get("TC_GO") or shutil.which("go") or r"C:\Users\1\.workbuddy-ai\binaries\go\go\bin\go.exe"
ENV = dict(
    os.environ,
    GOENV=os.path.join(ROOT, ".go", ".goenv"),
    GOPATH=os.path.join(ROOT, ".go"),
    GOMODCACHE=os.path.join(ROOT, ".gomods"),
    GOCACHE=os.environ.get("TC_GOCACHE") or os.path.join(
        os.environ.get("LOCALAPPDATA", os.environ.get("TEMP", "C:/tmp")), "TorrClient", "gocache"),
)

# Что попадает в релиз: (откуда в проекте, куда в папке релиза).
FILES = [
    ("TorrServer-windows-amd64.exe", "TorrServer-windows-amd64.exe"),
    (os.path.join("app", "build", "bin", "TorrClient.exe"), os.path.join("app", "build", "bin", "TorrClient.exe")),
    (os.path.join("app", "build", "bin", "app.ico"), os.path.join("app", "build", "bin", "app.ico")),
    ("start_desktop.bat", "start_desktop.bat"),
    ("start_web.bat", "start_web.bat"),
    ("stop_all.bat", "stop_all.bat"),
    ("README.md", "README.md"),
]

# Что делает окно окном: по времени правки этих файлов видно, не отстала ли
# собранная сборка окна от исходников. Страница оболочки здесь потому, что она
# вшивается в окно и правится отдельно от демона.
SHELL_SOURCES = [
    os.path.join("app", "app.go"),
    os.path.join("app", "restart.go"),
    os.path.join("app", "main.go"),
    os.path.join("app", "tray.go"),
    os.path.join("app", "frontend", "dist", "index.html"),
]

# Чего в релизе быть не должно. Проверка по имени на любом уровне вложенности:
# список собран из того, что реально лежит в рабочей папке.
FORBIDDEN = {
    ".go", ".gomods", ".workbuddy-ai", ".webview", "tools", "testdata", "web",
    "frontend", "node_modules", "downloads", "watch",
    "config.db", "settings.json", "torrclient.json", "tmdb-cache.json",
    "viewed.json", "userdata.json", "torrclient.log",
    "CHANGES.md", "SEARCH-REVIEW.md", "HESTIA-REVIEW.md", "go.mod",
}
FORBIDDEN_SUFFIX = (".go", ".py", ".cjs", ".js", ".css", ".html")

# Полный состав релиза — всё, что скрипт кладёт в папку сам. По нему проверяется,
# что в папке нет ничего постороннего, и по нему же распознаётся «своя» папка от
# прошлого запуска (её можно перезаписать) против чужой (её нужно отвести в сторону).
EXPECTED = {dst.replace("\\", "/") for _, dst in FILES} | {"torrclient.exe"}

PORT = 8123
ok = True


def step(name, cond, extra=""):
    global ok
    print(("  ок    | " if cond else "  ПЛОХО | ") + name + ((" — " + str(extra)) if extra else ""))
    if not cond:
        ok = False


def run(args, **kw):
    return subprocess.run(args, cwd=ROOT, env=ENV, capture_output=True, text=True, **kw)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def tree(base):
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        for n in filenames:
            p = os.path.join(dirpath, n)
            out.append((os.path.relpath(p, base), os.path.getsize(p)))
    return sorted(out)


def shell_is_stale():
    """Собранное окно старше своих исходников?

    Окно — отдельная сборка (`wails build`), и здесь она не делается: инструмент
    wails стоит не на всякой машине. Поэтому окно в релизе может молча остаться
    прежним, и правка, проверенная тестами, до пользователя не дойдёт вовсе.

    Именно так и вышло: окно от 22 сентября не содержало ни счёта попыток у
    сторожа, ни показа беды на странице, хотя и то и другое было написано и
    покрыто проверками. Сверить время сборки с исходниками — единственный способ
    заметить это без живой установки.

    Возвращает (устарело, причина).
    """
    exe = os.path.join("app", "build", "bin", "TorrClient.exe")
    if not os.path.exists(os.path.join(ROOT, exe)):
        return True, "окно не собрано вовсе"
    built = os.path.getmtime(os.path.join(ROOT, exe))
    newer = [p for p in SHELL_SOURCES
             if os.path.exists(os.path.join(ROOT, p))
             and os.path.getmtime(os.path.join(ROOT, p)) > built]
    if newer:
        return True, "новее окна: " + ", ".join(newer)
    return False, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="1.1")
    ap.add_argument("--skip-tests", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(GO):
        print("не найден go: " + GO + " (укажите TC_GO)")
        return 1

    ver = "TorrClient %s (%s)" % (args.version, datetime.date.today().isoformat())
    name = "TorrClient-%s-portable" % args.version
    rel = os.path.join(ROOT, "release")
    out = os.path.join(rel, name)

    if not args.skip_tests:
        print("1. Проверки до сборки")
        for title, cmd in (("go vet", [GO, "vet", "./..."]), ("go test", [GO, "test", "-count=1", "./..."])):
            p = run(cmd)
            step(title + " — чисто", p.returncode == 0, (p.stdout + p.stderr).strip().splitlines()[-1:] or "")

    print("2. Сборка демона: %s" % ver)
    # Отведённые папки прошлых запусков обнуляются — место на портативном диске
    # дороже пустых файлов, а удалить их нельзя (см. заголовок файла).
    if os.path.isdir(rel):
        for d in os.listdir(rel):
            if not d.startswith(".old-"):
                continue
            for dirpath, _, files in os.walk(os.path.join(rel, d)):
                for n in files:
                    try:
                        open(os.path.join(dirpath, n), "wb").close()
                    except OSError:
                        pass
    # Прежняя папка сборки не удаляется: удаление здесь не работает, и попытка
    # «вычистить» её обрывает весь запуск. Если в ней ровно состав релиза — это
    # своя папка от прошлого запуска, её достаточно перезаписать. Если в ней есть
    # постороннее (запускали демон прямо в папке релиза) — папка отводится в
    # сторону переименованием, которое ничего не удаляет.
    if os.path.isdir(out):
        extra = [f for f, _ in tree(out) if f.replace("\\", "/") not in EXPECTED]
        if extra:
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            try:
                os.rename(out, os.path.join(rel, ".old-" + stamp))
                print("      прежняя папка отведена в release\\.old-%s — в ней было постороннее: %s"
                      % (stamp, ", ".join(sorted(extra)[:3])))
            except OSError as e:
                # Папку держат (обычно не сразу отпускает WebView2). Переименовать
                # нельзя, а собирать поверх неё нельзя тем более: в архив попадут
                # torrclient.json с ключом TMDB, подписки и история просмотра.
                # Поэтому посторонние файлы выносятся по одному — папку держат,
                # а переносить из неё можно. Данные не теряются: уходят в
                # release\_data-<метка>, которую следующая сборка не обнуляет.
                keep = os.path.join(rel, "_data-" + stamp)
                stuck = []
                for f in extra:
                    src = os.path.join(out, f)
                    dst = os.path.join(keep, f)
                    try:
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                        os.replace(src, dst)
                    except OSError:
                        stuck.append(f)
                if stuck:
                    print("      ПРЕКРАЩАЮ: не смог убрать из папки релиза: %s" % ", ".join(sorted(stuck)[:3]))
                    print("      Закройте программу (stop_all.bat) и повторите сборку.")
                    return 1
                print("      прежнюю папку отвести не удалось (%s)" % (e.args[2] if len(e.args) > 2 else e))
                print("      посторонние файлы вынесены в release\\_data-%s: %s"
                      % (stamp, ", ".join(sorted(extra)[:3])))
    os.makedirs(out, exist_ok=True)
    exe = os.path.join(out, "torrclient.exe")
    p = run([GO, "build", "-ldflags", "-s -w -X 'main.version=%s'" % ver, "-o", exe, "."])
    step("демон собран", p.returncode == 0 and os.path.exists(exe), (p.stdout + p.stderr).strip()[-200:])
    if p.returncode != 0:
        return 1

    print("3. Состав папки релиза")
    # Окно собирается отдельно и здесь не пересобирается. Молча положить в релиз
    # прежнюю сборку — значит отдать пользователю старую программу под новым
    # номером версии.
    stale, why = shell_is_stale()
    if stale and os.environ.get("TC_ALLOW_STALE_SHELL") == "1":
        print("  ВНИМАНИЕ | окно в релизе старше своих исходников — %s" % why)
        print("          | пересобрать: cd app && wails build")
    else:
        step("окно собрано не раньше своих исходников", not stale,
             why + " (пересобрать: cd app && wails build)" if stale else "")
    for src, dst in FILES:
        s = os.path.join(ROOT, src)
        if not os.path.exists(s):
            step("на месте: " + src, False, "нет файла")
            continue
        d = os.path.join(out, dst)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)

    print("4. Ничего лишнего и ни одного секрета")
    bad = []
    for relpath, _ in tree(out):
        parts = relpath.replace("\\", "/").split("/")
        hit = [p for p in parts if p in FORBIDDEN]
        if hit:
            bad.append((relpath, "лишнее: " + ", ".join(hit)))
        elif parts[-1].lower().endswith(FORBIDDEN_SUFFIX):
            bad.append((relpath, "исходник в релизе"))
    step("в папке нет исходников и рабочих данных", not bad, bad[:4])

    # Состав сверяется точно: папка от прошлого запуска перезаписывается, и если
    # в ней завёлся хоть один лишний файл, он уедет человеку вместе с релизом.
    stray = [f for f, _ in tree(out) if f.replace("\\", "/") not in EXPECTED]
    step("в папке ровно состав релиза", not stray, sorted(stray)[:4])

    # Ключ TMDB берётся из рабочего конфига: если он попал в релиз — это ошибка
    # сборки, а не мелочь, и знать о ней нужно до отправки папки кому-либо.
    key = ""
    conf = os.path.join(ROOT, "torrclient.json")
    if os.path.exists(conf):
        key = (read_json(conf) or {}).get("tmdb_api_key", "")
    if key:
        leaks = []
        for relpath, _ in tree(out):
            with open(os.path.join(out, relpath), "rb") as f:
                if key.encode() in f.read():
                    leaks.append(relpath)
        step("ключ TMDB в релиз не попал", not leaks, leaks)
    else:
        step("ключ TMDB в релиз не попал", True, "в рабочем конфиге ключа нет")

    print("5. Проверка собранного демона на порту %d" % PORT)
    # Демон проверяется **копией** exe во временной папке: при запуске он создаёт
    # рядом с собой журнал, папки наблюдения и закачек, и делать это в папке
    # релиза нельзя — её отдают человеку, а не запускают для проверки.
    #
    # Рабочий каталог задан отдельно и нарочно: все пути демон строит от каталога
    # exe, и в рабочем каталоге не должно появиться ни одного файла. Это и есть
    # проверка переносимости — «папка работает с любого диска и не зависит от
    # того, откуда её запустили».
    tmp = tempfile.mkdtemp(prefix="tc-release-check-")
    cwd = os.path.join(tmp, "чужой-рабочий-каталог")
    os.makedirs(cwd, exist_ok=True)
    probe = os.path.join(tmp, "torrclient.exe")
    shutil.copy2(exe, probe)
    proc = subprocess.Popen([probe, "-port", str(PORT), "-open=false", "-quiet"],
                            cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    hello = None
    try:
        for _ in range(40):
            time.sleep(0.25)
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/api/hello" % PORT, timeout=2) as r:
                    hello = json.loads(r.read().decode())
                break
            except Exception:
                continue
        step("демон отвечает", hello is not None)
        if hello:
            step("версия в exe — заказанная", hello.get("version") == ver, hello.get("version"))
            with urllib.request.urlopen("http://127.0.0.1:%d/app.js" % PORT, timeout=10) as r:
                served = r.read()
            disk = open(os.path.join(ROOT, "web", "app.js"), "rb").read()
            step("вшитый интерфейс совпадает с web/app.js байт в байт",
                 served == disk, "%d байт против %d" % (len(served), len(disk)))
            folders = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/api/folders" % PORT, timeout=10).read().decode())
            step("папки созданы рядом с программой, а не в рабочем каталоге",
                 os.path.isdir(os.path.join(tmp, "watch")) and os.path.isdir(os.path.join(tmp, "downloads")),
                 folders["watch"]["path"])
        step("в рабочем каталоге не появилось ни одного файла", os.listdir(cwd) == [], os.listdir(cwd))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass

    step("папка релиза осталась чистой", not [f for f, _ in tree(out) if os.path.basename(f) in FORBIDDEN])

    print("6. Состав релиза")
    total = 0
    for relpath, size in tree(out):
        print("      %9d  %s" % (size, relpath))
        total += size
    print("      %9d  всего (%d файлов)" % (total, len(tree(out))))

    zpath = os.path.join(rel, name + ".zip")
    # Архив пишется поверх прежнего: режим "w" обрезает файл на месте, а удалять
    # его нельзя по той же причине, что и папку сборки.
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, filenames in os.walk(out):
            for n in filenames:
                p = os.path.join(dirpath, n)
                z.write(p, os.path.join(name, os.path.relpath(p, out)))
    step("архив собран", os.path.exists(zpath), "%s — %d байт" % (zpath, os.path.getsize(zpath) if os.path.exists(zpath) else 0))

    print("\nитог: " + ("релиз собран — " + out if ok else "есть замечания"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
