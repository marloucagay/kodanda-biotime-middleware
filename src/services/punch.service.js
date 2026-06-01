import { db } from "../config/firestore.js";
import moment from "moment";
import { computePunch, getEmployeePunchRecord } from "./hcm.service.js";
import colors from "colors";

function groupByEmployee(logs) {
  return logs.reduce((acc, log) => {
    if (!acc[log.employeeId]) acc[log.employeeId] = [];
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

export async function updatePunchRecords(logs) {
  const grouped = groupByEmployee(logs);

  const punchCache = new Map(); // key: employeeId-date
  const updatedPunchMap = new Map();

  for (const employeeId in grouped) {
    const employeeLogs = [...grouped[employeeId]].sort(
      (a, b) => moment(a.timestamp).valueOf() - moment(b.timestamp).valueOf(),
    );

    for (const log of employeeLogs) {
      if (log.type !== "IN" && log.type !== "OUT") {
        console.log(
          colors.yellow(`Unknown log type '${log.type}' for ${employeeId}`),
        );
        continue;
      }

      const ts = moment(log.timestamp);
      const dateKey = ts.format("YYYY-MM-DD");
      const cacheKey = `${employeeId}-${dateKey}`;

      let punchData = punchCache.get(cacheKey);

      if (!punchData) {
        const punchRecord = await getEmployeePunchRecord(
          employeeId,
          dateKey,
          "gti",
        );

        if (
          !punchRecord ||
          (Array.isArray(punchRecord) && punchRecord.length === 0)
        ) {
          console.log(
            colors.yellow(`No punch record for ${employeeId} on ${dateKey}`),
          );
          continue;
        }

        const base = Array.isArray(punchRecord) ? punchRecord[0] : punchRecord;

        punchData = { ...base }; // avoid mutation issues
        punchCache.set(cacheKey, punchData);
      }

      /** =======================
       * HANDLE IN
       ======================= */
      if (log.type === "IN") {
        if (isWithinWindow(punchData.punchIn, ts)) {
          console.log(colors.yellow(`Duplicate IN skipped (${employeeId})`));
          continue;
        }

        // Infer OUT from second IN
        if (
          punchData.punchIn &&
          !punchData.punchOut &&
          isValidOutCandidate(punchData.punchIn, ts) &&
          !isWithinWindow(punchData.punchIn, ts, 120) // prevent double scans
        ) {
          console.log(
            colors.cyan(`Inferring OUT from second IN (${employeeId})`),
          );

          punchData.punchOut = ts.format("YYYY-MM-DD HH:mm:ss");

          punchData.punchOutInfo = {
            inferred: true,
            deviceInfo: log.deviceAlias || log.deviceId,
            deviceId: log.deviceId,
            timestamp: punchData.punchOut,
            updatedAt: moment().toISOString(),
            source: "biometric",
          };

          updatedPunchMap.set(punchData.punchId, punchData);
          continue;
        }

        // Infer OUT from second IN
        if (
          punchData.punchIn &&
          punchData.punchOut &&
          ts.isAfter(moment(punchData.punchOut)) &&
          !isWithinWindow(punchData.punchOut, ts, 120)
        ) {
          console.log(
            colors.cyan(`Inferring OUT from second IN (${employeeId})`),
          );

          punchData.punchOut = ts.format("YYYY-MM-DD HH:mm:ss");

          punchData.punchOutInfo = {
            inferred: true,
            deviceInfo: log.deviceAlias || log.deviceId,
            deviceId: log.deviceId,
            timestamp: punchData.punchOut,
            updatedAt: moment().toISOString(),
            source: "biometric",
          };

          updatedPunchMap.set(punchData.punchId, punchData);
          continue;
        }
        // Normal IN
        if (!punchData.punchIn || ts.isBefore(moment(punchData.punchIn))) {
          punchData.punchIn = ts.format("YYYY-MM-DD HH:mm:ss");

          punchData.punchInInfo = {
            inferred: false,
            deviceInfo: log.deviceAlias || log.deviceId,
            deviceId: log.deviceId,
            timestamp: punchData.punchIn,
            updatedAt: moment().toISOString(),
            source: "biometric",
          };

          updatedPunchMap.set(punchData.punchId, punchData);
        }
      }

      if (log.type === "OUT" && !punchData.punchIn) {
        console.log(
          colors.cyan(`Correcting OUT → IN (first log) (${employeeId})`),
        );

        punchData.punchIn = ts.format("YYYY-MM-DD HH:mm:ss");

        punchData.punchInInfo = {
          inferred: true,
          correctedFrom: "OUT",
          deviceInfo: log.deviceAlias || log.deviceId,
          deviceId: log.deviceId,
          timestamp: punchData.punchIn,
          updatedAt: moment().toISOString(),
          source: "biometric",
        };

        updatedPunchMap.set(punchData.punchId, punchData);
        continue;
      }

      /** =======================
       * HANDLE OUT
       ======================= */
      if (log.type === "OUT") {
        if (isWithinWindow(punchData.punchOut, ts)) {
          console.log(colors.yellow(`Duplicate OUT skipped (${employeeId})`));
          continue;
        }

        // Prevent OUT before IN
        if (punchData.punchIn && ts.isBefore(moment(punchData.punchIn))) {
          console.log(colors.red(`Invalid OUT before IN (${employeeId})`));
          continue;
        }

        if (!punchData.punchOut || ts.isAfter(moment(punchData.punchOut))) {
          punchData.punchOut = ts.format("YYYY-MM-DD HH:mm:ss");

          punchData.punchOutInfo = {
            inferred: false,
            deviceInfo: log.deviceAlias || log.deviceId,
            deviceId: log.deviceId,
            timestamp: punchData.punchOut,
            updatedAt: moment().toISOString(),
            source: "biometric",
          };

          updatedPunchMap.set(punchData.punchId, punchData);
        }
      }
    }
  }

  const batch = db.batch();
  const punchesToCompute = [];

  for (const [punchId, punchData] of updatedPunchMap.entries()) {
    console.log(colors.green(`Processing punch ${punchId}`));

    const ref = db.collection("PunchRecords").doc(punchId);

    batch.set(ref, punchData, { merge: true });

    if (punchData.punchIn && punchData.punchOut) {
      punchesToCompute.push(punchData);
    }
  }

  await batch.commit();

  console.log(colors.cyan(`Batch commit complete. Starting compute phase...`));

  await Promise.all(
    punchesToCompute.map((punchData) => computePunch(punchData)),
  );
}
