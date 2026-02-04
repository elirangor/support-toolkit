/* job-processor.js - Handles job state, retry logic, and grouping */

import { MAX_TABS_PER_JOB, sanitizeUrl, sleep } from './utils.js';

// Track running jobs so we can cancel mid-loop
const jobs = new Map(); // jobId -> { cancelled: boolean, timestamp: number }

const JOB_MAX_AGE = 900000; // 15 minutes

// Periodic cleanup of orphaned jobs
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
        if (job.timestamp && now - job.timestamp > JOB_MAX_AGE) {
            jobs.delete(jobId);
        }
    }
}, 120000); // Check every 2 minutes

// Detect errors that are safe to retry
function isTransientTabError(errMsg = "") {
    return /Tabs cannot be edited right now|user may be dragging a tab|currently being dragged|No browser window/i.test(
        String(errMsg)
    );
}

// Create a tab with retries/backoff
async function createTabWithRetry({ url, windowId, jobId, maxRetries = 20 }) {
    const cleanUrl = sanitizeUrl(url);
    if (!cleanUrl) return null;

    let attempt = 0;
    while (true) {
        if (jobs.get(jobId)?.cancelled) return null;

        try {
            const tab = await chrome.tabs.create({ url: cleanUrl, active: false, windowId });
            return tab;
        } catch (e) {
            const msg = e?.message || String(e);
            if (isTransientTabError(msg) && attempt < maxRetries) {
                const waitMs = Math.min(2000, 100 + attempt * 150);
                await sleep(waitMs, () => jobs.get(jobId)?.cancelled);
                attempt++;
                continue;
            } else {
                console.warn('Skipping URL due to non-retryable error:', cleanUrl, msg);
                return null;
            }
        }
    }
}

// Main exported function to run a job
export async function processUrlJob({ urls, windowId, delayMs, jobId }) {
    if (urls.length > MAX_TABS_PER_JOB) {
        throw new Error(`Cannot open more than ${MAX_TABS_PER_JOB} tabs at once.`);
    }

    const tabIds = [];
    jobs.set(jobId, { cancelled: false, timestamp: Date.now() });

    try {
        for (const u of urls) {
            if (jobs.get(jobId)?.cancelled) break;

            const tab = await createTabWithRetry({ url: u, windowId, jobId });
            if (tab?.id != null) tabIds.push(tab.id);

            if (delayMs > 0) {
                const waited = await sleep(delayMs, () => jobs.get(jobId)?.cancelled);
                if (!waited) break;
            }
        }

        let groupId = null;
        if (tabIds.length) {
            try {
                groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
                await chrome.tabGroups.update(groupId, { title: "Failed LP", color: "red" });
            } catch (e) {
                console.warn('Grouping failed:', e);
            }
        }

        const wasCancelled = !!jobs.get(jobId)?.cancelled;
        return { count: tabIds.length, groupId, cancelled: wasCancelled };
    } finally {
        jobs.delete(jobId);
    }
}

export function cancelJob(jobId) {
    if (jobs.has(jobId)) {
        jobs.get(jobId).cancelled = true;
        return true;
    }
    return false;
}

export function getRunningJobIds() {
    return [...jobs.entries()]
        .filter(([, v]) => v && !v.cancelled)
        .map(([id]) => id);
}