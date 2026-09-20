import process from 'node:process';

// Node loads .env natively since 20.12 — no dotenv dependency needed.
// Throws when the file is absent, which is the normal case on App Service.
try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on real environment variables.
}

const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Copy .env.example to .env and fill it in (local), or set it as an App Service application setting.',
    );
  }
  return value;
}

function positiveInt(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return value;
}

export const config = {
  account: required('AZURE_STORAGE_ACCOUNT'),
  container: required('AZURE_BLOB_CONTAINER'),
  apiSecret: required('API_SECRET'),
  cookieSecret: required('COOKIE_SECRET'),
  azureClientId: process.env.AZURE_CLIENT_ID?.trim() || undefined,
  maxUploadBytes: positiveInt('MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES),
  port: positiveInt('PORT', 3000),
  isProduction: process.env.NODE_ENV === 'production' || Boolean(process.env.WEBSITE_SITE_NAME),
};
