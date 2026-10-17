# latex-p2p-editor (app)

Frontend React + CodeMirror 6 y backend Tauri v2 del editor. La documentación
general, la arquitectura y la demo están en el [README raíz](../README.md).

```bash
npm install
npm run tauri dev      # app de escritorio en desarrollo
npm test               # vitest
npm run build          # tsc + vite build
(cd src-tauri && cargo test)
```

Variables de entorno opcionales (`.env`, ver `.env.example`; todas se pueden
fijar también en *Perfil* dentro de la app, que tiene prioridad):

```env
# Servidor de señalización propio (ver ../signaling-server y ../render.yaml).
# Se prueba antes que los públicos de y-webrtc, que quedan como fallback.
VITE_SIGNALING_SERVER=wss://tu-servidor-de-senalizacion

# Relay TURN, solo necesario para peers detrás de NAT simétricos.
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=user
VITE_TURN_CREDENTIAL=secret
```
