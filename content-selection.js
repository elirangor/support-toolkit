// content-selection.js
// Reads selection (text + HTML). If selection is inside a table, returns full table HTML.

function getSelectionHtml(selection) {
  if (!selection || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0).cloneContents();
  const div = document.createElement("div");
  div.appendChild(range);
  return div.innerHTML || "";
}

function findNearestTableFromSelection(selection) {
  if (!selection || selection.rangeCount === 0) return null;

  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!(node instanceof Element)) return null;

  return node.closest("table");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_SELECTION_DATA") return;

  try {
    const selection = window.getSelection();
    const text = selection ? selection.toString() : "";
    const html = getSelectionHtml(selection);
    const table = findNearestTableFromSelection(selection);

    sendResponse({
      ok: true,
      text,
      html,
      tableHtml: table ? table.outerHTML : "",
      hasSelection: Boolean((text && text.trim()) || (html && html.trim()))
    });
  } catch (e) {
    sendResponse({ ok: false, error: e?.message || String(e) });
  }

  return true;
});
