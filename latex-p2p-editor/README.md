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

Variables de entorno opcionales (`.env`):

```env
VITE_SIGNALING_SERVER=wss://tu-servidor-de-senalizacion
```
