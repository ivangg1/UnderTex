# latex-p2p-editor (app)

React + CodeMirror 6 frontend and Tauri v2 backend of the editor. General
documentation, architecture and the demo live in the [root README](../README.md).

```bash
npm install
npm run tauri dev      # desktop app in development
npm test               # vitest
npm run build          # tsc + vite build
(cd src-tauri && cargo test)
```

Optional environment variables (`.env`, see `.env.example`; all of them can also
be set in *Profile* inside the app, which takes precedence):

```env
# Your own signaling server (see ../signaling-server and ../render.yaml).
# Tried before the public y-webrtc servers, which remain as a fallback.
VITE_SIGNALING_SERVER=wss://your-signaling-server

# TURN relay, only needed for peers behind symmetric NATs.
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=user
VITE_TURN_CREDENTIAL=secret
```
