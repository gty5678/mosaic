// JavTxt：搜索、跳转详情页、解析（与 javdb / javlibrary 同一套 sessionStorage 接力）
(function () {
    if (!/javtxt\.com/i.test(window.location.hostname)) return;

    const CF_NOTIFY_KEY = "darkeye_javtxt_cf_desktop_notified";
    const TASK_STARTED_AT_KEY = "darkeye_javtxt_task_started_at";
    const TOP_REQUEST_ID_KEY = "darkeye_javtxt_top_actresses_request_id";
    const WAIT_INTERVAL_MS = 1000;
    const WAIT_TIMEOUT_MS = 8 * 60 * 1000;
    let waitTimer = null;

    /** 与 utils.serial_number.serial_number_equal 对齐：小写且 '-' -> '00' */
    function serialNumberEqual(a, b) {
        function norm(s) {
            return (s || "").toLowerCase().replace(/-/g, "00");
        }
        return norm(a) === norm(b);
    }

    function isCloudflarePage() {
        const t = document.title || "";
        if (/just a moment|attention required|checking your browser|verify you are human/i.test(t)) {
            return true;
        }
        return !!document.querySelector(
            "#challenge-running, #challenge-form, #cf-wrapper, .cf-browser-verification, " +
            ".cf-turnstile, iframe[src*='challenges.cloudflare.com']"
        ) || /请稍候|正在验证|安全验证|performing security verification|checking your browser|verify you are human/i.test(
            document.body ? (document.body.innerText || "") : ""
        );
    }

    function isSearchPageUrl(href) {
        try {
            const u = new URL(href, window.location.origin);
            return (
                u.searchParams.get("type") === "id" &&
                u.searchParams.has("q")
            );
        } catch (e) {
            return false;
        }
    }

    function isDetailPageUrl(href) {
        return /\/(?:v|video)\/[^/]+\/?$/i.test(href || "");
    }

    function isTopActressesPageUrl(href) {
        try {
            const u = new URL(href, window.location.origin);
            return /top-actresses/i.test(u.pathname || "");
        } catch (e) {
            return false;
        }
    }

    function attachMergeRequestId(payload) {
        const mid = sessionStorage.getItem("darkeye_merge_request_id");
        if (mid) payload.merge_request_id = mid;
        return payload;
    }

    function stopWaiting() {
        if (waitTimer !== null) {
            clearTimeout(waitTimer);
            waitTimer = null;
        }
    }

    function clearWorkTask() {
        stopWaiting();
        sessionStorage.setItem("darkeye_auto_parse", "false");
        sessionStorage.removeItem(TASK_STARTED_AT_KEY);
    }

    function notifyCloudflareChallengeIfNeeded(phase) {
        const seen = (sessionStorage.getItem(CF_NOTIFY_KEY) || "").split(",").filter(Boolean);
        if (seen.indexOf(phase) >= 0) return;
        seen.push(phase);
        sessionStorage.setItem(CF_NOTIFY_KEY, seen.join(","));
        browser.runtime.sendMessage(attachMergeRequestId({
            command: "notify-cloudflare-challenge",
            site: "javtxt",
            phase: phase,
            serial: sessionStorage.getItem("id") || "",
        })).catch(() => {});
    }

    function ensureTaskStartedAt() {
        const saved = sessionStorage.getItem(TASK_STARTED_AT_KEY);
        if (saved) return Number(saved);
        const now = Date.now();
        sessionStorage.setItem(TASK_STARTED_AT_KEY, String(now));
        return now;
    }

    /** 验证页与业务 DOM 载入期间保留 session 任务，不能提交空抓取结果。 */
    function waitForBusinessPage(phase, resume) {
        if (waitTimer !== null) return;
        if (Date.now() - ensureTaskStartedAt() > WAIT_TIMEOUT_MS) {
            console.warn("DarkEye: JavTxt Cloudflare/page wait timed out", phase);
            stopWaiting();
            if (phase === "top-actresses") {
                const requestId = sessionStorage.getItem(TOP_REQUEST_ID_KEY) || undefined;
                sessionStorage.removeItem(TOP_REQUEST_ID_KEY);
                sessionStorage.removeItem(TASK_STARTED_AT_KEY);
                sendTopActressesResult(false, [], "cloudflare_timeout", requestId);
            } else {
                failCrawl("cloudflare_timeout");
            }
            return;
        }
        if (isCloudflarePage()) notifyCloudflareChallengeIfNeeded(phase);
        console.log("DarkEye: JavTxt waiting for business page", phase);
        waitTimer = setTimeout(() => {
            waitTimer = null;
            resume();
        }, WAIT_INTERVAL_MS);
    }

    function sendTopActressesResult(ok, names, errorMsg, requestId) {
        const rid =
            requestId != null && String(requestId).trim() !== ""
                ? String(requestId).trim()
                : "";
        const payload = {
            command: "send_crawler_result",
            id: "",
            web: "javtxt-top-actresses",
            result: ok,
            data: ok
                ? { names: names || [] }
                : { names: [], error: errorMsg || "parse failed" },
        };
        if (rid) {
            payload.request_id = rid;
        }
        stopWaiting();
        browser.runtime.sendMessage(payload);
    }

    function parseTopActresses(requestId) {
        if (isCloudflarePage()) {
            console.log("DarkEye: javtxt top-actresses 遇到 Cloudflare");
            waitForBusinessPage("top-actresses", () => parseTopActresses(requestId));
            return;
        }
        const els = document.querySelectorAll("p.actress-name");
        const names = [];
        els.forEach((el) => {
            const t = (el.textContent || "").trim();
            if (t) {
                names.push(t);
            }
        });
        if (!names.length) {
            waitForBusinessPage("top-actresses", () => parseTopActresses(requestId));
            return;
        }
        sessionStorage.removeItem(TOP_REQUEST_ID_KEY);
        sessionStorage.removeItem(TASK_STARTED_AT_KEY);
        sendTopActressesResult(true, names.slice(0, 50), undefined, requestId);
    }

    function absoluteUrl(maybeRelative) {
        if (!maybeRelative) return "";
        try {
            return new URL(maybeRelative, window.location.origin).href;
        } catch (e) {
            return maybeRelative;
        }
    }

    function firstMatchingElement(selectors) {
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) return el;
        }
        return null;
    }

    function getJavtxtDetailNodes() {
        const titleEl = firstMatchingElement([
            "h1.title.is-4.text-jp",
            "h1.text-jp",
            "h1.title",
            ".work-title h1",
            "main h1",
            "h1",
        ]);
        const workIdEl = firstMatchingElement([
            "h4.work-id",
            ".work-id",
            "[class*='work-id']",
            "[data-work-id]",
        ]);
        return { titleEl, workIdEl };
    }

    function isJavtxtDetailDomReady() {
        const nodes = getJavtxtDetailNodes();
        const title = nodes.titleEl ? (nodes.titleEl.textContent || "").trim() : "";
        // 标题加上详情区/番号之一即可确认业务页；番号可能在新版页面异步加载，届时回退使用任务番号。
        const hasDetailContent = !!document.querySelector(
            "div.attributes, .attributes, p.text-jp, .text-jp, .work-id, [class*='work-id']"
        );
        return !!title && hasDetailContent;
    }

    function parseAttributesDl(root) {
        const out = {
            release_date: "",
            series: "",
            maker: "",
            director: "",
            label: "",
            genre: [],
        };
        const dl = root.querySelector("div.attributes dl");
        if (!dl) return out;

        const dts = dl.querySelectorAll("dt");
        for (const dt of dts) {
            const dd = dt.nextElementSibling;
            if (!dd || dd.tagName.toLowerCase() !== "dd") continue;
            const key = (dt.textContent || "").replace(/\s+/g, " ").trim();
            if (key.includes("发行时间")) {
                const raw = (dd.textContent || "").trim();
                const m = raw.match(/\d{4}-\d{2}-\d{2}/);
                out.release_date = m ? m[0] : raw;
            } else if (key.includes("系列")) {
                const a = dd.querySelector("a");
                out.series = a
                    ? a.textContent.trim()
                    : (dd.textContent || "").trim() || "----";
            } else if (key.includes("片商")) {
                const a = dd.querySelector("a");
                out.maker = a
                    ? a.textContent.trim()
                    : (dd.textContent || "").trim() || "----";
            } else if (key.includes("导演")) {
                const a = dd.querySelector("a");
                out.director = a
                    ? a.textContent.trim()
                    : (dd.textContent || "").trim() || "----";
            } else if (key.includes("厂牌")) {
                const a = dd.querySelector("a");
                out.label = a
                    ? a.textContent.trim()
                    : (dd.textContent || "").trim() || "----";
            } else if (key.includes("类别")) {
                out.genre = Array.from(dd.querySelectorAll("a.tag"))
                    .map((a) => a.textContent.trim())
                    .filter(Boolean);
            }
        }
        return out;
    }

    function parse_data_javtxt() {
        const href = window.location.href;
        if (!href.includes("javtxt.com")) return;

        if (isCloudflarePage()) {
            waitForBusinessPage("detail", parse_data_javtxt);
            return;
        }

        // Cloudflare 页面会保留 /v/... 地址；详情关键节点未出现时继续保留任务。
        if (!isJavtxtDetailDomReady()) {
            waitForBusinessPage("detail", parse_data_javtxt);
            return;
        }

        const detailNodes = getJavtxtDetailNodes();
        const jpEl = detailNodes.titleEl;
        const cnEl = firstMatchingElement(["h2.title.is-4.text-zh", "h2.text-zh", ".text-zh h2"]);
        const jpStoryEl = firstMatchingElement(["p.text-jp", ".text-jp p", ".text-jp"]);
        const cnWrap = firstMatchingElement(["div.text-zh", ".text-zh"]);
        let cn_story = "";
        if (cnWrap) {
            const cnP = cnWrap.querySelector("p");
            if (cnP) cn_story = cnP.textContent.trim();
        }

        const attrs = parseAttributesDl(document);
        const workIdEl = detailNodes.workIdEl;
        const idFromDom = workIdEl ? workIdEl.textContent.trim() : "";
        const idText =
            idFromDom || (sessionStorage.getItem("id") || "").trim();

        const data = {
            id: idText,
            cn_title: cnEl ? cnEl.textContent.trim() : "",
            jp_title: jpEl ? jpEl.textContent.trim() : "",
            cn_story,
            jp_story: jpStoryEl ? jpStoryEl.textContent.trim() : "",
            release_date: attrs.release_date,
            series: attrs.series,
            maker: attrs.maker,
            director: attrs.director,
            label: attrs.label,
            genre: attrs.genre,
        };

        clearWorkTask();
        sessionStorage.removeItem(CF_NOTIFY_KEY);
        console.log("DarkEye javtxt:", data);
        browser.runtime.sendMessage(
            attachMergeRequestId({
                command: "send_crawler_result",
                id: sessionStorage.getItem("id"),
                web: "javtxt",
                result: true,
                data: data,
            })
        );
    }

    function failCrawl(errorCode) {
        clearWorkTask();
        browser.runtime.sendMessage(
            attachMergeRequestId({
                command: "send_crawler_result",
                id: sessionStorage.getItem("id"),
                web: "javtxt",
                result: false,
                data: errorCode ? { darkeye_error: String(errorCode) } : {},
            })
        );
    }

    function search_javtxt() {
        const href = window.location.href;

        // 验证页有时会改写 URL，因此必须在 URL 分支之前检测并保留任务。
        if (isCloudflarePage()) {
            sessionStorage.setItem("darkeye_auto_parse", "true");
            waitForBusinessPage("search", search_javtxt);
            return false;
        }

        if (isSearchPageUrl(href)) {
            if (isCloudflarePage()) {
                console.log("DarkEye: javtxt 遇到 Cloudflare，等待自动重试...");
                sessionStorage.setItem("darkeye_auto_parse", "true");
                waitForBusinessPage("search", search_javtxt);
                return false;
            }

            const workLink = document.querySelector("a.work");
            const workIdEl = document.querySelector("h4.work-id");
            const searchSerial = sessionStorage.getItem("id") || "";

            if (!workLink || !workIdEl) {
                const bodyText = document.body ? (document.body.innerText || "") : "";
                if (/没有.*结果|无.*结果|no results|not found|見つかりません/i.test(bodyText)) {
                    console.log("DarkEye: javtxt 无搜索结果");
                    failCrawl();
                } else {
                    waitForBusinessPage("search DOM", search_javtxt);
                }
                return false;
            }

            const targetWorkId = (workIdEl.textContent || "").trim();
            const hrefAttr = workLink.getAttribute("href") || "";
            if (!serialNumberEqual(targetWorkId, searchSerial)) {
                console.log("DarkEye: javtxt 搜索结果番号不匹配");
                failCrawl();
                return false;
            }

            const targetUrl = absoluteUrl(hrefAttr);
            if (!targetUrl || !isDetailPageUrl(targetUrl)) {
                failCrawl();
                return false;
            }

            sessionStorage.setItem("darkeye_auto_parse", "true");
            window.location.href = targetUrl;
            return true;
        }

        if (isDetailPageUrl(href) || isJavtxtDetailDomReady()) {
            parse_data_javtxt();
            return true;
        }

        // 验证完成的短暂跳转/空白页可能既不是搜索页也不是详情页；继续保留原任务。
        waitForBusinessPage("search URL", search_javtxt);
        return false;
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.command === "javtxt-parse-top-actresses") {
            const rid =
                message.request_id != null &&
                message.request_id !== undefined &&
                String(message.request_id).trim() !== ""
                    ? String(message.request_id).trim()
                    : undefined;
            stopWaiting();
            sessionStorage.setItem(TOP_REQUEST_ID_KEY, rid || "");
            sessionStorage.setItem(TASK_STARTED_AT_KEY, String(Date.now()));
            parseTopActresses(rid);
            return;
        }
        if (message.command === "javtxt-dvdid") {
            stopWaiting();
            sessionStorage.removeItem(CF_NOTIFY_KEY);
            sessionStorage.setItem(TASK_STARTED_AT_KEY, String(Date.now()));
            sessionStorage.setItem("darkeye_auto_parse", "true");
            sessionStorage.setItem("id", message.serial);
            if (message.mergeRequestId) {
                sessionStorage.setItem(
                    "darkeye_merge_request_id",
                    message.mergeRequestId
                );
            } else {
                sessionStorage.removeItem("darkeye_merge_request_id");
            }
            search_javtxt();
        }
    });

    const savedTopActressesRequestId = sessionStorage.getItem(TOP_REQUEST_ID_KEY);
    if (savedTopActressesRequestId !== null) {
        setTimeout(() => {
            console.log("DarkEye: javtxt 热门女优任务续跑...");
            parseTopActresses(savedTopActressesRequestId || undefined);
        }, 800);
        } else if (sessionStorage.getItem("darkeye_auto_parse") === "true") {
        const href = window.location.href;
        if (isSearchPageUrl(href)) {
            setTimeout(() => {
                console.log("DarkEye: javtxt 搜索页任务续跑...");
                search_javtxt();
            }, 800);
        } else if (!isTopActressesPageUrl(href)) {
            setTimeout(() => {
                console.log("DarkEye: javtxt 检测到自动跳转任务，开始解析...");
                if (isDetailPageUrl(href) || isJavtxtDetailDomReady()) {
                    parse_data_javtxt();
                } else {
                    search_javtxt();
                }
            }, 1000);
        }
    }
})();
