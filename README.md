# mediacurator-poc

Publish media assets for myself.

A small Node + HTMX web app that stores audio in an Azure Blob container:

- **`POST /api/files`** — upload endpoint for applications and agents. Takes a raw
  binary body or `multipart/form-data`.
- **A listing page** — every audio file in the container, newest first.
- **Click a file name** — it streams into the browser's audio player, seeking included.
- **Delete** — per-file, once unlocked.

The container stays private. Nothing is ever served straight from Blob Storage; the
app streams the bytes itself, so no blob URL or SAS token leaves the server.

## How access works

| | Who can do it |
| --- | --- |
| Browse the list, play a file | Anyone who can reach the app |
| Upload, delete | Anyone holding `API_SECRET` |

Two doors, one secret:

- **Agents and scripts** send `Authorization: Bearer <API_SECRET>` (or `X-Api-Key`).
- **The browser** exchanges the secret once, via the unlock form, for a signed
  HttpOnly cookie. The secret never appears in page source or client-side JS —
  which it would have to if the delete button carried it.

Hiding the delete button when locked is only a UI convenience. Every write is
re-checked server-side, so `curl` without the header gets a 401 regardless.

> **Note:** with playback open, anyone who knows the app URL can list and stream
> everything in the container. That is a deliberate choice for this POC. To close
> it, turn on App Service Authentication (Easy Auth) — no app-code change needed.

## Storage authentication

The app never holds a storage key or connection string. It uses
`DefaultAzureCredential`, which resolves to:

- the web app's **managed identity** when running on App Service, and
- **your `az login` session** when running locally.

Either identity needs the **Storage Blob Data Contributor** role on the container.
Reader is not enough — it covers neither upload nor delete.

## Local development

```bash
npm install
cp .env.example .env     # then fill in the account and container names
az login
npm start                # http://localhost:3000
```

`npm run dev` restarts on file changes. `npm test` runs the helper unit tests
(name sanitizing, range parsing, size formatting) — these are pure functions and
need no Azure access.

**This project uses npm.** `package.json` pins `"packageManager": "npm@11.5.1"`,
so pnpm and yarn refuse to install rather than quietly writing a second lockfile.
`package-lock.json` is committed and is what both local installs and the Azure
build resolve from.

