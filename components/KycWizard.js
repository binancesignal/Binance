'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { COUNTRIES, DOC_TYPES, getDocFrame, countryName } from '../lib/kyc/countries.js';
import { compareIdAndSelfie, STRONG_MATCH_SCORE, detectFacePose, ensureFaceApi } from '../lib/kyc/faceMatchClient.js';

const STEPS = ['country', 'doctype', 'docphoto', 'details', 'selfie', 'review'];

function compressDataUrl(dataUrl, maxW = 1280, quality = 0.72) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function ExampleTips({ mode }) {
  if (mode === 'doc') {
    return (
      <div className="kyc-tips">
        <div className="kyc-tips-title">How to take a clear photo</div>
        <div className="kyc-tips-grid">
          <div className="kyc-tip good">
            <div className="kyc-tip-visual">✓</div>
            <div>
              <b>Good</b>
              <span>Flat, well-lit, all 4 corners inside the frame, no glare</span>
            </div>
          </div>
          <div className="kyc-tip bad">
            <div className="kyc-tip-visual">✗</div>
            <div>
              <b>Avoid</b>
              <span>Blur, cropped edges, fingers covering text, dark rooms</span>
            </div>
          </div>
        </div>
        <ul className="kyc-tips-list">
          <li>Place the document on a plain dark background</li>
          <li>Turn off flash if it causes reflection</li>
          <li>Make sure name &amp; document number are readable</li>
        </ul>
      </div>
    );
  }
  return (
    <div className="kyc-tips">
      <div className="kyc-tips-title">Selfie with your ID</div>
      <div className="kyc-tips-grid">
        <div className="kyc-tip good">
          <div className="kyc-tip-visual">✓</div>
          <div>
            <b>Good</b>
            <span>Face clearly visible, hold ID next to your face (same photo)</span>
          </div>
        </div>
        <div className="kyc-tip bad">
          <div className="kyc-tip-visual">✗</div>
          <div>
            <b>Avoid</b>
            <span>Sunglasses, hat, only ID without face, heavy filters</span>
          </div>
        </div>
      </div>
      <ul className="kyc-tips-list">
        <li>Look straight at the camera</li>
        <li>Hold the same document you uploaded</li>
        <li>Use natural light — no strong backlight</li>
      </ul>
    </div>
  );
}

function CameraCapture({ frame, facingMode = 'environment', onCapture, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (dead) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setReady(true);
        }
      } catch (e) {
        setErr(e.message || 'Camera permission denied');
      }
    })();
    return () => {
      dead = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [facingMode]);

  async function snap() {
    const video = videoRef.current;
    if (!video) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 720;
    c.getContext('2d').drawImage(video, 0, 0);
    const raw = c.toDataURL('image/jpeg', 0.92);
    const compressed = await compressDataUrl(raw);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onCapture(compressed);
  }

  const aspect = frame?.aspect || 1.5;
  // box width relative to container
  const boxStyle =
    aspect >= 1
      ? { width: '88%', aspectRatio: String(aspect) }
      : { height: '72%', aspectRatio: String(aspect) };

  return (
    <div className="kyc-cam">
      {err ? (
        <div className="kyc-cam-err">
          <p>{err}</p>
          <p className="kyc-muted">Allow camera access in browser settings, or upload a photo instead.</p>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Back
          </button>
        </div>
      ) : (
        <>
          <div className="kyc-cam-stage">
            <video ref={videoRef} playsInline muted autoPlay className="kyc-cam-video" />
            <div className="kyc-cam-overlay">
              <div className="kyc-cam-frame" style={boxStyle}>
                <span className="kyc-cam-frame-label">{frame?.label || 'Align document'}</span>
              </div>
            </div>
          </div>
          <div className="kyc-cam-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!ready} onClick={snap}>
              Capture
            </button>

          </div>
        </>
      )}
    </div>
  );
}

/** Sumsub-style tick ring: fills green as user turns head freely */
const LIVE_TICKS = 72;
const YAW_MIN = -0.55;
const YAW_MAX = 0.55;
const COVER_NEED = 0.82; // fraction of ticks that must light up
const HOLD_AFTER_FULL_MS = 400;

