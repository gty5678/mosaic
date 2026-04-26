// JavLibrary 站点：dvdid 搜索、解析、自动续跑
(function() {
  if (!window.location.href.includes("javlibrary.com")) return;

  const CF_NOTIFY_KEY = "darkeye_javlib_cf_desktop_notified";

  function attachMergeRequestId(payload) {
    const mid = sessionStorage.getItem("darkeye_merge_request_id");
    if (mid) payload.merge_request_id = mid;
    return payload;
  }

  function isJavlibraryCloudflarePage() {
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

  function clearJavlibCfDesktopNotifyDedupe() {
    sessionStorage.removeItem(CF_NOTIFY_KEY);
  }

  /** 本轮任务遇到 Cloudflare 时只通知桌面一次（不区分搜索页 / 详情页） */
  function notifyCloudflareChallengeIfNeeded() {
    if (sessionStorage.getItem(CF_NOTIFY_KEY) === "1") return;
    sessionStorage.setItem(CF_NOTIFY_KEY, "1");
    const payload = {
      command: "notify-cloudflare-challenge",
      site: "javlib",
      serial: sessionStorage.getItem("id") || "",
      merge_request_id:
        sessionStorage.getItem("darkeye_merge_request_id") || "",
    };
    chrome.runtime.sendMessage(attachMergeRequestId(payload)).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === "javlibrary-dvdid"){
        console.log("DarkEye: JavLibrary 开始爬虫任务...");
        clearJavlibCfDesktopNotifyDedupe();
        sessionStorage.setItem('darkeye_auto_parse', 'true')
        sessionStorage.setItem('id', message.serial)
        if (message.mergeRequestId) {
          sessionStorage.setItem("darkeye_merge_request_id", message.mergeRequestId);
        } else {
          sessionStorage.removeItem("darkeye_merge_request_id");
        }
        if (!search_javlibrary()){
            //这里回传失败的信息
        }
    }
  });

  function search_javlibrary(){
    if (window.location.href.startsWith("https://www.javlibrary.com/cn/vl_searchbyid.php?keyword=")){
        const videos = document.querySelectorAll('div.video');
        if (videos.length === 0) {
            if (isJavlibraryCloudflarePage()) {
                console.log("DarkEye: 遇到 Cloudflare，暂不报错，等待自动重试...");
                notifyCloudflareChallengeIfNeeded();
                sessionStorage.setItem('darkeye_auto_parse', 'true');
                return false;
            }
            console.log("该番号javlib没有搜索结果");
            sessionStorage.setItem('darkeye_auto_parse', 'false')
            chrome.runtime.sendMessage(attachMergeRequestId({
                command: "send_crawler_result",
                id: sessionStorage.getItem('id'),
                web:'javlib',
                result: false,
                data:{}
            }));
            return false;
        }
        console.log("搜索结果个数: " + videos.length);
        const results = Array.from(videos).map(video => {
            const idDiv = video.querySelector('.id');
            const titleDiv = video.querySelector('.title');
            const link = video.querySelector('a');
            return {
                id: idDiv ? idDiv.textContent.trim() : "",
                title: titleDiv ? titleDiv.textContent.trim() : "",
                url: link ? link.href : ""
            };
        });
        const filtered = results.filter(item => !item.title.includes("ブルーレイディスク"));//这个是过滤掉蓝光碟的
        let targetUrl = null;
        if (filtered.length > 0) {
            targetUrl = filtered[0].url;
        } else if (results.length > 0) {
            targetUrl = results[0].url;
        }
        if (targetUrl) {
            sessionStorage.setItem('darkeye_auto_parse', 'true');
            window.location.href = targetUrl;
        }
    } else {
        parse_data_javlibrary();
    }
  }

  function parse_data_javlibrary(){
    if (window.location.href.includes("javlibrary.com")) {
        if (isJavlibraryCloudflarePage()) {
            console.log(
                "DarkEye: JavLibrary 详情页 Cloudflare，等待手动验证后继续..."
            );
            notifyCloudflareChallengeIfNeeded();
            sessionStorage.setItem("darkeye_auto_parse", "true");
            return;
        }
        const data = {};
        const dvdidElement = document.querySelector("#video_id .text");
        data.id = dvdidElement ? dvdidElement.textContent.trim() : "";
        data.id = /[vz]$/.test(data.id) ? data.id.slice(0, -1) : data.id;
        console.log("番号: " + data.id);

        const titleElement = document.querySelector(".post-title.text a");
        if (titleElement) {
            let newtitle = titleElement.textContent.replace(data.id,'').trim();
            data.title = newtitle;
            console.log("标题: " + data.title);
        }

        const dateElement = document.querySelector("#video_date .text");
        data.release_date = dateElement ? dateElement.textContent.trim() : "";

        const lengthElement = document.querySelector("#video_length .text");
        data.length = lengthElement ? lengthElement.textContent.trim() : "";

        const directorElement = document.querySelector("#video_director .text");
        data.director = directorElement ? directorElement.textContent.trim() : "";

        const makerElement = document.querySelector("#video_maker .text");
        data.maker = makerElement ? makerElement.textContent.trim() : "";

        const labelElement = document.querySelector("#video_label .text");
        data.label = labelElement ? labelElement.textContent.trim() : "";

        const genreElements = document.querySelectorAll("#video_genres .genre a");
        data.genre = Array.from(genreElements).map(el => el.textContent.trim());

        const castElements = document.querySelectorAll("#video_cast .star a");
        data.actress = Array.from(castElements).map(el => el.textContent.trim());

        const imgElement = document.querySelector("#video_jacket_img");
        data.image = imgElement ? imgElement.src : "";

        const previewThumbs = document.querySelector("div.previewthumbs");
        data.fanart = [];
        if (previewThumbs) {
          const anchors = previewThumbs.querySelectorAll("a[href]");
          data.fanart = Array.from(anchors).map((a) => {
            const href = (a.getAttribute("href") || "").trim();
            if (href) return href;
            const img = a.querySelector("img[src]");
            return img ? (img.getAttribute("src") || "").trim() : "";
          }).filter(Boolean);
        }

        sessionStorage.setItem('darkeye_auto_parse', 'false');
        clearJavlibCfDesktopNotifyDedupe();
        console.log(data);
        if (data) {
            console.debug("发送数据");
            chrome.runtime.sendMessage(attachMergeRequestId({
                command: "send_crawler_result",
                id: sessionStorage.getItem('id'),
                web:'javlib',
                result: true,
                data:data
            }));
        }
    }
  }

  if (sessionStorage.getItem('darkeye_auto_parse') === 'true') {
      sessionStorage.removeItem('darkeye_auto_parse');
      const isVlSearchById =
          window.location.href.startsWith(
              "https://www.javlibrary.com/cn/vl_searchbyid.php?keyword="
          );
      if (isVlSearchById) {
          // 含 Cloudflare：首次 complete 已消耗 pendingCrawler，通过后整页刷新不会再收
          // javlibrary-dvdid；需在搜索页主动再跑 search_javlibrary。
          setTimeout(() => {
              console.log(
                  "DarkEye: 搜索页接力（例如已通过验证），继续执行..."
              );
              search_javlibrary();
          }, 800);
      } else {
          setTimeout(() => {
              console.log("DarkEye: 检测到自动跳转任务，开始解析...");
              parse_data_javlibrary();
          }, 1000);
      }
  }
})();
