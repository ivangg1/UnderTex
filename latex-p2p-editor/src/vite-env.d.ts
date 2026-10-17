/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional custom y-webrtc signaling server (wss://…). */
  readonly VITE_SIGNALING_SERVER?: string;
  /** Optional TURN relay baked into the build: `turn:host:3478` (comma separated list allowed). */
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
}
