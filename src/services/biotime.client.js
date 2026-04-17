import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const client = axios.create({
  baseURL: process.env.BIOTIME_URL,
  timeout: 15000,
});

export default client;
