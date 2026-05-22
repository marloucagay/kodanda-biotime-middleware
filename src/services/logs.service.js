import { db } from "../config/firestore.js";

const BATCH_LIMIT = 500;

/**
 * Saves ONLY new logs.
 * Returns inserted logs.
 */
export async function saveLogs(logs) {
  if (!logs || logs.length === 0) return [];

  const existingIds = await getExistingLogIds(logs);

  const newLogs = logs.filter((log) => {
    const docId = `${log.employeeId}_${log.timestamp}`;

    return !existingIds.has(docId);
  });

  if (newLogs.length === 0) {
    console.log("No new logs to save");
    return [];
  }

  const chunks = chunkArray(newLogs, BATCH_LIMIT);

  for (const chunk of chunks) {
    const batch = db.batch();

    for (const log of chunk) {
      const docId = `${log.employeeId}_${log.timestamp}`;

      const ref = db.collection("biometric_logs").doc(docId);

      batch.create(ref, {
        ...log,
        createdAt: new Date().toISOString(),
      });
    }

    await batch.commit();

    console.log(`Saved chunk of ${chunk.length} new logs`);
  }

  return newLogs;
}

async function getExistingLogIds(logs) {
  const ids = logs.map((log) => `${log.employeeId}_${log.timestamp}`);

  const chunks = chunkArray(ids, 10);

  const existingIds = new Set();

  for (const chunk of chunks) {
    const snapshots = await Promise.all(
      chunk.map((id) => db.collection("biometric_logs").doc(id).get()),
    );

    for (const doc of snapshots) {
      if (doc.exists) {
        existingIds.add(doc.id);
      }
    }
  }

  return existingIds;
}

function chunkArray(array, size) {
  const result = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }

  return result;
}
