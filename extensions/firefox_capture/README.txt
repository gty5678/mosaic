This extension helps users extract information from the current webpage and send it to a local application for processing.

The extension only works when the user explicitly triggers it (e.g., by clicking a button). It reads content from the active tab and sends the data to a local service running on the user's machine via localhost.

No data is transmitted to any remote servers.
No personal data is collected, stored, or shared.
All processing is performed locally on the user's device.

Permissions explanation:
- activeTab: Used to access the content of the current webpage only after user interaction.
- localhost (127.0.0.1): Used to communicate with a local application for data processing.

The extension does not track browsing activity, does not run background data collection, and does not execute any remote code.


为何 Chrome 会「总像新开一个窗口」
Chrome 用的是 Manifest V3 的 service worker（见 manifest.json 里 "service_worker": "background.js"）：

Service worker 会在空闲一段时间后被浏览器结束；
一旦被结束，内存里的全局变量全部清零，包括 crawlerWindowId / crawlerWindowPromise；
下次收到爬虫指令时，脚本眼里等于「从来没有专用窗口」，又会走 chrome.windows.create(...)；
你之前最小化/藏起来的那个爬虫窗口往往还在，只是扩展已经不记得它的 windowId 了，于是就再开一个 → 看起来像「每次一个新窗口」。
Firefox 用的是 MV2 常驻 background 页面（"background": {"scripts": ["background.js"]}），页面一般一直挂着，crawlerWindowId 不会轻易丢，所以更像「固定一个窗口」。

小结
环境	后台形态	crawlerWindowId 能否长期保留
Chrome 扩展（你这份）
MV3 Service Worker
空闲重启后会丢 → 容易重复建窗
Firefox 扩展（你这份）
MV2 常驻后台
通常一直有效 → 更像单窗口
若要在 Chrome 里也像「固定一个窗口」，需要 在 Service Worker 之外持久化窗口 ID（例如 chrome.storage.session / local，并在用时 chrome.windows.get 校验窗口仍存在；不存在再 create）。如果你希望，我可以在仓库里直接补一版持久化实现。


现在的爬虫逻辑很简单粗暴，也没有调度，就是来了判断要爬几个网站，然后有一个merge的专门来收数据，时间到了就合并发数据了。
如果定时内没有发后，这个页面就会永久的留在那里

合并超时后任务算结束，但未成功回传结果的标签没有被关掉「超 30s 后就会留下来」：更准确说是——合并超时后任务算结束，但未成功回传结果的标签没有被关掉，所以你会看到标签仍然留着；这不是「30 秒专门为了保留页面」，而是超时收尾没关 tab 的表现。

现在遇到的问题，最顺利，网页顺利加载爬取结束

遇到cloudflare验证，又分两种一种非点击盾，一种点击盾，然后javlib和javdb的盾又不一样
遇到页面一直在加载的情况，永久加载中，加载了超过30s后好了，或者加载30s空白
遇到页面加载好了，但是什么都没有，刷新后又有了

javtxt经常遇到一直加载的情况。