import express from 'express';
import { getBlobInfo, listAudioBlobs } from '../blob.js';
import { isSafeBlobName } from '../util.js';

export const pagesRouter = express.Router();

pagesRouter.get('/', async (req, res) => {
  const files = await listAudioBlobs();
  res.render('index', { files, error: null });
});

/** The file list on its own, for HTMX refreshes. */
pagesRouter.get('/files', async (req, res) => {
  const files = await listAudioBlobs();
  res.render('partials/file-list', { files, oob: false });
});

/**
 * Swapping a fresh <audio> into #player replaces whatever was there, so only
 * one file ever plays at a time. Autoplay is allowed because this swap always
 * follows a click.
 */
pagesRouter.get('/player', async (req, res) => {
  const name = req.query.name;
  if (typeof name !== 'string' || !isSafeBlobName(name)) {
    return res.status(400).render('partials/player', { file: null, error: 'Invalid file name.' });
  }
  const info = await getBlobInfo(name);
  if (!info) {
    return res.status(404).render('partials/player', { file: null, error: `${name} is no longer available.` });
  }
  return res.render('partials/player', { file: info, error: null });
});

/** Health probe for App Service. Deliberately does not touch storage. */
pagesRouter.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});
