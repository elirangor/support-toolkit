// background.js
// Robust opening with per-URL retries + cancel support + keyboard shortcuts
// Fixed: Memory leaks, rate limiting, job cleanup, security hardening

// Track running jobs so we can cancel mid-loop
const jobs = new Map(); // jobId -> { cancelled: boolean, timestamp: number }

// Constants
const MAX_TABS_PER_JOB = 40;
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

// Fixed sleep function - no memory leak
function sleep(ms, jobId) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      clearInterval(intervalId);
      resolve(true);
    }, ms);

    const intervalId = setInterval(() => {
      if (jobs.get(jobId)?.cancelled) {
        clearTimeout(timeoutId);
        clearInterval(intervalId);
        resolve(false);
      }
    }, 50);
  });
}

// Detect errors that are safe to retry
function isTransientTabError(errMsg = "") {
  return /Tabs cannot be edited right now|user may be dragging a tab|currently being dragged|No browser window/i.test(
    String(errMsg)
  );
}

// Security: Validate and sanitize URLs
function sanitizeUrl(url) {
  try {
    // First, clean up the URL: fix malformed ?url= that should be &url=
    let cleanedUrl = url;
    
    // Find first ? and replace subsequent ? with &
    const firstQuestionMark = cleanedUrl.indexOf('?');
    if (firstQuestionMark !== -1) {
      const beforeQuery = cleanedUrl.substring(0, firstQuestionMark + 1);
      const afterQuery = cleanedUrl.substring(firstQuestionMark + 1);
      // Replace any ? in query string with &
      cleanedUrl = beforeQuery + afterQuery.replace(/\?/g, '&');
    }
    
    // Pattern 1: index.html?id=XXXXX (with potential query params after)
    const matchesIndexId = cleanedUrl.match(/^(https?:\/\/[^\s"'<>()]+index\.html\?id=)([^&\s]+)(.*)$/i);
    
    // Pattern 2: ANY path?url=https://...XXXXX.m3u8 (stops at first uppercase in the video path)
    // UPDATED: Removed hardcoded "index.html" requirement
    const matchesIndexM3u8 = cleanedUrl.match(/^(https?:\/\/[^\s"'<>()]+?\?url=https?:\/\/[^\s"'<>()]+?)([a-z0-9/]+\.m3u8)(.*)$/i);
    
    let finalUrl = null;

    if (matchesIndexId) {
      let base = matchesIndexId[1];
      let idPart = matchesIndexId[2];
      let queryParams = matchesIndexId[3]; // Everything after the ID
      
      // Stop at first uppercase in the ID itself
      const idxUp = idPart.search(/[A-Z]/);
      if (idxUp !== -1) idPart = idPart.slice(0, idxUp);
      
      // If there's a &url= parameter, extract and clean the m3u8 URL
      if (queryParams.includes('&url=')) {
        const urlMatch = queryParams.match(/(&url=https?:\/\/[^\s&]+?)([a-z0-9/]+\.m3u8)/i);
        if (urlMatch) {
          const urlBase = urlMatch[1];
          let m3u8Path = urlMatch[2];
          
          // Stop at first uppercase in m3u8 filename
          const m3u8UpIdx = m3u8Path.search(/[A-Z]/);
          if (m3u8UpIdx !== -1) m3u8Path = m3u8Path.slice(0, m3u8UpIdx);
          
          // Cut after .m3u8 extension
          const m3u8Idx = m3u8Path.indexOf('.m3u8');
          if (m3u8Idx !== -1) m3u8Path = m3u8Path.slice(0, m3u8Idx + 6);
          
          // Reconstruct: keep other query params before &url=
          const beforeUrl = queryParams.substring(0, queryParams.indexOf('&url='));
          finalUrl = base + idPart + beforeUrl + urlBase + m3u8Path;
        } else {
          finalUrl = base + idPart + queryParams;
        }
      } else {
        finalUrl = base + idPart + queryParams;
      }
      
    } else if (matchesIndexM3u8) {
      let base = matchesIndexM3u8[1];
      let m3u8 = matchesIndexM3u8[2];
      
      // Stop at first uppercase in m3u8 path (before .m3u8)
      const idxUp = m3u8.search(/[A-Z]/);
      if (idxUp !== -1) m3u8 = m3u8.slice(0, idxUp);
      
      // Cut after .m3u8
      const idxM3U8 = m3u8.indexOf('.m3u8');
      if (idxM3U8 !== -1) m3u8 = m3u8.slice(0, idxM3U8 + 6);
      
      finalUrl = base + m3u8;
    }

    // Final validation: block if uppercase in the video ID/hash portion
    // But allow uppercase in query parameters (like &l=EN)
    if (!finalUrl) return null;
    
    // Check for uppercase only in the hash/ID part, not in query params
    try {
      const urlObj = new URL(finalUrl);
      const idParam = urlObj.searchParams.get('id');
      const urlParam = urlObj.searchParams.get('url');
      
      // If there's an ID param with uppercase in the video hash, reject
      if (idParam) {
        // Extract just the video hash part (after project/account IDs)
        const idParts = idParam.split('/');
        if (idParts.length > 0) {
          const videoHash = idParts[idParts.length - 1];
          if (/[A-Z]/.test(videoHash)) return null;
        }
      }
      
      if (urlParam) {
        // Extract the video hash from the URL parameter
        const urlParts = urlParam.split('/');
        const lastPart = urlParts[urlParts.length - 1];
        const videoHash = lastPart.replace('.m3u8', '');
        if (/[A-Z]/.test(videoHash)) return null;
      }
    } catch (urlParseError) {
      // If URL parsing fails, return null
      return null;
    }
    
    return finalUrl;
    
  } catch (e) {
    return null;
  }
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
        await sleep(waitMs, jobId);
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
        console.warn('[Support Toolkit] Grouping failed:', e?.message || e);
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

  const urls = new Set();

  // Method 1: Standard regex for complete URLs with http/https
  const standardMatches = [...text.matchAll(/https?:\/\/[^\s"'<>()]+/gi)];
  standardMatches.forEach(m => {
    const cleaned = sanitizeUrl(m[0]
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[),.;\]]+$/g, "")
      .trim());
    if (cleaned) urls.add(cleaned);
  });

  // Method 2: Look for domain patterns (but be more careful)
  const domainPattern = /(?:^|[^a-zA-Z0-9.-])([a-zA-Z0-9][-a-zA-Z0-9]{0,61}[a-zA-Z0-9]?\.)+(?:com|net|org|io|co|idomoo)(?:\/[^\s]*)?/gi;
  const domainMatches = [...text.matchAll(domainPattern)];

  domainMatches.forEach(m => {
    let url = m[0].replace(/^[^a-zA-Z0-9]+/, "").replace(/[),.;\]]+$/g, "").trim();
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    const cleaned = sanitizeUrl(url);
    if (!cleaned) return;

    // Only add if it's not already a substring of an existing URL
    let shouldAdd = true;
    for (const existing of urls) {
      if (existing.includes(cleaned.replace('https://', ''))) {
        shouldAdd = false;
        break;
      }
    }

    if (shouldAdd && cleaned.includes('/')) {
      urls.add(cleaned);
    }
  });

  return [...urls];
}

// ✅ Extract URLs from anchor tags in selected HTML/table HTML
function extractUrlsFromHtml(html) {
  if (!html) return [];

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    return [...doc.querySelectorAll("a[href]")]
      .map(a => a.getAttribute("href"))
      .filter(Boolean)
      .map(href => sanitizeUrl(href.trim()))
      .filter(Boolean); // Remove null values from sanitizeUrl
  } catch (e) {
    console.warn("[Support Toolkit] Failed to parse HTML for URLs", e);
    return [];
  }
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

      // Extract URLs from <a href> + raw URLs in text, then dedupe
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

      const pad2 = (n) => String(n).padStart(2, "0");

      const d = new Date();
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