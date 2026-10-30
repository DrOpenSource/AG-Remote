/**
 * Phone side of the relay (src/pwa/relay-link.js): what happens when the app comes back on screen.
 * A fake WebSocket stands in for the relay, so this runs in Node without a browser.
 */
console.log('='.repeat(75));
console.log('🧪 RELAY LINK (PHONE SIDE) WAKE-UP TEST SUITE');
console.log('='.repeat(75));

let passed = 0;
let failed = 0;

function assert(condition: boolean, desc: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${desc}`);
    failed++;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((e?: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: ((e?: any) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(text: string) {
    this.onmessage?.({ data: text });
  }
}

(globalThis as any).WebSocket = FakeWebSocket;
(globalThis as any).location = { protocol: 'https:', host: 'relay.example' };
(globalThis as any).document = { visibilityState: 'visible' };

const { RelayLink } = await import('../src/pwa/relay-link.js');

async function runTests() {
  const states: string[] = [];
  const link = new RelayLink({ room: 'room1', secret: null, onState: (s: string) => states.push(s) });
  const sockets = () => FakeWebSocket.all.length;
  const current = () => FakeWebSocket.all[FakeWebSocket.all.length - 1];

  console.log('\n[1] Several wake events while the socket is still opening');
  link.connect();
  assert(sockets() === 1 && current().url === 'wss://relay.example/ws/room1?role=phone', 'connect() opens one socket to the room');
  link.wake();
  link.wake();
  link.wake();
  assert(sockets() === 1 && !current().closed, 'visible + focus + online while opening: the opening socket is kept, not restarted');

  console.log('\n[2] Socket survived the screen being off');
  current().open();
  link.wake();
  assert(sockets() === 1 && !current().sent.includes('ping'), 'just opened (relay heard from <3 s ago): nothing to check');
  link.lastActivity = Date.now() - 60_000;
  link.wake();
  assert(current().sent.filter((s) => s === 'ping').length === 1, 'quiet for a minute: one ping checks the socket');
  link.wake();
  assert(current().sent.filter((s) => s === 'ping').length === 1, 'a second wake while the check runs sends no second ping');
  current().receive('pong');
  await sleep(2200);
  assert(sockets() === 1 && !current().closed, 'relay answered: the same socket and session carry on (no new handshake)');

  console.log('\n[3] Socket died while the phone slept');
  link.state = 'ready'; // as if the encrypted session had been up before the phone slept
  link.lastActivity = Date.now() - 60_000;
  const dead = current();
  link.wake();
  await sleep(1000);
  assert(sockets() === 1, 'no answer yet after 1 s: still waiting');
  await sleep(1200);
  assert(sockets() === 2 && dead.closed && dead.onclose === null, 'no answer in 2 s: the dead socket is dropped and one new one opened');
  assert(states[states.length - 1] === 'connecting', 'state goes back to connecting');

  console.log('\n[4] Socket closed by the phone');
  current().open();
  current().readyState = 3;
  link.wake();
  assert(sockets() === 3, 'a closed socket is replaced at once, without waiting for the backoff timer');

  console.log('\n[5] Phone slept in the middle of connecting');
  link.connectStartedAt = Date.now() - 9_000;
  link.wake();
  assert(sockets() === 4, 'a socket stuck opening for more than 8 s is restarted');

  console.log('\n[6] Unpaired phone');
  link.state = 'unpaired';
  link.wake();
  assert(sockets() === 4, 'an unpaired phone does not reconnect on wake');
  link.restart = () => {};
  clearTimeout(link.reconnectTimer);
  clearTimeout(link.probeTimer);
  clearInterval(link.pingTimer);
}

try {
  await runTests();
} catch (err) {
  console.error('  ❌ ERROR:', err);
  failed++;
}

console.log('\n' + '='.repeat(75));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(75));
process.exit(failed > 0 ? 1 : 0);
