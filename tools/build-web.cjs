// Сборка web/app.js из частей web/src/*.js и web/style.css из web/css/*.css
// (по имени файла, по порядку).
//
// Интерфейс правится в web/src (скрипты) и web/css (стили) — небольшие файлы по
// разделам. web/app.js и web/style.css — результат склейки байт в байт: их по-
// прежнему отдаёт демон и читают инструменты проверки, поэтому ни программа, ни
// проверки не меняются.
//   node tools/build-web.cjs          — собрать оба файла
//   node tools/build-web.cjs --check  — только сверить (для CI и go test)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'web');
const targets = [
  { dir: 'src', ext: '.js', out: 'app.js' },
  { dir: 'css', ext: '.css', out: 'style.css' },
];
let bad = false;
for (const t of targets) {
  const dir = path.join(root, t.dir);
  const out = path.join(root, t.out);
  if (!fs.existsSync(dir)) continue;
  const parts = fs.readdirSync(dir).filter(f => f.endsWith(t.ext)).sort();
  const code = parts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (cur !== code) {
      console.error('web/' + t.out + ' не совпадает со склейкой web/' + t.dir + '/*' + t.ext + ' — запустите: node tools/build-web.cjs');
      bad = true;
    } else console.log('web/' + t.out + ' собран из ' + parts.length + ' частей — совпадает');
  } else {
    fs.writeFileSync(out, code);
    console.log('web/' + t.out + ' собран из ' + parts.length + ' частей, строк: ' + code.split('\n').length);
  }
}
if (bad) process.exit(1);
