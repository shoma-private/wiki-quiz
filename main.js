"use strict";

const API_URL = "https://ja.wikipedia.org/w/api.php";
const SEARCH_LIMIT = 40;
const DETAIL_CHUNK = 20; // extracts は1回のリクエストで最大20件まで
const TITLES_PER_QUERY = 50;
const MAX_POOL_TITLES = 100;
const MASK = "○○";
const BLANK = "【 ？ 】";
const MAX_TEXT_LENGTH = 160;
const SKIP_SECTIONS = /脚注|注釈|出典|参考|関連項目|外部リンク|関連書籍|ギャラリー/;
const LEADING_CONNECTOR = /^(また|なお|さらに|一方|ただし|しかし|そのため|このため)、/;
const UNCLEAR_SUBJECT = /^(これ|それ|この|その|同|彼|彼女|ここ|そこ|上記|前者|後者)/;

// ---------- Wikipedia からデータを取る ----------

async function apiGet(params) {
  const url = new URL(API_URL);
  const all = { format: "json", formatversion: "2", origin: "*", ...params };
  for (const [key, value] of Object.entries(all)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url);
  if (res.status === 429) throw new Error("Wikipedia が混み合っています。少し待ってからもう一度試してください。");
  if (!res.ok) throw new Error(`Wikipedia へのアクセスに失敗しました (HTTP ${res.status})`);
  return res.json();
}

async function wikiQuery(params) {
  const data = await apiGet({ action: "query", ...params });
  if (data.error) throw new Error(data.error.info);
  return data;
}

async function wikiParse(page) {
  const data = await apiGet({
    action: "parse",
    page,
    redirects: 1,
    prop: "text|properties",
    disableeditsection: 1,
    disabletoc: 1,
  });
  if (data.error) {
    if (data.error.code === "missingtitle" || data.error.code === "invalidtitle") return null;
    throw new Error(data.error.info);
  }
  return data.parse;
}

function isDisambiguation(parsed) {
  const props = parsed.properties || {};
  return Array.isArray(props) ? props.some((p) => p.name === "disambiguation") : "disambiguation" in props;
}

// テーマの記事を探す。「人参」→「ニンジン」のような転送にも対応し、
// 見つからないときや曖昧さ回避ページのときは検索の上位から選ぶ
async function resolveArticle(theme) {
  const direct = await wikiParse(theme);
  if (direct && !isDisambiguation(direct)) return direct;

  const search = await wikiQuery({ list: "search", srsearch: theme, srlimit: 2, srnamespace: 0, srprop: "" });
  for (const r of search.query.search) {
    const parsed = await wikiParse(r.title);
    if (parsed && !isDisambiguation(parsed)) return parsed;
  }
  return null;
}

async function fetchCategories(titles) {
  const result = new Map(titles.map((t) => [t, new Set()]));
  for (let i = 0; i < titles.length; i += TITLES_PER_QUERY) {
    const chunk = titles.slice(i, i + TITLES_PER_QUERY);
    const alias = new Map();
    let cont = {};
    for (let guard = 0; guard < 5; guard++) {
      const data = await wikiQuery({
        prop: "categories",
        titles: chunk.join("|"),
        cllimit: "max",
        clshow: "!hidden",
        redirects: 1,
        ...cont,
      });
      for (const r of [...(data.query.normalized || []), ...(data.query.redirects || [])]) {
        alias.set(r.from, r.to);
      }
      const pageCats = new Map((data.query.pages || []).map((p) => [p.title, (p.categories || []).map((c) => c.title)]));
      for (const original of chunk) {
        let resolved = original;
        for (let n = 0; n < 3 && alias.has(resolved); n++) resolved = alias.get(resolved);
        for (const c of pageCats.get(resolved) || []) result.get(original).add(c);
      }
      if (!data.continue) break;
      cont = data.continue;
    }
  }
  return result;
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

// ---------- 共通の小物 ----------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 「ビール (曲)」のような曖昧さ回避の括弧を外した表示名
function displayName(title) {
  return title.replace(/\s*[（(][^（）()]*[）)]$/, "").trim();
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function articleUrl(title, sectionId) {
  const base = "https://ja.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
  return sectionId ? `${base}#${encodeURIComponent(sectionId)}` : base;
}

// ---------- 記事の本文から穴埋め問題を作る ----------

function linkTarget(a) {
  const href = a.getAttribute("href") || "";
  const title = a.getAttribute("title");
  if (!href.startsWith("/wiki/") || !title || title.includes(":") || a.classList.contains("new")) return null;
  return title;
}

// 段落を文に分け、文ごとに「どこがどの記事へのリンクか」を記録する
function splitBlock(block, section, sectionId) {
  let text = "";
  const links = [];
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue;
    const a = node.parentElement.closest("a");
    const target = a && block.contains(a) ? linkTarget(a) : null;
    if (target) {
      const last = links[links.length - 1];
      if (last && last.el === a) last.end += value.length;
      else links.push({ el: a, target, start: text.length, end: text.length + value.length });
    }
    text += value;
  }

  const sentences = [];
  const re = /[^。！？]+[。！？]?/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    sentences.push({
      raw: m[0],
      section,
      sectionId,
      links: links
        .filter((l) => l.start >= start && l.end <= end)
        .map((l) => ({ text: text.slice(l.start, l.end).trim(), target: l.target })),
    });
  }
  return sentences;
}

