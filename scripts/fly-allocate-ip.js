// Allocates public IP addresses for a Fly app via Fly's GraphQL API
// (api.fly.io/graphql) — NOT the Machines REST API (api.machines.dev) used
// elsewhere in src/core/fly/. IP allocation isn't exposed on the Machines
// API at all; it's only available through flyctl or this GraphQL endpoint.
// Same FLY_API_TOKEN works for both.
//
// Useful for diagnosing "site can't be reached" (as opposed to a 404): if
// `fly-push-test.js` shows the app correctly listening inside the machine
// but the public hostname is still unreachable, check here first — an app
// can have zero public IPs (nothing for Fly's edge to route to), or only an
// IPv6 address, which is invisible to networks without IPv6 (e.g. Google
// Fiber as of 2026).
//
// Usage:
//   node scripts/fly-allocate-ip.js list <appName>
//   node scripts/fly-allocate-ip.js allocate-v6 <appName>
//   node scripts/fly-allocate-ip.js allocate-v4 <appName>   [shared, free; needs a card on file for trial orgs]
//   node scripts/fly-allocate-ip.js allocate-dedicated-v4 <appName>  [paid, dedicated IPv4]
//
// "shared_v4" (the default for allocate-v4) is the free shared-IP tier.
// Fly returns an UNPROCESSABLE error for any v4 allocation on a trial org
// with no credit card on file — add one at
// https://fly.io/dashboard/<org>/billing, then re-run.

require('dotenv').config();

const GRAPHQL_URL = 'https://api.fly.io/graphql';

async function gql(query, variables) {
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error('FLY_API_TOKEN is required (set it in .env)');
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(`Fly GraphQL error: ${JSON.stringify(data.errors, null, 2)}`);
  }
  return data.data;
}

async function listIps(appName) {
  const data = await gql(
    `query($name: String!) {
      app(name: $name) {
        ipAddresses { nodes { id address type region } }
      }
    }`,
    { name: appName },
  );
  return data.app.ipAddresses.nodes;
}

async function allocateIp(appName, type) {
  const data = await gql(
    `mutation($input: AllocateIPAddressInput!) {
      allocateIpAddress(input: $input) {
        ipAddress { id address type region }
      }
    }`,
    { input: { appId: appName, type } },
  );
  return data.allocateIpAddress.ipAddress;
}

function usageAndExit() {
  console.error(`Usage:
  node scripts/fly-allocate-ip.js list <appName>
  node scripts/fly-allocate-ip.js allocate-v6 <appName>
  node scripts/fly-allocate-ip.js allocate-v4 <appName>
  node scripts/fly-allocate-ip.js allocate-dedicated-v4 <appName>`);
  process.exit(1);
}

const TYPE_BY_COMMAND = {
  'allocate-v6': 'v6',
  'allocate-v4': 'shared_v4',
  'allocate-dedicated-v4': 'v4',
};

async function main() {
  const [command, appName] = process.argv.slice(2);
  if (!command || !appName) usageAndExit();

  if (command === 'list') {
    const ips = await listIps(appName);
    if (ips.length === 0) {
      console.log(`${appName} has no public IP addresses allocated.`);
    } else {
      console.log(`${appName} IP addresses:`);
      for (const ip of ips) console.log(`  ${ip.type.padEnd(10)} ${ip.address}  (region: ${ip.region})`);
    }
    return;
  }

  const type = TYPE_BY_COMMAND[command];
  if (!type) usageAndExit();

  console.log(`Allocating ${type} for "${appName}"...`);
  const ip = await allocateIp(appName, type);
  if (!ip) {
    console.error('Allocation returned no IP address (no error, but nothing was created). Run `list` to check current state.');
    process.exit(1);
  }
  console.log(`Allocated: ${ip.type} ${ip.address} (region: ${ip.region})`);
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.message || err);
  process.exit(1);
});
