// background.js
// Robust opening with per-URL retries + cancel support + keyboard shortcuts
// Fixed: Memory leaks, rate limiting, job cleanup, security hardening

import {
  MAX_TABS_PER_JOB,
  sanitizeUrl,
  sleep,
  extractAll,
  extractUrlsFromHtml,
  unique,
  parseCompanyCount,
  parseVersionErrorCount,
  rowsToTSV,
  tableToHTML,
  pad2
} from './utils.js';

// Track running jobs so we can cancel mid-loop
const jobs = new Map(); // jobId -> { cancelled: boolean, timestamp: number }

// Constants
const JOB_CLEANUP_INTERVAL = 120000; // 2 minutes
const JOB_MAX_AGE = 900000; // 15 minutess

// Periodic cleanup of orphaned jobs
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (job.timestamp && now - job.timestamp > JOB_MAX_AGE) {
      console.log('[Support Toolkit] Cleaning up old job:', jobId);
      jobs.delete(jobId);
    }
  }
}, JOB_CLEANUP_INTERVAL);

// Detect errors that are safe to retry
function isTransientTabError(errMsg = "") {
  return /Tabs cannot be edited right now|user may be dragging a tab|currently being dragged|No browser window/i.test(
    String(errMsg)
  );
}

// Create a tab with retries/backoff. Returns the Tab or null (skipped), never throws.
async function createTabWithRetry({ url, windowId, jobId, maxRetries = 20 }) {
  // Validate URL first
  const cleanUrl = sanitizeUrl(url);
  if (!cleanUrl) {
    return null;
  }

  let attempt = 0;
  while (true) {
    if (jobs.get(jobId)?.cancelled) return null;

    try {
      const tab = await chrome.tabs.create({ url: cleanUrl, active: false, windowId });
      return tab; // success
    } catch (e) {
      const msg = e?.message || String(e);
      // Retry transient errors; skip others
      if (isTransientTabError(msg) && attempt < maxRetries) {
        const waitMs = Math.min(2000, 100 + attempt * 150);
        // Use the utility sleep with a cancellation check callback
        await sleep(waitMs, () => jobs.get(jobId)?.cancelled);
        attempt++;
        continue;
      } else {
        console.warn('[Support Toolkit] Skipping URL due to non-retryable error:', cleanUrl, msg);
        return null;
      }
    }
  }
}

async function openAndGroupInBackground({ urls, windowId, delayMs, jobId }) {
  // Validate tab count limit
  if (urls.length > MAX_TABS_PER_JOB) {
    throw new Error(`Cannot open more than ${MAX_TABS_PER_JOB} tabs at once. Found ${urls.length} URLs.`);
  }

  const tabIds = [];
  jobs.set(jobId, { cancelled: false, timestamp: Date.now() });

  try {
    for (const u of urls) {
      if (jobs.get(jobId)?.cancelled) break;

      const tab = await createTabWithRetry({ url: u, windowId, jobId });
      if (tab?.id != null) tabIds.push(tab.id);

      // optional delay between tabs (also cancel-aware)
      if (delayMs > 0) {
        const waited = await sleep(delayMs, () => jobs.get(jobId)?.cancelled);
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
        console.warn('[Support Toolkit] Grouping failed:', e?.message || e);
      }
    }

    const wasCancelled = !!jobs.get(jobId)?.cancelled;
    return { count: tabIds.length, groupId, cancelled: wasCancelled };
  } finally {
    jobs.delete(jobId);
  }
}

// Show notification to user
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: title,
    message: message,
    priority: 2
  });
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
    return true;
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

  if (msg?.type === "JOB_STATUS") {
    const runningIds = [...jobs.entries()]
      .filter(([, v]) => v && !v.cancelled)
      .map(([id]) => id);
    sendResponse({ ok: true, running: runningIds.length > 0, jobIds: runningIds });
    return true;
  }
});

