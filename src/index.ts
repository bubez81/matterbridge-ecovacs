/**
 * matterbridge-ecovacs  v0.2.1
 *
 * 0.2.1: Evt errors no longer auto-clear after 60 s: they stay until the problem is resolved
 *   (mop pad reattached → WaterInfo.mopCount up; back on dock; ErrorCode 0; new Start; real cleaning).
 *   Evt 1131 (bumper stuck, T30 Omni 2026-10-04) → Stuck. Removed the operationCompletion event
 *   trigger: the event is not enabled on the endpoint, so it never fired and only logged an error.
 *
 * 0.2.0: ecovacs-deebot 1.0.0-alpha.23 (pure MQTT/JSON rewrite, Node >= 22.15, no canvas/XMPP deps).
 *   - Proactive token refresh: the login reports the token validity (~7 days); the plugin
 *     re-authenticates before expiry and hands the new token to the live MQTT session
 *     (updateUserAccessToken), so the robot never becomes unreachable. The "Not authorized"
 *     recovery of 0.1.88 stays as a safety net.
 *   - Device-auth login goes through the library's completeLogin() (tracks the expiry).
 *   - appVersion patch removed (the 1.0 library handles the current API itself).
 *   - ErrorCode 0/100 ("no error") logged at info level instead of warn.
 *
 * 0.1.90: detect the mop pad being reattached. The T30 reports the number of attached mop pads
 *   in WaterInfo.mopCount (observed 2026-10-04: 1 with a pad detached, 2 after reattaching),
 *   pushed as soon as it changes. ecovacs-deebot ignores the field: we read it and clear the
 *   mop-pad error as soon as the count goes up. (Evt 1007 is not sent by the T30.)
 *
 * 0.1.89: Evt codes known to ecovacs-deebot (library/eventCodes.json) are logged by name.
 *   Evt 1007 "Mop installed" clears the mop-pad error at once. Evt 1026 "Charging dock not
 *   found" → FailedToFindChargingDock, kept until the robot is back on the dock or cleans again
 *   (the problem persists, so the error must too). Unknown codes are still logged as warnings.
 *
 * 0.1.88: recover from an invalidated token. MQTT "Not authorized" (token rejected by the broker
 *   while REST still accepts it) now triggers a single-flight re-authentication through the same
 *   path used at startup (device-auth identity), refreshes the token cache and reconnects.
 *   Before, the MQTT client retried forever with the dead token (100 MB of log, robot unreachable).
 *   Plain disconnects no longer re-login with email/password (that bypassed device-auth).
 *   ErrorCode -1 (client/connection failure, not a robot error) is no longer surfaced.
 *
 * 0.1.87: while an error is active, operationalState = Error (Matterbridge wipes operationalError
 *   when the state leaves Error, so errors never reached Apple Home). Real cleaning (CleanReport
 *   Running) clears any error; a new Start clears a transient Evt error.
 *
 * 0.1.86: handle 'Evt' messages (unhandled by ecovacs-deebot). Evt 1128 = mop pad missing/detached:
 *   robot refuses to start → report MopCleaningPadMissing, drop the optimistic Running state.
 *   The error auto-clears after EVT_ERROR_CLEAR_MS (like the Ecovacs app), or earlier on a
 *   real cleaning start (CleanReport → Running) or ErrorCode 0/100. Other Evt codes are logged.
 *   Fix: ErrorCode arrives as a string — normalized to number ("0" was treated as a real error).
 *
 * 0.1.81–0.1.85: verified device identity (ecovacs-device-auth.json) to pass Ecovacs device
 *   verification (error 1013); token cache bound to deviceId and chmod 600; extended error map;
 *   hasActiveError / hasStartedCleaning guards; force-write Docked after registration.
 *
 * Complete rewrite following matterbridge-roomba / matterbridge-aeg-robot patterns.
 *
 * Key design principles:
 *  - updateAttribute() everywhere (has built-in deepEqual guard; never calls setStateOf for same value)
 *  - lastPushed dedup: our own layer on top, prevents redundant calls before they reach matter.js
 *  - 100 ms coalescing timer for operationalState (absorbs rapid transitions during stop/dock)
 *  - 1000 ms slow queue for ServiceArea.supportedAreas (rooms arrive over ~800 ms)
 *  - operationCompletion fires only when robot actually cleaned (hasStartedCleaning guard):
 *      wasActiveCleaning stays true through SeekingCharger (robot is still returning),
 *      only cleared on Charging|Docked|Stopped|Error
 *  - hasActiveError flag: error persists until ErrorCode 0/100 explicitly clears it.
 *    Without this, CleanReport: undefined (polling) resets cleanState → error clears 215ms
 *    after it fired, before Apple Home can show it.
 *  - Force-write Docked after registerDevice to clear stale persisted state from old versions
 *    (CleaningMop=68 was written by <0.1.79; now evicted on every restart so Apple Home
 *    never sees an unknown state in the initial subscription report)
 *  - NO CleaningMop (68) or EmptyingDustBin (67): Matter 1.4 states not supported by
 *    Apple Home HomePod firmware; map mop-wash/dry and auto-empty to chargeState instead
 *  - sentErrorId sentinel: never write operationalError at startup (avoids spurious notification
 *    from matter.js normalizing {errorStateId:0} vs internal default differently)
 */

import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint } from 'matterbridge';
import { AnsiLogger }                                         from 'matterbridge/logger';
import { RoboticVacuumCleaner }                              from 'matterbridge/devices';
import { RvcRunMode, RvcCleanMode, RvcOperationalState, PowerSource } from 'matterbridge/matter/clusters';
import type { PlatformConfig, PlatformMatterbridge }         from 'matterbridge';
import { createRequire }                                     from 'module';
import * as fs                                               from 'fs';
import * as path                                             from 'path';

const require = createRequire(import.meta.url);
const ecovacsDeebot = require('ecovacs-deebot') as Record<string, any>;
const nodeMachineId = require('node-machine-id') as Record<string, any>;
const EcoVacsAPI = ecovacsDeebot['EcoVacsAPI'];

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): EcovacsPlatform {
  return new EcovacsPlatform(matterbridge, log, config);
}

// ── Constants ──────────────────────────────────────────────────────────────────

