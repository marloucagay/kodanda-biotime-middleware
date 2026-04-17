import { db } from "../config/firestore.js";
import moment from "moment";
import { getEmployeePunchRecord, webBundy } from "./hcm.service.js";
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

  return Math.abs(new Date(incoming) - new Date(existing)) / 1000 <= seconds;
}

function isValidOutCandidate(punchIn, incoming, minMinutes = 30) {
  if (!punchIn) return false;

  return new Date(incoming) - new Date(punchIn) >= minMinutes * 60 * 1000;
}

export async function updatePunchRecords(logs) {
  const grouped = groupByEmployee(logs);

  const updatedPunchMap = new Map();

  for (const employeeId in grouped) {
    const employeeLogs = grouped[employeeId];

    employeeLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    for (const log of employeeLogs) {
      if (log.type !== "IN" && log.type !== "OUT") {
        console.log(
          colors.yellow(
            `Unknown log type '${log.type}' for ${employeeId}, skipping`,
          ),
        );
        continue;
      }

      const dateKey = moment(log.timestamp).format("YYYY-MM-DD");

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
          colors.yellow(
            `No punch record for ${employeeId} on ${dateKey}, skipping`,
          ),
        );
        continue;
      }

      const punchData = Array.isArray(punchRecord)
        ? punchRecord[0]
        : punchRecord;

      if (log.type === "IN") {
        if (isWithinWindow(punchData.punchIn, log.timestamp)) {
          console.log(colors.yellow(`Duplicate IN skipped (${employeeId})`));
          continue;
        }

        if (
          punchData.punchIn &&
          !punchData.punchOut &&
          isValidOutCandidate(punchData.punchIn, log.timestamp)
        ) {
          console.log(
            colors.cyan(`Inferring OUT from second IN (${employeeId})`),
          );

          punchData.punchOut = log.timestamp;

          punchData.clientInfo = {
            type: "punchOut",
            inferred: true,
            deviceInfo: log.deviceAlias || log.deviceId,
            deviceId: log.deviceId,
            timestamp: log.timestamp,
            updatedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
            source: "biometric",
          };

          updatedPunchMap.set(punchData.punchId, punchData);
          continue;
        }

        if (
          !punchData.punchIn ||
          new Date(log.timestamp) < new Date(punchData.punchIn)
        ) {
          punchData.punchIn = log.timestamp;

          punchData.clientInfo = {
            type: "punchIn",
            inferred: false,
            deviceInfo: log.deviceAlias || log.deviceId,
            deviceId: log.deviceId,
            timestamp: log.timestamp,
            updatedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
            source: "biometric",
          };

          updatedPunchMap.set(punchData.punchId, punchData);
        }
      }

      if (log.type === "OUT") {
        if (isWithinWindow(punchData.punchOut, log.timestamp)) {
          console.log(colors.yellow(`Duplicate OUT skipped (${employeeId})`));
          continue;
        }

        if (
          !punchData.punchOut ||
          new Date(log.timestamp) > new Date(punchData.punchOut)
        ) {
          punchData.punchOut = log.timestamp;

          punchData.clientInfo = {
            type: "punchOut",
            inferred: false,
            deviceInfo: log.deviceAlias || log.deviceId,
            deviceId: log.deviceId,
            timestamp: log.timestamp,
            updatedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
            source: "biometric",
          };

          updatedPunchMap.set(punchData.punchId, punchData);
        }
      }
    }
  }

  for (const [punchId, punchData] of updatedPunchMap.entries()) {
    console.log(colors.green(`Processing punch ${punchId}`));
    await webBundy(punchData);
  }
}
