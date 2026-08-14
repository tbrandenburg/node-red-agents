'use strict';

// Thin fetch wrapper for talking to an opencode `serve` daemon: adds an
// AbortController-based timeout (fetch has no built-in one) and optional
// HTTP basic auth. Deliberately not a generic HTTP client -- just enough to
// call the handful of endpoints this node needs.
function basicAuthHeader(username, password) {
    return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// opts: { method, body, timeoutMs, username, password }
// Returns the parsed JSON body, or undefined for a 204/empty response.
// Throws an Error (with .status set, if the server responded at all) on
// network failure, timeout, or a non-2xx response.
async function request(url, opts = {}) {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs || 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = { 'Content-Type': 'application/json' };
    if (opts.username || opts.password) {
        headers.Authorization = basicAuthHeader(opts.username || '', opts.password || '');
    }

    let res;
    try {
        res = await fetch(url, {
            method: opts.method || 'GET',
            headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
        }
        throw new Error(`request to ${url} failed: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    const text = await res.text();
    let body;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch (err) {
        body = text;
    }

    if (!res.ok) {
        const err = new Error(`${opts.method || 'GET'} ${url} -> ${res.status}${text ? ': ' + text : ''}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }

    return body;
}

module.exports = { request, basicAuthHeader };
