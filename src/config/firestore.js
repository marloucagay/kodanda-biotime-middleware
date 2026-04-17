import admin from "firebase-admin";
import dotenv from "dotenv";
import colors from "colors";

dotenv.config();
//
colors.cyan("Config Loaded Successfully...");
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
  ),
});

export const db = admin.firestore();
