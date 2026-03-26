/**
 * Host-side Kasa device discovery via python-kasa CLI.
 *
 * Runs on the NanoClaw host (not inside Docker) where UDP broadcasts
 * can reach LAN devices. Results are written to the group's IPC directory
 * as kasa_discovery.json for the container's kasa-mcp.ts to read.
 *
 * Uses python-kasa's Discover module which handles both IOT (port 9999)
 * and SMART (port 20002) protocols correctly.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';

const CACHE_TTL_MS = 15_000;

export interface DiscoveredDevice {
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

/**
 * Discover devices using python-kasa's raw discovery output.
 * This handles both IOT and SMART protocols automatically.
 */
async function discoverDevices(): Promise<DiscoveredDevice[]> {
  const raw = await runPythonKasaDiscover();
  return parsePythonKasaRawOutput(raw);
}

function runPythonKasaDiscover(): Promise<string> {
  return new Promise((resolve) => {
    // Try common paths for the kasa binary
    const kasaPaths = [
      path.join(process.env.HOME || '/root', '.local/bin/kasa'),
      '/usr/local/bin/kasa',
      '/usr/bin/kasa',
      'kasa',
    ];

    function tryPath(idx: number): void {
      if (idx >= kasaPaths.length) {
        resolve('[]'); // No kasa binary found
        return;
      }
      execFile(
        kasaPaths[idx],
        ['discover', 'raw'],
        { timeout: 15_000 },
        (err, stdout) => {
          if (err) {
            tryPath(idx + 1);
            return;
          }
          resolve(stdout);
        },
      );
    }

    tryPath(0);
  });
}

function parsePythonKasaRawOutput(raw: string): DiscoveredDevice[] {
  const devices: DiscoveredDevice[] = [];

  // The raw output is multiple JSON objects separated by whitespace
  // Each has { discovery_response: {...}, meta: { ip, port } }
  const jsonBlocks = raw
    .split(/\n(?=\{)/)
    .filter((s) => s.trim().startsWith('{'));

  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block);
      const meta = parsed.meta;
      const resp = parsed.discovery_response;
      if (!meta?.ip) continue;

      // IOT devices: have system.get_sysinfo with alias, relay_state, mac
      const sys = resp?.system?.get_sysinfo;
      if (sys) {
        devices.push({
          ip: meta.ip,
          mac: normalizeMac(sys.mac || ''),
          model: sys.model || '',
          deviceType: sys.type || sys.mic_type || 'IOT.SMARTPLUGSWITCH',
          alias: sys.alias,
          relayState: sys.relay_state,
        });
        continue;
      }

      // SMART devices: have result with device_type, device_model, mac
      const result = resp?.result;
      if (result?.device_type?.startsWith('SMART.')) {
        devices.push({
          ip: meta.ip,
          mac: normalizeMac(
            (result.mac || '').replace(/-/g, ':').replace(/:/g, ''),
          ),
          model: result.device_model || '',
          deviceType: result.device_type,
        });
      }
    } catch {
      /* skip malformed blocks */
    }
  }

  return devices;
}

// ---------------------------------------------------------------------------
// Cache + Snapshot Writer
// ---------------------------------------------------------------------------

let cachedDevices: DiscoveredDevice[] | null = null;
let cacheTime = 0;

async function getCachedDiscovery(): Promise<DiscoveredDevice[]> {
  if (cachedDevices && Date.now() - cacheTime < CACHE_TTL_MS)
    return cachedDevices;
  cachedDevices = await discoverDevices();
  cacheTime = Date.now();
  return cachedDevices;
}

/**
 * Run UDP discovery (cached) and write results to the group's IPC directory
 * as kasa_discovery.json for the container's kasa-mcp.ts to read.
 */
export async function writeKasaDiscoverySnapshot(
  groupFolder: string,
): Promise<void> {
  const devices = await getCachedDiscovery();
  const ipcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(ipcDir, { recursive: true });
  const filePath = path.join(ipcDir, 'kasa_discovery.json');
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      { devices, discoveredAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}
