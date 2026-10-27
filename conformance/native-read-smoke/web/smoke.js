// Closed bootstrap dispatch; existing profiles retain their one no-argument capture.
window.__TAURI_INTERNALS__.invoke('capture_native_reads').then(
  (reply) => {
    if (reply?.profile === 'managed-action') {
      import('./quit.js').then(({ mountManagedActionFixture }) => mountManagedActionFixture(reply)).catch(() => { document.getElementById('state').textContent = 'Managed fixture unavailable; inspect native evidence.'; });
    } else if (reply?.profile === 'quit-timing') {
      import('./quit.js')
        .then(({ mountQuitFixture }) => mountQuitFixture(reply))
        .catch(() => {
          document.getElementById('state').textContent =
            'Quit fixture unavailable; inspect native evidence.';
        });
    } else document.getElementById('state').textContent = 'Capture finished.';
  },
  () => {
    document.getElementById('state').textContent = 'Capture unavailable; inspect the report.';
  },
);
