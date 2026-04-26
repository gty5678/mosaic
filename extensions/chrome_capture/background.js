// background.js for Chrome (Manifest V3; merge_work 经 importScripts；SSE 在 offscreen，经 sse_command转发)
importScripts("merge_work.js");

const SERVER_URL = "http://localhost:56790";

const pendingCrawlers = new Map();

/** 爬虫专用标签：主框架导航失败时自动 reload 的次数上限（不含首次打开） */
const CRAWLER_TAB_MAX_AUTO_RELOAD = 1;

/** tabId -> { attempts } */
const tabCrawlerReloadState = new Map();
/** 已安排 reload，避免 onErrorOccurred 与 complete 双触发重复计数 */
const tabCrawlerReloadInFlight = new Set();

function clearTabCrawlerReloadState(tabId) {
  tabCrawlerReloadState.delete(tabId);
  tabCrawlerReloadInFlight.delete(tabId);
}

function getTabCrawlerReloadState(tabId) {
  let s = tabCrawlerReloadState.get(tabId);
  if (!s) {
    s = { attempts: 0 };
    tabCrawlerReloadState.set(tabId, s);
  }
  return s;
}

/**
 * webNavigation.onErrorOccurred 的 error：是否适合自动刷新（证书/用户取消等刷新无效）。
 */
function shouldAutoReloadForNavigationError(errorStr) {
  const u = String(errorStr || "").toUpperCase();
  if (!u) return true;
  if (u.includes("CERT")) return false;
  if (u.includes("SSL")) return false;
  if (u.includes("SEC_ERROR")) return false;
  if (u.includes("MOZILLA_PKIX")) return false;
  if (u.includes("NS_ERROR_CERT")) return false;
  if (u.includes("ABORTED")) return false;
  if (u.includes("CANCELLED")) return false;
  if (u.includes("CANCELED")) return false;
  if (u.includes("BLOCKED_BY_CLIENT")) return false;
  return true;
}

/** Chrome 内置错误页 / interstitial（complete 时 tab.url 可见；与 Firefox about:* 分类对齐） */
function isChromiumInternalErrorPageUrl(url) {
  if (!url || typeof url !== "string") return false;
  return (
    url.startsWith("chrome-error://") ||
    url.startsWith("chrome://network-error") ||
    url.startsWith("chrome://interstitials/")
  );
}

/**
 * 证书/HSTS/一般 interstitial 不重试；典型网络错误页可试（次数仍受
 * CRAWLER_TAB_MAX_AUTO_RELOAD 限制）。
 */
function chromiumErrorPageAllowsAutoReload(url) {
  if (!url || typeof url !== "string") return false;
  const u = url.toLowerCase();
  if (u.startsWith("chrome://interstitials/ssl")) return false;
  if (u.startsWith("chrome://interstitials/")) return false;
  if (u.startsWith("chrome-error://chromewebdata")) return true;
  if (u.startsWith("chrome://network-error")) return true;
  return false;
}

function abandonPendingCrawlerTab(tabId, reason) {
  if (!pendingCrawlers.has(tabId)) {
    clearTabCrawlerReloadState(tabId);
    return;
  }
  console.warn(
    "DarkEye: 爬虫标签放弃 pending",
    "tabId=",
    tabId,
    "reason=",
    reason
  );
  pendingCrawlers.delete(tabId);
  clearTabCrawlerReloadState(tabId);
}

function tryAutoReloadPendingCrawlerTab(tabId, errorOrUrl, kind) {
  if (!pendingCrawlers.has(tabId)) return;
  if (tabCrawlerReloadInFlight.has(tabId)) return;

  const allow =
    kind === "error-page-url"
      ? chromiumErrorPageAllowsAutoReload(errorOrUrl)
      : shouldAutoReloadForNavigationError(errorOrUrl);

  if (!allow) {
    abandonPendingCrawlerTab(
      tabId,
      "error-not-retryable:" + String(errorOrUrl).slice(0, 120)
    );
    return;
  }

  const st = getTabCrawlerReloadState(tabId);
  st.attempts += 1;
  if (st.attempts > CRAWLER_TAB_MAX_AUTO_RELOAD) {
    abandonPendingCrawlerTab(
      tabId,
      "max-auto-reload:" + CRAWLER_TAB_MAX_AUTO_RELOAD
    );
    return;
  }

  tabCrawlerReloadInFlight.add(tabId);
  const delayMs = 300 + st.attempts * 400;
  console.warn(
    "DarkEye: 爬虫标签导航失败将 reload",
    "tabId=",
    tabId,
    "attempt=",
    st.attempts,
    "/",
    CRAWLER_TAB_MAX_AUTO_RELOAD,
    "kind=",
    kind,
    "detail=",
    String(errorOrUrl).slice(0, 200)
  );
  setTimeout(() => {
    chrome.tabs
      .reload(tabId, { bypassCache: true })
      .then(() => {
        tabCrawlerReloadInFlight.delete(tabId);
      })
      .catch((err) => {
        tabCrawlerReloadInFlight.delete(tabId);
        console.error("DarkEye: crawler tab reload failed", tabId, err);
      });
  }, delayMs);
}

