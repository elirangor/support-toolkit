// background.js
// Robust opening with per-URL retries + cancel support

// Track running jobs so we can cancel mid-loop
const jobs = new Map(); // jobId -> { cancelled: boolean }

function sleep(ms, jobId) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    // light cancel polling; if cancelled, resolve early
    const check = () => {
      if (jobs.get(jobId)?.cancelled) {
        clearTimeout(t);
        resolve(false);
      } else {
        setTimeout(check, 50);
      }
    };
    setTimeout(check, 50);
  });
}

// Detect errors that are safe to retry
function isTransientTabError(errMsg = "") {
  return /Tabs cannot be edited right now|user may be dragging a tab|currently being dragged|No browser window/i.test(
    String(errMsg)
  );
}

// Create a tab with retries/backoff. Returns the Tab or null (skipped), never throws.
async function createTabWithRetry({ url, windowId, jobId, maxRetries = 20 }) {
  let attempt = 0;
  while (true) {
    if (jobs.get(jobId)?.cancelled) return null;

    try {
      const tab = await chrome.tabs.create({ url, active: false, windowId });
      return tab; // success
    } catch (e) {
      const msg = e?.message || String(e);
      // Retry transient errors; skip others
      if (isTransientTabError(msg) && attempt < maxRetries) {
        // simple backoff: 100ms + 150ms*attempt, capped at ~2s
        const waitMs = Math.min(2000, 100 + attempt * 150);
        await sleep(waitMs, jobId);
        attempt++;
        continue;
      } else {
        console.warn("[Support Toolkit] Skipping URL due to non-retryable error:", url, msg);
        return null;
      }
    }
  }
}

async function openAndGroupInBackground({ urls, windowId, delayMs, jobId }) {
  const tabIds = [];
  jobs.set(jobId, { cancelled: false });

  try {
    for (const u of urls) {
      if (jobs.get(jobId)?.cancelled) break;

      const tab = await createTabWithRetry({ url: u, windowId, jobId });
      if (tab?.id != null) tabIds.push(tab.id);

      // optional delay between tabs (also cancel-aware)
      if (delayMs > 0) {
        const waited = await sleep(delayMs, jobId);
        if (!waited) break; // cancelled during delay
      }
    }

    // Group whatever we managed to open (even if cancelled or some failed)
    let groupId = null;
    if (tabIds.length) {
      try {
        groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: "Failed LP", color: "red" });
      } catch (e) {
        console.warn("[Support Toolkit] Grouping failed:", e?.message || e);
      }
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
        // If we reach this, it’s truly fatal
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

  // Report whether any jobs are currently running (for popup Stop button)
  if (msg?.type === "JOB_STATUS") {
    const runningIds = [...jobs.entries()]
      .filter(([, v]) => v && !v.cancelled)
      .map(([id]) => id);
    sendResponse({ ok: true, running: runningIds.length > 0, jobIds: runningIds });
    return true;
  }
});
