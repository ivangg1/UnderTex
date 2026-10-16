# y-webrtc Signaling Server

Servidor de señalización WebRTC minimalista y ligero para el editor colaborativo P2P de LaTeX.

## Ejecución Local

```bash
npm install
npm start
```
El servidor escuchará por defecto en `http://localhost:4444` y `ws://localhost:4444`.

## Despliegue Gratuito en la Nube

### Render (Web Service)
1. Conecta tu repositorio de GitHub en [render.com](https://render.com).
2. Elige **Web Service** con **Docker** (Root Directory: `signaling-server`).
3. Render asignará una URL segura (`https://tu-signaling.onrender.com`).
4. Para la app de escritorio, usa: `wss://tu-signaling.onrender.com`.

### Railway / Fly.io
- **Railway:** Nuevo proyecto -> Deploy from GitHub repo -> Configura Root Directory como `/signaling-server`.
- **Fly.io:** En esta carpeta ejecuta `fly launch` y sigue las instrucciones interactivas.

### Configurar en la App
Crea un archivo `.env` en `latex-p2p-editor/` (o configura la variable de entorno al compilar):
```env
VITE_SIGNALING_SERVER=wss://tu-signaling.onrender.com
```
