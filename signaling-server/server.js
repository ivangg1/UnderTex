#!/usr/bin/env node

/**
 * Minimalist y-webrtc signaling server for UnderTeX.
 * Based on the official y-webrtc signaling protocol.
 */

import http from 'http';
import { WebSocketServer } from 'ws';

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const pingTimeout = 30000;

const port = process.env.PORT || 4444;
const wss = new WebSocketServer({ noServer: true });

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('y-webrtc signaling server is healthy');
});

/**
 * Map from topic name to set of subscribed WebSocket connections.
 * @type {Map<string, Set<import('ws').WebSocket>>}
 */
const topics = new Map();

/**
 * Send JSON message to a connection safely.
 */
const send = (conn, message) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    conn.close();
    return;
  }
  try {
    conn.send(JSON.stringify(message));
  } catch (_e) {
    conn.close();
  }
};

/**
 * Handle new WebSocket connection.
 */
const onconnection = (conn) => {
  const subscribedTopics = new Set();
  let closed = false;
  let pongReceived = true;

  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      conn.close();
      clearInterval(pingInterval);
    } else {
      pongReceived = false;
      try {
        conn.ping();
      } catch (_e) {
        conn.close();
      }
    }
  }, pingTimeout);

  conn.on('pong', () => {
    pongReceived = true;
  });

  conn.on('close', () => {
    clearInterval(pingInterval);
    subscribedTopics.forEach((topicName) => {
      const subs = topics.get(topicName);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) {
          topics.delete(topicName);
        }
      }
    });
    subscribedTopics.clear();
    closed = true;
  });

  conn.on('message', (data) => {
    let message;
    try {
      if (typeof data === 'string' || data instanceof Buffer) {
        message = JSON.parse(data.toString());
      }
    } catch (_err) {
      return;
    }

    if (message && message.type && !closed) {
      switch (message.type) {
        case 'subscribe':
          (message.topics || []).forEach((topicName) => {
            if (typeof topicName === 'string') {
              if (!topics.has(topicName)) {
                topics.set(topicName, new Set());
              }
              topics.get(topicName).add(conn);
              subscribedTopics.add(topicName);
            }
          });
          break;

        case 'unsubscribe':
          (message.topics || []).forEach((topicName) => {
            const subs = topics.get(topicName);
            if (subs) {
              subs.delete(conn);
              if (subs.size === 0) {
                topics.delete(topicName);
              }
            }
          });
          break;

        case 'publish':
          if (message.topic) {
            const receivers = topics.get(message.topic);
            if (receivers) {
              message.clients = receivers.size;
              receivers.forEach((receiver) => {
                send(receiver, message);
              });
            }
          }
          break;

        case 'ping':
          send(conn, { type: 'pong' });
          break;
      }
    }
  });
};

wss.on('connection', onconnection);

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(port, () => {
  console.log(`[y-webrtc] Signaling server running on port ${port}`);
});
