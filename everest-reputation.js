// everest-reputation.js
// Logs in to Everest, switches to the DTC business unit, opens Reputation,
// and returns the JSON the page loads in the background.
// Can be used by app.js (require) or run directly: node everest-reputation.js
//
// TODO values: get the real ones with  npx playwright codegen <your Everest login URL>

const { chromium } = require("playwright");
const fs = require("fs");

const CFG = {
  loginUrl: "https://TODO_EVEREST_LOGIN_URL",
  userSel: "input[type=email]",          // TODO
  passSel: "input[type=password]",       // TODO
  submitSel: "button[type=submit]",      // TODO
  afterLoginUrl: "**/*",                 // TODO e.g. "**/dashboard**"

  buSwitcher: "TODO_BU_SWITCHER_TEXT_OR_SELECTOR", // dropdown showing current account/BU
  buName: "DTC",

  reportingNav: "Reporting",             // TODO menu text
  reputationNav: "Reputation",           // TODO tab/menu text
  apiMatch: (url) =>                     // TODO narrow after running with DEBUG=1
    url.includes("api.everest.validity.com") && url.toLowerCase().includes("reputation"),
};

const STATE_FILE = "everest-session.json"; // saved cookies

async function getReputation() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(
    fs.existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}
  );
  const page = await context.newPage();

  if (process.env.DEBUG) {
    page.on("response", (r) => {
      if (r.url().includes("api.everest.validity.com"))
        console.log(r.request().method(), r.status(), r.url());
    });
  }

  try {
    // 1. Login (skipped if saved session is still valid)
    await page.goto(CFG.loginUrl, { waitUntil: "networkidle" });
    if (await page.locator(CFG.passSel).count()) {
      await page.fill(CFG.userSel, process.env.EV_USER);
      await page.fill(CFG.passSel, process.env.EV_PASS);
      await page.click(CFG.submitSel);
      await page.waitForURL(CFG.afterLoginUrl);
      await page.waitForLoadState("networkidle");
      await context.storageState({ path: STATE_FILE });
    }

    // 2. Switch to DTC business unit
    await page.locator(CFG.buSwitcher).first().click();
    await page.getByText(CFG.buName, { exact: false }).first().click();
    await page.waitForLoadState("networkidle");

    // 3. Reporting -> Reputation (SPA: click, don't navigate by URL)
    await page.getByText(CFG.reportingNav, { exact: true }).first().click();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => CFG.apiMatch(r.url()) && r.status() === 200, {
        timeout: 30000,
      }),
      page.getByText(CFG.reputationNav, { exact: true }).first().click(),
    ]);

    return { source: resp.url(), data: await resp.json() };
  } catch (err) {
    await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { getReputation };

// Run directly: node everest-reputation.js
if (require.main === module) {
  require("dotenv").config();
  getReputation()
    .then((r) => {
      fs.writeFileSync("reputation.json", JSON.stringify(r, null, 2));
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error("Failed:", e.message);
      process.exit(1);
    });
}
