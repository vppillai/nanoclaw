/**
 * Google Calendar MCP Server — service account auth
 * Provides tools to list, create, update, and delete calendar events.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — service account key JSON (base64-encoded or raw)
 *   GOOGLE_CALENDAR_ID           — calendar ID (e.g. family calendar ID or 'primary')
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';

const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON!;
const familyCalendarId = process.env.GOOGLE_FAMILY_CALENDAR_ID || 'primary';
const personalCalendarId = process.env.GOOGLE_PERSONAL_CALENDAR_ID || '';

// All configured calendars with labels
const calendars: Array<{ id: string; label: string }> = [
  { id: familyCalendarId, label: 'Family' },
  ...(personalCalendarId ? [{ id: personalCalendarId, label: 'Personal' }] : []),
];

function getAuth() {
  let keyJson: string;
  try {
    // Support base64-encoded JSON (avoids newline issues in env vars)
    keyJson = Buffer.from(rawJson, 'base64').toString('utf-8');
    JSON.parse(keyJson); // validate
  } catch {
    keyJson = rawJson; // assume raw JSON
  }
  const key = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

const auth = getAuth();
const cal = google.calendar({ version: 'v3', auth });

function formatEventWithCalendar(e: Parameters<typeof formatEvent>[0], calendarLabel: string): string {
  return `[${calendarLabel}] ${formatEvent(e)}`;
}

function formatEvent(e: {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  attendees?: Array<{ email?: string | null; displayName?: string | null }> | null;
  htmlLink?: string | null;
}): string {
  const start = e.start?.dateTime || e.start?.date || 'unknown';
  const end = e.end?.dateTime || e.end?.date || '';
  const attendees = e.attendees?.map(a => a.displayName || a.email).join(', ') || '';
  return [
    `ID: ${e.id}`,
    `Title: ${e.summary || '(no title)'}`,
    `Start: ${start}`,
    end ? `End: ${end}` : '',
    e.location ? `Location: ${e.location}` : '',
    e.description ? `Description: ${e.description}` : '',
    attendees ? `Attendees: ${attendees}` : '',
  ].filter(Boolean).join('\n');
}

const server = new McpServer({ name: 'gcal', version: '1.0.0' });

server.tool(
  'calendar_list_events',
  'List upcoming calendar events from all configured calendars (Family and Personal). Returns events sorted by start time, labeled by calendar.',
  {
    maxResults: z.number().min(1).max(50).default(10).describe('Max number of events to return per calendar (default 10)'),
    timeMin: z.string().optional().describe('Start of time range (ISO 8601). Defaults to now.'),
    timeMax: z.string().optional().describe('End of time range (ISO 8601). Defaults to 30 days from now.'),
    query: z.string().optional().describe('Free-text search filter'),
  },
  async (args) => {
    try {
      const now = new Date();
      const thirtyDaysOut = new Date(now.getTime() + 30 * 86400_000);
      const timeMin = args.timeMin || now.toISOString();
      const timeMax = args.timeMax || thirtyDaysOut.toISOString();

      const results = await Promise.all(
        calendars.map(async ({ id, label }) => {
          const res = await cal.events.list({
            calendarId: id,
            timeMin,
            timeMax,
            maxResults: args.maxResults,
            singleEvents: true,
            orderBy: 'startTime',
            q: args.query,
          });
          return { label, events: res.data.items || [] };
        }),
      );

      // Merge and sort all events by start time
      const allEvents: Array<{ label: string; event: (typeof results)[0]['events'][0]; startMs: number }> = [];
      for (const { label, events } of results) {
        for (const e of events) {
          const start = e.start?.dateTime || e.start?.date || '';
          allEvents.push({ label, event: e, startMs: start ? new Date(start).getTime() : 0 });
        }
      }
      allEvents.sort((a, b) => a.startMs - b.startMs);

      if (allEvents.length === 0) return { content: [{ type: 'text' as const, text: 'No events found.' }] };
      const text = allEvents.map(({ label, event }) => formatEventWithCalendar(event, label)).join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'calendar_create_event',
  'Create a new calendar event. Use calendarType to specify "family" or "personal" (defaults to "family").',
  {
    title: z.string().describe('Event title'),
    startDateTime: z.string().describe('Start time (ISO 8601, e.g. 2026-03-25T14:00:00-07:00)'),
    endDateTime: z.string().describe('End time (ISO 8601)'),
    description: z.string().optional().describe('Event description or notes'),
    location: z.string().optional().describe('Location'),
    attendees: z.array(z.string()).optional().describe('List of attendee email addresses'),
    timeZone: z.string().optional().describe('IANA time zone (e.g. America/Vancouver). Defaults to UTC.'),
    calendarType: z.enum(['family', 'personal']).optional().describe('Which calendar to create the event in (default: family)'),
  },
  async (args) => {
    try {
      const calId = args.calendarType === 'personal' && personalCalendarId ? personalCalendarId : familyCalendarId;
      const res = await cal.events.insert({
        calendarId: calId,
        requestBody: {
          summary: args.title,
          description: args.description,
          location: args.location,
          start: { dateTime: args.startDateTime, timeZone: args.timeZone || 'UTC' },
          end: { dateTime: args.endDateTime, timeZone: args.timeZone || 'UTC' },
          attendees: args.attendees?.map(email => ({ email })),
        },
      });
      return { content: [{ type: 'text' as const, text: `Event created.\n\n${formatEvent(res.data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'calendar_update_event',
  'Update an existing calendar event. Only provided fields are changed. Use calendarType to specify which calendar the event belongs to.',
  {
    eventId: z.string().describe('Event ID (from calendar_list_events)'),
    title: z.string().optional().describe('New title'),
    startDateTime: z.string().optional().describe('New start time (ISO 8601)'),
    endDateTime: z.string().optional().describe('New end time (ISO 8601)'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    timeZone: z.string().optional().describe('IANA time zone'),
    calendarType: z.enum(['family', 'personal']).optional().describe('Which calendar the event is in (default: family)'),
  },
  async (args) => {
    try {
      const calId = args.calendarType === 'personal' && personalCalendarId ? personalCalendarId : familyCalendarId;
      const existing = await cal.events.get({ calendarId: calId, eventId: args.eventId });
      const patch: Record<string, unknown> = {};
      if (args.title) patch.summary = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.location !== undefined) patch.location = args.location;
      if (args.startDateTime) patch.start = { dateTime: args.startDateTime, timeZone: args.timeZone || existing.data.start?.timeZone || 'UTC' };
      if (args.endDateTime) patch.end = { dateTime: args.endDateTime, timeZone: args.timeZone || existing.data.end?.timeZone || 'UTC' };
      const res = await cal.events.patch({ calendarId: calId, eventId: args.eventId, requestBody: patch });
      return { content: [{ type: 'text' as const, text: `Event updated.\n\n${formatEvent(res.data)}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'calendar_delete_event',
  'Delete a calendar event. Use calendarType to specify which calendar the event belongs to.',
  {
    eventId: z.string().describe('Event ID (from calendar_list_events)'),
    calendarType: z.enum(['family', 'personal']).optional().describe('Which calendar the event is in (default: family)'),
  },
  async (args) => {
    try {
      const calId = args.calendarType === 'personal' && personalCalendarId ? personalCalendarId : familyCalendarId;
      await cal.events.delete({ calendarId: calId, eventId: args.eventId });
      return { content: [{ type: 'text' as const, text: `Event ${args.eventId} deleted from ${args.calendarType || 'family'} calendar.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
