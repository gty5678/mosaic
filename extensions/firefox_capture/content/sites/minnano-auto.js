// Minnano：桌面下发 minnano-actress-auto → 自动采集；多条搜索按「无匹配」回传；单条则跳转详情
(function () {
  if (!window.location.href.includes("minnano-av.com")) return;

  const STORAGE_KEY = "darkeye_minnano_auto";
  const CF_NOTIFY_KEY = "darkeye_minnano_cf_desktop_notified";
  const LOG = "DarkEye: minnano-auto";
  const WAIT_INTERVAL_MS = 1000;
  // Cloudflare 的自动验证或人工点击可能要花一些时间。超时前绝不把验证页当成「无匹配」。
  const PAGE_READY_TIMEOUT_MS = 8 * 60 * 1000;
  let waitTimer = null;

  console.log(LOG, "content script injected", {
    href: location.href,
    readyState: document.readyState,
  });

  function reportFailure(err, ctx) {
    stopWaiting();
    console.log(LOG, "failure", err, {
      url: location.href,
      jpName: (ctx && ctx.jpName) || undefined,
      persist: ctx && ctx.persist,
      httpSync: !!(ctx && ctx.actress_http_request_id),
    });
    sessionStorage.removeItem(STORAGE_KEY);
    browser.runtime.sendMessage({
      command: "capture_minnano_actress",
      error: err,
      context: ctx || {},
    });
  }

  function reportSuccess(data, ctx) {
    stopWaiting();
    const jp = data && data["日文名"];
    console.log(LOG, "success", {
      url: location.href,
      jp_name: jp,
      minnano_id: data && data.minnano_actress_id,
      persist: ctx && ctx.persist,
      httpSync: !!(ctx && ctx.actress_http_request_id),
    });
    sessionStorage.removeItem(STORAGE_KEY);
    browser.runtime.sendMessage({
      command: "capture_minnano_actress",
      data: data,
      context: ctx || {},
    });
  }

  function stopWaiting() {
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
  }

  function isCloudflareChallengePage() {
    const title = document.title || "";
    if (
      /just a moment|attention required|checking your browser|verify you are human/i.test(
        title
      )
    ) {
      return true;
    }
    return !!document.querySelector(
      "#challenge-running, #challenge-form, #cf-wrapper, .cf-browser-verification, " +
        ".cf-turnstile, iframe[src*='challenges.cloudflare.com']"
    );
  }

  function notifyCloudflareChallengeIfNeeded(state) {
    if (sessionStorage.getItem(CF_NOTIFY_KEY) === "1") return;
    sessionStorage.setItem(CF_NOTIFY_KEY, "1");
    browser.runtime
      .sendMessage({
        command: "notify-cloudflare-challenge",
        site: "minnano",
        phase: "actress",
        serial: String((state && state.jpName) || ""),
      })
      .catch(() => {});
  }

  function scheduleRetry(reason) {
    if (waitTimer !== null) return;
    console.log(LOG, "page not ready; wait before retry", { reason, url: location.href });
    waitTimer = setTimeout(() => {
      waitTimer = null;
      tryMinnanoAutoRun("wait: " + reason);
    }, WAIT_INTERVAL_MS);
  }

  function isReadyActressDetail(Scrape) {
    if (!Scrape.isActressDetailPage(document)) return false;
    const section = document.getElementById("main-section");
    const heading = section && section.querySelector("h1");
    return !!(heading && (heading.textContent || "").trim());
  }

  function tryMinnanoAutoRun(from) {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // 正常：直接打开/刷新详情页时不会写入 sessionStorage；仅扩展下发
      // minnano-actress-auto 后才有任务。需要手动采集请用页面上的采集按钮（minnano.js）。
      console.debug(LOG, "skip: no auto task in sessionStorage", {
        from,
        href: location.href,
        hint: "expected on manual visit; auto crawl only after extension sends minnano-actress-auto",
      });
      return;
    }

    let state;
    try {
      state = JSON.parse(raw);
    } catch (e) {
      console.warn(LOG, "sessionStorage JSON parse error", e, { from });
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }

    const ctx = Object.assign({ persist: true }, state.context || {});
    if (state.jpName != null) ctx.jpName = state.jpName;

    if (!state.startedAt) {
      state.startedAt = Date.now();
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    const elapsedMs = Date.now() - Number(state.startedAt);
    if (elapsedMs > PAGE_READY_TIMEOUT_MS) {
      reportFailure("minnano_page_load_timeout", ctx);
      return;
    }

    console.log(LOG, "run", {
      from,
      url: location.href,
      jpName: state.jpName,
      persist: ctx.persist,
      httpSync: !!ctx.actress_http_request_id,
      readyState: document.readyState,
    });

    const Scrape = window.DarkEyeMinnanoScrape;
    if (!Scrape) {
      console.warn(LOG, "DarkEyeMinnanoScrape missing (minnano-scrape.js 未加载或顺序不对)", {
        from,
      });
      reportFailure("minnano_scrape_unavailable", ctx);
      return;
    }

    if (isCloudflareChallengePage()) {
      console.log(LOG, "Cloudflare challenge detected; wait for verification", {
        elapsedMs,
      });
      notifyCloudflareChallengeIfNeeded(state);
      scheduleRetry("cloudflare");
      return;
    }

    const headlineEl = document.querySelector(".headline");
    const headlineText = headlineEl
      ? (headlineEl.textContent || "").trim().slice(0, 80)
      : "";
    const isSearch = Scrape.isSearchResultsPage(document);
    const isDetail = isReadyActressDetail(Scrape);
    console.log(LOG, "page detection", {
      from,
      isSearchResultsPage: isSearch,
      isActressDetailPage: isDetail,
      pathname: location.pathname,
      has_main_section: !!document.getElementById("main-section"),
      headlinePreview: headlineText || "(no .headline)",
    });

    if (isSearch) {
      const rows = document.querySelectorAll("td.details");
      const n = rows.length;
      console.log(LOG, "search results page, row count=", n);
      if (n > 1) {
        reportFailure("minnano_auto_no_match", ctx);
        return;
      }
      if (n === 1) {
        const a = document.querySelector("td.details h2.ttl a[href]");
        if (a && a.href) {
          console.log(LOG, "single match, navigate to", a.href);
          window.location.assign(a.href);
          return;
        }
      }
      reportFailure("minnano_auto_no_match", ctx);
      return;
    }

    if (isDetail) {
      let data;
      try {
        data = Scrape.scrapeActressPage(document);
      } catch (e) {
        console.error(LOG, "scrapeActressPage threw", e, { from });
        reportFailure("minnano_scrape_unavailable", ctx);
        return;
      }
      // Cloudflare 的中间页仍可能保留 actress123.html 路径；只在真实详情的姓名已就绪时上传。
      if (!String((data && data["日文名"]) || "").trim()) {
        scheduleRetry("actress detail content");
        return;
      }
      sessionStorage.removeItem(CF_NOTIFY_KEY);
      reportSuccess(data, ctx);
      return;
    }

    // 页面刚完成跳转、Cloudflare 正在替换 DOM 时，尚未出现业务页面结构；继续等待而不是回传空数据。
    scheduleRetry("business page DOM");
  }

  function bootFrom(reason) {
    console.log(LOG, "boot", reason, { readyState: document.readyState });
    tryMinnanoAutoRun(reason);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.command === "minnano-actress-auto") {
      console.log(LOG, "message minnano-actress-auto", {
        jpName: message.jpName,
        persist: (message.context && message.context.persist) !== false,
        httpSync: !!(message.context && message.context.actress_http_request_id),
      });
      const payload = {
        jpName: message.jpName,
        context: Object.assign({ persist: true }, message.context || {}),
        startedAt: Date.now(),
      };
      sessionStorage.removeItem(CF_NOTIFY_KEY);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      tryMinnanoAutoRun("runtime message");
    }
    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bootFrom("DOMContentLoaded"));
  } else {
    bootFrom("sync (already interactive)");
  }

  window.addEventListener("load", () => {
    if (sessionStorage.getItem(STORAGE_KEY)) {
      console.log(LOG, "window load: session task still present, retry run");
      tryMinnanoAutoRun("window.load");
    } else {
      console.log(LOG, "window load: no session task, skip retry");
    }
  });
})();
