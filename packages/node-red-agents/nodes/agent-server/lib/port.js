'use strict';

const net = require('net');

// Self-allocates a free TCP port instead of spawning `opencode serve --port
// 0` and scraping its stdout for the OS-assigned port: bind a throwaway
// server to port 0, read back whatever the OS gave it, close it immediately,
// then hand that concrete number to `--port`. Deterministic, doesn't depend
// on a log line's exact wording, and is trivially unit-testable without
// spawning any real agent binary.
//
// Unavoidable TOCTOU: the port could theoretically be grabbed by something
// else between close() here and the daemon binding it moments later. Left
// as a known, accepted race (same as almost every "find a free port" helper)
// -- the daemon's own health-poll failing/timing out is the backstop.
function findFreePort(hostname = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, hostname, () => {
            const { port } = server.address();
            server.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
    });
}

module.exports = { findFreePort };
