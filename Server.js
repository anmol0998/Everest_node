// Server.js
// 1. Sender Score for your IPs   -> Everest API (X-API-KEY, no browser needed)
// 2. Pristine spam traps (30d, first 50)   -> browser login + DTC BU switch, then the same
//                                   session calls the UI's own traps endpoint
// 3. Everything is returned as ONE object (and saved to everest-data.json)
//
// .env needs:
//   EV_USER, EV_PASS            Everest login
//   EV_API_KEY                  Everest API key
//   SENDER_IPS                  comma separated, e.g. 1.2.3.4,5.6.7.8
//   APP_TOKEN                   (only for the app.js server)
// Optional:
//   HEADLESS=0                  watch the browser
//   IGNORE_TLS=1                if your company proxy causes SELF_SIGNED_CERT errors

const { chromium, request } = require("playwright");
const fs = require("fs");

const CFG = {
  loginUrl: "https://everest.validity.com/login",
  userSel: "#email",
  passSel: "#password",
  submitSel: "#standardsignin",
  afterLoginUrl: "**/dashboards/**",

  buSelect: "#switchaccount",
  buValue: "1025648", // DTC BU 515008882
  buLabel: "DTC BU 515008882",

  // Paste the part of your traps URL between "includes=" and "&startdate"
  // (keep it exactly as it appears in the browser, still encoded)
  trapIncludes:
    "%7B%22type%22%3A%22trap%22%2C%22age%22%3A%22%3E%203%20years%22%2C%22trapType%22%3A%5B%22pristine%22%5D%7D",
  trapsBase: "https://everest.validity.com/reputation/iframedata/traps",
  pageSize: 50,
  daysBack: 29, // today - 29 days = 30 day window

  senderScoreBase: "https://api.everest.validity.com/api/2.0/reputation/senderscore",
};

const STATE_FILE = "everest-session.json";
const TLS = process.env.IGNORE_TLS === "1";
const DEBUG = !!process.env.DEBUG;

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d, time) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;

function dateWindow() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - CFG.daysBack);
  return { startdate: fmt(start, "00:00:00"), enddate: fmt(end, "23:59:00") };
}

function trapsUrl(win, start) {
  return (
    `${CFG.trapsBase}?includes=${CFG.trapIncludes}` +
    `&startdate=${encodeURIComponent(win.startdate)}` +
    `&enddate=${encodeURIComponent(win.enddate)}` +
    `&start=${start}&length=${CFG.pageSize}`
  );
}

// ---------- 1. Sender Score (API key) ----------
function pickScore(b) {
  return b?.score ?? b?.data?.score ?? b?.senderScore ?? b?.sender_score ?? null;
}

async function getSenderScores(ips) {
  const api = await request.newContext({
    extraHTTPHeaders: { "X-API-KEY": process.env.EV_API_KEY, Accept: "application/json" },
    ignoreHTTPSErrors: TLS,
  });
  const out = [];
  for (const ip of ips) {
    try {
      const r = await api.get(`${CFG.senderScoreBase}/${ip}`);
      const body = await r.json();
      out.push({ ip, score: pickScore(body), httpStatus: r.status(), raw: body });
    } catch (e) {
      out.push({ ip, score: null, error: e.message });
    }
  }
  await api.dispose();
  return out;
}

// ---------- 2. Pristine traps (browser session) ----------
async function getJson(context, url) {
  const r = await context.request.get(url, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Traps call did not return JSON (HTTP ${r.status()}). ` +
        `Session may have expired - delete everest-session.json and retry. ` +
        `Start of response: ${text.slice(0, 200)}`
    );
  }
}

// First 50 rows only (start=0, length=50) - no paging
async function fetchTraps(context, win) {
  const body = await getJson(context, trapsUrl(win, 0));
  if (DEBUG) console.log("Traps response keys:", Array.isArray(body) ? "[array]" : Object.keys(body));
  const rows = Array.isArray(body) ? body : body.data || body.rows || [];
  const total = body.recordsTotal ?? body.recordsFiltered ?? rows.length;
  return { total, rows: rows.slice(0, CFG.pageSize) };
}

async function loginAndSwitch(browser) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: TLS,
    ...(fs.existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}),
  });
  const page = await context.newPage();

  // login (skipped if saved session is valid)
  await page.goto(CFG.loginUrl, { waitUntil: "networkidle" });
  if (await page.locator(CFG.passSel).count()) {
    await page.fill(CFG.userSel, process.env.EV_USER);
    await page.fill(CFG.passSel, process.env.EV_PASS);
    await page.click(CFG.submitSel);
    await page.waitForURL(CFG.afterLoginUrl);
    await page.waitForLoadState("networkidle");
    await context.storageState({ path: STATE_FILE });
  }

  // switch to DTC BU (skip if already on it)
  await page.waitForSelector(CFG.buSelect, { state: "attached", timeout: 30000 });
  const current = await page.locator(CFG.buSelect).inputValue();
  console.log("Account before:", current);
  if (current !== CFG.buValue) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load", timeout: 30000 }),
      page.selectOption(CFG.buSelect, CFG.buValue).catch(() => {}), // reload interrupts the call
    ]);
    await page.waitForLoadState("networkidle");
  }
  const chosen = await page.locator(`${CFG.buSelect} option:checked`).innerText();
  console.log("Account now:", chosen.trim());
  if (!chosen.includes("515008882")) throw new Error(`Not on DTC BU, on: ${chosen.trim()}`);

  // open Monitoring > Reputation so the session is "on" that page
  const rep = page.getByRole("link", { name: "Reputation", exact: true }).first();
  if (!(await rep.isVisible())) await page.getByText("Monitoring", { exact: true }).first().click();
  await rep.click();
  await page.waitForLoadState("networkidle");

  return { context, page };
}

// ---------- 3. Build the final object ----------
async function getEverestData() {
  const ips = (process.env.SENDER_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ips.length) throw new Error("Set SENDER_IPS in .env, e.g. SENDER_IPS=1.2.3.4,5.6.7.8");
  if (!process.env.EV_API_KEY) throw new Error("Set EV_API_KEY in .env");

  const win = dateWindow();
  const senderScores = await getSenderScores(ips);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.HEADLESS !== "0",
  });
  let traps;
  try {
    const { context, page } = await loginAndSwitch(browser);
    try {
      traps = await fetchTraps(context, win);
    } catch (e) {
      await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
      throw e;
    }
  } finally {
    await browser.close();
  }

  // ONE object with everything SFMC needs
  return {
    generatedAt: new Date().toISOString(),
    businessUnit: CFG.buLabel,
    window: { start: win.startdate, end: win.enddate },
    senderScores: senderScores.map(({ ip, score, httpStatus, error }) => ({
      ip,
      score,
      httpStatus,
      error,
    })),
    pristineTraps: {
      total: traps.total,
      fetched: traps.rows.length,
      rows: traps.rows,
    },
    rawSenderScoreResponses: senderScores.map((s) => ({ ip: s.ip, raw: s.raw })), // remove once fields are confirmed
  };
}

module.exports = { getEverestData, getReputation: getEverestData };

// Run directly: node Server.js  (or npm run debug)
if (require.main === module) {
  require("dotenv").config();
  getEverestData()
    .then((d) => {
      fs.writeFileSync("everest-data.json", JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d, null, 2));
    })
    .catch((e) => {
      console.error("Failed:", e.message);
      process.exit(1);
    });
}
