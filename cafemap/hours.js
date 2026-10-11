// OpenStreetMap の opening_hours をざっくり解釈して「今あいてる？」を返す
// よくある書き方（Mo-Fr 08:00-18:00; Sa,Su 09:00-17:00 / 24/7 / off）に対応。
// 祝日(PH)や月指定など、読めない書き方は「時間不明」にする。
(function (root) {
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const JP = ["月", "火", "水", "木", "金", "土", "日"];

  function parseDays(str) {
    const set = new Set();
    for (const part of str.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const m = p.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
      if (!m) return null;
      const a = DAYS.indexOf(m[1]);
      const b = m[2] ? DAYS.indexOf(m[2]) : a;
      for (let i = a; ; i = (i + 1) % 7) {
        set.add(i);
        if (i === b) break;
      }
    }
    return set;
  }

  function toMin(t) {
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return +m[1] * 60 + +m[2];
  }

  function parseTimes(str) {
    const out = [];
    for (const part of str.split(",")) {
      const p = part.trim();
      const m = p.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/);
      if (!m) return null;
      const s = toMin(m[1]);
      let e = toMin(m[2]);
      if (s == null || e == null) return null;
      if (e <= s) e += 24 * 60; // 日をまたぐ
      out.push([s, e]);
    }
    return out;
  }

  // 戻り値: week[0..6] = [[start,end],...]（分）、読めなければ null
  function parse(spec) {
    if (!spec || typeof spec !== "string") return null;
    const s = spec.trim();
    if (s === "24/7") return Array.from({ length: 7 }, () => [[0, 1440]]);
    const week = Array.from({ length: 7 }, () => null);
    let anyRule = false;
    for (let rule of s.split(";")) {
      rule = rule.trim();
      if (!rule) continue;
      if (/^PH\b/.test(rule)) continue; // 祝日ルールは無視
      rule = rule.replace(/,\s*PH\b/g, "").replace(/\bPH\s*,/g, "");
      let m = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,]\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+(.+)$/);
      let days, rest;
      if (m) {
        days = parseDays(m[1].replace(/\s+/g, ""));
        rest = m[2].trim();
      } else {
        days = new Set([0, 1, 2, 3, 4, 5, 6]);
        rest = rule;
      }
      if (!days) return null;
      let times;
      if (/^(off|closed)$/i.test(rest)) times = [];
      else {
        times = parseTimes(rest);
        if (!times) return null;
      }
      for (const d of days) week[d] = times; // 後のルールが上書き
      anyRule = true;
    }
    if (!anyRule) return null;
    return week.map((x) => x || []);
  }

  const fmt = (m) => {
    m = ((m % 1440) + 1440) % 1440;
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  };

  // date: Date。戻り値 {state:'open'|'closed'|'unknown', label}
  function status(spec, date) {
    const week = parse(spec);
    if (!week) return { state: "unknown", label: "営業時間不明" };
    const d = (date.getDay() + 6) % 7; // 0=月
    const now = date.getHours() * 60 + date.getMinutes();
    const prev = (d + 6) % 7;
    // 前日から続く営業
    for (const [s, e] of week[prev]) {
      if (e > 1440 && now < e - 1440) return { state: "open", label: `営業中 · ${fmt(e)}まで` };
    }
    for (const [s, e] of week[d]) {
      if (now >= s && now < e) {
        if (s === 0 && e >= 1440) return { state: "open", label: "営業中 · 24時間" };
        return { state: "open", label: `営業中 · ${fmt(e)}まで` };
      }
    }
    const later = week[d].filter(([s]) => s > now).sort((a, b) => a[0] - b[0]);
    if (later.length) return { state: "closed", label: `準備中 · ${fmt(later[0][0])}から` };
    for (let k = 1; k <= 7; k++) {
      const dd = (d + k) % 7;
      if (week[dd].length) {
        const first = week[dd].slice().sort((a, b) => a[0] - b[0])[0];
        const when = k === 1 ? "明日" : `${JP[dd]}曜`;
        return { state: "closed", label: `営業時間外 · ${when}${fmt(first[0])}から` };
      }
    }
    return { state: "closed", label: "営業時間外" };
  }

  // 表示用：曜日ごとの営業時間
  function table(spec) {
    const week = parse(spec);
    if (!week) return null;
    return week.map((t, i) => ({
      day: JP[i],
      text: t.length ? t.map(([s, e]) => `${fmt(s)}–${fmt(e)}`).join(", ") : "定休",
    }));
  }

  root.CafeHours = { parse, status, table };
  if (typeof module !== "undefined") module.exports = root.CafeHours;
})(typeof window !== "undefined" ? window : globalThis);
