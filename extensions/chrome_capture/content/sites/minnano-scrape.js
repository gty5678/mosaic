// 与 core/crawler/actress.py 插件回传字段对齐的 DOM 抽取（纯函数，依赖 document）
(function (global) {
  "use strict";

  const SCRAPE_LOG = "DarkEye: minnano-scrape";

  function isSearchResultsPage(doc) {
    const headline = doc.querySelector(".headline");
    if (!headline) return false;
    return headline.textContent.indexOf("AV女優検索結果") !== -1;
  }

  function isActressDetailPage(doc) {
    if (isSearchResultsPage(doc)) return false;
    const path = doc.location ? doc.location.pathname : "";
    if (/actress\d+\.html/i.test(path)) return true;
    const section = doc.getElementById("main-section");
    if (section && section.querySelector("h1")) return true;
    return false;
  }

  function absUrl(src) {
    if (!src) return "";
    try {
      return new URL(src, "https://www.minnano-av.com/").href;
    } catch (e) {
      return src;
    }
  }

  function findLabelSpan(doc, labelText) {
    const spans = doc.querySelectorAll("span");
    for (let i = 0; i < spans.length; i++) {
      if (spans[i].textContent.trim() === labelText) return spans[i];
    }
    return null;
  }

  /** 文档序中 el 之后的第一个 tagName 元素（对齐 BeautifulSoup find_next） */
  function findNextTagAfter(el, tagName) {
    if (!el || !el.ownerDocument || !el.ownerDocument.body) return null;
    const tn = tagName.toLowerCase();
    const walker = el.ownerDocument.createTreeWalker(
      el.ownerDocument.body,
      NodeFilter.SHOW_ELEMENT
    );
    let passed = false;
    let n = walker.nextNode();
    while (n) {
      if (n === el) passed = true;
      else if (passed && n.nodeName.toLowerCase() === tn) return n;
      n = walker.nextNode();
    }
    return null;
  }

  /** 去掉半角 () 与全角 （） 括号及其中的文字（可多次出现） */
  function stripParentheticals(text) {
    let s = String(text || "").trim();
    let prev;
    do {
      prev = s;
      s = s.replace(/\([^()]*\)/g, "").replace(/（[^（）]*）/g, "").trim();
    } while (s !== prev);
    return s;
  }

  function scrapeActressPage(doc) {
    console.log(SCRAPE_LOG, "scrapeActressPage start", {
      href: doc.location ? doc.location.href : "",
      pathname: doc.location ? doc.location.pathname : "",
    });

    let minnano_actress_id = "";
    const og = doc.querySelector('meta[property="og:url"]');
    if (og && og.getAttribute("content")) {
      const m = /actress(\d+)\.html/.exec(og.getAttribute("content") || "");
      if (m) minnano_actress_id = m[1];
    }
    if (!minnano_actress_id && doc.location && doc.location.pathname) {
      const m2 = /actress(\d+)\.html/i.exec(doc.location.pathname);
      if (m2) minnano_actress_id = m2[1];
    }

    let img_src = "";
    const thumbDiv = doc.querySelector("div.thumb");
    if (thumbDiv) {
      const img = thumbDiv.querySelector("img");
      if (img && img.getAttribute("src")) img_src = img.getAttribute("src");
    }
    const full_img_src = img_src ? absUrl(img_src) : "";

    let jp_name = "";
    let kana = "";
    let romaji = "";
    const section = doc.getElementById("main-section");
    if (section) {
      const h1 = section.querySelector("h1");
      if (h1) {
        const first = h1.childNodes[0];
        if (first && first.nodeType === Node.TEXT_NODE) {
          jp_name = stripParentheticals(first.textContent || "");
        }
        const span = h1.querySelector("span");
        if (span) {
          const spanText = span.textContent.trim();
          const parts = spanText.split("/");
          kana = (parts[0] || "").trim();
          romaji = (parts[1] || "").trim();
        }
      }
    }

    const alias_chain = [];
    const aliasSpans = doc.querySelectorAll("span");
    for (let i = 0; i < aliasSpans.length; i++) {
      const el = aliasSpans[i];
      if (el.textContent.trim() !== "別名") continue;
      const mixalias = findNextTagAfter(el, "p");
      if (!mixalias) continue;
      const mixText = mixalias.textContent || "";
      let jp = null;
      const mHead = mixText.match(/^([\s\S]*?)[\(\（【]/);
      if (mHead) jp = mHead[1].trim();
      const inner = mixText.match(/（([^（）]*)）/g);
      let kana_ = null;
      let romaji_ = null;
      if (inner && inner.length) {
        const last = inner[inner.length - 1];
        const innerMatch = /（([^（）]*)）/.exec(last);
        if (innerMatch) {
          const mix = innerMatch[1].trim();
          const p = mix.split("/", 2);
          kana_ = (p[0] || "").trim();
          romaji_ = p.length > 1 ? p[1].trim() : null;
        }
      }
      alias_chain.push({ jp: jp, kana: kana_, en: romaji_ });
    }

    let birth_date = "";
    const birthLabel = findLabelSpan(doc, "生年月日");
    if (birthLabel) {
      const p = findNextTagAfter(birthLabel, "p");
      if (p) {
        const bm = /(\d{4})年(\d{2})月(\d{2})日/.exec(p.textContent || "");
        if (bm) birth_date = bm[1] + "-" + bm[2] + "-" + bm[3];
      }
    }

    let birthplace = "";
    const birthplaceLabel = findLabelSpan(doc, "出身地");
    if (birthplaceLabel) {
      const p = findNextTagAfter(birthplaceLabel, "p");
      if (p) birthplace = (p.textContent || "").replace(/\s+/g, " ").trim();
    }

    let height = 0;
    let bust = 0;
    let cup = "";
    let waist = 0;
    let hip = 0;
    const sizeLabel = findLabelSpan(doc, "サイズ");
    if (sizeLabel) {
      const body = findNextTagAfter(sizeLabel, "p");
      if (body) {
        const pattern =
          /T(\d+)\s*\/\s*B(\d+)\((\w)カップ\)\s*\/\s*W(\d+)\s*\/\s*H(\d+)/;
        const mm = pattern.exec(body.textContent || "");
        if (mm) {
          height = parseInt(mm[1], 10) || 0;
          bust = parseInt(mm[2], 10) || 0;
          cup = mm[3] || "";
          waist = parseInt(mm[4], 10) || 0;
          hip = parseInt(mm[5], 10) || 0;
        }
      }
    }

    let debut_date = "";
    const debutLabel = findLabelSpan(doc, "デビュー作品");
    if (debutLabel) {
      const p = findNextTagAfter(debutLabel, "p");
      if (p) {
        const text = p.textContent || "";
        const all = text.match(/（([^）]*?)）/g);
        if (all && all.length) {
          const raw = all[all.length - 1].replace(/\s/g, "");
          const inner = /（([^）]*?)）/.exec(raw);
          const rawDate = inner ? inner[1].replace(/\s/g, "") : "";
          const dm = /(\d{4})年(\d{2})月(\d{2})日/.exec(rawDate);
          if (dm) debut_date = dm[1] + "-" + dm[2] + "-" + dm[3];
        }
      }
    }

    const out = {
      日文名: String(jp_name || ""),
      假名: String(kana || ""),
      英文名: String(romaji || ""),
      出生日期: String(birth_date || ""),
      出身地: String(birthplace || ""),
      身高: height,
      罩杯: String(cup || ""),
      胸围: bust,
      腰围: waist,
      臀围: hip,
      出道日期: String(debut_date || ""),
      头像地址: full_img_src,
      minnano_actress_id: String(minnano_actress_id || ""),
      alias_chain: alias_chain,
    };

    console.log(SCRAPE_LOG, "scrapeActressPage end", {
      日文名: out["日文名"] || "(empty)",
      minnano_actress_id: out.minnano_actress_id || "(empty)",
      has_main_section: !!doc.getElementById("main-section"),
      alias_count: alias_chain.length,
    });

    return out;
  }

  global.DarkEyeMinnanoScrape = {
    isActressDetailPage: isActressDetailPage,
    scrapeActressPage: scrapeActressPage,
    isSearchResultsPage: isSearchResultsPage,
  };
})(typeof window !== "undefined" ? window : self);