/** work_merge_fetch：request_id -> { serial, perSite, tabIds, mergeRequestId, ... } */
const workMergeJobs = new Map();
/** 合并层需要的四站键（merge_work.js 与 tests/support/merge_crawl_legacy 单测思路一致） */
const WORK_MERGE_SITES_ALL = ["javlib", "javdb", "javtxt", "avdanyuwiki"];

/** 以下前缀只开 javdb + javtxt + avdanyuwiki（不开 javlib） */
const MERGE_PREFIX_THREE_NO_JAVLIB = [
  "LUXU",
  "SIRO",
  "GANA",
  "MIUM",
  "ARA",
  "MAAN",
  "NAMA",
  "HON",
  "DCV",
  "NTK",
  "AKO",
  "LADY",
  "SUKE",
  "AHSHIRO",
  "POW",
];

/**
 * 去掉 `-`、`_` 后若整串为纯数字（0-9），视为仅适合 javdb 检索的形态。
 */
function isDigitsOnlyAfterStripHyphens(serial) {
  const compact = String(serial).trim().replace(/[-_]/g, "");
  return compact.length > 0 && /^\d+$/.test(compact);
}

/**
 * 按番号前缀决定要开的爬虫标签（未匹配的番号默认四站全开）。
 * 例：FC2/HEYZO 只 javdb；纯数字只 javdb；MERGE_PREFIX_THREE_NO_JAVLIB 只三站（不开 javlib）。
 */
function resolveMergeSitesForSerial(serial) {
  const raw = String(serial).trim();
  if (!raw) return WORK_MERGE_SITES_ALL.slice();
  const u = raw.toUpperCase();
  if (u.startsWith("FC2") || u.startsWith("HEYZO")) {
    return ["javdb"];
  }
  if (isDigitsOnlyAfterStripHyphens(raw)) {
    return ["javdb"];
  }
  if (MERGE_PREFIX_THREE_NO_JAVLIB.some((p) => u.startsWith(p))) {
    return ["javdb", "javtxt", "avdanyuwiki"];
  }
  return WORK_MERGE_SITES_ALL.slice();
}

/** 单站超过此时长无结果则视为放弃该站，用空对象参与合并（与服务端 GET 120s 总超时配合） */
const WORK_MERGE_PER_SITE_MS = 30000;

/**
 * 单站结果写入合并（onWorkMergeSiteResult）后，关闭该站爬虫标签的延迟（ms）。
 * 0 表示 setTimeout(0)，在监听器返回后再关，避免与 sendMessage 尾逻辑打架。
 */
const WORK_MERGE_CLOSE_TAB_AFTER_SITE_MS = 5000;

/** 桌面 navigate 写入：tabId -> { actress_id?, source? } */
const tabNavigateContext = new Map();
/** session 中持久化，避免 MV3 service worker 休眠后丢失 ID */
const CRAWLER_WINDOW_STORAGE_KEY = "crawlerWindowId";
let crawlerWindowId = null; // 专用爬虫窗口 ID（内存缓存，与 session 同步）
/** 并发 ensure 只跑一次创建逻辑 */
let crawlerWindowEnsurePromise = null;

