import {
  MAX_TABS_PER_JOB,
  pad2,
  unique,
  extractAll,
  escapeHtml,
  truncate,
  parseCompanyCount,
  parseVersionErrorCount,
  rowsToTSV,
  tableToHTML,
  buildPrettyPreview
} from './utils.js';

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
        } else if (cmd.name === 'copy-daily-report') {
          elementId = 'shortcut-daily';
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

  // Keep shortcuts dynamic while popup is open (updates if user changes chrome://extensions/shortcuts)
  const shortcutsRefreshTimer = setInterval(loadShortcuts, 1000);
  window.addEventListener('beforeunload', () => clearInterval(shortcutsRefreshTimer));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadShortcuts();
  });

  // ===== Daily Report top button =====

  function getDailyReportTextFull(d = new Date()) {
    const dd = pad2(d.getDate());
    const mm = pad2(d.getMonth() + 1);
    const yy = pad2(d.getFullYear() % 100);
    const day = d.toLocaleDateString('en-US', { weekday: 'long' });
    return `Daily Report ${dd}.${mm}.${yy} ${day}`;
  }

  function getDailyReportTextShort(d = new Date()) {
    const dd = pad2(d.getDate());
    const mm = pad2(d.getMonth() + 1);
    const yy = pad2(d.getFullYear() % 100);
    const day = d.toLocaleDateString('en-US', { weekday: 'short' });
    return `Daily Report ${dd}.${mm}.${yy} ${day}`;
  }

  // Set title on open (SHORT weekday for UI)
  const dailyTitleEl = document.getElementById('dailyReportTitle');
  if (dailyTitleEl) {
    dailyTitleEl.textContent = getDailyReportTextShort();
  }

  // Copy on click with visual feedback (FULL weekday for clipboard)
  const dailyBtn = document.getElementById('copyDailyReport');
  if (dailyBtn) {
    dailyBtn.addEventListener('click', async () => {
      try {
        const text = getDailyReportTextFull();
        await navigator.clipboard.writeText(text);
        
        // Add copied class for visual feedback
        dailyBtn.classList.add('copied');
        
        // Remove after animation
        setTimeout(() => {
          dailyBtn.classList.remove('copied');
        }, 1500);
      } catch (e) {
        console.error('Clipboard write failed:', e);
      }
    });
  }

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

  // Fixed: More robust URL preview formatting (Local helper that relies on truncate/escapeHtml)
  function formatUrlForPreview(u) {
    try {
      const url = new URL(u);
      const display = `${url.host}${url.pathname}${url.search}`;
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
      return `<div class="url-line" title="${escapedUrl}">${i + 1}. ${escapeHtml(shortText)}</div>`;
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