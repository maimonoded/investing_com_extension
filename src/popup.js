// Popup Script
document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const lastSyncEl = document.getElementById('lastSync');
  const holdingsCountEl = document.getElementById('holdingsCount');
  const refreshBtn = document.getElementById('refreshBtn');
  const saveBtn = document.getElementById('saveBtn');
  const debugBtn = document.getElementById('debugBtn');
  const debugOutput = document.getElementById('debugOutput');
  const cacheDurationInput = document.getElementById('cacheDuration');
  const monitoredPathsInput = document.getElementById('monitoredPaths');

  // Load current status and settings
  await loadStatus();

  // Refresh button handler
  refreshBtn.addEventListener('click', async () => {
    setRefreshing(true);
    try {
      await chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' });
      await loadStatus();
    } catch (err) {
      console.error('Refresh failed:', err);
      alert('Failed to refresh portfolio data. Make sure you are logged in to investing.com.');
    }
    setRefreshing(false);
  });

  // Save button handler
  saveBtn.addEventListener('click', async () => {
    const cacheDuration = parseInt(cacheDurationInput.value, 10);
    const pathsText = monitoredPathsInput.value;
    const paths = pathsText
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    if (cacheDuration < 1 || cacheDuration > 60) {
      alert('Cache duration must be between 1 and 60 minutes.');
      return;
    }

    if (paths.length === 0) {
      alert('Please enter at least one monitored path.');
      return;
    }

    const settings = {
      cacheDurationMinutes: cacheDuration,
      monitoredPaths: paths
    };

    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
      saveBtn.textContent = 'Saved!';
      setTimeout(() => {
        saveBtn.textContent = 'Save Settings';
      }, 1500);
    } catch (err) {
      console.error('Save failed:', err);
      alert('Failed to save settings.');
    }
  });

  // Load status from background
  async function loadStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

      // Update last sync display
      if (status.lastSync) {
        const date = new Date(status.lastSync);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 1000 / 60);

        if (diffMins < 1) {
          lastSyncEl.textContent = 'Just now';
        } else if (diffMins < 60) {
          lastSyncEl.textContent = `${diffMins} min ago`;
        } else {
          const hours = Math.floor(diffMins / 60);
          lastSyncEl.textContent = `${hours}h ${diffMins % 60}m ago`;
        }
      } else {
        lastSyncEl.textContent = 'Never';
      }

      // Update holdings count
      holdingsCountEl.textContent = status.holdingsCount || 0;

      // Update settings inputs
      if (status.settings) {
        cacheDurationInput.value = status.settings.cacheDurationMinutes || 10;
        monitoredPathsInput.value = (status.settings.monitoredPaths || []).join('\n');
      }
    } catch (err) {
      console.error('Failed to load status:', err);
      lastSyncEl.textContent = 'Error';
    }
  }

  // Set refreshing state
  function setRefreshing(isRefreshing) {
    refreshBtn.disabled = isRefreshing;
    refreshBtn.querySelector('.btn-text').hidden = isRefreshing;
    refreshBtn.querySelector('.btn-loading').hidden = !isRefreshing;
  }

  // Debug button handler
  debugBtn.addEventListener('click', async () => {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'DEBUG_STORAGE' });
      debugOutput.style.display = 'block';
      debugOutput.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      debugOutput.style.display = 'block';
      debugOutput.textContent = 'Error: ' + err.message;
    }
  });
});
