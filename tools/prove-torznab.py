# Живая приёмка прямого Torznab: поднимает эталонный индексатор на своём порту,
# добавляет его через настоящую ручку настроек, ищет и проверяет, что разбор по
# источникам и маскирование ключа работают так, как ждёт интерфейс.
#
# Запуск:  python tools\prove-torznab.py [порт] [путь к torrclient.json]
# Порт по умолчанию 8130 — корневой демон для разработки. Конфиг по умолчанию
# корневой; для проверки собранного релиза передаём его torrclient.json.

import io
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURE = os.path.join(ROOT, 'testdata', 'torznab_search.xml')
DAEMON_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8130
CONFIG = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(ROOT, 'torrclient.json')
IDX_PORT = 8791
KEY = 'LIVE-SECRET-KEY-9876'

fails = []
last_search_query = {}


def check(ok, label, detail=''):
    print(('  ok   ' if ok else '  FAIL') + ' | ' + label + ((' — ' + str(detail)) if detail else ''))
    if not ok:
        fails.append(label)


def get(url, body=None):
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data)
    if data is not None:
        req.add_header('Content-Type', 'application/json; charset=utf-8')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8')
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {'error': raw}


class Indexer(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/lastquery':
            return self.reply(200, json.dumps(last_search_query, ensure_ascii=False).encode('utf-8'),
                              'application/json; charset=utf-8')
        q = parse_qs(u.query)
        t = (q.get('t') or [''])[0]
        if t == 'caps':
            body = ('<?xml version="1.0" encoding="UTF-8"?><caps>'
                    '<server title="Приёмка"/><searching>'
                    '<search available="yes" supportedParams="q"/>'
                    '<tv-search available="yes"/>'
                    '<movie-search available="no"/></searching></caps>').encode('utf-8')
        elif t == 'search':
            if (q.get('apikey') or [''])[0] != KEY:
                self.send_error(403)
                return
            last_search_query.clear()
            last_search_query.update({k: v[0] for k, v in q.items()})
            with io.open(FIXTURE, 'rb') as f:
                body = f.read()
        else:
            self.send_error(400)
            return
        self.reply(200, body, 'application/xml; charset=utf-8')

    def reply(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    idx = ThreadingHTTPServer(('127.0.0.1', IDX_PORT), Indexer)
    threading.Thread(target=idx.serve_forever, daemon=True).start()
    print('Эталонный индексатор: http://127.0.0.1:%d, ключ %s' % (IDX_PORT, KEY))
    base = 'http://127.0.0.1:%d' % DAEMON_PORT

    try:
        print('\n1. Проверка индексатора ничего не сохраняет')
        st, r = get(base + '/api/torznab/sources')
        check(st == 200 and r.get('sources') == [], 'до проверки список пуст', r)
        st, r = get(base + '/api/torznab/test', {
            'name': 'Приёмка', 'url': 'http://127.0.0.1:%d/api' % IDX_PORT, 'api_key': KEY})
        check(r.get('ok') is True, 'живой индексатор признан рабочим', r.get('error'))
        check(r.get('items') == 3, 'пробный поиск вернул раздачи', r.get('items'))
        check(r.get('caps', {}).get('search') and r.get('caps', {}).get('tv_search')
              and not r.get('caps', {}).get('movie_search'), 'capabilities прочитаны', r.get('caps'))
        st, after = get(base + '/api/torznab/sources')
        check(after.get('sources') == [], 'проверка ничего не записала', after)

        print('\n2. Ключ не уходит наружу')
        st, r = get(base + '/api/torznab/test', {
            'name': 'Без ключа', 'url': 'http://127.0.0.1:%d/api' % IDX_PORT})
        check(r.get('ok') is False and 'ключ' in r.get('error', ''),
              'без ключа индексатор отказал и это названо', r.get('error'))

        print('\n3. Добавление источника и поиск')
        st, r = get(base + '/api/torznab/sources', {'sources': [
            {'name': 'Приёмка', 'url': 'http://127.0.0.1:%d/api/' % IDX_PORT, 'api_key': KEY}]})
        check(st == 200, 'источник добавлен', r)
        raw = json.dumps(r, ensure_ascii=False)
        check(KEY not in raw, 'ключ не утёк в ответ списка', raw[:200])
        check('has_key' in raw and 'key_hint' in raw, 'ключ показан маской', raw[:200])
        cfg = json.load(io.open(CONFIG, encoding='utf-8'))
        saved = cfg.get('torznab_sources') or []
        check(len(saved) == 1 and saved[0].get('api_key') == KEY, 'ключ сохранён в конфиге %s' % CONFIG, saved)
        check(len(saved) == 1 and saved[0]['url'].endswith('/api'), 'слеш убран из адреса',
              saved[0]['url'] if saved else None)

        st, r = get(base + '/api/torznab/search?query=matrix&page=0')
        check(st == 200, 'поиск отдал 200', st)
        items = r.get('items') or []
        check(len(items) == 3, 'раздачи доехали', len(items))
        check(items[0].get('seed') == 120, 'сиды на месте', items[0].get('seed'))
        check((items[0].get('magnet') or '').startswith('magnet:?xt=urn:btih:'), 'magnet на месте', items[0].get('magnet'))
        check('Матрица 1999 1080p BluRay & HDR' in (items[0].get('title') or ''),
              'сущности XML не сломали заголовок', items[0].get('title'))
        check('приёмка' in json.dumps(r, ensure_ascii=False).lower(),
              'имя источника сохранено как задано', (r.get('sources') or [{}])[0].get('name'))
        srcs = r.get('sources') or []
        check(len(srcs) == 1 and srcs[0].get('ok'), 'разбор по источникам приложен', srcs)
        check(len(r.get('sources')) and 'ms' in r['sources'][0], 'время ответа замерено', srcs[0].get('ms'))

        print('\n3b. Проверка от живого индексатора по сохранённому имени')
        st, r = get(base + '/api/torznab/test', {'name': 'Приёмка'})
        check(r.get('ok') is True, 'проверка по имени сохранённого источника работает', r.get('error'))

        print('\n4. Кэш и пагинация')
        st, r2 = get(base + '/api/torznab/search?query=matrix&page=0')
        check(len(r2.get('items') or []) == 3, 'повторный поиск отдаёт то же', len(r2.get('items') or []))
        st, r3 = get(base + '/api/torznab/search?query=matrix&page=1')
        check(st == 200, 'вторая страница запрошена без ошибки', st)
        check((r3.get('sources') or [{}])[0].get('name') == 'Приёмка',
              'вторая страница пришла с живого источника, а не из кэша',
              (r3.get('sources') or [{}])[0].get('name'))
        st, lq = get('http://127.0.0.1:%d/lastquery' % IDX_PORT)
        check(lq.get('offset') == '100', 'вторая страница ушла к индексатору со смещением 100', lq)
        check(lq.get('q') == 'matrix', 'запрос за поиском ушёл с искомым словом', lq)

        print('\n5. Удаление и «источник недоступен»')
        st, r = get(base + '/api/torznab/sources', {'remove': 'Приёмка'})
        check(r.get('sources') == [], 'источник удалён', r)
        st, r = get(base + '/api/torznab/search?query=matrix')
        check(st == 503 and 'не настроены' in r.get('error', ''), 'после удаления поиск объясняет причину', r)
    finally:
        idx.shutdown()

    print('\n' + ('ПРОВАЛОВ: %d' % len(fails) if fails else 'живая приёмка пройдена'))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
