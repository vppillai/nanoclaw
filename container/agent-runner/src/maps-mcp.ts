/**
 * Google Maps MCP Server
 * Provides directions, geocoding, and nearby places search.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.GOOGLE_MAPS_API_KEY!;
const BASE = 'https://maps.googleapis.com/maps/api';

async function mapsFetch(endpoint: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE}/${endpoint}/json`);
  url.searchParams.set('key', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString());
  return resp.json();
}

const server = new McpServer({ name: 'maps', version: '1.0.0' });

server.tool(
  'maps_directions',
  'Get driving/walking/transit directions between two locations. Returns step-by-step directions with distance and duration.',
  {
    origin: z.string().describe('Starting location (address or place name)'),
    destination: z.string().describe('Destination (address or place name)'),
    mode: z.enum(['driving', 'walking', 'bicycling', 'transit']).default('driving').describe('Travel mode'),
  },
  async (args) => {
    try {
      const data = await mapsFetch('directions', {
        origin: args.origin,
        destination: args.destination,
        mode: args.mode,
      }) as { status: string; routes?: Array<{ legs: Array<{ distance: { text: string }; duration: { text: string }; steps: Array<{ html_instructions: string; distance: { text: string }; duration: { text: string } }> }> }> };

      if (data.status !== 'OK' || !data.routes?.length) {
        return { content: [{ type: 'text' as const, text: `No route found (${data.status})` }], isError: true };
      }

      const leg = data.routes[0].legs[0];
      const steps = leg.steps.map((s, i) => {
        const instruction = s.html_instructions.replace(/<[^>]+>/g, '');
        return `${i + 1}. ${instruction} (${s.distance.text}, ${s.duration.text})`;
      }).join('\n');

      return { content: [{ type: 'text' as const, text: `${args.origin} → ${args.destination}\nDistance: ${leg.distance.text} | Duration: ${leg.duration.text} | Mode: ${args.mode}\n\n${steps}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'maps_geocode',
  'Convert an address or place name to coordinates, or coordinates to an address.',
  {
    address: z.string().optional().describe('Address or place name to geocode'),
    latlng: z.string().optional().describe('Coordinates to reverse geocode (e.g. "49.2827,-123.1207")'),
  },
  async (args) => {
    try {
      const params: Record<string, string> = {};
      if (args.address) params.address = args.address;
      if (args.latlng) params.latlng = args.latlng;

      const data = await mapsFetch('geocode', params) as {
        status: string;
        results?: Array<{ formatted_address: string; geometry: { location: { lat: number; lng: number } } }>;
      };

      if (data.status !== 'OK' || !data.results?.length) {
        return { content: [{ type: 'text' as const, text: `Not found (${data.status})` }], isError: true };
      }

      const results = data.results.slice(0, 3).map(r =>
        `${r.formatted_address} (${r.geometry.location.lat}, ${r.geometry.location.lng})`
      ).join('\n');

      return { content: [{ type: 'text' as const, text: results }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'maps_nearby',
  'Search for nearby places (restaurants, gas stations, hospitals, etc.) around a location.',
  {
    location: z.string().describe('Center point (address, place name, or "lat,lng")'),
    query: z.string().describe('What to search for (e.g. "pizza", "gas station", "pharmacy")'),
    radius: z.number().default(5000).describe('Search radius in meters (default 5000)'),
  },
  async (args) => {
    try {
      // Geocode location first if it's not coordinates
      let latlng = args.location;
      if (!/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(latlng)) {
        const geo = await mapsFetch('geocode', { address: args.location }) as {
          status: string;
          results?: Array<{ geometry: { location: { lat: number; lng: number } } }>;
        };
        if (geo.status !== 'OK' || !geo.results?.length) {
          return { content: [{ type: 'text' as const, text: `Could not find location: ${args.location}` }], isError: true };
        }
        const loc = geo.results[0].geometry.location;
        latlng = `${loc.lat},${loc.lng}`;
      }

      const url = new URL(`${BASE}/place/textsearch/json`);
      url.searchParams.set('key', API_KEY);
      url.searchParams.set('query', args.query);
      url.searchParams.set('location', latlng);
      url.searchParams.set('radius', String(args.radius));

      const resp = await fetch(url.toString());
      const data = await resp.json() as {
        status: string;
        results?: Array<{ name: string; formatted_address: string; rating?: number; user_ratings_total?: number; opening_hours?: { open_now?: boolean } }>;
      };

      if (data.status !== 'OK' || !data.results?.length) {
        return { content: [{ type: 'text' as const, text: `No results for "${args.query}" near ${args.location}` }] };
      }

      const places = data.results.slice(0, 8).map((p, i) => {
        const rating = p.rating ? `${p.rating}★ (${p.user_ratings_total} reviews)` : '';
        const open = p.opening_hours?.open_now !== undefined ? (p.opening_hours.open_now ? 'Open' : 'Closed') : '';
        const details = [rating, open].filter(Boolean).join(' | ');
        return `${i + 1}. ${p.name} — ${p.formatted_address}${details ? `\n   ${details}` : ''}`;
      }).join('\n');

      return { content: [{ type: 'text' as const, text: `"${args.query}" near ${args.location}:\n\n${places}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
