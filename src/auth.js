import express from 'express';
import { config } from './config.js';
import { listAudioBlobs } from './blob.js';
import { safeEqual } from './util.js';

const COOKIE_NAME = 'mc_write';
const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FAILED_UNLOCK_DELAY_MS = 500;

/**
 * Write access has two doors, one secret.
 *
 *  - `Authorization: Bearer <secret>` / `X-Api-Key` — for agents and scripts.
 *    Browsers never attach these automatically, so this path cannot be forged
 *    by a third-party page.
 *  - The signed `mc_write` cookie — for the browser UI, set by POST /unlock so
 *    the secret never has to appear in page source or client-side JS.
 */
export function hasWriteAccess(req) {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ') && safeEqual(authorization.slice(7).trim(), config.apiSecret)) {
    return true;
  }
  const apiKey = req.get('x-api-key');
  if (apiKey && safeEqual(apiKey, config.apiSecret)) return true;
  return req.signedCookies?.[COOKIE_NAME] === '1';
}

/** Makes `canWrite` available to every template without each route passing it. */
export function writeAccessLocals(req, res, next) {
  res.locals.canWrite = hasWriteAccess(req);
  next();
}

/**
 * The real gate. Hiding the delete button is only a UI convenience — every
 * write goes through here, whether it came from the page or from curl.
 *
 * htmx does not swap non-2xx responses, so a browser whose cookie expired gets
 * JSON here too; public/app.js notices the 401 and reloads into the unlock form.
 */
export function requireWriteAccess(req, res, next) {
  if (hasWriteAccess(req)) return next();
  return res
    .status(401)
    .set('WWW-Authenticate', 'Bearer realm="mediacurator"')
    .json({ error: 'unauthorized', message: 'Send Authorization: Bearer <API_SECRET>, or unlock in the browser.' });
}

/**
 * Unlocking flips both the write panel and the file list (delete buttons), so
 * both are returned in one response: the panel as the normal swap, the list as
 * an out-of-band swap.
 */
async function renderWriteState(res, { canWrite, error, status = 200 }) {
  const files = await listAudioBlobs();
  res.locals.canWrite = canWrite;
  res.status(status).render('partials/write-state', { canWrite, error, files });
}

export const authRouter = express.Router();

authRouter.post('/unlock', express.urlencoded({ extended: false }), async (req, res) => {
  const secret = typeof req.body?.secret === 'string' ? req.body.secret : '';
  if (!safeEqual(secret, config.apiSecret)) {
    // Fixed delay on failure: makes online guessing tedious. The comparison
    // itself is already constant-time.
    await new Promise((resolve) => setTimeout(resolve, FAILED_UNLOCK_DELAY_MS));
    // 200 so htmx still swaps in the panel carrying the error message.
    return renderWriteState(res, { canWrite: false, error: 'That secret is not valid.' });
  }
  res.cookie(COOKIE_NAME, '1', {
    signed: true,
    httpOnly: true,
    // Strict is the CSRF defence for the cookie path: a third-party page cannot
    // make the browser attach this cookie to a cross-site POST or DELETE.
    sameSite: 'strict',
    secure: config.isProduction,
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
  return renderWriteState(res, { canWrite: true });
});

authRouter.post('/lock', async (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return renderWriteState(res, { canWrite: false });
});
