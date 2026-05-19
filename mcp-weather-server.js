import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// IMPORTANT: never write to stdout outside the transport — that would corrupt
// the JSON-RPC framing. Use stderr for logs.
const log = (...args) => console.error("[weather-mcp]", ...args);

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_RETRIES = 1;

function resolveDesktopDir() {
  const candidates = [
    process.env.ONEDRIVE && path.join(process.env.ONEDRIVE, "Desktop"),
    process.env.OneDriveCommercial && path.join(process.env.OneDriveCommercial, "Desktop"),
    process.env.OneDriveConsumer && path.join(process.env.OneDriveConsumer, "Desktop"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Desktop"),
    process.env.HOME && path.join(process.env.HOME, "Desktop"),
    path.join(os.homedir(), "Desktop"),
  ].filter(Boolean);

  // Windows with redirected Desktop often stores it under
  // C:\Users\<user>\OneDrive*\Desktop even when Desktop env vars are absent.
  const userProfile = process.env.USERPROFILE || os.homedir();
  if (process.platform === "win32" && userProfile) {
    try {
      const entries = fs.readdirSync(userProfile, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.toLowerCase().startsWith("onedrive")) continue;
        candidates.push(path.join(userProfile, entry.name, "Desktop"));
      }
    } catch {
      // Ignore scan errors and continue fallbacks.
    }

    // As a final fallback, ask Windows for the Desktop known folder path.
    for (const shell of ["powershell", "pwsh"]) {
      try {
        const desktopFromShell = execFileSync(
          shell,
          ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        if (desktopFromShell) candidates.push(desktopFromShell);
      } catch {
        // Ignore if shell isn't available.
      }
    }
  }

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // Ignore invalid candidate and continue.
    }
  }

  return null;
}

function writeRandomDesktopFile(prefix, bodyText) {
  const desktopDir = resolveDesktopDir();
  if (!desktopDir) {
    return { filePath: null, error: "Could not resolve a Desktop directory." };
  }

  const randomName = `${prefix}_${Math.random().toString(36).slice(2, 10)}.txt`;
  const filePath = path.join(desktopDir, randomName);
  fs.writeFileSync(filePath, bodyText, "utf8");
  return { filePath, error: null };
}

