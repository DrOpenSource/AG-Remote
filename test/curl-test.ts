import { exec } from 'child_process';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { RemoteServer } from '../src/server/index.ts';

function runCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) resolve(stderr || stdout || err.message);
      else resolve(stdout);
    });
  });
}

async function testCurl() {
  const adapter = new AntigravityAdapter(process.cwd());
  const sessionManager = new SessionManager(adapter);
  const server = new RemoteServer(sessionManager, { port: 49223 });
  await server.start();
  const token = sessionManager.auth.getSessionToken();

  console.log('1. Testing curl without token...');
  const resNoToken = await runCmd('curl -s -i http://127.0.0.1:49223/api/state');
  const is401 = resNoToken.includes('401 Unauthorized');
  console.log('   Result contains "401 Unauthorized":', is401);

  console.log('2. Testing curl with valid Bearer token...');
  const resWithToken = await runCmd(`curl -s -i -H "Authorization: Bearer ${token}" http://127.0.0.1:49223/api/state`);
  const is200 = resWithToken.includes('200 OK');
  console.log('   Result contains "200 OK":', is200);

  await server.stop();

  if (is401 && is200) {
    console.log('\n✅ CURL ACCEPTANCE CRITERIA VERIFIED SUCCESSFULLY');
  } else {
    console.error('\n❌ CURL VERIFICATION FAILED');
    process.exit(1);
  }
}

testCurl().catch((err) => {
  console.error(err);
  process.exit(1);
});
