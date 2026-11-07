// JavTxt：搜索、跳转详情页、解析（与 javdb / javlibrary 同一套 sessionStorage 接力）
(function () {
    if (!/javtxt\.com/i.test(window.location.hostname)) return;

    /** 与 utils.serial_number.serial_number_equal 对齐：小写且 '-' -> '00' */
    function serialNumberEqual(a, b) {
        function norm(s) {
            return (s || "").toLowerCase().replace(/-/g, "00");
        }
        return norm(a) === norm(b);
    }

    function isCloudflarePage() {
        const t = document.title || "";
        if (t.includes("Just a moment") || t.includes("Attention Required")) {
            return true;
        }
        if (document.querySelector("#challenge-running")) {
            return true;
        }
        return false;
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
        return /\/v\/[^/]+\/?$/i.test(href || "");
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
        chrome.runtime.sendMessage(payload);
    }

    function parseTopActresses(requestId) {
        if (isCloudflarePage()) {
            console.log("DarkEye: javtxt top-actresses 遇到 Cloudflare");
            sendTopActressesResult(false, [], "Cloudflare", requestId);
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

        const dds = dl.querySelectorAll("dd");
        for (const dd of dds) {
            const dt = dd.nextElementSibling;
            if (!dt || dt.tagName.toLowerCase() !== "dt") continue;
            const key = (dd.textContent || "").replace(/\s+/g, " ").trim();
            if (key.includes("发行时间")) {
                const raw = (dt.textContent || "").trim();
                const m = raw.match(/\d{4}-\d{2}-\d{2}/);
                out.release_date = m ? m[0] : raw;
            } else if (key.includes("系列")) {
                const a = dt.querySelector("a");
                out.series = a
                    ? a.textContent.trim()
                    : (dt.textContent || "").trim() || "----";
            } else if (key.includes("片商")) {
                const a = dt.querySelector("a");
                out.maker = a
                    ? a.textContent.trim()
                    : (dt.textContent || "").trim() || "----";
            } else if (key.includes("导演")) {
                const a = dt.querySelector("a");
                out.director = a
                    ? a.textContent.trim()
                    : (dt.textContent || "").trim() || "----";
            } else if (key.includes("厂牌")) {
                const a = dt.querySelector("a");
                out.label = a
                    ? a.textContent.trim()
                    : (dt.textContent || "").trim() || "----";
            } else if (key.includes("类别")) {
                out.genre = Array.from(dt.querySelectorAll("a.tag"))
                    .map((a) => a.textContent.trim())
                    .filter(Boolean);
            }
        }
        return out;
    }

    function parse_data_javtxt() {
        const href = window.location.href;
        if (!href.includes("javtxt.com")) return;

        const jpEl = document.querySelector("h1.title.is-4.text-jp");
        const cnEl = document.querySelector("h2.title.is-4.text-zh");
        const jpStoryEl = document.querySelector("p.text-jp");
        const cnWrap = document.querySelector("div.text-zh");
        let cn_story = "";
        if (cnWrap) {
            const cnP = cnWrap.querySelector("p");
            if (cnP) cn_story = cnP.textContent.trim();
        }

        const attrs = parseAttributesDl(document);
        const workIdEl = document.querySelector("h4.work-id");
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

        sessionStorage.setItem("darkeye_auto_parse", "false");
        console.log("DarkEye javtxt:", data);
        chrome.runtime.sendMessage(
            attachMergeRequestId({
                command: "send_crawler_result",
                id: sessionStorage.getItem("id"),
                web: "javtxt",
                result: true,
                data: data,
            })
        );
    }

    function failCrawl() {
        sessionStorage.setItem("darkeye_auto_parse", "false");
        chrome.runtime.sendMessage(
            attachMergeRequestId({
                command: "send_crawler_result",
                id: sessionStorage.getItem("id"),
                web: "javtxt",
                result: false,
                data: {},
            })
        );
    }

    function search_javtxt() {
        const href = window.location.href;

        if (isSearchPageUrl(href)) {
            if (isCloudflarePage()) {
                console.log("DarkEye: javtxt 遇到 Cloudflare，等待自动重试...");
                sessionStorage.setItem("darkeye_auto_parse", "true");
                return false;
            }

            const workLink = document.querySelector("a.work");
            const workIdEl = document.querySelector("h4.work-id");
            const searchSerial = sessionStorage.getItem("id") || "";

            if (!workLink || !workIdEl) {
                console.log("DarkEye: javtxt 无搜索结果");
                failCrawl();
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

        if (isDetailPageUrl(href)) {
            parse_data_javtxt();
            return true;
        }

        return false;
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.command === "javtxt-parse-top-actresses") {
            const rid =
                message.request_id != null &&
                message.request_id !== undefined &&
                String(message.request_id).trim() !== ""
                    ? String(message.request_id).trim()
                    : undefined;
            parseTopActresses(rid);
            return;
        }
        if (message.command === "javtxt-dvdid") {
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

    if (sessionStorage.getItem("darkeye_auto_parse") === "true") {
        sessionStorage.removeItem("darkeye_auto_parse");
        const href = window.location.href;
        if (!isSearchPageUrl(href) && !isTopActressesPageUrl(href)) {
            setTimeout(() => {
                console.log("DarkEye: javtxt 检测到自动跳转任务，开始解析...");
                if (isDetailPageUrl(href)) {
                    parse_data_javtxt();
                }
            }, 1000);
        }
    }
})();