async function crawlerWindowExists(windowId) {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

async function hydrateCrawlerWindowIdFromStorage() {
  try {
    const data = await chrome.storage.session.get(CRAWLER_WINDOW_STORAGE_KEY);
    const stored = data[CRAWLER_WINDOW_STORAGE_KEY];
    if (stored == null) {
      crawlerWindowId = null;
      return;
    }
    if (await crawlerWindowExists(stored)) {
      crawlerWindowId = stored;
    } else {
      await chrome.storage.session.remove(CRAWLER_WINDOW_STORAGE_KEY);
      crawlerWindowId = null;
    }
  } catch (e) {
    console.error("DarkEye: hydrateCrawlerWindowIdFromStorage", e);
  }
}

async function clearCrawlerWindowPersistence() {
  crawlerWindowId = null;
  crawlerWindowEnsurePromise = null;
  try {
    await chrome.storage.session.remove(CRAWLER_WINDOW_STORAGE_KEY);
  } catch (e) {
    console.error("DarkEye: clearCrawlerWindowPersistence", e);
  }
}

/**
 * 仅最小化传入的爬虫专用窗口。注意：chrome.windows.update 的 focused 不能与 state:minimized
 * 混用；focused:false 还会把 z-order 上下一窗口拉到前台，易误伤多窗口场景。
 */
function minimizeCrawlerWindow(windowId) {
  if (windowId == null) {
    return Promise.resolve();
  }
  return chrome.windows
    .update(windowId, { state: "minimized" })
    .catch((e) => {
      console.warn("DarkEye: minimizeCrawlerWindow", windowId, e);
    });
}

/**
 * 返回可用的爬虫专用窗口 ID：优先 session 中已保存且仍存在的窗口，否则创建。
 */
async function ensureCrawlerWindowId() {
  if (crawlerWindowEnsurePromise) {
    return crawlerWindowEnsurePromise;
  }
  crawlerWindowEnsurePromise = (async () => {
    try {
      await hydrateCrawlerWindowIdFromStorage();
      if (crawlerWindowId != null) {
        return crawlerWindowId;
      }
      const crawlerHomeUrl = "https://www.baidu.com";
      const win = await chrome.windows.create({
        url: crawlerHomeUrl,
        type: "normal",
        state: "minimized",
      });
      await minimizeCrawlerWindow(win.id);
      crawlerWindowId = win.id;
      await chrome.storage.session.set({
        [CRAWLER_WINDOW_STORAGE_KEY]: win.id,
      });
      return win.id;
    } catch (e) {
      console.error("DarkEye: ensureCrawlerWindowId", e);
      throw e;
    } finally {
      crawlerWindowEnsurePromise = null;
    }
  })();
  return crawlerWindowEnsurePromise;
}

/** 专用窗口内标签总数达到该值时通知桌面（去重：跌破后再回升才再报） */
const CRAWLER_BACKLOG_THRESHOLD = 13; // 与 Firefox 扩展一致；正常情况下大于10个就通知桌面
let backlogWarningArmed = true;

/** Uint8Array -> base64（避免大文件 String.fromCharCode 爆栈） */
function uint8ToBase64(u8) {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      u8.subarray(i, Math.min(i + CHUNK, u8.length))
    );
  }
  return btoa(s);
}

function postCoverFetchResult(request_id, ok, error, content_base64) {
  fetch(`${SERVER_URL}/api/v1/cover-image-fetch-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id,
      ok,
      error: error || null,
      content_base64: content_base64 || null,
    }),
  }).catch((err) => {
    console.error("DarkEye: cover-image-fetch-result failed", err);
  });
}

function fetchCoverImageForDesktop(imageUrl, request_id) {
  const minBytes = 5 * 1024; // 小于5kb的图片认为是下载失败
  fetch(imageUrl, { credentials: "omit", cache: "no-store" })
    .then((r) => {
      if (!r.ok) {
        postCoverFetchResult(request_id, false, `HTTP ${r.status}`, null);
        return null;
      }
      return r.arrayBuffer();
    })
    .then((buf) => {
      if (!buf) return;
      const u8 = new Uint8Array(buf);
      if (u8.length < minBytes) {
        postCoverFetchResult(request_id, false, "图片过小（小于 5KB）", null);
        return;
      }
      const b64 = uint8ToBase64(u8);
      postCoverFetchResult(request_id, true, null, b64);
    })
    .catch((e) => {
      console.error("DarkEye: fetchCoverImageForDesktop", e);
      postCoverFetchResult(request_id, false, String(e), null);
    });
}

function postWorkMergeResult(payload) {
  return fetch(`${SERVER_URL}/api/v1/work-merge-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .catch((err) => {
      console.error("DarkEye: work-merge-result failed", err);
      throw err;
    });
}

function clearWorkMergeTimer(job) {
  if (job && job.mergeTimeoutId != null) {
    clearTimeout(job.mergeTimeoutId);
    job.mergeTimeoutId = null;
  }
}

/** work_merge：单站已并入 job.perSite 后关闭对应标签 */
function scheduleCloseWorkMergeCrawlerTab(tabId) {
  if (tabId === undefined || tabId === null) return;
  const ms = WORK_MERGE_CLOSE_TAB_AFTER_SITE_MS;
  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
  }, ms > 0 ? ms : 0);
}