If you get a **403** from storage with a perfectly valid login, your own user
account is missing the role on the container. Grant it the same way as step 2 below,
using your own object ID (`az ad signed-in-user show --query id -o tsv`) in place of
the managed identity's. If that command fails with `MissingSubscription`, see
[the REST workaround](#if-az-role-assignment-fails-with-missingsubscription) and use
`principalType: "User"`.

## Deploying to Azure App Service

Both the storage account and the container are assumed to exist already.

```bash
# 1. Give the web app a system-assigned managed identity
az webapp identity assign -g <rg> -n <app>

# 2. Grant that identity data-plane access to the container.
#    Contributor, not Reader — it must cover write AND delete.
az role assignment create \
  --assignee <principalId-from-step-1> \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>"

# 3. Application settings
az webapp config appsettings set -g <rg> -n <app> --settings \
  AZURE_STORAGE_ACCOUNT=<account> \
  AZURE_BLOB_CONTAINER=<container> \
  API_SECRET="$(openssl rand -base64 32)" \
  COOKIE_SECRET="$(openssl rand -base64 32)" \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true

# 4. Runtime and startup command
az webapp config set -g <rg> -n <app> \
  --linux-fx-version "NODE|24-lts" \
  --startup-file "node server.js"

# 5. Deploy
az webapp up -g <rg> -n <app> --runtime "NODE|24-lts"
```

Set the health check path to `/healthz` if you use one.

### If `az role assignment` fails with `MissingSubscription`

Some az CLI installs return `MissingSubscription` for the entire `az role assignment`
command group — including `list`, and even at plain subscription scope — while every
other ARM call works normally. That is the command group misbehaving, not a problem
with your permissions or your `--scope`. Create the assignment through the ARM REST
API instead:

```bash
SUB=<sub>
PRINCIPAL=<principalId-from-step-1>
# "Storage Blob Data Contributor" — this GUID is the same in every tenant
ROLE=ba92f5b4-2d11-453d-a403-e96b0029c9fe
SCOPE="/subscriptions/$SUB/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>"
# Any fresh GUID; it becomes the assignment's name
NAME=$(node -e "console.log(require('crypto').randomUUID())")

cat > ra.json <<JSON
{
  "properties": {
    "roleDefinitionId": "/subscriptions/$SUB/providers/Microsoft.Authorization/roleDefinitions/$ROLE",
    "principalId": "$PRINCIPAL",
    "principalType": "ServicePrincipal"
  }
}
JSON

az rest --method put \
  --url "https://management.azure.com$SCOPE/providers/Microsoft.Authorization/roleAssignments/$NAME?api-version=2022-04-01" \
  --body @ra.json
```

Two details that matter:

- **`principalType`** is `ServicePrincipal` for a managed identity, `User` for your
  own account when setting up local development.
- **The PUT is idempotent.** If it fails with a connection reset — ARM does this
  intermittently — just run it again with the same `$NAME`. Re-running a successful
  call is harmless.

Verify it took by doing something that needs the data plane, since `az role
assignment list` is broken in the same way:

```bash
az storage blob list --account-name <account> --container-name <container> --auth-mode login -o table
```

Expect a 403 for the first minute or two while the assignment propagates.

Things that will bite otherwise:

- **Role assignments take a minute or two to propagate.** A 403 immediately after
  step 2 usually just means "not yet".
- **App Service times out requests at 230 seconds.** That, not `MAX_UPLOAD_BYTES`,
  is the real ceiling on upload size over a slow connection.
- **`API_SECRET` is a bearer token over TLS.** Rotating it means updating the app
  setting and every caller.
- **The Oryx build runs `npm install` against the committed `package-lock.json`.**
  Keep that lockfile in sync with `package.json` — if the two disagree, `npm
  install` silently resolves fresh instead of honouring the pins, and the
  deployed dependency tree stops matching the one you tested locally.

## API

All three endpoints require the secret. Blob names travel as a query parameter,
never a path segment.

### Upload — `POST /api/files`

Raw body (simplest for an agent — one request, no multipart assembly):

```bash
curl -X POST "https://<app>.azurewebsites.net/api/files" \
  -H "Authorization: Bearer <secret>" \
  -H "X-File-Name: episode-12.mp3" \
  -H "Content-Type: audio/mpeg" \
  --data-binary @episode-12.mp3
```

Multipart, one or more files per request:

```bash
curl -X POST "https://<app>.azurewebsites.net/api/files" \
  -H "Authorization: Bearer <secret>" \
  -F "file=@episode-12.mp3;type=audio/mpeg"
```

```jsonc
// 201
{
  "uploaded": [{ "name": "episode-12.mp3", "size": 5242880, "contentType": "audio/mpeg" }],
  "rejected": []
}
```

Optional headers:

- `X-Overwrite: true` — replace an existing blob of the same name. Without it, a
  collision is renamed to `episode-12-2.mp3`, `episode-12-3.mp3`, and so on.

**Always read `uploaded[].name` from the response** — collision handling means the
stored name is not always the name you sent.

Failure modes: `400` (no usable filename, or empty body), `401` (bad or missing
secret), `413` (over `MAX_UPLOAD_BYTES`), `415` (not a recognised audio extension).

### List — `GET /api/files`

```bash
curl -H "Authorization: Bearer <secret>" "https://<app>.azurewebsites.net/api/files"
```

```jsonc
{
  "files": [
    {
      "name": "episode-12.mp3",
      "size": 5242880,
      "contentType": "audio/mpeg",
      "lastModified": "2026-09-20T10:14:00.000Z"
    }
  ]
}
```

### Delete — `DELETE /api/files?name=<url-encoded>`

```bash
curl -X DELETE -H "Authorization: Bearer <secret>" \
  "https://<app>.azurewebsites.net/api/files?name=episode-12.mp3"
```

`204` on success, `404` if the blob was not there.

### Playback — `GET /audio?name=<url-encoded>`

Open, no secret. Supports `Range`, returning `206 Partial Content`, which is what
makes seeking work and what Safari and iOS require before they will play at all.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AZURE_STORAGE_ACCOUNT` | yes | — | Account **name** only |
| `AZURE_BLOB_CONTAINER` | yes | — | Must already exist |
| `API_SECRET` | yes | — | Guards upload and delete |
| `COOKIE_SECRET` | yes | — | Signs the unlock cookie |
| `AZURE_CLIENT_ID` | no | — | Only for a *user*-assigned managed identity |
| `MAX_UPLOAD_BYTES` | no | `536870912` | 512 MB |
| `PORT` | no | `3000` | App Service injects this |

## Layout

```
server.js            express wiring, error handling
src/config.js        env validation, fails fast
src/blob.js          the only module that talks to Azure Storage
src/util.js          pure helpers (sanitizing, ranges, formatting)
src/auth.js          write-access checks, unlock/lock routes
src/routes/api.js    POST/GET/DELETE /api/files
src/routes/audio.js  Range-aware streaming
src/routes/pages.js  page and HTMX fragment routes
views/               EJS page + fragments
public/              stylesheet and ~30 lines of JS
```

Uploads stream from the request straight into Blob Storage — a whole file is never
buffered in memory, which matters on a small App Service instance.
