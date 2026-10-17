# LaTeX P2P Desktop Editor

Editor de escritorio **local-first** para LaTeX: compila en tu propia CPU (sin
timeouts de servidor) y colabora en tiempo real por **P2P (WebRTC + CRDT)** sin
pagar un servidor central. Pensado para quien usa Overleaf gratuito y sufre los
límites de compilación.

```
┌──────────────────────────┐      WebRTC (yjs + y-webrtc)      ┌──────────────────────────┐
│  Peer A  (Host 👑)        │ ◄──────────────────────────────► │  Peer B  (Invitado)       │
│  CodeMirror 6 ⇄ Y.Doc    │   señalización pública / propia   │  CodeMirror 6 ⇄ Y.Doc    │
│  tectonic (local)        │                                   │  tectonic (local)        │
│  escribe main.tex + CRDT │                                   │  solo RAM                │
└───────────┬──────────────┘                                   └──────────────────────────┘
            ▼
   carpeta local o en la nube (Drive / iCloud / OneDrive / Dropbox)
```

## Qué hace

- **Compilación 100 % local** con `tectonic` (recomendado) o `pdflatex`, dentro de
  una caché por proyecto en el directorio temporal del sistema: la carpeta del
  proyecto nunca se ensucia con `.aux`, `.log` ni PDFs, y los assets (figuras,
  `.sty`, `.bib`, capítulos) se copian de forma incremental.
- **Modo individual** por defecto: sin red, sin archivos ocultos, guardado
  atómico de tu `.tex`.
- **Colaboración P2P bajo demanda** (estilo Google Docs, con cursores en vivo):
  pulsa *Colaborar en vivo* y comparte la carpeta por la nube **o** el ID de sala
  (un compañero se une con *Unirse* sin carpeta compartida).
- **Elección dinámica de Host**: en una sala solo el peer con menor `clientID`
  escribe en disco (evita las *conflicted copies* de Drive/iCloud). Si el Host
  cae, el siguiente peer toma el relevo en milisegundos y consolida el estado.
- **Vista previa PDF** con pdf.js: conserva scroll y zoom entre compilaciones,
  renderizado perezoso por página, exportación del PDF.
- **Errores navegables**: la salida del compilador se parsea en una lista de
  errores/avisos; un clic lleva a la línea en el editor.
- **Raíz flexible**: no todo se llama `main.tex`. Se detecta el archivo raíz
  (`main.tex` → primer `.tex` con `\documentclass` → primer `.tex`) y se puede
  cambiar desde la barra; la sala recuerda cuál es.

## Instalación y ejecución

Requisitos: Node 22+, Rust estable, y un motor LaTeX en el sistema:

| SO      | Recomendado                             | Alternativa                     |
| ------- | --------------------------------------- | ------------------------------- |
| macOS   | `brew install tectonic`                 | MacTeX                          |
| Linux   | `cargo install tectonic` / paquete distro | TeX Live (`texlive-latex-base`) |
| Windows | `winget install TectonicTypesetting.Tectonic` | MiKTeX                   |

La app busca el motor en las rutas habituales (Homebrew, Cargo, MacTeX, TeX Live,
MiKTeX) aunque se lance desde Finder/Explorer con un PATH mínimo. Si no hay
ninguno, la barra lo indica en rojo con instrucciones para tu sistema.

```bash
cd latex-p2p-editor
npm install
npm run tauri dev        # desarrollo
npm run tauri build      # binario de producción
```

## Demo en 2 minutos

Hay un proyecto de ejemplo listo en [`examples/demo-project`](examples/demo-project)
(raíz `thesis.tex`, un capítulo incluido con `\input` y una figura).

1. **Abrir** → elige una carpeta (por ejemplo `examples/demo-project`, o una
   vacía). Se abre en modo *Individual*; con **Auto** activado el PDF aparece al
   dejar de escribir, y `⌘S`/`Ctrl+S` compila al instante.
2. Pulsa **Colaborar en vivo**. Se crea `.texcollab/room.json` con el ID de sala
   y la barra pasa a *Host · Conectado/Esperando compañeros*.
3. En otro equipo (o en *Perfil → Abrir otra ventana* en el mismo), pulsa
   **Unirse**, pega el ID y elige una carpeta local. Los cursores y el texto se
   sincronizan en vivo; el otro peer aparece como *Invitado*.
4. Cierra la ventana del Host: el Invitado pasa a Host y guarda en su carpeta.
5. **Desconectar y trabajar solo** (en el panel de la sala) vuelve al modo
   individual sin perder nada.

La interfaz sigue el esquema de un IDE: un **rail de acciones** a la izquierda
(Abrir, Unirse, Compartir/Sala, Compilar, Auto, Exportar, perfil e idioma), una
**barra superior** con el proyecto, el archivo raíz y el estado en vivo (modo,
conexión, guardado, compilador, última compilación) y, abajo del PDF, la lista
de errores. Paleta Monokai Pro. Está en **inglés y español** (se detecta el
idioma del sistema; se cambia desde el perfil). **Auto** compila al dejar de
escribir; desactivado, solo con Compilar o `⌘S`.

## Arquitectura