function finishWorkMergeJob(requestId, ok, merged, serial, error) {
  const job = workMergeJobs.get(requestId);
  if (job) clearWorkMergeTimer(job);
  workMergeJobs.delete(requestId);
  postWorkMergeResult({
    request_id: requestId,
    ok,
    merged: merged || null,
    per_site: {},
    error: error || null,
    serial_number: serial || "",
  }).catch(() => {});
}

function runWorkMergeAndFinish(requestId) {
  const job = workMergeJobs.get(requestId);
  if (!job || job.finalized) return;
  job.finalized = true;
  clearWorkMergeTimer(job);

  let merged = null;
  let ok = true;
  let errMsg = null;
  try {
    for (const k of WORK_MERGE_SITES_ALL) {
      if (!Object.prototype.hasOwnProperty.call(job.perSite, k)) {
        job.perSite[k] = {};
      }
    }
    let snapshot = {};
    try {
      snapshot = JSON.parse(JSON.stringify(job.perSite));
    } catch (e) {
      snapshot = Object.assign({}, job.perSite);
    }
    merged = mergeCrawlResultsNoTranslate(snapshot, job.serial);
    console.log(
      "DarkEye: work_merge merged",
      "request_id=" + requestId,
      "serial=" + (job.serial || ""),
      merged
    );
  } catch (e) {
    ok = false;
    errMsg = String(e);
    console.error("DarkEye: mergeCrawlResultsNoTranslate", e);
  }
  finishWorkMergeJob(requestId, ok, merged, job.serial, errMsg);
}

function onWorkMergeSiteResult(requestId, web, data, sourceTabId) {
  const job = workMergeJobs.get(requestId);
  if (!job || job.finalized) return;
  job.perSite[web] = data && typeof data === "object" ? data : {};
  console.log(
    "DarkEye: work_merge crawler raw",
    web,
    "request_id=" + requestId,
    "serial=" + (job.serial || ""),
    job.perSite[web]
  );
  scheduleCloseWorkMergeCrawlerTab(sourceTabId);
  const sites = job.sites || WORK_MERGE_SITES_ALL;
  const n = sites.filter((k) =>
    Object.prototype.hasOwnProperty.call(job.perSite, k)
  ).length;
  if (n < sites.length) return;
  runWorkMergeAndFinish(requestId);
}

function onWorkMergePerSiteTimeout(requestId) {
  const job = workMergeJobs.get(requestId);
  if (!job || job.finalized) return;
  console.warn(
    "DarkEye: work_merge 单站 " +
      WORK_MERGE_PER_SITE_MS / 1000 +
      "s 内未返回的源将按空对象合并 request_id=" +
      requestId
  );
  runWorkMergeAndFinish(requestId);
}

function startWorkMergeFetch(requestId, serial) {
  const sites = resolveMergeSitesForSerial(serial);
  workMergeJobs.set(requestId, {
    serial: String(serial),
    sites, // 计划参与的站点
    perSite: {}, // 每个站点的结果
    tabIds: [], // 参与的标签
    mergeRequestId: requestId,
    mergeTimeoutId: null, // 超时时间
    finalized: false, // 是否完成合并
  });
  console.log("DarkEye: 爬虫任务启用站点", sites.join(","), "serial=", serial);
  const urls = {
    javlib:
      "https://www.javlibrary.com/cn/vl_searchbyid.php?keyword=" +
      String(serial),
    javdb: "https://javdb.com/search?q=" + String(serial),
    javtxt:
      "https://javtxt.com/search?type=id&q=" +
      encodeURIComponent(String(serial)),
    avdanyuwiki:
      "https://avdanyuwiki.com/?s=" +
      encodeURIComponent(
        globalThis.convertFanzaForAvdanyuwiki(String(serial))
      ),
  };

  sites.forEach((w) => {
    addTabInCrawlerWindow(
      urls[w],
      {
        type: w,
        serial: String(serial),
        context: {},
        mergeRequestId: requestId,
      },
      (tabId) => {
        const job = workMergeJobs.get(requestId);
        // 新开的 tab 成功后把 tabId 加入到 job 中
        if (job) job.tabIds.push(tabId);
      }
    );
  });

  const j = workMergeJobs.get(requestId);
  if (j) {
    j.mergeTimeoutId = setTimeout(
      () => onWorkMergePerSiteTimeout(requestId),
      WORK_MERGE_PER_SITE_MS
    );
  }
}

