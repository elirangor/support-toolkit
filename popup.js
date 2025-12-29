// popup.js

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

  // Load shortcuts on popup open
  loadShortcuts();

  // ===== Tabs =====
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${targetTab}-content`).classList.add('active');
      try { localStorage.setItem('activeTab', targetTab); } catch { }
      refreshRunningUI();
    });
  });

  try {
    const last = localStorage.getItem('activeTab');
    if (last && document.getElementById(`${last}-content`)) {
      document.querySelector(`.tab[data-tab="${last}"]`)?.click();
    }
  } catch { }

  // ===== Remember the 1s Delay Toggle =====
  const delayCheckbox = document.getElementById('useDelay');

  try {
    const saved = localStorage.getItem('useDelayChecked');
    if (saved === 'true') delayCheckbox.checked = true;
  } catch { }

  delayCheckbox.addEventListener('change', () => {
    try { localStorage.setItem('useDelayChecked', delayCheckbox.checked); } catch { }
  });

  // ===== Preview helpers =====
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function truncate(s, max = 200) {
    const str = String(s ?? "");
    return str.length > max ? str.slice(0, max) + "…" : str;
  }

  // No bullets. Show up to maxLines lines. If more, add "... (+N more)".
  function buildPrettyPreview(lines, maxLines = 6) {
    if (!lines || !lines.length) return "";
    const shown = lines.slice(0, maxLines);
    const more = lines.length > maxLines ? `… (+${lines.length - maxLines} more)` : "";
    return [...shown, more].filter(Boolean).map(escapeHtml).join("<br>");
  }

  // ===== URL helpers =====
  function sanitize(u) {
    return u
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[),.;\]]+$/g, "")
      .trim();
  }

  function extractAll(text) {
    if (!text) return [];
    
    // Much more aggressive URL extraction
    const urls = [];
    
    // Method 1: Standard regex for complete URLs
    const standardMatches = [...text.matchAll(/https?:\/\/[^\s"'<>()]+/gi)];
    standardMatches.forEach(m => {
      const cleaned = sanitize(m[0]);
      if (cleaned) urls.push(cleaned);
    });
    
    // Method 2: Look for URL patterns even without http/https prefix
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

  const unique = arr => [...new Set(arr)];

  // ✅ LP preview display: host + pathname ONLY (no src / no query)
  function formatUrlForPreview(u) {
    try {
      const url = new URL(u);
      return `${url.host}${url.pathname}`;
    } catch {
      return u;
    }
  }

  function renderUrlPreview(allUrls, uniqueUrls) {
    const counts = document.getElementById("urlCounts");
    const preview = document.getElementById("urlPreview");

    if (!uniqueUrls.length) { counts.textContent = ""; preview.innerHTML = ""; return; }

    const removed = allUrls.length - uniqueUrls.length;
    counts.textContent =
      `Found ${allUrls.length} URL occurrence(s) → ${uniqueUrls.length} unique (${removed} duplicate${removed === 1 ? '' : 's'} removed).`;

    // ✅ one visual line per item (CSS handles no-wrap + horizontal scroll)
    preview.innerHTML = uniqueUrls.map((u, i) => {
      const shortText = formatUrlForPreview(u);
      return `<div class="url-line" title="${escapeHtml(u)}">${i + 1}. ${escapeHtml(shortText)}</div>`;
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
    const delayEnabled = document.getElementById('useDelay').checked;
    const urls = unique(extractAll(text));
    if (!urls.length) { status.textContent = 'No URLs found.'; return; }

    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    currentJobId = jobId;
    setRunning(true, urls.length);

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const windowId = currentTab.windowId;

    chrome.runtime.sendMessage({
      type: "OPEN_URLS",
      payload: { urls, windowId, delayMs: delayEnabled ? 1000 : 0, jobId }
    }, (resp) => {
      if (!resp) return;
      setRunning(false);
      status.textContent = resp.ok
        ? `${resp.cancelled ? 'Stopped early.' : 'Done.'} Opened ${resp.count} tab(s)${resp.cancelled ? '' : ' (some URLs may be skipped if non-retryable)'}.
          Grouped as "Failed LP".`
        : `Error: ${resp.error}`;
      currentJobId = null;
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

  // 2-col: Company | Count → rows array
  function parseCompanyCount(raw) {
    const lines = normalizeLines(raw);
    if (!lines.length) return [];
    const headA = (lines[0] || "").toLowerCase(), headB = (lines[1] || "").toLowerCase();
    let start = 0; if (headA === "company" && headB === "count") start = 2;
    const rows = [];
    for (let i = start; i < lines.length; i += 2) {
      if (!lines[i]) break;
      rows.push([lines[i], lines[i + 1] || ""]);
    }
    return rows;
  }

  // 3-col parser (Version | Error | Count) → rows array
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
      rows.push([v, e, c]); // Version, Error, Count
    }
    return rows;
  }

  function tableToHTML(headers, rows) {
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const th = headers.length
      ? `<thead><tr>${headers.map(h => `<th style="border:1px solid #000;padding:6px 8px;text-align:left;">${esc(h)}</th>`).join("")}</tr></thead>` : "";
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
      await navigator.clipboard.writeText(tsv); // fallback
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

  // ===== Formatter: Company/Count =====
  document.getElementById('formatGrafana').addEventListener('click', async () => {
    const out = document.getElementById('tsvStatus');
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) { out.textContent = "Nothing to format. Paste text or copy from Grafana first."; return; }

      const rows = parseCompanyCount(source);
      if (!rows.length) { out.textContent = "Could not parse any rows (expected Company/Count pairs)."; return; }

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

  // ===== Formatter: Media Player Errors =====
  document.getElementById('formatGrafana3').addEventListener('click', async () => {
    const out = document.getElementById('tsvStatus');
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) { out.textContent = "Nothing to format. Paste text or copy from Grafana first."; return; }

      const rowsVEC = parseVersionErrorCount(source);
      if (!rowsVEC.length) { out.textContent = "Could not parse any 3-line groups (Version, Error, Count)."; return; }

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

  // ✅ On popup open (or reopen), sync Stop/Run with background state
  refreshRunningUI();

});