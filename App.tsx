import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  FireplaceConnection,
  FoundDevice,
  LogEntry,
  requestPermissions,
  scan,
  waitForPoweredOn,
} from './src/ble';
import {
  applyStatus,
  commands,
  FireplaceState,
  FLAME_PATTERN_MAX,
  FLAME_PATTERN_MIN,
  LEVEL_MAX,
  LEVEL_MIN,
  ProtocolVersion,
  TempUnit,
  V1_TEMP_RANGE,
  V2_TEMP_STEPS,
} from './src/protocol';

const LAST_DEVICE_KEY = 'lastDevice';
const VERSION_KEY = 'protocolVersion';
const UNIT_KEY = 'unit';

const C = {
  bg: '#16110e',
  card: '#241b16',
  border: '#3a2c23',
  text: '#f6ece4',
  dim: '#a8968a',
  accent: '#ff7a2f',
  accentDim: '#5a3320',
  on: '#3ccf7a',
};

type Screen = 'scan' | 'control' | 'log';

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const [screen, setScreen] = useState<Screen>('scan');
  const [devices, setDevices] = useState<FoundDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const [state, setState] = useState<FireplaceState>({});
  const [version, setVersion] = useState<ProtocolVersion>(1);
  const [unit, setUnit] = useState<TempUnit>('F');
  const [log, setLog] = useState<LogEntry[]>([]);
  const conn = useRef<FireplaceConnection | null>(null);
  const stopScan = useRef<(() => void) | null>(null);

  // The fireplace's own status wins over saved/manual settings.
  const effVersion = state.version ?? version;
  const effUnit = state.unit ?? unit;

  useEffect(() => {
    AsyncStorage.multiGet([VERSION_KEY, UNIT_KEY]).then((pairs) => {
      const m = Object.fromEntries(pairs);
      if (m[VERSION_KEY] === '2') setVersion(2);
      if (m[UNIT_KEY] === 'C') setUnit('C');
    });
  }, []);

  useEffect(() => {
    if (state.version) AsyncStorage.setItem(VERSION_KEY, String(state.version));
  }, [state.version]);

  const addLog = useCallback((e: LogEntry) => setLog((l) => [e, ...l].slice(0, 300)), []);

  const startScan = useCallback(async () => {
    if (!(await requestPermissions())) {
      Alert.alert('Bluetooth permission needed', 'Allow Bluetooth access in Settings to find your fireplace.');
      return;
    }
    await waitForPoweredOn();
    setDevices([]);
    setScanning(true);
    stopScan.current?.();
    stopScan.current = scan((d) =>
      setDevices((list) => {
        const rest = list.filter((x) => x.id !== d.id);
        return [...rest, d].sort((a, b) => Number(b.isFireplace) - Number(a.isFireplace) || (b.rssi ?? -999) - (a.rssi ?? -999));
      }),
    );
    setTimeout(() => {
      stopScan.current?.();
      setScanning(false);
    }, 12000);
  }, []);

  const connect = useCallback(
    async (d: { id: string; name: string }) => {
      stopScan.current?.();
      setScanning(false);
      setConnecting(d.id);
      const c = new FireplaceConnection(
        (msg) => setState((s) => applyStatus(s, msg)),
        addLog,
        () => {
          setConnectedName(null);
          setScreen('scan');
        },
      );
      try {
        await c.connect(d.id);
        conn.current = c;
        setState({});
        setConnectedName(d.name);
        setScreen('control');
        AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(d));
      } catch (e: any) {
        Alert.alert('Could not connect', `${e?.message ?? e}\n\nMake sure the fireplace is plugged in, you're within about 1 m, and no other phone is connected to it.`);
      } finally {
        setConnecting(null);
      }
    },
    [addLog],
  );

  // Reconnect to the last fireplace on launch.
  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(LAST_DEVICE_KEY);
      if (!saved) return startScan();
      if (!(await requestPermissions())) return;
      await waitForPoweredOn();
      connect(JSON.parse(saved));
    })();
    return () => {
      conn.current?.disconnect();
    };
  }, []);

  const send = useCallback((line: string, optimistic?: Partial<FireplaceState>) => {
    if (!conn.current) return;
    if (optimistic) setState((s) => ({ ...s, ...optimistic }));
    conn.current.send(line).catch(() => {});
  }, []);

  const disconnect = async () => {
    await conn.current?.disconnect();
    conn.current = null;
    setConnectedName(null);
    setScreen('scan');
    startScan();
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>🔥 Fireplace</Text>
        {connectedName && (
          <View style={styles.tabs}>
            <Tab label="Control" active={screen === 'control'} onPress={() => setScreen('control')} />
            <Tab label="Log" active={screen === 'log'} onPress={() => setScreen('log')} />
          </View>
        )}
      </View>

      {screen === 'scan' && (
        <ScanScreen devices={devices} scanning={scanning} connecting={connecting} onScan={startScan} onPick={connect} />
      )}
      {screen === 'control' && connectedName && (
        <ControlScreen
          name={connectedName}
          state={state}
          version={effVersion}
          unit={effUnit}
          send={send}
          setVersion={(v) => {
            setVersion(v);
            setState((s) => ({ ...s, version: undefined }));
            AsyncStorage.setItem(VERSION_KEY, String(v));
          }}
          setUnit={(u) => {
            setUnit(u);
            AsyncStorage.setItem(UNIT_KEY, u);
            send(commands.unit(effVersion, u), { unit: u, temperature: undefined });
          }}
          onDisconnect={disconnect}
        />
      )}
      {screen === 'log' && <LogScreen log={log} onClear={() => setLog([])} />}
    </SafeAreaView>
  );
}