function maybeNotifyCrawlerBacklog() {
  if (crawlerWindowId === null) {
    return Promise.resolve();
  }
  return chrome.tabs
    .query({ windowId: crawlerWindowId })
    .then((tabs) => {
      const count = tabs.length;
      if (count >= CRAWLER_BACKLOG_THRESHOLD && backlogWarningArmed) {
        backlogWarningArmed = false;
        fetch(`${SERVER_URL}/api/v1/crawler-backlog-warning`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            browser: "chrome",
            count,
            threshold: CRAWLER_BACKLOG_THRESHOLD,
          }),
        }).catch((err) => {
          console.error("DarkEye: crawler-backlog-warning failed", err);
        });
      }
      if (count < CRAWLER_BACKLOG_THRESHOLD) {
        backlogWarningArmed = true;
      }
    })
    .catch((err) => {
      console.error("DarkEye: maybeNotifyCrawlerBacklog", err);
    });
}

/**
 * 在专用爬虫窗口中打开后台标签；加载完成后由 tabs.onUpdated 消费 pendingCrawlers。
 * @param {string} url
 * @param {{ type: string, serial?: string, context?: object, mergeRequestId?: string, apiRequestId?: string }} pendingPayload
 * @param {(tabId: number) => void} [onTabCreated]
 */
function addTabInCrawlerWindow(url, pendingPayload, onTabCreated) {
  ensureCrawlerWindowId()
    .then((windowId) =>
      chrome.tabs
        .create({ windowId, url, active: false })
        .then((tab) => {
          minimizeCrawlerWindow(windowId);
          if (tab && tab.id !== undefined) {
            pendingCrawlers.set(tab.id, pendingPayload);
            if (onTabCreated) {
              onTabCreated(tab.id);
            }
          }
          return maybeNotifyCrawlerBacklog();
        })
    )
    .catch((err) => {
      console.error("DarkEye: 爬虫窗口可能已被关闭，重新创建", err);
      clearCrawlerWindowPersistence().then(() => {
        addTabInCrawlerWindow(url, pendingPayload, onTabCreated);
      });
    });
}

/**
 * HTTP GET /api/v1/actress/{jp}：服务端经 SSE 下发 minnano_actress_fetch；可有 minnano_url 直达详情。
 * context 带 actress_http_request_id，回传走 /api/v1/actress-fetch-result（persist: false）。
 */
function startMinnanoActressHttpFetch(
  requestId,
  actressJpName,
  minnanoUrlFragment
) {
  const jp = String(actressJpName || "").trim();
  if (!jp) return;
  const mid = String(minnanoUrlFragment || "").trim();
  let url;
  if (mid) {
    url = "https://www.minnano-av.com/actress" + mid + ".html";
  } else {
    url =
      "https://www.minnano-av.com/search_result.php?search_scope=actress&search_word=" +
      encodeURIComponent(jp) +
      "&search=+Go+";
  }
  const httpCtx = {
    actress_http_request_id: String(requestId),
    persist: false,
    actress_jp_name: jp,
  };
  if (mid) {
    httpCtx.minnano_url = mid;
  }
  addTabInCrawlerWindow(url, {
    type: "minnano",
    serial: jp,
    context: httpCtx,
  });
  console.log("DarkEye: minnano_actress_fetch", requestId, jp);
}

/**
 * HTTP GET /api/v1/top-actresses：打开 javtxt 热门页，回传走 /api/v1/top-actresses-result。
 */
function startJavtxtTopActressesHttpFetch(requestId) {
  const rid = String(requestId || "").trim();
  if (!rid) return;
  const url = "https://javtxt.com/top-actresses";
  addTabInCrawlerWindow(url, {
    type: "javtxt-top-actresses",
    serial: "",
    context: {},
    apiRequestId: rid,
  });
  console.log("DarkEye: javtxt_top_actresses_fetch", rid);
}

