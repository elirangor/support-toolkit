document.addEventListener('DOMContentLoaded', () => {

  // ===== Load and Display Keyboard Shortcuts Dynamically =====
  async function loadShortcuts() {
    try {
      const commands = await chrome.commands.getAll();

      commands.forEach(cmd => {
        let elementId = null;

        if (cmd.name === 'open-lp-urls') {
          elementId = 'shortcut-urls';
        } else if (cmd.name === 'format-company-batch') {
          elementId = 'shortcut-batch';
        } else if (cmd.name === 'format-media-errors') {
          elementId = 'shortcut-errors';
        }

        if (elementId && cmd.shortcut) {
          const element = document.getElementById(elementId);
          if (element) {
            element.textContent = cmd.shortcut;
          }
        }
      });
    } catch (e) {
      console.error('Failed to load shortcuts:', e);
    }
  }

  loadShortcuts();

  // ===== Tabs =====
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${targetTab}-content`).classList.add('active');
      
      // Use chrome.storage.local instead of localStorage
      chrome.storage.local.set({ activeTab: targetTab });
      refreshRunningUI();
    });
  });

  // Restore last active tab from chrome.storage
  chrome.storage.local.get(['activeTab'], (result) => {
    const last = result.activeTab;
    if (last && document.getElementById(`${last}-content`)) {
      document.querySelector(`.tab[data-tab="${last}"]`)?.click();
    }
  });

  // ===== Remember the 1s Delay Toggle (SHARED WITH SHORTCUT) =====
  const delayCheckbox = document.getElementById('useDelay');

  // Load from chrome.storage
  chrome.storage.local.get(['useDelayBetweenTabs'], (res) => {
    if (typeof res.useDelayBetweenTabs === 'boolean') {
      delayCheckbox.checked = res.useDelayBetweenTabs;
    }
  });

  delayCheckbox.addEventListener('change', () => {
    const enabled = delayCheckbox.checked;
    chrome.storage.local.set({ useDelayBetweenTabs: enabled });
  });

  // ===== Preview helpers =====
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function truncate(s, max = 200) {
    const str = String(s ?? "");
    return str.length > max ? str.slice(0, max) + "…" : str;
  }

  function buildPrettyPreview(lines, maxLines = 6) {
    if (!lines || !lines.length) return "";
    const shown = lines.slice(0, maxLines);
    const more = lines.length > maxLines ? `… (+${lines.length - maxLines} more)` : "";
    return [...shown, more].filter(Boolean).map(escapeHtml).join("<br>");
  }

  // ===== URL helpers with security =====
  function sanitizeUrl(url) {
    try {
      const matchesIndexId = url.match(/^(https?:\/\/[^\s"'<>()]+index\.html\?id=)([a-z0-9/]+)(.*)$/i);
      const matchesIndexM3u8 = url.match(/^(https?:\/\/[^\s"'<>()]+index\.html\?url=https?:\/\/[^\s"'<>()]+?)([a-z0-9/]+\.m3u8)(.*)$/i);
      let cleanUrl = null;

      if (matchesIndexId) {
        let base = matchesIndexId[1];
        let hash = matchesIndexId[2];
        // Stop at first uppercase in hash
        const idxUp = hash.search(/[A-Z]/);
        if (idxUp !== -1) hash = hash.slice(0, idxUp);
        cleanUrl = base + hash;
      } else if (matchesIndexM3u8) {
        let base = matchesIndexM3u8[1];
        let m3u8 = matchesIndexM3u8[2];
        // Stop at first uppercase in m3u8 (before .m3u8)
        const idxUp = m3u8.search(/[A-Z]/);
        if (idxUp !== -1) m3u8 = m3u8.slice(0, idxUp);
        // Cut after .m3u8
        const idxM3U8 = m3u8.indexOf('.m3u8');
        if (idxM3U8 !== -1) m3u8 = m3u8.slice(0, idxM3U8 + 6);
        cleanUrl = base + m3u8;
      }

      // Block if uppercase anywhere in result, or if didn't match
      if (!cleanUrl || /[A-Z]/.test(cleanUrl)) return null;
      return cleanUrl;
    } catch (e) {
      return null;
    }
  }

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

    // Method 2: Look for domain patterns
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

  const unique = arr => [...new Set(arr)];

  // Fixed: More robust URL preview formatting
  function formatUrlForPreview(u) {
    try {
      const url = new URL(u);
      const display = `${url.host}${url.pathname}`;
      // Truncate very long paths
      return display.length > 200 ? display.substring(0, 200) + "…" : display;
    } catch (e) {
      // Fallback for invalid URLs - truncate and sanitize
      return truncate(String(u), 200);
    }
  }

  function renderUrlPreview(allUrls, uniqueUrls) {
    const counts = document.getElementById("urlCounts");
    const preview = document.getElementById("urlPreview");

    if (!uniqueUrls.length) { 
      counts.textContent = ""; 
      preview.innerHTML = ""; 
      return; 
    }

    const removed = allUrls.length - uniqueUrls.length;
    counts.textContent =
      `Found ${allUrls.length} URL occurrence(s) → ${uniqueUrls.length} unique (${removed} duplicate${removed === 1 ? '' : 's'} removed).`;

    preview.innerHTML = uniqueUrls.map((u, i) => {
      const shortText = formatUrlForPreview(u);
      const escapedUrl = escapeHtml(u);
      const escapedShort = escapeHtml(shortText);
      return `<div class="url-line" title="${escapedUrl}">${i + 1}. ${escapedShort}</div>`;
    }).join("");
  }

  document.getElementById('readUrlClip').addEventListener('click', async () => {
    const status = document.getElementById('urlStatus');
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById('urlInput').value = t || '';
      status.textContent = t ? 'Clipboard pasted.' : 'Clipboard was empty.';
      const all = extractAll(t);
      renderUrlPreview(all, unique(all));
    } catch {
      status.textContent = 'Clipboard read failed. Paste manually.';
    }
  });

  document.getElementById('urlInput').addEventListener('input', (e) => {
    const t = e.target.value || '';
    const all = extractAll(t);
    renderUrlPreview(all, unique(all));
  });

  renderUrlPreview([], []);

  // ===== Open/group URLs =====
  const MAX_TABS_PER_JOB = 100;
  let currentJobId = null;
  const runBtn = document.getElementById('runUrls');
  const stopBtn = document.getElementById('stopOpen');
  const status = document.getElementById('urlStatus');

  function setRunning(running, totalCount = null) {
    if (running) {
      runBtn.disabled = true;
      stopBtn.style.display = '';
      if (totalCount != null)
        status.textContent = `Starting in background: ${totalCount} unique tab(s)… Click "Stop" to cancel.`;
    } else {
      runBtn.disabled = false;
      stopBtn.style.display = 'none';
    }
  }

  async function refreshRunningUI() {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "JOB_STATUS" }, resolve);
    });
    if (!resp?.ok) return;

    if (resp.running) {
      currentJobId = resp.jobIds?.[0] || null;
      setRunning(true);
      status.textContent = 'Running in background… Click "Stop" to cancel.';
    } else {
      currentJobId = null;
      setRunning(false);
    }
  }

  runBtn.addEventListener('click', async () => {
    const text = document.getElementById('urlInput').value || '';
    const urls = unique(extractAll(text));
    
    if (!urls.length) { 
      status.textContent = 'No valid URLs found.'; 
      return; 
    }

    if (urls.length > MAX_TABS_PER_JOB) {
      status.textContent = `Too many URLs (${urls.length}). Maximum is ${MAX_TABS_PER_JOB}.`;
      return;
    }

    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    currentJobId = jobId;
    
    // Get delay setting from storage
    chrome.storage.local.get(['useDelayBetweenTabs'], async (result) => {
      const delayEnabled = result.useDelayBetweenTabs || false;
      setRunning(true, urls.length);

      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const windowId = currentTab.windowId;

      chrome.runtime.sendMessage({
        type: "OPEN_URLS",
        payload: { urls, windowId, delayMs: delayEnabled ? 1000 : 0, jobId }
      }, (resp) => {
        if (!resp) {
          status.textContent = 'Error: No response from background script';
          setRunning(false);
          currentJobId = null;
          return;
        }
        
        setRunning(false);
        status.textContent = resp.ok
          ? `${resp.cancelled ? 'Stopped early.' : 'Done.'} Opened ${resp.count} tab(s)${resp.cancelled ? '' : ' (some URLs may be skipped if invalid)'}.
            Grouped as "Failed LP".`
          : `Error: ${resp.error}`;
        currentJobId = null;
      });
    });
  });

  stopBtn.addEventListener('click', () => {
    if (!currentJobId) return;
    chrome.runtime.sendMessage({ type: "STOP_OPEN", jobId: currentJobId }, (resp) => {
      if (resp?.ok) status.textContent = 'Stopping… finishing up current step.';
      else status.textContent = `Stop failed: ${resp?.error || 'unknown error'}`;
    });
  });

  // ===== Grafana formatters =====
  const normalizeLines = raw =>
    raw.replace(/\r\n/g, "\n").split("\n").map(s => s.trim()).filter(Boolean);

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

  function tableToHTML(headers, rows) {
    const esc = s => escapeHtml(String(s));
    const th = headers.length
      ? `<thead><tr>${headers.map(h => `<th style="border:1px solid #000;padding:6px 8px;text-align:left;">${esc(h)}</th>`).join("")}</tr></thead>` 
      : "";
    const tb = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td style="border:1px solid #000;padding:6px 8px;vertical-align:top;">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return `<!doctype html><html><body><table style="border-collapse:collapse;">${th}${tb}</table></body></html>`;
  }

  function rowsToTSV(headers, rows) {
    const all = headers.length ? [headers, ...rows] : rows;
    return all.map(r => r.join("\t")).join("\n");
  }

  async function copyTSVOnly(headers, rows) {
    const tsv = rowsToTSV(headers, rows);
    await navigator.clipboard.writeText(tsv);
    return { tsvLines: tsv.split("\n").length };
  }

  async function copyTableHTMLPlusTSV(headers, rows) {
    const html = tableToHTML(headers, rows);
    const tsv = rowsToTSV(headers, rows);
    if (window.ClipboardItem) {
      const blobHtml = new Blob([html], { type: "text/html" });
      const blobTxt = new Blob([tsv], { type: "text/plain" });
      await navigator.clipboard.write([new ClipboardItem({ "text/html": blobHtml, "text/plain": blobTxt })]);
    } else {
      await navigator.clipboard.writeText(tsv);
    }
    return { tsvLines: tsv.split("\n").length };
  }

  document.getElementById('readGrafanaClip').addEventListener('click', async () => {
    const out = document.getElementById('tsvStatus');
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById('grafanaInput').value = t || '';
      out.textContent = t ? 'Clipboard pasted.' : 'Clipboard was empty.';
    } catch {
      out.textContent = 'Clipboard read failed. Paste manually.';
    }
  });

  document.getElementById('formatGrafana').addEventListener('click', async () => {
    const out = document.getElementById('tsvStatus');
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) { 
        out.textContent = "Nothing to format. Paste text or copy from Grafana first."; 
        return; 
      }

      const rows = parseCompanyCount(source);
      if (!rows.length) { 
        out.textContent = "Could not parse any rows (expected Company/Count pairs)."; 
        return; 
      }

      await copyTSVOnly([], rows);

      const COMPANY_PREVIEW_MAX_LINES = 6;
      const allPreviewLines = rows.map(r => r.join(" | "));

      out.innerHTML =
        `<strong>✓ Copied TSV (${rows.length} row${rows.length === 1 ? "" : "s"})</strong>` +
        `<br><br>Preview:<br>${buildPrettyPreview(allPreviewLines, COMPANY_PREVIEW_MAX_LINES)}`;
    } catch (e) {
      out.textContent = "Clipboard error. " + (e?.message || e);
    }
  });

  document.getElementById('formatGrafana3').addEventListener('click', async () => {
    const out = document.getElementById('tsvStatus');
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) { 
        out.textContent = "Nothing to format. Paste text or copy from Grafana first."; 
        return; 
      }

      const rowsVEC = parseVersionErrorCount(source);
      if (!rowsVEC.length) { 
        out.textContent = "Could not parse any 3-line groups (Version, Error, Count)."; 
        return; 
      }

      const finalRows = rowsVEC.map(([version, error, count]) => [error, version, count]);
      await copyTableHTMLPlusTSV([], finalRows);

      const ERROR_PREVIEW_MAX_LINES = 6;
      const ERROR_TEXT_MAX = 110;

      const allPreviewLines = finalRows.map(([err, ver, cnt]) => {
        const cleanErr = truncate(String(err).replace(/\s+/g, " ").trim(), ERROR_TEXT_MAX);
        return `${cnt} | ${ver} | ${cleanErr}`;
      });

      out.innerHTML =
        `<strong>✓ Copied HTML table + TSV (${finalRows.length} row${finalRows.length === 1 ? "" : "s"})</strong>` +
        `<br><br>Preview:<br>${buildPrettyPreview(allPreviewLines, ERROR_PREVIEW_MAX_LINES)}`;
    } catch (e) {
      out.textContent = "Clipboard error. " + (e?.message || e);
    }
  });

  // On popup open, sync Stop/Run with background state
  refreshRunningUI();

});