import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { authRouter, writeAccessLocals } from './src/auth.js';
import { apiRouter } from './src/routes/api.js';
import { audioRouter } from './src/routes/audio.js';
import { pagesRouter } from './src/routes/pages.js';
import { formatBytes } from './src/util.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// App Service terminates TLS at the front end; trust its headers so `secure`
// cookies and req.protocol behave correctly behind the proxy.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));

app.use(cookieParser(config.cookieSecret));
app.use('/static', express.static(path.join(rootDir, 'public')));
// htmx comes from node_modules, so its version is pinned in package.json and
// there is no CDN in the request path.
app.use('/vendor', express.static(path.join(rootDir, 'node_modules/htmx.org/dist')));

// No global body parser: POST /api/files needs the raw request stream intact so
// it can be piped straight to Blob Storage. Only /unlock parses a body.
app.use(writeAccessLocals);
app.locals.formatBytes = formatBytes;

app.use('/api', apiRouter);
app.use(authRouter);
app.use(audioRouter);
app.use(pagesRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}.` });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const status = error.status ?? error.statusCode ?? 500;

  // The single most likely first-run failure, so name the fix explicitly.
  const isRoleProblem = status === 403 && error.name === 'RestError';
  const message = isRoleProblem
    ? `Storage returned 403. The identity in use needs the "Storage Blob Data Contributor" role on container "${config.container}" of account "${config.account}" — locally that is your own az login account, in Azure it is the web app's managed identity.`
    : (error.message ?? 'Unexpected error.');

  if (status >= 500) console.error(error);
  else console.warn(`${status} ${req.method} ${req.originalUrl}: ${message}`);

  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error: error.code ?? 'error', message });
});

app.listen(config.port, () => {
  console.log(`mediacurator listening on port ${config.port}`);
  console.log(`  account=${config.account} container=${config.container}`);
});
