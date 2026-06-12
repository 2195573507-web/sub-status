# sub-status

Node.js backend for a lightweight server status dashboard.

## Setup

```sh
npm install
npm start
```

The server listens on `PORT` from the environment, or `3001` by default.

```sh
PORT=3001 npm start
```

## API

- `GET /health` returns service health and process uptime.
- `GET /api/status` returns current CPU, memory, disk, network, load, Docker, health-check, alert, and overall status data.
- `GET /api/history` returns the last 30 minutes of snapshots, one point per 30 seconds.
- `GET /api/check-now` triggers an immediate status collection and returns the result.

## Notes

- No database is used. Runtime history is kept in memory.
- Linux hosts use `/proc` data when available, with `os` module fallbacks for local development.
- Disk usage is read with `df -k /`.
- Docker status is read from `/var/run/docker.sock` when available.
- The local service health check uses `curl http://127.0.0.1:8080/health`.
