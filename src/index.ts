/**
 * matterbridge-ecovacs  v0.1.80
 * Complete rewrite following matterbridge-roomba / matterbridge-aeg-robot patterns.
 *
 * Key design principles:
 *  - updateAttribute() everywhere (has built-in deepEqual guard; never calls setStateOf for same value)
 *  - lastPushed dedup: our own layer on top, prevents redundant calls before they reach matter.js
 *  - 100 ms coalescing timer for operationalState (absorbs rapid transitions during stop/dock)
 *  - 1000 ms slow queue for ServiceArea.supportedAreas (rooms arrive over ~800 ms)
 *  - operationCompletion event triggered when cleaning ends (Apple Home state refresh)
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
    case 101:         return E.LowBattery;
    case 103:         return E.NavigationSensorObscured;
    case 104:         return E.NavigationSensorObscured;
    case 105:         return E.Stuck;
    case 108: case 109: return E.BrushJammed;
    case 110:         return E.DustBinMissing;
    case 114:         return E.DustBinFull;
    case 120: case 125: case 126: return E.WaterTankMissing;
    case 128: case 129: return E.MopCleaningPadMissing;
    case 301:         return E.WaterTankEmpty;
    case 302: case 305: return E.DirtyWaterTankFull;
    case 303:         return E.WaterTankMissing;
    case 304: case 75: return E.DirtyWaterTankMissing;
    default:          return E.UnableToCompleteOperation;
  }
}

function isActiveCleaning(s: number): boolean {
  return s === OpState.Running || s === OpState.Paused;
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface EcovacsVacuumInfo { did: string; nick: string; deviceName: string; resource?: string; class?: string; }
interface RoomConfig { id: string; name?: string; enabled?: boolean; }
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

  // Tracks whether the last sent opState was "active" (Running/Paused/SeekingCharger)
  // Used to trigger operationCompletion when cleaning ends (Apple Home refresh)
  private wasActiveCleaning = false;

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
    this.wasActiveCleaning = false;
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
      const nowActive = val === OpState.Running || val === OpState.Paused || val === OpState.SeekingCharger;
      this.lastPushed.opState = val;
      this.wasActiveCleaning = nowActive;
      const label = (RvcOperationalState.OperationalState as Record<number, string>)[val] ?? String(val);
      this.log.info(`[${this.name}] opState → ${label}`);
      await this.endpoint?.updateAttribute('RvcOperationalState', 'operationalState', val, this.log);
      // Trigger operationCompletion when transitioning from active cleaning to idle/charging.
      // This forces Apple Home to refresh device state, clearing any "Aggiornamento" caused
      // by the rapid subscription notifications during the cleaning cycle.
      if (prevWasActive && !nowActive) {
        this.log.info(`[${this.name}] operationCompletion`);
        await this.endpoint?.triggerEvent('RvcOperationalState', 'operationCompletion', {
          completionErrorCode: 0,
          totalOperationalTime: null,
          pausedTime: null,
        }, this.log);
      }
    }, 100);
  }

  /** Write operationalError only when strictly necessary (never at startup with NoError). */
  private applyError(): void {
    const errId = this.cleanState === OpState.Error
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
    const resolved = (isActiveCleaning(this.cleanState) || this.cleanState === OpState.SeekingCharger)
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
        if (!this.roomsLoaded) this.vacbot?.run('GetMaps');
        this.startPolling();
      }, 3000);
    });
    this.vacbot.on('Error', (msg: string) => {
      this.log.warn(`[${this.name}] Vacbot error: ${msg}`);
      if (!msg || msg.includes('not reachable') || msg.includes('IndexSizeError') ||
          msg.includes('NoError') || msg.includes('source width is 0')) return;
      this.cleanState = OpState.Error;
      this.applyState();
    });
    this.vacbot.on('disconnect', () => {
      this.log.warn(`[${this.name}] Disconnected`);
      this.stopPolling();
      this.scheduleReconnect();
    });
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.stopPolling();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.opStateTimer)   { clearTimeout(this.opStateTimer);   this.opStateTimer = null; }
    if (this.areasTimer)     { clearTimeout(this.areasTimer);      this.areasTimer = null; }
    try { if (this.vacbot) await this.vacbot.disconnectAsync(); } catch { /* ignore */ }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.api.connect(this.api.accountId, this.api.passwordHash); } catch { /* carry on */ }
      await this.connect();
    }, delay);
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  private listenVacbotEvents(): void {

    this.vacbot.on('CleanReport', (v: string) => {
      this.log.info(`[${this.name}] CleanReport: ${v}`);
      const s = cleanReportToOpState(v);
      this.cleanState = s;
      this.applyState();
      this.writeRunMode(isActiveCleaning(s) ? RUN.CLEANING : RUN.IDLE);
    });

    this.vacbot.on('ChargeState', (v: string) => {
      this.log.info(`[${this.name}] ChargeState: ${v}`);
      const s = chargeStateToOpState(v);
      this.chargeState = s;
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

    this.vacbot.on('ErrorCode', (code: number) => {
      this.log.warn(`[${this.name}] ErrorCode: ${code}`);
      if (code === 0 || code === 100) {
        this.currentErrorId = RvcOperationalState.ErrorState.NoError;
        this.applyState();
        return;
      }
      this.currentErrorId = ecovacsErrorToMatterError(code);
      this.cleanState = OpState.Error;
      this.applyState();
    });

    this.vacbot.on('Error', (description: string) => {
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

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    this.log.info('EcovacsPlatform: loaded');
  }

  async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart(${reason})`);
    const cfg = this.config as EcovacsConfig;
    this.log.info(`Authenticating: ${cfg.email} [${cfg.countryCode}]`);

    const machineIdRaw = await nodeMachineId.machineId();
    const machineId = machineIdRaw.substring(0, 32); // server requires 32-char (MD5) device ID

    // Patch appVersion in ecovacs-deebot to match current Ecovacs API requirements
    try {
      const ecovacsPath = require.resolve('ecovacs-deebot');
      let src = fs.readFileSync(ecovacsPath, 'utf8');
      if (src.includes("appVersion = '2.2.3'")) {
        src = src.replace("appVersion = '2.2.3'", "appVersion = '1.6.3'");
        fs.writeFileSync(ecovacsPath, src, 'utf8');
        this.log.info('Patched ecovacs-deebot appVersion to 1.6.3');
      }
    } catch (e) {
      this.log.warn(`Could not patch ecovacs-deebot: ${String(e)}`);
    }

    const api = new EcoVacsAPI(machineId, cfg.countryCode, cfg.authDomain ?? '');

    // Token cache: avoid re-authenticating on every restart (prevents rate limiting)
    const tokenFile = path.join(process.env.HOME ?? '', '.matterbridge', 'ecovacs-token.json');
    let tokenLoaded = false;
    try {
      const cached = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (cached?.uid && cached?.user_access_token && cached?.authCode && cached?.email === cfg.email) {
        api.uid = cached.uid;
        api.user_access_token = cached.user_access_token;
        api.authCode = cached.authCode;
        api.resource = cached.resource;
        this.log.info(`Using cached auth token for ${cfg.email} (saved ${cached.savedAt})`);
        tokenLoaded = true;
      }
    } catch { /* no cache yet */ }

    const saveToken = () => {
      try {
        fs.writeFileSync(tokenFile, JSON.stringify({
          uid: api.uid, user_access_token: api.user_access_token,
          authCode: api.authCode, resource: api.resource,
          email: cfg.email, savedAt: new Date().toISOString(),
        }), 'utf8');
        this.log.info('Auth token cached');
      } catch { /* ignore */ }
    };

    if (!tokenLoaded) {
      this.log.info(`Fresh authentication: ${cfg.email} [${cfg.countryCode}]`);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await api.connect(cfg.email, EcoVacsAPI.md5(cfg.password));
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

    let devices: EcovacsVacuumInfo[];
    try {
      devices = await api.devices();
    } catch (err) {
      if (!tokenLoaded) throw err;
      this.log.warn(`Cached token expired — re-authenticating…`);
      try { fs.unlinkSync(tokenFile); } catch { /* ignore */ }
      await api.connect(cfg.email, EcoVacsAPI.md5(cfg.password));
      saveToken();
      devices = await api.devices();
    }

    const filtered = cfg.whiteList?.length
      ? devices.filter(d => cfg.whiteList!.includes(d.did) || cfg.whiteList!.includes(d.nick))
      : devices;
    this.log.info(`Found ${filtered.length} Ecovacs device(s)`);
    for (const vac of filtered) {
      await this.registerVacuum(api, vac, cfg.pollingInterval ?? 15, cfg.rooms ?? []);
    }
  }

  async onStop(reason?: string): Promise<void> {
    this.log.info(`onStop(${reason})`);
    await Promise.all(this.devices.map(d => d.disconnect()));
    this.devices = [];
  }

  async onConfigure(): Promise<void> { this.log.info('onConfigure'); }

  private async registerVacuum(api: any, vac: EcovacsVacuumInfo, pollSec: number, roomsConfig: RoomConfig[]): Promise<void> {
    const name = vac.nick || vac.deviceName || vac.did;
    this.log.info(`Registering: "${name}" (${vac.did})`);

    const device = new EcovacsDevice(api, vac, pollSec, this.log, roomsConfig);

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
    device.connect().catch((err: unknown) => this.log.error(`[${name}] connect failed: ${String(err)}`));
  }
}