// --- screens ----------------------------------------------------------------

function ScanScreen(props: {
  devices: FoundDevice[];
  scanning: boolean;
  connecting: string | null;
  onScan: () => void;
  onPick: (d: FoundDevice) => void;
}) {
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={styles.hint}>
        Turn the fireplace on at the wall, stand within about 1 m, and close the official app so it isn't holding the
        connection.
      </Text>
      <Button label={props.scanning ? 'Scanning…' : 'Scan for fireplaces'} onPress={props.onScan} disabled={props.scanning} />
      <FlatList
        style={{ marginTop: 12 }}
        data={props.devices}
        keyExtractor={(d) => d.id}
        ListEmptyComponent={
          props.scanning ? <ActivityIndicator color={C.accent} style={{ marginTop: 24 }} /> : undefined
        }
        renderItem={({ item }) => (
          <Pressable style={[styles.card, item.isFireplace && { borderColor: C.accent }]} onPress={() => props.onPick(item)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.dim}>
                {item.isFireplace ? 'Fireplace · ' : ''}
                {item.rssi ?? '?'} dBm
              </Text>
            </View>
            {props.connecting === item.id ? <ActivityIndicator color={C.accent} /> : <Text style={styles.dim}>›</Text>}
          </Pressable>
        )}
      />
    </View>
  );
}

