'use strict';

// Framework-agnostic, in-memory tracking of every daemon (opencode serve
// process) this node instance has spawned, keyed by sessionID. Deliberately
// has no Node-RED dependency (same reasoning as the `agent` package's
// lib/execution/scheduler.js) so it's unit-testable in isolation.
//
// This is also the entire answer to "how many/which agents are running
// right now": everything summary() reports comes from local state already
// being maintained for routing purposes anyway -- no extra network calls,
// no separate bookkeeping subsystem.
class InstanceRegistry {
    constructor() {
        this.map = new Map();
    }

    // record: { child, host, port, baseUrl } -- busy/startedAt/lastUsed are
    // owned by the registry itself, not the caller.
    register(sessionID, record) {
        this.map.set(
            sessionID,
            Object.assign({ busy: false, startedAt: Date.now(), lastUsed: Date.now() }, record)
        );
    }

    get(sessionID) {
        return this.map.get(sessionID);
    }

    has(sessionID) {
        return this.map.has(sessionID);
    }

    delete(sessionID) {
        return this.map.delete(sessionID);
    }

    list() {
        return Array.from(this.map.keys());
    }

    size() {
        return this.map.size;
    }

    // Marks a tracked session busy/idle and bumps lastUsed. No-op if the
    // sessionID isn't tracked (e.g. already torn down) -- callers don't need
    // to guard this themselves.
    setBusy(sessionID, busy) {
        const record = this.map.get(sessionID);
        if (!record) return;
        record.busy = busy;
        record.lastUsed = Date.now();
    }

    // Pure, local (no network) snapshot -- this is what backs the 'status'
    // operation when called without a sessionID, and the lifecycle-event
    // envelope's live counts.
    summary() {
        const sessions = [];
        let busy = 0;
        for (const [sessionID, record] of this.map) {
            if (record.busy) busy += 1;
            sessions.push({
                sessionID,
                host: record.host,
                port: record.port,
                busy: !!record.busy,
                startedAt: record.startedAt,
                lastUsed: record.lastUsed
            });
        }
        return { total: sessions.length, busy, idle: sessions.length - busy, sessions };
    }
}

module.exports = { InstanceRegistry };