const RUN   = { IDLE: 1, CLEANING: 2 } as const;
const CLEAN = { VACUUM: 1, MOP: 2, VACUUM_AND_MOP: 3, VACUUM_THEN_MOP: 4 } as const;
const OpState = RvcOperationalState.OperationalState;
// 'Evt' codes (sent by 950-type robots, ignored by ecovacs-deebot) that map to a Matter error.
// The error stays until the problem is resolved:
//  - clear 'pad':    mop pad reattached (WaterInfo.mopCount goes up)
//  - clear 'dock':   robot back on the dock
//  - clear 'action': no specific signal — cleared by the next Start (the robot re-sends the
//                    Evt if the problem persists)
// Every Evt error is also cleared by ErrorCode 0/100 and by a real cleaning start.
interface EvtErrorSpec { errId: number; clear: 'pad' | 'dock' | 'action'; }
const EVT_ERRORS: Record<number, EvtErrorSpec> = {
  // 1128 observed on T30 Omni 2026-10-04: mop pad detached, robot refuses to start (even vacuum-only)
  1128: { errId: RvcOperationalState.ErrorState.MopCleaningPadMissing,    clear: 'pad' },
  // 1131 observed on T30 Omni 2026-10-04: bumper stuck (app: "Il paracolpi è bloccato")
  1131: { errId: RvcOperationalState.ErrorState.Stuck,                    clear: 'action' },
  // 1026 "Charging dock not found" (ecovacs-deebot eventCodes.json)
  1026: { errId: RvcOperationalState.ErrorState.FailedToFindChargingDock, clear: 'dock' },
};
// 1007 "Mop installed": resolves a pending mop-pad error immediately.
const EVT_MOP_INSTALLED = 1007;
// Proactive token refresh: renew this long before the expiry reported by the library.
const TOKEN_REFRESH_MARGIN_MS = 60 * 60_000;      // 1 h
const TOKEN_REFRESH_RETRY_MS  = 10 * 60_000;      // retry after a failed refresh
const TOKEN_DEFAULT_VALIDITY_MS = 7 * 24 * 3_600_000 * 0.99; // when the cache has no expiry

// Human-readable names for Evt codes, from the library's own table (absent in some versions).
let EVT_NAMES: Record<string, string> = {};
try {
  EVT_NAMES = (require('ecovacs-deebot/library/eventCodes.json') as { eventCodes?: Record<string, string> }).eventCodes ?? {};
} catch { /* table not available: codes are logged as numbers */ }
const RECONNECT_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];

// ── State-mapping helpers ──────────────────────────────────────────────────────

/**
 * Convert Ecovacs CleanReport value to RVC OperationalState.
 * CleaningMop (68) and EmptyingDustBin (67) are Matter 1.4 — NOT mapped here;
 * mop-wash/drying/auto-empty all return Stopped so chargeState wins in applyState.
 */
function cleanReportToOpState(v: string): number {
  switch (v) {
    case 'auto': case 'spot_area': case 'custom_area': case 'entrust':
    case 'freeClean': case 'qcClean': case 'spot': case 'area':
    case 'singlePoint': case 'move': case 'comeClean':
      return OpState.Running;
    case 'pause':
      return OpState.Paused;
    case 'returning': case 'goCharging':
      return OpState.SeekingCharger;
    default:
      // washing / drying / airdrying / idle / undefined → Stopped
      // chargeState (Charging or Docked) will be the resolved state in applyState
      return OpState.Stopped;
  }
}

function chargeStateToOpState(v: string): number {
  switch (v) {
    case 'charging': case 'slot_charging': return OpState.Charging;
    case 'returning': case 'going': case 'goCharging': return OpState.SeekingCharger;
    default: return OpState.Docked;
  }
}

/** Map Ecovacs error code to Matter RvcOperationalState ErrorState */
function ecovacsErrorToMatterError(code: number): number {
  const E = RvcOperationalState.ErrorState;
  switch (code) {
    case 0: case 100: return E.NoError;
    // Robot errors
    case 101:         return E.LowBattery;
    case 102:         return E.FailedToFindChargingDock;
    case 103: case 104: return E.NavigationSensorObscured;
    case 105: case 106: case 113: return E.Stuck;
    case 108: case 109: return E.BrushJammed;
    case 110:         return E.DustBinMissing;
    case 111:         return E.DustBinFull;
    case 114:         return E.DustBinFull;
    case 118:         return E.WaterTankEmpty;
    case 119:         return E.WaterTankLidOpen;
    case 120: case 121: case 125: case 126: return E.WaterTankMissing;
    case 128: case 129: return E.MopCleaningPadMissing;
    // Auto-empty station errors (T10 TURBO / OMNI)
    case 312:         return E.DustBinFull;    // station bag full
    case 313:         return E.DustBinMissing; // station bag missing
    // Water / dirty water (station or robot)
    case 75:          return E.DirtyWaterTankMissing;
    case 301:         return E.WaterTankEmpty;
    case 302: case 305: return E.DirtyWaterTankFull;
    case 303:         return E.WaterTankMissing;
    case 304:         return E.DirtyWaterTankMissing;
    default:          return E.UnableToCompleteOperation;
  }
}

