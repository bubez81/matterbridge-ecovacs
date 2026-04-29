/**
 * matterbridge-ecovacs  v0.1.37
 * Clean rewrite with dual-source state management.
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

const RUN   = { IDLE: 1, CLEANING: 2 } as const;
const CLEAN = { VACUUM: 1, MOP: 2, VACUUM_AND_MOP: 3, VACUUM_THEN_MOP: 4 } as const;
const OpState = RvcOperationalState.OperationalState;
const RECONNECT_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];

function cleanReportToOpState(v: string): number {
  switch (v) {
    case 'auto': case 'spot_area': case 'custom_area': case 'entrust':
    case 'freeClean': case 'qcClean': case 'spot': case 'area':
    case 'singlePoint': case 'move': case 'comeClean':
      return OpState.Running;
    case 'pause':      return OpState.Paused;
    case 'returning':  case 'goCharging': return OpState.SeekingCharger;
    case 'washing':    case 'drying': case 'airdrying': return OpState.CleaningMop;
    default:           return OpState.Stopped;
  }
}

function chargeStateToOpState(v: string): number {
  switch (v) {
    case 'charging': case 'slot_charging': return OpState.Charging;
    case 'returning': case 'going': case 'goCharging': return OpState.SeekingCharger;
    default: return OpState.Docked;
  }
}

/** Map Ecovacs error code to Matter RVC ErrorState */
function ecovacsErrorToMatterError(code: number): number {
  const E = RvcOperationalState.ErrorState;
  switch (code) {
    case 0: case 100: return E.NoError;
    case 101:         return E.LowBattery;
    case 103:         return E.WheelsJammed;
    case 104:         return E.NavigationSensorObscured;
    case 105:         return E.Stuck;
    case 108: case 109: return E.BrushJammed;
    case 110:         return E.DustBinMissing;
    case 114:         return E.DustBinFull;
    case 120: case 126: return E.WaterTankMissing;
    case 125:         return E.WaterTankMissing;
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

interface EcovacsVacuumInfo { did: string; nick: string; deviceName: string; resource?: string; class?: string; }
interface RoomConfig { id: string; name?: string; enabled?: boolean; }
interface EcovacsConfig extends PlatformConfig {
  email: string; password: string; countryCode: string;
  authDomain?: string; whiteList?: string[];
  pollingInterval?: number; rooms?: RoomConfig[];
}

class EcovacsDevice {
  private vacbot: any = null;
  private endpoint: RoboticVacuumCleaner | null = null;

  // Dual-source state: cleanState from CleanReport, chargeState from ChargeState
  private cleanState:  number = OpState.Stopped;
  private chargeState: number = OpState.Docked;
  private opState:     number = OpState.Docked;

  private runMode:   number = RUN.IDLE;
  private cleanMode: number = CLEAN.VACUUM;

  private matterIdToEcovacsId: Map<number, string> = new Map();
  private selectedAreaIds: string[] = [];

  private rooms: Map<string, string> = new Map();
  private roomsLoaded = false;
  private roomsExpected = 0;

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  onRoomsDiscovered?: (rooms: RoomConfig[]) => void;

  constructor(
    private readonly api: any,
    private readonly vacuum: EcovacsVacuumInfo,
    private readonly pollSec: number,
    private readonly log: AnsiLogger,
    private readonly roomsConfig: RoomConfig[] = [],
  ) {}

  get name(): string { return this.vacuum.nick || this.vacuum.deviceName || this.vacuum.did; }

  bindEndpoint(ep: RoboticVacuumCleaner): void {
    this.endpoint = ep;
    this.registerHandlers();
  }

  // State resolution: CleanReport wins for active states, ChargeState wins otherwise
  private applyState(): void {
    const resolved = (
      isActiveCleaning(this.cleanState) ||
      this.cleanState === OpState.SeekingCharger ||
      this.cleanState === OpState.CleaningMop ||
      this.cleanState === OpState.EmptyingDustBin
    ) ? this.cleanState : this.chargeState;

    if (resolved === this.opState) return;
    this.opState = resolved;
    const label = (RvcOperationalState.OperationalState as Record<number, string>)[resolved] ?? String(resolved);
    this.log.info(`[${this.name}] opState → ${label}`);
    this.endpoint?.setAttribute('RvcOperationalState', 'operationalState', resolved, this.log).catch(() => undefined);
    const errId = resolved === OpState.Error
      ? RvcOperationalState.ErrorState.UnableToCompleteOperation
      : RvcOperationalState.ErrorState.NoError;
    this.endpoint?.setAttribute('RvcOperationalState', 'operationalError',
      { errorStateId: errId, errorStateLabel: undefined, errorStateDetails: undefined }, this.log).catch(() => undefined);
  }

  async connect(): Promise<void> {
    if (this.shuttingDown) return;
    this.log.info(`[${this.name}] Connecting (attempt ${this.reconnectAttempt + 1})`);
    try { this.vacbot = this.api.getVacBotObj(this.vacuum); }
    catch (err) { this.log.error(`[${this.name}] getVacBotObj failed: ${String(err)}`); this.scheduleReconnect(); return; }
    this.listenVacbotEvents();
    this.vacbot.connect();
    this.vacbot.on('ready', () => {
      this.log.info(`[${this.name}] Connected — refreshing state in 3s`);
      this.reconnectAttempt = 0;
      setTimeout(() => {
        if (this.shuttingDown) return;
        this.vacbot?.run('GetBatteryState');
        this.vacbot?.run('GetChargeState');
        this.vacbot?.run('GetCleanState_V2');
        if (!this.roomsLoaded) this.vacbot?.run('GetMaps');
        this.startPolling(); // poll every 15s at startup
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
      this.stopPolling(); this.scheduleReconnect();
    });
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true; this.stopPolling();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
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

  private listenVacbotEvents(): void {
    this.vacbot.on('CleanReport', (v: string) => {
      this.log.info(`[${this.name}] CleanReport: ${v}`);
      const s = cleanReportToOpState(v);
      this.cleanState = s;
      this.applyState();
      this.setRunMode(isActiveCleaning(s) ? RUN.CLEANING : RUN.IDLE);
    });

    this.vacbot.on('ChargeState', (v: string) => {
      this.log.info(`[${this.name}] ChargeState: ${v}`);
      const s = chargeStateToOpState(v);
      this.chargeState = s;

      if (s === OpState.Charging) {
        // Robot is charging — only reset if not actively cleaning
        if (!isActiveCleaning(this.cleanState) && this.cleanState !== OpState.CleaningMop) {
          this.cleanState = OpState.Stopped;
          this.setRunMode(RUN.IDLE);
        }
      } else if (s === OpState.Docked) {
        // ChargeState: idle — only reset cleanState if not actively cleaning
        // When robot is cleaning, ChargeState is "idle" too — don't override Running!
        if (!isActiveCleaning(this.cleanState) &&
            this.cleanState !== OpState.CleaningMop &&
            this.cleanState !== OpState.SeekingCharger) {
          this.cleanState = OpState.Stopped;
          this.setRunMode(RUN.IDLE);
        }
      }
      // SeekingCharger: don't override cleanState — CleanReport handles it

      this.applyState();
      const bat = s === OpState.Charging ? PowerSource.BatChargeState.IsCharging : PowerSource.BatChargeState.IsNotCharging;
      this.endpoint?.setAttribute('PowerSource', 'batChargeState', bat, this.log).catch(() => undefined);
    });

    this.vacbot.on('BatteryInfo', (level: number) => {
      const pct = Math.max(0, Math.min(100, Math.round(level)));
      this.endpoint?.setAttribute('PowerSource', 'batPercentRemaining', pct * 2, this.log).catch(() => undefined);
    });

    this.vacbot.on('Error', (description: string) => {
      this.log.warn(`[${this.name}] Robot error: ${description}`);
    });

    this.vacbot.on('ErrorCode', (code: number) => {
      this.log.warn(`[${this.name}] ErrorCode: ${code}`);
      if (code === 0 || code === 100) {
        // NoError — clear error state
        this.endpoint?.setAttribute('RvcOperationalState', 'operationalError',
          { errorStateId: RvcOperationalState.ErrorState.NoError, errorStateLabel: undefined, errorStateDetails: undefined },
          this.log).catch(() => undefined);
        return;
      }
      const errorStateId = ecovacsErrorToMatterError(code);
      this.cleanState = OpState.Error;
      this.applyState();
      this.endpoint?.setAttribute('RvcOperationalState', 'operationalError',
        { errorStateId, errorStateLabel: undefined, errorStateDetails: undefined },
        this.log).catch(() => undefined);
    });

    this.vacbot.on('MopWash', (v: string) => {
      if (v === 'washing' || v === 'start') { this.cleanState = OpState.CleaningMop; this.applyState(); }
    });

    // CurrentStats fires during cleaning — use it as a Running indicator
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.vacbot.on('CurrentStats', (v: any) => {
      this.log.info(`[${this.name}] CurrentStats: type=${v?.cleanType}`);
      const cleanType = v?.cleanType;
      if (cleanType === 'spotArea' || cleanType === 'auto' || cleanType === 'customArea' || cleanType === 'freeClean') {
        if (this.cleanState !== OpState.Running) {
          this.cleanState = OpState.Running;
          this.applyState();
          this.setRunMode(RUN.CLEANING);
        }
      }
    });

    this.vacbot.on('EmptyDustBin', (v: string) => {
      if (v === 'start') { this.cleanState = OpState.EmptyingDustBin; this.applyState(); }
    });

    this.vacbot.on('StatusInfo', (v: unknown) => { this.log.debug(`[${this.name}] StatusInfo: ${JSON.stringify(v)}`); });

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
      if (id) { this.rooms.set(id, name); this.updateServiceAreas(); }
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

    let entries = Array.from(this.rooms.entries());
    if (this.roomsConfig.length > 0) {
      entries = entries
        .filter(([id]) => { const c = this.roomsConfig.find((r: RoomConfig) => r.id === id); return c ? c.enabled !== false : true; })
        .map(([id, n]) => { const c = this.roomsConfig.find((r: RoomConfig) => r.id === id); return [id, (c?.name?.trim() || n)] as [string, string]; });
    }

    this.matterIdToEcovacsId.clear();
    const areas = entries.map(([ecoId, name]) => {
      // Use Ecovacs numeric ID as Matter areaId for stability across restarts
      // This ensures Apple Home scenes always point to the correct room
      const matterAreaId = (parseInt(ecoId, 10) || 0) + 1; // +1 to avoid 0
      this.matterIdToEcovacsId.set(matterAreaId, ecoId);
      return { areaId: matterAreaId, mapId: null, areaInfo: { locationInfo: { locationName: name, floorNumber: 0, areaType: null }, landmarkInfo: null } };
    });

    this.log.info(`[${this.name}] ServiceArea: ${areas.length} rooms`);
    this.endpoint.setAttribute('ServiceArea', 'supportedAreas', areas, this.log).catch(() => undefined);
  }

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
      this.log.info(`[${this.name}] selectAreas: ${JSON.stringify(matterIds)} → ${JSON.stringify(this.selectedAreaIds)}`);
      setTimeout(() => {
        this.endpoint?.setAttribute('ServiceArea', 'selectedAreas', matterIds, this.log).catch(() => undefined);
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
        this.setRunMode(RUN.IDLE);
      }
    });

    this.endpoint.addCommandHandler('RvcOperationalState.pause', async () => {
      this.vacbot?.run('Pause'); this.cleanState = OpState.Paused; this.applyState();
    });
    this.endpoint.addCommandHandler('RvcOperationalState.resume', async () => {
      this.vacbot?.run('Resume'); this.cleanState = OpState.Running; this.applyState();
    });
    this.endpoint.addCommandHandler('RvcOperationalState.goHome', async () => {
      this.vacbot?.run('Charge'); this.cleanState = OpState.SeekingCharger; this.applyState();
    });
  }

  private async cmdStart(): Promise<void> {
    this.log.info(`[${this.name}] Start (cleanMode=${this.cleanMode}, areas=${JSON.stringify(this.selectedAreaIds)}, totalRooms=${this.matterIdToEcovacsId.size})`);
    const workMode = this.cleanMode === CLEAN.VACUUM ? 1 : this.cleanMode === CLEAN.MOP ? 2 : this.cleanMode === CLEAN.VACUUM_THEN_MOP ? 3 : 0;
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
    this.setRunMode(RUN.CLEANING);
  }

  private setRunMode(m: number): void {
    if (this.runMode === m) return;
    this.runMode = m;
    this.endpoint?.setAttribute('RvcRunMode', 'currentMode', m, this.log).catch(() => undefined);
  }

  private startPolling(): void {
    if (this.pollSec <= 0 || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.vacbot?.run('GetBatteryState');
      this.vacbot?.run('GetChargeState');
      this.vacbot?.run('GetCleanState_V2');
    }, this.pollSec * 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}

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
    // Server requires 32-char device ID (MD5 length), not 64-char SHA256
    const machineId = machineIdRaw.substring(0, 32);

    // Patch appVersion in ecovacs-deebot to match current Ecovacs API requirements
    // The library hardcodes '2.2.3' but the server now requires '1.6.3'
    try {
      const ecovacsPath = require.resolve('ecovacs-deebot');
      const ecovacsDir = path.dirname(ecovacsPath);
      const indexPath = ecovacsPath;
      let src = fs.readFileSync(indexPath, 'utf8');
      if (src.includes("appVersion = '2.2.3'")) {
        src = src.replace("appVersion = '2.2.3'", "appVersion = '1.6.3'");
        fs.writeFileSync(indexPath, src, 'utf8');
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
          this.log.warn(`Authentication failed (attempt ${attempt}/5): ${String(err)} — retrying in ${delay/1000}s`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      if (lastErr) throw lastErr;
    }

    // Helper to save token
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

    // Save token if we just authenticated fresh
    if (!tokenLoaded) saveToken();

    // If we used a cached token, verify it works — if not, re-authenticate
    let devices: EcovacsVacuumInfo[];
    try {
      devices = await api.devices();
    } catch (err) {
      if (tokenLoaded) {
        this.log.warn(`Cached token expired or invalid — re-authenticating...`);
        try { fs.unlinkSync(tokenFile); } catch { /* ignore */ }
        await api.connect(cfg.email, EcoVacsAPI.md5(cfg.password));
        saveToken();
        this.log.info('Auth token refreshed and cached');
        devices = await api.devices();
      } else {
        throw err;
      }
    }
    const filtered = cfg.whiteList?.length
      ? devices.filter(d => cfg.whiteList!.includes(d.did) || cfg.whiteList!.includes(d.nick))
      : devices;
    this.log.info(`Found ${filtered.length} Ecovacs device(s)`);
    for (const vac of filtered) await this.registerVacuum(api, vac, cfg.pollingInterval ?? 15, cfg.rooms ?? []);
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
      null, null,
      OpState.Docked,
      [
        { operationalStateId: OpState.Stopped },
        { operationalStateId: OpState.Running },
        { operationalStateId: OpState.Paused },
        { operationalStateId: OpState.Error },
        { operationalStateId: OpState.SeekingCharger },
        { operationalStateId: OpState.Charging },
        { operationalStateId: OpState.Docked },
        { operationalStateId: OpState.CleaningMop },
        { operationalStateId: OpState.EmptyingDustBin },
      ],
      [], [], null, [],
    );

    const device = new EcovacsDevice(api, vac, pollSec, this.log, roomsConfig);
    if (roomsConfig.length === 0) {
      device.onRoomsDiscovered = (disc: RoomConfig[]) => {
        const updated = { ...this.config, rooms: disc } as EcovacsConfig;
        this.saveConfig(updated as unknown as PlatformConfig);
        this.wssSendSnackbarMessage(`✅ ${name}: ${disc.length} stanze scoperte — riavvia per applicare.`, 8000);
      };
    }
    device.bindEndpoint(endpoint);
    this.devices.push(device);
    await this.registerDevice(endpoint as unknown as MatterbridgeEndpoint);
    device.connect().catch((err: unknown) => this.log.error(`[${name}] Initial connect failed: ${String(err)}`));
  }
}
