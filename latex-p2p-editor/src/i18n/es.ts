import type { en } from "./en";

// Español.
export const es: Record<keyof typeof en, string> = {
  // ─── App / genérico ─────────────────────────────────────────────
  "app.name": "LaTeX P2P",
  "app.tagline": "Compilación local · Colaboración P2P",
  "action.close": "Cerrar",
  "action.copy": "Copiar",
  "action.copied": "¡Copiado!",
  "action.cancel": "Cancelar",
  "common.you": "Tú",
  "common.peer": "Peer {id}",

  // ─── Barra ──────────────────────────────────────────────────────
  "toolbar.open": "Abrir",
  "toolbar.open.tip": "Abrir una carpeta de proyecto LaTeX (⌘O / Ctrl+O)",
  "toolbar.join": "Unirse",
  "toolbar.join.tip": "Unirse a una sala P2P con el ID que te compartió un compañero",
  "toolbar.collaborate": "Colaborar",
  "toolbar.collaborate.tip": "Compartir este proyecto y habilitar edición P2P en tiempo real",
  "toolbar.room": "Sala",
  "toolbar.room.tip": "Sala, compañeros, conexión e invitación",
  "toolbar.manual": "Manual",
  "toolbar.manual.tip": "Compilar solo al pulsar Compilar o ⌘S",
  "toolbar.auto": "Auto",
  "toolbar.auto.tip": "Recompilar automáticamente poco después de dejar de escribir",
  "toolbar.compile": "Compilar",
  "toolbar.compile.tip": "Compilar LaTeX en local (⌘S / Ctrl+S)",
  "toolbar.compiling": "Compilando…",
  "toolbar.rootFile.tip": "Archivo raíz a compilar",
  "toolbar.rootFile.lockedTip": "El archivo raíz lo fija la sala (.texcollab/room.json)",
  "toolbar.language": "Idioma",
  "toolbar.profile.tip": "Tu nombre, color de cursor y ajustes de red",

  // ─── Modo / host ────────────────────────────────────────────────
  "mode.solo": "Individual",
  "mode.solo.tip": "Modo individual: guarda en disco localmente, sin tráfico de red",
  "mode.host": "Host",
  "mode.host.tip": "Eres el Host: el único peer que escribe en disco (cada 1,5 s).",
  "mode.guest": "Invitado",
  "mode.guest.tip": "Eres Invitado: sincronizado en memoria con el enjambre, sin escribir en disco.",

  // ─── Conexión ───────────────────────────────────────────────────
  "conn.disconnected": "Sin conexión",
  "conn.connecting": "Conectando…",
  "conn.unreachable": "Sin señalización",
  "conn.waiting": "Esperando compañeros",
  "conn.connected": "Conectado",
  "conn.unreachable.help":
    "No se pudo contactar ningún servidor de señalización. Revisa tu conexión o configura uno propio en Perfil (ver signaling-server/).",
  "conn.waiting.help": "Conectado a la señalización. Nadie más está en la sala todavía.",
  "conn.peersLine": "Peers WebRTC: {webrtc} · Ventanas locales: {bc}",
  "conn.synced": "Sincronizado: {value}",
  "conn.yes": "sí",
  "conn.no": "no",

  // ─── Guardado ───────────────────────────────────────────────────
  "save.guest": "Invitado",
  "save.guest.tip": "Los invitados sincronizan en memoria; el Host guarda en disco.",
  "save.saving": "Guardando…",
  "save.dirty": "Sin guardar",
  "save.dirty.tip": "Cambios pendientes (autoguardado en 1,5 s).",
  "save.error": "Error al guardar",
  "save.saved": "Guardado {time}",
  "save.saved.tip": "Último guardado: {time}",

  // ─── Compilador ─────────────────────────────────────────────────
  "compiler.missing": "Sin compilador",
  "compiler.hint.macos":
    "No se encontró ningún motor LaTeX. Instala Tectonic con `brew install tectonic` (recomendado) o MacTeX desde https://tug.org/mactex/ y reinicia la app.",
  "compiler.hint.windows":
    "No se encontró ningún motor LaTeX. Instala Tectonic (`winget install TectonicTypesetting.Tectonic`) o MiKTeX desde https://miktex.org/download y reinicia la app.",
  "compiler.hint.linux":
    "No se encontró ningún motor LaTeX. Instala Tectonic (`cargo install tectonic` o el paquete de tu distribución) o TeX Live (`sudo apt install texlive-latex-base`) y reinicia la app.",

  // ─── Unirse ─────────────────────────────────────────────────────
  "join.title": "Unirse a una sala",
  "join.help": "Pega el ID de sala. Elegirás una carpeta local donde se guarda el proyecto cuando seas el Host.",
  "join.placeholder": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "join.submit": "Elegir carpeta y unirse",

  // ─── Panel de colaboración ──────────────────────────────────────
  "collab.title": "Colaboración en vivo",
  "collab.roomId": "ID de sala",
  "collab.inviteButton": "Copiar mensaje de invitación",
  "collab.copyId": "Copiar ID",
  "collab.invite":
    "Invita a tu equipo: comparte la carpeta por tu nube (Drive, iCloud, OneDrive…) o envíales este ID para usar “Unirse”.",
  "collab.peers": "Compañeros ({count})",
  "collab.hostWrites": "Host · escribe en disco",
  "collab.guestRam": "Invitado · en memoria",
  "collab.connection": "Conexión",
  "collab.disconnect": "Desconectar y trabajar solo",
  "collab.disconnect.tip": "Cerrar WebRTC y volver al modo individual",

  // ─── Perfil ─────────────────────────────────────────────────────
  "profile.title": "Perfil de colaboración",
  "profile.name": "Tu nombre",
  "profile.name.placeholder": "Escribe tu nombre…",
  "profile.color": "Color del cursor",
  "profile.signaling": "Servidor de señalización propio (opcional)",
  "profile.signaling.help": "Se usa en la próxima conexión, antes que los servidores públicos.",
  "profile.newWindow": "Abrir otra ventana",
  "profile.newWindow.tip": "Abrir una segunda ventana para probar la colaboración en este equipo",

  // ─── Pantalla inicial ───────────────────────────────────────────
  "empty.title": "Escribe LaTeX. Compila en local. Colabora peer-to-peer.",
  "empty.subtitle": "Sin servidor, sin timeouts, sin suscripción.",
  "empty.step1.title": "Abre una carpeta",
  "empty.step1.body": "Vale cualquier carpeta: un proyecto existente o una vacía (se crea un main.tex por ti).",
  "empty.step2.title": "Compila con ⌘S",
  "empty.step2.body": "Tu CPU ejecuta tectonic o pdflatex. El PDF y la lista de errores aparecen a la derecha.",
  "empty.step3.title": "Colabora",
  "empty.step3.body": "Pulsa “Colaborar” y comparte la carpeta por tu nube o envía el ID de sala para “Unirse”.",
  "empty.open": "Abrir carpeta",
  "empty.join": "Unirse a una sala",
  "empty.compilerMissing": "No se encontró ningún motor LaTeX en este equipo.",

  // ─── Vista previa ───────────────────────────────────────────────
  "preview.zoomOut": "Alejar",
  "preview.zoomIn": "Acercar",
  "preview.fitWidth": "Ajustar al ancho",
  "preview.pages": "{count} páginas",
  "preview.page": "1 página",
  "preview.export": "Exportar PDF",
  "preview.export.tip": "Guardar el PDF compilado donde quieras",
  "preview.compiledWith": "{compiler} · {seconds} s",
  "preview.compiling": "Compilando en local…",
  "preview.fatal.title": "No se pudo compilar",
  "preview.error.title": "Error de compilación",
  "preview.error.body": "LaTeX no generó un PDF. Revisa los errores de abajo; haz clic en uno para ir a la línea.",
  "preview.idle.before": "Pulsa",
  "preview.idle.after": "o “Compilar” para ver el PDF",
  "preview.status.ok": "Compilado",
  "preview.status.error": "Error",
  "preview.status.errors": "{count} errores",
  "preview.status.error1": "1 error",
  "preview.status.warnings": "{count} avisos",
  "preview.status.warning1": "1 aviso",
  "preview.status.timeout": "Tiempo agotado",
  "preview.log": "Log",
  "preview.log.tip": "Mostrar la salida completa del compilador",
  "preview.jump": "Ir a la línea",

  // ─── Barra de estado ────────────────────────────────────────────
  "status.noProject": "Ningún proyecto abierto",
  "status.root": "Raíz",
  "status.room": "Sala {id}",

  // ─── Barra lateral ──────────────────────────────────────────────
  "rail.open": "Abrir",
  "rail.join": "Unirse",
  "rail.share": "Compartir",
  "rail.room": "Sala",
  "rail.build": "Compilar",
  "rail.auto": "Auto",
  "rail.export": "Exportar",
  "rail.you": "Tú",
  "rail.lang": "Idioma",
  "rail.auto.on": "Compilación automática activada: compila al dejar de escribir. Clic para pasar a manual.",
  "rail.auto.off": "Compilación automática desactivada: compila con Compilar o ⌘S. Clic para activarla.",
  "panel.close": "Cerrar panel",

  // ─── Bienvenida ─────────────────────────────────────────────────
  "welcome.start": "Empezar",
  "welcome.recent": "Recientes",
  "welcome.noRecent": "Los proyectos que abras aparecerán aquí.",
  "welcome.remove": "Quitar de la lista",
  "welcome.how": "Cómo funciona",
  "welcome.how1": "Abre cualquier carpeta. Se detecta el .tex raíz (o se crea un main.tex).",
  "welcome.how2": "Compilar ejecuta tectonic o pdflatex en tu equipo. Los errores enlazan a la línea.",
  "welcome.how3": "Compartir abre una sala P2P. Tu equipo se une por la carpeta en la nube o con el ID.",
  "welcome.shortcut.open": "⌘O",
  "welcome.shortcut.build": "⌘S",

  // ─── Barra superior ─────────────────────────────────────────────
  "topbar.lastBuild": "Última compilación",
  "topbar.autoOn": "auto",
  "topbar.manual": "manual",

  // ─── Errores ────────────────────────────────────────────────────
  "error.openProject": "No se pudo abrir el proyecto: {message}",
  "error.join": "No se pudo unir a la sala: {message}",
  "error.collab": "No se pudo iniciar la colaboración: {message}",
  "error.export": "No se pudo exportar el PDF: {message}",
};
