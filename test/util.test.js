import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  formatBytes,
  isAudioName,
  isSafeBlobName,
  parseRange,
  resolveContentType,
  safeEqual,
  sanitizeBlobName,
  withNameSuffix,
} from '../src/util.js';

describe('sanitizeBlobName', () => {
  test('keeps ordinary names intact', () => {
    assert.equal(sanitizeBlobName('Episode 12 - intro.mp3'), 'Episode 12 - intro.mp3');
  });

  test('strips any directory component', () => {
    assert.equal(sanitizeBlobName('../../etc/passwd.mp3'), 'passwd.mp3');
    assert.equal(sanitizeBlobName(String.raw`C:\Users\andfo\song.mp3`), 'song.mp3');
  });

  test('cannot produce a traversal or empty name', () => {
    assert.equal(sanitizeBlobName('..'), '');
    assert.equal(sanitizeBlobName('...'), '');
    assert.equal(sanitizeBlobName('/'), '');
    assert.equal(sanitizeBlobName(undefined), '');
  });

  test('keeps unicode letters but replaces separators', () => {
    assert.equal(sanitizeBlobName('kävely/ilta.mp3'), 'ilta.mp3');
    assert.equal(sanitizeBlobName('kävely-ilta.mp3'), 'kävely-ilta.mp3');
  });

  test('truncates long names without losing the extension', () => {
    const long = `${'a'.repeat(400)}.mp3`;
    const result = sanitizeBlobName(long);
    assert.ok(result.length <= 200);
    assert.ok(result.endsWith('.mp3'));
  });
});

describe('isSafeBlobName', () => {
  test('accepts normal names', () => {
    assert.equal(isSafeBlobName('song.mp3'), true);
    assert.equal(isSafeBlobName('2026/song.mp3'), true);
  });

  test('rejects traversal, absolutes and control characters', () => {
    assert.equal(isSafeBlobName('../secret.mp3'), false);
    assert.equal(isSafeBlobName('/song.mp3'), false);
    assert.equal(isSafeBlobName(String.raw`a\b.mp3`), false);
    assert.equal(isSafeBlobName('song\u0000.mp3'), false);
    assert.equal(isSafeBlobName(''), false);
  });
});

describe('parseRange', () => {
  test('returns null when the whole entity should be sent', () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange('bytes=-', 100), null);
    assert.equal(parseRange('items=0-10', 100), null);
    assert.equal(parseRange('bytes=0-10,20-30', 100), null);
  });

  test('parses an explicit range', () => {
    assert.deepEqual(parseRange('bytes=0-499', 1000), { start: 0, end: 499, satisfiable: true });
  });

  test('clamps an open-ended range to the last byte', () => {
    assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999, satisfiable: true });
    assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999, satisfiable: true });
  });

  test('handles the suffix form', () => {
    assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999, satisfiable: true });
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999, satisfiable: true });
  });

  test('flags ranges that cannot be satisfied', () => {
    assert.deepEqual(parseRange('bytes=1000-', 1000), { satisfiable: false });
    assert.deepEqual(parseRange('bytes=0-0', 0), { satisfiable: false });
    assert.deepEqual(parseRange('bytes=-0', 1000), { satisfiable: false });
  });
});

describe('formatBytes', () => {
  test('formats across units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(120 * 1024 * 1024), '120 MB');
  });

  test('rejects nonsense', () => {
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes(Number.NaN), '');
  });
});

describe('audio typing', () => {
  test('recognises supported extensions only', () => {
    assert.equal(isAudioName('a.mp3'), true);
    assert.equal(isAudioName('a.FLAC'), true);
    assert.equal(isAudioName('a.txt'), false);
    assert.equal(isAudioName('mp3'), false);
  });

  test('prefers a declared audio type, falls back to the extension', () => {
    assert.equal(resolveContentType('audio/mp4; codecs=mp4a', 'a.mp3'), 'audio/mp4');
    assert.equal(resolveContentType('application/octet-stream', 'a.mp3'), 'audio/mpeg');
    assert.equal(resolveContentType(undefined, 'a.opus'), 'audio/opus');
  });
});

describe('withNameSuffix', () => {
  test('inserts the counter before the extension', () => {
    assert.equal(withNameSuffix('song.mp3', 2), 'song-2.mp3');
    assert.equal(withNameSuffix('song', 3), 'song-3');
    assert.equal(withNameSuffix('a.b.mp3', 2), 'a.b-2.mp3');
  });
});

describe('safeEqual', () => {
  test('compares without leaking length', () => {
    assert.equal(safeEqual('secret', 'secret'), true);
    assert.equal(safeEqual('secret', 'secrets'), false);
    assert.equal(safeEqual('secret', ''), false);
    assert.equal(safeEqual(undefined, 'secret'), false);
  });
});
