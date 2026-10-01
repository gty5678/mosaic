
// popup.js
// 仅用于检测桌面端（DarkEye Server）是否已启动

const serverStatusEl = document.getElementById("server-status");

const SERVER_URL = "http://localhost:56790";

// --- Check Server Status ---
function checkServerStatus() {
  serverStatusEl.textContent = "⚪ 正在连接...";
  
  // Set a timeout for the fetch
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  
  fetch(`${SERVER_URL}/api/v1/health`, { signal: controller.signal })
    .then(response => {
      if (response.ok) {
        serverStatusEl.textContent = "🟢 已连接到 DarkEye Server";
        serverStatusEl.style.color = "#34c759"; // Green
      } else {
        throw new Error("Server error");
      }
    })
    .catch(err => {
      console.error("Server check failed:", err);
      serverStatusEl.textContent = "🔴 桌面端未启动";
      serverStatusEl.style.color = "#ff3b30"; // Red
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

// Init check
checkServerStatus();