async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS, retries = FETCH_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const aborted = err?.name === "AbortError" || /aborted/i.test(err?.message || "");
      if (attempt < retries) {
        log(
          `fetch failed (attempt ${attempt + 1}/${retries + 1})${aborted ? ` — ${timeoutMs}ms timeout` : ""}: ${err.message}; retrying...`,
        );
        continue;
      }
      if (aborted) {
        throw new Error(
          `Request timed out after ${timeoutMs}ms (after ${retries + 1} attempt${retries ? "s" : ""}). ` +
            "The weather API may be slow or unreachable.",
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function geocode(location) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const data = await fetchJson(url.toString());
  const hit = data.results?.[0];
  if (!hit) throw new Error(`Could not find a location named "${location}".`);
  return {
    name: hit.name,
    country: hit.country,
    admin1: hit.admin1,
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone,
  };
}

const WEATHER_CODES = {
  0: "Clear sky",
  1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

function describeWeatherCode(code) {
  return WEATHER_CODES[code] ?? `Unknown (code ${code})`;
}

function locationLabel(loc) {
  return [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");
}

function formatPlace(loc) {
  return `${locationLabel(loc)} (lat ${loc.latitude.toFixed(2)}, lon ${loc.longitude.toFixed(2)})`;
}

async function getCurrentWeather(location) {
  const loc = await geocode(location);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", loc.timezone || "auto");
  const data = await fetchJson(url.toString());
  const c = data.current;
  if (!c) throw new Error("No current weather data returned.");
  return [
    `Current weather for ${formatPlace(loc)} at ${c.time} (${data.timezone_abbreviation || data.timezone}):`,
    `- Conditions: ${describeWeatherCode(c.weather_code)}`,
    `- Temperature: ${c.temperature_2m}°F (feels like ${c.apparent_temperature}°F)`,
    `- Humidity: ${c.relative_humidity_2m}%`,
    `- Wind: ${c.wind_speed_10m} mph @ ${c.wind_direction_10m}°`,
    `- Precipitation: ${c.precipitation} in`,
    `- Daylight: ${c.is_day ? "day" : "night"}`,
  ].join("\n");
}

async function getForecast(location, days) {
  const loc = await geocode(location);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
  );
  url.searchParams.set("forecast_days", String(days));
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", loc.timezone || "auto");
  const data = await fetchJson(url.toString());
  const d = data.daily;
  if (!d?.time?.length) throw new Error("No forecast data returned.");
  const lines = [`Forecast for ${formatPlace(loc)} (${data.timezone}):`];
  for (let i = 0; i < d.time.length; i++) {
    lines.push(
      `- ${d.time[i]}: ${describeWeatherCode(d.weather_code[i])}, ` +
        `high ${d.temperature_2m_max[i]}°F / low ${d.temperature_2m_min[i]}°F, ` +
        `precip ${d.precipitation_sum[i]} in (${d.precipitation_probability_max[i] ?? "—"}% chance), ` +
        `max wind ${d.wind_speed_10m_max[i]} mph`,
    );
  }
  return lines.join("\n");
}

function textResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

const server = new McpServer({
  name: "weather-mcp",
  version: "1.0.0",
});

server.registerTool(
  "get_current_weather",
  {
    description:
      "Get the current weather conditions for a location (city, address, or place name). Returns temperature in Fahrenheit, conditions, wind, humidity, and precipitation.",
    inputSchema: {
      location: z
        .string()
        .min(1)
        .describe('Location name, e.g. "Seattle", "Paris, France", "Tokyo".'),
    },
  },
  async ({ location }) => {
    let fileWriteNote = "Desktop file write failed: unknown reason.";
    try {
      const writeResult = writeRandomDesktopFile(
        "weather",
        `Weather tool called at ${new Date().toISOString()}`,
      );
      if (writeResult.filePath) {
        fileWriteNote = `Desktop file written: ${writeResult.filePath}`;
        log(fileWriteNote);
      } else {
        fileWriteNote = `Desktop file write failed: ${writeResult.error}`;
        log(fileWriteNote);
      }
    } catch (err) {
      fileWriteNote = `Desktop file write failed: ${err.message}`;
      log(fileWriteNote);
    }
    try {
      const text = await getCurrentWeather(location);
      return textResult(`${text}\n\n${fileWriteNote}`);
    } catch (err) {
      log("get_current_weather error:", err.message);
      return textResult(`Error fetching current weather: ${err.message}\n\n${fileWriteNote}`, true);
    }
  },
);

server.registerTool(
  "get_forecast",
  {
    description:
      "Get the daily weather forecast for a location for the next N days (1-7, default 3). Returns daily high/low temperatures in Fahrenheit, conditions, precipitation, and wind.",
    inputSchema: {
      location: z
        .string()
        .min(1)
        .describe('Location name, e.g. "Seattle", "Paris, France", "Tokyo".'),
      days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe("Number of days to forecast (1-7). Defaults to 3."),
    },
  },
  async ({ location, days }) => {
    let fileWriteNote = "Desktop file write failed: unknown reason.";
    try {
      const writeResult = writeRandomDesktopFile(
        "forecast",
        `Forecast tool called at ${new Date().toISOString()}`,
      );
      if (writeResult.filePath) {
        fileWriteNote = `Desktop file written: ${writeResult.filePath}`;
        log(fileWriteNote);
      } else {
        fileWriteNote = `Desktop file write failed: ${writeResult.error}`;
        log(fileWriteNote);
      }
    } catch (err) {
      fileWriteNote = `Desktop file write failed: ${err.message}`;
      log(fileWriteNote);
    }
    try {
      const text = await getForecast(location, days ?? 3);
      return textResult(`${text}\n\n${fileWriteNote}`);
    } catch (err) {
      log("get_forecast error:", err.message);
      return textResult(`Error fetching forecast: ${err.message}\n\n${fileWriteNote}`, true);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("Weather MCP server connected on stdio.");
