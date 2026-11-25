'use client';

import { useEffect, useState } from 'react';

export default function ScannerDisplaySettings() {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/admin/scanner-settings', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load settings');
        if (active) setSettings(data.settings);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateCardPreference = (key, value) => {
    setSettings((current) => ({
      ...current,
      cardPreferences: { ...current.cardPreferences, [key]: value },
    }));
  };

  async function save() {
    if (!settings || !Number.isInteger(Number(settings.maxVisibleSignals))) {
      setError('Enter a whole number between 1 and 100.');
      return;
    }

    setBusy(true);
    setMessage('');
    setError('');
    try {
      const response = await fetch('/api/admin/scanner-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { ...settings, maxVisibleSignals: Number(settings.maxVisibleSignals) } }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save settings');
      setSettings(data.settings);
      setMessage('Scanner display settings saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <section className="card" aria-labelledby="scanner-display-settings-title">
        <div className="card-title" id="scanner-display-settings-title">Scanner display</div>
        <div className="card-subtitle">{error || 'Loading display settings…'}</div>
      </section>
    );
  }

  const count = Number(settings.maxVisibleSignals);
  const invalidCount = !Number.isInteger(count) || count < 1 || count > 100;

  return (
    <section className="card" aria-labelledby="scanner-display-settings-title">
      <div className="card-title" id="scanner-display-settings-title">Scanner display</div>
      <p className="card-subtitle" style={{ marginTop: 4, marginBottom: 16 }}>
        Control the number of signals and optional details shown on the Scanner page.
      </p>

      <label className="form-label" htmlFor="scanner-visible-limit">Maximum visible signals</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <input
          id="scanner-visible-limit"
          type="number"
          min="1"
          max="100"
          step="1"
          value={settings.maxVisibleSignals}
          onChange={(event) => setSettings((current) => ({ ...current, maxVisibleSignals: event.target.value }))}
          style={{ width: 100, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, #cbd5e1)' }}
          aria-describedby="scanner-visible-limit-help"
        />
        <span className="card-subtitle" id="scanner-visible-limit-help">1–100 · default 10</span>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={!!settings.entryProximityRingEnabled}
            onChange={(event) => setSettings((current) => ({ ...current, entryProximityRingEnabled: event.target.checked }))}
            style={{ marginTop: 3 }}
          />
          <span>
            <b>Entry proximity ring</b>
            <span className="card-subtitle" style={{ display: 'block' }}>Show progress around each coin icon.</span>
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={!!settings.cardPreferences.showTargetPercentages}
            onChange={(event) => updateCardPreference('showTargetPercentages', event.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>Show target percentage labels</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={!!settings.cardPreferences.showSignalAge}
            onChange={(event) => updateCardPreference('showSignalAge', event.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>Show signal age and entry time</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={!!settings.cardPreferences.showRecentResults}
            onChange={(event) => updateCardPreference('showRecentResults', event.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>Include recently closed signals</span>
        </label>
      </div>

      {(error || message) && (
        <div role={error ? 'alert' : 'status'} className="card-subtitle" style={{ marginTop: 12, color: error ? '#b91c1c' : '#15803d' }}>
          {error || message}
        </div>
      )}
      <button type="button" className="btn btn-primary" disabled={busy || invalidCount} onClick={save} style={{ marginTop: 16 }}>
        {busy ? 'Saving…' : 'Save display settings'}
      </button>
    </section>
  );
}
