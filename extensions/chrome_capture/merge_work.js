/**
 * 与 tests/support/merge_crawl_legacy.merge_crawl_results 对齐（不含翻译）。
 * 供 background.js 在四站结果集齐后调用。
 */
(function () {
  const FANZA_PL_SKIP_MAKER_SUBSTR = [
    "sod",
    "SOD Create",
    "ソフト・オン・デマンド",
    "SODクリエイト",
    "prestige",
    "プレステージ",
  ];
  const FANZA_PL_SKIP_SERIAL_PREFIXES = new Set([
    "START",
    "STARS",
    "SDJS",
    "SDAB",
    "SDDE",
    "SDMU",
    "SDNM",
    "SDMM",
    "SDAF",
    "SDHS",
    "FC2",
    "LUXU",
  ]);
  const FANZA_PL_MIN_RELEASE_YEAR = 2018;

  /**
   * 与 resources/config/exclude_genre.json 中 exclude_genre 同步（merge_crawl_legacy.exclude_genre_set）。
   */
  const EXCLUDE_GENRE = new Set([
    "AV女优",
    "2000",
    "2001",
    "2002",
    "2003",
    "2004",
    "2005",
    "2006",
    "2007",
    "2008",
    "2009",
    "2010",
    "2011",
    "2012",
    "2013",
    "2014",
    "2015",
    "2016",
    "2017",
    "2018",
    "2019",
    "2020",
    "2021",
    "2022",
    "2023",
    "2024",
    "2025",
    "2026",
    "2027",
    "2028",
    "2029",
    "2030",
    "2031",
    "2032",
    "2033",
    "女優部門",
    "AV",
    "OPEN",
    "AI生成作品",
    "MGSだけのおまけ映像付き",
  ]);

  /** 与 merge_crawl_legacy._fanza_pl_serial_head：有横杠取横杠前；否则取连续 isalpha 前缀 */
  function fanzaPlSerialHead(serial) {
    const s = String(serial).trim().toUpperCase();
    if (!s) return "";
    if (s.includes("-")) return s.split("-")[0];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (!/^\p{L}$/u.test(ch)) break;
      i++;
    }
    return i ? s.slice(0, i) : s;
  }

  /** 与 utils.serial_number.convert_fanza 一致（FANZA PL cid） */
  function convertFanza(serialNumber) {
    let convertedCode = String(serialNumber).toLowerCase().replace(/-/g, "00");
    const halfCoverPrefixes = ["start", "stars", "star", "sdde", "kmhrs"];
    const fullCoverPrefixes = [
      "namh",
      "dldss",
      "fns",
      "fsdss",
      "boko",
      "sdam",
      "hawa",
      "moon",
      "mogi",
      "nhdtb",
    ];
    if (halfCoverPrefixes.some((p) => convertedCode.startsWith(p))) {
      convertedCode = "1" + convertedCode;
    }
    if (fullCoverPrefixes.some((p) => convertedCode.startsWith(p))) {
      convertedCode = "1" + convertedCode;
    }
    if (convertedCode.startsWith("knmb")) {
      convertedCode = "h_491" + convertedCode;
    }
    if (convertedCode.startsWith("isrd")) {
      convertedCode = "24" + convertedCode;
    }
    return convertedCode;
  }

  /** 与 merge_crawl_legacy._skip_fanza_pl_priority_cover：sub in m（m 为小写 maker） */
  function skipFanzaPlPriorityCover(maker, canonicalSerial) {
    const m = (maker || "").trim().toLowerCase();
    if (m) {
      for (const sub of FANZA_PL_SKIP_MAKER_SUBSTR) {
        if (!sub) continue;
        if (m.includes(sub.toLowerCase())) return true;
      }
    }
    const head = fanzaPlSerialHead(canonicalSerial);
    return Boolean(head) && FANZA_PL_SKIP_SERIAL_PREFIXES.has(head);
  }

  function releaseYearIsBefore(releaseDate, year) {
    const s = (releaseDate || "").trim();
    if (!s) return false;
    const m = s.match(/(?:19|20)\d{2}/);
    if (!m) return false;
    return parseInt(m[0], 10) < year;
  }

  function urls(x) {
    if (x == null) return [];
    if (typeof x === "string") return [x];
    if (Array.isArray(x)) return x;
    return [];
  }

  /** 与 avdanyuwiki 发行日相差超过此天数则丢弃该站合并输入（javlib/javdb/javtxt） */
  const RELEASE_DATE_TOLERANCE_DAYS = 60;

  /**
   * 解析为 UTC 日历日；无法解析为单一 YYYY-MM-DD 形态则返回 null。
   */
  function parseReleaseDateString(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (!t) return null;
    const m = t.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    if (y < 1900 || y > 2100) return null;
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== mo ||
      dt.getUTCDate() !== d
    ) {
      return null;
    }
    return dt;
  }

  function calendarDaysApartUTC(a, b) {
    return Math.round(
      Math.abs(a.getTime() - b.getTime()) / (24 * 3600 * 1000)
    );
  }

  /**
   * 以 avdanyuwiki.release_date 为基准：无日期或无法解析则不校验；
   * javlib/javdb/javtxt 有可解析日期且与基准相差 >20 天则整站不用（置空对象）。
   */
  function filterResultsByAvdanyuReleaseDate(results) {
    let base;
    try {
      base = JSON.parse(JSON.stringify(results || {}));
    } catch (e) {
      base = Object.assign({}, results || {});
    }
    const av = base.avdanyuwiki || {};
    const ref = parseReleaseDateString(av.release_date);
    if (ref == null) {
      return base;
    }

    const others = ["javlib", "javdb", "javtxt"];
    for (let i = 0; i < others.length; i++) {
      const key = others[i];
      const site = base[key] || {};
      const d = parseReleaseDateString(site.release_date);
      if (d == null) {
        continue;
      }
      if (calendarDaysApartUTC(ref, d) > RELEASE_DATE_TOLERANCE_DAYS) {
        console.warn(
          "merge_work: 丢弃 " +
            key +
            "（release_date 与 avdanyuwiki 相差 " +
            calendarDaysApartUTC(ref, d) +
            " 天，>" +
            RELEASE_DATE_TOLERANCE_DAYS +
            "）"
        );
        base[key] = {};
      }
    }
    return base;
  }

  /** 取第一个非空数组；避免 `[] || fallback` 在 JS 中空数组为真值导致不回退。 */
  function firstNonEmptyArray(...candidates) {
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if (Array.isArray(a) && a.length > 0) {
        return a;
      }
    }
    return [];
  }

  /** 跳过采集器的空白和纯横线占位符，取第一个有效文本。 */
  function firstNonEmptyText(...candidates) {
    for (const value of candidates) {
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (text && !/^[-—–－\s]+$/.test(text)) return text;
    }
    return "";
  }

  /**
   * @param {Record<string, object>} results — 键：javlib | javdb | javtxt | avdanyuwiki
   * @param {string} canonicalSerial
   * @returns {object} CrawledWorkData 形状（含 tag_list = 合并后类别）
   */
  function mergeCrawlResultsNoTranslate(results, canonicalSerial) {
    const mergedIn = filterResultsByAvdanyuReleaseDate(results);
    const javlibResult = mergedIn.javlib || {};
    const javtxtResult = mergedIn.javtxt || {};
    const avdanyuwikiResult = mergedIn.avdanyuwiki || {};
    const javdbResult = mergedIn.javdb || {};

    const releaseDate =
      javlibResult.release_date ||
      avdanyuwikiResult.release_date ||
      javdbResult.release_date ||
      javtxtResult.release_date ||
      "";

    const director = firstNonEmptyText(
      avdanyuwikiResult.director,
      javlibResult.director,
      javdbResult.director,
      javtxtResult.director,
    );

    // 空串、占位符或 0 表示无有效时长，继续尝试下一来源（单位：分钟）。
    let runtimeVal = 0;
    for (const value of [
      avdanyuwikiResult.runtime,
      javlibResult.length,
      javdbResult.length,
    ]) {
      const minutes = parseInt(String(value == null ? "" : value).trim(), 10);
      if (Number.isFinite(minutes) && minutes > 0) {
        runtimeVal = minutes;
        break;
      }
    }

    const actressList = firstNonEmptyArray(
      avdanyuwikiResult.actress_list,
      javlibResult.actress,
      javdbResult.actress
    );

    const maker = firstNonEmptyText(
      avdanyuwikiResult.maker,
      javlibResult.maker,
      javdbResult.maker,
      javtxtResult.maker
    );

    let coverList = urls(javlibResult.image).filter(
      (u) => u && typeof u === "string"
    );
    const sn = String(canonicalSerial).trim();
    if (
      sn &&
      !skipFanzaPlPriorityCover(maker, sn) &&
      !releaseYearIsBefore(releaseDate, FANZA_PL_MIN_RELEASE_YEAR)
    ) {
      const cid = convertFanza(sn.toUpperCase());
      const fanzaPl = `https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/${cid}/${cid}pl.jpg`;
      coverList = [fanzaPl].concat(coverList);
    }
    const avdanurl = avdanyuwikiResult.cover || "";
    if (avdanurl) coverList = coverList.concat([avdanurl]);
    const serialLower = canonicalSerial.toLowerCase();
    coverList = coverList.concat([
      "https://fourhoi.com/" + serialLower + "/cover-n.jpg",
    ]);
    const javdburl = javdbResult.cover || "";
    if (javdburl) coverList = coverList.concat([javdburl]);

    const series = firstNonEmptyText(
      avdanyuwikiResult.series,
      javdbResult.series,
      javtxtResult.series
    );

    const label = firstNonEmptyText(
      avdanyuwikiResult.label,
      javlibResult.label,
      javdbResult.label,
      javtxtResult.label
    );

    const tagList = avdanyuwikiResult.tag_list || [];
    const genreJav = javlibResult.genre || [];
    const genreJavdb = javdbResult.genre || [];
    const genreJavtxt = javtxtResult.genre || [];
    const genreRaw = []
      .concat(Array.isArray(tagList) ? tagList : [])
      .concat(Array.isArray(genreJav) ? genreJav : [])
      .concat(Array.isArray(genreJavdb) ? genreJavdb : [])
      .concat(Array.isArray(genreJavtxt) ? genreJavtxt : []);

    const genreList = [];
    const seen = new Set();
    for (const x of genreRaw) {
      if (x == null) continue;
      const g = String(x);
      if (EXCLUDE_GENRE.has(g)) continue;
      if (seen.has(g)) continue;
      seen.add(g);
      genreList.push(g);
    }

    const jpTitle =
      javlibResult.title ||
      javtxtResult.jp_title ||
      javdbResult.title ||
      "";

    const fanartList = firstNonEmptyArray(
      javlibResult.fanart,
      javdbResult.fanart
    );

    return {
      serial_number: canonicalSerial,
      director,
      release_date: releaseDate,
      runtime: runtimeVal,
      cn_title: javtxtResult.cn_title || "",
      jp_title: jpTitle,
      cn_story: javtxtResult.cn_story || "",
      jp_story: javtxtResult.jp_story || "",
      maker,
      series,
      label,
      tag_list: genreList,
      actress_list: Array.isArray(actressList) ? actressList : [],
      actor_list: avdanyuwikiResult.actor_list || [],
      cover_url_list: coverList,
      fanart_url_list: Array.isArray(fanartList) ? fanartList : [],
    };
  }

  const g = typeof globalThis !== "undefined" ? globalThis : this;
  g.mergeCrawlResultsNoTranslate = mergeCrawlResultsNoTranslate;
  /** 与 ``utils.serial_number.convert_fanza`` 一致；供 background 拼 avdanyuwiki 搜索串。 */
  g.convertFanzaForAvdanyuwiki = convertFanza;
})();

