'use strict';

// Framework-agnostic bounded-concurrency FIFO scheduler. Deliberately has no
// Node-RED dependency (same reasoning as lib/execution/lifecycle.js) so it's
// unit-testable in isolation.
//
// This is the entire "concurrency" feature: a plain array + Map, no worker
// threads, no external queue library. Node-RED's own message-per-invocation
// model already gives independent executions for free (see AGENTS fan-out
// spec); this class only adds the bound + the waiting line on top of that.
class ExecutionScheduler {
    constructor({ concurrency, onStart, onQueued, onSettled } = {}) {
        this.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
        this.onStart = onStart; // (item) => Promise -- required
        this.onQueued = onQueued; // (item) => void -- optional
        // Called after this item is removed from `active` AND after any
        // queued item that became eligible to start has already been
        // started -- i.e. the scheduler's own bookkeeping is fully
        // settled, so a status render triggered from here is never stale.
        this.onSettled = onSettled; // (item) => void -- optional
        this.queue = [];
        this.active = new Map();
    }

    get activeCount() {
        return this.active.size;
    }

    get queuedCount() {
        return this.queue.length;
    }

    activeIds() {
        return Array.from(this.active.keys());
    }

    // item must have a unique `executionId` property; anything else on it
    // is opaque to the scheduler (agent.js stores msg/send/done/resolved).
    submit(item) {
        if (this.active.size < this.concurrency) {
            this._start(item);
        } else {
            this.queue.push(item);
            if (this.onQueued) this.onQueued(item);
        }
    }

    _start(item) {
        this.active.set(item.executionId, item);
        Promise.resolve(this.onStart(item)).finally(() => {
            this.active.delete(item.executionId);
            this._advance();
            if (this.onSettled) this.onSettled(item);
        });
    }

    _advance() {
        while (this.active.size < this.concurrency && this.queue.length > 0) {
            this._start(this.queue.shift());
        }
    }

    // Removes every still-queued item (FIFO order) without ever starting
    // them, calling onCancel for each. Used on node close/redeploy so
    // queued-but-not-yet-started messages get a clean done() instead of
    // hanging forever. Does not touch active executions -- that's the
    // caller's responsibility (terminate() belongs to the runtime layer).
    drainQueue(onCancel) {
        const remaining = this.queue.splice(0, this.queue.length);
        if (onCancel) remaining.forEach((item) => onCancel(item));
        return remaining;
    }
}

module.exports = { ExecutionScheduler };
