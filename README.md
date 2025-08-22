# Tip Bridge (Streamlabs -> StreamElements)

Deploy to Render or Railway. Two modes:
- MODE=socket (recommended): set SL_SOCKET_TOKEN
- MODE=webhook : Streamlabs/TipMe posts to /webhook/streamlabs

Env vars:
- SE_JWT (StreamElements JWT)
- SE_CHANNEL_ID (StreamElements channel id)
- MODE (socket|webhook)
- SL_SOCKET_TOKEN (if MODE=socket)
- FORWARD_ONLY_THB (true/false)
