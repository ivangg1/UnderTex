# y-webrtc Signaling Server

Servidor de señalización WebRTC minimalista (protocolo oficial de y-webrtc, un
solo archivo, sin base de datos) para el editor colaborativo P2P de LaTeX.

Solo sirve para que dos peers se **encuentren**: intercambia las ofertas SDP y
los candidatos ICE y luego el tráfico va directo entre equipos. Desde la app,
esos mensajes viajan **cifrados extremo a extremo** (y-webrtc `password`,
derivada del ID de sala), así que el servidor, el tuyo o uno público, solo ve
el nombre de la sala y blobs opacos.

Orden en que la app prueba servidores: el configurado en *Perfil* →
`VITE_SIGNALING_SERVER` → los públicos de y-webrtc (`y-webrtc-eu.fly.dev`,
`y-webrtc.fly.dev`), que son de terceros y solo un *fallback*. Despliega el tuyo
para no depender de ellos.

## Ejecución local

```bash
npm install
npm start
```

Escucha en `http://localhost:4444` / `ws://localhost:4444`. `GET /` responde
`200` (health check). En desarrollo (`npm run tauri dev`) la app ya lo prueba
automáticamente como `ws://127.0.0.1:4444`.

## Despliegue gratuito

### Render (un clic, con `render.yaml`)

El [`render.yaml`](../render.yaml) de la raíz del repo describe el servicio
(Docker, plan *free*, health check en `GET /`, redeploy solo cuando cambia
`signaling-server/`).

1. Sube tu fork a GitHub.
2. En [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
   → elige el repo y la rama. Render lee `render.yaml` y crea
   `latex-p2p-signaling`. Cambia `region` en el YAML si tus usuarios están lejos
   de Frankfurt.
3. Cuando termine el deploy, copia la URL (`https://latex-p2p-signaling-xxxx.onrender.com`)
   y úsala como `wss://latex-p2p-signaling-xxxx.onrender.com` en la app.

Sin Blueprint: **New → Web Service** → repo → *Root Directory* `signaling-server`,
*Runtime* Docker, *Health Check Path* `/`.

> Plan *free*: la instancia se duerme tras ~15 min sin tráfico y la primera
> conexión tarda 30-60 s en despertarla. y-webrtc reintenta solo, así que la
> sala termina conectando; la barra muestra *Conectando…* mientras tanto.

### Fly.io

[`fly.toml`](fly.toml) ya está configurado (puerto 4444, HTTPS forzado, health
check, *scale to zero*).

```bash
cd signaling-server
fly launch --copy-config --no-deploy   # elige nombre de app y región
fly deploy
```

La URL es `wss://<nombre-de-app>.fly.dev`.

### Railway / cualquier VPS

- **Railway:** New Project → Deploy from GitHub → *Root Directory* `/signaling-server`.
  Detecta el `Dockerfile`; expón el puerto que indique `PORT`.
- **VPS / Docker:** `docker build -t latex-signaling . && docker run -p 4444:4444 latex-signaling`
  detrás de un proxy con TLS (los clientes necesitan `wss://`).

## Configurar en la app

Dos opciones, ambas con la misma prioridad sobre los servidores públicos:

- **En tiempo de ejecución:** *Perfil → Servidor de señalización propio* (se
  guarda en el equipo; varios separados por comas).
- **En el build:** `.env` en `latex-p2p-editor/` (hay un `.env.example`):

  ```env
  VITE_SIGNALING_SERVER=wss://latex-p2p-signaling-xxxx.onrender.com
  ```

## STUN / TURN (NAT)

La señalización no basta cuando ambos peers están detrás de NAT **simétricos**
(algunas redes corporativas, 4G/5G): el STUN público de Google que la app usa
por defecto descubre la IP pública, pero el tráfico no puede atravesar y hace
falta un relay **TURN**. Configúralo en *Perfil → Relay TURN* (URL, usuario,
credencial) o en el build con `VITE_TURN_URL`, `VITE_TURN_USERNAME` y
`VITE_TURN_CREDENTIAL`. Opciones: [coturn](https://github.com/coturn/coturn) en
un VPS, o un proveedor gestionado (Metered, Twilio, Cloudflare Calls). El relay
solo transporta DTLS/SRTP cifrado; no puede leer el documento.
