import express from "express";
import dotenv from "dotenv";
import colors from "colors";

// Load env
dotenv.config();

const app = express();
app.use(express.json());

// Basic route
app.get("/", (req, res) => {
  res.send("Biometric Middleware Running");
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// Start scheduler
import "./scheduler/sync.job.js";

const PORT = process.env.PORT;
console.log(PORT);
app.listen(PORT, () => {
  colors.cyan(`Server running on http://localhost:${PORT}`);
});
