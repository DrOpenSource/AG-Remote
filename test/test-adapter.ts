import fs from 'fs';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import type { SessionSnapshot, AdapterEvent } from '../src/core/types.ts';
import { auditLogger } from '../src/core/logger.ts';

console.log('='.repeat(75));
console.log('🧪 ANTIGRAVITY ADAPTER TERMINAL TEST SUITE (PHASE 2)');
console.log('='.repeat(75));

async function runTests() {
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

  const adapter = new AntigravityAdapter(process.cwd());

  console.log('\n[Suite 1] Lifecycle & Contract Compliance');
  assert(adapter.name === 'antigravity', 'Adapter name is "antigravity"');

  let eventFired = false;
  adapter.onEvent((e: AdapterEvent) => {
    eventFired = true;
  });

  await adapter.connect();
  const snapshot: SessionSnapshot = await adapter.getSnapshot();
  assert(['idle', 'generating', 'awaiting_approval', 'disconnected'].includes(snapshot.status), `Snapshot status is valid (${snapshot.status})`);
  assert(Array.isArray(snapshot.messages), `Messages is an array (length: ${snapshot.messages.length})`);
  assert(snapshot.messages.length > 0, `Captured conversation messages (count: ${snapshot.messages.length})`);

  console.log('\n[Suite 2] Security Invariants (Mismatched / Unsafe Actions)');
  
  // Test 1: Empty prompt validation
  try {
    await adapter.sendPrompt('   ');
    assert(false, 'Empty prompt should reject');
  } catch (err: any) {
    assert(err.message.includes('empty'), 'Empty prompt rejected with clear error');
  }

  // Test 2: Mismatched approval ID protection (Security Requirement 5)
  try {
    await adapter.approve('invalid-bogus-approval-id');
    assert(false, 'Mismatched approval id should reject');
  } catch (err: any) {
    assert(err.message.includes('No pending approval') || err.message.includes('mismatch'), 'Bogus approval ID safely rejected without executing');
  }

  // Test 3: Mismatched denial ID protection
  try {
    await adapter.deny('invalid-bogus-denial-id');
    assert(false, 'Mismatched denial id should reject');
  } catch (err: any) {
    assert(err.message.includes('No pending approval') || err.message.includes('mismatch'), 'Bogus denial ID safely rejected');
  }

  console.log('\n[Suite 3] 10/10 Repetition Reliability Test');
  let snapshot10Pass = true;
  for (let i = 1; i <= 10; i++) {
    const start = performance.now();
    const snap = await adapter.getSnapshot();
    const duration = performance.now() - start;
    if (!snap || !Array.isArray(snap.messages) || duration > 1000) {
      snapshot10Pass = false;
      break;
    }
  }
  assert(snapshot10Pass, 'Snapshot retrieval succeeds with < 1s latency across 10/10 attempts');

  let approval10Pass = true;
  for (let i = 1; i <= 10; i++) {
    const pending = await adapter.getPendingApproval();
    // pending is either null or a valid Approval object
    if (pending !== null && (typeof pending.id !== 'string' || typeof pending.kind !== 'string')) {
      approval10Pass = false;
      break;
    }
  }
  assert(approval10Pass, 'Pending approval verification succeeds consistently across 10/10 attempts');

  let security10Pass = true;
  for (let i = 1; i <= 10; i++) {
    try {
      await adapter.approve(`fake-attempt-${i}`);
      security10Pass = false;
      break;
    } catch (_) {
      // Expected: must reject
    }
  }
  assert(security10Pass, 'Security validation rejects spoofed approvals across 10/10 attempts');

  console.log('\n[Suite 4] Audit Logging Verification (Security Requirement 7)');
  const auditPath = auditLogger.getLogPath();
  assert(fs.existsSync(auditPath), `Local audit log file exists at ${auditPath}`);
  const auditContent = fs.readFileSync(auditPath, 'utf8');
  assert(auditContent.includes('"action":"CONNECT"'), 'Audit log contains CONNECT entry');

  console.log('\n[Suite 5] Teardown & Disconnection');
  await adapter.disconnect();
  const disconnectedSnapshot = await adapter.getSnapshot();
  assert(disconnectedSnapshot.status === 'disconnected', 'Status transitioned to "disconnected"');

  console.log('\n' + '='.repeat(75));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(75));

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
