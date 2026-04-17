import axios from "axios";
import colors from "colors";

let token = null;

export async function login() {
  console.log(colors.cyan("Logging in to BioTime..."));
  const response = await axios.post(
    process.env.BIOTIME_AUTH_URL,
    {
      username: process.env.BIOTIME_USERNAME,
      password: process.env.BIOTIME_PASSWORD,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  const { token: accessToken } = response.data;

  token = accessToken;

  console.log(token, colors.green("Auth success"));

  return token;
}

export async function getToken() {
  if (!token) {
    await login();
  }
  return token;
}

export function clearToken() {
  token = null;
}
