import { db } from "../config/firestore.js";

const DOC_ID = "biotime-gti";

export async function getLastSyncTime() {
  const doc = await db.collection("sync_state").doc(DOC_ID).get();

  if (!doc.exists) {
    return null;
  }

  return doc.data().lastSyncTime;
}

export async function updateLastSyncTime(time) {
  await db.collection("sync_state").doc(DOC_ID).set({
    lastSyncTime: time,
  });
}
