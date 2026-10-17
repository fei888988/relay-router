'use strict';
// Event bus: persists notable events to the store and fans them out to panel SSE listeners.
const { EventEmitter } = require('node:events');

class Bus extends EventEmitter {
  constructor(store) {
    super();
    this.setMaxListeners(100);
    this.store = store;
  }

  // level: info | warn | error | success
  log(level, type, message, providerId, detail) {
    const ev = { ts: Date.now(), level, type, providerId: providerId || null, message, detail: detail || null };
    try {
      ev.id = this.store.addEvent(ev);
    } catch (e) {
      console.error('[events] write failed', e.message);
    }
    const tag = { info: 'INFO', warn: 'WARN', error: 'ERR ', success: ' OK ' }[level] || level;
    console.log(`${new Date(ev.ts).toLocaleTimeString()} [${tag}] ${message}`);
    this.emit('push', { kind: 'event', data: ev });
    return ev;
  }

  request(row) {
    this.emit('push', { kind: 'request', data: row });
  }

  stateChanged() {
    this.emit('push', { kind: 'state' });
  }
}

module.exports = { Bus };
