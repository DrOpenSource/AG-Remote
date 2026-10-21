import http from 'http';
import net from 'net';
import crypto from 'crypto';
import EventEmitter from 'events';
import type { AdapterEvent } from '../core/types.ts';
import { AuthManager } from '../core/auth.ts';

export class WebSocketClient extends EventEmitter {
  public socket: net.Socket;
  public isAlive: boolean = true;

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    this.setupListeners();
  }

  private setupListeners(): void {
    let buffer = Buffer.alloc(0);

    this.socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let headerLen = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          headerLen = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          // Support up to 32-bit length in payloadLen
          payloadLen = Number(buffer.readBigUInt64BE(2));
          headerLen = 10;
        }

        const maskLen = isMasked ? 4 : 0;
        const totalFrameLen = headerLen + maskLen + payloadLen;

        if (buffer.length < totalFrameLen) {
          // Incomplete frame, wait for more data
          return;
        }

        let payload = buffer.subarray(headerLen + maskLen, totalFrameLen);
        if (isMasked) {
          const mask = buffer.subarray(headerLen, headerLen + 4);
          const unmasked = Buffer.alloc(payloadLen);
          for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ mask[i % 4];
          }
          payload = unmasked;
        }

        // Handle Opcodes
        if (opcode === 0x08) {
          // Close frame
          this.close();
          return;
        } else if (opcode === 0x09) {
          // Ping -> send Pong
          this.sendFrame(0x0a, payload);
        } else if (opcode === 0x0a) {
          // Pong
          this.isAlive = true;
        } else if (opcode === 0x01) {
          // Text frame
          const text = payload.toString('utf8');
          this.emit('message', text);
        }

        buffer = buffer.subarray(totalFrameLen);
      }
    });

    this.socket.on('close', () => {
      this.emit('close');
    });

    this.socket.on('error', (err) => {
      // Ignore routine socket disconnect errors (e.g. ECONNRESET, EPIPE)
      this.emit('close');
    });
  }

  public send(text: string): void {
    const payload = Buffer.from(text, 'utf8');
    this.sendFrame(0x01, payload);
  }

  public ping(): void {
    this.isAlive = false;
    this.sendFrame(0x09, Buffer.alloc(0));
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;

    const len = payload.length;
    let header: Buffer;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {}
  }

  public close(): void {
    if (!this.socket.destroyed) {
      try {
        const closeFrame = Buffer.from([0x88, 0x00]);
        this.socket.write(closeFrame);
        this.socket.end();
      } catch (_) {}
    }
  }
}

export class WebSocketServer extends EventEmitter {
  private clients: Set<WebSocketClient> = new Set();
  private auth: AuthManager;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(auth: AuthManager) {
    super();
    this.auth = auth;
  }

  public handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const clientIp = req.socket.remoteAddress || '127.0.0.1';

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Auth verification: Token from query parameter or Authorization header
    let token: string | null = url.searchParams.get('token');
    if (!token && req.headers['authorization']) {
      const parts = req.headers['authorization'].split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        token = parts[1];
      }
    }

    if (!token || !this.auth.verifyToken(token, clientIp)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const secKey = req.headers['sec-websocket-key'];
    if (!secKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // RFC 6455 Handshake
    const acceptHash = crypto
      .createHash('sha1')
      .update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptHash}\r\n\r\n`
    ];

    socket.write(headers.join('\r\n'));

    const client = new WebSocketClient(socket);
    this.clients.add(client);
    this.emit('connection', client);

    client.on('close', () => {
      this.clients.delete(client);
    });

    if (!this.pingInterval) {
      this.startHeartbeat();
    }
  }

  public broadcast(event: AdapterEvent): void {
    const json = JSON.stringify(event);
    for (const client of this.clients) {
      client.send(json);
    }
  }

  public getConnectedCount(): number {
    return this.clients.size;
  }

  private startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.close();
          this.clients.delete(client);
        } else {
          client.ping();
        }
      }
      if (this.clients.size === 0 && this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
    }, 30000);
  }

  public close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}
