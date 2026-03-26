/**
 * Google Tasks MCP Server
 * Manages task lists and tasks via OAuth2 refresh token.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN!;

const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
oauth2.setCredentials({ refresh_token: refreshToken });

const tasks = google.tasks({ version: 'v1', auth: oauth2 });

const server = new McpServer({ name: 'tasks', version: '1.0.0' });

server.tool(
  'tasks_list_tasklists',
  'List all Google Tasks lists.',
  {},
  async () => {
    try {
      const res = await tasks.tasklists.list({ maxResults: 100 });
      const lists = res.data.items || [];
      if (lists.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No task lists found.' }] };
      }
      const lines = lists.map(
        (l) => `• *${l.title}* [id: ${l.id}]`,
      );
      return { content: [{ type: 'text' as const, text: `Task lists:\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'tasks_list_tasks',
  'List tasks in a task list. Shows title, status (needsAction/completed), due date, and notes.',
  {
    tasklist: z.string().default('@default').describe('Task list ID (use "@default" for the default list)'),
    show_completed: z.boolean().default(false).describe('Include completed tasks'),
  },
  async (args) => {
    try {
      const res = await tasks.tasks.list({
        tasklist: args.tasklist,
        maxResults: 100,
        showCompleted: args.show_completed,
        showHidden: args.show_completed,
      });
      const items = res.data.items || [];
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };
      }
      const lines = items.map((t) => {
        const status = t.status === 'completed' ? '✅' : '⬜';
        const due = t.due ? ` (due: ${t.due.split('T')[0]})` : '';
        const notes = t.notes ? `\n   ${t.notes.slice(0, 100)}` : '';
        return `${status} ${t.title}${due}${notes} [id: ${t.id}]`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'tasks_create',
  'Create a new task in a task list.',
  {
    title: z.string().describe('Task title'),
    notes: z.string().optional().describe('Additional notes/details'),
    due: z.string().optional().describe('Due date in YYYY-MM-DD format'),
    tasklist: z.string().default('@default').describe('Task list ID'),
  },
  async (args) => {
    try {
      const body: { title: string; notes?: string; due?: string } = { title: args.title };
      if (args.notes) body.notes = args.notes;
      if (args.due) body.due = `${args.due}T00:00:00.000Z`;
      const res = await tasks.tasks.insert({ tasklist: args.tasklist, requestBody: body });
      return { content: [{ type: 'text' as const, text: `Created: "${res.data.title}" [id: ${res.data.id}]` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'tasks_complete',
  'Mark a task as completed.',
  {
    task: z.string().describe('Task ID'),
    tasklist: z.string().default('@default').describe('Task list ID'),
  },
  async (args) => {
    try {
      const existing = await tasks.tasks.get({ tasklist: args.tasklist, task: args.task });
      await tasks.tasks.update({
        tasklist: args.tasklist,
        task: args.task,
        requestBody: { ...existing.data, status: 'completed' },
      });
      return { content: [{ type: 'text' as const, text: `Completed: "${existing.data.title}"` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'tasks_delete',
  'Delete a task.',
  {
    task: z.string().describe('Task ID'),
    tasklist: z.string().default('@default').describe('Task list ID'),
  },
  async (args) => {
    try {
      await tasks.tasks.delete({ tasklist: args.tasklist, task: args.task });
      return { content: [{ type: 'text' as const, text: 'Task deleted.' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'tasks_update',
  'Update a task (title, notes, due date).',
  {
    task: z.string().describe('Task ID'),
    title: z.string().optional().describe('New title'),
    notes: z.string().optional().describe('New notes'),
    due: z.string().optional().describe('New due date (YYYY-MM-DD) or empty to clear'),
    tasklist: z.string().default('@default').describe('Task list ID'),
  },
  async (args) => {
    try {
      const existing = await tasks.tasks.get({ tasklist: args.tasklist, task: args.task });
      const body = { ...existing.data };
      if (args.title !== undefined) body.title = args.title;
      if (args.notes !== undefined) body.notes = args.notes;
      if (args.due !== undefined) body.due = args.due ? `${args.due}T00:00:00.000Z` : undefined;
      await tasks.tasks.update({ tasklist: args.tasklist, task: args.task, requestBody: body });
      return { content: [{ type: 'text' as const, text: `Updated: "${body.title}"` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
