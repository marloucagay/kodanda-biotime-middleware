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
  if (isIncrementalRunning) {
    console.log(colors.yellow("[SYNC] Previous incremental job still running"));

    return;
  }

  isIncrementalRunning = true;

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
    isIncrementalRunning = false;
  }
}

/**
 * Whole day reconciliation
 */
async function syncWholeDayLogs(date, label = "RECON") {
  if (isReconRunning) {
    console.log(
      colors.yellow(`[${label}] Previous reconciliation still running`),
    );

    return;
  }

  isReconRunning = true;

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
    isReconRunning = false;
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
