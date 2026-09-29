// Проверка оценки качества раздачи (rateRelease): берёт блок из web/app.js и
// гоняет его на названиях, похожих на настоящие раздачи rutor/Кинозала.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../web/app.js', 'utf8');
const m = src.match(/\/\* QUALITY-BEGIN \*\/([\s\S]*?)\/\* QUALITY-END \*\//);
if (!m) { console.error('блок QUALITY не найден'); process.exit(1); }
const { rateRelease, playVerdict } = new Function(m[1] + '; return { rateRelease, rateTip, playVerdict };')();
let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.error('FAIL: ' + msg); } };
const r = (title, seed, gb) => rateRelease({ title, seed, size_bytes: gb ? gb * 1e9 : 0 });

const remux = r('Матрица / The Matrix (1999) BDRemux 2160p HDR Dolby Vision | Дубляж', 300, 60);
ok(remux.res === '4K' && remux.source === 'Remux' && remux.hdr && remux.ru && remux.audio === 'Дубляж', 'remux 4K: ' + JSON.stringify(remux));
const web = r('Фильм (2023) WEB-DL 1080p | MVO', 120, 4);
ok(web.res === '1080p' && web.source === 'WEB-DL' && web.audio === 'Многоголосый', 'web-dl: ' + JSON.stringify(web));
const cam = r('Фильм (2024) CAMRip 720p | Дубляж', 500, 1.5);
ok(cam.bad && cam.score <= 15, 'экранка должна быть внизу: ' + cam.score);
const orig = r('Movie (2022) BDRip 1080p x265 Original ENG + Subs', 50, 3);
ok(!orig.ru, 'без русской дорожки: ' + JSON.stringify(orig));
ok(remux.score > web.score && web.score > orig.score && orig.score > cam.score, 'порядок оценок: ' + [remux, web, orig, cam].map(x => x.score));
ok(r('Фильм 1080p WEB-DL Дубляж', 0, 4).score <= 30, 'без сидов потолок 30');
ok(r('Фильм 1080p WEB-DL Дубляж', 100, 0.3).notes.some(n => /мал/.test(n)), 'подозрительно малый размер');
const sd = r('Старый фильм DVDRip Лицензия', 20, 1.4);
ok(sd.res === 'SD' && sd.source === 'DVD' && sd.ru, 'dvdrip: ' + JSON.stringify(sd));
ok(rateRelease({}).score >= 0 && rateRelease(null).score >= 0, 'пустой ввод не падает');
const bad = playVerdict({ streams: [{ codec_type: 'video', codec_name: 'hevc' }, { codec_type: 'audio', codec_name: 'dts', tags: { language: 'rus' } }] });
ok(!bad.ok && bad.ru && bad.problems.length === 2 && /внешнем плеере/.test(bad.text), 'HEVC+DTS не играет: ' + JSON.stringify(bad));
const good = playVerdict({ streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }] });
ok(good.ok && !good.ru, 'H264+AAC играет: ' + JSON.stringify(good));
ok(playVerdict(null).ok, 'пустой ответ не падает');
if (fail) process.exit(1);
console.log('quality: ok');
