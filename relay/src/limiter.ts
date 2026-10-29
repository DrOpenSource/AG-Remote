import { DurableObject } from 'cloudflare:workers';

/**
 * Counts requests of one kind from one IP address (one object per kind+IP, e.g. "ws:1.2.3.4").
 * Fixed one-minute window, kept in memory: if the object is evicted the count starts over,
 * which only ever errs towards letting people in.
 *
 * The limit is deliberately generous. Mobile carriers put many phones behind one address
 * (carrier-grade NAT), and a normal phone or laptop reconnects only a few times a minute
 * even on a bad network. The point is to stop one address opening thousands of rooms.
 */
export class ConnLimiter extends DurableObject {
  private windowStart = 0;
  private count = 0;

  /** Records one request. Returns false when this kind+IP is over `limit` in the current window. */
  hit(limit: number, windowMs: number): boolean {
    const now = Date.now();
    if (now - this.windowStart >= windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return this.count <= limit;
  }
}
