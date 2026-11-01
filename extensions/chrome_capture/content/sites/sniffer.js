// 作品番号探测器：JavDB / JavLibrary / JavTxt 列表页「已收录 / + 采集」标签；详情页 video-detail 番号嗅探
(function() {
    const href = window.location.href;
    const isListSite = href.includes("javdb.com") || href.includes("javlibrary.com") || href.includes("javtxt.com");

    const State = {
        pendingItems: new Map(),
        checkQueue: new Set(),
        checkTimer: null
    };

    class SiteSniffer {
        constructor() {
            this.observer = null;
        }

        /** 标签位置：'top-left' | 'bottom-right'，子类可覆盖 */
        getTagPosition() {
            return 'top-left';
        }

        init() {
            this.scanExisting();
            this.startObserver();
            this.startProcessor();
        }

        scanExisting() {
            const items = document.querySelectorAll(this.itemSelector);
            items.forEach(item => this.processItem(item));
        }

        startObserver() {
            this.observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) {
                            if (node.matches && node.matches(this.itemSelector)) {
                                this.processItem(node);
                            }
                            if (node.querySelectorAll) {
                                const children = node.querySelectorAll(this.itemSelector);
                                children.forEach(item => this.processItem(item));
                            }
                        }
                    });
                });
            });
            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        startProcessor() {}

        /** 统一规范化番号：去掉末尾的 -V（不区分大小写）等 */
        normalizeId(rawId) {
            if (!rawId) return null;
            const trimmed = rawId.trim();
            if (!trimmed) return null;
            // 去掉末尾的 -V / -v 或单独的 v
            const normalized = trimmed.replace(/-?v$/i, "");
            return normalized || null;
        }

        processItem(element) {
            if (element.dataset.darkeyeProcessed) return;
            const rawId = this.extractId(element);
            const id = this.normalizeId(rawId);
            console.log("DarkEye: 提取到ID:", rawId, "规范化为:", id);
            if (!id) return;

            element.dataset.darkeyeProcessed = "true";
            State.pendingItems.set(id, { element });
            State.checkQueue.add(id);
            this.scheduleCheck();
        }

        scheduleCheck() {
            if (State.checkTimer) clearTimeout(State.checkTimer);
            State.checkTimer = setTimeout(() => this.performCheck(), 500);
        }

        async performCheck() {
            if (State.checkQueue.size === 0) return;
            const ids = Array.from(State.checkQueue);
            State.checkQueue.clear();

            try {
                const response = await chrome.runtime.sendMessage({
                    command: "check_existence",
                    items: ids
                });
                if (response && response.results) {
                    Object.entries(response.results).forEach(([id, exists]) => {
                        console.log("DarkEye:更新UI", id);
                        this.updateUI(id, exists);
                    });
                }
            } catch (e) {
                console.error("DarkEye: Check existence failed", e);
            }
        }

        updateUI(id, exists) {
            const item = State.pendingItems.get(id);
            if (!item) return;
            const { element } = item;

            const tag = document.createElement("div");
            tag.className = "darkeye-tag darkeye-tag--" + this.getTagPosition();
            if (exists) {
                tag.classList.add("exists");
                tag.textContent = "已收录";
                tag.title = "本地已收录";
            } else {
                tag.classList.add("not-found");
                tag.textContent = "+ 采集";
                tag.title = "点击采集到本地";
                tag.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.captureItem(tag, id, element);
                };
            }

            if (getComputedStyle(element).position === 'static') {
                element.style.position = 'relative';
            }
            element.appendChild(tag);
            // 若容器是 <a>（如 javtxt 的 a.work），在冒泡阶段拦截，只拦跳转、不拦标签自身的点击
            if (element.tagName === 'A' && !element.dataset.darkeyeClickBound) {
                element.dataset.darkeyeClickBound = '1';
                element.addEventListener('click', (e) => {
                    if (e.target.closest('.darkeye-tag')) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }, false);
            }
            console.log("DarkEye: 注入标签:", tag);
        }

        async captureItem(tag, id, element) {
            tag.classList.remove("not-found");
            tag.classList.add("loading");
            tag.textContent = "发送中...";

            try {
                const payload = {
                    url: window.location.href,
                    title: document.title,
                    content: id,
                    extra: {
                        source: "javdb_sniff",
                        timestamp: Date.now()
                    }
                };
                const response = await chrome.runtime.sendMessage({
                    command: "capture_one",
                    payload: payload
                });
                if (response && !response.error) {
                    tag.classList.remove("loading");
                    tag.classList.add("exists");
                    tag.textContent = "已收录";
                    tag.onclick = null;
                } else {
                    throw new Error(response ? response.error : "Unknown error");
                }
            } catch (e) {
                console.error("Capture failed", e);
                tag.classList.remove("loading");
                tag.classList.add("error");
                tag.textContent = "失败";
                setTimeout(() => {
                    tag.classList.remove("error");
                    tag.classList.add("not-found");
                    tag.textContent = "+ 采集";
                }, 2000);
            }
        }
    }

    /** JavDB 列表页嗅探：探测 .item 内 .video-title strong 的番号 */
    class JavDBSniffer extends SiteSniffer {
        constructor() {
            super();
            this.itemSelector = ".item";
        }
        extractId(element) {
            const titleStrong = element.querySelector(".video-title strong");
            if (titleStrong) return titleStrong.textContent.trim();
            return null;
        }
    }

    /** JavLibrary 列表页嗅探：探测 .video 内 .id 的番号 */
    class JavLibrarySniffer extends SiteSniffer {
        constructor() {
            super();
            this.itemSelector = ".video";
        }
        extractId(element) {
            const titleStrong = element.querySelector(".id");
            if (titleStrong) return titleStrong.textContent.trim();
            return null;
        }
    }

    /** JavTxt 列表页嗅探：探测 a.work 内 .work-id 的番号 */
    class JavTxtSniffer extends SiteSniffer {
        constructor() {
            super();
            this.itemSelector = "a.work";
        }
        getTagPosition() {
            return 'bottom-right';
        }
        extractId(element) {
            const workIdEl = element.querySelector(".work-id");
            if (!workIdEl) return null;
            // 番号在 .work-id 内，后面可能有 .work-actress 等，取第一个空白前的 token（如 SNOS-079）
            const raw = workIdEl.textContent.trim();
            const first = raw.split(/\s+/)[0];
            return first || null;
        }
    }

    /** 详情页嗅探：探测 div.video-detail[data-controller="movie-detail"] 内第一个 strong 的番号，标签显示在 .video-meta-panel 右上角 */
    class JavDBDetailSniffer extends SiteSniffer {
        constructor() {
            super();
            this.itemSelector = 'div.video-detail[data-controller="movie-detail"]';
        }
        getTagPosition() {
            return 'top-right';
        }
        extractId(element) {
            const h2 = element.querySelector('h2.title.is-4');
            if (!h2) return null;
            // 第一个 <strong> 为番号（如 STARS-998），第二个为标题
            const firstStrong = h2.querySelector('strong');
            if (!firstStrong) return null;
            const code = firstStrong.textContent.trim();
            return code || null;
        }
        updateUI(id, exists) {
            const item = State.pendingItems.get(id);
            if (!item) return;
            const { element } = item;
            const container = element.querySelector('.video-meta-panel') || element;

            const tag = document.createElement("div");
            tag.className = "darkeye-tag darkeye-tag--" + this.getTagPosition();
            if (exists) {
                tag.classList.add("exists");
                tag.textContent = "已收录";
                tag.title = "本地已收录";
            } else {
                tag.classList.add("not-found");
                tag.textContent = "+ 采集";
                tag.title = "点击采集到本地";
                tag.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.captureItem(tag, id, element);
                };
            }

            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
            container.appendChild(tag);
            console.log("DarkEye: 注入标签 (JavDB 详情 video-meta-panel):", tag);
        }
    }

    /** JavLibrary 详情页嗅探：探测 tr 内 td.header「识别码:」+ td.text 结构，标签显示在 #rightcolumn 右上角 */
    class JavLibraryDetailSniffer extends SiteSniffer {
        constructor() {
            super();
            this.itemSelector = 'tr:has(td.header):has(td.text)';
        }
        getTagPosition() {
            return 'top-right';
        }
        extractId(element) {
            const headerTd = element.querySelector('td.header');
            const textTd = element.querySelector('td.text');
            if (!headerTd || !textTd) return null;
            if (!headerTd.textContent.trim().includes('识别码')) return null;
            const code = textTd.textContent.trim();
            return code || null;
        }
        updateUI(id, exists) {
            const item = State.pendingItems.get(id);
            if (!item) return;
            const { element } = item;
            const container = document.getElementById('video_info');
            if (!container) return;

            const existing = container.querySelector('.darkeye-tag');
            if (existing) existing.remove();

            const tag = document.createElement("div");
            tag.className = "darkeye-tag darkeye-tag--" + this.getTagPosition();
            if (exists) {
                tag.classList.add("exists");
                tag.textContent = "已收录";
                tag.title = "本地已收录";
            } else {
                tag.classList.add("not-found");
                tag.textContent = "+ 采集";
                tag.title = "点击采集到本地";
                tag.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.captureItem(tag, id, element);
                };
            }

            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
            container.appendChild(tag);
            console.log("DarkEye: 注入标签 (JavLibrary 详情 #rightcolumn):", tag);
        }
    }

    /** JavTxt 详情页嗅探：探测 dl 内 dd「🆔 番号」后的 dt，提取番号（如 tek-102）并转为大写后检测 */
    class JavTxtDetailSniffer extends SiteSniffer {
        constructor() {
            super();
            this.itemSelector = 'dl';
        }
        
        getTagPosition() {
            return 'top-right';
        }

        extractId(element) {
            const dds = element.querySelectorAll('dd');
            for (const dd of dds) {
                if (!dd.textContent.includes('番号')) continue;
                const dt = dd.nextElementSibling;
                if (!dt || dt.tagName !== 'DT') continue;
                const raw = dt.textContent.trim();
                const code = raw.split(/[\s(]/)[0].trim();
                if (!code) continue;
                return code.toUpperCase();
            }
            return null;
        }

    }

    const url = window.location.href;
    let activeSniffer = null;
    if (url.includes("javdb.com")) {
        activeSniffer = new JavDBSniffer();
    } else if (url.includes("javlibrary.com")) {
        activeSniffer = new JavLibrarySniffer();
    } else if (url.includes("javtxt.com")) {
        activeSniffer = new JavTxtSniffer();
    }

    function initSniffers() {
        if (activeSniffer) {
            console.log("DarkEye: 启动列表页嗅探器");
            activeSniffer.init();
        }
        // JavDB 详情页：video-detail 结构
        const javdbDetailSniffer = new JavDBDetailSniffer();
        javdbDetailSniffer.init();
        // JavLibrary 详情页：识别码 tr 结构
        const javLibraryDetailSniffer = new JavLibraryDetailSniffer();
        javLibraryDetailSniffer.init();
        // JavTxt 详情页：dl 内 🆔 番号 + dt 结构
        const javTxtDetailSniffer = new JavTxtDetailSniffer();
        javTxtDetailSniffer.init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSniffers);
    } else {
        initSniffers();
    }
})();
