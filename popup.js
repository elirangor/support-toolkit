document.addEventListener('DOMContentLoaded', () => {
  // ===== Tabs =====
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${targetTab}-content`).classList.add('active');
      try { localStorage.setItem('activeTab', targetTab); } catch { }
    });
  });
  try {
    const last = localStorage.getItem('activeTab');
    if (last && document.getElementById(`${last}-content`)) {
      document.querySelector(`.tab[data-tab="${last}"]`)?.click();
    }
  } catch { }

  // ===== URL helpers =====
  function sanitize(u) { return u.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[),.;\]]+$/g, "").trim(); }
  function extractAll(text) { if (!text) return []; return [...text.matchAll(/https?:\/\/[^\s"'<>()]+/g)].map(m => sanitize(m[0])); }
  const unique = arr => [...new Set(arr)];

  function renderUrlPreview(allUrls, uniqueUrls) {
    const counts = document.getElementById("urlCounts");
    const preview = document.getElementById("urlPreview");
    if (!uniqueUrls.length) { counts.textContent = ""; preview.innerHTML = ""; return; }
    const removed = allUrls.length - uniqueUrls.length;
    counts.textContent = `Found ${allUrls.length} URL occurrence(s) → ${uniqueUrls.length} unique (${removed} duplicate${removed === 1 ? '' : 's'} removed).`;
    preview.innerHTML = uniqueUrls.map((u, i) => `${i + 1}. ${u}`).join("<br>");
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
    if (running) { runBtn.disabled = true; stopBtn.style.display = ''; if (totalCount != null) { status.textContent = `Starting in background: ${totalCount} unique tab(s)… Click “Stop” to cancel.`; } }
    else { runBtn.disabled = false; stopBtn.style.display = 'none'; }
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
        ? `${resp.cancelled ? 'Stopped early.' : 'Done.'} Opened ${resp.count} tab(s) and grouped as “Failed LP”.`
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

  // === Clipboard helpers ===
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

  // copy ONLY TSV (plain text)
  async function copyTSVOnly(headers, rows) {
    const tsv = rowsToTSV(headers, rows);
    await navigator.clipboard.writeText(tsv);
    return { tsvLines: tsv.split("\n").length };
  }

  // copy HTML table + TSV (rich paste)
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

  // Read clipboard into Grafana textarea
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

  // === 1) Company | Count — TSV ONLY (no table) ===
  document.getElementById('formatGrafana').addEventListener('click', async () => {
    const out = document.getElementById('tsvStatus');
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) { out.textContent = "Nothing to format. Paste text or copy from Grafana first."; return; }

      const rows = parseCompanyCount(source);
      if (!rows.length) { out.textContent = "Could not parse any rows (expected Company/Count pairs)."; return; }

      const { tsvLines } = await copyTSVOnly([], rows); // no headers
      const preview = rows.slice(0, Math.min(3, rows.length)).map(r => r.join(" | ")).join(" || ");
      out.textContent = `Copied TSV (${tsvLines - 1} rows). Example: ${preview}${rows.length > 3 ? " ..." : ""}`;
    } catch (e) { out.textContent = "Clipboard error. " + (e?.message || e); }
  });

  // === 2) Error | Version | Count — HTML table (+ TSV fallback) ===
  document.getElementById('formatGrafana3').addEventListener('click', async () => {
    const out = document.getElementById('tsvStatus');
    try {
      let source = (document.getElementById('grafanaInput').value || "").trim();
      if (!source) source = await navigator.clipboard.readText();
      if (!source) { out.textContent = "Nothing to format. Paste text or copy from Grafana first."; return; }

      const rowsVEC = parseVersionErrorCount(source);
      if (!rowsVEC.length) { out.textContent = "Could not parse any 3-line groups (Version, Error, Count)."; return; }

      // permanent order swap to Error | Version | Count; no header row
      const finalRows = rowsVEC.map(([version, error, count]) => [error, version, count]);
      const headers = []; // no headers

      const { tsvLines } = await copyTableHTMLPlusTSV(headers, finalRows); // <-- rich table
      const shown = finalRows.slice(0, Math.min(2, finalRows.length)).map(r => r.join(" | ")).join(" || ");
      out.textContent = `Copied HTML table + TSV (${tsvLines} row${tsvLines === 1 ? "" : "s"}). Example: ${shown}${finalRows.length > 2 ? " ..." : ""}`;
    } catch (e) { out.textContent = "Clipboard error. " + (e?.message || e); }
  });
});
