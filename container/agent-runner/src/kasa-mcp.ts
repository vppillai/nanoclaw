/**
 * Kasa MCP Server — TP-Link Kasa smart home control (hybrid cloud + local)
 *
 * IOT.SMARTPLUGSWITCH devices: cloud API passthrough for status and control.
 * SMART.KASASWITCH devices: cloud API for listing (with base64 alias decode),
 * host-side UDP discovery for real online status (read from IPC snapshot).
 * Local KLAP control is not yet implemented (requires TCP access on port 80).
 */

import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const APP_TYPE = 'Kasa_Android';
const TERMINAL_UUID = 'nanoclaw-kasa-mcp';

const username = process.env.KASA_USERNAME!;
const password = process.env.KASA_PASSWORD!;

// ---------------------------------------------------------------------------
// Cloud API
// ---------------------------------------------------------------------------

interface CloudLogin {
  token: string;
  apiUrl: string;
}

let cachedLogin: CloudLogin | null = null;

async function kasaRequest(apiUrl: string, body: object): Promise<unknown> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { error_code: number; msg?: string; result?: unknown };
  if (data.error_code !== 0) throw new Error(`Kasa error ${data.error_code}: ${data.msg ?? 'unknown'}`);
  return data.result;
}

async function login(): Promise<CloudLogin> {
  if (cachedLogin) return cachedLogin;

  // Login to default endpoint first to discover the regional server
  const defaultApi = 'https://wap.tplinkcloud.com';
  const result = (await kasaRequest(defaultApi, {
    method: 'login',
    params: { appType: APP_TYPE, cloudUserName: username, cloudPassword: password, terminalUUID: TERMINAL_UUID },
  })) as { token: string };

  // Get device list to find the regional appServerUrl
  const devResult = (await kasaRequest(defaultApi, {
    method: 'getDeviceList',
    params: { token: result.token },
  })) as { deviceList: CloudDevice[] };

  // Find a regional server URL (prefer the one with isSameRegion=true)
  let regionalUrl = defaultApi;
  for (const d of devResult.deviceList) {
    if (d.appServerUrl && d.appServerUrl !== defaultApi) {
      regionalUrl = d.appServerUrl;
      break;
    }
  }

  // Re-login to regional server if different
  if (regionalUrl !== defaultApi) {
    const regional = (await kasaRequest(regionalUrl, {
      method: 'login',
      params: { appType: APP_TYPE, cloudUserName: username, cloudPassword: password, terminalUUID: TERMINAL_UUID },
    })) as { token: string };
    cachedLogin = { token: regional.token, apiUrl: regionalUrl };
  } else {
    cachedLogin = { token: result.token, apiUrl: defaultApi };
  }

  return cachedLogin;
}

interface CloudDevice {
  deviceId: string;
  alias: string;
  deviceType: string;
  deviceModel: string;
  deviceMac: string;
  status: number;
  appServerUrl: string;
  isSameRegion?: boolean;
}

async function getCloudDevices(): Promise<CloudDevice[]> {
  const { token, apiUrl } = await login();
  const result = (await kasaRequest(apiUrl, {
    method: 'getDeviceList',
    params: { token },
  })) as { deviceList: CloudDevice[] };
  return result.deviceList;
}

async function passthrough(device: MergedDevice, command: object): Promise<unknown> {
  const { token, apiUrl } = await login();
  const result = (await kasaRequest(apiUrl, {
    method: 'passthrough',
    params: { token, deviceId: device.deviceId, requestData: JSON.stringify(command) },
  })) as { responseData: string };
  return JSON.parse(result.responseData);
}

// ---------------------------------------------------------------------------
// Local Discovery (read from host-side IPC snapshot)
// ---------------------------------------------------------------------------

interface DiscoveredDevice {
  ip: string;
  mac: string;
  model: string;
  deviceType: string;
  alias?: string;
  relayState?: number;
}

function normalizeMac(mac: string): string {
  return mac.replace(/[-:]/g, '').toUpperCase();
}

const DISCOVERY_FILE = '/workspace/ipc/kasa_discovery.json';

