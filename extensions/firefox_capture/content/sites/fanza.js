// Fanza 站点：搜索、解析、年龄确认
(function() {
  if (!window.location.href.includes("dmm.co.jp")) return;

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === "fanza-dvdid"){
        sessionStorage.setItem('darkeye_fanza_parse', 'true');
        if (message.serial) {
            sessionStorage.setItem('darkeye_fanza_serial', message.serial);
        }
        serach_fanza();
    }
  });

  function serach_fanza() {
      console.log("DarkEye: Fanza checkAndParse...");
      const links = Array.from(document.querySelectorAll('a, input[type="submit"], button'));
      const yesBtn = links.find(el => {
          const text = el.textContent || el.value || "";
          return text.includes("はい") || text.includes("Enter");
      });
      if (yesBtn && (document.body.innerText.includes("18歳未満") || document.body.innerText.includes("Age Verification"))) {
          console.log("DarkEye: 检测到年龄确认，自动点击...");
          yesBtn.click();
          return;
      }
      if (window.location.href.includes("dmm.co.jp/mono/-/search/")) {
          console.log("DarkEye: Fanza 搜索结果页，开始提取...");
          const items = document.querySelectorAll('div.border-r.border-b.border-gray-300');
          const results = Array.from(items).map(item => {
              const linkElement = item.querySelector('a');
              if (linkElement) {
                  const url = linkElement.href;
                  const match = url.match(/cid=([^/&?]+)/);
                  if (match) {
                      return { cid: match[1], url: url };
                  }
              }
              return null;
          }).filter(item => item !== null);
          console.log("DarkEye Fanza Results:", results);
          const serial = sessionStorage.getItem('darkeye_fanza_serial') || "";
      }
  }

  function parse_data_fanza(){
      sessionStorage.removeItem('darkeye_fanza_parse');
      sessionStorage.removeItem('darkeye_fanza_serial');
  }

  function checkAndParseFanza() {
      serach_fanza();
  }

  if (sessionStorage.getItem('darkeye_fanza_parse') === 'true') {
      setTimeout(checkAndParseFanza, 1000);
  }
})();
