'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const PORT = Number(process.env.PORT || 3001);
const HISTORY_INTERVAL_MS = 30 * 1000;
const COLLECT_INTERVAL_MS = 1000;
const HISTORY_WINDOW_MS = 30 * 60 * 1000;
const HEALTH_CHECK_URL = process.env.STATUS_HEALTH_TARGET || 'http://127.0.0.1:8080/health';
const DOCKER_SOCKET = '/var/run/docker.sock';

const app = express();

app.use(express.static('public'));

let latestStatus = null;
let history = [];
let collectorTimer = null;
let historyTimer = null;
let cpuPrevious = null;
let networkPrevious = null;
let collectionInFlight = null;

function readText(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function bytesToHuman(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function secondsToHuman(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0 seconds';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} days ${hours} hours`;
  if (hours > 0) return `${hours} hours ${minutes} minutes`;
  return `${minutes} minutes`;
}

function percent(used, total) {
  if (!total || total <= 0) return 0;
  return Number(((used / total) * 100).toFixed(1));
}

function parseProcCpu() {
  const stat = readText('/proc/stat');
  if (!stat) return null;
  const line = stat.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { idle, total };
}

function parseOsCpu() {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function getCpuMetrics() {
  const current = parseProcCpu() || parseOsCpu();
  const cores = os.cpus().length || 1;

  if (!current) {
    return { percent: 0, cores };
  }

  let cpuPercent = 0;
  if (cpuPrevious) {
    const totalDelta = current.total - cpuPrevious.total;
    const idleDelta = current.idle - cpuPrevious.idle;
    if (totalDelta > 0) {
      cpuPercent = Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(1));
    }
  }
  cpuPrevious = current;

  return { percent: Math.max(0, Math.min(100, cpuPercent)), cores };
}

function parseProcMeminfo() {
  const meminfo = readText('/proc/meminfo');
  if (!meminfo) return null;

  const values = {};
  for (const line of meminfo.split('\n')) {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }

  if (!values.MemTotal) return null;
  const totalBytes = values.MemTotal;
  const availableBytes = values.MemAvailable ?? values.MemFree ?? 0;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swapTotal = values.SwapTotal || 0;

  return {
    usedBytes,
    totalBytes,
    availableBytes,
    swapEnabled: swapTotal > 0,
  };
}

function getMemoryMetrics() {
  const procMemory = parseProcMeminfo();
  const totalBytes = procMemory?.totalBytes ?? os.totalmem();
  const availableBytes = procMemory?.availableBytes ?? os.freemem();
  const usedBytes = procMemory?.usedBytes ?? Math.max(0, totalBytes - availableBytes);
  const swapEnabled = procMemory?.swapEnabled ?? false;

  return {
    used: bytesToHuman(usedBytes),
    total: bytesToHuman(totalBytes),
    available: bytesToHuman(availableBytes),
    percent: percent(usedBytes, totalBytes),
    used_bytes: usedBytes,
    total_bytes: totalBytes,
    available_bytes: availableBytes,
    swap_enabled: swapEnabled,
  };
}

async function getDiskMetrics() {
  try {
    const { stdout } = await execAsync('df -k /', { timeout: 3000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const dataLine = lines[lines.length - 1];
    const parts = dataLine.split(/\s+/);
    const sizeKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const availableKb = Number(parts[3]);
    const mount = parts[parts.length - 1] || '/';

    if (Number.isFinite(sizeKb) && Number.isFinite(usedKb) && Number.isFinite(availableKb)) {
      const totalBytes = sizeKb * 1024;
      const usedBytes = usedKb * 1024;
      const availableBytes = availableKb * 1024;
      return {
        used: bytesToHuman(usedBytes),
        total: bytesToHuman(totalBytes),
        available: bytesToHuman(availableBytes),
        percent: percent(usedBytes, totalBytes),
        mount,
        used_bytes: usedBytes,
        total_bytes: totalBytes,
        available_bytes: availableBytes,
      };
    }
  } catch {
    // Fall through to a zeroed disk object for restricted/local environments.
  }

  return {
    used: '0 B',
    total: '0 B',
    available: '0 B',
    percent: 0,
    mount: '/',
    used_bytes: 0,
    total_bytes: 0,
    available_bytes: 0,
  };
}

function parseProcNetwork() {
  const data = readText('/proc/net/dev');
  if (!data) return null;

  const interfaces = [];
  for (const line of data.split('\n').slice(2)) {
    const [rawName, rawCounters] = line.split(':');
    if (!rawName || !rawCounters) continue;
    const name = rawName.trim();
    const counters = rawCounters.trim().split(/\s+/).map(Number);
    if (counters.length < 16 || name === 'lo') continue;
    interfaces.push({
      name,
      rxBytes: counters[0] || 0,
      txBytes: counters[8] || 0,
    });
  }

  if (!interfaces.length) return null;
  return interfaces.find((iface) => iface.name === 'eth0') || interfaces[0];
}

function fallbackNetwork() {
  const entries = Object.entries(os.networkInterfaces());
  const external = entries.find(([, addresses]) => addresses?.some((addr) => !addr.internal));
  if (!external) return null;
  return { name: external[0], rxBytes: 0, txBytes: 0 };
}

function getNetworkMetrics(nowMs) {
  const current = parseProcNetwork() || fallbackNetwork() || { name: 'unknown', rxBytes: 0, txBytes: 0 };
  let inRateMbps = 0;
  let outRateMbps = 0;

  if (networkPrevious && networkPrevious.name === current.name) {
    const elapsedSeconds = Math.max((nowMs - networkPrevious.timeMs) / 1000, 1);
    const rxDelta = Math.max(0, current.rxBytes - networkPrevious.rxBytes);
    const txDelta = Math.max(0, current.txBytes - networkPrevious.txBytes);
    inRateMbps = Number(((rxDelta * 8) / elapsedSeconds / 1000000).toFixed(2));
    outRateMbps = Number(((txDelta * 8) / elapsedSeconds / 1000000).toFixed(2));
  }

  networkPrevious = {
    name: current.name,
    rxBytes: current.rxBytes,
    txBytes: current.txBytes,
    timeMs: nowMs,
  };

  return {
    in_rate_mbps: inRateMbps,
    out_rate_mbps: outRateMbps,
    cumulative_rx: bytesToHuman(current.rxBytes),
    cumulative_tx: bytesToHuman(current.txBytes),
    cumulative_rx_bytes: current.rxBytes,
    cumulative_tx_bytes: current.txBytes,
    interface: current.name,
  };
}

function getProcessCount() {
  try {
    return fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).length;
  } catch {
    return 0;
  }
}

function getSystemMetrics(memory) {
  const uptimeSeconds = os.uptime();
  return {
    uptime: secondsToHuman(uptimeSeconds),
    uptime_seconds: Math.floor(uptimeSeconds),
    boot_time: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    process_count: getProcessCount(),
    swap_enabled: memory.swap_enabled,
  };
}

function dockerRequest(path) {
  return new Promise((resolve) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      resolve(null);
      return;
    }

    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method: 'GET',
        timeout: 3000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function getDockerMetrics() {
  const containers = await dockerRequest('/containers/json?all=1');
  if (!Array.isArray(containers)) return [];

  const result = [];
  for (const container of containers) {
    const id = container.Id;
    const inspect = id ? await dockerRequest(`/containers/${id}/json`) : null;
    const health = inspect?.State?.Health?.Status || 'unknown';
    const state = inspect?.State?.Status || container.State || 'unknown';
    const startedAt = inspect?.State?.StartedAt ? Date.parse(inspect.State.StartedAt) : null;
    const uptimeSeconds = startedAt && state === 'running' ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;

    result.push({
      name: (container.Names?.[0] || container.Image || id || 'unknown').replace(/^\//, ''),
      status: state,
      health,
      uptime: state === 'running' ? secondsToHuman(uptimeSeconds) : '0 minutes',
    });
  }

  return result;
}

async function runHealthCheck() {
  const start = Date.now();
  try {
    const command = `curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 3 ${HEALTH_CHECK_URL}`;
    const { stdout } = await execAsync(command, { timeout: 4000 });
    const [statusRaw, timeRaw] = stdout.trim().split(/\s+/);
    const status = Number(statusRaw);
    const latencyMs = Number.isFinite(Number(timeRaw)) ? Math.round(Number(timeRaw) * 1000) : Date.now() - start;
    const failed = !Number.isFinite(status) || status < 200 || status >= 400;

    return {
      name: 'sub2api (local)',
      url: HEALTH_CHECK_URL,
      status: Number.isFinite(status) ? status : null,
      latency_ms: latencyMs,
      error: failed ? `HTTP ${Number.isFinite(status) ? status : 'unknown'}` : null,
    };
  } catch (error) {
    return {
      name: 'sub2api (local)',
      url: HEALTH_CHECK_URL,
      status: null,
      latency_ms: Date.now() - start,
      error: error.message || 'health check failed',
    };
  }
}

function buildAlerts(status) {
  const alerts = [];

  if (status.cpu.percent > 85) {
    alerts.push({ level: 'warning', name: 'cpu', message: `CPU usage is ${status.cpu.percent}%` });
  }
  if (status.memory.percent > 85) {
    alerts.push({ level: 'warning', name: 'memory', message: `Memory usage is ${status.memory.percent}%` });
  }
  if (status.disk.percent > 85) {
    alerts.push({ level: 'warning', name: 'disk', message: `Disk usage is ${status.disk.percent}%` });
  }
  if (status.load.load1 > status.cpu.cores * 1.5) {
    alerts.push({ level: 'warning', name: 'load', message: `Load average is ${status.load.load1}` });
  }

  for (const check of status.health_checks) {
    if (check.error || !check.status || check.status < 200 || check.status >= 400) {
      alerts.push({ level: 'critical', name: 'health_check', message: `${check.name} failed` });
    }
  }

  for (const container of status.docker) {
    if (container.status !== 'running' || container.health === 'unhealthy') {
      alerts.push({ level: 'critical', name: 'docker', message: `${container.name} is ${container.status}/${container.health}` });
    }
  }

  return alerts;
}

function statusFromAlerts(alerts) {
  if (alerts.some((alert) => alert.level === 'critical')) return 'critical';
  if (alerts.some((alert) => alert.level === 'warning')) return 'warning';
  return 'healthy';
}

async function collectStatus() {
  if (collectionInFlight) return collectionInFlight;

  collectionInFlight = (async () => {
    const nowMs = Date.now();
    const memory = getMemoryMetrics();
    const cpu = getCpuMetrics();
    const loadAverages = os.loadavg();

    const status = {
      time: new Date(nowMs).toISOString(),
      cpu,
      load: {
        load1: Number((loadAverages[0] || 0).toFixed(2)),
        load5: Number((loadAverages[1] || 0).toFixed(2)),
        load15: Number((loadAverages[2] || 0).toFixed(2)),
      },
      memory: {
        used: memory.used,
        total: memory.total,
        available: memory.available,
        percent: memory.percent,
        used_bytes: memory.used_bytes,
        total_bytes: memory.total_bytes,
        available_bytes: memory.available_bytes,
      },
      disk: await getDiskMetrics(),
      network: getNetworkMetrics(nowMs),
      system: getSystemMetrics(memory),
      docker: await getDockerMetrics(),
      health_checks: [await runHealthCheck()],
      alerts: [],
      overall_status: 'healthy',
    };

    status.alerts = buildAlerts(status);
    status.overall_status = statusFromAlerts(status.alerts);
    latestStatus = status;
    return status;
  })();

  try {
    return await collectionInFlight;
  } finally {
    collectionInFlight = null;
  }
}

function snapshotHistory(status = latestStatus) {
  if (!status) return;
  const point = {
    time: status.time,
    cpu: status.cpu.percent,
    memory: status.memory.percent,
    disk: status.disk.percent,
    load1: status.load.load1,
    net_in: status.network.in_rate_mbps,
    net_out: status.network.out_rate_mbps,
  };

  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  history.push(point);
  history = history.filter((item) => Date.parse(item.time) >= cutoff).slice(-60);
}

function startCollector() {
  if (collectorTimer || historyTimer) return;

  collectStatus().then(snapshotHistory).catch(() => {});
  collectorTimer = setInterval(() => {
    collectStatus().catch(() => {});
  }, COLLECT_INTERVAL_MS);
  historyTimer = setInterval(() => {
    snapshotHistory();
  }, HISTORY_INTERVAL_MS);

  collectorTimer.unref?.();
  historyTimer.unref?.();
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/api/status', async (req, res) => {
  try {
    const status = latestStatus || await collectStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'failed_to_collect_status', message: error.message });
  }
});

app.get('/api/history', (req, res) => {
  res.json({ points: history });
});

app.get('/api/check-now', async (req, res) => {
  try {
    const status = await collectStatus();
    snapshotHistory(status);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'failed_to_collect_status', message: error.message });
  }
});

function startServer() {
  startCollector();
  return app.listen(PORT, () => {
    console.log(`sub-status listening on ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  collectStatus,
  startCollector,
  startServer,
};
