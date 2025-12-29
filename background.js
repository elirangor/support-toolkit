// background.js
// Robust opening with per-URL retries + cancel support + keyboard shortcuts

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

// ===== HELPER FUNCTIONS FOR SHORTCUTS =====
function extractAll(text) {
  if (!text) return [];
  
  // Much more aggressive URL extraction
  const urls = [];
  
  // Method 1: Standard regex for complete URLs
  const standardMatches = [...text.matchAll(/https?:\/\/[^\s"'<>()]+/gi)];
  standardMatches.forEach(m => {
    const cleaned = m[0]
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[),.;\]]+$/g, "")
      .trim();
    if (cleaned) urls.push(cleaned);
  });
  
  // Method 2: Look for URL patterns even without http/https prefix
  // This catches cases where URLs might be partially visible
  const urlPatterns = text.match(/[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.(?:com|net|org|io|co|idomoo)[^\s]*/gi);
  if (urlPatterns) {
    urlPatterns.forEach(match => {
      let url = match.replace(/[),.;\]]+$/g, "").trim();
      // Add https:// if not present
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }
      if (!urls.includes(url)) urls.push(url);
    });
  }
  
  // Method 3: Split by whitespace and check each part
  const parts = text.split(/[\s\t\n\r]+/);
  parts.forEach(part => {
    if (part.includes('://') || part.includes('.com') || part.includes('.idomoo')) {
      const cleaned = part
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/^[^a-zA-Z0-9]+/, "")
        .replace(/[),.;\]]+$/g, "")
        .trim();
      
      if (cleaned && (cleaned.startsWith('http') || cleaned.includes('.'))) {
        let url = cleaned;
        if (!url.startsWith('http')) {
          url = 'https://' + url;
        }
        if (!urls.includes(url)) urls.push(url);
      }
    }
  });
  
  return urls;
}

function unique(arr) {
  return [...new Set(arr)];
}

function normalizeLines(raw) {
  return raw.replace(/\r\n/g, "\n").split("\n").map(s => s.trim()).filter(Boolean);
}

function parseCompanyCount(raw) {
  const lines = normalizeLines(raw);
  if (!lines.length) return [];
  const headA = (lines[0] || "").toLowerCase(), headB = (lines[1] || "").toLowerCase();
  let start = 0; 
  if (headA === "company" && headB === "count") start = 2;
  const rows = [];
  for (let i = start; i < lines.length; i += 2) {
    if (!lines[i]) break;
    rows.push([lines[i], lines[i + 1] || ""]);
  }
  return rows;
}

function looksLikeHeaderTriplet(a, b, c) {
  if (!a || !b || !c) return false;
  const A = a.toLowerCase(), B = b.toLowerCase(), C = c.toLowerCase();
  return ((A.includes("player") && A.includes("version")) || (A.includes("version") && !/\d/.test(A)))
    && (B.includes("description") || B.includes("error"))
    && (C.includes("count") || C.includes("unique"));
}

function parseVersionErrorCount(raw) {
  const lines = normalizeLines(raw);
  if (!lines.length) return [];
  let start = 0;
  if (looksLikeHeaderTriplet(lines[0], lines[1], lines[2])) start = 3;
  const rows = [];
  for (let i = start; i < lines.length; i += 3) {
    const v = lines[i], e = lines[i + 1], c = lines[i + 2];
    if (!v || !e || !c) break;
    rows.push([v, e, c]);
  }
  return rows;
}

function rowsToTSV(headers, rows) {
  const all = headers.length ? [headers, ...rows] : rows;
  return all.map(r => r.join("\t")).join("\n");
}

function tableToHTML(headers, rows) {
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const th = headers.length
    ? `<thead><tr>${headers.map(h => `<th style="border:1px solid #000;padding:6px 8px;text-align:left;">${esc(h)}</th>`).join("")}</tr></thead>` : "";
  const tb = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td style="border:1px solid #000;padding:6px 8px;vertical-align:top;">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<!doctype html><html><body><table style="border-collapse:collapse;">${th}${tb}</table></body></html>`;
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
      
      // Try to get selected text and copy it
      const results = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: async () => {
          try {
            // Get the selected text directly
            const selection = window.getSelection();
            const selectedText = selection.toString();
            
            console.log('[Support Toolkit] Selected text length:', selectedText?.length);
            console.log('[Support Toolkit] Selected text preview:', selectedText?.substring(0, 500));
            
            if (!selectedText) {
              return { success: false, error: 'No text selected' };
            }
            
            // Copy to clipboard using modern API
            try {
              await navigator.clipboard.writeText(selectedText);
            } catch (e) {
              // Fallback to execCommand
              document.execCommand('copy');
            }
            
            // Small delay
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Read back from clipboard to verify
            const clipboardText = await navigator.clipboard.readText();
            
            console.log('[Support Toolkit] Clipboard text length:', clipboardText?.length);
            console.log('[Support Toolkit] Clipboard preview:', clipboardText?.substring(0, 500));
            
            return { success: true, text: clipboardText || selectedText };
          } catch (e) {
            console.error('[Support Toolkit] Error:', e);
            return { success: false, error: e.message };
          }
        }
      });

      if (!results?.[0]?.result?.success) {
        showNotification('Support Toolkit', 'Unable to copy/read selection. Make sure text is selected.');
        return;
      }

      const clipboardText = results[0].result.text;
      console.log('[Support Toolkit] Processing text:', clipboardText?.substring(0, 300));
      
      if (!clipboardText) {
        showNotification('Support Toolkit', 'No text found. Make sure to select text first.');
        return;
      }

      const urls = unique(extractAll(clipboardText));
      console.log('[Support Toolkit] Extracted URLs count:', urls.length);
      console.log('[Support Toolkit] URLs:', urls);
      
      if (!urls.length) {
        // Show first 200 chars of text in notification for debugging
        const preview = clipboardText.substring(0, 200).replace(/\n/g, ' ');
        showNotification('Support Toolkit', `No URLs found in: "${preview}..."`);
        console.log('[Support Toolkit] Full text that failed:', clipboardText);
        return;
      }

      const windowId = currentTab.windowId;
      const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      
      showNotification('Support Toolkit', `Opening ${urls.length} tab(s)...`);
      
      const result = await openAndGroupInBackground({ urls, windowId, delayMs: 0, jobId });
      showNotification('Support Toolkit', `Opened ${result.count} tab(s) and grouped as "Failed LP"`);
      
    } else if (command === "format-company-batch") {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      const results = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: async () => {
          try {
            // Copy selected text
            document.execCommand('copy');
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const text = await navigator.clipboard.readText();
            return { success: true, text };
          } catch (e) {
            return { success: false, error: e.message };
          }
        }
      });

      if (!results?.[0]?.result?.success) {
        showNotification('Support Toolkit', 'Unable to copy selection');
        return;
      }

      const clipboardText = results[0].result.text;
      if (!clipboardText) {
        showNotification('Support Toolkit', 'No text selected');
        return;
      }

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
            // Copy selected text
            document.execCommand('copy');
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const text = await navigator.clipboard.readText();
            return { success: true, text };
          } catch (e) {
            return { success: false, error: e.message };
          }
        }
      });

      if (!results?.[0]?.result?.success) {
        showNotification('Support Toolkit', 'Unable to copy selection');
        return;
      }

      const clipboardText = results[0].result.text;
      if (!clipboardText) {
        showNotification('Support Toolkit', 'No text selected');
        return;
      }

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
    }
  } catch (error) {
    console.error('[Support Toolkit] Shortcut error:', error);
    showNotification('Support Toolkit', `Error: ${error.message}`);
  }
});