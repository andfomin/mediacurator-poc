import express from 'express';
import Busboy from 'busboy';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { requireWriteAccess } from '../auth.js';
import { deleteBlob, getBlobInfo, listAudioBlobs, resolveBlobName, uploadBlobStream } from '../blob.js';
import { isAudioName, isSafeBlobName, resolveContentType, sanitizeBlobName } from '../util.js';

export const apiRouter = express.Router();

const MAX_FILES_PER_REQUEST = 20;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function wantsOverwrite(req) {
  return req.get('x-overwrite')?.trim().toLowerCase() === 'true';
}

/**
 * One endpoint serves both the page and agents, so the response format is
 * chosen by the HX-Request header HTMX sets: HTML fragment for the browser,
 * JSON for everyone else.
 */
async function respond(req, res, status, payload) {
  if (req.get('hx-request')) {
    const files = await listAudioBlobs();
    return res.status(200).render('partials/file-list', { files, canWrite: true, oob: false });
  }
  return res.status(status).json(payload);
}

/** Aborts the upload mid-stream once the configured ceiling is crossed. */
function byteLimiter(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(httpError(413, 'too_large', `Upload exceeds MAX_UPLOAD_BYTES (${maxBytes}).`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Raw-body upload: the request body IS the file. This is the easy path for an
 * agent — one fetch with a body, no multipart assembly.
 */
async function handleRawUpload(req, res) {
  const headerName = req.get('x-file-name');
  const queryName = typeof req.query.name === 'string' ? req.query.name : '';
  const name = sanitizeBlobName(headerName || queryName);

  if (!name) {
    throw httpError(400, 'bad_request', 'An X-File-Name header (or ?name=) with a usable filename is required.');
  }
  if (!isAudioName(name)) {
    throw httpError(415, 'unsupported_type', `${name} does not have a supported audio extension.`);
  }

  const declaredLength = Number(req.get('content-length'));
  if (Number.isFinite(declaredLength)) {
    if (declaredLength === 0) {
      throw httpError(400, 'bad_request', 'Request body is empty.');
    }
    if (declaredLength > config.maxUploadBytes) {
      throw httpError(413, 'too_large', `Upload exceeds MAX_UPLOAD_BYTES (${config.maxUploadBytes}).`);
    }
  }

  const contentType = resolveContentType(req.get('content-type'), name);
  const finalName = await resolveBlobName(name, wantsOverwrite(req));
  const limiter = byteLimiter(config.maxUploadBytes);
  req.pipe(limiter);
  await uploadBlobStream(finalName, limiter, contentType);

  const info = await getBlobInfo(finalName);
  return respond(req, res, 201, {
    uploaded: [{ name: finalName, size: info?.size ?? 0, contentType }],
    rejected: [],
  });
}

/** multipart/form-data upload, for tools that only speak HTML forms. */
function parseMultipart(req, overwrite) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: config.maxUploadBytes, files: MAX_FILES_PER_REQUEST },
    });

    const uploaded = [];
    const rejected = [];
    const pending = [];

    busboy.on('file', (_field, stream, info) => {
      const name = sanitizeBlobName(info.filename ?? '');
      if (!name || !isAudioName(name)) {
        rejected.push({
          filename: info.filename ?? '',
          reason: name ? 'unsupported_type' : 'invalid_filename',
        });
        stream.resume();
        return;
      }

      // busboy truncates at the limit rather than erroring, which would commit a
      // half a file. Destroying the stream makes the upload fail instead.
      stream.on('limit', () => {
        stream.destroy(httpError(413, 'too_large', `${name} exceeds MAX_UPLOAD_BYTES (${config.maxUploadBytes}).`));
      });

      const contentType = resolveContentType(info.mimeType, name);
      pending.push(
        (async () => {
          const finalName = await resolveBlobName(name, overwrite);
          await uploadBlobStream(finalName, stream, contentType);
          const stored = await getBlobInfo(finalName);
          uploaded.push({ name: finalName, size: stored?.size ?? 0, contentType });
        })(),
      );
    });

    busboy.on('error', reject);
    busboy.on('close', async () => {
      const results = await Promise.allSettled(pending);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) {
        reject(failure.reason);
        return;
      }
      resolve({ uploaded, rejected });
    });

    req.pipe(busboy);
  });
}

async function handleMultipartUpload(req, res) {
  const { uploaded, rejected } = await parseMultipart(req, wantsOverwrite(req));
  if (uploaded.length === 0) {
    if (rejected.length > 0) {
      throw httpError(415, 'unsupported_type', 'No supported audio files in the request.');
    }
    throw httpError(400, 'bad_request', 'No file part found in the request.');
  }
  return respond(req, res, 201, { uploaded, rejected });
}

apiRouter.post('/files', requireWriteAccess, async (req, res) => {
  const contentType = req.get('content-type') ?? '';
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    return handleMultipartUpload(req, res);
  }
  return handleRawUpload(req, res);
});

apiRouter.get('/files', requireWriteAccess, async (req, res) => {
  const files = await listAudioBlobs();
  return res.json({
    files: files.map((file) => ({
      name: file.name,
      size: file.size,
      contentType: file.contentType,
      lastModified: file.lastModified?.toISOString() ?? null,
    })),
  });
});

apiRouter.delete('/files', requireWriteAccess, async (req, res) => {
  const name = req.query.name;
  if (typeof name !== 'string' || !isSafeBlobName(name)) {
    throw httpError(400, 'bad_request', 'A valid ?name= is required.');
  }

  const deleted = await deleteBlob(name);

  if (req.get('hx-request')) {
    const files = await listAudioBlobs();
    return res.status(200).render('partials/file-list', { files, canWrite: true, oob: false });
  }
  if (!deleted) {
    throw httpError(404, 'not_found', `No blob named ${name}.`);
  }
  return res.status(204).end();
});
