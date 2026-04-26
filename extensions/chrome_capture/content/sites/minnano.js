// Minnano AV：女优详情页 — 悬浮「采集」按钮（与 minnano-scrape 对齐）
(function () {
  if (!window.location.href.includes("minnano-av.com")) return;
  const Scrape = window.DarkEyeMinnanoScrape;
  if (!Scrape) {
    console.error("DarkEye: DarkEyeMinnanoScrape not loaded");
    return;
  }

  function init() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", init);
      return;
    }
    if (!Scrape.isActressDetailPage(document)) return;
    if (document.getElementById("darkeye-minnano-capture-btn")) return;

    const btn = document.createElement("button");
    btn.id = "darkeye-minnano-capture-btn";
    btn.type = "button";
    btn.textContent = "采集";
    function styleBase() {
      btn.style.cssText = [
        "position:fixed",
        "bottom:24px",
        "right:24px",
        "z-index:2147483647",
        "padding:8px 12px",
        "font-size:14px",
        "line-height:1.2",
        "cursor:pointer",
        "border:1px solid #1d4ed8",
        "border-radius:4px",
        "background:#2563eb",
        "color:#fff",
        "font-family:sans-serif",
      ].join(";");
    }
    styleBase();

    btn.onclick = () => {
      if (btn.disabled) return;
      const fresh = Scrape.scrapeActressPage(document);
      btn.textContent = "…";
      btn.disabled = true;
      btn.style.background = "#1d4ed8";
      btn.style.color = "#fff";
      btn.style.borderColor = "#1e40af";
      const p = chrome.runtime.sendMessage({
        command: "capture_minnano_actress",
        data: fresh,
      });
      const doneOk = () => {
        btn.textContent = "已采集";
        btn.style.background = "#dcfce7";
        btn.style.color = "#166534";
        btn.style.borderColor = "#86efac";
      };
      const doneFail = () => {
        btn.textContent = "失败";
        btn.disabled = false;
        btn.style.background = "#fef2f2";
        btn.style.color = "#991b1b";
        btn.style.borderColor = "#fecaca";
      };
      if (p && typeof p.then === "function") {
        p.then(doneOk).catch(doneFail);
      } else {
        doneOk();
      }
    };

    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
