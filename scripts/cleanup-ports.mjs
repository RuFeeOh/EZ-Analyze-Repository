#!/usr/bin/env node
/**
 * Cleans up processes listening on commonly used Firebase emulator ports before starting them.
 * Supports macOS/Linux (lsof) and Windows (netstat + taskkill).
 *
 * Optional env vars:
 *   CLEANUP_PORTS          Comma list to override default ports.
 *   CLEANUP_PORTS_DRY_RUN  If set ("1"), only logs intended actions.
 */
import { execSync } from 'node:child_process';

// Ports used by Firestore / Auth / Functions / Hosting / UI (adjust as needed)
// Note: macOS commonly reserves 5000 for AirPlay Receiver; prefer avoiding it.
const DEFAULT_PORTS = [8080, 9099, 5001, 4400, 5100, 9199, 4000];
const PORTS = process.env.CLEANUP_PORTS
    ? process.env.CLEANUP_PORTS.split(',').map(p => Number(p.trim())).filter(Boolean)
    : DEFAULT_PORTS;

const DRY_RUN = process.env.CLEANUP_PORTS_DRY_RUN === '1';

function findAndKillUnix(port) {
    try {
        const cmd = `lsof -i tcp:${port} -sTCP:LISTEN -Pn | awk 'NR>1 {print $2}' | uniq`;
        const output = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (!output) {
            console.log(`[cleanup-ports] Port ${port} free.`);
            return;
        }
        const pids = output.split(/\n+/).filter(Boolean);
        for (const pid of pids) {
            try {
                if (DRY_RUN) {
                    console.log(`[cleanup-ports] (dry-run) Would kill PID ${pid} on port ${port}`);
                } else {
                    process.kill(Number(pid), 'SIGKILL');
                    console.log(`[cleanup-ports] Killed PID ${pid} on port ${port}`);
                }
            } catch (e) {
                console.warn(`[cleanup-ports] Failed to kill PID ${pid} on port ${port}: ${e.message}`);
            }
        }
    } catch {
        console.log(`[cleanup-ports] No listener found on port ${port}`);
    }
}

function findAndKillWindows(port) {
    try {
        // netstat output lines include the PID as the final token; filter for LISTENING state
        const cmd = `netstat -ano -p tcp | findstr :${port}`;
        const output = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const lines = output.split(/\r?\n/).filter(l => l.includes(`:${port}`) && /LISTENING/i.test(l));
        if (!lines.length) {
            console.log(`[cleanup-ports] Port ${port} free.`);
            return;
        }
        const pids = Array.from(new Set(lines.map(l => l.trim().split(/\s+/).pop()).filter(Boolean)));
        for (const pid of pids) {
            try {
                if (DRY_RUN) {
                    console.log(`[cleanup-ports] (dry-run) Would kill PID ${pid} on port ${port}`);
                } else {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: ['ignore', 'ignore', 'ignore'] });
                    console.log(`[cleanup-ports] Killed PID ${pid} on port ${port}`);
                }
            } catch (e) {
                console.warn(`[cleanup-ports] Failed to kill PID ${pid} on port ${port}: ${e.message}`);
            }
        }
    } catch {
        console.log(`[cleanup-ports] No listener found on port ${port}`);
    }
}

function findAndKill(port) {
    if (process.platform === 'darwin' || process.platform === 'linux') return findAndKillUnix(port);
    if (process.platform === 'win32') return findAndKillWindows(port);
    console.log(`[cleanup-ports] Unsupported platform ${process.platform}; skipping port ${port}`);
}

(async () => {
    if (DRY_RUN) console.log('[cleanup-ports] DRY RUN enabled; no processes will be killed.');
    console.log(`[cleanup-ports] Checking ports: ${PORTS.join(', ')}`);
    for (const p of PORTS) findAndKill(p);
})();
