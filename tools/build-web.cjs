// Сборка web/app.js из частей web/src/*.js (по имени файла, по порядку).
//
// Интерфейс правится в web/src — небольшие файлы по разделам. web/app.js —
// результат склейки байт в байт: его по-прежнему отдаёт демон и читают
// инструменты проверки, поэтому ни программа, ни проверки не меняются.
//   node tools/build-web.cjs          — собрать web/app.js
//   node tools/build-web.cjs --check  — только сверить (для CI и go test)
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'web', 'src');
const out = path.join(__dirname, '..', 'web', 'app.js');
const parts = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
const code = parts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur !== code) {
    console.error('web/app.js не совпадает со склейкой web/src/*.js — запустите: node tools/build-web.cjs');
    process.exit(1);
  }
  console.log('web/app.js собран из ' + parts.length + ' частей — совпадает');
} else {
  fs.writeFileSync(out, code);
  console.log('web/app.js собран из ' + parts.length + ' частей, строк: ' + code.split('\n').length);
}
