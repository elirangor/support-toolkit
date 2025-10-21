// background.js
// Handles all heavy lifting in the background — continues even if popup closes.

// Track running jobs so we can cancel mid-loop
const jobs = new Map(); // jobId -> { cancelled: boolean }

async function openAndGroupInBackground({ urls, windowId, delayMs, jobId }) {
  const tabIds = [];
  jobs.set(jobId, { cancelled: false });

  try {
    for (const u of urls) {
      // Stop if cancelled
      if (jobs.get(jobId)?.cancelled) break;

      const tab = await chrome.tabs.create({ url: u, active: false, windowId });
      tabIds.push(tab.id);

      // Respect optional delay, but allow cancel during the wait
      if (delayMs > 0) {
        const waited = await new Promise(resolve => {
          const t = setTimeout(() => resolve(true), delayMs);
          // simple polling for cancel state while "sleeping"
          const check = () => {
            if (jobs.get(jobId)?.cancelled) {
              clearTimeout(t);
              resolve(false);
            } else {
              setTimeout(() => {
                // do nothing, timeout will resolve if not cancelled
              }, 0);
            }
          };
          // micro-queue single check (fast exit)
          setTimeout(check, 0);
        });
        if (!waited) break; // was cancelled during delay
      }
    }

    // If we opened any tabs, group them (nice cleanup whether cancelled or not)
    let groupId = null;
    if (tabIds.length) {
      groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: "Failed LP", color: "red" });
    }

    const wasCancelled = !!jobs.get(jobId)?.cancelled;
    return { count: tabIds.length, groupId, cancelled: wasCancelled };
  } finally {
    jobs.delete(jobId);
  }
}

// Listener for popup messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "OPEN_URLS") {
    (async () => {
      try {
        const result = await openAndGroupInBackground(msg.payload);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error(e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // keep channel open for async reply
  }

  if (msg?.type === "STOP_OPEN") {
    try {
      const { jobId } = msg;
      if (jobs.has(jobId)) {
        jobs.get(jobId).cancelled = true;
        sendResponse({ ok: true, message: "Cancellation requested." });
      } else {
        sendResponse({ ok: false, error: "No running job for that ID." });
      }
    } catch (e) {
      console.error(e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
    return true;
  }
});
