"use strict";

const API_URL = "https://ja.wikipedia.org/w/api.php";
const SEARCH_LIMIT = 40;
const DETAIL_CHUNK = 20; // extracts は1回のリクエストで最大20件まで
const MASK = "○○";
const MAX_TEXT_LENGTH = 160;

// ---------- Wikipedia からデータを取る ----------

async function wikiQuery(params) {
  const url = new URL(API_URL);
  const all = { action: "query", format: "json", formatversion: "2", origin: "*", ...params };
  for (const [key, value] of Object.entries(all)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url);
  if (res.status === 429) throw new Error("Wikipedia が混み合っています。少し待ってからもう一度試してください。");
  if (!res.ok) throw new Error(`Wikipedia へのアクセスに失敗しました (HTTP ${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.info);
  return data;
}

async function fetchPages(theme) {
  const search = await wikiQuery({
    list: "search",
    srsearch: theme,
    srlimit: SEARCH_LIMIT,
    srnamespace: 0,
    srprop: "",
  });
  const titles = search.query.search.map((r) => r.title);
  const rank = new Map(titles.map((t, i) => [t, i]));

  const pages = [];
  for (let i = 0; i < titles.length; i += DETAIL_CHUNK) {
    const data = await wikiQuery({
      prop: "extracts|categories|pageprops",
      titles: titles.slice(i, i + DETAIL_CHUNK).join("|"),
      exintro: 1,
      explaintext: 1,
      exlimit: DETAIL_CHUNK,
      cllimit: "max",
      clshow: "!hidden",
      ppprop: "disambiguation",
    });
    pages.push(...(data.query.pages || []));
  }

  return pages
    .filter((p) => !p.missing && p.extract && !(p.pageprops && "disambiguation" in p.pageprops))
    .sort((a, b) => (rank.get(a.title) ?? 999) - (rank.get(b.title) ?? 999));
}

// ---------- 問題を組み立てる ----------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 「ビール (曲)」のような曖昧さ回避の括弧を外した表示名
function displayName(title) {
  return title.replace(/\s*[（(][^（）()]*[）)]$/, "").trim();
}

// 伏せ字の直後にある読みや別名の括弧書きは答えのヒントになるので消す
function removeParenAfterMask(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const next = text.indexOf(MASK, i);
    if (next === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, next + MASK.length);
    let j = next + MASK.length;
    while (text[j] === " ") j++;
    if (text[j] === "（" || text[j] === "(") {
      let depth = 0;
      let k = j;
      for (; k < text.length; k++) {
        if (text[k] === "（" || text[k] === "(") depth++;
        if (text[k] === "）" || text[k] === ")") depth--;
        if (depth === 0) break;
      }
      i = k < text.length ? k + 1 : j;
    } else {
      i = j;
    }
  }
  return out;
}

function toKatakana(s) {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

// 書き出しの「麒麟麦酒株式会社（きりんビール、英: Kirin Brewery …）は」から、
// 主語の部分と括弧内の読み・外国語名を取り出し、括弧書きは本文から消す
function splitLead(text) {
  const parens = [];
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "（" || c === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if ((c === "）" || c === ")") && depth > 0) {
      depth--;
      if (depth === 0) parens.push([start, i + 1]);
    } else if (depth === 0 && (c === "は" || c === "。") && i > 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return { text, terms: [] };

  const terms = [];
  let lead = "";
  let pos = 0;
  for (const [s, e] of parens) {
    lead += text.slice(pos, s);
    pos = e;
    for (let seg of text.slice(s + 1, e - 1).split(/[、，;；]/)) {
      seg = seg.replace(/^[^:：]*[:：]\s*/, "").trim();
      if (seg.length >= 2 && seg.length <= 40) terms.push(seg, toKatakana(seg));
    }
  }
  lead = (lead + text.slice(pos, end)).replace(/と$/, "").replace(/[『』「」]/g, "").trim();
  if (lead.length >= 2 && lead.length <= 30) {
    terms.push(lead, lead.replace(/[・\s]/g, ""));
    for (const part of lead.split("・")) {
      if (part.length >= 3) terms.push(part);
    }
  }
  const rest = parens.reduceRight((t, [s, e]) => t.slice(0, s) + t.slice(e), text.slice(0, end)) + text.slice(end);
  return { text: rest, terms };
}

function makeQuestionText(extract, name) {
  const lead = splitLead(extract.replace(/\s+/g, " ").trim());
  let text = lead.text;
  const variants = [...new Set([name, name.replace(/[・\s]/g, ""), ...lead.terms])]
    .filter((v) => v.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const v of variants) {
    text = text.replace(new RegExp(escapeRegExp(v), "gi"), MASK);
  }
  text = removeParenAfterMask(text);

  const sentences = text.match(/[^。]+。?/g) || [text];
  let out = "";
  for (const s of sentences) {
    if (out && (out + s).length > MAX_TEXT_LENGTH) break;
    out += s;
  }
  if (out.length > MAX_TEXT_LENGTH + 20) out = out.slice(0, MAX_TEXT_LENGTH) + "…";
  return out.trim();
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toItems(pages) {
  const seen = new Set();
  const items = [];
  for (const p of pages) {
    const name = displayName(p.title);
    if (!name || seen.has(name) || /一覧/.test(name)) continue;
    const text = makeQuestionText(p.extract, name);
    if (text.length < 30) continue;
    seen.add(name);
    items.push({
      title: p.title,
      name,
      text,
      categories: (p.categories || []).map((c) => c.title),
    });
  }
  return items;
}

// 同じカテゴリに属する記事ほど、それらしい「はずれ選択肢」になる
function pickDistractors(item, items) {
  const cats = new Set(item.categories);
  return items
    .filter((o) => o !== item && !o.name.includes(item.name) && !item.name.includes(o.name) && !item.text.includes(o.name))
    .map((o) => ({ o, score: o.categories.filter((c) => cats.has(c)).length + Math.random() * 0.5 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.o);
}

function buildQuestions(items, count) {
  // 検索で上位の記事ほどテーマに近いので、上位から多めに候補を取って混ぜる
  const candidates = shuffle(items.slice(0, Math.max(count * 2, 20)));
  const questions = [];
  for (const item of candidates) {
    if (questions.length >= count) break;
    const distractors = pickDistractors(item, items);
    if (distractors.length < 3) continue;
    questions.push({
      answer: item,
      text: item.text,
      choices: shuffle([item, ...distractors]),
    });
  }
  return questions;
}

async function createQuiz(theme, count) {
  const pages = await fetchPages(theme);
  const items = toItems(pages);
  const questions = buildQuestions(items, count);
  if (questions.length < 3) {
    throw new Error(`「${theme}」に関する記事が少なくて、問題を作れませんでした。別の言葉で試してみてください。`);
  }
  return questions;
}

function articleUrl(title) {
  return "https://ja.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
}

// ---------- 画面 ----------

function initApp() {
  const $ = (id) => document.getElementById(id);
  const screens = ["start", "loading", "quiz", "result"];

  const state = { theme: "", count: 10, questions: [], index: 0, answers: [] };

  function show(name) {
    for (const s of screens) $(s).hidden = s !== name;
    window.scrollTo(0, 0);
  }

  function showError(message) {
    $("error").textContent = message;
    $("error").hidden = false;
    show("start");
  }

  async function start(theme, count) {
    state.theme = theme;
    state.count = count;
    $("error").hidden = true;
    $("loading-text").textContent = `「${theme}」のクイズを作っています…`;
    show("loading");

    const url = new URL(location.href);
    url.searchParams.set("theme", theme);
    history.replaceState(null, "", url);

    try {
      state.questions = await createQuiz(theme, count);
    } catch (e) {
      showError(e.message || "クイズを作れませんでした。");
      return;
    }
    state.index = 0;
    state.answers = [];
    $("quiz-theme").textContent = `テーマ: ${theme}`;
    renderQuestion();
    show("quiz");
  }

  function renderQuestion() {
    const q = state.questions[state.index];
    $("progress").textContent = `${state.index + 1} / ${state.questions.length}`;
    $("question").textContent = q.text;
    $("feedback").hidden = true;

    const choices = $("choices");
    choices.replaceChildren();
    q.choices.forEach((choice, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${i + 1}. ${choice.name}`;
      button.addEventListener("click", () => answer(choice, button));
      choices.append(button);
    });
    window.scrollTo(0, 0);
  }

  function answer(choice, button) {
    const q = state.questions[state.index];
    const correct = choice === q.answer;
    state.answers.push({ question: q, choice, correct });

    const buttons = $("choices").querySelectorAll("button");
    buttons.forEach((b, i) => {
      b.disabled = true;
      if (q.choices[i] === q.answer) b.classList.add("correct");
    });
    if (!correct) button.classList.add("wrong");

    $("feedback-text").textContent = correct ? "⭕ 正解！" : `❌ 残念… 正解は「${q.answer.name}」`;
    $("source-link").textContent = `Wikipedia で「${q.answer.name}」を読む`;
    $("source-link").href = articleUrl(q.answer.title);
    const isLast = state.index === state.questions.length - 1;
    $("next").textContent = isLast ? "結果を見る" : "次の問題へ";
    $("feedback").hidden = false;
    $("feedback").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function next() {
    if (state.index < state.questions.length - 1) {
      state.index++;
      renderQuestion();
    } else {
      renderResult();
      show("result");
    }
  }

  function renderResult() {
    const total = state.answers.length;
    const score = state.answers.filter((a) => a.correct).length;
    const ratio = score / total;
    $("score").textContent = `${score} / ${total} 問正解`;
    $("comment").textContent =
      ratio === 1 ? "完璧！ テーマの達人です 🎉"
        : ratio >= 0.7 ? "すごい！ かなり詳しいですね"
        : ratio >= 0.4 ? "なかなかの健闘！"
        : "次はがんばろう！";

    const review = $("review");
    review.replaceChildren();
    for (const a of state.answers) {
      const li = document.createElement("li");
      const mark = document.createElement("span");
      mark.className = a.correct ? "mark-correct" : "mark-wrong";
      mark.textContent = a.correct ? "⭕ " : "❌ ";
      const link = document.createElement("a");
      link.href = articleUrl(a.question.answer.title);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = a.question.answer.name;
      li.append(mark, link);
      if (!a.correct) {
        const yours = document.createElement("span");
        yours.className = "your-answer";
        yours.textContent = `（あなたの答え: ${a.choice.name}）`;
        li.append(yours);
      }
      review.append(li);
    }
  }

  $("start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const theme = $("theme").value.trim();
    if (theme) start(theme, Number($("count").value));
  });

  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      $("theme").value = chip.textContent;
      $("theme").focus();
    });
  }

  $("next").addEventListener("click", next);
  $("quit").addEventListener("click", () => show("start"));
  $("retry").addEventListener("click", () => start(state.theme, state.count));
  $("new-theme").addEventListener("click", () => {
    $("theme").value = "";
    show("start");
    $("theme").focus();
  });

  const initialTheme = new URLSearchParams(location.search).get("theme");
  if (initialTheme) $("theme").value = initialTheme.slice(0, 50);
}

if (typeof document !== "undefined") {
  initApp();
} else if (typeof module !== "undefined") {
  module.exports = { createQuiz, makeQuestionText, displayName };
}
