import { clearToken, getToken, login } from "./biotime.auth.js";
import moment from "moment";
import client from "./biotime.client.js";
import colors from "colors";
const PAGE_SIZE = 100;

export async function fetchLogs({ startTime, endTime }) {
  let allLogs = [];
  let page = 1;
  let hasNext = true;

  try {
    while (hasNext) {
      let retry = false;

      try {
        const token = await getToken();
        const response = await client.get("/", {
          headers: {
            Authorization: `Token ${token}`,
            "Content-Type": "application/json",
          },
          params: {
            page,
            page_size: PAGE_SIZE,
            start_time: startTime,
            end_time: endTime,
          },
        });

        const res = response.data;

        colors.green(`Successfully Fetched ${res.data.length}`);

        const logs = res.data || [];

        const normalized = logs.map(normalizeLog);
        allLogs.push(...normalized);

        console.log(`Page ${page} fetched (${logs.length} logs)`);

        hasNext = !!res.next;
        if (hasNext) page++;
      } catch (err) {
        if (err.response?.status === 401) {
          console.warn("Session expired, re-authenticating...");

          clearToken();
          await login();

          retry = true;
        } else {
          throw err;
        }
      }

      if (retry) {
        const token = await getToken();

        const response = await client.get("", {
          headers: {
            Authorization: `Token ${token}`,
          },
          params: {
            page,
            page_size: PAGE_SIZE,
            start_time: startTime,
            end_time: endTime,
          },
        });

        const res = response.data;

        // if (res.code !== 0) {
        //   throw new Error(res.msg || "BioTime API error");
        // }
        const logs = res.data || [];

        const normalized = logs.map(normalizeLog);
        allLogs.push(...normalized);

        console.log(`Page ${page} fetched after re-auth (${logs.length} logs)`);

        hasNext = !!res.next;
        if (hasNext) page++;
      }
    }

    return allLogs;
  } catch (err) {
    console.error("BioTime fetch error:", err);
    throw err;
  }
}
function normalizeLog(log) {
  return {
    id: log.id,
    employeeId: log.emp_code,
    name: `${log.first_name || ""} ${log.last_name || ""}`.trim(),
    timestamp: log.punch_time,
    type: mapPunchState(log.punch_state),
    typeLabel: log.punch_state_display,
    deviceId: log.terminal_sn,
    deviceAlias: log.terminal_alias,
    uploadTime: log.upload_time,
    raw: log,
  };
}

function mapPunchState(state) {
  switch (state) {
    case "0":
      return "IN";
    case "1":
      return "OUT";
    default:
      return "UNKNOWN";
  }
}

export function deduplicateLogs(logs, windowSeconds = 30) {
  const result = [];

  // group by employee + device + type
  const grouped = {};

  for (const log of logs) {
    const key = `${log.employeeId}_${log.deviceId}_${log.type}`;

    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(log);
  }

  for (const key in grouped) {
    const group = grouped[key];

    // sort by timestamp
    group.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let lastAccepted = null;

    for (const log of group) {
      if (!lastAccepted) {
        result.push(log);
        lastAccepted = log;
        continue;
      }

      const diff = moment(log.timestamp).diff(
        moment(lastAccepted.timestamp),
        "seconds",
      );

      if (diff > windowSeconds) {
        result.push(log);
        lastAccepted = log;
      } else {
        // console.log(
        //   `Skipping duplicate log (${log.employeeId}) within ${diff}s`,
        // );
      }
    }
  }

  return result;
}
