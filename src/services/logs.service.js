import { db } from "../config/firestore.js";

const BATCH_LIMIT = 500;

export async function saveLogs(logs) {
  if (!logs || logs.length === 0) return;

  const chunks = chunkArray(logs, BATCH_LIMIT);

  for (const chunk of chunks) {
    const batch = db.batch();

    for (const log of chunk) {
      const docId = `${log.employeeId}_${log.timestamp}`;

      const ref = db.collection("biometric_logs").doc(docId);

      batch.set(ref, {
        ...log,
        createdAt: new Date().toISOString(),
      });
    }

    await batch.commit();
    console.log(`Saved chunk of ${chunk.length} logs`);
  }
}

function chunkArray(array, size) {
  const result = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }

  return result;
}
