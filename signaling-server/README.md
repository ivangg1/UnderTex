# y-webrtc signaling server

Minimal, stateless WebRTC signaling server for the LaTeX P2P editor. It only
relays connection offers between peers; document content never passes through it.

## Run locally

```bash
npm install
npm start
```

The server listens on `http://localhost:4444` / `ws://localhost:4444` by default
(`PORT` overrides it).

## Free cloud deployment

### Render (Web Service)
1. Connect your GitHub repository at [render.com](https://render.com).
2. Choose **Web Service** with **Docker** (Root Directory: `signaling-server`).
3. Render assigns a secure URL (`https://your-signaling.onrender.com`).
4. In the desktop app use `wss://your-signaling.onrender.com`.

### Railway / Fly.io
- **Railway:** New project → Deploy from GitHub repo → set Root Directory to `/signaling-server`.
- **Fly.io:** run `fly launch` in this folder and follow the prompts.

## Configure the app

Create a `.env` file in `latex-p2p-editor/` (or set the variable when building):

```env
VITE_SIGNALING_SERVER=wss://your-signaling.onrender.com
```

Users can also set a server at runtime in *Profile → Custom signaling server*;
it is tried before the public y-webrtc servers, which remain as a fallback.
