import cron from "node-cron";
import moment from "moment";
import colors from "colors";
import dotenv from "dotenv";

import { deduplicateLogs, fetchLogs } from "../services/biotime.service.js";

import {
  getLastSyncTime,
  updateLastSyncTime,
} from "../services/syncState.service.js";

import { saveLogs } from "../services/logs.service.js";
import { updatePunchRecords } from "../services/punch.service.js";

dotenv.config();

let isIncrementalRunning = false;
let isReconRunning = false;

// Global job state
let activeJob = null;

// Queued Jobs FIFO pattern
const queuedJobs = [];

function acquireJobLock(jobName) {
  if (activeJob) {
    console.log(
      colors.yellow(
        `[${jobName}] Queued because ${activeJob} is currently running`,
      ),
    );

    return false;
  }

  activeJob = {
    name: jobName,
    startedAt: new Date(),
  };

  console.log(
    colors.cyan(
      `[${jobName}] Lock acquired at ${moment().format("YYYY-MM-DD HH:mm:ss")}`,
    ),
  );

  return true;
}

/**
 * Release global lock
 */
async function releaseJobLock() {
  if (!activeJob) return;

  console.log(
    colors.cyan(
      `[${activeJob.name}] Lock released at ${moment().format(
        "YYYY-MM-DD HH:mm:ss",
      )}`,
    ),
  );

  activeJob = null;

  /**
   * Process next queued job
   */
  if (queuedJobs.length > 0) {
    const nextJob = queuedJobs.shift();

    console.log(colors.magenta(`[QUEUE] Starting queued job: ${nextJob.name}`));

    /**
     * Run queued job async
     * Prevent blocking release flow
     */
    setTimeout(async () => {
      try {
        await nextJob.fn();
      } catch (err) {
        console.error(
          colors.red(`[QUEUE ERROR] ${nextJob.name}: ${err.message}`),
        );
      }
    }, 0);
  }
}

// Queue helper
function enqueueJob(name, fn) {
  queuedJobs.push({
    name,
    fn,
    queuedAt: new Date(),
  });

  console.log(colors.gray(`[QUEUE] Total queued jobs: ${queuedJobs.length}`));
}

/**
 * Shared processor
 */
async function processFetchedLogs(logs, context = "SYNC") {
  const cleanedLogs = deduplicateLogs(logs);

  console.log(
    colors.blue(
      `[${context}] Fetched: ${logs.length} | Cleaned: ${cleanedLogs.length}`,
    ),
  );

  if (cleanedLogs.length === 0) {
    console.log(colors.yellow(`[${context}] No logs fetched`));
    return [];
  }

  /**
   * saveLogs now returns ONLY inserted logs
   */
  const insertedLogs = await saveLogs(cleanedLogs);

  console.log(
    colors.green(`[${context}] New logs inserted: ${insertedLogs.length}`),
  );

  if (insertedLogs.length > 0) {
    await updatePunchRecords(insertedLogs);

    console.log(colors.green(`[${context}] Punch records updated`));
  } else {
    console.log(colors.yellow(`[${context}] No new logs to process`));
  }

  return insertedLogs;
}

/**
 * Incremental sync
 */
async function syncLogs() {
  const jobName = "SYNC";

  if (!acquireJobLock(jobName)) {
    enqueueJob(jobName, syncLogs);

    return;
  }

  try {
    console.log(colors.cyan("\n[SYNC] Starting biometric sync..."));

    const lastSync = await getLastSyncTime();

    const now = moment();

    const start = lastSync
      ? moment(lastSync).subtract(2, "minutes")
      : moment().subtract(15, "minutes");

    console.log(
      colors.gray(
        `[SYNC] Range: ${start.format("YYYY-MM-DD HH:mm:ss")} → ${now.format(
          "YYYY-MM-DD HH:mm:ss",
        )}`,
      ),
    );

    const logs = await fetchLogs({
      startTime: start.format("YYYY-MM-DD HH:mm:ss"),
      endTime: now.format("YYYY-MM-DD HH:mm:ss"),
    });

    const insertedLogs = await processFetchedLogs(logs, "SYNC");

    /**
     * Update sync cursor
     */
    let nextSyncTime = start;

    if (insertedLogs.length > 0) {
      nextSyncTime = insertedLogs.reduce((max, log) => {
        const ts = moment(log.timestamp);

        return ts.isAfter(max) ? ts : max;
      }, start);
    }

    await updateLastSyncTime(nextSyncTime.toISOString());

    console.log(colors.green("[SYNC] Incremental sync complete"));
  } catch (err) {
    console.error(colors.red(`[SYNC ERROR] ${err.message}`));
  } finally {
    await releaseJobLock();
  }
}

/**
 * Whole day reconciliation
 */
async function syncWholeDayLogs(date, label = "RECON") {
  if (!acquireJobLock(label)) {
    enqueueJob(label, () => syncWholeDayLogs(date, label));

    return;
  }

  try {
    const start = moment(date).startOf("day");
    const end = moment(date).endOf("day");

    console.log(
      colors.magenta(
        `\n[${label}] Fetching whole day logs: ${start.format("YYYY-MM-DD")}`,
      ),
    );

    console.log(
      colors.gray(
        `[${label}] Range: ${start.format(
          "YYYY-MM-DD HH:mm:ss",
        )} → ${end.format("YYYY-MM-DD HH:mm:ss")}`,
      ),
    );

    const logs = await fetchLogs({
      startTime: start.format("YYYY-MM-DD HH:mm:ss"),
      endTime: end.format("YYYY-MM-DD HH:mm:ss"),
    });

    await processFetchedLogs(logs, label);

    console.log(colors.green(`[${label}] Whole day reconciliation complete`));
  } catch (err) {
    console.error(colors.red(`[${label} ERROR] ${err.message}`));
  } finally {
    await releaseJobLock();
  }
}

/**
 * Every 15 minutes incremental sync
 */
cron.schedule("*/15 * * * *", async () => {
  await syncLogs();
});

/**
 * 11:00 PM
 * Reconcile CURRENT day
 */
cron.schedule("0 23 * * *", async () => {
  await syncWholeDayLogs(moment(), "RECON-TODAY");
});

/**
 * 11:00 AM
 * Reconcile YESTERDAY
 */
cron.schedule("0 11 * * *", async () => {
  await syncWholeDayLogs(moment().subtract(1, "day"), "RECON-YESTERDAY");
});
