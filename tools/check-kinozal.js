// check-kinozal.js — перебор зеркал Кинозала вживую.
//
// Домены Кинозала живут недолго: часть отвечает 403 (защита от ботов), часть не
// резолвится, часть открывается, но страницы выдачи не содержит. Список в
// kinozal.go протухает, и проверить его вручную — работа на полчаса.
//
// Проверка ходит в сеть намеренно, поэтому в гейты проекта (tools/check-all.py)
// не входит: гейты обязаны быть воспроизводимы без сети. Запуск — вручную,
// когда нужно понять, какое зеркало ожило:
//
//	node tools/check-kinozal.js
//
// Печатает по строке на хост: отвечает ли и отдаёт ли разметку выдачи.
// Разметка важнее кода ответа: страница может открыться и при этом быть
// заглушкой, из которой парсер не вытащит ни одной строки.

const HOSTS = [
  'kinozaltv.life',
  'kinozal.cloudns.nz',
  'kinozal.me',
  'kinozal.guru',
  'kinozal.tv',
  'tv.kinozal.app',
  'kinozal.jumpingcrab.com',
  'kinozal.club',
  'kinozal.bz',
  'kinozal.ist',
  'kinozal.shop',
  'kinozal.today',
];

// Тот же путь и тот же признак страницы выдачи, что в kinozal.go. Дублируются
// намеренно: инструмент проверяет живой сайт, а не парсер, и тащить сюда
// regexp-ы Go нельзя.
const PATH = '/browse.php?s=matrix&g=0&page=0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TIMEOUT_MS = 10000;

function pad(s, n) { return String(s).padEnd(n, ' '); }

async function probe(host) {
  const started = Date.now();
  try {
    const res = await fetch('https://' + host + PATH, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ru-RU,ru;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    const links = (body.match(/details\.php\?id=\d+/g) || []).length;
    const ms = Date.now() - started;
    if (!res.ok) return { host, verdict: 'ЗАКРЫТ ' + res.status, ms };
    if (!links) return { host, verdict: 'ОТКРЫТ, БЕЗ РАЗМЕТКИ', ms };
    return { host, verdict: 'ВЫДАЧА ОК (' + links + ')', ms };
  } catch (e) {
    const ms = Date.now() - started;
    const name = e && e.name ? e.name : 'ошибка';
    return { host, verdict: 'НЕ ОТВЕЧАЕТ (' + name + ')', ms };
  }
}

async function main() {
  console.log('Перебор зеркал Кинозала, путь ' + PATH);
  console.log('');
  const out = [];
  for (const h of HOSTS) out.push(await probe(h));
  for (const r of out) {
    console.log(pad(r.host, 28) + pad(r.ms + ' мс', 10) + r.verdict);
  }
  const alive = out.filter(r => r.verdict.indexOf('ВЫДАЧА ОК') === 0);
  console.log('');
  console.log('отдают выдачу: ' + alive.length + ' из ' + out.length);
  if (alive.length) console.log('рабочие: ' + alive.map(r => r.host).join(', '));
  else console.log('рабочих нет: список в kinozal.go пора чинить, а перебор молчал.');
}

main();
