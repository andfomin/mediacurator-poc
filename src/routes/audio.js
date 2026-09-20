import express from 'express';
import { getBlobInfo, openBlobRange } from '../blob.js';
import { isSafeBlobName, parseRange } from '../util.js';

export const audioRouter = express.Router();

/**
 * Streams a blob to the browser's audio element.
 *
 * The blob name travels as a query parameter rather than a path segment: blob
 * names may contain slashes and other characters that fight Express 5's
 * path-to-regexp matching, and `?name=` sidesteps that entirely.
 *
 * Range support is what makes seeking work, and what makes Safari and iOS play
 * at all — a plain 200 with the whole body is not enough.
 */
audioRouter.get('/audio', async (req, res, next) => {
  const name = req.query.name;
  if (typeof name !== 'string' || !isSafeBlobName(name)) {
    return res.status(400).json({ error: 'bad_request', message: 'A valid ?name= is required.' });
  }

  const info = await getBlobInfo(name);
  if (!info) {
    return res.status(404).json({ error: 'not_found', message: `No blob named ${name}.` });
  }

  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Type': info.contentType,
    'Cache-Control': 'private, max-age=3600',
  });
  if (info.etag) res.set('ETag', info.etag);

  // Answer HEAD from metadata alone; no reason to pull bytes out of Azure.
  if (req.method === 'HEAD') {
    return res.status(200).set('Content-Length', String(info.size)).end();
  }

  const range = parseRange(req.get('range'), info.size);

  if (range && !range.satisfiable) {
    return res.status(416).set('Content-Range', `bytes */${info.size}`).end();
  }

  const offset = range ? range.start : 0;
  const count = range ? range.end - range.start + 1 : undefined;

  if (range) {
    res.status(206).set({
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': String(count),
    });
  } else {
    res.status(200).set('Content-Length', String(info.size));
  }

  const stream = await openBlobRange(name, offset, count);
  if (!stream) {
    return res.status(500).json({ error: 'stream_failed', message: 'Blob returned no body.' });
  }

  // An abandoned seek must not keep pulling bytes from Azure.
  res.on('close', () => stream.destroy());

  stream.on('error', (error) => {
    // Nothing written yet, so a proper error response is still possible.
    if (!res.headersSent) {
      next(error);
      return;
    }
    // Mid-body: the status line is already out, so the only honest signal left
    // is an aborted response rather than a truncated file that looks complete.
    res.destroy(error);
  });

  return stream.pipe(res);
});
