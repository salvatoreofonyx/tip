// Streamlabs -> StreamElements tip bridge with currency conversion
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const MODE = (process.env.MODE || 'socket').toLowerCase(); // 'socket' or 'webhook'
const PORT = process.env.PORT || 3000;

const SE_JWT = process.env.SE_JWT; // StreamElements JWT
const SE_CHANNEL_ID = process.env.SE_CHANNEL_ID; // StreamElements channel ID
const SE_TIPS_URL = `https://api.streamelements.com/kappa/v2/tips/${SE_CHANNEL_ID}`;
const TARGET_CURRENCY = process.env.TARGET_CURRENCY || 'USD'; // target currency for conversion

if (!SE_JWT || !SE_CHANNEL_ID) {
  console.error('Missing SE_JWT or SE_CHANNEL_ID environment variables.');
  process.exit(1);
}

const app = express();
app.use(express.json());

/* --- Currency conversion helper --- */
async function convertCurrency(amount, from, to) {
  if (from === to) return amount; // no conversion needed
  try {
    const res = await axios.get('https://api.exchangerate.host/convert', {
      params: { from, to, amount }
    });
    return res.data.result || amount;
  } catch (err) {
    console.error('Currency conversion failed:', err.message);
    return amount; // fallback: return original amount
  }
}

/* --- Forward to StreamElements --- */
async function forwardToSE({ username='Anonymous', amount=0, currency='USD', message='' }) {
  try {
    const payload = {
      username,
      amount,
      currency,
      message,
      provider: 'streamlabs'
    };
    const res = await axios.post(SE_TIPS_URL, payload, {
      headers: { Authorization: `Bearer ${SE_JWT}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`[SE] forwarded ${amount} ${currency} from ${username} -> ${res.status}`);
    return res.data;
  } catch (err) {
    console.error('[SE] forward error:', err.response ? err.response.data : err.message);
    throw err;
  }
}

/* --- WEBHOOK mode --- */
app.post('/webhook/streamlabs', async (req, res) => {
  try {
    console.log('[WEBHOOK] incoming body:', req.body);
    const body = req.body || {};
    const username = body.name || 'Anonymous';
    const amount = Number(body.amount || 0);
    const currency = (body.currency || 'THB').toUpperCase();
    const message = body.message || '';

    const convertedAmount = await convertCurrency(amount, currency, TARGET_CURRENCY);
    await forwardToSE({ username, amount: convertedAmount, currency: TARGET_CURRENCY, message });
    res.status(200).send({ ok: true });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e.message || e) });
  }
});

/* --- SOCKET mode (Streamlabs socket) --- */
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
        const id = String(d.donation_id || d.id || `${d.name}-${d.amount}`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);

        const username = d.name || 'Anonymous';
        const amount = Number(d.amount || 0);
        const currency = (d.currency || 'THB').toUpperCase();
        const message = d.message || '';

        console.log(`[SOCKET] donation ${amount} ${currency} from ${username}`);

        const convertedAmount = await convertCurrency(amount, currency, TARGET_CURRENCY);
        await forwardToSE({ username, amount: convertedAmount, currency: TARGET_CURRENCY, message });
      }
    } catch (e) {
      console.error('[SOCKET] handler error', e);
    }
  });
}

app.get('/', (req, res) => res.send(`Tip bridge running. MODE=${MODE}`));
app.listen(PORT, () => console.log(`Server listening on ${PORT} (MODE=${MODE})`));
