import { test, expect } from '@playwright/test';

/**
 * Drives engine.export() directly through the test harness (no UI). Per the
 * Playwright/ArrayBuffer gotcha, everything happens inside ONE page.evaluate:
 * shuttling raw bytes back out corrupts them, so only booleans/numbers
 * cross the evaluate boundary.
 */

test.describe('export', () => {
  test('png: signature, colour chunk, and decode round-trip against readback', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
      await window.__engineTest!.loadGold();
    });

    const result = await page.evaluate(async () => {
      const host = window.__engineTest!.host;
      const exportResult = await host.export({ target: 'png' });
      const bytes = new Uint8Array(exportResult.data);

      function parseChunkTypes(png: Uint8Array): string[] {
        const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
        let offset = 8;
        const types: string[] = [];
        while (offset < png.length) {
          const length = view.getUint32(offset);
          types.push(String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!));
          offset += 8 + length + 4;
        }
        return types;
      }
      const chunkTypes = parseChunkTypes(bytes);

      const readback = await host.readback({ via: 'quantised' });
      const rb = new Uint8Array(readback.data);
      const cx = Math.floor(readback.width / 2);
      const cy = Math.floor(readback.height / 2);
      const idx = (cy * readback.width + cx) * 4;
      const expectedPixel = [rb[idx]!, rb[idx + 1]!, rb[idx + 2]!, rb[idx + 3]!];

      const blob = new Blob([bytes], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image decode failed'));
      });
      img.src = url;
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx2d = canvas.getContext('2d')!;
      ctx2d.drawImage(img, 0, 0);
      const decoded = ctx2d.getImageData(cx, cy, 1, 1).data;
      URL.revokeObjectURL(url);

      return {
        sigOk:
          bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
          bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10,
        byteLength: bytes.length,
        mime: exportResult.mime,
        hasColourChunk: chunkTypes.includes('cICP') || chunkTypes.includes('sRGB'),
        hasIhdr: chunkTypes.includes('IHDR'),
        decodedWidth: img.naturalWidth,
        decodedHeight: img.naturalHeight,
        width: readback.width,
        height: readback.height,
        decoded: [decoded[0], decoded[1], decoded[2], decoded[3]],
        expectedPixel,
      };
    });

    expect(result.sigOk).toBe(true);
    expect(result.byteLength).toBeGreaterThan(64);
    expect(result.mime).toBe('image/png');
    expect(result.hasIhdr).toBe(true);
    expect(result.hasColourChunk).toBe(true);
    expect(result.decodedWidth).toBe(result.width);
    expect(result.decodedHeight).toBe(result.height);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(result.decoded[i]! - result.expectedPixel[i]!)).toBeLessThanOrEqual(3);
    }
  });

  test('video: codec probe + container magic (or documented environment skip)', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
      await window.__engineTest!.loadGold();
    });

    const probe = await page.evaluate(async () => {
      const configs: Record<string, VideoEncoderConfig> = {
        avc: { codec: 'avc1.42001f', width: 64, height: 64, bitrate: 1_000_000 },
        vp9: { codec: 'vp09.00.10.08', width: 64, height: 64, bitrate: 1_000_000 },
        vp8: { codec: 'vp8', width: 64, height: 64, bitrate: 1_000_000 },
      };
      const out: Record<string, boolean> = {};
      for (const [name, config] of Object.entries(configs)) {
        try {
          out[name] = (await VideoEncoder.isConfigSupported(config)).supported ?? false;
        } catch {
          out[name] = false;
        }
      }
      return out;
    });
    console.log('VIDEO CODEC PROBE:', JSON.stringify(probe));

    const anySupported = Object.values(probe).some(Boolean);
    test.skip(!anySupported, `no VideoEncoder codec supported in this environment: ${JSON.stringify(probe)}`);

    const result = await page.evaluate(async () => {
      const host = window.__engineTest!.host;
      const exportResult = await host.export({ target: 'video', range: { from: 0, to: 0.2 } });
      const bytes = new Uint8Array(exportResult.data);
      const isMp4 =
        bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70; // 'ftyp'
      const isWebm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3; // EBML
      return { mime: exportResult.mime, byteLength: bytes.length, isMp4, isWebm };
    });

    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.isMp4 || result.isWebm).toBe(true);
  });

  test('video: fps=10 over 1s produces a container whose demuxed frame count/rate match', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
      await window.__engineTest!.loadGold();
    });

    const probe = await page.evaluate(async () => {
      const configs: Record<string, VideoEncoderConfig> = {
        avc: { codec: 'avc1.42001f', width: 64, height: 64, bitrate: 1_000_000 },
        vp9: { codec: 'vp09.00.10.08', width: 64, height: 64, bitrate: 1_000_000 },
        vp8: { codec: 'vp8', width: 64, height: 64, bitrate: 1_000_000 },
      };
      const out: Record<string, boolean> = {};
      for (const [name, config] of Object.entries(configs)) {
        try {
          out[name] = (await VideoEncoder.isConfigSupported(config)).supported ?? false;
        } catch {
          out[name] = false;
        }
      }
      return out;
    });
    const anySupported = Object.values(probe).some(Boolean);
    test.skip(!anySupported, `no VideoEncoder codec supported in this environment: ${JSON.stringify(probe)}`);

    // Per tests/CLAUDE.md's Playwright/ArrayBuffer gotcha: do the demux
    // (mediabunny's Input/BufferSource re-parse) inside the SAME
    // page.evaluate as the export, and only cross plain numbers back out.
    // `import('mediabunny')` as a bare specifier can't resolve inside
    // page.evaluate's raw-injected code (no import map in a real browser;
    // Vite only rewrites imports it sees in its own module graph). Use
    // the already-resolved module the harness re-exports instead.
    const result = await page.evaluate(async () => {
      const { Input, BufferSource, ALL_FORMATS } = window.__engineTest!.mediabunny;
      const host = window.__engineTest!.host;
      const exportResult = await host.export({
        target: 'video',
        range: { from: 0, to: 1 },
        options: { fps: 10 },
      });

      const input = new Input({ source: new BufferSource(exportResult.data), formats: ALL_FORMATS });
      const [track] = await input.getVideoTracks();
      if (!track) return { hasTrack: false, packetCount: 0, averagePacketRate: 0, duration: 0 };
      const stats = await track.computePacketStats();
      const duration = await track.computeDuration();
      return {
        hasTrack: true,
        packetCount: stats.packetCount,
        averagePacketRate: stats.averagePacketRate,
        duration,
      };
    });

    expect(result.hasTrack).toBe(true);
    expect(result.packetCount).toBe(10); // 1s @ 10fps
    expect(Math.round(result.averagePacketRate)).toBe(10);
    expect(result.duration).toBeGreaterThan(0.9);
    expect(result.duration).toBeLessThan(1.1);
  });

  test('export-progress: events collected during a video export are strictly increasing and end at total', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
      await window.__engineTest!.loadGold();
    });

    const probe = await page.evaluate(async () => {
      try {
        return (await VideoEncoder.isConfigSupported({
          codec: 'avc1.42001f', width: 64, height: 64, bitrate: 1_000_000,
        })).supported ?? false;
      } catch {
        return false;
      }
    });
    test.skip(!probe, 'no avc VideoEncoder support in this environment');

    const result = await page.evaluate(async () => {
      const host = window.__engineTest!.host;
      const events: { done: number; total: number }[] = [];
      const unsubscribe = host.on('export-progress', (e) => {
        if (e.type !== 'export-progress') return;
        events.push({ done: e.done, total: e.total });
      });
      await host.export({ target: 'video', range: { from: 0, to: 0.5 }, options: { fps: 10 } });
      unsubscribe();
      return events;
    });

    expect(result.length).toBeGreaterThan(0);
    for (let i = 1; i < result.length; i++) expect(result[i]!.done).toBeGreaterThan(result[i - 1]!.done);
    expect(result.at(-1)!.done).toBe(result.at(-1)!.total);
  });

  test('png-sequence: downloads a .tar whose bytes are a valid tar with the right frame count', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
      await window.__engineTest!.loadGold();
    });

    const result = await page.evaluate(async () => {
      const host = window.__engineTest!.host;
      const exportResult = await host.export({
        target: 'png-sequence',
        range: { from: 0, to: 0.4 },
        options: { fps: 10 },
      });
      const bytes = new Uint8Array(exportResult.data);

      const magic = String.fromCharCode(bytes[257]!, bytes[258]!, bytes[259]!, bytes[260]!, bytes[261]!);
      let offset = 0;
      let count = 0;
      const names: string[] = [];
      while (offset + 512 <= bytes.length) {
        const header = bytes.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        let nameEnd = 0;
        while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
        names.push(String.fromCharCode(...header.subarray(0, nameEnd)));
        let sizeStr = '';
        for (let i = 124; i < 136 && header[i] !== 0; i++) sizeStr += String.fromCharCode(header[i]!);
        const size = parseInt(sizeStr.trim() || '0', 8);
        count += 1;
        offset += 512 + Math.ceil(size / 512) * 512;
      }

      return { mime: exportResult.mime, magic, count, names, byteLength: bytes.length };
    });

    expect(result.mime).toBe('application/x-tar');
    expect(result.magic).toBe('ustar');
    expect(result.count).toBe(4); // 0.4s @ 10fps
    expect(result.names).toEqual(['frame-0000.png', 'frame-0001.png', 'frame-0002.png', 'frame-0003.png']);
  });
});
