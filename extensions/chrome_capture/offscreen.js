const SERVER_URL = "http://localhost:56790";
const SSE_URL = `${SERVER_URL}/events`;

let eventSource = null;

function startSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  try {
    console.log("DarkEye (Chrome Offscreen): Connecting to SSE server at " + SSE_URL);
    eventSource = new EventSource(SSE_URL);

    eventSource.onopen = () => {
      console.log("DarkEye (Chrome Offscreen): Connected to SSE server");
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("DarkEye (Chrome Offscreen): Received command", data);
        chrome.runtime.sendMessage({ type: "sse_command", payload: data });
      } catch (e) {
        console.error("DarkEye (Chrome Offscreen): Error parsing SSE message", e);
      }
    };

    eventSource.onerror = (err) => {
      console.error("DarkEye (Chrome Offscreen): SSE Error", err);
      try {
        eventSource.close();
      } catch (e) {}
      eventSource = null;
      setTimeout(startSSE, 5000);
    };
  } catch (e) {
    console.error("DarkEye (Chrome Offscreen): Failed to create EventSource", e);
    setTimeout(startSSE, 5000);
  }
}

startSSE();