function yawToBin(yaw, n = LIVE_TICKS) {
  const t = (yaw - YAW_MIN) / (YAW_MAX - YAW_MIN);
  const clamped = Math.max(0, Math.min(0.999, t));
  return Math.floor(clamped * n);
}

function binToYaw(bin, n = LIVE_TICKS) {
  return YAW_MIN + ((bin + 0.5) / n) * (YAW_MAX - YAW_MIN);
}

function TickRing({ covered, hintBin, size = 300 }) {
  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - 6;
  const inner = outer - 16;
  const n = covered.length;
  const ticks = [];
  for (let i = 0; i < n; i++) {
    // map bins left→right across top arc visually: start from left side going clockwise-ish
    // place ticks around full circle for Sumsub look; coverage still driven by yaw bins
    const ang = (-90 + (i / n) * 360) * (Math.PI / 180);
    const x1 = cx + inner * Math.cos(ang);
    const y1 = cy + inner * Math.sin(ang);
    const x2 = cx + outer * Math.cos(ang);
    const y2 = cy + outer * Math.sin(ang);
    const on = covered[i];
    const isHint = hintBin === i && !on;
    ticks.push(
      <line
        key={i}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={on ? '#22C55E' : isHint ? '#FBBF24' : 'rgba(255,255,255,0.35)'}
        strokeWidth={on || isHint ? 3.2 : 2.2}
        strokeLinecap="round"
        opacity={on ? 1 : isHint ? 0.95 : 0.55}
      />
    );
  }
  return (
    <svg className="kyc-ring-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {ticks}
    </svg>
  );
}