function ControlScreen(props: {
  name: string;
  state: FireplaceState;
  version: ProtocolVersion;
  unit: TempUnit;
  send: (line: string, optimistic?: Partial<FireplaceState>) => void;
  setVersion: (v: ProtocolVersion) => void;
  setUnit: (u: TempUnit) => void;
  onDisconnect: () => void;
}) {
  const { state, version: v, unit, send } = props;
  const on = state.power ?? false;

  const pattern = state.flamePattern ?? FLAME_PATTERN_MIN;
  const flame = state.flameLevel ?? LEVEL_MIN;
  const logs = state.logLevel ?? LEVEL_MIN;

  const timerMins = state.timerRunning !== false && state.timerSeconds ? Math.ceil(state.timerSeconds / 60) : 0;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={styles.rowBetween}>
        <Text style={styles.dim}>{props.name}</Text>
        <Pressable onPress={props.onDisconnect}>
          <Text style={[styles.dim, { color: C.accent }]}>Disconnect</Text>
        </Pressable>
      </View>

      <Pressable
        style={[styles.power, on && { backgroundColor: C.accent, borderColor: C.accent }]}
        onPress={() => send(commands.power(v, !on), { power: !on })}
      >
        <Text style={styles.powerIcon}>⏻</Text>
        <Text style={styles.powerLabel}>{state.power === undefined ? 'Power' : on ? 'On' : 'Off'}</Text>
      </Pressable>

      <HeatControl
        version={v}
        unit={unit}
        temperature={state.temperature}
        onSet={(t) => send(commands.temperature(v, v === 1 ? t : V2_TEMP_STEPS[unit][t]), { temperature: t })}
      />
      <Levels
        label="Flame level"
        min={LEVEL_MIN}
        max={LEVEL_MAX}
        value={flame}
        onPick={(n) => send(commands.flameLevel(v, n), { flameLevel: n })}
      />
      <Levels
        label="Flame pattern"
        min={FLAME_PATTERN_MIN}
        max={FLAME_PATTERN_MAX}
        value={pattern}
        onPick={(n) => send(commands.flamePattern(v, n), { flamePattern: n })}
      />
      <Levels
        label={v === 1 ? 'Log level' : 'Ember bed'}
        min={LEVEL_MIN}
        max={LEVEL_MAX}
        value={logs}
        onPick={(n) => send(commands.logLevel(v, n), { logLevel: n })}
      />

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Shut-off timer {timerMins ? `· ${fmtMins(timerMins)} left` : ''}</Text>
        <View style={styles.chips}>
          {[30, 60, 120, 240, 480].map((m) => (
            <Chip
              key={m}
              label={fmtMins(m)}
              onPress={() => send(commands.timer(v, m * 60), { timerSeconds: m * 60, timerRunning: true })}
            />
          ))}
          <Chip label="Cancel" onPress={() => send(commands.timer(v, 0), { timerSeconds: 0, timerRunning: false })} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Settings</Text>
        <View style={styles.rowBetween}>
          <Text style={styles.text}>Temperature unit</Text>
          <Segmented options={['F', 'C']} value={unit} onChange={(u) => props.setUnit(u as TempUnit)} />
        </View>
        <View style={[styles.rowBetween, { marginTop: 10 }]}>
          <Text style={styles.text}>
            Controller type{props.state.version ? ' (detected)' : ''}
          </Text>
          <Segmented options={['1', '2']} value={String(v)} onChange={(x) => props.setVersion(Number(x) as ProtocolVersion)} />
        </View>
      </View>
    </ScrollView>
  );
}

function LogScreen({ log, onClear }: { log: LogEntry[]; onClear: () => void }) {
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <View style={styles.rowBetween}>
        <Text style={styles.dim}>Bluetooth traffic (newest first)</Text>
        <Pressable onPress={onClear}>
          <Text style={{ color: C.accent }}>Clear</Text>
        </Pressable>
      </View>
      <FlatList
        style={{ marginTop: 8 }}
        data={log}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <Text style={[styles.mono, item.dir === 'tx' && { color: C.accent }, item.dir === 'rx' && { color: C.on }]}>
            {new Date(item.at).toLocaleTimeString()} {item.dir === 'tx' ? '→' : item.dir === 'rx' ? '←' : '·'} {item.text}
          </Text>
        )}
      />
    </View>
  );
}

// --- widgets ----------------------------------------------------------------

const fmtMins = (m: number) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && { color: C.text }]}>{label}</Text>
    </Pressable>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.button, disabled && { opacity: 0.5 }]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.chip}>
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

type HeatMode = 'off' | 'on' | 'high';

/**
 * The fireplace has one heat value: its lowest setting is "off", its highest is "full heat",
 * and everything in between is a thermostat target. This splits that into a mode switch
 * plus a target, and waits until you stop tapping before sending.
 */