```
latex-p2p-editor/
├── src/
│   ├── components/
│   │   ├── Sidebar.tsx         # rail de acciones (abrir, unirse, compartir, compilar, auto, exportar) + panel lateral
│   │   ├── TopBar.tsx          # proyecto › raíz, modo, conexión, guardado, compilador, última compilación
│   │   ├── CollabPanel.tsx     # sala: ID, invitación, compañeros, diagnóstico de conexión
│   │   ├── JoinPanel.tsx       # unirse a una sala con un ID
│   │   ├── ProfilePanel.tsx    # nombre, color de cursor, idioma, servidor de señalización
│   │   ├── Welcome.tsx         # inicio: empezar, recientes, cómo funciona
│   │   ├── SplitPane.tsx       # divisor arrastrable editor | PDF
│   │   ├── LatexEditor.tsx     # CodeMirror 6 + y-codemirror.next (undo colaborativo), tema Monokai
│   │   └── PdfPreview.tsx      # visor pdf.js + lista de errores navegable
│   ├── i18n/                   # diccionarios en/es y hook useI18n
│   ├── services/
│   │   ├── collabManager.ts    # Y.Doc, WebrtcProvider, awareness, elección de Host, guardado
│   │   ├── crdtSeed.ts         # seed determinista del documento (evita texto duplicado)
│   │   ├── latexLog.ts         # parser de logs de tectonic / pdflatex
│   │   ├── recents.ts          # proyectos recientes (localStorage)
│   │   └── tauriBridge.ts      # wrappers tipados de invoke()
│   └── __tests__/              # vitest
├── src-tauri/src/
│   ├── lib.rs                  # comandos Tauri, cierre de ventana con flush
│   ├── project.rs              # raíz .tex, .texcollab/, guardado atómico
│   ├── compiler.rs             # detección de motor, caché de build, timeout
│   └── fsutil.rs               # write_atomic, validación de rutas
└── signaling-server/           # servidor de señalización y-webrtc opcional
```

### Decisiones clave

- **Seed determinista del CRDT** (`crdtSeed.ts`). Dos peers que inicializan
  su `Y.Doc` desde el mismo `main.tex` con un `clientID` aleatorio producen
  operaciones distintas y, al sincronizar, el texto aparece **duplicado**. El
  seed se hace con un `clientID` derivado del hash del texto: seeds idénticos
  generan operaciones idénticas que Yjs deduplica. Al unirse a una sala, además,
  el seed se pospone hasta la primera sincronización (o 4 s sin nadie) para
  adoptar el documento del enjambre en lugar de una copia local desactualizada.
- **Elección de Host robusta**. Cada peer publica su `peerId` de y-webrtc en
  awareness; cuando una conexión WebRTC se cierra se elimina su estado al
  instante (sin esperar el timeout de 30 s de awareness). Al ser promovido, el
  nuevo Host hace un *flush* inmediato. Un peer recién unido con `clientID` bajo
  **no escribe** hasta estar sincronizado, para no pisar `main.tex` con su copia
  vieja.
- **Guardado serializado e idempotente**. Nunca hay dos escrituras simultáneas
  de `main.tex`; un flag *dirty* evita reescrituras cuando nada cambió (menos
  subidas a la nube); el cierre de ventana y el cambio de proyecto hacen flush
  antes de destruir la sesión. En Rust, `write_atomic` escribe en un temporal
  oculto, hace `fsync` y renombra.
- **Pipeline de compilación**. Comando asíncrono (no bloquea la UI), caché por
  proyecto con manifiesto (copia solo lo que cambió, borra lo eliminado, conserva
  los intermedios del motor), timeout con kill del grupo de procesos, PDF
  devuelto como bytes binarios por IPC (no como array JSON).

### Limitaciones conocidas (honestas)

- **Particiones de red.** La elección de Host depende de que todos los peers se
  vean. Si el enjambre se parte en dos grupos, cada grupo elige su Host y, si
  comparten carpeta en la nube, ambos escribirán. Al reunirse, el CRDT fusiona
  en memoria sin pérdida y el Host vuelve a escribir el resultado; la nube puede
  dejar una *conflicted copy* que se puede borrar. No hay garantía de
  "cero conflictos" sin un servidor.
- **Señalización.** Los servidores públicos de y-webrtc son de terceros; si no
  responden, la barra lo indica (*Sin señalización*). Puedes configurar el tuyo
  en *Perfil* o con `VITE_SIGNALING_SERVER` (ver `signaling-server/`).
- **Un solo archivo editable.** Se compila el proyecto completo (`\input`,
  `.bib`, figuras) pero el editor solo abre el archivo raíz. El backend ya
  maneja rutas arbitrarias; abrir varios archivos es el siguiente paso.
- **Los tests de colaboración usan un `WebrtcProvider` simulado**: ejercitan el
  manager real (elección, failover, seed, guardado) con los eventos que emite
  y-webrtc, pero no sustituyen una prueba entre dos máquinas reales.

## Tests

```bash
cd latex-p2p-editor
npm test                 # vitest: CRDT seed, parser de logs, CollabManager, señalización, i18n
npm run build            # tsc + vite

cd src-tauri
cargo test               # proyecto, fsutil, compilador (los de compilación se omiten si no hay motor)
```