function handleCommand(data) {
  // 处理服务器发送来的命令
  if (data.type === "navigate") {
    const url = data.url;
    const target = data.target || "new_tab";
    const ctx = data.context || null;

    if (target === "new_tab") {
      chrome.tabs.create({ url }).then((tab) => {
        if (ctx != null && tab && tab.id !== undefined) {
          tabNavigateContext.set(tab.id, ctx);
        }
      });
    } else if (target === "current_tab") {
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]) {
          const tid = tabs[0].id;
          chrome.tabs.update(tid, { url }).then(() => {
            if (ctx != null) tabNavigateContext.set(tid, ctx);
          });
        }
      });
    }
  }
  if (data.type === "work_merge_fetch") {
    const requestId = data.request_id;
    const serial = data.serial_number;
    if (requestId && serial != null && serial !== "") {
      console.log("DarkEye: 开始爬虫任务", requestId, serial);
      startWorkMergeFetch(String(requestId), serial);
    }
  }
  if (data.type === "minnano_actress_fetch") {
    const requestId = data.request_id;
    const name = data.actress_jp_name;
    const minnanoUrl =
      data.minnano_url != null && data.minnano_url !== undefined
        ? String(data.minnano_url)
        : "";
    if (requestId && name != null && String(name).trim() !== "") {
      startMinnanoActressHttpFetch(
        String(requestId),
        String(name),
        minnanoUrl
      );
    }
  }
  if (data.type === "javtxt_top_actresses_fetch") {
    const requestId = data.request_id;
    if (
      requestId != null &&
      requestId !== undefined &&
      String(requestId).trim() !== ""
    ) {
      startJavtxtTopActressesHttpFetch(String(requestId));
    }
  }
  if (data.type === "fetch_cover_image") {
    const imageUrl = data.url;
    const request_id = data.request_id;
    if (imageUrl && request_id) {
      console.log("DarkEye: fetch_cover_image", request_id);
      fetchCoverImageForDesktop(imageUrl, request_id);
    }
  }
}

/**
 * minnano：complete 有时早于 content script 注册 onMessage，导致 sendMessage 丢包。
 * 使用有限次重试（间隔递增）。
 */
function sendMinnanoActressAutoMessage(tabId, msg, serial) {
  const maxAttempts = 6;
  function trySend(attemptNum) {
    chrome.tabs
      .sendMessage(tabId, msg)
      .then(() => {
        console.log(
          "DarkEye: minnano sendMessage ok tabId=",
          tabId,
          "jp=",
          serial,
          "attempt=",
          attemptNum
        );
      })
      .catch((err) => {
        if (attemptNum < maxAttempts) {
          const wait = 100 * attemptNum;
          console.warn(
            "DarkEye: minnano sendMessage failed; retry",
            attemptNum + 1,
            "in",
            wait,
            "ms",
            err
          );
          setTimeout(() => trySend(attemptNum + 1), wait);
        } else {
          console.error(
            "DarkEye: minnano sendMessage FAILED after",
            maxAttempts,
            "attempts tabId=",
            tabId,
            err
          );
        }
      });
  }
  trySend(1);
}

// 主框架导航失败：仅处理专用爬虫窗口内待下发的标签（pendingCrawlers）
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!pendingCrawlers.has(details.tabId)) return;
  tryAutoReloadPendingCrawlerTab(
    details.tabId,
    details.error || "",
    "navigation-error"
  );
});

