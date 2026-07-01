#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const {
  CF_AUTH_EMAIL,
  CF_GLOBAL_AUTH_KEY,
  CF_ACCOUNT_ID,
  CF_ZONE_ID,
} = process.env;

for (const [name, value] of Object.entries({ CF_AUTH_EMAIL, CF_GLOBAL_AUTH_KEY, CF_ACCOUNT_ID, CF_ZONE_ID })) {
  if (!value) {
    console.error(`Missing ${name}. Source a private .cloudflare.sh first.`);
    process.exit(2);
  }
}

const headers = {
  "X-Auth-Email": CF_AUTH_EMAIL,
  "X-Auth-Key": CF_GLOBAL_AUTH_KEY,
  "Content-Type": "application/json",
};

async function api(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ success: false, errors: [{ message: "invalid json" }] }));
  if (!res.ok || json.success === false) {
    const message = (json.errors || []).map((error) => error.message).join("; ");
    throw new Error(`${method} ${path} failed: ${res.status} ${message}`);
  }
  return json.result;
}

async function main() {
  const tunnelName = "hawky-live-runpod";
  const websiteHostnames = ["hawky.live", "www.hawky.live", "ios.hawky.live"];
  const controlHostnames = ["app.hawky.live", "admin.hawky.live", "realtime-gateway.hawky.live"];
  const websiteService = process.env.HAWKY_WEBSITE_SERVICE || "http://localhost:4260";
  const controlService = "http://localhost:4242";

  const tunnels = await api("GET", `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
  let tunnel = tunnels[0];
  if (!tunnel) {
    tunnel = await api("POST", `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel`, {
      name: tunnelName,
      config_src: "cloudflare",
    });
  }

  await api("PUT", `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: {
      ingress: [
        ...websiteHostnames.map((hostname) => ({ hostname, service: websiteService, originRequest: {} })),
        ...controlHostnames.map((hostname) => ({ hostname, service: controlService, originRequest: {} })),
        { service: "http_status:404" },
      ],
    },
  });

  const dnsRecords = [];
  const dnsHostnames = [...websiteHostnames, ...controlHostnames];
  const legacyDnsHostnames = ["login.hawky.live", "*.hawky.live", "*.user.hawky.live"];
  for (const hostname of legacyDnsHostnames) {
    const records = await api("GET", `/zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`);
    for (const record of records) {
      if (["A", "AAAA", "CNAME"].includes(record.type)) {
        await api("DELETE", `/zones/${CF_ZONE_ID}/dns_records/${record.id}`);
      }
    }
  }
  for (const hostname of dnsHostnames) {
    const records = await api("GET", `/zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`);
    for (const record of records) {
      if (["A", "AAAA", "CNAME"].includes(record.type)) {
        await api("DELETE", `/zones/${CF_ZONE_ID}/dns_records/${record.id}`);
      }
    }
    const dns = await api("POST", `/zones/${CF_ZONE_ID}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    });
    dnsRecords.push({ name: dns.name, content: dns.content, proxied: dns.proxied });
  }

  console.log(JSON.stringify({
    tunnel: { id: tunnel.id, name: tunnelName },
    website: websiteHostnames.map((hostname) => ({ hostname, service: websiteService })),
    control: controlHostnames.map((hostname) => ({ hostname, service: controlService })),
    dns: dnsRecords,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
