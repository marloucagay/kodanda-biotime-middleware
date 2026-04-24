import axios from "axios";

const HCM_URL = process.env.HCM_API_URL;
const API_KEY = process.env.API_KEY;
const AUTH_KEY = process.env.AUTH_KEY;

export async function getEmployeePunchRecord(
  employeeId,
  dateKey,
  orgId = "gti",
) {
  console.log(HCM_URL);
  const request = await axios.get(
    `${HCM_URL}/punch/transaction-date/temp/${employeeId}/${dateKey}/${orgId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        Authorization: `Bearer ${AUTH_KEY}`,
        "x-org": "gti",
      },
    },
  );
  const res = request.data.response;

  return res;
}

export async function webBundy(punchData) {
  // Implementation for web bundy
  try {
    await axios.post(`${HCM_URL}/web-bundy`, punchData, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        Authorization: `Bearer ${AUTH_KEY}`,
        "x-org": "gti",
      },
    });

    return true;
  } catch (error) {
    console.error("Error recomputing punch record:", error.message);
    return false;
  }
}

export async function computePunch(punchData) {
  try {
    await axios.post(`${HCM_URL}/recompute-punch-vinc`, punchData, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        Authorization: `Bearer ${AUTH_KEY}`,
        "x-org": punchData.orgId,
      },
    });

    return true;
  } catch (error) {
    console.error("Error recomputing punch record:", error.message);
    return false;
  }
}
