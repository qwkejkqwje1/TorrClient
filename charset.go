package main

import (
	"strings"
)

// Кодировки страниц.
//
// Rutor отдаёт UTF-8, а Кинозал — windows-1251: об этом говорят и заголовок
// Content-Type, и <meta> внутри страницы. Go декодирует только UTF-8, поэтому
// байты старше 0x7F нужно переводить вручную.
//
// Внешних зависимостей в проекте нет и не будет (go.mod пуст), поэтому таблица
// соответствия вписана в исходник, а не взята из golang.org/x/text.

// cp1251High — знаки Unicode для байтов 0x80..0xFF кодировки windows-1251.
// Байты 0x00..0x7F совпадают с ASCII и в таблицу не входят: она короче и её
// проще сверить глазами. Значение 0x98 в windows-1251 не определено — на его
// месте стоит U+FFFD, чтобы битый байт был виден, а не превращался в мусор.
const cp1251High = "\u0402\u0403\u201a\u0453\u201e\u2026\u2020\u2021\u20ac\u2030" +
	"\u0409\u2039\u040a\u040c\u040b\u040f\u0452\u2018\u2019\u201c\u201d\u2022" +
	"\u2013\u2014\ufffd\u2122\u0459\u203a\u045a\u045c\u045b\u045f\u00a0\u040e" +
	"\u045e\u0408\u00a4\u0490\u00a6\u00a7\u0401\u00a9\u0404\u00ab\u00ac\u00ad" +
	"\u00ae\u0407\u00b0\u00b1\u0406\u0456\u0491\u00b5\u00b6\u00b7\u0451\u2116" +
	"\u0454\u00bb\u0458\u0405\u0455\u0457\u0410\u0411\u0412\u0413\u0414\u0415" +
	"\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421" +
	"\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d" +
	"\u042e\u042f\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439" +
	"\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445" +
	"\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f"

// cp1251Table — та же таблица, развёрнутая по индексу байта. Декодирование
// идёт по каждому байту страницы, и поиск в строке на каждый из них был бы
// заметно дороже.
var cp1251Table = func() [256]rune {
	var t [256]rune
	for i := range t {
		t[i] = rune(i)
	}
	for i, r := range []rune(cp1251High) {
		t[0x80+i] = r
	}
	return t
}()

// decodeCP1251 переводит байты windows-1251 в строку UTF-8.
func decodeCP1251(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.Grow(len(b))
	for _, c := range b {
		if c < 0x80 {
			sb.WriteByte(c)
			continue
		}
		sb.WriteRune(cp1251Table[c])
	}
	return sb.String()
}

// isCP1251 сообщает, объявлена ли windows-1251 — заголовком ответа или
// <meta> в начале страницы. Проверять нужно оба места: Кинозал ставит
// кодировку и там, и там, но зеркала делают это по-разному.
func isCP1251(contentType string, body []byte) bool {
	if declaresCP1251(contentType) {
		return true
	}
	head := body
	if len(head) > 2048 {
		head = head[:2048]
	}
	return declaresCP1251(string(head))
}

func declaresCP1251(s string) bool {
	s = strings.ToLower(s)
	if !strings.Contains(s, "charset") {
		return false
	}
	return strings.Contains(s, "1251")
}

// decodeBody приводит тело ответа к UTF-8. Для UTF-8 (Rutor) тело
// возвращается как есть — лишняя перекодировка только испортила бы его.
func decodeBody(body []byte, contentType string) string {
	if isCP1251(contentType, body) {
		return decodeCP1251(body)
	}
	return string(body)
}
