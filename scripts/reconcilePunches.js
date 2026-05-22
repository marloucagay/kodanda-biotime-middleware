import moment from "moment";
import colors from "colors";
import dotenv from "dotenv";
import fs from "fs";
import { db } from "../src/config/firestore.js";
import { fetchLogs, deduplicateLogs } from "../src/services/biotime.service.js";

import { computePunch } from "../src/services/hcm.service.js";

dotenv.config();

/**
 * =========================================================
 * CONFIG
 * =========================================================
 */

const ORG_IDS = [
  "gti",
  "wn-energy",
  // add more orgIds here
];

/**
 * =========================================================
 * HELPERS
 * =========================================================
 */

function groupByEmployee(logs) {
  return logs.reduce((acc, log) => {
    if (!acc[log.employeeId]) {
      acc[log.employeeId] = [];
    }

    acc[log.employeeId].push(log);

    return acc;
  }, {});
}

function isWithinWindow(existing, incoming, seconds = 10) {
  if (!existing) return false;

  return (
    Math.abs(moment(incoming).diff(moment(existing), "seconds")) <= seconds
  );
}

function isValidOutCandidate(punchIn, incoming, minMinutes = 30) {
  if (!punchIn) return false;

  return moment(incoming).diff(moment(punchIn), "minutes") >= minMinutes;
}

/**
 * =========================================================
 * FETCH PROBLEMATIC PUNCH RECORDS
 * =========================================================
 */

async function getProblematicPunchRecords(date) {
  const snapshot = await db
    .collection("PunchRecords")
    .where("transactionDate", "==", date)
    .where("orgId", "in", ORG_IDS)
    .get();

  const records = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  /**
   * Missing punchIn OR punchOut only
   */
  return records.filter((record) => !record.punchIn || !record.punchOut);
}

/**
 * =========================================================
 * RECONCILE SINGLE PUNCH
 * =========================================================
 */

function reconcilePunchRecord(punchData, employeeLogs) {
  if (!employeeLogs || employeeLogs.length === 0) {
    return punchData;
  }

  const logs = [...employeeLogs].sort(
    (a, b) => moment(a.timestamp).valueOf() - moment(b.timestamp).valueOf(),
  );

  for (const log of logs) {
    if (log.type !== "IN" && log.type !== "OUT") {
      continue;
    }

    const ts = moment(log.timestamp);

    /**
     * =====================================================
     * HANDLE IN
     * =====================================================
     */
    if (log.type === "IN") {
      /**
       * Missing IN
       */
      if (!punchData.punchIn) {
        punchData.punchIn = ts.format("YYYY-MM-DD HH:mm:ss");

        punchData.punchInInfo = {
          inferred: false,
          reconciled: true,
          reconciliationType: "manual-script",
          deviceInfo: log.deviceAlias || log.deviceId,
          deviceId: log.deviceId,
          timestamp: punchData.punchIn,
          updatedAt: moment().toISOString(),
          source: "biometric",
        };

        console.log(colors.green(`Recovered IN for ${punchData.employeeId}`));

        continue;
      }

      /**
       * Infer OUT from second IN
       */
      if (
        punchData.punchIn &&
        !punchData.punchOut &&
        isValidOutCandidate(punchData.punchIn, ts) &&
        !isWithinWindow(punchData.punchIn, ts, 120)
      ) {
        punchData.punchOut = ts.format("YYYY-MM-DD HH:mm:ss");

        punchData.punchOutInfo = {
          inferred: true,
          reconciled: true,
          reconciliationType: "manual-script",
          deviceInfo: log.deviceAlias || log.deviceId,
          deviceId: log.deviceId,
          timestamp: punchData.punchOut,
          updatedAt: moment().toISOString(),
          source: "biometric",
        };

        console.log(
          colors.cyan(`Inferred OUT from second IN (${punchData.employeeId})`),
        );

        continue;
      }
    }

    /**
     * =====================================================
     * HANDLE OUT
     * =====================================================
     */
    if (log.type === "OUT") {
      /**
       * Missing IN but OUT exists first
       */
      if (!punchData.punchIn) {
        punchData.punchIn = ts.format("YYYY-MM-DD HH:mm:ss");

        punchData.punchInInfo = {
          inferred: true,
          correctedFrom: "OUT",
          reconciled: true,
          reconciliationType: "manual-script",
          deviceInfo: log.deviceAlias || log.deviceId,
          deviceId: log.deviceId,
          timestamp: punchData.punchIn,
          updatedAt: moment().toISOString(),
          source: "biometric",
        };

        console.log(
          colors.cyan(`Corrected OUT → IN (${punchData.employeeId})`),
        );

        continue;
      }

      /**
       * Missing OUT
       */
      if (!punchData.punchOut && ts.isAfter(moment(punchData.punchIn))) {
        punchData.punchOut = ts.format("YYYY-MM-DD HH:mm:ss");

        punchData.punchOutInfo = {
          inferred: false,
          reconciled: true,
          reconciliationType: "manual-script",
          deviceInfo: log.deviceAlias || log.deviceId,
          deviceId: log.deviceId,
          timestamp: punchData.punchOut,
          updatedAt: moment().toISOString(),
          source: "biometric",
        };

        console.log(colors.green(`Recovered OUT for ${punchData.employeeId}`));

        continue;
      }
    }
  }

  return punchData;
}
async function buildEmployeeBadgeMap(employeeReferences) {
  const map = new Map();

  for (const employeeReference of employeeReferences) {
    console.log(colors.blue(`Searching ${employeeReference.employeeNumber}`));

    const snapshot = await db
      .collection("Employees")
      .where(
        "information.employeeNumber",
        "==",
        employeeReference.employeeNumber,
      )
      .where("information.orgId", "==", employeeReference.orgId)
      .where("information.statusType", "==", "Active")
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log(
        colors.red(
          `No employee found for badgeNumber ${employeeReference.employeeNumber}`,
        ),
      );

      continue;
    }

    const employee = snapshot.docs[0].data();
    if (!employee.biometrics?.badgeNumber) {
      console.log(
        colors.red(`No badgeNumber for ${employeeReference.employeeNumber}`),
      );
      continue;
    }
    map.set(employeeReference.employeeNumber, employee.biometrics.badgeNumber);

    console.log(
      colors.green(
        `Mapped badge ${employeeReference.employeeNumber} → ${employee.biometrics.badgeNumber}`,
      ),
    );
  }

  return map;
}
/**
 * =========================================================
 * MAIN RECONCILIATION
 * =========================================================
 */

