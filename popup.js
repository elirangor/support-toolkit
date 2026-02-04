import {
  MAX_TABS_PER_JOB,
  pad2,
  unique,
  extractAll,
  extractIdomooMp4s,
  escapeHtml,
  truncate,
  parseCompanyCount,
  parseVersionErrorCount,
  rowsToTSV,
  tableToHTML
} from './utils.js';

// Global variable to track current job for cancellation
let currentJobId = null;

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

  let contentHtml = `
    <div class="status-card ${type}">
      <div class="status-icon">${icon}</div>
      <div class="status-title">${title}</div>
      <div class="status-desc">${description}</div>
  `;

  // ADDED: If loading, add a Cancel button directly to the overlay
  if (type === 'loading') {
    contentHtml += `
      <div style="margin-top:15px;">
        <button id="overlay-cancel-btn" class="danger" style="padding: 8px 16px; font-size:12px;">⏹ Stop Operation</button>
      </div>
    `;
  }

  contentHtml += `</div>`;
  overlay.innerHTML = contentHtml;
  overlay.classList.remove('hidden');

  // Handle Cancel Button Click
  if (type === 'loading') {
    const cancelBtn = document.getElementById('overlay-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent overlay click-to-dismiss
        if (currentJobId) {
          chrome.runtime.sendMessage({ type: "STOP_OPEN", jobId: currentJobId }, (resp) => {
            showOverlay('Stopped', 'Operation cancelled by user', 'info');
          });
        }
      });
    }
  }

  // Auto-hide logic
  if (type !== 'loading') {
    if (overlay.dataset.timer) clearTimeout(overlay.dataset.timer);
    overlay.dataset.timer = setTimeout(() => {
      overlay.classList.add('hidden');
    }, 2500);
  }
}

// Allow clicking overlay to dismiss immediately (unless loading)
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('status-overlay');
  if (overlay) {
    overlay.addEventListener('click', () => {
        // Don't auto-dismiss if we are in the middle of a loading operation (user must click Stop)
        const isLoading = overlay.querySelector('.status-card.loading');
        if (!isLoading) {
            overlay.classList.add('hidden');
        }
    });
  }
});


document.addEventListener('DOMContentLoaded', () => {

  // ... (Shortcuts logic) ...
  async function loadShortcuts() {
    try {
      const commands = await chrome.commands.getAll();
      commands.forEach(cmd => {
        let elementId = null;
        if (cmd.name === 'open-lp-urls') elementId = 'shortcut-urls';
        else if (cmd.name === 'format-company-batch') elementId = 'shortcut-batch';
        else if (cmd.name === 'format-media-errors') elementId = 'shortcut-errors';
        else if (cmd.name === 'copy-daily-report') elementId = 'shortcut-daily';
        else if (cmd.name === 'open-black-frames') elementId = 'shortcut-black-frames';

        if (elementId && cmd.shortcut) {
          const el = document.getElementById(elementId);
          if (el) el.textContent = cmd.shortcut;
        }
      });
    } catch (e) { console.error(e); }
  }
  loadShortcuts();

  // ... (Daily Report logic) ...
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

  // URL Preview Logic
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

    counts.textContent = `Found ${allUrls.length} URL(s) → ${uniqueUrls.length} unique`;

    preview.innerHTML = uniqueUrls.map((u, i) => {
      return `<div class="url-line" title="${escapeHtml(u)}">${i + 1}. ${escapeHtml(formatUrlForPreview(u))}</div>`;
    }).join("");
  }

  // Helper to extract BOTH types of URLs for preview
  function extractCombinedUrls(text) {
      if (!text) return [];
      const standard = extractAll(text);
      const mp4s = extractIdomooMp4s(text);
      // Combine them so the user sees everything
      return [...standard, ...mp4s];
  }

  document.getElementById('readUrlClip').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById('urlInput').value = t || '';
      
      const all = extractCombinedUrls(t);
      renderUrlPreview(all, unique(all));

      if (t) showOverlay('Clipboard Loaded', `Found ${all.length} URLs in text`, 'info');
      else showOverlay('Clipboard Empty', 'No text found in clipboard', 'error');

    } catch {
      showOverlay('Error', 'Could not access clipboard', 'error');
    }
  });

  document.getElementById('urlInput').addEventListener('input', (e) => {
    const t = e.target.value || '';
    // CHANGED: Use combined extraction so MP4s show up too
    const all = extractCombinedUrls(t);
    renderUrlPreview(all, unique(all));
  });

  // Open URLs Logic
  const runBtn = document.getElementById('runUrls');
  const runBFBtn = document.getElementById('runBlackFrames');
  const stopBtn = document.getElementById('stopOpen');

  function setRunning(running, totalCount = null) {
    if (running) {
      runBtn.disabled = true;
      runBFBtn.disabled = true;
      stopBtn.style.display = '';
      if (totalCount != null)
        showOverlay('Processing...', `Opening ${totalCount} tabs in background`, 'loading');
    } else {
      runBtn.disabled = false;
      runBFBtn.disabled = false;
      stopBtn.style.display = 'none';
    }
  }

  // Helper to start job
  function startOpenJob(urls, groupTitle, groupColor) {
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
        payload: { 
            urls, 
            windowId: currentTab.windowId, 
            delayMs: delayEnabled ? 1000 : 0, 
            jobId,
            groupTitle,
            groupColor
        }
      }, (resp) => {
        setRunning(false);
        if (!resp) return showOverlay('System Error', 'No response from background script', 'error');

        if (resp.ok) {
          showOverlay('Action Complete', `Opened ${resp.count} Tabs.<br>Grouped as "${groupTitle}"`, 'success');
        } else {
          showOverlay('Action Failed', resp.error, 'error');
        }
        currentJobId = null;
      });
    });
  }

  runBtn.addEventListener('click', () => {
    const text = document.getElementById('urlInput').value || '';
    const urls = unique(extractAll(text));
    startOpenJob(urls, "Failed LP", "red");
  });

  runBFBtn.addEventListener('click', () => {
    const text = document.getElementById('urlInput').value || '';
    const urls = extractIdomooMp4s(text);
    if (!urls.length) {
        return showOverlay('No MP4s', 'No black frame videos found in text.', 'error');
    }
    startOpenJob(urls, "Black Frames", "grey");
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