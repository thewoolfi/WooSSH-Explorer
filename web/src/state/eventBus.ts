import type { ServerEvent } from '../api/types';
import { eventSocketUrl } from '../api/client';
import { useConnectionStore } from './connectionStore';
import { useExplorerStore } from './explorerStore';
import { useTransferStore } from './transferStore';
import { useUiStore } from './uiStore';

/**
 * Single multiplexed event socket per browser tab. Reconnects with exponential
 * backoff and republishes every server event into the relevant store.
 */
class EventBus {
  private socket: WebSocket | null = null;
  private reconnectDelay = 500;
  private heartbeat: number | null = null;
  private stopped = false;
  private restarts = 0;

  start(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.stopped = false;
    this.restarts += 1;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      // Closing a socket mid-handshake logs a browser warning; let it settle first.
      socket.onopen = () => socket.close();
      socket.onmessage = null;
    } else {
      socket.close();
    }
  }

  /** Number of `start()` calls — StrictMode mounts the shell twice in dev. */
  get startCount(): number {
    return this.restarts;
  }

  private open(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(eventSocketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      socket.close();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 500;
      this.heartbeat = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
    };

    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      if (typeof message.data !== 'string') return;
      let payload: ServerEvent;
      try {
        payload = JSON.parse(message.data) as ServerEvent;
      } catch {
        return;
      }
      this.dispatch(payload);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.socket = null;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    window.setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private dispatch(event: ServerEvent): void {
    const connections = useConnectionStore.getState();
    const transfers = useTransferStore.getState();
    const explorer = useExplorerStore.getState();
    const ui = useUiStore.getState();

    switch (event.type) {
      case 'hello':
        break;

      case 'connection:status': {
        const previous = connections.connections.find((c) => c.id === event.connection.id);
        connections.upsertConnection(event.connection);
        if (event.connection.status === 'authenticated' && previous?.status !== 'authenticated') {
          explorer.refreshConnection(event.connection.id);
        }
        break;
      }

      case 'connection:closed': {
        connections.removeConnection(event.connectionId);
        explorer.closeTabsForConnection(event.connectionId);
        ui.pushToast({
          level: 'warn',
          title: 'Connection closed',
          detail: event.reason || undefined,
        });
        break;
      }

      case 'transfer:update': {
        const previous = transfers.transfers.find((t) => t.id === event.transfer.id);
        transfers.upsert(event.transfer);
        if (
          event.transfer.state === 'done' &&
          previous &&
          previous.state !== 'done' &&
          event.transfer.direction === 'upload'
        ) {
          explorer.refreshConnection(event.transfer.connectionId);
        }
        break;
      }

      case 'fs:changed': {
        for (const tab of explorer.tabs) {
          if (tab.kind !== 'files' || tab.connectionId !== event.connectionId) continue;
          if (tab.path === event.path || tab.path === parentOf(event.path)) {
            void explorer.refresh(tab.id);
          }
        }
        break;
      }

      case 'toast':
        ui.pushToast({ level: event.level, title: event.message });
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

export const eventBus = new EventBus();
