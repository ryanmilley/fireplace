import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';
import { READ_CHAR_UUID, SERVICE_UUID, WRITE_CHAR_UUID } from './protocol';

export const manager = new BleManager();

// --- small helpers (RN has no Buffer) ---------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : -1));
    out.push((n[0] << 2) | (n[1] >> 4));
    if (n[2] >= 0) out.push(((n[1] & 15) << 4) | (n[2] >> 2));
    if (n[3] >= 0) out.push(((n[2] & 3) << 6) | n[3]);
  }
  return Uint8Array.from(out);
}

function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

// Fireplace status is plain ASCII JSON; anything else is shown as-is in the log.
const utf8Decode = (b: Uint8Array) => String.fromCharCode(...b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- permissions & scanning -------------------------------------------------

export async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(res).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
  }
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

export function waitForPoweredOn(): Promise<void> {
  return new Promise((resolve) => {
    const sub = manager.onStateChange((s) => {
      if (s === State.PoweredOn) {
        sub.remove();
        resolve();
      }
    }, true);
  });
}

export interface FoundDevice {
  id: string;
  name: string;
  rssi: number | null;
  /** advertises the fireplace service */
  isFireplace: boolean;
}

/** Scans all nearby devices; fireplaces don't always advertise their service UUID. */
export function scan(onDevice: (d: FoundDevice) => void): () => void {
  manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
    if (error || !device) return;
    const name = device.name ?? device.localName ?? '';
    const isFireplace = !!device.serviceUUIDs?.some((u) => u.toLowerCase() === SERVICE_UUID);
    if (!name && !isFireplace) return;
    onDevice({ id: device.id, name: name || 'Unnamed device', rssi: device.rssi, isFireplace });
  });
  return () => manager.stopDeviceScan();
}

// --- connection -------------------------------------------------------------

export type LogEntry = { dir: 'tx' | 'rx' | 'info'; text: string; at: number };

export class FireplaceConnection {
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private rxBuffer = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private onStatus: (msg: Record<string, unknown>) => void,
    private onLog: (e: LogEntry) => void,
    private onDisconnect: () => void,
  ) {}

  private log(dir: LogEntry['dir'], text: string) {
    this.onLog({ dir, text, at: Date.now() });
  }

  async connect(id: string): Promise<void> {
    manager.stopDeviceScan();
    this.log('info', `Connecting to ${id}…`);
    let d = await manager.connectToDevice(id, { timeout: 15000, requestMTU: 185 });
    d = await d.discoverAllServicesAndCharacteristics();
    this.device = d;
    this.log('info', `Connected (MTU ${d.mtu})`);

    this.subs.push(
      d.onDisconnected(() => {
        this.log('info', 'Disconnected');
        this.cleanup();
        this.onDisconnect();
      }),
      d.monitorCharacteristicForService(SERVICE_UUID, READ_CHAR_UUID, (error, ch) => {
        if (error) {
          this.log('info', `Notify error: ${error.message}`);
          return;
        }
        if (ch?.value) this.handleRx(utf8Decode(base64ToBytes(ch.value)));
      }),
    );
  }

  private handleRx(chunk: string) {
    this.rxBuffer += chunk;
    let nl: number;
    while ((nl = this.rxBuffer.indexOf('\n')) >= 0) {
      const line = this.rxBuffer.slice(0, nl).replace(/\r$/, '').trim();
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line) continue;
      this.log('rx', line);
      try {
        const msg = JSON.parse(line);
        if (msg && typeof msg === 'object') this.onStatus(msg);
      } catch {
        // not JSON; already in the log
      }
    }
    if (this.rxBuffer.length > 4096) this.rxBuffer = '';
  }

  /** Sends one command line. Writes are serialized and spaced like the official app (80 ms). */
  send(line: string): Promise<void> {
    const job = this.queue.then(async () => {
      const d = this.device;
      if (!d) throw new Error('Not connected');
      this.log('tx', line.trimEnd());
      const bytes = utf8Encode(line);
      const chunk = Math.max(20, (d.mtu ?? 23) - 3);
      for (let i = 0; i < bytes.length; i += chunk) {
        await d.writeCharacteristicWithResponseForService(
          SERVICE_UUID,
          WRITE_CHAR_UUID,
          bytesToBase64(bytes.subarray(i, i + chunk)),
        );
      }
      await sleep(80);
    });
    this.queue = job.catch((e) => this.log('info', `Write failed: ${e?.message ?? e}`));
    return job;
  }

  async disconnect() {
    const d = this.device;
    this.cleanup();
    if (d) await manager.cancelDeviceConnection(d.id).catch(() => {});
  }

  private cleanup() {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    this.device = null;
    this.rxBuffer = '';
  }
}
