#!/usr/bin/env node
'use strict';

// Проверка страницы-оболочки окна.
//
// Оболочка показывает «Запуск TorrClient...», пока демон не ответит, и уводит
// окно на его интерфейс. Ошибка здесь тихая: без пути ошибки сломанный демон
// выглядит как бесконечный запуск, и связать это с причиной пользователю нечем.
//
// Имя события связывает страницу с программой. Оно живёт в двух файлах —
// в app/app.go и в app/frontend/dist/index.html, — и разойтись им нельзя:
// страница просто перестанет слышать сообщения, а заметить это можно было бы
// только живым запуском со сломанным TorrServer.
//
// Порядок проверок не случаен: сравнение исходника с собранной страницей стоит
// последним. Любая правка одной только страницы роняет и его, и проверку по
// существу — а доказательство правки должно показывать именно проверку по
// существу, а не «файлы разошлись».

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failed = 0;

function check(name, ok, detail) {
    console.log((ok ? '  ок   ' : '  ПЛОХО') + ' | ' + name + (detail ? ' — ' + detail : ''));
    if (!ok) {
        failed++;
    }
}

function read(rel) {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

const pagePath = 'app/frontend/dist/index.html';
const srcPath = 'app/frontend/index.html';
const goPath = 'app/app.go';

const page = read(pagePath);
const src = read(srcPath);
const go = read(goPath);

// 1. Встроенный скрипт разбирается: страница со сломанным скриптом не уводит
// окно никуда и не показывает ничего.
const script = page.match(/<script>([\s\S]*?)<\/script>/);
let parses = false;
let why = 'скрипт не найден';
if (script) {
    try {
        new Function(script[1]);
        parses = true;
        why = '';
    } catch (e) {
        why = e.message;
    }
}
check('встроенный скрипт разбирается', parses, why);

// 2. Имя события одно на двоих.
const goEvent = (go.match(/problemEvent\s*=\s*"([^"]+)"/) || [])[1];
check('имя события объявлено в программе', !!goEvent, goEvent || 'problemEvent не найдено');
if (goEvent) {
    check(
        'страница подписана на то же имя события',
        page.includes('"' + goEvent + '"'),
        goEvent
    );
}

// 3. У страницы есть путь ошибки: без него сломанный демон выглядит как
// бесконечный запуск.
check(
    'страница умеет показать беду',
    /patientSeconds/.test(page) && /не удалось запустить|не отвечает/.test(page)
);

// 4. Демон всё ещё уводит окно на свой интерфейс — ради этого страница и нужна.
check(
    'страница уводит окно на интерфейс демона',
    /location\.replace\("http:\/\/127\.0\.0\.1:8099\/"\)/.test(page)
);

// 5. Собранная страница и её исходник совпадают: правится обычно одна, и
// вторая молча остаётся старой.
check(
    'исходник и собранная страница совпадают',
    page === src,
    page === src ? '' : 'app/frontend/index.html отличается от dist/index.html'
);

console.log('\n' + (failed === 0 ? 'все проверки пройдены' : 'ПРОВАЛОВ: ' + failed));
process.exit(failed === 0 ? 0 : 1);