// 监听页面加载完成，启动对应爬虫 content script
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    crawlerWindowId !== null &&
    tab.windowId === crawlerWindowId
  ) {
    maybeNotifyCrawlerBacklog();
  }
  if (changeInfo.status === "complete" && pendingCrawlers.has(tabId)) {
    const pageUrl = (tab && tab.url) || "";
    if (isChromiumInternalErrorPageUrl(pageUrl)) {
      tryAutoReloadPendingCrawlerTab(tabId, pageUrl, "error-page-url");
      return;
    }

    const task = pendingCrawlers.get(tabId);
    // 根据任务类型分发不同的指令，并透传 serial
    if (task.type === "javlib") {
      const msg = { command: "javlibrary-dvdid", serial: task.serial };
      if (task.mergeRequestId) msg.mergeRequestId = task.mergeRequestId;
      chrome.tabs.sendMessage(tabId, msg);
      console.log("javlib爬虫开始:" + tabId);
    } else if (task.type === "javdb") {
      const msg = { command: "javdb-dvdid", serial: task.serial };
      if (task.mergeRequestId) msg.mergeRequestId = task.mergeRequestId;
      chrome.tabs.sendMessage(tabId, msg);
      console.log("javdb爬虫开始:" + tabId);
    } else if (task.type === "javtxt") {
      const msg = { command: "javtxt-dvdid", serial: task.serial };
      if (task.mergeRequestId) msg.mergeRequestId = task.mergeRequestId;
      chrome.tabs.sendMessage(tabId, msg);
      console.log("javtxt爬虫开始:" + tabId);
    } else if (task.type === "javtxt-top-actresses") {
      const msg = { command: "javtxt-parse-top-actresses" };
      if (task.apiRequestId) {
        msg.request_id = task.apiRequestId;
      }
      chrome.tabs.sendMessage(tabId, msg);
      console.log("javtxt top-actresses:" + tabId);
    } else if (task.type === "avdanyuwiki") {
      const msg = { command: "avdanyuwiki-dvdid", serial: task.serial };
      if (task.mergeRequestId) msg.mergeRequestId = task.mergeRequestId;
      chrome.tabs.sendMessage(tabId, msg);
      console.log("avdanyuwiki爬虫开始:" + tabId);
    } else if (task.type === "minnano") {
      const msg = {
        command: "minnano-actress-auto",
        jpName: task.serial,
        context: Object.assign({ persist: true }, task.context || {}),
      };
      sendMinnanoActressAutoMessage(tabId, msg, task.serial);
      console.log("minnano爬虫开始:" + tabId);
    }

    // 注意：如果我们采用 Content Script 自动接力模式，这里可能不需要删除，每次刷新时判断有无任务，有就处理，直接任务全部结束
    // 为了防止多次触发，通常还是删除，依赖页面内的 sessionStorage 自动接力
    pendingCrawlers.delete(tabId);
    clearTabCrawlerReloadState(tabId);
  }
});

