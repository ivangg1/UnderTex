# y-webrtc signaling server

Minimal, stateless WebRTC signaling server (official y-webrtc protocol, a single
file, no database) for UnderTeX, the P2P LaTeX editor.

Its only job is to let peers **find each other**: it relays SDP offers and ICE
candidates, after which traffic flows directly between machines. From the app
those messages are **end-to-end encrypted** (y-webrtc `password`, derived from
the room id), so the server, yours or a public one, only sees the room name
and opaque blobs. Document content never passes through it.

Order in which the app tries servers: the one set in *Profile* →
`VITE_SIGNALING_SERVER` → the public y-webrtc ones (`y-webrtc-eu.fly.dev`,
`y-webrtc.fly.dev`), which are third-party and only a *fallback*. Deploy your
own to stop depending on them.

## Run locally

```bash
npm install
npm start
```

The server listens on `http://localhost:4444` / `ws://localhost:4444` by default
(`PORT` overrides it). `GET /` answers `200` (health check). In development
(`npm run tauri dev`) the app already tries `ws://127.0.0.1:4444` automatically.

## Free cloud deployment

### Render (one click, with `render.yaml`)

The [`render.yaml`](../render.yaml) at the repo root describes the service
(Docker, *free* plan, health check on `GET /`, redeploy only when
`signaling-server/` changes).

1. Push your fork to GitHub.
2. On [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
   → pick the repo and branch. Render reads `render.yaml` and creates
   `latex-p2p-signaling`. Change `region` in the YAML if your users are far
   from Frankfurt.
3. When the deploy finishes, copy the URL
   (`https://latex-p2p-signaling-xxxx.onrender.com`) and use it as
   `wss://latex-p2p-signaling-xxxx.onrender.com` in the app.

Without a Blueprint: **New → Web Service** → repo → *Root Directory*
`signaling-server`, *Runtime* Docker, *Health Check Path* `/`.

> *Free* plan: the instance sleeps after ~15 min without traffic and the first
> connection takes 30-60 s to wake it up. y-webrtc retries on its own, so the
> room eventually connects; the top bar shows *Connecting…* meanwhile.

### Fly.io

[`fly.toml`](fly.toml) is ready (port 4444, forced HTTPS, health check,
*scale to zero*).

```bash
cd signaling-server
fly launch --copy-config --no-deploy   # pick an app name and region
fly deploy
```

The URL is `wss://<app-name>.fly.dev`.

### Railway / any VPS

- **Railway:** New project → Deploy from GitHub repo → set Root Directory to
  `/signaling-server`. It detects the `Dockerfile`; expose the port given by
  `PORT`.
- **VPS / Docker:** `docker build -t latex-signaling . && docker run -p 4444:4444 latex-signaling`
  behind a TLS-terminating proxy (clients need `wss://`).

## Configure the app

Two options, both tried before the public servers:

- **At runtime:** *Profile → Custom signaling server* (stored on this machine;
  several separated by commas).
- **At build time:** `.env` in `latex-p2p-editor/` (there is a `.env.example`),
  or set the variable when building:

  ```env
  VITE_SIGNALING_SERVER=wss://latex-p2p-signaling-xxxx.onrender.com
  ```

## STUN / TURN (NAT traversal)

Signaling is not enough when both peers sit behind **symmetric** NATs (some
corporate networks, 4G/5G): the public Google STUN the app uses by default
discovers the public IP, but traffic cannot get through and a **TURN** relay is
required. Configure it in *Profile → TURN relay* (URL, username, credential)
or at build time with `VITE_TURN_URL`, `VITE_TURN_USERNAME` and
`VITE_TURN_CREDENTIAL`. Options: [coturn](https://github.com/coturn/coturn)
on a VPS, or a managed provider (Metered, Twilio, Cloudflare Calls). The relay
only carries encrypted DTLS/SRTP; it cannot read the document.