// ===== KEYBOARD SHORTCUTS HANDLER =====
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Support Toolkit] Command received:', command);

  try {
    if (command === "open-lp-urls") {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!currentTab?.id) {
        showNotification('Support Toolkit', 'No active tab found');
        return;
      }

      // Read selection from page
      const injected = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id, allFrames: true },
        func: () => {
          function getSelectionHtml(sel) {
            if (!sel || sel.rangeCount === 0) return "";
            const range = sel.getRangeAt(0).cloneContents();
            const div = document.createElement("div");
            div.appendChild(range);
            return div.innerHTML || "";
          }

          function findClosestTable(sel) {
            if (!sel || sel.rangeCount === 0) return null;
            let node = sel.getRangeAt(0).commonAncestorContainer;
            if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
            if (!(node instanceof Element)) return null;
            return node.closest("table");
          }

          const sel = window.getSelection();
          const text = sel ? sel.toString() : "";
          const html = getSelectionHtml(sel);
          const table = findClosestTable(sel);

          return {
            ok: true,
            hasSelection: Boolean((text && text.trim()) || (html && html.trim())),
            text,
            html,
            tableHtml: table ? table.outerHTML : ""
          };
        }
      }).catch(err => {
        console.error('[Support Toolkit] Script injection failed:', err);
        return null;
      });

      if (!injected || injected.length === 0) {
        showNotification('Support Toolkit', 'Failed to read selection. Try refreshing the page.');
        return;
      }

      const picked = injected.map(r => r.result).find(r => r?.ok && r.hasSelection);

      if (!picked) {
        showNotification('Support Toolkit', 'No selection found. Select the table/text first.');
        return;
      }

      // Extract URLs using imported utilities
      const htmlToParse = picked.tableHtml || picked.html || "";
      const urlsFromHtml = extractUrlsFromHtml(htmlToParse);
      const urlsFromText = extractAll(picked.text || "");
      const urls = unique([...urlsFromHtml, ...urlsFromText]);

      if (!urls.length) {
        showNotification('Support Toolkit', 'No valid URLs found in selection');
        return;
      }

      if (urls.length > MAX_TABS_PER_JOB) {
        showNotification('Support Toolkit', `Too many URLs (${urls.length}). Maximum is ${MAX_TABS_PER_JOB}.`);
        return;
      }

      const windowId = currentTab.windowId;
      const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

      // Read delay setting (shared with popup)
      const { useDelayBetweenTabs } = await chrome.storage.local.get(['useDelayBetweenTabs']);
      const delayMs = useDelayBetweenTabs ? 1000 : 0;

      showNotification(
        'Support Toolkit',
        `Opening ${urls.length} tab(s)...${delayMs ? ' (1s delay enabled)' : ''}`
      );

      const result = await openAndGroupInBackground({ urls, windowId, delayMs, jobId });

      showNotification(
        'Support Toolkit',
        `Opened ${result.count} tab(s) and grouped as "Failed LP"${delayMs ? ' (1s delay enabled)' : ''}`
      );

    } else if (command === "format-company-batch") {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const results = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: async () => {
          try {
            document.execCommand('copy');
            await new Promise(resolve => setTimeout(resolve, 100));

            const text = await navigator.clipboard.readText();
            return { success: true, text };
          } catch (e) {
            return { success: false, error: e.message };
          }
        }
      }).catch(err => {
        console.error('[Support Toolkit] Script execution failed:', err);
        return [{ result: { success: false, error: err.message } }];
      });

      if (!results?.[0]?.result?.success) {
        showNotification('Support Toolkit', 'Unable to copy selection. Try refreshing the page.');
        return;
      }

      const clipboardText = results[0].result.text;
      if (!clipboardText) {
        showNotification('Support Toolkit', 'No text selected');
        return;
      }

      // Use imported utility
      const rows = parseCompanyCount(clipboardText);
      if (!rows.length) {
        showNotification('Support Toolkit', 'Could not parse company/count data');
        return;
      }

      const tsv = rowsToTSV([], rows);

      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: async (tsvData) => {
          await navigator.clipboard.writeText(tsvData);
        },
        args: [tsv]
      });

      showNotification('Support Toolkit', `✓ Formatted ${rows.length} row(s) - TSV copied to clipboard`);

    } else if (command === "format-media-errors") {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const results = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: async () => {
          try {
            document.execCommand('copy');
            await new Promise(resolve => setTimeout(resolve, 100));

            const text = await navigator.clipboard.readText();
            return { success: true, text };
          } catch (e) {
            return { success: false, error: e.message };
          }
        }
      }).catch(err => {
        console.error('[Support Toolkit] Script execution failed:', err);
        return [{ result: { success: false, error: err.message } }];
      });

      if (!results?.[0]?.result?.success) {
        showNotification('Support Toolkit', 'Unable to copy selection. Try refreshing the page.');
        return;
      }

      const clipboardText = results[0].result.text;
      if (!clipboardText) {
        showNotification('Support Toolkit', 'No text selected');
        return;
      }

      // Use imported utility
      const rowsVEC = parseVersionErrorCount(clipboardText);
      if (!rowsVEC.length) {
        showNotification('Support Toolkit', 'Could not parse version/error/count data');
        return;
      }

      const finalRows = rowsVEC.map(([version, error, count]) => [error, version, count]);
      const html = tableToHTML([], finalRows);
      const tsv = rowsToTSV([], finalRows);

      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: async (htmlData, tsvData) => {
          if (window.ClipboardItem) {
            const blobHtml = new Blob([htmlData], { type: "text/html" });
            const blobTxt = new Blob([tsvData], { type: "text/plain" });
            await navigator.clipboard.write([new ClipboardItem({ "text/html": blobHtml, "text/plain": blobTxt })]);
          } else {
            await navigator.clipboard.writeText(tsvData);
          }
        },
        args: [html, tsv]
      });

      showNotification('Support Toolkit', `✓ Formatted ${finalRows.length} row(s) - HTML table copied`);

    } else if (command === "copy-daily-report") {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const url = currentTab?.url || "";
      const isGmail = url.startsWith("https://mail.google.com/");

      if (!currentTab?.id) {
        showNotification("Support Toolkit", "No active tab found");
        return;
      }

      if (!isGmail) {
        showNotification("Support Toolkit", "Daily Report copy works only on Gmail (mail.google.com).");
        return;
      }

      const d = new Date();
      // Use imported utility
      const dd = pad2(d.getDate());
      const mm = pad2(d.getMonth() + 1);
      const yy = pad2(d.getFullYear() % 100);
      const day = d.toLocaleDateString("en-US", { weekday: "long" });

      const text = `Daily Report ${dd}.${mm}.${yy} ${day}`;

      // Copy + paste into focused field (Gmail compose is contenteditable)
      const results = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: async (t) => {
          let pasted = false;

          // 1) Copy to clipboard
          try {
            await navigator.clipboard.writeText(t);
          } catch (e) {
            // keep going - paste might still work
          }

          // 2) Paste into the currently focused element (if possible)
          try {
            const el = document.activeElement;

            if (el) {
              // input / textarea
              if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
                const start = el.selectionStart ?? el.value.length;
                const end = el.selectionEnd ?? el.value.length;

                const before = el.value.slice(0, start);
                const after = el.value.slice(end);

                el.value = before + t + after;

                const newPos = start + t.length;
                el.setSelectionRange?.(newPos, newPos);

                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                pasted = true;
              }
              // contenteditable (Gmail compose body / subject sometimes)
              else if (el.isContentEditable) {
                el.focus();

                // Insert at cursor (works for Gmail most of the time)
                const ok = document.execCommand && document.execCommand("insertText", false, t);
                if (ok) {
                  pasted = true;
                } else {
                  // Fallback: Range insertion
                  const sel = window.getSelection();
                  if (sel && sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    range.deleteContents();
                    range.insertNode(document.createTextNode(t));
                    // Move cursor after inserted text
                    range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    pasted = true;
                  }
                }

                el.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }
          } catch (e) {
            // ignore paste failures
          }

          return { pasted: pasted };
        },
        args: [text]
      });

      const pasted = !!results?.[0]?.result?.pasted;

      if (pasted) {
        showNotification("Support Toolkit", `✓ Copied + pasted: ${text}`);
      } else {
        showNotification("Support Toolkit", `✓ Copied: ${text} (focus a text field to auto-paste)`);
      }
    }

  } catch (error) {
    console.error('[Support Toolkit] Shortcut error:', error);
    showNotification('Support Toolkit', `Error: ${error.message}`);
  }
});