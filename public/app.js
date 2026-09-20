// Four small behaviours htmx cannot express declaratively.

document.body.addEventListener('htmx:xhr:progress', (event) => {
  const bar = document.getElementById('upload-progress');
  if (!bar || !event.detail.lengthComputable) return;
  bar.hidden = false;
  bar.value = (event.detail.loaded / event.detail.total) * 100;
});

document.body.addEventListener('htmx:afterRequest', (event) => {
  const request = event.detail.requestConfig;
  if (!request) return;

  // An expired unlock cookie: htmx will not swap a 401, so reload into the
  // unlock form rather than leaving the click looking like it did nothing.
  if (event.detail.xhr && event.detail.xhr.status === 401) {
    window.location.reload();
    return;
  }

  if (request.verb === 'post' && request.path.startsWith('/api/files')) {
    const bar = document.getElementById('upload-progress');
    if (bar) {
      bar.hidden = true;
      bar.value = 0;
    }
    document.getElementById('upload-form')?.reset();
  }

  // Deleting the file that is currently loaded would leave the player pointing
  // at a blob that no longer exists.
  if (request.verb === 'delete') {
    const deleted = new URL(request.path, window.location.origin).searchParams.get('name');
    const audio = document.querySelector('#player audio');
    if (deleted && audio && audio.dataset.name === deleted) {
      document.getElementById('player').innerHTML = '';
    }
  }
});

// Blob Storage records timestamps in UTC and the server has no idea what zone the
// viewer is in, so the markup ships UTC and gets rewritten here. The server-rendered
// text stays readable (as UTC) if this never runs.
const timeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

function localizeTimes() {
  for (const el of document.querySelectorAll('time[datetime]:not([data-localized])')) {
    const parsed = new Date(el.dateTime);
    if (Number.isNaN(parsed.getTime())) continue; // leave the server's UTC text alone
    el.textContent = timeFormat.format(parsed);
    el.dataset.localized = '';
  }
}

// This script is deferred, so the first list is already parsed.
localizeTimes();

// htmx replaces the list wholesale on refresh and delete, and out-of-band after an
// upload. htmx:load covers new content from both; the scan is idempotent and cheap.
document.body.addEventListener('htmx:load', localizeTimes);
