import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { config } from './config.js';
import { isAudioName, withNameSuffix } from './util.js';

const UPLOAD_BUFFER_BYTES = 8 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const MAX_COLLISION_ATTEMPTS = 50;

let containerClient;

/**
 * One credential and one client for the process. DefaultAzureCredential picks up
 * the App Service managed identity in Azure and your `az login` session locally,
 * so no secret ever reaches this code.
 */
export function getContainerClient() {
  if (!containerClient) {
    const credential = new DefaultAzureCredential(
      config.azureClientId ? { managedIdentityClientId: config.azureClientId } : {},
    );
    const service = new BlobServiceClient(
      `https://${config.account}.blob.core.windows.net`,
      credential,
    );
    containerClient = service.getContainerClient(config.container);
  }
  return containerClient;
}

function isNotFound(error) {
  return error?.statusCode === 404 || error?.code === 'BlobNotFound' || error?.code === 'ContainerNotFound';
}

/** Audio blobs in the container, newest first. */
export async function listAudioBlobs() {
  const files = [];
  for await (const blob of getContainerClient().listBlobsFlat()) {
    const contentType = blob.properties.contentType ?? '';
    if (!isAudioName(blob.name) && !contentType.startsWith('audio/')) continue;
    files.push({
      name: blob.name,
      size: blob.properties.contentLength ?? 0,
      contentType,
      lastModified: blob.properties.lastModified ?? null,
    });
  }
  files.sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
  return files;
}

/** Blob metadata, or null when it does not exist. */
export async function getBlobInfo(name) {
  try {
    const properties = await getContainerClient().getBlobClient(name).getProperties();
    return {
      name,
      size: properties.contentLength ?? 0,
      contentType: properties.contentType ?? 'application/octet-stream',
      etag: properties.etag,
      lastModified: properties.lastModified ?? null,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Opens a byte range as a readable stream. `count` of undefined means
 * "everything from offset onwards".
 */
export async function openBlobRange(name, offset, count) {
  const response = await getContainerClient().getBlobClient(name).download(offset, count);
  return response.readableStreamBody;
}

export async function uploadBlobStream(name, stream, contentType) {
  await getContainerClient()
    .getBlockBlobClient(name)
    .uploadStream(stream, UPLOAD_BUFFER_BYTES, UPLOAD_CONCURRENCY, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
}

export async function deleteBlob(name) {
  const response = await getContainerClient().getBlobClient(name).deleteIfExists({
    deleteSnapshots: 'include',
  });
  return response.succeeded;
}

/**
 * Picks the name to write to. Without overwrite, an existing name gains a
 * `-2`, `-3`, … suffix so an upload never silently destroys an earlier file.
 */
export async function resolveBlobName(name, overwrite) {
  if (overwrite) return name;
  const container = getContainerClient();
  if (!(await container.getBlobClient(name).exists())) return name;
  for (let counter = 2; counter <= MAX_COLLISION_ATTEMPTS; counter += 1) {
    const candidate = withNameSuffix(name, counter);
    if (!(await container.getBlobClient(candidate).exists())) return candidate;
  }
  throw Object.assign(new Error(`Could not find a free name for ${name}.`), { status: 409 });
}
