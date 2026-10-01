// avdanyuwiki：搜索结果页卡片解析；两次查询：convert_fanza 小写形（如 ipx00787）→ 输入番号纯大写
(function () {
    if (!/\.?avdanyuwiki\.com$/i.test(window.location.hostname)) {
        return;
    }

    const SEARCH_PREFIX = "https://avdanyuwiki.com/?s=";
    const CF_NOTIFY_KEY = "darkeye_avdan_cf_desktop_notified";
    const AVDAN_WAIT_MS = 2000;
    /** Cloudflare 验证可能需要人工处理：持续等待，不回传失败，避免后台关闭标签。 */

    const avdanWait = { timer: null };

    /** 与 ``utils.serial_number.convert_fanza`` / background.js 一致 */
    function convertFanza(serial_number) {
        let converted_code = String(serial_number)
            .toLowerCase()
            .replace(/-/g, "00");
        const halfCoverPrefixes = [
            "start",
            "stars",
            "star",
            "sdde",
            "kmhrs",
        ];
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
        if (halfCoverPrefixes.some((p) => converted_code.startsWith(p))) {
            converted_code = "1" + converted_code;
        }
        if (fullCoverPrefixes.some((p) => converted_code.startsWith(p))) {
            converted_code = "1" + converted_code;
        }
        if (converted_code.startsWith("knmb")) {
            converted_code = "h_491" + converted_code;
        }
        if (converted_code.startsWith("isrd")) {
            converted_code = "24" + converted_code;
        }
        return converted_code;
    }

    function isSearchPageUrl(href) {
        try {
            const u = new URL(href, window.location.origin);
            return u.searchParams.has("s");
        } catch (e) {
            return false;
        }
    }

    function findEntryArticle() {
        const articles = document.querySelectorAll('article[id^="post-"]');
        for (const el of articles) {
            const cls = el.getAttribute("class") || "";
            if (cls.includes("entry-card") && cls.includes("e-card")) {
                return el;
            }
        }
        return null;
    }

    function splitListByCommaLike(text) {
        return text
            .split(/[,、\s.]+/)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    function parseArticle(article) {
        const text = (article.innerText || article.textContent || "").replace(
            /\r\n/g,
            "\n"
        );

        let img_src = "";
        const imgTag = article.querySelector("img");
        if (imgTag) {
            img_src = (imgTag.getAttribute("src") || "").trim();
        }

        let actor_list = [];
        let m = text.match(/出演男優：(.+)/);
        if (m) {
            actor_list = splitListByCommaLike(m[1].trim());
        }

        let director = "----";
        m = text.match(/監督：(.+)/);
        if (m) {
            director = m[1].trim();
        }

        let date = "";
        m = text.match(/配信開始日：(.+)/);
        if (m) {
            date = m[1].trim();
        } else {
            m = text.match(/商品発売日：(.+)/);
            if (m) {
                date = m[1].trim();
            }
        }

        let actress_list = [];
        m = text.match(/出演者?：(.+)/);
        if (m) {
            let actress_text = m[1].trim().replace(/—-/g, "");
            const clean_text = actress_text
                .replace(/（[^）]*）/g, "")
                .replace(/\([^)]*\)/g, "");
            actress_list = splitListByCommaLike(clean_text.trim());
        }

        let tag_list = [];
        m = text.match(/ジャンル：(.+)/);
        if (m) {
            let tag_text = m[1].trim().replace(/—-/g, "");
            tag_list = tag_text
                .split(/[\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
        }

        let maker = "----";
        m = text.match(/メーカー：(.+)/);
        if (m) {
            maker = m[1].trim();
        }

        let series = "";
        m = text.match(/シリーズ：(.+)/);
        if (m) {
            series = m[1].trim();
        }
        if (series === "—-") {
            series = "----";
        }

        let label = "";
        m = text.match(/レーベル：(.+)/);
        if (m) {
            label = m[1].trim();
        }
        if (label === "—-") {
            label = "----";
        }

        let runtime = "";
        m = text.match(/収録時間：\s*([^分]+?)\s*(?:分|min\b)/i);
        if (m) {
            runtime = m[1].trim();
        }

        if (date) {
            const dm = date.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
            if (dm) {
                date = `${dm[1]}-${dm[2]}-${dm[3]}`;
            }
        }

        if (director === "—-") {
            director = "----";
        }

        const serial = sessionStorage.getItem("id") || "";

        return {
            id: serial,
            director,
            release_date: date,
            actor_list,
            actress_list,
            cover: img_src,
            tag_list,
            maker,
            series,
            label,
            runtime,
        };
    }

    function attachMergeRequestId(payload) {
        const mid = sessionStorage.getItem("darkeye_merge_request_id");
        if (mid) payload.merge_request_id = mid;
        return payload;
    }

    function sendRuntimeMessage(payload) {
        const api = typeof browser !== "undefined" ? browser : chrome;
        const ret = api.runtime.sendMessage(payload);
        if (ret && typeof ret.catch === "function") {
            ret.catch(() => {});
        }
    }

    function isAvdanyuwikiCloudflarePage() {
        const t = document.title || "";
        if (
            t.includes("Just a moment") ||
            t.includes("Attention Required") ||
            t.includes("请稍候")
        ) {
            return true;
        }
        if (document.querySelector("#challenge-running")) return true;
        if (document.querySelector("#cf-wrapper")) return true;
        if (document.querySelector(".cf-browser-verification")) return true;
        if (document.querySelector("body.cf-error-details")) return true;
        if (document.querySelector("#challenge-form")) return true;
        if (document.querySelector(".cf-turnstile")) return true;
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
            return true;
        }
        return false;
    }

    function clearAvdanCfDesktopNotifyDedupe() {
        sessionStorage.removeItem(CF_NOTIFY_KEY);
    }

    /** 本轮任务遇到 Cloudflare 时只通知桌面一次，避免轮询重复弹窗 */
    function notifyCloudflareChallengeIfNeeded() {
        if (sessionStorage.getItem(CF_NOTIFY_KEY) === "1") return;
        sessionStorage.setItem(CF_NOTIFY_KEY, "1");
        const payload = {
            command: "notify-cloudflare-challenge",
            site: "avdanyuwiki",
            phase: "search",
            serial: sessionStorage.getItem("id") || "",
            merge_request_id:
                sessionStorage.getItem("darkeye_merge_request_id") || "",
        };
        sendRuntimeMessage(attachMergeRequestId(payload));
    }

    function stopAvdanWait() {
        if (avdanWait.timer !== null) {
            clearInterval(avdanWait.timer);
            avdanWait.timer = null;
        }
    }

    function runAvdanWaitTick() {
        const article = findEntryArticle();
        if (article) {
            stopAvdanWait();
            succeedCrawl(parseArticle(article));
            return;
        }

        if (isAvdanyuwikiCloudflarePage()) {
            notifyCloudflareChallengeIfNeeded();
            return;
        }

        stopAvdanWait();
        tryAvdanyuwikiSearch();
    }

    function startAvdanWait() {
        if (avdanWait.timer !== null) return;
        avdanWait.timer = setInterval(runAvdanWaitTick, AVDAN_WAIT_MS);
    }

    function sendResult(ok, data) {
        sessionStorage.setItem("darkeye_auto_parse", "false");
        const payload = attachMergeRequestId({
            command: "send_crawler_result",
            id: sessionStorage.getItem("id"),
            web: "avdanyuwiki",
            result: ok,
            data: data || {},
        });
        console.log("DarkEye avdanyuwiki:", payload);
        sendRuntimeMessage(payload);
    }

    function failCrawl() {
        stopAvdanWait();
        sessionStorage.removeItem("darkeye_avdan_phase");
        sendResult(false, {});
    }

    function succeedCrawl(data) {
        stopAvdanWait();
        sessionStorage.removeItem("darkeye_avdan_phase");
        sendResult(true, data);
    }

    function tryAvdanyuwikiSearch() {
        const href = window.location.href;
        const serial = (sessionStorage.getItem("id") || "").trim();
        if (!serial || !isSearchPageUrl(href)) {
            return false;
        }

        const article = findEntryArticle();
        if (article) {
            succeedCrawl(parseArticle(article));
            return true;
        }

        if (isAvdanyuwikiCloudflarePage()) {
            notifyCloudflareChallengeIfNeeded();
            startAvdanWait();
            return true;
        }

        const phase = sessionStorage.getItem("darkeye_avdan_phase") || "0";
        if (phase === "0") {
            const fanzaQ = convertFanza(serial);
            const upperQ = serial.toUpperCase();
            if (fanzaQ === upperQ) {
                failCrawl();
                return false;
            }
            sessionStorage.setItem("darkeye_avdan_phase", "1");
            sessionStorage.setItem("darkeye_avdan_resume", "true");
            window.location.href = SEARCH_PREFIX + encodeURIComponent(upperQ);
            return true;
        }

        failCrawl();
        return false;
    }

    browser.runtime.onMessage.addListener((message) => {
        if (message.command === "avdanyuwiki-dvdid") {
            clearAvdanCfDesktopNotifyDedupe();
            stopAvdanWait();
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
            sessionStorage.removeItem("darkeye_avdan_phase");
            tryAvdanyuwikiSearch();
        }
    });

    if (sessionStorage.getItem("darkeye_avdan_resume") === "true") {
        sessionStorage.removeItem("darkeye_avdan_resume");
        setTimeout(() => {
            console.log("DarkEye: avdanyuwiki 第二次查询（纯大写番号）加载，继续解析…");
            tryAvdanyuwikiSearch();
        }, 800);
    } else if (sessionStorage.getItem("darkeye_auto_parse") === "true") {
        setTimeout(() => {
            console.log("DarkEye: avdanyuwiki 验证页面已重新加载，继续等待或解析…");
            tryAvdanyuwikiSearch();
        }, 800);
    }
})();
