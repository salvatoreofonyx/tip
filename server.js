// Streamlabs → StreamElements tip bridge with THB → USD conversion
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const MODE = (process.env.MODE || 'socket').toLowerCase(); // 'socket' or 'webhook'
const PORT = process.env.PORT || 3000;

const SE_JWT = process.env.SE_JWT;  // From Render Environment Variables
const SE_CHANNEL_ID = process.env.SE_CHANNEL_ID; // From Render Environment Variables
const SL_SOCKET_TOKEN = process.env.SL_SOCKET_TOKEN; // From Render Environment Variables

if (!SE_JWT || !SE_CHANNEL_ID) {
  console.error('Missing SE_JWT or SE_CHANNEL_ID environment variables. Exiting.');
  process.exit(1);
}

const SE_TIPS_URL = `https://api.streamelements.com/kappa/v2/tips/${SE_CHANNEL_ID}`;
const app = express();
app.use(express.json());

/* ---- Currency Conversion Function ---- */
async function convertTHBtoUSD(amountTHB) {
  try {
    const res = await axios.get('https://api.exchangerate.host/latest?base=THB&symbols=USD');
    const rate = res.data.rates.USD || 0.03; // fallback ~0.03
    const converted = amountTHB * rate;
    console.log(`[FX] THB → USD rate: ${rate}, converted: ${converted.toFixed(2)}`);
    return converted;
  } catch (err) {
    console.error('[FX] Conversion failed, using fallback 0.03');
    return amountTHB * 0.03; // fallback
  }
}

/* ---- Forward donation to StreamElements ---- */
async function forwardToSE({ username='Anonymous', amount=0, currency='USD', message='' }) {
  try {
    const payload = { username, amount, currency, message, provider: 'streamlabs' };
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

/* ---- Streamlabs SOCKET Mode ---- */
if (MODE === 'socket') {
  if (!SL_SOCKET_TOKEN) {
    console.error('MODE=socket but SL_SOCKET_TOKEN missing. Exiting.');
    process.exit(1);
  }
  const io = require('socket.io-client');
  const socketUrl = `https://sockets.streamlabs.com?token=${SL_SOCKET_TOKEN}`;
  console.log('[SOCKET] connecting to', socketUrl);

  const socket = io(socketUrl, { transports: ['websocket'] });
  const seen = new Set();

  socket.on('connect', () => console.log('[SOCKET] connected'));
  socket.on('disconnect', () => console.log('[SOCKET] disconnected'));
  socket.on('connect_error', (err) => console.error('[SOCKET] connect_error', err.message));

  socket.on('event', async (evt) => {
    try {
      if (!evt || evt.type !== 'donation') return;
      const donations = Array.isArray(evt.message) ? evt.message : [evt.message];
      for (const d of donations) {
        const id = String(d.donation_id || d.id || `${d.name}-${Date.now()}`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);

        const username = d.name || 'Anonymous';
        const amountTHB = Number(d.amount || 0);
        const message = d.message || '';

        console.log(`[SOCKET] donation ${amountTHB} THB from ${username}`);

        // Convert THB → USD
        const amountUSD = await convertTHBtoUSD(amountTHB);

        await forwardToSE({ username, amount: amountUSD.toFixed(2), currency: 'USD', message });
      }
    } catch (e) {
      console.error('[SOCKET] handler error', e);
    }
  });
}

/* ---- Health route ---- */
app.get('/', (req, res) => res.send(`Tip bridge running. MODE=${MODE}`));
app.listen(PORT, () => console.log(`Server listening on ${PORT} (MODE=${MODE})`));
