// app.js - small Express server. SFMC (SSJS HTTP.Get) calls GET /reputation
// with header x-token. The server runs the Everest bot and returns JSON.
require("dotenv").config();
const express = require("express");
const { getReputation } = require("./everest-reputation");

const app = express();
const CACHE_MS = 15 * 60 * 1000; // reuse result for 15 min
let cache = null;   // { at, payload }
let running = null; // in-flight promise, so only one browser runs at a time

app.get("/health", (req, res) => res.send("ok"));

app.get("/reputation", async (req, res) => {
  if (req.get("x-token") !== process.env.APP_TOKEN) return res.status(401).json({ error: "unauthorized" });

  try {
    const fresh = cache && Date.now() - cache.at < CACHE_MS && req.query.refresh !== "1";
    if (fresh) return res.json({ cached: true, ...cache.payload });

    running = running || getReputation().finally(() => (running = null));
    const payload = await running;
    cache = { at: Date.now(), payload };
    res.json({ cached: false, ...payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