function HeatControl(props: {
  version: ProtocolVersion;
  unit: TempUnit;
  /** v1: setpoint; v2: step index */
  temperature?: number;
  onSet: (t: number) => void;
}) {
  const { version: v, unit } = props;
  const [min, max] = v === 1 ? V1_TEMP_RANGE[unit] : [0, V2_TEMP_STEPS[unit].length - 1];
  const defaultTarget = v === 1 ? (unit === 'F' ? 72 : 22) : 3;
  const [pending, setPending] = useState<number | undefined>();
  const lastTarget = useRef(defaultTarget);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const shown = pending ?? props.temperature ?? min;
  const mode: HeatMode = shown <= min ? 'off' : shown >= max ? 'high' : 'on';

  useEffect(() => {
    lastTarget.current = defaultTarget;
  }, [v, unit]);
  useEffect(() => {
    if (mode === 'on') lastTarget.current = shown;
  }, [mode, shown]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const set = (t: number, delayMs: number) => {
    setPending(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      props.onSet(t);
      setPending(undefined);
    }, delayMs);
  };
  const pickMode = (m: HeatMode) => set(m === 'off' ? min : m === 'high' ? max : lastTarget.current, 0);
  const nudge = (d: number) => set(Math.min(max - 1, Math.max(min + 1, shown + d)), 700);

  const degrees = v === 1 ? shown : V2_TEMP_STEPS[unit][shown];
  const caption =
    mode === 'off' ? 'Heater off. Flames only.' : mode === 'high' ? 'Heater running at full power.' : 'Heats the room to this temperature.';

  return (
    <View style={styles.section}>
      <View style={styles.rowBetween}>
        <Text style={[styles.sectionLabel, { marginBottom: 0 }]}>Heat</Text>
        <Segmented
          options={['off', 'on', 'high']}
          labels={{ off: 'Off', on: 'On', high: 'High' }}
          value={mode}
          onChange={(m) => pickMode(m as HeatMode)}
        />
      </View>
      {mode === 'on' && (
        <View style={[styles.row, { justifyContent: 'center', marginTop: 14 }]}>
          <Pressable style={styles.round} onPress={() => nudge(-1)} disabled={shown <= min + 1}>
            <Text style={[styles.roundText, shown <= min + 1 && { opacity: 0.3 }]}>−</Text>
          </Pressable>
          <Text style={styles.heatValue}>
            {degrees}°{unit}
          </Text>
          <Pressable style={styles.round} onPress={() => nudge(1)} disabled={shown >= max - 1}>
            <Text style={[styles.roundText, shown >= max - 1 && { opacity: 0.3 }]}>+</Text>
          </Pressable>
        </View>
      )}
      <Text style={[styles.dim, { marginTop: 10, textAlign: mode === 'on' ? 'center' : 'left' }]}>{caption}</Text>
    </View>
  );
}

function Levels(props: { label: string; min: number; max: number; value: number; onPick: (n: number) => void }) {
  const nums = Array.from({ length: props.max - props.min + 1 }, (_, i) => props.min + i);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{props.label}</Text>
      <View style={styles.levels}>
        {nums.map((n) => (
          <Pressable
            key={n}
            onPress={() => props.onPick(n)}
            style={[styles.level, n <= props.value && n > 0 && { backgroundColor: C.accentDim }, n === props.value && styles.levelActive]}
          >
            <Text style={[styles.text, n === props.value && { fontWeight: '700' }]}>{n === 0 ? 'Off' : n}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Segmented({
  options,
  labels,
  value,
  onChange,
}: {
  options: string[];
  labels?: Record<string, string>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable key={o} onPress={() => onChange(o)} style={[styles.segment, o === value && { backgroundColor: C.accent }]}>
          <Text style={[styles.text, o === value && { fontWeight: '700' }]}>{labels?.[o] ?? (o === 'F' || o === 'C' ? `°${o}` : `v${o}`)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: C.text, fontSize: 22, fontWeight: '700' },
  tabs: { flexDirection: 'row', backgroundColor: C.card, borderRadius: 10, padding: 3 },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  tabActive: { backgroundColor: C.border },
  tabText: { color: C.dim, fontWeight: '600' },
  hint: { color: C.dim, marginBottom: 12, lineHeight: 20 },
  text: { color: C.text, fontSize: 15 },
  dim: { color: C.dim, fontSize: 13 },
  mono: { color: C.dim, fontFamily: 'monospace', fontSize: 12, paddingVertical: 2 },
  button: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#1b0f08', fontWeight: '700', fontSize: 16 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 8 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '600', marginBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  power: { alignSelf: 'center', width: 150, height: 150, borderRadius: 75, borderWidth: 3, borderColor: C.border, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', marginVertical: 8 },
  powerIcon: { color: C.text, fontSize: 48 },
  powerLabel: { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  section: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14 },
  sectionLabel: { color: C.dim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.border, alignItems: 'center', justifyContent: 'center' },
  roundText: { color: C.text, fontSize: 24, fontWeight: '600' },
  heatValue: { color: C.text, fontSize: 40, fontWeight: '700', minWidth: 140, textAlign: 'center' },
  levels: { flexDirection: 'row', gap: 6 },
  level: { flex: 1, height: 44, borderRadius: 10, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  levelActive: { borderColor: C.accent, backgroundColor: C.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  segmented: { flexDirection: 'row', backgroundColor: C.bg, borderRadius: 10, padding: 3 },
  segment: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
});