function extractSentences(html) {
  // DOMParser で作った文書はスクリプトを実行せず、画像なども読み込まない。
  // 埋め込みのスタイルはページの安全設定に引っかかって警告が出るので先に取り除く
  const cleaned = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/\sstyle="[^"]*"/gi, "");
  const doc = new DOMParser().parseFromString(cleaned, "text/html");
  const root = doc.querySelector(".mw-parser-output") || doc.body;
  root
    .querySelectorAll("sup, style, script, table, figure, .mw-editsection, .noprint, .thumb, .navbox, .hatnote, .dablink, .mw-empty-elt")
    .forEach((e) => e.remove());

  const sentences = [];
  let h2 = "";
  let section = "概要";
  let sectionId = "";
  for (const el of root.children) {
    const heading = el.matches("h2, h3, h4") ? el : el.matches(".mw-heading") ? el.querySelector("h2, h3, h4") : null;
    if (heading) {
      section = heading.textContent.trim();
      sectionId = heading.id || heading.querySelector(".mw-headline")?.id || "";
      if (heading.tagName === "H2") h2 = section;
      continue;
    }
    if (SKIP_SECTIONS.test(h2)) continue;
    const blocks = el.matches("p") ? [el] : el.matches("ul, ol") ? [...el.querySelectorAll(":scope > li")] : [];
    for (const block of blocks) sentences.push(...splitBlock(block, section, sectionId));
  }
  return sentences;
}

function cleanSentence(s) {
  const text = s.replace(/\s+/g, " ").trim().replace(LEADING_CONNECTOR, "");
  if (text.length < 15 || text.length > MAX_TEXT_LENGTH || UNCLEAR_SUBJECT.test(text)) return null;
  // 「。」で終わらない箇条書きの断片は文脈がわからないので使わない
  if (!/[。！？]$/.test(text)) return null;
  return text;
}

function isGoodTerm(term, themeNames) {
  if (term.length < 2 || term.length > 20 || /^[\d,.]/.test(term)) return false;
  for (const name of themeNames) {
    if (term === name || term.includes(name) || name.includes(term)) return false;
  }
  return true;
}

function scriptOf(s) {
  if (/^[゠-ヿー・]+$/.test(s)) return "katakana";
  if (/^[぀-ゟー]+$/.test(s)) return "hiragana";
  if (/^[A-Za-z0-9 .\-]+$/.test(s)) return "latin";
  return "kanji";
}

// 見た目が似た言葉（同じ文字種、「〜県」「〜時代」のように同じ漢字で終わる）ほど高得点
function shapeScore(a, b) {
  let score = 0;
  if (scriptOf(a) === scriptOf(b)) score += 0.5;
  const last = a.slice(-1);
  if (last === b.slice(-1) && /[一-鿿]/.test(last)) score += 1;
  if (Math.abs(a.length - b.length) <= 2) score += 0.2;
  return score;
}

// 同じカテゴリに属する言葉を優先して「はずれ選択肢」にする
function linkDistractors(c, pool, catsMap) {
  const own = catsMap.get(c.target) || new Set();
  const scored = [];
  const seen = new Set([c.term]);
  for (const o of pool.values()) {
    if (o.target === c.target || seen.has(o.text)) continue;
    if (o.text.includes(c.term) || c.term.includes(o.text) || c.raw.includes(o.text)) continue;
    let shared = 0;
    for (const cat of catsMap.get(o.target) || []) if (own.has(cat)) shared++;
    seen.add(o.text);
    scored.push({ text: o.text, score: shared * 2 + shapeScore(c.term, o.text) + Math.random() * 0.3 });
  }
  const picked = scored.filter((x) => x.score >= 1).sort((a, b) => b.score - a.score).slice(0, 3);
  return picked.length === 3 ? picked.map((x) => x.text) : null;
}

