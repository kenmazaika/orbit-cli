// orbit — universal CLI for the Orbit object API.
// Agent-agnostic: talks only to /api/v1. Bridge execution is an adapter.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const VERSION = '0.1.0';
const CONFIG = process.env.ORBIT_CONFIG || join(homedir(), '.config', 'orbit', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, code = 1) {
  console.error(`orbit: ${message}`);
  process.exit(code);
}

function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG)) { try { cfg = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch {} }
  const baseUrl = process.env.ORBIT_URL || cfg.baseUrl;
  const token = process.env.ORBIT_TOKEN || cfg.token;
  return { baseUrl, token, ...cfg, ...(process.env.ORBIT_URL ? { baseUrl } : {}), ...(process.env.ORBIT_TOKEN ? { token } : {}) };
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  chmodSync(CONFIG, 0o600);
}

class Client {
  constructor({ baseUrl, token }) {
    if (!baseUrl) fail('no base URL. Run: orbit login --url https://orbit.example.com --token <token>', 3);
    if (!token) fail('no token. Run: orbit login ... or set ORBIT_TOKEN', 3);
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }
  async req(method, path, { body, query } = {}) {
    const url = new URL(this.baseUrl + '/api/v1' + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status} ${data.error || ''}`.trim());
      err.status = res.status; err.code = data.error; err.data = data;
      throw err;
    }
    return data;
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, body, o) { return this.req('POST', p, { ...o, body }); }
  patch(p, body, o) { return this.req('PATCH', p, { ...o, body }); }
}

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      let value;
      if (inline !== undefined) value = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) value = argv[++i];
      else value = true;
      if (out.flags[k] === undefined) out.flags[k] = value;
      else if (Array.isArray(out.flags[k])) out.flags[k].push(value);
      else out.flags[k] = [out.flags[k], value];
    } else out._.push(a);
  }
  return out;
}

function print(data, flags) {
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  if (data?.object) return print(data.object, flags);
  if (Array.isArray(data)) { for (const row of data) console.log(fmtRow(row)); return; }
  if (data?.objects) return print(data.objects, flags);
  if (data?.dispatch) return print(data.dispatch, flags);
  if (data?.dispatches) {
    for (const d of data.dispatches) console.log(`${d.published_at || '-'}\t${d.status}\t${d.slug}\t${d.title}`);
    return;
  }
  if (data?.item) return print(data.item, flags);
  if (data?.items) return print(data.items, flags);
  if (data?.active && data?.outbox) {
    console.log('ACTIVE'); print(data.active, flags); console.log('OUTBOX'); print(data.outbox, flags); return;
  }
  if (data?.artifacts) { for (const a of data.artifacts) console.log(`${a.id}\tV${a.current_number}\t${a.closed_at ? 'closed' : 'open'}\t${a.title}`); return; }
  if (data?.revisions) { for (const r of data.revisions) console.log(`V${r.number}\t${r.created_at}\t${r.source}\t${r.id}`); return; }
  if (data?.relations) { for (const r of data.relations) console.log(`${r.relation}\t${r.from_object_id} -> ${r.to_object_id}`); return; }
  if (data?.requests) { for (const r of data.requests) console.log(`${r.id}\t${r.kind}\t${r.status}\t${r.article_id || r.object_id}\t${(r.text || '').slice(0, 80)}`); return; }
  if (data?.actions) { for (const a of data.actions) console.log(`${a.id}\t${a.status}\t${a.action || a.request_kind}\t${a.object_id}`); return; }
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function fmtRow(o) {
  return [o.id, o.kind, o.status, o.title].filter(Boolean).join('\t');
}

function readBody(flags) {
  if (flags.file) return readFileSync(flags.file, 'utf8');
  if (flags.stdin) return readFileSync(0, 'utf8');
  return flags.text || flags.content || '';
}

function repeated(flags, key) {
  const raw = flags[key] === undefined ? [] : Array.isArray(flags[key]) ? flags[key] : [flags[key]];
  return raw.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
}

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return text;
}

function listValue(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map(unquote).map((x) => x.trim()).filter(Boolean);
  }
  return [unquote(text)];
}

export function parseFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    const key = field[1]; const value = field[2];
    data[key] = ['tags', 'source_urls', 'sources'].includes(key) ? listValue(value) : unquote(value);
  }
  return data;
}

export function markdownUrls(markdown) {
  return [...new Set((String(markdown || '').match(/https?:\/\/[^\s)>\]"']+/g) || [])
    .map((url) => url.replace(/[.,;:!?]+$/, '')))];
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isoDate(value) {
  if (!value) return undefined;
  const date = new Date(String(value).length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function dispatchInput(flags, fileArg) {
  const path = flags.file || fileArg;
  let content;
  if (flags.stdin || path === '-') content = readFileSync(0, 'utf8');
  else if (path) content = readFileSync(path, 'utf8');
  else content = flags.text || flags.content || '';
  const fm = parseFrontmatter(content);
  const title = flags.title || fm.title;
  const slug = flags.slug || fm.slug || (path && path !== '-' ? basename(path).replace(/\.(md|markdown)$/i, '') : slugify(title));
  const tags = [...repeated(flags, 'tag'), ...listValue(fm.tags || ''), ...(fm.category ? [fm.category] : [])];
  const sources = [...repeated(flags, 'source'), ...listValue(fm.source_urls || fm.sources || ''), ...markdownUrls(content)];
  return {
    slug, title, content,
    summary: flags.summary || fm.summary || fm.description || fm.subtitle || '',
    tags: [...new Set(tags)], source_urls: [...new Set(sources)],
    author: flags.author || fm.author || 'Ken',
    published_at: isoDate(flags['published-at'] || fm.published_at || fm.pubDate || fm.date),
    legacy_path: flags['legacy-path'] !== undefined
      ? (flags['legacy-path'] === true ? null : flags['legacy-path'])
      : (path && path !== '-' ? path : null),
    idempotencyKey: flags['idempotency-key'] || null,
    source: flags.source === 'import' ? 'import' : 'cli',
  };
}

async function main() {
  const { _, flags } = parse(process.argv.slice(2));
  const [rawGroup, cmd, ...rest] = _;
  const group = rawGroup === 'article' ? 'dispatch' : rawGroup;
  const cfg = loadConfig();

  if (!group || group === 'help' || flags.help) {
    console.log(`orbit ${VERSION}\n\n` +
      '  orbit login --url <base> --token <token>\n  orbit status | config show\n' +
      '  orbit object create|get|list|update|revisions|relations\n' +
      '  orbit artifact create|show|revisions|revise|feedback\n' +
      '  orbit dispatch publish <file>|list|show|revise|archive\n' +
      '  orbit article ...  (compatibility alias for dispatch)\n' +
      '  orbit inbox send|list|show|respond|close|submit\n' +
      '  orbit actions pending|claim|progress|complete|fail\n' +
      '  orbit watch [--object <id>] [--interval 2]\n' +
      '  orbit bridge run|status\n\nFlags: --json  --file  --stdin  --text');
    return 0;
  }

  if (group === 'login') {
    const baseUrl = String(flags.url || '').replace(/\/$/, '');
    const token = String(flags.token || '');
    if (!baseUrl || !token) fail('usage: orbit login --url <base> --token <token>', 2);
    saveConfig({ baseUrl, token });
    console.log(`saved ${CONFIG}`);
    return 0;
  }
  if (group === 'config' && cmd === 'show') {
    console.log(JSON.stringify({ config: CONFIG, baseUrl: cfg.baseUrl, token: cfg.token ? '***' : null }, null, 2));
    return 0;
  }
  if (group === 'status') {
    const c = new Client(cfg);
    const me = await c.get('/objects', { query: { limit: 1 } });
    console.log(JSON.stringify({ ok: true, baseUrl: c.baseUrl, objects: me.objects?.length ?? 0 }, null, 2));
    return 0;
  }

  const c = new Client(cfg);

  if (group === 'object') {
    if (cmd === 'create') {
      const body = { kind: flags.kind, title: flags.title, externalId: flags['external-id'], data: flags.data ? JSON.parse(flags.data) : undefined };
      if (!body.kind || !body.title) fail('usage: orbit object create --kind <kind> --title <t> [--external-id <id>] [--data json]', 2);
      print(await c.post('/objects', body), flags); return 0;
    }
    if (cmd === 'get') { print(await c.get(`/objects/${encodeURIComponent(rest[0])}`), flags); return 0; }
    if (cmd === 'list') { print(await c.get('/objects', { query: { kind: flags.kind, status: flags.status, limit: flags.limit, offset: flags.offset } }), flags); return 0; }
    if (cmd === 'update') {
      const body = { title: flags.title, status: flags.status, data: flags.data ? JSON.parse(flags.data) : undefined };
      print(await c.patch(`/objects/${encodeURIComponent(rest[0])}`, body), flags); return 0;
    }
    if (cmd === 'revisions') {
      if (flags.create) print(await c.post(`/objects/${encodeURIComponent(rest[0])}/revisions`, { content: readBody(flags), source: flags.source }), flags);
      else print(await c.get(`/objects/${encodeURIComponent(rest[0])}/revisions`), flags);
      return 0;
    }
    if (cmd === 'relations') {
      if (flags.add) print(await c.post(`/objects/${encodeURIComponent(rest[0])}/relations`, { toObjectId: flags.to, relation: flags.relation }), flags);
      else print(await c.get(`/objects/${encodeURIComponent(rest[0])}/relations`), flags);
      return 0;
    }
    fail(`unknown object command: ${cmd}`, 2);
  }

  if (group === 'artifact') {
    if (cmd === 'create') {
      print(await c.post('/objects', { kind: 'orbit.artifact', title: flags.title || rest[0], externalId: flags.id || flags['external-id'], data: {} }), flags); return 0;
    }
    if (cmd === 'show') { print(await c.get(`/artifacts/${encodeURIComponent(rest[0])}`), flags); return 0; }
    if (cmd === 'revisions') { print(await c.get(`/artifacts/${encodeURIComponent(rest[0])}/revisions`), flags); return 0; }
    if (cmd === 'revise') {
      const state = await c.get(`/artifacts/${encodeURIComponent(rest[0])}`);
      print(await c.post(`/artifacts/${encodeURIComponent(rest[0])}/revisions`, {
        markdown: readBody(flags), source: 'cli', expectedRevisionId: state.currentRevisionId,
      }), flags); return 0;
    }
    if (cmd === 'feedback') {
      print(await c.post(`/artifacts/${encodeURIComponent(rest[0])}/feedback`, {
        text: flags.text || readBody(flags), idempotencyKey: flags['idempotency-key'] || `cli-${Date.now()}`,
      }), flags); return 0;
    }
    fail(`unknown artifact command: ${cmd}`, 2);
  }

  if (group === 'dispatch') {
    if (cmd === 'publish' || cmd === 'create') {
      const input = dispatchInput(flags, rest[0]);
      if (!input.title || !input.slug || !input.content) {
        fail('usage: orbit dispatch publish <file|-> [--title t] [--summary s] [--tag t] [--source url] [--slug s] [--draft]', 2);
      }
      const made = await c.post('/dispatches', input);
      if (flags.draft || cmd === 'create') { print(made, flags); return 0; }
      const published = await c.post(`/dispatches/${encodeURIComponent(made.dispatch.id)}/publish`, {
        published_at: input.published_at, published_from: flags['published-from'],
      });
      print(published, flags); return 0;
    }
    if (cmd === 'list') {
      print(await c.get('/dispatches', { query: {
        status: flags.status || 'published', limit: flags.limit, offset: flags.offset,
      } }), flags); return 0;
    }
    if (cmd === 'show') {
      print(await c.get(`/dispatches/${encodeURIComponent(rest[0])}`), flags); return 0;
    }
    if (cmd === 'revise') {
      const id = rest[0];
      if (!id) fail('usage: orbit dispatch revise <id-or-slug> <file|->', 2);
      const state = await c.get(`/dispatches/${encodeURIComponent(id)}`);
      const content = dispatchInput(flags, rest[1]).content;
      if (!content) fail('dispatch revision content is empty', 2);
      print(await c.post(`/dispatches/${encodeURIComponent(id)}/revisions`, {
        content, source: flags.source || 'cli', expectedRevisionId: flags['expected-revision'] || state.dispatch.currentRevisionId,
      }), flags); return 0;
    }
    if (cmd === 'archive') {
      print(await c.post(`/dispatches/${encodeURIComponent(rest[0])}/archive`, {}), flags); return 0;
    }
    fail(`unknown dispatch command: ${cmd}`, 2);
  }

  if (group === 'inbox') {
    if (cmd === 'send') {
      const body = flags.text || readBody(flags);
      const actions = [...repeated(flags, 'actions'), ...repeated(flags, 'options')];
      const type = flags.type || (actions.length || flags.instruction ? 'decision' : 'message');
      if (!['message', 'decision'].includes(type)) fail('inbox send --type must be message or decision', 2);
      print(await c.post('/inbox', {
        type, title: flags.title || (body || '').slice(0, 80) || '(untitled)', body,
        choices: actions, instruction: flags.instruction === true ? '' : flags.instruction,
        externalId: flags.id, source: flags.source || 'cli',
      }), flags); return 0;
    }
    if (cmd === 'list') { print(await c.get('/inbox', { query: { scope: flags.scope || flags.status || 'all' } }), flags); return 0; }
    if (cmd === 'show') { print(await c.get(`/inbox/${encodeURIComponent(rest[0])}`), flags); return 0; }
    if (cmd === 'respond') {
      const body = {};
      if (flags.actions !== undefined) body.choices = repeated(flags, 'actions');
      if (flags.instruction !== undefined || flags.text !== undefined || flags.file || flags.stdin) {
        body.instruction = flags.instruction === true ? '' : flags.instruction || flags.text || readBody(flags);
      }
      print(await c.patch(`/inbox/${encodeURIComponent(rest[0])}/selections`, body), flags); return 0;
    }
    if (cmd === 'submit') {
      const body = { idempotencyKey: flags['idempotency-key'] || `cli-${Date.now()}` };
      if (flags.actions !== undefined) body.choices = repeated(flags, 'actions');
      if (flags.instruction !== undefined || flags.text !== undefined || flags.file || flags.stdin) {
        body.instruction = flags.instruction === true ? '' : flags.instruction || flags.text || readBody(flags);
      }
      print(await c.post(`/inbox/${encodeURIComponent(rest[0])}/submit`, body), flags); return 0;
    }
    if (cmd === 'close') {
      print(await c.post(`/inbox/${encodeURIComponent(rest[0])}/close`, {}), flags); return 0;
    }
    fail(`unknown inbox command: ${cmd}`, 2);
  }

  if (group === 'actions') {
    if (cmd === 'pending') { print(await c.get('/agent/actions', { query: { limit: flags.limit } }), flags); return 0; }
    const act = { claim: 'claim', progress: 'progress', complete: 'complete', fail: 'fail' }[cmd];
    if (!act) fail(`unknown actions command: ${cmd}`, 2);
    const body = cmd === 'progress' ? { message: flags.message || flags.text, reply: flags.message || flags.text }
      : cmd === 'fail' ? { error: flags.error || 'failed', retryable: flags.retryable !== 'false' }
      : cmd === 'complete' ? { reply: flags.message, revisionId: flags.revision } : { worker: flags.worker || 'orbit-cli' };
    print(await c.post(`/agent/actions/${encodeURIComponent(rest[0])}/${act}`, body), flags); return 0;
  }

  if (group === 'watch') {
    const interval = Number(flags.interval || 2) * 1000;
    let last = '';
    for (;;) {
      const id = flags.object || rest[0];
      const data = id ? await c.get(`/artifacts/${encodeURIComponent(id)}`) : await c.get('/objects', { query: { limit: 20 } });
      const sig = JSON.stringify(id ? { n: data.currentNumber, a: data.activeRequest?.status, e: data.events?.length } : data.objects?.map((o) => [o.id, o.updatedAt]));
      if (sig !== last) { last = sig; console.log(JSON.stringify({ at: new Date().toISOString(), data })); }
      await sleep(interval);
    }
  }

  if (group === 'bridge') {
    if (cmd === 'status') {
      const q = await c.get('/agent/actions');
      const pending = q.requests?.length || 0;
      const { status = 'unknown' } = {}; // service state is adapter-specific
      console.log(JSON.stringify({ ok: true, pending, transport: 'poll', intervalSeconds: 2, service: 'orbit-artifact-bridge.service', state: status }, null, 2));
      return 0;
    }
    if (cmd === 'run') {
      const script = flags.script || join(homedir(), 'orbit-blog', 'poc', 'artifact-review', 'orbit-artifact-agent.mjs');
      const child = spawn(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, ORBIT_BASE: cfg.baseUrl, ORBIT_ARTIFACT_BRIDGE_TOKEN: cfg.token } });
      child.on('exit', (code) => process.exit(code ?? 1));
      return 0;
    }
    fail(`unknown bridge command: ${cmd}`, 2);
  }

  fail(`unknown command: ${group} ${cmd || ''}`, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    if (e.status === 401) fail('unauthorized — check your token (orbit login)', 3);
    fail(e.message || String(e), 1);
  });
}
