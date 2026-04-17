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

let isRunning = false;

async function syncLogs() {
  if (isRunning) {
    console.log(colors.yellow("Previous job still running, skipping..."));
    return;
  }

  isRunning = true;

  try {
    console.log(colors.cyan("\n[SYNC] Starting biometric sync..."));
    console.log(colors.blue("[SYNC] Fetching logs from Biotime..."));

    const lastSync = await getLastSyncTime();

    const now = moment();
    // const now = moment().set({
    //   hour: 17,
    //   minute: 3,
    //   second: 0,
    //   millisecond: 0,
    // });
    // console.log(colors.gray(now.format("YYYY-MM-DD HH:mm:ss")));

    const start = lastSync
      ? moment(lastSync).subtract(2, "minutes")
      : moment().subtract(15, "minutes");
    // const start = moment().set({
    //   hour: 17,
    //   minute: 3,
    //   second: 0,
    //   millisecond: 0,
    // });
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

    const cleanedLogs = deduplicateLogs(logs);

    console.log(
      colors.blue(
        `[SYNC] Fetched: ${logs.length} | Cleaned: ${cleanedLogs.length}`,
      ),
    );

    if (cleanedLogs.length > 0) {
      await saveLogs(cleanedLogs);
      console.log(colors.green("[SYNC] Logs saved"));

      await updatePunchRecords(cleanedLogs);
      console.log(colors.green("[SYNC] Punch records updated"));
    } else {
      console.log(colors.yellow("[SYNC] No logs to process"));
    }

    await updateLastSyncTime(now.toISOString());

    console.log(colors.green("[SYNC] Sync complete"));
  } catch (err) {
    console.error(colors.red(`[SYNC ERROR] ${err.message}`));
  } finally {
    isRunning = false;
  }
}

cron.schedule("*/15 * * * *", async () => {
  await syncLogs();
});