function isActiveCleaning(s: number): boolean {
  return s === OpState.Running || s === OpState.Paused;
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface EcovacsVacuumInfo { did: string; nick: string; deviceName: string; resource?: string; class?: string; }
interface RoomConfig { id: string; name?: string; enabled?: boolean; }
/** Verified device identity saved in ~/.matterbridge/ecovacs-device-auth.json */
interface DeviceAuth { email: string; deviceId: string; uid: string; accessToken: string; }
interface EcovacsConfig extends PlatformConfig {
  email: string; password: string; countryCode: string;
  authDomain?: string; whiteList?: string[];
  pollingInterval?: number; rooms?: RoomConfig[];
}

// ── EcovacsDevice ─────────────────────────────────────────────────────────────

class EcovacsDevice {
  private vacbot: any = null;
  private endpoint: RoboticVacuumCleaner | null = null;

  // Dual-source state: cleanState from CleanReport, chargeState from ChargeState
  private cleanState:  number = OpState.Stopped;
  private chargeState: number = OpState.Docked;

  // Current error (used when cleanState === Error)
  private currentErrorId: number = RvcOperationalState.ErrorState.NoError;

  // -1 = never sent; >0 = error was sent; 0 = NoError sent after clearing error.
  // We NEVER write operationalError unless there is (or was) a real error.
  // Writing NoError at startup causes matter.js to send a spurious subscription
  // notification (internal struct normalization differs from cluster default).
  private sentErrorId: number = -1;

  // True while a real ErrorCode (>0) is active. Cleared only by ErrorCode 0/100.
  // Without this, CleanReport: undefined (polling, ~200ms after error) resets
  // cleanState → Stopped → applyError sees no error → clears it before Apple Home sees it.
  private hasActiveError = false;

  // True while the active error comes from an 'Evt' message (auto-clears after a timeout).
  private evtErrorActive = false;
  private evtErrorClear: 'pad' | 'dock' | 'action' = 'action';
  // Number of attached mop pads from WaterInfo.mopCount (-1 = unknown).
  private mopCount = -1;

  // Re-authentication callback injected by the platform (same path as startup login).
  reauth: (() => Promise<void>) | null = null;
  private authRecovering = false;
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private authAttempt = 0;

  // lastPushed: track the last value we actually sent to matter.js for each attribute.
  // updateAttribute() has its own deepEqual guard but we add this layer so we never
  // even call updateAttribute() with a value we've already sent — matches matterbridge-roomba.
  private lastPushed = {
    opState:     -1,   // RvcOperationalState.operationalState  (-1 = never sent)
    batPct:      -1,   // PowerSource.batPercentRemaining        (-1 = never sent)
    batCharge:   -1,   // PowerSource.batChargeState             (-1 = never sent)
    runMode:     -1,   // RvcRunMode.currentMode                 (-1 = never sent)
  };
  // supportedAreas is a JSON-serialized string for comparison
  private lastPushedAreas: string = '';

  // operationalState coalescing: 100 ms window absorbs rapid transitions
  // (Running → Paused → SeekingCharger during a stop command)
  private pendingOpState: number | null = null;
  private opStateTimer: ReturnType<typeof setTimeout> | null = null;

  // supportedAreas coalescing: 1000 ms window (rooms arrive over ~800 ms from robot)
  private pendingAreas: any[] | null = null;
  private areasTimer: ReturnType<typeof setTimeout> | null = null;

  // Tracks whether the last sent opState was Running or Paused.
  // SeekingCharger is intentionally excluded: the robot may send ChargeState: returning
  // at startup (before we ever cleaned), which would set this flag and cause
  // operationCompletion to fire spuriously when 'charging' arrives → "Avviso" in Apple Home.
  private wasActiveCleaning = false;

  // Set true when CleanReport fires with Running, reset when operationCompletion fires.
  // Guards operationCompletion: prevents it from firing at startup or on state transitions
  // that did not involve an actual cleaning cycle in this session.
  private hasStartedCleaning = false;

  // Room discovery
  private rooms: Map<string, string> = new Map();
  private roomsLoaded = false;
  private roomsExpected = 0;
  private matterIdToEcovacsId: Map<number, string> = new Map();
  private selectedAreaIds: string[] = [];

  // Connection management
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Clean mode selections
  private runMode:   number = RUN.IDLE;
  private cleanMode: number = CLEAN.VACUUM;

  onRoomsDiscovered?: (rooms: RoomConfig[]) => void;

  constructor(
    private readonly api: any,
    private readonly vacuum: EcovacsVacuumInfo,
    private readonly pollSec: number,
    private readonly log: AnsiLogger,
    private readonly roomsConfig: RoomConfig[] = [],
  ) {
    if (roomsConfig.length > 0) {
      // Pre-load rooms from config: skip GetMaps entirely and pre-set lastPushedAreas
      // so the first updateServiceAreas call sees no delta and makes no write.
      // This prevents the [] → [N rooms] transition that triggers Apple Home "Aggiornamento".
      this.roomsLoaded = true;
      const areas = this.buildAreasFromConfig();
      this.lastPushedAreas = JSON.stringify(areas);
    }
  }

  /** Build supportedAreas array from roomsConfig in stable, deterministic order. */
  buildAreasFromConfig(): any[] {
    return this.roomsConfig
      .filter(r => r.enabled !== false)
      .map(r => {
        const matterAreaId = (parseInt(r.id, 10) || 0) + 1;
        this.matterIdToEcovacsId.set(matterAreaId, r.id);
        return {
          areaId: matterAreaId,
          mapId: null,
          areaInfo: {
            locationInfo: { locationName: r.name?.trim() || r.id, floorNumber: 0, areaType: null },
            landmarkInfo: null,
          },
        };
      });
  }

  get name(): string { return this.vacuum.nick || this.vacuum.deviceName || this.vacuum.did; }

  bindEndpoint(ep: RoboticVacuumCleaner): void {
    this.endpoint = ep;
    // Reset lastPushed: new endpoint starts at default values, force full re-sync
    this.lastPushed = { opState: -1, batPct: -1, batCharge: -1, runMode: -1 };
    this.lastPushedAreas = '';
    this.sentErrorId = -1;
    this.hasActiveError = false;
    this.clearEvtError(false);
    this.wasActiveCleaning = false;
    this.hasStartedCleaning = false;
    // Re-populate areas cache from config after reset so first updateServiceAreas finds no delta
    if (this.roomsConfig.length > 0) {
      const areas = this.buildAreasFromConfig();
      this.lastPushedAreas = JSON.stringify(areas);
    }
    this.registerHandlers();
  }

  // ── Attribute writers ────────────────────────────────────────────────────────

  /**
   * Write operationalState to matter.js via updateAttribute (deepEqual built-in).
   * 100 ms coalescing absorbs rapid state transitions (multiple events within 100 ms
   * all collapse into a single write with the LAST value — "last write wins").
   * Also triggers operationCompletion event when cleaning ends.
   */
  private scheduleOpState(s: number): void {
    this.pendingOpState = s;
    if (this.opStateTimer) return; // timer already running; last-write-wins
    this.opStateTimer = setTimeout(async () => {
      this.opStateTimer = null;
      const val = this.pendingOpState!;
      this.pendingOpState = null;
      if (val === this.lastPushed.opState) return;
      const prevWasActive = this.wasActiveCleaning;
      const nowActive = val === OpState.Running || val === OpState.Paused;
      const nowDone = val === OpState.Charging || val === OpState.Docked;
      this.lastPushed.opState = val;
      // wasActiveCleaning: set true on Running/Paused; keep true on SeekingCharger
      // (robot is returning from cleaning, still "was active"); clear only on final states.
      // SeekingCharger at startup (before any cleaning) won't set it because it starts false
      // and we only SET it on Running/Paused, never on SeekingCharger alone.
      if (nowActive) this.wasActiveCleaning = true;
      else if (nowDone || val === OpState.Stopped || val === OpState.Error) this.wasActiveCleaning = false;
      const label = (RvcOperationalState.OperationalState as Record<number, string>)[val] ?? String(val);
      this.log.info(`[${this.name}] opState → ${label}`);
      await this.endpoint?.updateAttribute('RvcOperationalState', 'operationalState', val, this.log);
      // Trigger operationCompletion only when:
      //  - we were actively cleaning (Running or Paused) in this session, AND
      //  - robot has reached a final resting state (Charging or Docked), AND
      //  - hasStartedCleaning is set (guards against startup false-positives)
      if (prevWasActive && nowDone && this.hasStartedCleaning) {
        this.hasStartedCleaning = false;
        // operationCompletion is not enabled on the RvcOperationalState server of this endpoint:
        // triggerEvent always failed ("cluster rvcOperationalState not found"). Not emitted anymore.
        this.log.info(`[${this.name}] Cleaning cycle completed`);
      }
    }, 100);
  }

  /** Write operationalError only when strictly necessary (never at startup with NoError). */
  private applyError(): void {
    // Use hasActiveError (set/cleared by ErrorCode events) rather than cleanState===Error.
    // CleanReport: undefined arrives ~200ms after an error and would reset cleanState to
    // Stopped, clearing the error from Apple Home before the user sees it.
    const errId = this.hasActiveError
      ? this.currentErrorId
      : RvcOperationalState.ErrorState.NoError;

    if (errId > 0) {
      if (errId !== this.sentErrorId) {
        this.sentErrorId = errId;
        this.endpoint?.updateAttribute('RvcOperationalState', 'operationalError',
          { errorStateId: errId, errorStateLabel: undefined, errorStateDetails: undefined }, this.log);
      }
    } else if (this.sentErrorId > 0) {
      // Had a real error, now clearing it
      this.sentErrorId = 0;
      this.endpoint?.updateAttribute('RvcOperationalState', 'operationalError',
        { errorStateId: 0, errorStateLabel: undefined, errorStateDetails: undefined }, this.log);
    }
    // errId === 0 and sentErrorId ≤ 0: startup case — do nothing
  }

  private writeBattery(pct: number, charge: number): void {
    if (pct !== this.lastPushed.batPct) {
      this.lastPushed.batPct = pct;
      this.endpoint?.updateAttribute('PowerSource', 'batPercentRemaining', pct, this.log);
    }
    if (charge !== this.lastPushed.batCharge) {
      this.lastPushed.batCharge = charge;
      this.endpoint?.updateAttribute('PowerSource', 'batChargeState', charge, this.log);
    }
  }

  private writeRunMode(m: number): void {
    if (m === this.lastPushed.runMode) return;
    this.lastPushed.runMode = m;
    this.endpoint?.updateAttribute('RvcRunMode', 'currentMode', m, this.log);
  }

  /** Queue supportedAreas write with 1000 ms debounce (rooms arrive over ~800 ms). */
  private scheduleAreas(areas: any[]): void {
    this.pendingAreas = areas;
    if (this.areasTimer) return;
    this.areasTimer = setTimeout(async () => {
      this.areasTimer = null;
      const a = this.pendingAreas!;
      this.pendingAreas = null;
      const serialized = JSON.stringify(a);
      if (serialized === this.lastPushedAreas) return;
      this.lastPushedAreas = serialized;
      this.log.info(`[${this.name}] supportedAreas → ${a.length} rooms`);
      await this.endpoint?.updateAttribute('ServiceArea', 'supportedAreas', a, this.log);
    }, 1000);
  }

  // ── State resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve the final operationalState and push it + error state to matter.js.
   * CleanReport wins for Running / Paused / SeekingCharger.
   * ChargeState wins for everything else (including mop-wash, auto-empty, idle).
   * States 67 (EmptyingDustBin) and 68 (CleaningMop) are never emitted —
   * they are Matter 1.4 values that Apple Home HomePod doesn't recognize.
   */
  private applyState(): void {
    // While an error is active, operationalState MUST be Error: Matterbridge's RVC server
    // switches the state to Error when operationalError is set, and resets operationalError
    // to NoError as soon as the state leaves Error. Writing Charging/Docked right after the
    // error (as <=0.1.86 did) silently wiped it ~100 ms later — Apple Home never showed it.
    const resolved = this.hasActiveError
      ? OpState.Error
      : (isActiveCleaning(this.cleanState) || this.cleanState === OpState.SeekingCharger)
        ? this.cleanState
        : this.chargeState;
    this.applyError();
    this.scheduleOpState(resolved);
  }

  // ── Connection ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.shuttingDown) return;
    this.log.info(`[${this.name}] Connecting (attempt ${this.reconnectAttempt + 1})`);
    try { this.vacbot = this.api.getVacBotObj(this.vacuum); }
    catch (err) {
      this.log.error(`[${this.name}] getVacBotObj failed: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.hookEvt();
    this.hookWaterInfo();
    this.listenVacbotEvents();
    this.vacbot.connect();
    this.vacbot.on('ready', () => {
      this.log.info(`[${this.name}] Connected — refreshing state in 3 s`);
      this.reconnectAttempt = 0;
      setTimeout(() => {
        if (this.shuttingDown) return;
        this.vacbot?.run('GetBatteryState');
        this.vacbot?.run('GetChargeState');
        this.vacbot?.run('GetCleanState_V2');
        this.vacbot?.run('GetWaterInfo'); // baseline for mopCount (attached mop pads)
        if (!this.roomsLoaded) this.vacbot?.run('GetMaps');
        this.startPolling();
      }, 3000);
    });
    this.vacbot.on('Error', (msg: string) => {
      if (typeof msg === 'string' && msg.includes('Not authorized')) {
        // Token rejected by the MQTT broker: log once, then recover (no flood).
        if (!this.authRecovering)
          this.log.warn(`[${this.name}] MQTT not authorized — token invalid, re-authenticating`);
        this.handleAuthFailure();
        return;
      }
      this.log.warn(`[${this.name}] Vacbot error: ${msg}`);
      if (!msg || msg.includes('not reachable') || msg.includes('IndexSizeError') ||
          msg.includes('NoError') || msg.includes('source width is 0')) return;
      this.cleanState = OpState.Error;
      this.applyState();
    });
    this.vacbot.on('disconnect', () => {
      if (this.authRecovering) return; // closed on purpose; handleAuthFailure reconnects
      this.log.warn(`[${this.name}] Disconnected`);
      this.stopPolling();
      this.scheduleReconnect();
    });
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.stopPolling();
    if (this.authRetryTimer) { clearTimeout(this.authRetryTimer); this.authRetryTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.opStateTimer)   { clearTimeout(this.opStateTimer);   this.opStateTimer = null; }
    if (this.areasTimer)     { clearTimeout(this.areasTimer);      this.areasTimer = null; }
    try { if (this.vacbot) await this.vacbot.disconnectAsync(); } catch { /* ignore */ }
  }

  // ── Evt messages ─────────────────────────────────────────────────────────────

  /** ecovacs-deebot marks 'Evt' as unhandled and emits nothing: wrap its handler. */
  private hookEvt(): void {
    try {
      if (typeof this.vacbot?.handleEvt !== 'function') {
        this.log.warn(`[${this.name}] handleEvt not found — Evt messages will be ignored`);
        return;
      }
      const orig = this.vacbot.handleEvt.bind(this.vacbot);
      this.vacbot.handleEvt = (payload: any) => {
        try { this.onEvt(Number(payload?.code)); }
        catch (e) { this.log.warn(`[${this.name}] Evt handling failed: ${String(e)}`); }
        return orig(payload);
      };
    } catch (e) {
      this.log.warn(`[${this.name}] Could not hook Evt: ${String(e)}`);
    }
  }

  /** ecovacs-deebot ignores WaterInfo.mopCount (attached mop pads): wrap its handler. */
  private hookWaterInfo(): void {
    try {
      if (typeof this.vacbot?.handleWaterInfo !== 'function') return;
      const orig = this.vacbot.handleWaterInfo.bind(this.vacbot);
      this.vacbot.handleWaterInfo = (payload: any) => {
        try { this.onMopCount(Number(payload?.mopCount)); }
        catch (e) { this.log.warn(`[${this.name}] mopCount handling failed: ${String(e)}`); }
        return orig(payload);
      };
    } catch (e) {
      this.log.warn(`[${this.name}] Could not hook WaterInfo: ${String(e)}`);
    }
  }

  private onMopCount(count: number): void {
    if (!Number.isFinite(count) || count < 0) return;
    const prev = this.mopCount;
    this.mopCount = count;
    if (prev === count) return;
    this.log.info(`[${this.name}] Mop pads attached: ${count}${prev >= 0 ? ` (was ${prev})` : ''}`);
    // Pad reattached: the count went up, or (no baseline yet) it reports a full set (2 pads).
    const reattached = prev >= 0 ? count > prev : count >= 2;
    if (reattached && this.evtErrorActive &&
        this.currentErrorId === RvcOperationalState.ErrorState.MopCleaningPadMissing) {
      this.log.info(`[${this.name}] Mop pad error cleared (pad reattached)`);
      this.clearEvtError(true);
    }
  }

  private onEvt(code: number): void {
    const evtName = EVT_NAMES[String(code)];
    if (code === EVT_MOP_INSTALLED) {
      this.log.info(`[${this.name}] Evt ${code} (${evtName ?? 'Mop installed'})`);
      if (this.evtErrorActive && this.currentErrorId === RvcOperationalState.ErrorState.MopCleaningPadMissing) {
        this.log.info(`[${this.name}] Mop pad error cleared (mop installed)`);
        this.clearEvtError(true);
      }
      return;
    }
    const spec = EVT_ERRORS[code];
    if (!spec) {
      if (evtName) this.log.info(`[${this.name}] Evt ${code} (${evtName})`);
      else this.log.warn(`[${this.name}] Unhandled Evt code: ${code}`);
      return;
    }
    this.log.warn(`[${this.name}] Evt ${code}${evtName ? ` (${evtName})` : ''} → Matter error ${spec.errId}`);
    if (spec.errId === RvcOperationalState.ErrorState.MopCleaningPadMissing)
      this.vacbot?.run('GetWaterInfo'); // refresh mopCount baseline (pad detection)
    this.hasActiveError = true;
    this.evtErrorActive = true;
    this.evtErrorClear = spec.clear;
    this.currentErrorId = spec.errId;
    // The robot refused to start / cannot proceed: drop the optimistic Running state.
    if (isActiveCleaning(this.cleanState)) this.cleanState = OpState.Stopped;
    this.writeRunMode(RUN.IDLE);
    this.applyState();
  }

  /** Clear an Evt-originated error (no-op if the active error came from ErrorCode). */
  private clearEvtError(apply: boolean): void {
    if (!this.evtErrorActive) return;
    this.evtErrorActive = false;
    this.hasActiveError = false;
    this.currentErrorId = RvcOperationalState.ErrorState.NoError;
    if (apply) this.applyState();
  }

  // ── Auth recovery ────────────────────────────────────────────────────────────

  /** Hand a proactively refreshed token to the live MQTT session (no full reconnect). */
  applyRefreshedToken(token: string): void {
    if (this.shuttingDown || !this.vacbot) return;
    if (typeof this.vacbot.updateUserAccessToken === 'function') {
      this.log.info(`[${this.name}] Applying refreshed token to the MQTT session`);
      this.vacbot.updateUserAccessToken(token);
    } else {
      // Older library: reconnect so the new token is used.
      this.handleAuthFailure();
    }
  }

  /** Single-flight recovery from an invalid token: close MQTT, re-login, reconnect. */
  private async handleAuthFailure(): Promise<void> {
    if (this.authRecovering || this.shuttingDown) return;
    this.authRecovering = true;
    this.stopPolling();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // Stop the MQTT client's own retry loop with the dead token.
    try { if (this.vacbot) await this.vacbot.disconnectAsync(); } catch { /* ignore */ }
    try {
      if (!this.reauth) throw new Error('no reauth callback');
      await this.reauth();
      this.log.info(`[${this.name}] Re-authenticated — reconnecting`);
      this.authAttempt = 0;
      this.reconnectAttempt = 0;
      this.authRecovering = false;
      await this.connect();
    } catch (err) {
      const delay = RECONNECT_DELAYS[Math.min(this.authAttempt, RECONNECT_DELAYS.length - 1)];
      this.authAttempt++;
      this.log.error(`[${this.name}] Re-authentication failed (attempt ${this.authAttempt}): ${String(err)} — retrying in ${delay / 1000}s`);
      this.authRetryTimer = setTimeout(() => {
        this.authRetryTimer = null;
        this.authRecovering = false;
        this.handleAuthFailure();
      }, delay);
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // No re-login here: a network drop does not invalidate the token, and the old
      // api.connect(account, passwordHash) bypassed the device-auth identity.
      // If the token is really dead, MQTT reports "Not authorized" → handleAuthFailure().
      await this.connect();
    }, delay);
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  private listenVacbotEvents(): void {

    this.vacbot.on('CleanReport', (v: string) => {
      this.log.info(`[${this.name}] CleanReport: ${v}`);
      const s = cleanReportToOpState(v);
      this.cleanState = s;
      // Mark that actual cleaning happened in this session so operationCompletion
      // fires when the robot docks — but only if it really cleaned.
      if (s === OpState.Running) {
        this.hasStartedCleaning = true;
        // Robot really cleaning: any previous error (Evt or ErrorCode) is resolved.
        // Errors are now visible in Apple Home, so they must not outlive the problem.
        this.clearEvtError(false);
        this.hasActiveError = false;
        this.currentErrorId = RvcOperationalState.ErrorState.NoError;
      }
      this.applyState();
      this.writeRunMode(isActiveCleaning(s) ? RUN.CLEANING : RUN.IDLE);
    });

    this.vacbot.on('ChargeState', (v: string) => {
      this.log.info(`[${this.name}] ChargeState: ${v}`);
      const s = chargeStateToOpState(v);
      this.chargeState = s;
      // Back on the dock: a 'dock'-type Evt error (e.g. charging dock not found) is resolved.
      if ((s === OpState.Charging || s === OpState.Docked) && this.evtErrorActive && this.evtErrorClear === 'dock') {
        this.log.info(`[${this.name}] Evt error cleared (robot back on dock)`);
        this.clearEvtError(false);
      }
      // Reset cleanState to Stopped when charging starts (unless actively cleaning)
      if (s === OpState.Charging && !isActiveCleaning(this.cleanState)) {
        this.cleanState = OpState.Stopped;
        this.writeRunMode(RUN.IDLE);
      } else if (s === OpState.Docked && !isActiveCleaning(this.cleanState) && this.cleanState !== OpState.SeekingCharger) {
        this.cleanState = OpState.Stopped;
        this.writeRunMode(RUN.IDLE);
      }
      this.applyState();
      const chargeAttr = s === OpState.Charging ? PowerSource.BatChargeState.IsCharging : PowerSource.BatChargeState.IsNotCharging;
      if (chargeAttr !== this.lastPushed.batCharge) {
        this.lastPushed.batCharge = chargeAttr;
        this.endpoint?.updateAttribute('PowerSource', 'batChargeState', chargeAttr, this.log);
      }
    });

    this.vacbot.on('BatteryInfo', (level: number) => {
      const pct = Math.max(0, Math.min(200, Math.round(level) * 2));
      if (pct !== this.lastPushed.batPct) {
        this.lastPushed.batPct = pct;
        this.endpoint?.updateAttribute('PowerSource', 'batPercentRemaining', pct, this.log);
      }
    });

    this.vacbot.on('ErrorCode', (rawCode: string | number) => {
      // ecovacs-deebot emits the code as a string ("0"): normalize, or 0/100 never match.
      const code = Number(rawCode);
      // -1 is emitted by ecovacs-deebot for client/connection failures (e.g. MQTT not
      // authorized), not by the robot: never surface it as a robot error in Apple Home.
      if (code === -1 || Number.isNaN(code)) return;
      if (code === 0 || code === 100) {
        this.log.info(`[${this.name}] ErrorCode: ${code} (no error)`);
        this.clearEvtError(false);
        this.hasActiveError = false;
        this.currentErrorId = RvcOperationalState.ErrorState.NoError;
        this.applyState();
        return;
      }
      this.log.warn(`[${this.name}] ErrorCode: ${code}`);
      this.clearEvtError(false);
      this.hasActiveError = true;
      this.currentErrorId = ecovacsErrorToMatterError(code);
      this.cleanState = OpState.Error;
      this.applyState();
    });

    this.vacbot.on('Error', (description: string) => {
      if (typeof description === 'string' && description.includes('Not authorized'))
        return; // handled (once) by the auth-recovery handler in connect()
      this.log.warn(`[${this.name}] Robot error: ${description}`);
    });

    // MopWash and EmptyDustBin: the robot is at the dock.
    // chargeState (Charging or Docked) wins in applyState — no state change needed.
    // States 68 (CleaningMop) and 67 (EmptyingDustBin) are Matter 1.4, not supported by
    // Apple Home HomePod firmware. Sending them causes permanent "Aggiornamento".
    this.vacbot.on('MopWash', (v: string) => {
      this.log.info(`[${this.name}] MopWash: ${v} — robot at dock, chargeState wins`);
    });

    this.vacbot.on('EmptyDustBin', (v: string) => {
      this.log.info(`[${this.name}] EmptyDustBin: ${v} — robot at dock, chargeState wins`);
    });

    this.vacbot.on('StatusInfo', (v: unknown) => {
      this.log.debug(`[${this.name}] StatusInfo: ${JSON.stringify(v)}`);
    });

    // Room / map discovery
    this.vacbot.on('CurrentMapMID', (mapID: string) => {
      if (this.roomsLoaded) return;
      this.vacbot.run('GetSpotAreas', mapID);
    });

    this.vacbot.on('Maps', (maps: any) => {
      if (this.roomsLoaded) return;
      const list = Array.isArray(maps) ? maps : (maps?.mapData ?? []);
      const first = list[0];
      if (first) {
        const mapID = first.mapID ?? first.mapId;
        if (mapID) this.vacbot.run('GetSpotAreas', mapID);
      }
    });

    this.vacbot.on('MapSpotAreas', (areas: any) => {
      if (this.roomsLoaded) return;
      const mapID = areas?.mapID ?? areas?.mapId;
      const list: any[] = Array.isArray(areas) ? areas : (areas?.mapSpotAreas ?? []);
      if (mapID && list.length > 0) {
        this.roomsExpected = list.length;
        for (const area of list) {
          const id = area?.mapSpotAreaID ?? area?.spotAreaID ?? area?.id;
          if (id !== undefined) this.vacbot.run('GetSpotAreaInfo', mapID, id);
        }
      }
    });

    this.vacbot.on('MapSpotAreaInfo', (info: any) => {
      const id = String(info?.mapSpotAreaID ?? info?.spotAreaID ?? info?.id ?? '');
      const name = info?.customName || info?.mapSpotAreaName || info?.name || `Area ${id}`;
      if (id) {
        this.rooms.set(id, name);
        this.updateServiceAreas();
      }
    });
  }

  private updateServiceAreas(): void {
    if (!this.endpoint || this.rooms.size === 0) return;
    const firstDiscovery = !this.roomsLoaded;
    if (this.roomsExpected === 0 || this.rooms.size >= this.roomsExpected) this.roomsLoaded = true;

    if (firstDiscovery && this.roomsLoaded && this.roomsConfig.length === 0 && this.onRoomsDiscovered) {
      const disc = Array.from(this.rooms.entries()).map(([id, name]) => ({ id, name, enabled: true }));
      this.onRoomsDiscovered(disc);
      this.onRoomsDiscovered = undefined;
    }

    // Iterate in roomsConfig order for stable JSON that matches lastPushedAreas
    let entries: [string, string][];
    if (this.roomsConfig.length > 0) {
      entries = this.roomsConfig
        .filter(r => r.enabled !== false && this.rooms.has(r.id))
        .map(r => [r.id, r.name?.trim() || this.rooms.get(r.id) || r.id] as [string, string]);
    } else {
      entries = Array.from(this.rooms.entries());
    }

    this.matterIdToEcovacsId.clear();
    const areas = entries.map(([ecoId, name]) => {
      const matterAreaId = (parseInt(ecoId, 10) || 0) + 1;
      this.matterIdToEcovacsId.set(matterAreaId, ecoId);
      return {
        areaId: matterAreaId,
        mapId: null,
        areaInfo: {
          locationInfo: { locationName: name, floorNumber: 0, areaType: null },
          landmarkInfo: null,
        },
      };
    });

    this.scheduleAreas(areas);
  }

  // ── Command handlers ─────────────────────────────────────────────────────────

  private registerHandlers(): void {
    if (!this.endpoint) return;

    this.endpoint.addCommandHandler('RvcCleanMode.changeToMode', async (data: any) => {
      const m = data.request?.newMode ?? data.request;
      this.log.info(`[${this.name}] cleanMode → ${m}`);
      this.cleanMode = m;
    });

    this.endpoint.addCommandHandler('ServiceArea.selectAreas', async (data: any) => {
      const matterIds: number[] = data.request?.newAreas ?? data.request?.selectedAreas ?? [];
      this.selectedAreaIds = matterIds
        .map((id: number) => this.matterIdToEcovacsId.get(id))
        .filter((id): id is string => id !== undefined);
      this.log.info(`[${this.name}] selectAreas: matter=${JSON.stringify(matterIds)} → ecovacs=${JSON.stringify(this.selectedAreaIds)}`);
      // iOS sends [] to mean "all rooms". Mirror back the full list so Apple Home
      // doesn't store an empty selectedAreas (matterbridge-roomba iOS workaround).
      const mirrorIds = matterIds.length === 0
        ? Array.from(this.matterIdToEcovacsId.keys())
        : matterIds;
      setTimeout(async () => {
        await this.endpoint?.updateAttribute('ServiceArea', 'selectedAreas', mirrorIds, this.log);
      }, 200);
    });

    this.endpoint.addCommandHandler('RvcRunMode.changeToMode', async (data: any) => {
      const m = data.request?.newMode ?? data.request;
      this.log.info(`[${this.name}] runMode → ${m}`);
      if (m === RUN.CLEANING) {
        await this.cmdStart();
      } else {
        this.vacbot?.run('Stop');
        this.cleanState = OpState.Stopped;
        this.applyState();
        this.writeRunMode(RUN.IDLE);
      }
    });

    this.endpoint.addCommandHandler('RvcOperationalState.pause', async () => {
      this.vacbot?.run('Pause');
      this.cleanState = OpState.Paused;
      this.applyState();
    });

    this.endpoint.addCommandHandler('RvcOperationalState.resume', async () => {
      this.vacbot?.run('Resume');
      this.cleanState = OpState.Running;
      this.applyState();
    });

    this.endpoint.addCommandHandler('RvcOperationalState.goHome', async () => {
      this.vacbot?.run('Stop');
      await new Promise(r => setTimeout(r, 500));
      this.vacbot?.run('Charge');
      this.cleanState = OpState.SeekingCharger;
      this.applyState();
    });
  }

  private async cmdStart(): Promise<void> {
    this.log.info(`[${this.name}] Start — cleanMode=${this.cleanMode} areas=${JSON.stringify(this.selectedAreaIds)} totalRooms=${this.matterIdToEcovacsId.size}`);
    // New attempt: drop a transient Evt error (if the cause persists, the robot re-sends it).
    this.clearEvtError(false);
    const workMode = this.cleanMode === CLEAN.VACUUM ? 1
      : this.cleanMode === CLEAN.MOP ? 2
      : this.cleanMode === CLEAN.VACUUM_THEN_MOP ? 3 : 0;
    this.vacbot?.run('SetWorkMode', workMode);

    const allSelected = this.selectedAreaIds.length === 0 || this.selectedAreaIds.length >= this.matterIdToEcovacsId.size;
    if (!allSelected) {
      const areaStr = this.selectedAreaIds.join(',');
      this.log.info(`[${this.name}] SpotArea_V2: "${areaStr}" workMode=${workMode}`);
      this.vacbot?.run('SpotArea_V2', areaStr, 1);
    } else {
      this.log.info(`[${this.name}] Full house clean workMode=${workMode}`);
      this.vacbot?.run('Clean');
    }

    this.cleanState = OpState.Running;
    this.applyState();
    this.writeRunMode(RUN.CLEANING);
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  private startPolling(): void {
    if (this.pollSec <= 0 || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.shuttingDown) return;
      this.vacbot?.run('GetBatteryState');
      this.vacbot?.run('GetChargeState');
      this.vacbot?.run('GetCleanState_V2');
    }, this.pollSec * 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}

// ── EcovacsPlatform ───────────────────────────────────────────────────────────

class EcovacsPlatform extends MatterbridgeDynamicPlatform {
  private devices: EcovacsDevice[] = [];
  private reauth: (reason?: string) => Promise<void> = async () => { throw new Error('not authenticated yet'); };
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    this.log.info('EcovacsPlatform: loaded');
  }

  async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart(${reason})`);
    const cfg = this.config as EcovacsConfig;
    this.log.info(`Authenticating: ${cfg.email} [${cfg.countryCode}]`);

    // Verified device identity (passes Ecovacs device verification, error 1013).
    const authFile = path.join(process.env.HOME ?? '', '.matterbridge', 'ecovacs-device-auth.json');
    let deviceAuth: DeviceAuth | null = null;
    try {
      const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      if (saved.email === cfg.email && saved.deviceId && saved.uid && saved.accessToken) {
        deviceAuth = saved;
        this.log.info(`Using verified Ecovacs device identity for ${cfg.email}`);
      }
    } catch { /* no verified device identity yet */ }

    const machineIdRaw = await nodeMachineId.machineId();
    const deviceId: string = deviceAuth?.deviceId ?? machineIdRaw.substring(0, 32); // server requires 32-char (MD5) device ID

    this.log.info(`ecovacs-deebot ${String(EcoVacsAPI.version?.() ?? 'unknown')}`);
    // 1.0 signature: (deviceId, country, continent = '', authDomain = '')
    const api = new EcoVacsAPI(deviceId, cfg.countryCode, '', cfg.authDomain ?? '');

    // Token cache: avoid re-authenticating on every restart (prevents rate limiting)
    const tokenFile = path.join(process.env.HOME ?? '', '.matterbridge', 'ecovacs-token.json');
    let tokenLoaded = false;
    try {
      const cached = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (cached?.uid && cached?.user_access_token && cached?.authCode &&
          cached?.email === cfg.email && cached?.deviceId === deviceId) {
        api.uid = cached.uid;
        api.user_access_token = cached.user_access_token;
        api.authCode = cached.authCode;
        api.resource = cached.resource;
        api.tokenExpiresAt = Number(cached.expiresAt) ||
          (Date.parse(cached.savedAt) + TOKEN_DEFAULT_VALIDITY_MS) || null;
        this.log.info(`Using cached auth token for ${cfg.email} (saved ${cached.savedAt})`);
        tokenLoaded = true;
      }
    } catch { /* no cache yet */ }

    const saveToken = () => {
      try {
        fs.writeFileSync(tokenFile, JSON.stringify({
          uid: api.uid, user_access_token: api.user_access_token,
          authCode: api.authCode, resource: api.resource,
          email: cfg.email, deviceId, savedAt: new Date().toISOString(),
          expiresAt: api.tokenExpiresAt ?? null,
        }), 'utf8');
        fs.chmodSync(tokenFile, 0o600);
        this.log.info('Auth token cached');
      } catch { /* ignore */ }
    };

    // Proactive refresh: renew before expiry, then hand the new token to every device.
    const scheduleRefresh = (): void => {
      if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
      const exp = Number(api.tokenExpiresAt) || 0;
      if (!exp) { this.log.warn('Token expiry unknown — proactive refresh disabled'); return; }
      const delay = Math.min(Math.max(exp - Date.now() - TOKEN_REFRESH_MARGIN_MS, 60_000), 2_000_000_000);
      this.log.info(`Token valid until ${new Date(exp).toISOString()} — proactive refresh in ${(delay / 3_600_000).toFixed(1)} h`);
      this.refreshTimer = setTimeout(async () => {
        this.refreshTimer = null;
        try {
          await this.reauth('proactive refresh'); // re-login + saveToken() + scheduleRefresh()
          for (const d of this.devices) d.applyRefreshedToken(api.user_access_token);
        } catch (err) {
          this.log.error(`Proactive token refresh failed: ${String(err)} — retrying in ${TOKEN_REFRESH_RETRY_MS / 60_000} min`);
          api.tokenExpiresAt = Date.now() + TOKEN_REFRESH_MARGIN_MS + TOKEN_REFRESH_RETRY_MS;
          scheduleRefresh();
        }
      }, delay);
    };

    const authenticate = async (): Promise<void> => {
      if (!deviceAuth) {
        await api.connect(cfg.email, EcoVacsAPI.md5(cfg.password));
        return;
      }
      api.uid = deviceAuth.uid;
      if (typeof api.completeLogin === 'function') {
        // getAuthCode + loginByItToken, and tracks the token expiry (tokenExpiresAt)
        await api.completeLogin(deviceAuth.accessToken);
        return;
      }
      const authResult = await api.callUserAuthApi('user/getAuthCode', {
        uid: deviceAuth.uid,
        accessToken: deviceAuth.accessToken,
      });
      api.authCode = authResult.authCode;
      const portalResult = await api.callUserApiLoginByItToken();
      api.user_access_token = portalResult.token;
      api.uid = portalResult.userId;
    };

    if (!tokenLoaded) {
      this.log.info(`Fresh authentication: ${cfg.email} [${cfg.countryCode}]`);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await authenticate();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const delay = attempt * 10_000;
          this.log.warn(`Auth failed (attempt ${attempt}/5): ${String(err)} — retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      if (lastErr) throw lastErr;
      saveToken();
    }

    // Shared, single-flight re-authentication for devices whose MQTT token gets rejected.
    let reauthInFlight: Promise<void> | null = null;
    this.reauth = (reason = 'token rejected') => {
      if (!reauthInFlight) {
        reauthInFlight = (async () => {
          const msg = `Re-authenticating with Ecovacs (${reason})…`;
          if (reason === 'token rejected') this.log.warn(msg); else this.log.info(msg);
          try { fs.unlinkSync(tokenFile); } catch { /* ignore */ }
          await authenticate();
          saveToken();
          scheduleRefresh();
        })().finally(() => { reauthInFlight = null; });
      }
      return reauthInFlight;
    };

    let devices: EcovacsVacuumInfo[];
    try {
      devices = await api.devices();
    } catch (err) {
      if (!tokenLoaded) throw err;
      this.log.warn(`Cached token expired — re-authenticating…`);
      await authenticate();
      saveToken();
      devices = await api.devices();
    }

    const filtered = cfg.whiteList?.length
      ? devices.filter(d => cfg.whiteList!.includes(d.did) || cfg.whiteList!.includes(d.nick))
      : devices;
    this.log.info(`Found ${filtered.length} Ecovacs device(s)`);
    scheduleRefresh();
    for (const vac of filtered) {
      await this.registerVacuum(api, vac, cfg.pollingInterval ?? 15, cfg.rooms ?? []);
    }
  }

  async onStop(reason?: string): Promise<void> {
    this.log.info(`onStop(${reason})`);
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    await Promise.all(this.devices.map(d => d.disconnect()));
    this.devices = [];
  }

  async onConfigure(): Promise<void> { this.log.info('onConfigure'); }

  private async registerVacuum(api: any, vac: EcovacsVacuumInfo, pollSec: number, roomsConfig: RoomConfig[]): Promise<void> {
    const name = vac.nick || vac.deviceName || vac.did;
    this.log.info(`Registering: "${name}" (${vac.did})`);

    const device = new EcovacsDevice(api, vac, pollSec, this.log, roomsConfig);
    device.reauth = () => this.reauth();

    if (roomsConfig.length === 0) {
      device.onRoomsDiscovered = (disc: RoomConfig[]) => {
        const updated = { ...this.config, rooms: disc } as EcovacsConfig;
        this.saveConfig(updated as unknown as PlatformConfig);
        this.wssSendSnackbarMessage(`✅ ${name}: ${disc.length} stanze scoperte — riavvia per applicare.`, 8000);
      };
    }

    // Pre-build areas from config so the endpoint is initialized with the correct list.
    // This prevents the [] → [N rooms] transition that triggers Apple Home "Aggiornamento".
    const initialAreas = device.buildAreasFromConfig();

    const endpoint = new RoboticVacuumCleaner(
      name, vac.did, 'server',
      RUN.IDLE,
      [
        { label: 'Idle',     mode: RUN.IDLE,     modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
        { label: 'Cleaning', mode: RUN.CLEANING, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
      ],
      CLEAN.VACUUM,
      [
        { label: 'Vacuum',          mode: CLEAN.VACUUM,          modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }] },
        { label: 'Mop',             mode: CLEAN.MOP,             modeTags: [{ value: RvcCleanMode.ModeTag.Mop }] },
        { label: 'Vacuum and Mop',  mode: CLEAN.VACUUM_AND_MOP,  modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: RvcCleanMode.ModeTag.Mop }] },
        { label: 'Vacuum then Mop', mode: CLEAN.VACUUM_THEN_MOP, modeTags: [{ value: RvcCleanMode.ModeTag.VacuumThenMop }] },
      ],
      null, null,          // currentPhase, phaseList
      OpState.Docked,
      [
        { operationalStateId: OpState.Stopped },
        { operationalStateId: OpState.Running },
        { operationalStateId: OpState.Paused },
        { operationalStateId: OpState.Error },
        { operationalStateId: OpState.SeekingCharger },
        { operationalStateId: OpState.Charging },
        { operationalStateId: OpState.Docked },
        // CleaningMop (68) and EmptyingDustBin (67) intentionally omitted:
        // Matter 1.4 states not supported by Apple Home HomePod firmware.
      ],
      initialAreas,
      [],                  // selectedAreas
      null,                // currentArea
      [],                  // supportedMaps
    );

    device.bindEndpoint(endpoint);
    this.devices.push(device);
    await this.registerDevice(endpoint as unknown as MatterbridgeEndpoint);
    // Force-write Docked immediately after the endpoint becomes active. This evicts any
    // stale operationalState persisted from old plugin versions (CleaningMop=68 from <0.1.79).
    // matter.js compares against its in-memory value: if persisted≠66 a subscription
    // notification is sent so Apple Home never sees an unknown state in the initial report.
    // setAttribute bypasses matterbridge's own deepEqual guard and always calls setStateOf.
    await endpoint.setAttribute('RvcOperationalState', 'operationalState', OpState.Docked, this.log);
    device.connect().catch((err: unknown) => this.log.error(`[${name}] connect failed: ${String(err)}`));
  }
}
