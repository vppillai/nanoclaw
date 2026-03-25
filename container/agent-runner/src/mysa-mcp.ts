/**
 * Mysa Thermostat MCP Server
 * Controls Mysa smart thermostats via the mysa-js-sdk cloud API.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MysaApiClient, type MysaSession, type MysaDeviceMode } from 'mysa-js-sdk';
import fs from 'fs';

const email = process.env.MYSA_EMAIL!;
const password = process.env.MYSA_PASSWORD!;
const SESSION_FILE = '/tmp/mysa-session.json';

let client: MysaApiClient | null = null;

async function getClient(): Promise<MysaApiClient> {
  if (client) return client;

  let savedSession: MysaSession | undefined;
  try {
    if (fs.existsSync(SESSION_FILE)) {
      savedSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as MysaSession;
    }
  } catch { /* ignore */ }

  client = new MysaApiClient(savedSession);

  client.emitter.on('sessionChanged', (session: MysaSession | undefined) => {
    try {
      if (session) fs.writeFileSync(SESSION_FILE, JSON.stringify(session));
    } catch { /* ignore */ }
  });

  await client.login(email, password);
  return client;
}

function formatTemp(tv: { v: number } | undefined): string {
  if (tv == null) return 'unknown';
  return `${tv.v.toFixed(1)}°C`;
}

function findDeviceId(devicesObj: Record<string, { Name?: string }>, query: string): string {
  const q = query.toLowerCase();
  if (devicesObj[query]) return query;
  const entries = Object.entries(devicesObj);
  const match = entries.find(
    ([id, d]) => id === query || (d.Name ?? '').toLowerCase() === q || (d.Name ?? '').toLowerCase().includes(q),
  );
  if (match) return match[0];
  const names = entries.map(([, d]) => `"${d.Name ?? '?'}"`).join(', ');
  throw new Error(`Device "${query}" not found. Available: ${names}`);
}

const server = new McpServer({ name: 'mysa', version: '1.0.0' });

server.tool(
  'mysa_list_devices',
  'List all Mysa thermostats with their current temperature, setpoint, mode, and humidity.',
  {},
  async () => {
    try {
      const c = await getClient();
      const [devicesRes, statesRes] = await Promise.all([c.getDevices(), c.getDeviceStates()]);
      const devicesObj = devicesRes.DevicesObj;
      const statesObj = statesRes.DeviceStatesObj;

      if (Object.keys(devicesObj).length === 0) {
        return { content: [{ type: 'text' as const, text: 'No Mysa devices found.' }] };
      }

      const lines = Object.entries(devicesObj).map(([id, dev]) => {
        const state = statesObj[id];
        const temp = formatTemp(state?.CorrectedTemp ?? state?.SensorTemp);
        const setpoint = formatTemp(state?.SetPoint);
        const humidity = state?.Humidity?.v;
        const humStr = humidity != null ? `, ${Math.round(humidity)}% humidity` : '';
        return `• *${(dev as any).Name ?? id}* — ${temp} (setpoint: ${setpoint}${humStr}) [id: ${id}]`;
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'mysa_set_temperature',
  'Set the target temperature on a Mysa thermostat.',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
    temperature: z.number().min(5).max(35).describe('Target temperature in °C'),
  },
  async (args) => {
    try {
      const c = await getClient();
      const devicesObj = (await c.getDevices()).DevicesObj;
      const id = findDeviceId(devicesObj as any, args.device);
      await c.setDeviceState(id, args.temperature);
      return { content: [{ type: 'text' as const, text: `${(devicesObj as any)[id]?.Name ?? id} setpoint set to ${args.temperature}°C.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'mysa_set_mode',
  'Set the mode on a Mysa thermostat (heat, off, auto, cool, fan_only, dry).',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
    mode: z.enum(['heat', 'off', 'auto', 'cool', 'fan_only', 'dry']).describe('Thermostat mode'),
  },
  async (args) => {
    try {
      const c = await getClient();
      const devicesObj = (await c.getDevices()).DevicesObj;
      const id = findDeviceId(devicesObj as any, args.device);
      await c.setDeviceState(id, undefined, args.mode as MysaDeviceMode);
      return { content: [{ type: 'text' as const, text: `${(devicesObj as any)[id]?.Name ?? id} mode set to ${args.mode}.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'mysa_get_device_info',
  'Get detailed status of a specific Mysa thermostat (temperature, setpoint, mode, humidity, etc.).',
  {
    device: z.string().describe('Device name or ID (partial match supported)'),
  },
  async (args) => {
    try {
      const c = await getClient();
      const [devicesRes, statesRes] = await Promise.all([c.getDevices(), c.getDeviceStates()]);
      const devicesObj = devicesRes.DevicesObj;
      const statesObj = statesRes.DeviceStatesObj;
      const id = findDeviceId(devicesObj as any, args.device);
      const info = { name: (devicesObj as any)[id]?.Name, id, state: statesObj[id] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
