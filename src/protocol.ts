// Source Pro Bluetooth fireplace protocol, recovered from the official
// "Source Pro Fireplace Remote" Android app (com.keny.fireplacebluetooth 1.7.2).
//
// The app writes newline-terminated JSON text to WRITE_CHAR, e.g.
//   {"C":"Spo","v1":"1"}\n
// and the fireplace answers with "\r\n"-terminated JSON status lines on READ_CHAR.
// Older controllers use the "v1" key, newer ones "v2"; the fireplace reports
// which one it is in the "12" field of its status.

export const SERVICE_UUID = '18704c6e-19b9-4cbb-8100-42a459142300';
export const READ_CHAR_UUID = '18704c6e-19b9-4cbb-8100-42a459142301';
export const WRITE_CHAR_UUID = '18704c6e-19b9-4cbb-8100-42a459142302';

export type ProtocolVersion = 1 | 2;
export type TempUnit = 'F' | 'C';

export const FLAME_PATTERN_MIN = 1;
export const FLAME_PATTERN_MAX = 5;
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 5;

// v1 heaters take a setpoint; the lowest value is shown as OFF, the highest as HIGH.
export const V1_TEMP_RANGE: Record<TempUnit, [number, number]> = {
  F: [59, 88],
  C: [15, 32],
};

// v2 heaters take one of these fixed steps (index 0 = off, last = high).
export const V2_TEMP_STEPS: Record<TempUnit, number[]> = {
  F: [0, 65, 70, 75, 80, 85, 90, 104],
  C: [0, 18, 21, 24, 27, 29, 32, 40],
};

export function command(cmd: string, version: ProtocolVersion, value: string | number): string {
  return JSON.stringify({ C: cmd, [version === 1 ? 'v1' : 'v2']: String(value) }) + '\n';
}

export const commands = {
  power: (v: ProtocolVersion, on: boolean) => command('Spo', v, on ? 1 : 0),
  flamePattern: (v: ProtocolVersion, pattern: number) => command('Sfs', v, pattern),
  flameLevel: (v: ProtocolVersion, level: number) => command('Sfl', v, level),
  // The log/ember bed level is "Sll" on v1 controllers and "Sse" on v2.
  logLevel: (v: ProtocolVersion, level: number) => command(v === 1 ? 'Sll' : 'Sse', v, level),
  // v1: setpoint in the current unit. v2: the value from V2_TEMP_STEPS.
  temperature: (v: ProtocolVersion, value: number) => command('Stt', v, value),
  unit: (v: ProtocolVersion, unit: TempUnit) => command('Stc', v, unit === 'C' ? 1 : 0),
  // Shut-off timer in seconds; 0 cancels it.
  timer: (v: ProtocolVersion, seconds: number) => command('Sts', v, Math.max(0, Math.round(seconds))),
};

export interface FireplaceState {
  version?: ProtocolVersion;
  power?: boolean;
  flamePattern?: number;
  flameLevel?: number;
  logLevel?: number;
  /** v1: setpoint; v2: step index into V2_TEMP_STEPS */
  temperature?: number;
  unit?: TempUnit;
  timerSeconds?: number;
  timerRunning?: boolean;
  /** room temperature measured by the fireplace, in its current unit */
  roomTemp?: number;
}

function num(x: unknown): number | undefined {
  if (x === undefined || x === null || x === '') return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/** Merge one status line from the fireplace into the current state. */
export function applyStatus(prev: FireplaceState, msg: Record<string, unknown>): FireplaceState {
  const s: FireplaceState = { ...prev };
  const ver = num(msg['12']);
  if (ver === 1 || ver === 2) s.version = ver;
  else if ('se' in msg && s.version === undefined) s.version = 2;
  else if ('ll' in msg && s.version === undefined) s.version = 1;

  const po = num(msg.po);
  if (po !== undefined) s.power = po !== 0;
  const fs = num(msg.fs);
  if (fs !== undefined) s.flamePattern = fs;
  const fl = num(msg.fl);
  if (fl !== undefined) s.flameLevel = fl;
  const ll = num(msg.ll ?? msg.se);
  if (ll !== undefined) s.logLevel = ll;
  const tc = num(msg.tc);
  if (tc !== undefined) s.unit = tc === 1 ? 'C' : 'F';
  const tt = num(msg.tt);
  if (tt !== undefined) {
    if (s.version === 2) {
      const steps = V2_TEMP_STEPS[s.unit ?? 'F'];
      const idx = steps.indexOf(tt);
      s.temperature = idx >= 0 ? idx : Math.min(Math.max(tt, 0), steps.length - 1);
    } else {
      s.temperature = tt;
    }
  }
  const tp = num(msg.tp);
  if (tp !== undefined) s.roomTemp = tp;
  const ts = num(msg.ts);
  if (ts !== undefined) s.timerSeconds = ts;
  const tr = num(msg.tr);
  if (tr !== undefined) s.timerRunning = tr !== 0;
  return s;
}

export function temperatureLabel(state: FireplaceState, version: ProtocolVersion, unit: TempUnit): string {
  const t = state.temperature;
  if (t === undefined) return '--';
  if (version === 2) {
    const steps = V2_TEMP_STEPS[unit];
    if (t <= 0) return 'OFF';
    if (t >= steps.length - 1) return 'HIGH';
    return `${steps[t]}°${unit}`;
  }
  const [min, max] = V1_TEMP_RANGE[unit];
  if (t <= min) return 'OFF';
  if (t >= max) return 'HIGH';
  return `${t}°${unit}`;
}
