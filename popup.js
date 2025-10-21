document.addEventListener('DOMContentLoaded', () => {
  // ===== Tab Switching =====
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${targetTab}-content`).classList.add('active');
      try { localStorage.setItem('activeTab', targetTab); } catch {}
    });
  });
  try {
    const last = localStorage.getItem('activeTab');
    if (last && document.getElementById(`${last}-content`)) {
      document.querySelector(`.tab[data-tab="${last}"]`)?.click();
    }
  } catch {}

  // ===== Helper Functions (URLs) =====
  function sanitize(u) {
    return u.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[),.;\]]+$/g, "").trim();
  }
  function extractAll(text) {
    if (!text) return [];
    return [...text.matchAll(/https?:\/\/[^\s"'<>()]+/g)].map(m => sanitize(m[0]));
  }
  function unique(arr) { return [...new Set(arr)]; }

  function renderUrlPreview(allUrls, uniqueUrls) {
    const counts = document.getElementById("urlCounts");
    const preview = document.getElementById("urlPreview");
    const hasData = uniqueUrls.length > 0;
    if (!hasData) { counts.textContent = ""; preview.innerHTML = ""; return; }
    const removed = allUrls.length - uniqueUrls.length;
    counts.textContent = `Found ${allUrls.length} URL occurrence(s) → ${uniqueUrls.length} unique (${removed} duplicate${removed===1?'':'s'} removed).`;
    preview.innerHTML = uniqueUrls.map((u, i) => `${i + 1}. ${u}`).join("<br>");
  }

  // ===== URLs Tab: Clipboard and textarea =====
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

  // Initialize: keep bubbles hidden until user provides text
  renderUrlPreview([], []);

  // ===== Start / Stop mechanics =====
  let currentJobId = null;

  const runBtn = document.getElementById('runUrls');
  const stopBtn = document.getElementById('stopOpen');
  const status = document.getElementById('urlStatus');

  function setRunning(running, totalCount = null) {
    if (running) {
      runBtn.disabled = true;
      stopBtn.style.display = '';
      if (totalCount != null) {
        status.textContent = `Starting in background: ${totalCount} unique tab(s)… Click “Stop” to cancel.`;
      }
    } else {
      runBtn.disabled = false;
      stopBtn.style.display = 'none';
    }
  }

  runBtn.addEventListener('click', async () => {
    const text = document.getElementById('urlInput').value || '';
    const delayEnabled = document.getElementById('useDelay').checked;

    const all = extractAll(text);
    const urls = unique(all);

    if (!urls.length) {
      status.textContent = 'No URLs found.';
      return;
    }

    // Generate a jobId and remember it
    currentJobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    setRunning(true, urls.length);

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const windowId = currentTab.windowId;

    chrome.runtime.sendMessage({
      type: "OPEN_URLS",
      payload: { urls, windowId, delayMs: delayEnabled ? 1000 : 0, jobId: currentJobId }
    }, (resp) => {
      // If popup was closed, resp may be undefined; ignore
      if (!resp) return;
      setRunning(false);
      if (resp.ok) {
        if (resp.cancelled) {
          status.textContent = `Stopped early. Opened ${resp.count} tab(s) and grouped as “Failed LP”.`;
        } else {
          status.textContent = `Done. Opened ${resp.count} tab(s) and grouped as “Failed LP”.`;
        }
      } else {
        status.textContent = `Error: ${resp.error}`;
      }
      currentJobId = null;
    });
  });

  stopBtn.addEventListener('click', () => {
    if (!currentJobId) return;
    chrome.runtime.sendMessage({ type: "STOP_OPEN", jobId: currentJobId }, (resp) => {
      // We keep the UI in "running" state until the OPEN_URLS call returns,
      // because background still needs to finish grouping already-opened tabs.
      if (resp?.ok) {
        status.textContent = 'Stopping… finishing up current step.';
      } else {
        status.textContent = `Stop failed: ${resp?.error || 'unknown error'}`;
      }
    });
  });

  // ===== Grafana → TSV formatter =====
  function formatGrafanaTextToTSV(raw) {
    if (!raw) return "";
    const lines = raw.replace(/\r\n/g,"\n").split("\n").map(s=>s.trim()).filter(Boolean);
    if (!lines.length) return "";
    const headA=(lines[0]||"").toLowerCase(), headB=(lines[1]||"").toLowerCase();
    let start=0; if (headA==="company" && headB==="count") start=2;
    const rows=[]; for (let i=start;i<lines.length;i+=2){ rows.push(`${lines[i]}\t${lines[i+1]||""}`); }
    return rows.join("\n");
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
      if (!source) { out.textContent = "Nothing to format. Paste text or copy from Grafana first."; return; }
      const tsv = formatGrafanaTextToTSV(source);
      if (!tsv) { out.textContent = "Could not parse any rows. Check the pasted text."; return; }
      await navigator.clipboard.writeText(tsv);
      const lines = tsv.split("\n");
      const preview = lines.slice(0, Math.min(4, lines.length)).join(" | ");
      out.textContent = `Copied TSV (${lines.length} rows). Example: ${preview}${lines.length>4?" ...":""}`;
    } catch (e) {
      out.textContent = "Clipboard error. " + (e?.message || e);
    }
  });
});
