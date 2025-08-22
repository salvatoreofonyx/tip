// Streamlabs → StreamElements Tip Forwarder with Currency Conversion (THB → USD)
// --------------------------------------------------
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const MODE = (process.env.MODE || 'socket').toLowerCase(); // 'socket' or 'webhook'
const PORT = process.env.PORT || 3000;

const SE_JWT = process.env.SE_JWT;
const SE_CHANNEL_ID = process.env.SE_CHANNEL_ID;
if (!SE_JWT || !SE_CHANNEL_ID) {
  console.error('Missing SE_JWT or SE_CHANNEL_ID environment variables. Exiting.');
  process.exit(1);
}

const SE_TIPS_URL = `https://api.streamelements.com/kappa/v2/tips/${SE_CHANNEL_ID}`;

// ---- CONFIG ----
const BASE_CURRENCY = 'USD';
const DEFAULT_RATE = 0.028; // fallback if API fails
const USE_LIVE_RATES = true; // enable live rate fetching
let thbToUsdRate = DEFAULT_RATE;

// ---- Fetch live exchange rate (THB → USD) ----
async function updateRates() {
  if (!USE_LIVE_RATES) return;
  try {
    const res = await axios.get('https://api.exchangerate.host/latest?base=THB&symbols=USD');
    thbToUsdRate = res.data.rates.USD || DEFAULT_RATE;
    console.log(`[RATE] Updated: 1 THB = ${thbToUsdRate} USD`);
  } catch (e) {
    console.error('[RATE] Error fetching live rates, using default', DEFAULT_RATE);
  }
}
if (USE_LIVE_RATES) {
  updateRates();
  setInterval(updateRates, 10 * 60 * 1000); // refresh every 10 min
}

// ---- Express app ----
const app = express();
app.use(express.json());

// ---- Forward to StreamElements ----
async function forwardToSE({ username='Anonymous', amount=0, currency='THB', message='' }) {
  try {
    let finalAmount = amount;
    let finalCurrency = currency;

    if (currency === 'THB') {
      finalAmount = parseFloat((amount * thbToUsdRate).toFixed(2));
      finalCurrency = BASE_CURRENCY;
    }

    const payload = {
      username,
      amount: finalAmount,
      currency: finalCurrency,
      message,
      provider: 'streamlabs'
    };

    const res = await axios.post(SE_TIPS_URL, payload, {
      headers: { Authorization: `Bearer ${SE_JWT}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    console.log(`[SE] forwarded ${amount} ${currency} → ${finalAmount} ${finalCurrency} from ${username}`);
    return res.data;
  } catch (err) {
    console.error('[SE] forward error:', err.response ? err.response.data : err.message);
    throw err;
  }
}

// ---- Webhook Mode ----
app.post('/webhook/streamlabs', async (req, res) => {
  try {
    console.log('[WEBHOOK] incoming body:', req.body);
    const body = req.body || {};
    const username = body.name || body.username || body.donor || 'Anonymous';
    const amount = Number(body.amount || body.data?.amount || body.donation?.amount || 0);
    const currency = (body.currency || body.data?.currency || 'THB').toUpperCase();
    const message = body.message || body.note || '';

    await forwardToSE({ username, amount, currency, message });
    res.status(200).send({ ok: true });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e.message || e) });
  }
});

// ---- Socket Mode ----
if (MODE === 'socket') {
  const io = require('socket.io-client');
  const SL_SOCKET_TOKEN = process.env.SL_SOCKET_TOKEN;
  if (!SL_SOCKET_TOKEN) {
    console.error('MODE=socket but SL_SOCKET_TOKEN missing. Exiting.');
    process.exit(1);
  }

  const socketUrl = `https://sockets.streamlabs.com?token=${SL_SOCKET_TOKEN}`;
  console.log('[SOCKET] connecting to', socketUrl);

  const socket = io(socketUrl, { transports: ['websocket'] });
  const seen = new Set();

  socket.on('connect', () => console.log('[SOCKET] connected'));
  socket.on('disconnect', () => console.log('[SOCKET] disconnected'));
  socket.on('connect_error', (err) => console.error('[SOCKET] connect_error', err && err.message));

  socket.on('event', async (evt) => {
    try {
      if (!evt || evt.type !== 'donation') return;

      const donations = Array.isArray(evt.message) ? evt.message : [evt.message];
      for (const d of donations) {
        const id = String(d.donation_id || d.id || `${d.name}-${d.amount}-${d.currency}-${Date.now()}`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);

        const username = d.name || d.display_name || d.username || 'Anonymous';
        const amount = Number(d.amount || d.amount_paid || 0);
        const currency = (d.currency || 'THB').toUpperCase();
        const message = d.message || d.note || '';

        console.log(`[SOCKET] donation ${amount} ${currency} from ${username}`);
        await forwardToSE({ username, amount, currency, message });
      }
    } catch (e) {
      console.error('[SOCKET] handler error', e);
    }
  });
}

// ---- Health Check ----
app.get('/', (req, res) => res.send(`Tip bridge running. MODE=${MODE}, Rate=${thbToUsdRate} USD`));
app.listen(PORT, () => console.log(`Server listening on ${PORT} (MODE=${MODE})`));
