const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ ...(process.env.TEST_BROWSER_PATH ? { executablePath: process.env.TEST_BROWSER_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8123');
    const result = await page.evaluate(async () => {
      const { RamVideoBackend } = await import('/src/media/RamVideoBackend.ts');
      const { VideoSample } = await import('/node_modules/mediabunny/dist/bundles/mediabunny.mjs');
      function source(duration = 3) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
        let calls = 0, disposals = 0;
        return {
          info: { backend: 'fake', codec: 'fake', width: 2, height: 2, fps: 1, firstTimestamp: 0, duration, hasAudio: false },
          get calls() { return calls; }, get disposals() { return disposals; },
          async getSample(time) { calls++; return new VideoSample(canvas, { timestamp: time, duration: 1 }); },
          async *samples() { calls++; for (let i = 0; i < 3; i++) yield new VideoSample(canvas, { timestamp: i, duration: 1 }); },
          dispose() { disposals++; },
        };
      }
      const native = source(); const cached = new RamVideoBackend(native);
      const ready = await cached.prepare(1024, new AbortController().signal, () => {});
      const bytes = cached.cacheBytes;
      const first = await cached.getSample(0.5); first.close();
      const again = await cached.getSample(0.5); const timestamp = again.timestamp; again.close();
      const times = []; for await (const frame of cached.samples(1, 3)) { times.push(frame.timestamp); frame.close(); }
      const noDecode = native.calls === 1 && native.disposals === 1;
      cached.dispose();
      const released = cached.cacheBytes === 0 && (await cached.getSample(0)) === null;
      const tooLarge = source(); const skipped = new RamVideoBackend(tooLarge);
      const skip = !(await skipped.prepare(1, new AbortController().signal, () => {})) && tooLarge.calls === 0;
      skipped.dispose();
      const inaccurate = source(1); const overflow = new RamVideoBackend(inaccurate);
      const bounded = !(await overflow.prepare(32, new AbortController().signal, () => {})) && overflow.cacheBytes === 0;
      overflow.dispose();
      const aborter = new AbortController(); const canceled = new RamVideoBackend(source()); let aborted = false;
      try { await canceled.prepare(1024, aborter.signal, state => { if (state.frames === 1) aborter.abort(); }); }
      catch (error) { aborted = error.name === 'AbortError' && canceled.cacheBytes === 0; }
      canceled.dispose();
      return { ready, bytes, timestamp, times, noDecode, released, skip, bounded, aborted };
    });
    assert.ok(result.ready && result.bytes > 0 && result.noDecode && result.released && result.skip && result.bounded && result.aborted);
    assert.equal(result.timestamp, 0); assert.deepEqual(result.times, [1, 2]);
    console.log('RAM CACHE', JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