/** Read host-side UDP discovery results from the IPC snapshot file. */
async function discoverDevices(): Promise<DiscoveredDevice[]> {
  try {
    const data = fs.readFileSync(DISCOVERY_FILE, 'utf-8');
    const parsed = JSON.parse(data) as { devices?: DiscoveredDevice[] };
    return parsed.devices || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Merged Device View
// ---------------------------------------------------------------------------

interface MergedDevice {
  deviceId: string;
  alias: string;
  deviceType: string;
  deviceModel: string;
  cloudStatus: number;
  localIp: string | null;
  locallyReachable: boolean;
  relayState: number | null;
  isSmartDevice: boolean;
}

function decodeAlias(alias: string, deviceType: string): string {
  if (!deviceType.startsWith('SMART.')) return alias;
  try {
    const decoded = Buffer.from(alias, 'base64').toString('utf8');
    // Sanity check: base64 decode of a normal string would produce garbage
    if (/^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0) return decoded.trim();
  } catch { /* not base64 */ }
  return alias;
}

let cachedDevices: MergedDevice[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000;

async function getDevices(): Promise<MergedDevice[]> {
  if (cachedDevices && Date.now() - cacheTime < CACHE_TTL_MS) return cachedDevices;

  const [cloudDevices, localDevices] = await Promise.all([
    getCloudDevices(),
    discoverDevices().catch(() => [] as DiscoveredDevice[]),
  ]);

  // Build MAC → local device lookup
  const localByMac = new Map<string, DiscoveredDevice>();
  for (const d of localDevices) {
    if (d.mac) localByMac.set(d.mac, d);
  }

  const merged: MergedDevice[] = cloudDevices.map((cd) => {
    const mac = normalizeMac(cd.deviceMac || '');
    const local = localByMac.get(mac);
    const isSmartDevice = cd.deviceType.startsWith('SMART.');

    return {
      deviceId: cd.deviceId,
      alias: decodeAlias(cd.alias, cd.deviceType),
      deviceType: cd.deviceType,
      deviceModel: cd.deviceModel,
      cloudStatus: cd.status,
      localIp: local?.ip ?? null,
      locallyReachable: !!local,
      relayState: local?.relayState ?? null,
      isSmartDevice,
    };
  });

  cachedDevices = merged;
  cacheTime = Date.now();
  return merged;
}

function findDevice(devices: MergedDevice[], query: string): MergedDevice {
  const q = query.toLowerCase();
  const match = devices.find(
    (d) => d.deviceId === query || d.alias.toLowerCase() === q || d.alias.toLowerCase().includes(q),
  );
  if (!match) {
    const names = devices.map((d) => `"${d.alias}"`).join(', ');
    throw new Error(`Device "${query}" not found. Available: ${names}`);
  }
  return match;
}

// ---------------------------------------------------------------------------
// MCP Tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'kasa', version: '2.0.0' });

server.tool(
  'kasa_list_devices',
  'List all Kasa smart home devices with their names, models, and status.',
  {},
  async () => {
    try {
      const devices = await getDevices();
      if (devices.length === 0) return { content: [{ type: 'text' as const, text: 'No Kasa devices found.' }] };

      const lines = devices.map((d) => {
        let status: string;
        if (d.cloudStatus === 1) {
          status = d.relayState === 1 ? 'on' : d.relayState === 0 ? 'off' : 'online';
        } else if (d.locallyReachable) {
          status = d.relayState === 1 ? 'on' : d.relayState === 0 ? 'off' : 'reachable';
        } else {
          status = 'offline';
        }
        const ip = d.localIp ? ` @ ${d.localIp}` : '';
        const smart = d.isSmartDevice ? ' [SMART]' : '';
        return `- ${d.alias} (${d.deviceModel}) — ${status}${ip}${smart}`;
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'kasa_set_power',
  'Turn a Kasa device on or off. Works for IOT devices via cloud. SMART devices require local network access.',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
    on: z.boolean().describe('true to turn on, false to turn off'),
  },
  async (args) => {
    try {
      const devices = await getDevices();
      const device = findDevice(devices, args.device);

      if (device.isSmartDevice) {
        return {
          content: [{
            type: 'text' as const,
            text: `${device.alias} is a SMART protocol device — cloud control is not supported for this device type. ` +
              `Local KLAP control requires TCP access on port 80 (currently blocked by network configuration).`,
          }],
          isError: true,
        };
      }

      const state = args.on ? 1 : 0;
      await passthrough(device, { system: { set_relay_state: { state } } });
      cachedDevices = null; // invalidate cache
      return { content: [{ type: 'text' as const, text: `${device.alias} turned ${args.on ? 'on' : 'off'}.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'kasa_set_brightness',
  'Set brightness on a dimmable Kasa device (bulb or dimmer switch). Also turns the device on. IOT devices only.',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
    brightness: z.number().min(1).max(100).describe('Brightness level 1–100'),
  },
  async (args) => {
    try {
      const devices = await getDevices();
      const device = findDevice(devices, args.device);

      if (device.isSmartDevice) {
        return {
          content: [{
            type: 'text' as const,
            text: `${device.alias} is a SMART protocol device — cloud brightness control is not supported. ` +
              `Local KLAP control requires TCP access on port 80.`,
          }],
          isError: true,
        };
      }

      await passthrough(device, { 'smartlife.iot.dimmer': { set_brightness: { brightness: args.brightness } } });
      await passthrough(device, { system: { set_relay_state: { state: 1 } } });
      cachedDevices = null;
      return { content: [{ type: 'text' as const, text: `${device.alias} brightness set to ${args.brightness}%.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'kasa_get_device_info',
  'Get the current status and details of a Kasa device (power state, brightness, voltage, current, etc.). IOT devices get full info from cloud; SMART devices show discovery data.',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
  },
  async (args) => {
    try {
      const devices = await getDevices();
      const device = findDevice(devices, args.device);

      if (device.isSmartDevice) {
        const info = {
          alias: device.alias,
          model: device.deviceModel,
          type: device.deviceType,
          localIp: device.localIp,
          locallyReachable: device.locallyReachable,
          cloudStatus: device.cloudStatus === 1 ? 'online' : 'cloud-offline',
          note: 'SMART device — full sysinfo requires local KLAP access (TCP port 80).',
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
      }

      const info = await passthrough(device, { system: { get_sysinfo: {} } });
      return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
