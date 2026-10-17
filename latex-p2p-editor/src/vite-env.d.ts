/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional custom y-webrtc signaling server (wss://…). */
  readonly VITE_SIGNALING_SERVER?: string;
}
