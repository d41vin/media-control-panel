// Shared message protocol between content scripts, the service worker and the
// side panel. Everything is plain JSON so it can cross extension messaging.

export type MediaKind = 'audio' | 'video';

export interface MediaElementState {
  /** Stable id within its frame, assigned by the content script. */
  id: string;
  kind: MediaKind;
  title: string | null;
  artist: string | null;
  artwork: string | null;
  /** Seconds; -1 when unknown. Live streams report live=true and duration -1. */
  duration: number;
  currentTime: number;
  playing: boolean;
  muted: boolean;
  /** 0..1 */
  volume: number;
  rate: number;
  live: boolean;
  ended: boolean;
}

export type MediaElementPatch = Partial<Omit<MediaElementState, 'id'>>;

export interface FrameSnapshot {
  frameUrl: string;
  elements: MediaElementState[];
}

export interface MediaSessionInfo {
  /** "tabId:frameId:elementId" */
  key: string;
  tabId: number;
  frameId: number;
  tabTitle: string;
  tabUrl: string;
  favIconUrl: string | null;
  element: MediaElementState;
}

export type MediaCommand =
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'toggle' }
  | { kind: 'seek-by'; seconds: number }
  | { kind: 'seek-to'; time: number }
  | { kind: 'set-volume'; volume: number }
  | { kind: 'set-muted'; muted: boolean }
  | { kind: 'set-rate'; rate: number };

/** Service worker -> content script (via tabs.sendMessage). */
export type ContentInbound =
  | { type: 'sync-request' }
  | { type: 'sleep' }
  | { type: 'command'; id: string; command: MediaCommand };

/** Content script -> service worker (via the media port). */
export type WorkerInbound =
  | { type: 'snapshot'; snapshot: FrameSnapshot }
  | { type: 'update'; id: string; patch: MediaElementPatch };

/** Panel -> service worker (via the panel port). */
export type PanelInbound =
  | { type: 'command'; key: string; command: MediaCommand }
  | { type: 'focus-tab'; tabId: number }
  | { type: 'pin'; key: string | null }
  | { type: 'pause-all' }
  | { type: 'mute-all'; muted: boolean }
  | { type: 'ping' };

/** Service worker -> panel (via the panel port). */
export type PanelOutbound =
  | { type: 'sessions'; sessions: MediaSessionInfo[] }
  | { type: 'patch'; key: string; patch: MediaElementPatch }
  | { type: 'pinned'; key: string | null }
  | { type: 'pong' };

export const MEDIA_PORT = 'media';
export const PANEL_PORT = 'panel';

/** Step used by the seek back/forward buttons (seconds). */
export const SEEK_STEP_SECONDS = 10;
