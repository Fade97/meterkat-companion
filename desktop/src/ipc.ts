// The contract between the main process and the window. The renderer only ever sees these shapes:
// no relay credentials and no source key. The pairing QR carries the key, so it exists only while pairing.
import type { Snapshot } from "../../shared/snapshot.js";
import type { ProviderCheck } from "../../src/setup.js";
import type { BarMode } from "./format.js";
import type { IslandEvent } from "./island-events.js";
import type { HitArea, IslandAnchor } from "./island-shape.js";

export type { BarMode, HitArea, IslandAnchor, ProviderCheck, Snapshot };
/** "service": a CLI companion (systemd unit or Windows background process) already syncs; the app only shows its data. */
export type SyncMode = "app" | "service";
export type AppState = {
  version: string;
  platform: string;
  registration: { relay: string; protocol: 1 | 2 } | null;
  snapshot: Snapshot | null;
  sync: { mode: SyncMode; running: boolean; lastSuccess: number | null; error: string | null };
  autostart: { supported: boolean; app: boolean; service: boolean };
  /**
   * install "auto": this copy updates itself (AppImage, Windows installation); "manual": only the download page.
   * automatic: updates install without asking (shared with `meterkat update enable|disable`).
   * ready: version downloaded and verified, waiting for a restart.
   */
  update: { latest: string | null; newer: boolean; checkedAt: number | null; error: string | null; install: "auto" | "manual"; automatic: boolean; downloading: boolean; ready: string | null };
  /**
   * The drop at the top screen edge, or pinned to the top edge of the AI window (anchor "window");
   * `unsupported` says why it cannot run on this system.
   */
  island: { enabled: boolean; anchor: IslandAnchor; unsupported: string | null };
  /** Whether bars and percentages show the used share or what is left (window, island and tray). */
  bars: BarMode;
};
export type Pairing = { qr: string; expiresAt: number };
export type Device = { id: string; pairedAt: number };
export type View = "overview" | "phones" | "settings";
export type ExternalLink = "releases" | "terms" | "privacy" | "source" | "licenses";

export interface MeterkatApi {
  state(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  onNavigate(listener: (view: View) => void): () => void;
  detectProviders(): Promise<ProviderCheck[]>;
  /** null registers with the default (hosted) relay. */
  register(relay: string | null): Promise<void>;
  syncNow(): Promise<void>;
  startPairing(): Promise<Pairing>;
  stopPairing(): Promise<void>;
  devices(): Promise<Device[]>;
  revokeDevice(id: string): Promise<void>;
  /** Asks for confirmation in a native dialog; resolves false when cancelled. */
  revokeAll(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  setIsland(enabled: boolean): Promise<void>;
  setIslandAnchor(anchor: IslandAnchor): Promise<void>;
  setBarMode(mode: BarMode): Promise<void>;
  /** Removes the CLI autostart, stops its process and lets the app sync instead. */
  takeOver(): Promise<void>;
  checkUpdate(): Promise<void>;
  /** Downloads the newest release if needed and restarts into it. */
  installUpdate(): Promise<void>;
  setAutomaticUpdates(enabled: boolean): Promise<void>;
  open(link: ExternalLink): Promise<void>;
  hide(): void;
  quit(): void;
}

export const CHANNEL = {
  state: "meterkat:state", stateChanged: "meterkat:state-changed", navigate: "meterkat:navigate",
  detect: "meterkat:detect", register: "meterkat:register", sync: "meterkat:sync",
  startPairing: "meterkat:pair-start", stopPairing: "meterkat:pair-stop",
  devices: "meterkat:devices", revoke: "meterkat:revoke", revokeAll: "meterkat:revoke-all",
  autostart: "meterkat:autostart", island: "meterkat:island-enabled", islandAnchor: "meterkat:island-anchor", barMode: "meterkat:bar-mode", takeOver: "meterkat:take-over", checkUpdate: "meterkat:check-update",
  installUpdate: "meterkat:install-update", automaticUpdates: "meterkat:automatic-updates",
  open: "meterkat:open", hide: "meterkat:hide", quit: "meterkat:quit",
} as const;

// ---- Island window -------------------------------------------------------------------------------------------

/** Light background → ink drop with the sand mark; dark background → white drop with the ink mark. */
export type IslandTone = "ink" | "white";
/** An announcement on screen; `id` changes per announcement, `holdMs` is how long it stays open. */
export type IslandShown = IslandEvent & { id: number; holdMs: number };
/**
 * hover: the pointer is on the island, so it takes clicks. expanded: the panel with every provider is open; it
 * carries the snapshot, the only time the island page sees one.
 */
export type IslandUpdate = { visible: boolean; tone: IslandTone; event: IslandShown | null; now: number; mode: BarMode; hover: boolean; expanded: boolean; snapshot: Snapshot | null };
export interface IslandApi {
  onUpdate(listener: (update: IslandUpdate) => void): () => void;
  /** Where the island currently is, so the main process knows when the pointer is on it; null while hidden. */
  hitArea(area: HitArea | null): void;
  /** A click on the island: opens or closes the panel. */
  toggle(): void;
}
export const ISLAND_CHANNEL = "meterkat:island";
export const ISLAND_HIT_CHANNEL = "meterkat:island-hit";
export const ISLAND_TOGGLE_CHANNEL = "meterkat:island-toggle";