async function buildArticleQuestions(article, themeNames, count) {
  const title = article.title;
  const sentences = extractSentences(article.text);

  const candidates = [];
  const pool = new Map();
  for (const s of sentences) {
    if (!cleanSentence(s.raw)) continue;
    for (const l of s.links) {
      if (!isGoodTerm(l.text, themeNames) || themeNames.has(l.target)) continue;
      if (!pool.has(l.target)) pool.set(l.target, { text: l.text, target: l.target });
      candidates.push({ s, raw: s.raw, term: l.text, target: l.target });
    }
  }
  if (candidates.length === 0) return [];

  // 問題の候補になる言葉を優先してカテゴリを調べる
  const answerTargets = new Set(candidates.map((c) => c.target));
  const titles = [...answerTargets, ...[...pool.keys()].filter((t) => !answerTargets.has(t))].slice(0, MAX_POOL_TITLES);
  const catsMap = titles.length ? await fetchCategories(titles) : new Map();

  // 概要より本文の節のほうが雑学っぽいので先に使う（同じ節の中ではランダム）
  const ordered = shuffle(candidates).sort((a, b) => (a.s.section === "概要") - (b.s.section === "概要"));
  const usedSentences = new Set();
  const usedAnswers = new Set();
  const questions = [];

  for (const c of ordered) {
    if (questions.length >= count) break;
    if (usedSentences.has(c.s) || usedAnswers.has(c.term)) continue;
    if (!catsMap.has(c.target)) continue;

    const distractors = linkDistractors(c, pool, catsMap);
    const text = cleanSentence(c.raw.split(c.term).join(BLANK));
    if (!distractors || !text || !text.includes(BLANK)) continue;

    usedSentences.add(c.s);
    usedAnswers.add(c.term);
    questions.push({
      prompt: `「${displayName(title)}」の記事より。${BLANK}に入るのは？`,
      text,
      answer: c.term,
      choices: shuffle([c.term, ...distractors]),
      full: cleanSentence(c.raw),
      sourceLabel: `Wikipedia「${title}」の「${c.s.section}」を読む`,
      sourceUrl: articleUrl(title, c.s.section === "概要" ? "" : c.s.sectionId),
    });
  }
  return questions;
}

// ---------- 関連記事の概要から「説明はどれ？」問題を作る ----------

function toKatakana(s) {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
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

function toItems(pages, themeNames) {
  const seen = new Set();
  const items = [];
  for (const p of pages) {
    const name = displayName(p.title);
    if (!name || seen.has(name) || /一覧/.test(name) || themeNames.has(p.title) || themeNames.has(name)) continue;
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

async function buildSummaryQuestions(theme, themeNames, count, usedAnswers) {
  const items = toItems(await fetchPages(theme), themeNames);
  // 検索で上位の記事ほどテーマに近いので、上位から多めに候補を取って混ぜる
  const candidates = shuffle(items.slice(0, Math.max(count * 2, 20)));
  const questions = [];
  for (const item of candidates) {
    if (questions.length >= count) break;
    if (usedAnswers.has(item.name)) continue;
    const distractors = pickDistractors(item, items);
    if (distractors.length < 3) continue;
    questions.push({
      prompt: "この説明に当てはまるのはどれ？",
      text: item.text,
      answer: item.name,
      choices: shuffle([item.name, ...distractors.map((d) => d.name)]),
      full: null,
      sourceLabel: `Wikipedia で「${item.name}」を読む`,
      sourceUrl: articleUrl(item.title),
    });
  }
  return questions;
}

async function createQuiz(theme, count) {
  const themeNames = new Set([theme]);
  let questions = [];

  const article = await resolveArticle(theme);
  if (article) {
    themeNames.add(article.title);
    themeNames.add(displayName(article.title));
    questions = await buildArticleQuestions(article, themeNames, count);
  }

  // 記事が短くて足りないぶんは、関連記事の概要から作る
  if (questions.length < count) {
    try {
      const used = new Set(questions.map((q) => q.answer));
      questions.push(...(await buildSummaryQuestions(theme, themeNames, count - questions.length, used)));
    } catch (e) {
      if (questions.length === 0) throw e;
    }
  }

  if (questions.length < 3) {
    throw new Error(`「${theme}」に関する記事が少なくて、問題を作れませんでした。別の言葉で試してみてください。`);
  }
  return shuffle(questions);
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
    $("question-label").textContent = q.prompt;
    $("question").textContent = q.text;
    $("feedback").hidden = true;

    const choices = $("choices");
    choices.replaceChildren();
    q.choices.forEach((choice, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${i + 1}. ${choice}`;
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

    $("feedback-text").textContent = correct ? "⭕ 正解！" : `❌ 残念… 正解は「${q.answer}」`;
    $("full-text").textContent = q.full || "";
    $("full-text").hidden = !q.full;
    $("source-link").textContent = q.sourceLabel;
    $("source-link").href = q.sourceUrl;
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
      link.href = a.question.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = a.question.answer;
      li.append(mark, link);
      if (!a.correct) {
        const yours = document.createElement("span");
        yours.className = "your-answer";
        yours.textContent = `（あなたの答え: ${a.choice}）`;
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

if (document.getElementById("start-form")) initApp();
