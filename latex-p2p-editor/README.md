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

Optional environment variables (`.env`):

```env
VITE_SIGNALING_SERVER=wss://your-signaling-server
```
