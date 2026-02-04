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
  tableToHTML
} from './utils.js';

// ===== NEW: Centralized Overlay Manager =====
function showOverlay(title, description, type = 'success') {
  const overlay = document.getElementById('status-overlay');
  if (!overlay) return;

  // Choose icon based on type
  let icon = '✨';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'info') icon = 'ℹ️';
  if (type === 'loading') icon = '⏳';

  overlay.innerHTML = `
    <div class="status-card ${type}">
      <div class="status-icon">${icon}</div>
      <div class="status-title">${title}</div>
      <div class="status-desc">${description}</div>
    </div>
  `;

  overlay.classList.remove('hidden');

  // Auto-hide after 2.5 seconds (unless it's an error, maybe keep it longer, or loading)
  if (type !== 'loading') {
    if (overlay.dataset.timer) clearTimeout(overlay.dataset.timer);
    overlay.dataset.timer = setTimeout(() => {
      overlay.classList.add('hidden');
    }, 2500);
  }
}

// Allow clicking overlay to dismiss immediately
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('status-overlay');
  if (overlay) {
    overlay.addEventListener('click', () => {
      overlay.classList.add('hidden');
    });
  }
});


document.addEventListener('DOMContentLoaded', () => {

  // ... (Shortcuts logic remains same) ...
  async function loadShortcuts() {
    try {
      const commands = await chrome.commands.getAll();
      commands.forEach(cmd => {
        let elementId = null;
        if (cmd.name === 'open-lp-urls') elementId = 'shortcut-urls';
        else if (cmd.name === 'format-company-batch') elementId = 'shortcut-batch';
        else if (cmd.name === 'format-media-errors') elementId = 'shortcut-errors';
        else if (cmd.name === 'copy-daily-report') elementId = 'shortcut-daily';

        if (elementId && cmd.shortcut) {
          const el = document.getElementById(elementId);
          if (el) el.textContent = cmd.shortcut;
        }
      });
    } catch (e) { console.error(e); }
  }
  loadShortcuts();

  // ... (Daily Report logic remains same) ...
  function pad2(n) { return String(n).padStart(2, '0'); }
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

  const dailyTitleEl = document.getElementById('dailyReportTitle');
  if (dailyTitleEl) dailyTitleEl.textContent = getDailyReportTextShort();

  const dailyBtn = document.getElementById('copyDailyReport');
  if (dailyBtn) {
    dailyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getDailyReportTextFull());
        dailyBtn.classList.add('copied');
        setTimeout(() => dailyBtn.classList.remove('copied'), 1500);
      } catch (e) { console.error(e); }
    });
  }

  // Tabs logic
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${targetTab}-content`).classList.add('active');
      chrome.storage.local.set({ activeTab: targetTab });
    });
  });

  chrome.storage.local.get(['activeTab'], (result) => {
    const last = result.activeTab;
    if (last && document.getElementById(`${last}-content`)) {
      document.querySelector(`.tab[data-tab="${last}"]`)?.click();
    }
  });

  // Delay toggle logic
  const delayCheckbox = document.getElementById('useDelay');
  chrome.storage.local.get(['useDelayBetweenTabs'], (res) => {
    if (typeof res.useDelayBetweenTabs === 'boolean') delayCheckbox.checked = res.useDelayBetweenTabs;
  });
  delayCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ useDelayBetweenTabs: delayCheckbox.checked });
  });

  // URL Preview Logic (Local Helper)
  function formatUrlForPreview(u) {
    try {
      const url = new URL(u);
      const display = `${url.host}${url.pathname}${url.search}`;
      return display.length > 200 ? display.substring(0, 200) + "…" : display;
    } catch (e) { return truncate(String(u), 200); }
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
    counts.textContent = `Found ${allUrls.length} URL(s) → ${uniqueUrls.length} unique`;

    preview.innerHTML = uniqueUrls.map((u, i) => {
      return `<div class="url-line" title="${escapeHtml(u)}">${i + 1}. ${escapeHtml(formatUrlForPreview(u))}</div>`;
    }).join("");
  }

  document.getElementById('readUrlClip').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById('urlInput').value = t || '';
      const all = extractAll(t);
      renderUrlPreview(all, unique(all));

      if (t) showOverlay('Clipboard Loaded', `Found ${all.length} URLs in text`, 'info');
      else showOverlay('Clipboard Empty', 'No text found in clipboard', 'error');

    } catch {
      showOverlay('Error', 'Could not access clipboard', 'error');
    }
  });

  document.getElementById('urlInput').addEventListener('input', (e) => {
    const t = e.target.value || '';
    const all = extractAll(t);
    renderUrlPreview(all, unique(all));
  });

  // Open URLs Logic
  const runBtn = document.getElementById('runUrls');
  const stopBtn = document.getElementById('stopOpen');
  let currentJobId = null;

  function setRunning(running, totalCount = null) {
    if (running) {
      runBtn.disabled = true;
      stopBtn.style.display = '';
      if (totalCount != null)
        showOverlay('Processing...', `Opening ${totalCount} tabs in background`, 'loading');
    } else {
      runBtn.disabled = false;
      stopBtn.style.display = 'none';
    }
  }

  runBtn.addEventListener('click', async () => {
    const text = document.getElementById('urlInput').value || '';
    const urls = unique(extractAll(text));

    if (!urls.length) return showOverlay('No URLs', 'Please paste text containing URLs first.', 'error');
    if (urls.length > MAX_TABS_PER_JOB) return showOverlay('Too Many URLs', `Limit is ${MAX_TABS_PER_JOB}. Found ${urls.length}.`, 'error');

    const jobId = `${Date.now()}-${Math.random()}`;
    currentJobId = jobId;

    chrome.storage.local.get(['useDelayBetweenTabs'], async (result) => {
      const delayEnabled = result.useDelayBetweenTabs || false;
      setRunning(true, urls.length);
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      chrome.runtime.sendMessage({
        type: "OPEN_URLS",
        payload: { urls, windowId: currentTab.windowId, delayMs: delayEnabled ? 1000 : 0, jobId }
      }, (resp) => {
        setRunning(false);
        if (!resp) return showOverlay('System Error', 'No response from background script', 'error');

        if (resp.ok) {
          showOverlay('Action Complete', `Opened ${resp.count} Tabs.<br>Grouped as "Failed LP"`, 'success');
        } else {
          showOverlay('Action Failed', resp.error, 'error');
        }
        currentJobId = null;
      });
    });
  });

  stopBtn.addEventListener('click', () => {
    if (!currentJobId) return;
    chrome.runtime.sendMessage({ type: "STOP_OPEN", jobId: currentJobId }, (resp) => {
      showOverlay('Stopped', 'Operation cancelled by user', 'info');
    });
  });

  // Grafana Formatters
  async function copyTSVOnly(headers, rows) {
    const tsv = rowsToTSV(headers, rows);
    await navigator.clipboard.writeText(tsv);
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
  }

  document.getElementById('readGrafanaClip').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById('grafanaInput').value = t || '';
      if (t) showOverlay('Clipboard Pasted', `${t.length} characters loaded`, 'info');
      else showOverlay('Clipboard Empty', '', 'error');
    } catch {
      showOverlay('Error', 'Clipboard access denied', 'error');
    }
  });

  document.getElementById('formatGrafana').addEventListener('click', async () => {
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) return showOverlay('No Data', 'Paste Grafana text first', 'error');

      const rows = parseCompanyCount(source);
      if (!rows.length) return showOverlay('Parse Failed', 'Could not find Company/Count data', 'error');

      await copyTSVOnly([], rows);
      showOverlay('Formatted & Copied!', `${rows.length} rows ready for Sheets`, 'success');
    } catch (e) {
      showOverlay('Error', e.message, 'error');
    }
  });

  document.getElementById('formatGrafana3').addEventListener('click', async () => {
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) return showOverlay('No Data', 'Paste Grafana text first', 'error');

      const rowsVEC = parseVersionErrorCount(source);
      if (!rowsVEC.length) return showOverlay('Parse Failed', 'Could not find Version/Error data', 'error');

      const finalRows = rowsVEC.map(([version, error, count]) => [error, version, count]);
      await copyTableHTMLPlusTSV([], finalRows);
      showOverlay('Formatted & Copied!', `${finalRows.length} rows (HTML Table + TSV)`, 'success');
    } catch (e) {
      showOverlay('Error', e.message, 'error');
    }
  });

});