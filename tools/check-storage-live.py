"""Живая проверка разнесения кэша и постоянных данных.

Ходит в работающий демон на 127.0.0.1:8099 и проверяет то, что видно только
живьём: папки берутся из настроек, накопленное переезжает, журнал пишется в
папку кэша.

Файлы состояния в рабочей папке остаются нетронутыми: тестовые отметки живут во
временных папках, а в конце состояние возвращается на место тем же путём, что и
у пользователя, — из архива (`/api/restore`). Так вышло не сразу: первая версия
проверки писала отметку прямо в рабочую папку, и лежавший там `viewed.json` был
потерян. Проверка, которая портит то, что проверяет, — не проверка.

Запуск из корня проекта, при работающем демоне:

    python tools/check-storage-live.py
"""

import io
import json
import os
import shutil
import sys
import urllib.request
import zipfile

BASE = "http://127.0.0.1:8099"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(os.environ.get("TEMP", r"C:\Windows\Temp"), "tc-storage-live")
CACHE = os.path.join(TMP, "cache")
DATA1 = os.path.join(TMP, "data1")
DATA2 = os.path.join(TMP, "data2")
STATE = ["torrclient.json", "viewed.json", "userdata.json"]

ok = True


def check(name, cond, extra=""):
    global ok
    print(("  ок    | " if cond else "  ПЛОХО | ") + name + ((" — " + str(extra)) if extra else ""))
    if not cond:
        ok = False


def post(path, body, raw=None, ctype="application/json"):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": ctype}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        return json.loads(r.read().decode())


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def reset(*dirs):
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)


# Снимок состояния: и настройки, и склад. Пустые файлы создаются — так же, как
# их создаёт сама программа, — иначе возвращать было бы нечего.
for name in STATE:
    p = os.path.join(ROOT, name)
    if not os.path.exists(p):
        with open(p, "w", encoding="utf-8") as f:
            f.write("{}\n")
snapshot = {name: open(os.path.join(ROOT, name), "rb").read() for name in STATE}

reset(CACHE, DATA1, DATA2)

print("1. Папки берутся из настройки: %s" % TMP)
r = post("/api/profiles", {"action": "dirs", "cache_folder": CACHE, "data_folder": DATA1})
check("демон принял смену папок", r.get("ok") is True, r)
check("накопленное перенесено", sorted(r.get("moved") or []) == ["userdata.json", "viewed.json"], r.get("moved"))
check("перенос — это копия: рабочее состояние осталось на месте",
      all(os.path.exists(os.path.join(ROOT, n)) for n in ("viewed.json", "userdata.json")))
check("избранное доехало целым",
      read_json(os.path.join(DATA1, "userdata.json")) == json.loads(snapshot["userdata.json"] or b"{}"))

folders = get("/api/folders")
check("папка кэша — из настройки", folders["cache"]["path"] == CACHE, folders["cache"]["path"])
check("папка постоянных данных — из настройки", folders["data"]["path"] == DATA1, folders["data"]["path"])
check("папка кэша доступна на запись", folders["cache"]["ok"] is True, folders["cache"].get("reason"))
check("папка постоянных данных доступна на запись", folders["data"]["ok"] is True, folders["data"].get("reason"))

hello = get("/api/hello")
check("интерфейсу отданы обе папки",
      hello.get("cache_folder") == CACHE and hello.get("data_folder") == DATA1,
      (hello.get("cache_folder"), hello.get("data_folder")))

print("2. Отметка просмотра создаётся уже в новой папке постоянных данных")
post("/api/positions", {"hash": "deadbeef", "file_index": 1, "timecode": 42, "duration": 100})
mark1 = os.path.join(DATA1, "viewed.json")
check("файл отметок появился в новой папке", os.path.exists(mark1), mark1)
if os.path.exists(mark1):
    check("отметка записана в новый файл",
          read_json(mark1).get("deadbeef", {}).get("1", {}).get("pos") == 42, read_json(mark1))

print("3. Смена папки постоянных данных переносит накопленное")
r = post("/api/profiles", {"action": "dirs", "data_folder": DATA2})
check("перенос назван в ответе", "viewed.json" in (r.get("moved") or []), r.get("moved"))
mark2 = os.path.join(DATA2, "viewed.json")
check("отметки оказались в новой папке", os.path.exists(mark2), mark2)
if os.path.exists(mark2):
    check("содержимое сохранилось",
          read_json(mark2).get("deadbeef", {}).get("1", {}).get("pos") == 42, read_json(mark2))

print("4. Журнал пишется в папку кэша")
log = os.path.join(CACHE, "torrclient.log")
check("журнал в папке кэша", os.path.exists(log), log)
if os.path.exists(log):
    text = open(log, encoding="utf-8", errors="replace").read()
    check("в журнале назван перенос", "перенесены" in text, text.strip().splitlines()[-1][:120])

print("5. Состояние возвращается на место")
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    for name, body in snapshot.items():
        z.writestr(name, body)
post("/api/restore", None, raw=buf.getvalue(), ctype="application/zip")
back = get("/api/hello")
check("демон снова смотрит в каталог программы",
      back.get("cache_folder") == ROOT and back.get("data_folder") == ROOT, back.get("cache_folder"))
same = [n for n in STATE if open(os.path.join(ROOT, n), "rb").read() == snapshot[n]]
check("все файлы состояния вернулись байт в байт", len(same) == len(STATE), same)

shutil.rmtree(TMP, ignore_errors=True)
print("\nитог: " + ("все проверки пройдены" if ok else "есть отказы"))
sys.exit(0 if ok else 1)
