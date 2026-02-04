// background.js - Full file with site-specific shortcut logic and detailed notifications
import {
  extractAll,
  extractUrlsFromHtml,
  extractIdomooMp4s, // Added import
  unique,
  parseCompanyCount,
  parseVersionErrorCount,
  rowsToTSV,
  tableToHTML,
  pad2,
  MAX_TABS_PER_JOB
} from './utils.js';

import { processUrlJob, cancelJob, getRunningJobIds } from './job-processor.js';

// Show notification helper with custom titles and messages
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
        // Pass payload directly which includes groupTitle/Color
        const result = await processUrlJob(msg.payload);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error(e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
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
    if (!currentTab?.id || !currentTab?.url) return;

    const currentUrl = currentTab.url;

    // --- SHORTCUT: Open URLs (Restricted to AlertOps) ---
    if (command === "open-lp-urls") {
      if (!currentUrl.includes("app.alertops.com")) {
        return showNotification('Invalid Site', 'The "Open URLs" shortcut only works on app.alertops.com.');
      }

      const injected = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id, allFrames: true },
        func: () => {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null;

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
        return showNotification('No Selection', 'Please select text containing URLs in AlertOps first.');
      }

      const urlsFromHtml = extractUrlsFromHtml(picked.tableHtml || picked.html || "");
      const urlsFromText = extractAll(picked.text || "");
      const urls = unique([...urlsFromHtml, ...urlsFromText]);

      if (!urls.length) return showNotification('No URLs Found', 'No valid LP URLs were found in your selection.');
      if (urls.length > MAX_TABS_PER_JOB) return showNotification('Limit Exceeded', `Found ${urls.length} URLs. Max allowed is ${MAX_TABS_PER_JOB}.`);

      const jobId = `${Date.now()}-shortcut`;
      const { useDelayBetweenTabs } = await chrome.storage.local.get(['useDelayBetweenTabs']);

      showNotification('Processing', `Opening ${urls.length} tab(s) in a new group...`);
      await processUrlJob({ urls, windowId: currentTab.windowId, delayMs: useDelayBetweenTabs ? 1000 : 0, jobId });
      showNotification('Success', `Finished opening ${urls.length} tabs.`);

      // --- NEW SHORTCUT: Open Black Frames (Global/Any text) ---
    } else if (command === "open-black-frames") {

      const text = await getSelectionText(currentTab.id);
      if (!text) return showNotification('No Selection', 'Please select text containing black frame videos first.');

      const urls = extractIdomooMp4s(text);

      if (!urls.length) return showNotification('No MP4s Found', 'No black frame video links were found in selection.');
      if (urls.length > MAX_TABS_PER_JOB) return showNotification('Limit Exceeded', `Found ${urls.length} URLs. Max allowed is ${MAX_TABS_PER_JOB}.`);

      const jobId = `${Date.now()}-bf-shortcut`;
      const { useDelayBetweenTabs } = await chrome.storage.local.get(['useDelayBetweenTabs']);

      showNotification('Processing', `Opening ${urls.length} Black Frames...`);
      // Use "grey" color for Black Frames group
      await processUrlJob({
        urls,
        windowId: currentTab.windowId,
        delayMs: useDelayBetweenTabs ? 1000 : 0,
        jobId,
        groupTitle: "Black Frames",
        groupColor: "grey"
      });
      showNotification('Success', `Opened ${urls.length} Black Frame videos.`);


      // --- SHORTCUT: Format Company Batch (Restricted to Grafana) ---
    } else if (command === "format-company-batch") {
      if (!currentUrl.includes("grafana.net")) {
        return showNotification('Invalid Site', 'Company Batch formatting only works on idomoo.grafana.net.');
      }

      const text = await getSelectionText(currentTab.id);
      if (!text) return showNotification('No Selection', 'Please select the Grafana table text to format.');

      const rows = parseCompanyCount(text);
      if (!rows.length) return showNotification('Parse Error', 'Selected text does not match the expected Company/Count format.');

      await writeToClipboard(currentTab.id, rowsToTSV([], rows));
      showNotification('Formatted', `✓ ${rows.length} rows copied as TSV for spreadsheets.`);

      // --- SHORTCUT: Format Media Errors (Restricted to Grafana) ---
    } else if (command === "format-media-errors") {
      if (!currentUrl.includes("grafana.net")) {
        return showNotification('Invalid Site', 'Media Error formatting only works on idomoo.grafana.net.');
      }

      const text = await getSelectionText(currentTab.id);
      if (!text) return showNotification('No Selection', 'Please select the Grafana error table text to format.');

      const rowsVEC = parseVersionErrorCount(text);
      if (!rowsVEC.length) return showNotification('Parse Error', 'Selected text does not match the expected Media Error format.');

      const finalRows = rowsVEC.map(([version, error, count]) => [error, version, count]);
      await writeToClipboardHTML(currentTab.id, tableToHTML([], finalRows), rowsToTSV([], finalRows));
      showNotification('Formatted', `✓ ${finalRows.length} rows copied (HTML Table + TSV).`);

      // --- SHORTCUT: Paste Daily Report (Restricted to Gmail) ---
    } else if (command === "copy-daily-report") {
      if (!currentUrl.includes("mail.google.com")) {
        return showNotification('Invalid Site', 'The Daily Report shortcut only works within Gmail.');
      }

      const d = new Date();
      const dateText = `Daily Report ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${pad2(d.getFullYear() % 100)} ${d.toLocaleDateString("en-US", { weekday: "long" })}`;

      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: (t) => {
          const success = document.execCommand("insertText", false, t);
          if (!success) {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.contentEditable === 'true' || activeEl.tagName === 'TEXTAREA')) {
              activeEl.innerText += t;
            }
          }
        },
        args: [dateText]
      });

      showNotification("Success", `✓ Inserted current date into Gmail.`);
    }

  } catch (error) {
    console.error("Shortcut Error:", error);
    showNotification('System Error', 'An unexpected error occurred while processing the shortcut.');
  }
});

// Helpers for Shortcuts to safely capture text
async function getSelectionText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const selection = window.getSelection().toString().trim();
      return selection || null;
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