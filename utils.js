/**
 * Shared Utilities for Support Toolkit
 */

export const MAX_TABS_PER_JOB = 40;

// ===== HELPER FUNCTIONS =====

export function sleep(ms, checkCancelled) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      clearInterval(intervalId);
      resolve(true);
    }, ms);

    const intervalId = setInterval(() => {
      if (checkCancelled && checkCancelled()) {
        clearTimeout(timeoutId);
        clearInterval(intervalId);
        resolve(false);
      }
    }, 50);
  });
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function unique(arr) {
  return [...new Set(arr)];
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function truncate(s, max = 200) {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export function normalizeLines(raw) {
  return raw.replace(/\r\n/g, "\n").split("\n").map(s => s.trim()).filter(Boolean);
}

// ===== URL LOGIC =====

// Security: Validate and sanitize URLs
export function sanitizeUrl(url) {
  try {
    let cleanedUrl = url;

    const firstQuestionMark = cleanedUrl.indexOf('?');
    if (firstQuestionMark !== -1) {
      const beforeQuery = cleanedUrl.substring(0, firstQuestionMark + 1);
      const afterQuery = cleanedUrl.substring(firstQuestionMark + 1);
      cleanedUrl = beforeQuery + afterQuery.replace(/\?/g, '&');
    }

    const matchesIndexId = cleanedUrl.match(/^(https?:\/\/[^\s"'<>()]+index\.html\?id=)([^&\s]+)(.*)$/i);
    const matchesIndexM3u8 = cleanedUrl.match(/^(https?:\/\/[^\s"'<>()]+?\?url=https?:\/\/[^\s"'<>()]+?)([a-z0-9/]+\.m3u8)(.*)$/i);
    const matchesMp4 = cleanedUrl.match(/^(https?:\/\/(?:[a-zA-Z0-9-]+\.)*idomoo\.com\/[a-zA-Z0-9\/._-]+\.mp4)$/i);

    if (matchesMp4) return matchesMp4[1];

    let finalUrl = null;

    if (matchesIndexId) {
      let base = matchesIndexId[1];
      let idPart = matchesIndexId[2];
      let queryParams = matchesIndexId[3];

      const idxUp = idPart.search(/[A-Z]/);
      if (idxUp !== -1) idPart = idPart.slice(0, idxUp);

      if (queryParams.includes('&url=')) {
        const urlMatch = queryParams.match(/(&url=https?:\/\/[^\s&]+?)([a-z0-9/]+\.m3u8)/i);
        if (urlMatch) {
          const urlBase = urlMatch[1];
          let m3u8Path = urlMatch[2];

          const m3u8UpIdx = m3u8Path.search(/[A-Z]/);
          if (m3u8UpIdx !== -1) m3u8Path = m3u8Path.slice(0, m3u8UpIdx);

          const m3u8Idx = m3u8Path.indexOf('.m3u8');
          if (m3u8Idx !== -1) m3u8Path = m3u8Path.slice(0, m3u8Idx + 6);

          const beforeUrl = queryParams.substring(0, queryParams.indexOf('&url='));
          finalUrl = base + idPart + beforeUrl + urlBase + m3u8Path;
        } else {
          finalUrl = base + idPart + queryParams;
        }
      } else {
        finalUrl = base + idPart + queryParams;
      }

    } else if (matchesIndexM3u8) {
      let base = matchesIndexM3u8[1];
      let m3u8 = matchesIndexM3u8[2];

      const idxUp = m3u8.search(/[A-Z]/);
      if (idxUp !== -1) m3u8 = m3u8.slice(0, idxUp);

      const idxM3U8 = m3u8.indexOf('.m3u8');
      if (idxM3U8 !== -1) m3u8 = m3u8.slice(0, idxM3U8 + 6);

      finalUrl = base + m3u8;
    }

    if (!finalUrl) return null;

    try {
      const urlObj = new URL(finalUrl);
      const idParam = urlObj.searchParams.get('id');
      const urlParam = urlObj.searchParams.get('url');

      if (idParam) {
        const idParts = idParam.split('/');
        if (idParts.length > 0) {
          const videoHash = idParts[idParts.length - 1];
          if (/[A-Z]/.test(videoHash)) return null;
        }
      }

      if (urlParam) {
        const urlParts = urlParam.split('/');
        const lastPart = urlParts[urlParts.length - 1];
        const videoHash = lastPart.replace('.m3u8', '');
        if (/[A-Z]/.test(videoHash)) return null;
      }
    } catch (urlParseError) {
      return null;
    }

    return finalUrl;

  } catch (e) {
    return null;
  }
}

export function extractAll(text) {
  if (!text) return [];

  const urls = new Set();
  const standardMatches = [...text.matchAll(/https?:\/\/[^\s"'<>()]+/gi)];
  standardMatches.forEach(m => {
    const cleaned = sanitizeUrl(m[0]
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[),.;\]]+$/g, "")
      .trim());
    if (cleaned) urls.add(cleaned);
  });

  const domainPattern = /(?:^|[^a-zA-Z0-9.-])([a-zA-Z0-9][-a-zA-Z0-9]{0,61}[a-zA-Z0-9]?\.)+(?:com|net|org|io|co|idomoo)(?:\/[^\s]*)?/gi;
  const domainMatches = [...text.matchAll(domainPattern)];

  domainMatches.forEach(m => {
    let url = m[0].replace(/^[^a-zA-Z0-9]+/, "").replace(/[),.;\]]+$/g, "").trim();
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    const cleaned = sanitizeUrl(url);
    if (!cleaned) return;

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

// NEW: Extract specific idomoo MP4s from messy text
export function extractIdomooMp4s(text) {
  if (!text) return [];
  // Regex: https://(anything).idomoo.com/(path).mp4
  // We stop specifically at .mp4 to avoid grabbing subsequent text like "EU:Account..."
  const regex = /https?:\/\/(?:[a-zA-Z0-9-]+\.)*idomoo\.com\/[a-zA-Z0-9\/._-]+\.mp4/gi;
  const matches = [...text.matchAll(regex)].map(m => m[0]);
  return unique(matches);
}

export function extractUrlsFromHtml(html) {
  if (!html) return [];

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    return [...doc.querySelectorAll("a[href]")]
      .map(a => a.getAttribute("href"))
      .filter(Boolean)
      .map(href => sanitizeUrl(href.trim()))
      .filter(Boolean);
  } catch (e) {
    console.warn("[Support Toolkit] Failed to parse HTML for URLs", e);
    return [];
  }
}

// ===== GRAFANA PARSING LOGIC =====

export function parseCompanyCount(raw) {
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

export function looksLikeHeaderTriplet(a, b, c) {
  if (!a || !b || !c) return false;
  const A = a.toLowerCase(), B = b.toLowerCase(), C = c.toLowerCase();
  return ((A.includes("player") && A.includes("version")) || (A.includes("version") && !/\d/.test(A)))
    && (B.includes("description") || B.includes("error"))
    && (C.includes("count") || C.includes("unique"));
}

export function parseVersionErrorCount(raw) {
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

export function rowsToTSV(headers, rows) {
  const all = headers.length ? [headers, ...rows] : rows;
  return all.map(r => r.join("\t")).join("\n");
}

export function tableToHTML(headers, rows) {
  const esc = escapeHtml;
  const th = headers.length
    ? `<thead><tr>${headers.map(h => `<th style="border:1px solid #000;padding:6px 8px;text-align:left;">${esc(h)}</th>`).join("")}</tr></thead>` : "";
  const tb = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td style="border:1px solid #000;padding:6px 8px;vertical-align:top;">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<!doctype html><html><body><table style="border-collapse:collapse;">${th}${tb}</table></body></html>`;
}

// ===== UI FORMATTING =====

export function buildPrettyPreview(lines, maxLines = 6) {
  if (!lines || !lines.length) return "";
  const shown = lines.slice(0, maxLines);
  const more = lines.length > maxLines ? `… (+${lines.length - maxLines} more)` : "";
  return [...shown, more].filter(Boolean).map(escapeHtml).join("<br>");
}