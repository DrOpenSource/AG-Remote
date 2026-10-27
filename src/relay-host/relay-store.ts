import fs from 'fs';
import path from 'path';
import { dataDir } from '../core/data-dir.ts';
import { generateIdentity, exportIdentity, importIdentity, newRoomId } from '../pwa/e2e.js';

export interface PhoneRecord {
  pub: string;
  name: string;
  pairedAt: number;
}

interface SavedState {
  room: string;
  identity: { pub: string; jwk: JsonWebKey };
  phones: PhoneRecord[];
}

/**
 * The laptop's relay identity: room id, long-term key and paired phones, saved in relay.json beside
 * session.token (mode 0600). Every IDE window reads the same file, so whichever window hosts uses
 * the same room and phones stay paired across hand-overs and restarts.
 * Implements the phone-registry methods HostE2E expects (get/add/remove/list).
 */
export class RelayStore {
  public room = '';
  public identity: any = null;
  private phones = new Map<string, PhoneRecord>();
  private readonly file: string;

  private constructor(dir: string) {
    this.file = path.join(dir, 'relay.json');
  }

  static async load(dir: string = dataDir()): Promise<RelayStore> {
    const store = new RelayStore(dir);
    try {
      const saved: SavedState = JSON.parse(fs.readFileSync(store.file, 'utf8'));
      store.room = saved.room;
      store.identity = await importIdentity(saved.identity, { extractable: true });
      store.phones = new Map((saved.phones || []).map((p) => [p.pub, p]));
      if (!/^[A-Za-z0-9_-]{22}$/.test(store.room)) throw new Error('bad room');
    } catch (_) {
      // Missing or unreadable: start fresh. Phones paired to a lost identity must pair again.
      await store.reset();
    }
    return store;
  }

  /** New room and key, no phones. Old QR codes and every paired phone stop working. */
  async reset(): Promise<void> {
    this.room = newRoomId();
    this.identity = await generateIdentity({ extractable: true });
    this.phones.clear();
    await this.save();
  }

  get(pub: string): PhoneRecord | undefined {
    return this.phones.get(pub);
  }

  async add(record: PhoneRecord): Promise<void> {
    this.phones.set(record.pub, record);
    await this.save();
  }

  async remove(pub: string): Promise<boolean> {
    const had = this.phones.delete(pub);
    if (had) await this.save();
    return had;
  }

  list(): PhoneRecord[] {
    return [...this.phones.values()];
  }

  private async save(): Promise<void> {
    const state: SavedState = {
      room: this.room,
      identity: await exportIdentity(this.identity),
      phones: this.list()
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write then rename, so a crash never leaves a half-written key file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
