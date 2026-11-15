// orbit — universal CLI for the Orbit object API.
// Agent-agnostic: talks only to /api/v1. Bridge execution is an adapter.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

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

async function main() {
  const { _, flags } = parse(process.argv.slice(2));
  const [group, cmd, ...rest] = _;
  const cfg = loadConfig();

  if (!group || group === 'help' || flags.help) {
    console.log(`orbit ${VERSION}\n\n` +
      '  orbit login --url <base> --token <token>\n  orbit status | config show\n' +
      '  orbit object create|get|list|update|revisions|relations\n' +
      '  orbit artifact create|show|revisions|revise|feedback\n' +
      '  orbit article create|publish|show|revise|feedback\n' +
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

  if (group === 'article') {
    if (cmd === 'create') {
      print(await c.post('/objects', { kind: 'orbit.document', title: flags.title || rest[0], externalId: flags.id, data: { surface: 'article' } }), flags); return 0;
    }
    if (cmd === 'publish' || cmd === 'revise') {
      const id = flags.id || rest[0];
      const state = await c.get(`/objects/${encodeURIComponent(id)}`);
      print(await c.post(`/objects/${encodeURIComponent(id)}/revisions`, {
        content: readBody(flags), source: flags.source || 'cli', expectedRevisionId: state.object?.currentRevisionId,
      }), flags); return 0;
    }
    if (cmd === 'show') { print(await c.get(`/objects/${encodeURIComponent(rest[0])}`), flags); return 0; }
    if (cmd === 'feedback') {
      print(await c.post(`/artifacts/${encodeURIComponent(rest[0])}/feedback`, {
        text: flags.text || readBody(flags), idempotencyKey: flags['idempotency-key'] || `cli-${Date.now()}`,
      }), flags); return 0;
    }
    fail(`unknown article command: ${cmd}`, 2);
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
      console.log(JSON.stringify({ ok: true, pending, transport: 'poll', intervalSeconds: 2, service: process.env.ORBIT_BRIDGE_SERVICE || 'orbit-bridge.service', state: status }, null, 2));
      return 0;
    }
    if (cmd === 'run') {
      const script = flags.script || process.env.ORBIT_BRIDGE_SCRIPT;
      if (!script) fail('set ORBIT_BRIDGE_SCRIPT or pass --script <adapter.mjs> (bridge execution is an adapter)', 2);
      const child = spawn(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, ORBIT_BASE: cfg.baseUrl, ORBIT_ARTIFACT_BRIDGE_TOKEN: cfg.token } });
      child.on('exit', (code) => process.exit(code ?? 1));
      return 0;
    }
    fail(`unknown bridge command: ${cmd}`, 2);
  }

  fail(`unknown command: ${group} ${cmd || ''}`, 2);
}

main().catch((e) => {
  if (e.status === 401) fail('unauthorized — check your token (orbit login)', 3);
  fail(e.message || String(e), 1);
});
