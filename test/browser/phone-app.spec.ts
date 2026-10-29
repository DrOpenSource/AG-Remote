/**
 * Phone app in a real (mobile-sized) browser against a fake agent. Covers release-plan 0.2.3-T2 and
 * the core flows the regression checklist checks by hand: open, read, approve, deny, prompt, stop, attach.
 */
import { test, expect, type Page } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:49391';
const TOKEN = 'browser-test-token';

async function control(path: string, body?: unknown) {
  const res = await fetch(CONTROL + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}
const calls = (): Promise<any[]> => control('/calls');

async function openApp(page: Page) {
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator('#statusText')).toHaveText('Ready');
}

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.beforeEach(async () => {
  await fetch(CONTROL + '/reset', { method: 'POST' });
});

test('without a token it asks to pair', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#pairingModal')).toBeVisible();
  await expect(page.locator('#tokenInput')).toBeVisible();
});

test('opens connected and shows the project as the title', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#sessionLabel')).toContainText('demo-project');
  await expect(page.locator('#pairingModal')).toBeHidden();
  // Nothing wider than the phone screen
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('shows agent messages, with file links as file names', async ({ page }) => {
  await openApp(page);
  await control('/message', { text: 'Read [NOTES.md](file:///c:/repo/NOTES.md) and see [docs](https://example.com).' });
  const bubble = page.locator('.chat-message.agent').last();
  await expect(bubble.locator('.chat-file')).toHaveText('NOTES.md');
  await expect(bubble.locator('.chat-file')).toHaveAttribute('title', 'c:/repo/NOTES.md');
  await expect(bubble.locator('a.chat-link')).toHaveAttribute('href', 'https://example.com');
  await expect(bubble).not.toContainText('file:///');
});

test('message text is never run as HTML', async ({ page }) => {
  await openApp(page);
  await control('/message', { text: '<img src=x onerror="window.__pwned=1"> hello' });
  await expect(page.locator('.chat-message.agent').last()).toContainText('<img src=x');
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
});

test('approves a command once', async ({ page }) => {
  await openApp(page);
  await control('/approval', { detail: 'npm test' });
  await expect(page.locator('#approvalCard')).toBeVisible();
  await expect(page.locator('#approvalDetail')).toHaveText('npm test');
  await page.locator('#btnApprove').click();
  await expect(page.locator('#approvalCard')).toBeHidden();
  expect((await calls()).find(c => c.type === 'approve')?.option).toBe('allow_once');
});

test('denies with a note', async ({ page }) => {
  await openApp(page);
  await control('/approval', { detail: 'rm -rf build' });
  await page.locator('#approvalDenyNote').fill('use npm run clean instead');
  await page.locator('#btnDeny').click();
  await expect(page.locator('#approvalCard')).toBeHidden();
  expect((await calls()).find(c => c.type === 'deny')?.reason).toBe('use npm run clean instead');
});

test('sends a prompt and clears the box', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#btnSend')).toBeDisabled();
  await page.locator('#promptInput').fill('add a test for the parser');
  await page.locator('#btnSend').click();
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect.poll(async () => (await calls()).find(c => c.type === 'prompt')?.text).toBe('add a test for the parser');
});

test('attach tray adds and removes an image', async ({ page }) => {
  await openApp(page);
  await page.locator('#attachInput').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('.attach-item')).toHaveCount(1);
  // An image alone is enough to send
  await expect(page.locator('#btnSend')).toBeEnabled();
  await page.locator('.attach-remove').click();
  await expect(page.locator('.attach-item')).toHaveCount(0);
  await expect(page.locator('#attachTray')).toBeHidden();
  await expect(page.locator('#btnSend')).toBeDisabled();
});

test('sends an image-only prompt, compressed to JPEG under 400 KB', async ({ page }) => {
  await openApp(page);
  // A large photo-like image made in the page, picked through the real file input
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 4000;
    c.height = 3000;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = `hsl(${i % 360} 70% ${30 + (i % 40)}%)`;
      ctx.fillRect((i * 37) % 4000, (i * 53) % 3000, 120, 90);
    }
    const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
    const input = document.getElementById('attachInput') as HTMLInputElement;
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('.attach-item')).toHaveCount(1, { timeout: 10_000 });
  await page.locator('#btnSend').click();
  await expect(page.locator('.chat-message.user .chat-images img')).toHaveCount(1);
  await expect.poll(async () => (await calls()).find(c => c.type === 'prompt')).toBeTruthy();
  const prompt = (await calls()).find(c => c.type === 'prompt');
  expect(prompt.text).toBe('');
  expect(prompt.images).toHaveLength(1);
  expect(prompt.images[0].mimeType).toBe('image/jpeg');
  expect(prompt.images[0].bytes).toBeLessThanOrEqual(400 * 1024);
});

test.describe('"Last active" line for a quiet conversation', () => {
  const lastActive = (page: Page) => page.locator('#lastActive');

  test('idle for 3 hours: shows "Last active 3 h ago"', async ({ page }) => {
    await control('/last-active', { minutesAgo: 185 });
    await openApp(page);
    await expect(lastActive(page)).toBeVisible();
    await expect(lastActive(page)).toHaveText('Last active 3 h ago');
  });

  test('minutes and days read naturally', async ({ page }) => {
    await control('/last-active', { minutesAgo: 25 });
    await openApp(page);
    await expect(lastActive(page)).toHaveText('Last active 25 min ago');
    await control('/last-active', { minutesAgo: 2 * 24 * 60 + 30 });
    await page.reload();
    await expect(lastActive(page)).toHaveText('Last active 2 days ago');
    await control('/last-active', { minutesAgo: 26 * 60 });
    await page.reload();
    await expect(lastActive(page)).toHaveText('Last active 1 day ago');
  });

  test('recent activity: no line', async ({ page }) => {
    await control('/last-active', { minutesAgo: 2 });
    await openApp(page);
    await expect(lastActive(page)).toBeHidden();
  });

  test('no activity time known: no line', async ({ page }) => {
    await openApp(page);
    await expect(lastActive(page)).toBeHidden();
  });

  test('hidden while the agent works or needs you, and after a new message', async ({ page }) => {
    await control('/last-active', { minutesAgo: 185 });
    await openApp(page);
    await expect(lastActive(page)).toBeVisible();
    await control('/approval', {});
    await expect(lastActive(page)).toBeHidden(); // needs you
    await page.locator('#btnApprove').click();
    await expect(page.locator('#statusText')).toHaveText('Working');
    await expect(lastActive(page)).toBeHidden(); // working
    await page.locator('#btnStop').click();
    await expect(page.locator('#statusText')).toHaveText('Ready');
    await expect(lastActive(page)).toBeHidden(); // it was just active
    await control('/last-active', { minutesAgo: 185 });
    await page.reload();
    await expect(lastActive(page)).toBeVisible();
    await control('/message', { text: 'done' });
    await expect(lastActive(page)).toBeHidden();
  });
});

test('stop button appears while the agent works and stops it', async ({ page }) => {
  await openApp(page);
  await control('/approval', {});
  await page.locator('#btnApprove').click(); // fake agent moves to "generating"
  await expect(page.locator('#statusText')).toHaveText('Working');
  await page.locator('#btnStop').click();
  await expect.poll(async () => (await calls()).some(c => c.type === 'stop')).toBe(true);
  await expect(page.locator('#statusText')).toHaveText('Ready');
});
