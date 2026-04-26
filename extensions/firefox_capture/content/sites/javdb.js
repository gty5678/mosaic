//javdb的站点有一个问题，就是图片有水印，作为封面无法使用。
//优点就是资源比较全，有javlib没有的一些资源。

// JavLibrary 站点：dvdid 搜索、解析、自动续跑
(function () {
    if (!window.location.href.includes("javdb.com")) return;

    const CF_NOTIFY_KEY = "darkeye_javdb_cf_desktop_notified";
    const JAVDB_WAIT_MS = 2000;
    /** Cloudflare 轮询约 28s；超时后上报 cloudflare_timeout（不整页 reload，避免打断手动验证） */
    const JAVDB_WAIT_MAX_ATTEMPTS = 14;
    /** 非 CF 时等待 .video-detail 的最大轮次（约 16s） */
    const JAVDB_DETAIL_SKELETON_MAX = 8;

    const javdbWait = { timer: null, kind: null, attempts: 0 };

    /** 首尾空白、去掉末尾 -v/-z/v/z（不区分大小写），并统一大写以便与检索一致。 */
    function normalizeCatalogId(value) {
        return (value || "")
            .trim()
            .replace(/-?[vz]$/i, "")
            .toUpperCase();
    }

    function attachMergeRequestId(payload) {
        const mid = sessionStorage.getItem("darkeye_merge_request_id");
        if (mid) payload.merge_request_id = mid;
        return payload;
    }

    function isJavdbSearchPageUrl() {
        try {
            const u = new URL(window.location.href);
            if (!/javdb\.com$/i.test(u.hostname)) return false;
            return (
                (u.pathname || "").includes("search") &&
                u.searchParams.has("q")
            );
        } catch (e) {
            return false;
        }
    }

    function isJavdbCloudflarePage() {
        const t = document.title || "";
        if (t.includes("Just a moment") || t.includes("Attention Required")) {
            return true;
        }
        if (document.querySelector("#challenge-running")) return true;
        if (document.querySelector("#cf-wrapper")) return true;
        if (document.querySelector(".cf-browser-verification")) return true;
        if (document.querySelector("body.cf-error-details")) return true;
        if (document.querySelector("#challenge-form")) return true;
        return false;
    }

    function clearJavdbCfDesktopNotifyDedupe() {
        sessionStorage.removeItem(CF_NOTIFY_KEY);
    }

    /** 每个 phase（search/detail）只通知桌面一次，避免轮询重复弹窗 */
    function notifyCloudflareChallengeIfNeeded(phase) {
        const raw = sessionStorage.getItem(CF_NOTIFY_KEY) || "";
        const seen = raw.split(",").filter(Boolean);
        if (seen.indexOf(phase) >= 0) return;
        seen.push(phase);
        sessionStorage.setItem(CF_NOTIFY_KEY, seen.join(","));
        const payload = {
            command: "notify-cloudflare-challenge",
            site: "javdb",
            phase: phase,
            serial: sessionStorage.getItem("id") || "",
            merge_request_id: sessionStorage.getItem("darkeye_merge_request_id") || "",
        };
        browser.runtime.sendMessage(attachMergeRequestId(payload)).catch(() => {});
    }

    function stopJavdbWait() {
        if (javdbWait.timer !== null) {
            clearInterval(javdbWait.timer);
            javdbWait.timer = null;
        }
        javdbWait.kind = null;
        javdbWait.attempts = 0;
    }

    function sendJavdbCrawlFailure(code) {
        browser.runtime.sendMessage(
            attachMergeRequestId({
                command: "send_crawler_result",
                id: sessionStorage.getItem("id"),
                web: "javdb",
                result: false,
                data: { darkeye_error: String(code || "unknown") },
            })
        );
    }

    function onJavdbWaitTimeout() {
        sessionStorage.setItem("darkeye_auto_parse", "false");
        sendJavdbCrawlFailure("cloudflare_timeout");
    }

    function runJavdbWaitTick() {
        if (!javdbWait.kind) return;
        javdbWait.attempts += 1;
        const kind = javdbWait.kind;

        if (kind === "search") {
            const videos = document.querySelectorAll("div.item");
            if (videos.length > 0) {
                stopJavdbWait();
                search_javdb();
                return;
            }
            if (isJavdbCloudflarePage()) {
                if (javdbWait.attempts >= JAVDB_WAIT_MAX_ATTEMPTS) {
                    stopJavdbWait();
                    onJavdbWaitTimeout();
                }
                return;
            }
            stopJavdbWait();
            sessionStorage.setItem("darkeye_auto_parse", "false");
            console.log("该番号javdb没有搜索结果");
            browser.runtime.sendMessage(
                attachMergeRequestId({
                    command: "send_crawler_result",
                    id: sessionStorage.getItem("id"),
                    web: "javdb",
                    result: false,
                    data: {},
                })
            );
            return;
        }

        if (kind === "detail") {
            const vd = document.querySelector(".video-detail");
            if (vd) {
                stopJavdbWait();
                parse_data_javdb();
                return;
            }
            if (isJavdbCloudflarePage()) {
                if (javdbWait.attempts >= JAVDB_WAIT_MAX_ATTEMPTS) {
                    stopJavdbWait();
                    onJavdbWaitTimeout();
                }
                return;
            }
            if (javdbWait.attempts >= JAVDB_DETAIL_SKELETON_MAX) {
                stopJavdbWait();
                sessionStorage.setItem("darkeye_auto_parse", "false");
                sendJavdbCrawlFailure("javdb_no_detail_dom");
            }
        }
    }

    function startJavdbWait(kind) {
        if (javdbWait.timer !== null) return;
        javdbWait.kind = kind;
        javdbWait.attempts = 0;
        javdbWait.timer = setInterval(runJavdbWaitTick, JAVDB_WAIT_MS);
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.command === "javdb-dvdid") {
            clearJavdbCfDesktopNotifyDedupe();
            stopJavdbWait();
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
            if (!search_javdb()) {
                // search_javdb 内部已处理 CF 等待或失败回传
            }
        }
    });

    function search_javdb() {
        //先解析多个结果，然后根据番号选择，找到目标页面，然后跳转后详细解析
        console.log("开始搜索javdb");
        const videos = document.querySelectorAll("div.item");
        if (videos.length === 0) {
            if (isJavdbCloudflarePage()) {
                console.log("DarkEye: javdb 搜索页 Cloudflare，轮询等待...");
                notifyCloudflareChallengeIfNeeded("search");
                sessionStorage.setItem("darkeye_auto_parse", "true");
                startJavdbWait("search");
                return false;
            }
            console.log("该番号javdb没有搜索结果");
            sessionStorage.setItem("darkeye_auto_parse", "false");
            browser.runtime.sendMessage(
                attachMergeRequestId({
                    command: "send_crawler_result",
                    id: sessionStorage.getItem("id"),
                    web: "javdb",
                    result: false,
                    data: {},
                })
            );
            return false;
        }
        console.log("搜索结果个数: " + videos.length);
        const results = Array.from(videos).map((video) => {
            const idDiv = video.querySelector(".video-title strong");
            const titleContainer = video.querySelector(".video-title");
            const link = video.querySelector("a.box");

            let titleText = "";
            if (titleContainer) {
                const clone = titleContainer.cloneNode(true);
                const strongEl = clone.querySelector("strong");
                if (strongEl) strongEl.remove();
                titleText = clone.textContent.trim();
            }

            const href = link ? link.getAttribute("href") : "";

            return {
                id: idDiv ? idDiv.textContent.trim() : "",
                title: titleText,
                url: href ? `https://javdb.com${href}` : "",
            };
        });
        const searchId = normalizeCatalogId(sessionStorage.getItem("id"));
        let targetUrl = null;

        if (searchId) {
            const matched = results.find(
                (item) => normalizeCatalogId(item.id) === searchId
            );
            if (matched) {
                targetUrl = matched.url;
            }
        }

        if (!targetUrl && results.length > 0) {
            targetUrl = results[0].url;
        }
        if (targetUrl) {
            sessionStorage.setItem("darkeye_auto_parse", "true");
            window.location.href = targetUrl;
            parse_data_javdb();
        }
    }

    function parse_data_javdb() {
        // 这个是解析 JavDB 详细页
        if (window.location.href.includes("javdb.com")) {
            const videoDetail = document.querySelector(".video-detail");
            if (!videoDetail) {
                if (isJavdbCloudflarePage()) {
                    console.log(
                        "DarkEye: javdb 详情页 Cloudflare，轮询等待 .video-detail..."
                    );
                    notifyCloudflareChallengeIfNeeded("detail");
                } else {
                    console.log("DarkEye: javdb 详情页等待 .video-detail...");
                }
                sessionStorage.setItem("darkeye_auto_parse", "true");
                startJavdbWait("detail");
                return;
            }

            const data = {};

            const panelBlocks = videoDetail.querySelectorAll(
                ".movie-panel-info .panel-block"
            );
            const getPanelValue = (labelText) => {
                for (const block of panelBlocks) {
                    const strongEl = block.querySelector("strong");
                    if (!strongEl) continue;
                    if (strongEl.textContent.trim().startsWith(labelText)) {
                        const val = block.querySelector(".value");
                        return val ? val.textContent.trim() : "";
                    }
                }
                return "";
            };

            // 番号：详情页「番號」面板（规范化同 search_javdb）
            data.id = normalizeCatalogId(getPanelValue("番號:"));
            console.log("番号: " + data.id);

            // 标题：优先当前显示标题（中文），否则用原始标题（日文）
            const currentTitleEl = videoDetail.querySelector(
                "h2.title strong.current-title"
            );
            const originTitleEl = videoDetail.querySelector(
                "h2.title .origin-title"
            );
            if (currentTitleEl) {
                data.title = currentTitleEl.textContent.trim();
            } else if (originTitleEl) {
                data.title = originTitleEl.textContent.trim();
            } else {
                data.title = "";
            }
            console.log("标题: " + data.title);

            data.release_date = getPanelValue("日期:");
            const lengthRaw = getPanelValue("時長:");
            const lengthMatch = lengthRaw.match(/\d+/);
            data.length = lengthMatch ? lengthMatch[0] : "0";
            data.director = getPanelValue("導演:") || "----";
            data.maker = getPanelValue("片商:") || "----";
            data.label = getPanelValue("發行:") || "----";
            data.series = getPanelValue("系列:") || "----";

            // 类别
            const genreBlock = Array.from(panelBlocks).find((block) => {
                const strongEl = block.querySelector("strong");
                return strongEl && strongEl.textContent.trim().startsWith("類別:");
            });
            if (genreBlock) {
                const genreLinks = genreBlock.querySelectorAll(".value a");
                data.genre = Array.from(genreLinks).map((el) =>
                    el.textContent.trim()
                );
            } else {
                data.genre = [];
            }

            // 演员：按 strong.symbol.female / strong.symbol.male 区分女优与男优
            const castBlock = Array.from(panelBlocks).find((block) => {
                const strongEl = block.querySelector("strong");
                return strongEl && strongEl.textContent.trim().startsWith("演員:");
            });
            data.actress = [];
            data.actor = [];
            if (castBlock) {
                const valueEl = castBlock.querySelector(".value");
                if (valueEl) {
                    const links = valueEl.querySelectorAll("a");
                    for (const a of links) {
                        const name = a.textContent.trim();
                        if (!name) continue;
                        const next = a.nextElementSibling;
                        if (next && next.classList.contains("symbol")) {
                            if (next.classList.contains("female")) {
                                data.actress.push(name);
                            } else if (next.classList.contains("male")) {
                                data.actor.push(name);
                            }
                        } else {
                            data.actress.push(name);
                        }
                    }
                }
            }

            const previewTileRoot =
                videoDetail.querySelector("div.tile-images.preview-images") ||
                document.querySelector("div.tile-images.preview-images");
            data.fanart = previewTileRoot
                ? Array.from(
                      previewTileRoot.querySelectorAll("a.tile-item[href]")
                  )
                      .map((a) => (a.getAttribute("href") || "").trim())
                      .filter((h) => h && !h.startsWith("#"))
                : [];

            // 封面，这个不要封面，有水印，宁可空也不要水印
            const imgElement = videoDetail.querySelector(".video-cover");
            data.cover = imgElement ? imgElement.src : "";

            sessionStorage.setItem("darkeye_auto_parse", "false");
            clearJavdbCfDesktopNotifyDedupe();
            console.log(data);
            if (data) {
                console.debug("发送数据");
                browser.runtime.sendMessage(
                    attachMergeRequestId({
                        command: "send_crawler_result",
                        id: sessionStorage.getItem("id"),
                        web: "javdb",
                        result: true,
                        data: data,
                    })
                );
            }
        }
    }

    if (sessionStorage.getItem("darkeye_auto_parse") === "true") {
        sessionStorage.removeItem("darkeye_auto_parse");
        if (isJavdbSearchPageUrl()) {
            setTimeout(() => {
                console.log(
                    "DarkEye: 检测到自动任务（搜索页），继续 search_javdb..."
                );
                search_javdb();
            }, 500);
        } else {
            setTimeout(() => {
                console.log("DarkEye: 检测到自动跳转任务，开始解析...");
                parse_data_javdb();
            }, 1000);
        }
    }
})();
