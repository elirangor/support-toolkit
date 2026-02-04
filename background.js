// background.js - Main entry point
import {
  extractAll,
  extractUrlsFromHtml,
  unique,
  parseCompanyCount,
  parseVersionErrorCount,
  rowsToTSV,
  tableToHTML,
  pad2,
  MAX_TABS_PER_JOB
} from './utils.js';

import { processUrlJob, cancelJob, getRunningJobIds } from './job-processor.js';

// Show notification helper
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: title,
    message: message,
    priority: 2
  });
}

// 1. Message Listeners (Popup Communication)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "OPEN_URLS") {
    (async () => {
      try {
        const result = await processUrlJob(msg.payload);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error(e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // async response
  }

  if (msg?.type === "STOP_OPEN") {
    const success = cancelJob(msg.jobId);
    if (success) sendResponse({ ok: true, message: "Cancellation requested." });
    else sendResponse({ ok: false, error: "No running job found." });
    return true;
  }

  if (msg?.type === "JOB_STATUS") {
    const ids = getRunningJobIds();
    sendResponse({ ok: true, running: ids.length > 0, jobIds: ids });
    return true;
  }
});

// 2. Command Listeners (Keyboard Shortcuts)
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!currentTab?.id) return;

    // --- SHORTCUT: Open URLs ---
    if (command === "open-lp-urls") {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id, allFrames: true },
        func: () => {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return null;

          const range = sel.getRangeAt(0).cloneContents();
          const div = document.createElement("div");
          div.appendChild(range);

          let node = sel.getRangeAt(0).commonAncestorContainer;
          if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
          const table = (node instanceof Element) ? node.closest("table") : null;

          return {
            text: sel.toString(),
            html: div.innerHTML,
            tableHtml: table ? table.outerHTML : ""
          };
        }
      }).catch(() => null);

      const picked = injected?.map(r => r.result).find(r => r);
      if (!picked) {
        showNotification('Support Toolkit', 'No selection found.');
        return;
      }

      const urlsFromHtml = extractUrlsFromHtml(picked.tableHtml || picked.html || "");
      const urlsFromText = extractAll(picked.text || "");
      const urls = unique([...urlsFromHtml, ...urlsFromText]);

      if (!urls.length) return showNotification('Support Toolkit', 'No valid URLs found.');
      if (urls.length > MAX_TABS_PER_JOB) return showNotification('Support Toolkit', `Too many URLs (${urls.length}). Max ${MAX_TABS_PER_JOB}.`);

      const jobId = `${Date.now()}-shortcut`;
      const { useDelayBetweenTabs } = await chrome.storage.local.get(['useDelayBetweenTabs']);

      showNotification('Support Toolkit', `Opening ${urls.length} tab(s)...`);
      await processUrlJob({ urls, windowId: currentTab.windowId, delayMs: useDelayBetweenTabs ? 1000 : 0, jobId });
      showNotification('Support Toolkit', `Finished opening ${urls.length} tabs.`);

      // --- SHORTCUT: Format Company Batch ---
    } else if (command === "format-company-batch") {
      const text = await getSelectionText(currentTab.id);
      if (!text) return showNotification('Support Toolkit', 'No text selected');

      const rows = parseCompanyCount(text);
      if (!rows.length) return showNotification('Support Toolkit', 'Invalid data format');

      await writeToClipboard(currentTab.id, rowsToTSV([], rows));
      showNotification('Support Toolkit', `✓ Formatted ${rows.length} rows (TSV)`);

      // --- SHORTCUT: Format Media Errors ---
    } else if (command === "format-media-errors") {
      const text = await getSelectionText(currentTab.id);
      if (!text) return showNotification('Support Toolkit', 'No text selected');

      const rowsVEC = parseVersionErrorCount(text);
      if (!rowsVEC.length) return showNotification('Support Toolkit', 'Invalid data format');

      const finalRows = rowsVEC.map(([version, error, count]) => [error, version, count]);
      await writeToClipboardHTML(currentTab.id, tableToHTML([], finalRows), rowsToTSV([], finalRows));
      showNotification('Support Toolkit', `✓ Formatted ${finalRows.length} rows (HTML Table)`);

      // --- SHORTCUT: Copy Daily Report ---
    } else if (command === "copy-daily-report") {
      const d = new Date();
      const text = `Daily Report ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${pad2(d.getFullYear() % 100)} ${d.toLocaleDateString("en-US", { weekday: "long" })}`;

      await writeToClipboard(currentTab.id, text); // Try copy

      // Try simple paste via execCommand
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: (t) => {
          document.execCommand("insertText", false, t);
        },
        args: [text]
      });

      showNotification("Support Toolkit", `✓ Copied: ${text}`);
    }

  } catch (error) {
    console.error(error);
  }
});

// Helpers for Shortcuts (to keep main listener clean)
async function getSelectionText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      document.execCommand('copy'); // Force copy to clipboard first
      await new Promise(r => setTimeout(r, 100));
      return navigator.clipboard.readText();
    }
  }).catch(() => null);
  return results?.[0]?.result || null;
}

async function writeToClipboard(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (t) => navigator.clipboard.writeText(t),
    args: [text]
  });
}

async function writeToClipboardHTML(tabId, html, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (h, t) => {
      const blobHtml = new Blob([h], { type: "text/html" });
      const blobTxt = new Blob([t], { type: "text/plain" });
      await navigator.clipboard.write([new ClipboardItem({ "text/html": blobHtml, "text/plain": blobTxt })]);
    },
    args: [html, text]
  });
}