async function reconcilePunches(date) {
  console.log(colors.magenta(`\nReconciling punch records for ${date}`));

  /**
   * STEP 1:
   * Fetch problematic punch records
   */
  const problematicPunches = await getProblematicPunchRecords(date);

  console.log(
    colors.yellow(`Problematic punch records: ${problematicPunches.length}`),
  );

  if (problematicPunches.length === 0) {
    console.log(colors.green("No problematic punches found"));

    return;
  }

  const employeeReferences = [
    ...new Map(
      problematicPunches.map((p) => [
        `${p.employeeNumber}_${p.orgId}`,
        {
          employeeNumber: p.employeeNumber,
          orgId: p.orgId,
        },
      ]),
    ).values(),
  ];

  const badgeMap = await buildEmployeeBadgeMap(employeeReferences);
  /**
   * STEP 2:
   * Fetch logs
   */
  const start = moment(date).startOf("day");
  const end = moment(date).endOf("day");

  const logs = await fetchLogs({
    startTime: start.format("YYYY-MM-DD HH:mm:ss"),
    endTime: end.format("YYYY-MM-DD HH:mm:ss"),
  });

  console.log(colors.blue(`Fetched logs: ${logs.length}`));

  const cleanedLogs = deduplicateLogs(logs);

  console.log(colors.blue(`Cleaned logs: ${cleanedLogs.length}`));

  /**
   * STEP 3:
   * Group logs
   */
  const groupedLogs = groupByEmployee(cleanedLogs);

  /**
   * STEP 4:
   * Reconcile
   */
  const batch = db.batch();

  const punchesToCompute = [];
  const reconciliationResults = [];

  for (const punchData of problematicPunches) {
    const employeeId = badgeMap.get(punchData.employeeNumber);

    if (!employeeId) {
      console.log(
        colors.red(`No employeeId mapping for ${punchData.employeeNumber}`),
      );

      continue;
    }
    const employeeLogs = groupedLogs[employeeId] || [];

    const originalPunchIn = punchData.punchIn;
    const originalPunchOut = punchData.punchOut;

    const reconciledPunch = reconcilePunchRecord(
      { ...punchData },
      employeeLogs,
    );

    /**
     * Skip unchanged
     */
    const changed =
      originalPunchIn !== reconciledPunch.punchIn ||
      originalPunchOut !== reconciledPunch.punchOut;

    if (!changed) {
      console.log(
        colors.gray(
          `No reconciliation changes for ${punchData.employeeNumber}`,
        ),
      );

      continue;
    }
    reconciliationResults.push(reconciledPunch);
    const ref = db.collection("PunchRecords").doc(reconciledPunch.id);

    batch.set(ref, reconciledPunch, {
      merge: true,
    });

    console.log(
      colors.green(`Queued update for ${reconciledPunch.employeeId}`),
    );

    if (reconciledPunch.punchIn && reconciledPunch.punchOut) {
      punchesToCompute.push(reconciledPunch);
    }
  }
  const outputPath = `./reconciliation-${date}.json`;

  fs.writeFileSync(outputPath, JSON.stringify(reconciliationResults, null, 2));

  console.log(colors.green(`\nReconciliation preview saved to ${outputPath}`));
  /**
   * STEP 5:
   * Commit updates
   */
  // await batch.commit();

  console.log(colors.green(`\nPunch reconciliation batch committed`));

  /**
   * STEP 6:
   * Recompute punches
   */
  if (punchesToCompute.length > 0) {
    console.log(colors.cyan(`Recomputing ${punchesToCompute.length} punches`));

    await Promise.all(punchesToCompute.map((punch) => computePunch(punch)));
  }

  console.log(colors.green(`\nPunch reconciliation completed successfully`));
}

/**
 * =========================================================
 * CLI
 * =========================================================
 *
 * Usage:
 *
 * node scripts/reconcilePunches.js 2026-05-18
 *
 * =========================================================
 */

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(
    colors.red("Usage: node scripts/reconcilePunches.js <YYYY-MM-DD>"),
  );

  process.exit(1);
}

const targetDate = args[0];

reconcilePunches(targetDate)
  .then(() => {
    console.log(colors.green("Done"));

    process.exit(0);
  })
  .catch((err) => {
    console.error(colors.red(err.message));

    process.exit(1);
  });