// 窗口关闭时重置专用爬虫窗口 ID（与 session 一致，含 SW 重启后仅 storage 有 ID 的情况）
chrome.windows.onRemoved.addListener(async (removedId) => {
  try {
    const data = await chrome.storage.session.get(CRAWLER_WINDOW_STORAGE_KEY);
    const stored = data[CRAWLER_WINDOW_STORAGE_KEY];
    if (removedId === crawlerWindowId || removedId === stored) {
      await clearCrawlerWindowPersistence();
      backlogWarningArmed = true;
    }
  } catch (e) {
    console.error("DarkEye: windows.onRemoved", e);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabNavigateContext.delete(tabId);
  clearTabCrawlerReloadState(tabId);
  if (crawlerWindowId !== null) {
    maybeNotifyCrawlerBacklog();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "sse_command" && message.payload) {
    try {
      handleCommand(message.payload);
    } catch (e) {
      console.error("DarkEye: Failed to handle SSE command", e);
    }
    return;
  }

  if (message.command === "check_existence") {
    // 批量检查番号是否存在于本地数据库
    fetch(`${SERVER_URL}/api/v1/check_existence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: message.items }),
    })
      .then((res) => res.json())
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: err.message }));

    return true; // Async response
  }

  if (message.command === "capture_one") {
    // 接受插件发来的单个id,然后发到本地，触发爬虫
    fetch(`${SERVER_URL}/api/v1/capture/one`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload),
    })
      .then((res) => res.json())
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: err.message }));
    console.log("DarkEye: 抓取指令 to server", message);
    return true; // Async response
  }

  if (message.command === "get_tab_context") {
    const tabId = sender.tab && sender.tab.id;
    const ctx = tabId !== undefined ? tabNavigateContext.get(tabId) : undefined;
    sendResponse({ context: ctx || null });
    return false;
  }

  if (message.command === "capture_minnano_actress") {
    const tabId = sender.tab && sender.tab.id;
    const tabCtx =
      tabId !== undefined ? tabNavigateContext.get(tabId) || {} : {};
    const msgCtx = message.context || {};
    const context = Object.assign({}, tabCtx, msgCtx);
    const httpRid = context.actress_http_request_id;
    if (httpRid) {
      const syncBody = {
        request_id: String(httpRid),
        ok: !message.error,
        actress_jp_name: context.actress_jp_name || null,
        data: message.error ? null : message.data,
        error: message.error || null,
      };
      fetch(`${SERVER_URL}/api/v1/actress-fetch-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(syncBody),
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.json();
        })
        .then((data) => {
          console.log("DarkEye: actress-fetch-result sent", data);
          sendResponse({ ok: true, data });
          // GET /api/v1/actress/... 同步查询：回传成功后关闭女优标签
          if (sender.tab && sender.tab.id !== undefined) {
            const tid = sender.tab.id;
            setTimeout(() => {
              chrome.tabs.remove(tid).catch(() => {});
            }, 3000);
          }
        })
        .catch((error) => {
          console.error("DarkEye: Failed to send actress-fetch-result", error);
          sendResponse({ ok: false, error: String(error) });
        });
      return true;
    }
    const payload = {
      context,
      url: sender.tab && sender.tab.url ? sender.tab.url : "",
    };
    if (message.error) {
      payload.error = message.error;
    } else {
      payload.data = message.data;
    }
    fetch(`${SERVER_URL}/api/v1/minnano-actress-capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((response) => response.json())
      .then((data) => {
        console.log("DarkEye: minnano actress capture sent", data);
        sendResponse({ ok: true, data });
        // 桌面「单个女优」自动爬取（persist）：回传成功后与 send_crawler_result 一致，延迟关标签
        const mergedCtx = Object.assign({}, tabCtx, msgCtx);
        if (
          mergedCtx.persist &&
          !message.error &&
          sender.tab &&
          sender.tab.id !== undefined
        ) {
          const tid = sender.tab.id;
          setTimeout(() => {
            chrome.tabs.remove(tid);
          }, 10000);
        }
      })
      .catch((error) => {
        console.error("DarkEye: Failed to send minnano capture", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message.command === "notify-cloudflare-challenge") {
    const tabUrl =
      sender.tab && sender.tab.url ? String(sender.tab.url) : "";
    const body = {
      url: tabUrl,
      site: message.site != null ? String(message.site) : "",
      phase: message.phase != null ? String(message.phase) : "",
      serial: message.serial != null ? String(message.serial) : "",
      merge_request_id:
        message.merge_request_id != null
          ? String(message.merge_request_id)
          : "",
    };
    fetch(`${SERVER_URL}/api/v1/cloudflare-challenge-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((err) => {
      console.error("DarkEye: cloudflare-challenge-notify failed", err);
    });
    return false;
  }

  // send_crawler_result：① merge_request_id + 四站 → work_merge；② 热门女优带 request_id → top-actresses-result；③ 其余不再 POST（已无对应接口）。
  if (message.command === "send_crawler_result") {
    if (message.merge_request_id && message.web) {
      const rid = message.merge_request_id;
      const web = message.web;
      if (WORK_MERGE_SITES_ALL.indexOf(web) >= 0) {
        const job = workMergeJobs.get(rid);
        if (job && job.sites && job.sites.indexOf(web) >= 0) {
          const srcTid =
            sender.tab && sender.tab.id !== undefined
              ? sender.tab.id
              : undefined;
          onWorkMergeSiteResult(rid, web, message.data || {}, srcTid);
        }
        return false;
      }
    }
    const topApiRid =
      message.web === "javtxt-top-actresses" && message.request_id
        ? String(message.request_id).trim()
        : "";
    console.log("DarkEye: send_crawler_result", message);
    if (topApiRid === "") {
      console.warn(
        "DarkEye: 跳过上传（非 work 合并路径且无 top-actresses request_id） web=",
        message.web
      );
      return false;
    }
    const inner = message.data || {};
    const names = Array.isArray(inner.names) ? inner.names : [];
    const topPayload = {
      request_id: topApiRid,
      ok: !!message.result,
      names: names,
    };
    if (inner.error) {
      topPayload.error = String(inner.error);
    }
    fetch(`${SERVER_URL}/api/v1/top-actresses-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(topPayload),
    })
      .then((response) => response.json())
      .then((data) => {
        console.log("DarkEye: top-actresses-result ok", data);
        if (sender.tab && sender.tab.id) {
          setTimeout(() => {
            chrome.tabs.remove(sender.tab.id);
          }, 10000);
        }
      })
      .catch((error) => {
        console.error("DarkEye: top-actresses-result failed", error);
      });
  }
});

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_SCRAPING"],
      justification: "SSE connection to receive DarkEye server commands",
    });
  } catch (e) {
    console.error("DarkEye: Failed to create offscreen document", e);
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
  hydrateCrawlerWindowIdFromStorage();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen();
  hydrateCrawlerWindowIdFromStorage();
});

ensureOffscreen();
hydrateCrawlerWindowIdFromStorage();
