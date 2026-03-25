/**
 * Kasa MCP Server — TP-Link Kasa cloud control
 * Provides tools to list, control, and query Kasa smart home devices.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const KASA_API = 'https://wap.tplinkcloud.com';
const APP_TYPE = 'Kasa_Android';
const TERMINAL_UUID = 'nanoclaw-kasa-mcp';

const username = process.env.KASA_USERNAME!;
const password = process.env.KASA_PASSWORD!;

let cachedToken: string | null = null;

async function kasaRequest(body: object): Promise<unknown> {
  const res = await fetch(KASA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { error_code: number; msg?: string; result?: unknown };
  if (data.error_code !== 0) throw new Error(`Kasa error ${data.error_code}: ${data.msg ?? 'unknown'}`);
  return data.result;
}

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const result = (await kasaRequest({
    method: 'login',
    params: { appType: APP_TYPE, cloudUserName: username, cloudPassword: password, terminalUUID: TERMINAL_UUID },
  })) as { token: string };
  cachedToken = result.token;
  return cachedToken;
}

interface KasaDevice {
  deviceId: string;
  alias: string;
  deviceType: string;
  deviceModel: string;
  status: number;
  appServerUrl: string;
}

async function getDevices(): Promise<KasaDevice[]> {
  const token = await getToken();
  const result = (await kasaRequest({
    method: 'getDeviceList',
    params: { token },
  })) as { deviceList: KasaDevice[] };
  return result.deviceList;
}

async function passthrough(device: KasaDevice, command: object): Promise<unknown> {
  const token = await getToken();
  const result = (await kasaRequest({
    method: 'passthrough',
    params: { token, deviceId: device.deviceId, requestData: JSON.stringify(command) },
  })) as { responseData: string };
  return JSON.parse(result.responseData);
}

function findDevice(devices: KasaDevice[], query: string): KasaDevice {
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

const server = new McpServer({ name: 'kasa', version: '1.0.0' });

server.tool(
  'kasa_list_devices',
  'List all Kasa smart home devices with their names, IDs, and online status.',
  {},
  async () => {
    try {
      const devices = await getDevices();
      if (devices.length === 0) return { content: [{ type: 'text' as const, text: 'No Kasa devices found.' }] };
      const lines = devices.map(
        (d) => `- ${d.alias} (${d.deviceModel}) — ${d.status === 1 ? 'online' : 'offline'} [id: ${d.deviceId}]`,
      );
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'kasa_set_power',
  'Turn a Kasa device on or off.',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
    on: z.boolean().describe('true to turn on, false to turn off'),
  },
  async (args) => {
    try {
      const devices = await getDevices();
      const device = findDevice(devices, args.device);
      const state = args.on ? 1 : 0;
      await passthrough(device, { system: { set_relay_state: { state } } });
      return { content: [{ type: 'text' as const, text: `${device.alias} turned ${args.on ? 'on' : 'off'}.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'kasa_set_brightness',
  'Set brightness on a dimmable Kasa device (bulb or dimmer switch). Also turns the device on if it is off.',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
    brightness: z.number().min(1).max(100).describe('Brightness level 1–100'),
  },
  async (args) => {
    try {
      const devices = await getDevices();
      const device = findDevice(devices, args.device);
      await passthrough(device, { 'smartlife.iot.dimmer': { set_brightness: { brightness: args.brightness } } });
      await passthrough(device, { system: { set_relay_state: { state: 1 } } });
      return { content: [{ type: 'text' as const, text: `${device.alias} brightness set to ${args.brightness}%.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'kasa_get_device_info',
  'Get the current status and details of a Kasa device (power state, brightness, voltage, current, etc.).',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
  },
  async (args) => {
    try {
      const devices = await getDevices();
      const device = findDevice(devices, args.device);
      const info = await passthrough(device, { system: { get_sysinfo: {} } });
      return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
