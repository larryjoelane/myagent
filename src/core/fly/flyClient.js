// Fly Machines API client — thin wrapper around https://api.machines.dev/v1.
// No flyctl dependency: every call is a plain fetch() against the REST API,
// authenticated with a Fly API token (FLY_API_TOKEN).
//
// Scope is deliberately the minimum needed to launch a sample webapp on a
// fresh machine and get a reachable URL back:
//   ensureApp        - create the Fly app if it doesn't already exist
//   createMachine     - launch a machine from an image, with env + services
//   getMachine        - poll machine state (e.g. wait for "started")
//   listMachines      - list machines in an app
//   stopMachine / destroyMachine - lifecycle teardown
//
// Fly's own docs: https://fly.io/docs/machines/api/
//
// Auth: pass `apiToken` explicitly, or rely on FLY_API_TOKEN in the
// environment (loaded via dotenv in electron/main.js, same convention as
// OLLAMA_API_KEY / OPENROUTER_API_KEY).

const DEFAULT_BASE_URL = 'https://api.machines.dev/v1';
const ALLOWED_FLY_API_HOSTS = new Set(['api.machines.dev']);

function normalizeFlyBaseUrl(rawBaseUrl) {
  const candidate = rawBaseUrl || DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    throw new Error('FlyClient: baseUrl must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('FlyClient: baseUrl must use https');
  }
  if (!ALLOWED_FLY_API_HOSTS.has(parsed.hostname)) {
    throw new Error(`FlyClient: baseUrl host "${parsed.hostname}" is not allowed`);
  }

  return parsed.toString().replace(/\/+$/, '');
}

class FlyApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'FlyApiError';
    this.status = status;
    this.body = body;
  }
}

class FlyClient {
  constructor({ apiToken, baseUrl, org } = {}) {
    const token = apiToken || process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error('FlyClient: apiToken is required (pass it directly or set FLY_API_TOKEN)');
    }
    this.apiToken = token;
    this.baseUrl = normalizeFlyBaseUrl(baseUrl || process.env.FLY_API_BASE_URL || DEFAULT_BASE_URL);
    // Fly orgs are usually slugs like "personal". Required by app creation.
    this.org = org || process.env.FLY_ORG || 'personal';
  }

  async _request(method, path, body) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('FlyClient: request path must start with "/"');
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new FlyApiError(`Fly API ${method} ${path} failed: ${res.status}`, {
        status: res.status,
        body: data,
      });
    }
    return data;
  }

  // Creates the app if missing. Fly returns 422 when an app name is already
  // taken (by you or anyone else, since app names are globally unique) —
  // treat that as success rather than a hard failure, since the common case
  // is re-running against an app this same client created earlier.
  async ensureApp(appName) {
    try {
      return await this._request('POST', '/apps', {
        app_name: appName,
        org_slug: this.org,
      });
    } catch (err) {
      if (err instanceof FlyApiError && err.status === 422) {
        return { app_name: appName, already_exists: true };
      }
      throw err;
    }
  }

  // Launches a machine. `config` follows Fly's machine config schema:
  // https://fly.io/docs/machines/api/machines-resource/#create-a-machine
  // Minimal shape for a webapp:
  //   {
  //     image: 'registry/image:tag',
  //     env: { PORT: '8080' },
  //     services: [{ ports: [{ port: 443, handlers: ['tls','http'] }, { port: 80, handlers: ['http'] }], protocol: 'tcp', internal_port: 8080 }],
  //   }
  async createMachine(appName, config, { name, region } = {}) {
    return this._request('POST', `/apps/${appName}/machines`, {
      name,
      region,
      config,
    });
  }

  async getMachine(appName, machineId) {
    return this._request('GET', `/apps/${appName}/machines/${machineId}`);
  }

  // Updates a machine's full config (Fly doesn't support partial updates —
  // the whole config object must be sent every time). Reboots a running
  // machine automatically. Used to retrofit a public service/port mapping
  // onto a machine that was created without one (e.g. attach-to-existing).
  async updateMachineConfig(appName, machineId, config, { region } = {}) {
    return this._request('POST', `/apps/${appName}/machines/${machineId}`, {
      region,
      config,
    });
  }

  async listMachines(appName) {
    return this._request('GET', `/apps/${appName}/machines`);
  }

  async stopMachine(appName, machineId) {
    return this._request('POST', `/apps/${appName}/machines/${machineId}/stop`);
  }

  async startMachine(appName, machineId) {
    return this._request('POST', `/apps/${appName}/machines/${machineId}/start`);
  }

  async destroyMachine(appName, machineId, { force = false } = {}) {
    return this._request('DELETE', `/apps/${appName}/machines/${machineId}${force ? '?force=true' : ''}`);
  }

  async listVolumes(appName) {
    return this._request('GET', `/apps/${appName}/volumes`);
  }

  // Volumes can only be mounted onto a machine at createMachine() time —
  // confirmed by testing: updateMachineConfig() on a running machine with a
  // valid, fully-provisioned volume id fails with "volume does not exist",
  // while the identical mounts entry on createMachine() succeeds. There is
  // no API-level way to attach persistent storage to an existing machine;
  // the machine must be recreated.
  async createVolume(appName, name, { region, sizeGb = 1 } = {}) {
    return this._request('POST', `/apps/${appName}/volumes`, {
      name,
      region,
      size_gb: sizeGb,
    });
  }

  // Runs a single command on a running machine and returns its output.
  // Capped server-side at 60s — not for long-lived processes.
  //
  // `stdin` is part of Fly's documented exec schema, but in practice the
  // Machines API does not reliably deliver it to the command (confirmed: a
  // `wc -c` exec with an 11-byte stdin string returns 0 — verified with a
  // raw fetch() against the API, no wrapper involved). Don't depend on it;
  // see writeFileViaArgv() below for the workaround used instead.
  async exec(appName, machineId, command, { stdin, timeout } = {}) {
    return this._request('POST', `/apps/${appName}/machines/${machineId}/exec`, {
      command,
      ...(stdin !== undefined ? { stdin } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    });
  }

  // Writes `content` to `remotePath` on the machine without relying on exec
  // stdin (see the note on exec() above). Content travels as a base64
  // command-line argument to a `node -e` script that decodes and writes it —
  // avoids both the broken stdin path and shell quoting/heredoc escaping for
  // arbitrary file content. Fly's exec endpoint rejects very large argv
  // payloads (PayloadTooLarge around ~150-200KB of base64); this is meant
  // for source files and small-to-medium app files, not large binaries.
  async writeFileViaArgv(appName, machineId, remotePath, content, { timeout } = {}) {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const script = 'require("fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"))';
    return this.exec(appName, machineId, ['node', '-e', script, remotePath, b64], { timeout });
  }

  // Polls getMachine until state reaches `targetState` ("started" is the
  // common case right after createMachine) or the timeout elapses.
  async waitForState(appName, machineId, targetState = 'started', { timeoutMs = 60000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const machine = await this.getMachine(appName, machineId);
      if (machine.state === targetState) return machine;
      if (Date.now() >= deadline) {
        throw new Error(`FlyClient.waitForState: timed out waiting for "${targetState}" (last state: "${machine.state}")`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

module.exports = { FlyClient, FlyApiError };