function LivenessCapture({ onCapture, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const coveredRef = useRef(Array(LIVE_TICKS).fill(false));
  const busyCapture = useRef(false);
  const fullSinceRef = useRef(0);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const [err, setErr] = useState('');
  const [loadingModels, setLoadingModels] = useState(true);
  const [covered, setCovered] = useState(() => Array(LIVE_TICKS).fill(false));
  const [poseNow, setPoseNow] = useState('none');
  const [yawNow, setYawNow] = useState(0);
  const [hintBin, setHintBin] = useState(null);
  const [flash, setFlash] = useState(false);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    let dead = false;
    let timer = 0;

    (async () => {
      try {
        setLoadingModels(true);
        await ensureFaceApi();
        if (dead) return;
        setLoadingModels(false);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (dead) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }

        const finish = async () => {
          if (busyCapture.current || dead) return;
          busyCapture.current = true;
          setFlash(true);
          const videoEl = videoRef.current;
          if (!videoEl) return;
          await new Promise((r) => setTimeout(r, 200));
          const c = document.createElement('canvas');
          c.width = videoEl.videoWidth || 960;
          c.height = videoEl.videoHeight || 720;
          const ctx = c.getContext('2d');
          ctx.translate(c.width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(videoEl, 0, 0);
          const raw = c.toDataURL('image/jpeg', 0.9);
          const compressed = await compressDataUrl(raw, 960, 0.75);
          const cov = coveredRef.current;
          const filled = cov.filter(Boolean).length;
          streamRef.current?.getTracks().forEach((t) => t.stop());
          onCaptureRef.current?.(compressed, {
            ok: true,
            mode: 'free_yaw_ring',
            ticks: LIVE_TICKS,
            filled,
            coverage: filled / LIVE_TICKS,
            completedAt: new Date().toISOString(),
            challenges: [{ id: 'ring_cover', pose: 'free', at: new Date().toISOString() }],
          });
        };

        const nearestEmpty = (arr, fromBin) => {
          let best = null;
          let bestDist = 999;
          for (let i = 0; i < arr.length; i++) {
            if (arr[i]) continue;
            const d = Math.min(Math.abs(i - fromBin), arr.length - Math.abs(i - fromBin));
            if (d < bestDist) {
              bestDist = d;
              best = i;
            }
          }
          return best;
        };

        const tick = async () => {
          if (dead) return;
          const videoEl = videoRef.current;
          if (videoEl && videoEl.readyState >= 2 && !busyCapture.current) {
            try {
              const r = await detectFacePose(videoEl, { mirrored: true });
              if (dead) return;
              if (!r.found) {
                setPoseNow('none');
                fullSinceRef.current = 0;
              } else {
                setPoseNow(r.pose);
                setYawNow(r.yaw);
                const bin = yawToBin(r.yaw);
                // light this bin + neighbors (smoother fill while turning)
                const next = coveredRef.current.slice();
                for (let d = -1; d <= 1; d++) {
                  const j = bin + d;
                  if (j >= 0 && j < LIVE_TICKS) next[j] = true;
                }
                coveredRef.current = next;
                const filled = next.filter(Boolean).length;
                const ratio = filled / LIVE_TICKS;
                setCovered(next);
                setPct(Math.round(ratio * 100));
                const hint = nearestEmpty(next, bin);
                setHintBin(hint);

                if (ratio >= COVER_NEED) {
                  if (!fullSinceRef.current) fullSinceRef.current = Date.now();
                  if (Date.now() - fullSinceRef.current >= HOLD_AFTER_FULL_MS) {
                    await finish();
                    return;
                  }
                } else {
                  fullSinceRef.current = 0;
                }
              }
            } catch (_) {}
          }
          timer = window.setTimeout(tick, 120);
        };
        tick();
      } catch (e) {
        setErr(e.message || 'Camera / face model failed');
        setLoadingModels(false);
      }
    })();

    return () => {
      dead = true;
      window.clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const hintYaw = hintBin != null ? binToYaw(hintBin) : 0;
  const hintDir =
    hintBin == null || pct >= COVER_NEED * 100
      ? null
      : hintYaw < yawNow - 0.05
        ? 'left'
        : hintYaw > yawNow + 0.05
          ? 'right'
          : 'center';

  return (
    <div className="kyc-cam kyc-live">
      {err ? (
        <div className="kyc-cam-err">
          <p>{err}</p>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Back</button>
        </div>
      ) : (
        <>
          <div className="kyc-live-banner">
            <div className={`kyc-live-arrow ${pct >= COVER_NEED * 100 ? 'ok' : ''}`}>
              {pct >= COVER_NEED * 100 ? '✓' : hintDir === 'left' ? '←' : hintDir === 'right' ? '→' : '●'}
            </div>
            <div>
              <div className="kyc-live-step">{loadingModels ? 'Preparing' : `${pct}% covered`}</div>
              <div className="kyc-live-label">
                {loadingModels
                  ? 'Loading face AI…'
                  : pct >= COVER_NEED * 100
                    ? 'Ring complete — capturing…'
                    : hintDir === 'left'
                      ? 'Turn your head LEFT slowly'
                      : hintDir === 'right'
                        ? 'Turn your head RIGHT slowly'
                        : 'Turn your head left & right slowly'}
              </div>
              <div className="kyc-live-hint">
                {poseNow === 'none'
                  ? 'Face not detected — center your face in the circle'
                  : 'Green ticks = covered · yellow = try this direction'}
              </div>
            </div>
          </div>

          <div className={`kyc-ring-wrap ${flash ? 'flash' : ''}`}>
            <TickRing covered={covered} hintBin={hintBin} size={300} />
            <div className="kyc-ring-video-clip">
              <video ref={videoRef} playsInline muted autoPlay className="kyc-cam-video kyc-live-video" />
            </div>
          </div>

          <p className="kyc-live-foot">
            Move your head freely. Each direction you look lights green ticks (like Sumsub).
            When the ring is mostly green, we take the photo automatically, then match it to your ID.
          </p>
          <button type="button" className="btn btn-secondary btn-block" onClick={onCancel}>Cancel</button>
        </>
      )}
    </div>
  );
}

export default function KycWizard({ initialCountryCode, initialCountry, onDone, showToast }) {
  const [step, setStep] = useState(() => {
    try {
      const n = Number(sessionStorage.getItem('kyc_step'));
      return Number.isFinite(n) && n >= 0 && n < STEPS.length ? n : 0;
    } catch (_) {
      return 0;
    }
  });
  const [busy, setBusy] = useState(false);
  const [countryCode, setCountryCode] = useState(initialCountryCode || '');
  const [country, setCountry] = useState(initialCountry || '');
  const [docType, setDocType] = useState('');
  const [docFront, setDocFront] = useState(null);
  const [selfie, setSelfie] = useState(null);
  const [cam, setCam] = useState(null); // 'doc' | 'selfie' | null
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const [dob, setDob] = useState('');
  const [status, setStatus] = useState('none');
  const [reviewNote, setReviewNote] = useState('');
  const [faceMatch, setFaceMatch] = useState(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const [liveness, setLiveness] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/user/kyc', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) return;
      const k = data.kyc;
      if (!k) return;
      setStatus(k.status || 'none');
      setReviewNote(k.reviewNote || '');
      if (k.countryCode) setCountryCode(k.countryCode);
      if (k.country) setCountry(k.country);
      const d = k.data || {};
      if (d.docType) setDocType(d.docType);
      if (d.docFront) setDocFront(d.docFront);
      if (d.selfie) setSelfie(d.selfie);
      if (d.firstName) setFirstName(d.firstName);
      if (d.lastName) setLastName(d.lastName);
      if (d.docNumber) setDocNumber(d.docNumber);
      if (d.dob) setDob(d.dob);
      if (k.status === 'pending' || k.status === 'approved') setStep(STEPS.length - 1);
      else if (k.status === 'rejected') setStep(0);
    } catch (_) {}
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem('kyc_step', String(step));
    } catch (_) {}
  }, [step]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-detect country if empty
  useEffect(() => {
    if (countryCode) return;
    (async () => {
      try {
        const res = await fetch('/api/geo', { cache: 'no-store' });
        const data = await res.json();
        if (data.countryCode) {
          setCountryCode(data.countryCode);
          setCountry(data.country || countryName(data.countryCode));
        }
      } catch (_) {}
    })();
  }, [countryCode]);

  async function saveCountry() {
    if (!countryCode) {
      showToast?.('Select your country');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/user/kyc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_country',
          countryCode,
          country: country || countryName(countryCode),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setStep(1);
    } catch (e) {
      showToast?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function persistDraft(extra = {}) {
    const payload = {
      docType,
      firstName,
      lastName,
      docNumber,
      dob,
      docFront,
      selfie,
      ...extra,
    };
    const res = await fetch('/api/user/kyc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_draft', data: payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    return data;
  }

  async function onDocCaptured(dataUrl) {
    setDocFront(dataUrl);
    setCam(null);
    setBusy(true);
    try {
      await persistDraft({ docFront: dataUrl, docType });
      setStep(3);
      showToast?.('Document saved — enter your details');
    } catch (e) {
      showToast?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onSelfieCaptured(dataUrl, liveMeta = null) {
    setSelfie(dataUrl);
    if (liveMeta) setLiveness(liveMeta);
    setCam(null);
    setBusy(true);
    try {
      await persistDraft({ selfie: dataUrl, liveness: liveMeta || liveness });
      setStep(5);
      showToast?.(liveMeta?.ok ? 'Liveness passed' : 'Selfie saved');
    } catch (e) {
      showToast?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onFilePick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const compressed = await compressDataUrl(String(reader.result));
      if (cam === 'doc' || step === 2) onDocCaptured(compressed);
      else onSelfieCaptured(compressed);
    };
    reader.readAsDataURL(file);
  }

  async function saveDetails() {
    if (!firstName.trim() || !lastName.trim()) {
      showToast?.('First and last name required');
      return;
    }
    setBusy(true);
    try {
      await persistDraft({ firstName: firstName.trim(), lastName: lastName.trim(), docNumber, dob });
      setStep(4);
    } catch (e) {
      showToast?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitAll() {
    if (!docFront || !selfie) {
      showToast?.('Document and selfie required');
      return;
    }
    setBusy(true);
    setMatchBusy(true);
    showToast?.('Checking face match…');
    let match = faceMatch;
    try {
      match = await compareIdAndSelfie(docFront, selfie);
      setFaceMatch(match);
      if (!match.ok) {
        showToast?.(match.error || 'Face check failed — you can still submit for manual review');
      } else {
        const pct = Math.round((match.score || 0) * 100);
        showToast?.(match.score >= STRONG_MATCH_SCORE
          ? `Face match ${pct}% — strong match`
          : `Face match ${pct}% — will need manual review`);
      }
    } catch (e) {
      match = { ok: false, error: e.message, score: null, distance: null, docFaces: 0, selfieFaces: 0, provider: 'face-api' };
      setFaceMatch(match);
    } finally {
      setMatchBusy(false);
    }

    try {
      const res = await fetch('/api/user/kyc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit',
          countryCode,
          country: country || countryName(countryCode),
          faceMatch: match,
          data: {
            docType,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            docNumber,
            dob,
            docFront,
            selfie,
            faceMatch: match,
            liveness: liveness,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submit failed');
      setStatus(data.kyc?.status || 'pending');
      try { sessionStorage.removeItem('kyc_step'); } catch (_) {}
      showToast?.(
        data.kyc?.status === 'approved'
          ? 'Face verified — KYC auto-approved'
          : 'Submitted — waiting for admin review'
      );
      onDone?.();
    } catch (e) {
      showToast?.(e.message);
    } finally {
      setBusy(false);
    }
  }


  const frame = getDocFrame(countryCode, docType);
  const stepId = STEPS[step];

  if (status === 'approved') {
    return (
      <div className="kyc-wrap">
        <div className="kyc-status-card ok">
          <div className="kyc-status-icon">✓</div>
          <h2>Identity verified</h2>
          <p>Your KYC was approved. Country: <b>{country || countryName(countryCode)}</b></p>
        </div>
      </div>
    );
  }

  if (status === 'pending' && stepId === 'review') {
    return (
      <div className="kyc-wrap">
        <div className="kyc-status-card pending">
          <div className="kyc-status-icon">⏳</div>
          <h2>Under review</h2>
          <p>We received your documents. Admin will approve or reject shortly.</p>
          <p className="kyc-muted">{firstName} {lastName} · {country || countryName(countryCode)}</p>
        </div>
      </div>
    );
  }

  if (cam === 'selfie') {
    return (
      <div className="kyc-wrap">
        <ExampleTips mode="selfie" />
        <LivenessCapture
          onCapture={(img, meta) => onSelfieCaptured(img, meta)}
          onCancel={() => setCam(null)}
          showToast={showToast}
        />
      </div>
    );
  }

  if (cam) {
    return (
      <div className="kyc-wrap">
        <ExampleTips mode="doc" />
        <CameraCapture
          frame={frame}
          facingMode="environment"
          onCapture={onDocCaptured}
          onCancel={() => setCam(null)}
        />
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onFilePick} />
        <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 10 }} onClick={() => fileRef.current?.click()}>
          Or upload from gallery
        </button>
      </div>
    );
  }

  return (
    <div className="kyc-wrap">
      <div className="kyc-progress">
        {STEPS.map((s, i) => (
          <span key={s} className={`kyc-dot ${i <= step ? 'on' : ''} ${i === step ? 'current' : ''}`} />
        ))}
      </div>

      {status === 'rejected' && (
        <div className="kyc-status-card rejected">
          <b>Previous submission rejected</b>
          {reviewNote ? <p>{reviewNote}</p> : <p>Please fix and resubmit.</p>}
        </div>
      )}

      {stepId === 'country' && (
        <div className="kyc-card">
          <h2>Confirm your country</h2>
          <p className="kyc-muted">We use this for document format. Auto-detected from your network when possible — change if wrong.</p>
          <label className="form-label">Country</label>
          <select
            className="form-input"
            value={countryCode}
            onChange={(e) => {
              const code = e.target.value;
              setCountryCode(code);
              setCountry(countryName(code));
            }}
          >
            <option value="">Select country…</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={busy || !countryCode} onClick={saveCountry}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </div>
      )}

      {stepId === 'doctype' && (
        <div className="kyc-card">
          <h2>Choose document</h2>
          <p className="kyc-muted">Country: <b>{country || countryName(countryCode)}</b></p>
          <div className="kyc-doc-grid">
            {DOC_TYPES.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`kyc-doc-btn ${docType === d.id ? 'on' : ''}`}
                onClick={() => setDocType(d.id)}
              >
                <span className="kyc-doc-ico">{d.icon}</span>
                <span>{d.label}</span>
              </button>
            ))}
          </div>
          <div className="kyc-row-btns">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(0)}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!docType}
              onClick={() => {
                setStep(2);
              }}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {stepId === 'docphoto' && (
        <div className="kyc-card">
          <h2>Photograph your document</h2>
          <ExampleTips mode="doc" />
          {docFront ? (
            <div className="kyc-preview">
              <img src={docFront} alt="Document" />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCam('doc')}>
                Retake
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary btn-block" onClick={() => setCam('doc')}>
              Open camera
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onFilePick} />
          <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 8 }} onClick={() => { setCam('doc'); setTimeout(() => fileRef.current?.click(), 0); }}>
            Upload from gallery
          </button>
          <div className="kyc-row-btns">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" className="btn btn-primary" disabled={!docFront} onClick={() => setStep(3)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {stepId === 'details' && (
        <div className="kyc-card">
          <h2>Your details</h2>
          <p className="kyc-muted">Enter exactly as on the document. You can edit anytime before submit.</p>
          {docFront && (
            <div className="kyc-preview small">
              <img src={docFront} alt="Document reference" />
            </div>
          )}
          <label className="form-label">First name</label>
          <input className="form-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Given name" autoComplete="given-name" />
          <label className="form-label">Last name</label>
          <input className="form-input" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Family name" autoComplete="family-name" />
          <label className="form-label">Document number</label>
          <input className="form-input" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="ID / passport number" />
          <label className="form-label">Date of birth</label>
          <input className="form-input" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          <div className="kyc-row-btns">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>
              Back
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={saveDetails}>
              {busy ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {stepId === 'selfie' && (
        <div className="kyc-card">
          <h2>Liveness selfie</h2>
          <p className="kyc-muted">Turn your head left and right when asked — proves you are a real person. Hold your ID next to your face for the final photo.</p>
          <ExampleTips mode="selfie" />
          {selfie ? (
            <div className="kyc-preview">
              <img src={selfie} alt="Selfie" />
              {liveness?.ok && <p className="kyc-muted">Liveness checks passed ✓</p>}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCam('selfie')}>
                Retake
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary btn-block" onClick={() => setCam('selfie')}>
              Start liveness check
            </button>
          )}
          <div className="kyc-row-btns">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(3)}>
              Back
            </button>
            <button type="button" className="btn btn-primary" disabled={!selfie} onClick={() => setStep(5)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {stepId === 'review' && (
        <div className="kyc-card">
          <h2>Review &amp; submit</h2>
          <p className="kyc-muted">Check everything before sending to admin.</p>
          <div className="kyc-review-grid">
            <div>
              <div className="kyc-muted">Country</div>
              <b>{country || countryName(countryCode)}</b>
            </div>
            <div>
              <div className="kyc-muted">Document</div>
              <b>{DOC_TYPES.find((d) => d.id === docType)?.label || docType}</b>
            </div>
            <div>
              <div className="kyc-muted">Name</div>
              <b>
                {firstName} {lastName}
              </b>
            </div>
            <div>
              <div className="kyc-muted">Doc number</div>
              <b>{docNumber || '—'}</b>
            </div>
          </div>
          <div className="kyc-preview-row">
            {docFront && <img src={docFront} alt="Doc" />}
            {selfie && <img src={selfie} alt="Selfie" />}
          </div>
          <button type="button" className="btn btn-secondary btn-block" onClick={() => setStep(3)}>
            Edit details
          </button>
          {liveness?.ok && (
            <div className="kyc-muted" style={{ marginBottom: 6 }}>Liveness: <b>passed</b> ({(liveness.challenges || []).length} moves)</div>
          )}
          {faceMatch?.ok && (
            <div className="kyc-muted" style={{ marginBottom: 8 }}>
              Last face score: <b>{Math.round(faceMatch.score * 100)}%</b>
              {faceMatch.score >= STRONG_MATCH_SCORE ? ' (eligible for auto-approve)' : ' (manual review likely)'}
            </div>
          )}
          <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 8 }} disabled={busy || matchBusy} onClick={submitAll}>
            {matchBusy ? 'Matching faces…' : busy ? 'Submitting…' : 'Verify face & submit'}
          </button>
          <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 8 }} onClick={() => setStep(0)}>
            Change country
          </button>
        </div>
      )}
    </div>
  );
}
