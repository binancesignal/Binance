/**
 * Browser-side face match + liveness (turn left / right / center)
 * using face-api models from CDN.
 */

const FACEAPI_JS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.min.js';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';

let loadPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load face-api script'));
    document.head.appendChild(s);
  });
}

export async function ensureFaceApi() {
  if (typeof window === 'undefined') throw new Error('Face match only runs in the browser');
  if (window.__faceApiReady && window.faceapi) return window.faceapi;
  if (!loadPromise) {
    loadPromise = (async () => {
      await loadScript(FACEAPI_JS);
      const faceapi = window.faceapi;
      if (!faceapi) throw new Error('face-api not available');
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      window.__faceApiReady = true;
      return faceapi;
    })().catch((e) => {
      loadPromise = null;
      throw e;
    });
  }
  return loadPromise;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image for face detection'));
    img.src = dataUrl;
  });
}

/**
 * Rough head yaw from 68 landmarks.
 * mirrored=true for selfie video (CSS scaleX -1).
 */
export function estimateYaw(landmarks, mirrored = true) {
  try {
    const nose = landmarks.getNose();
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    if (!nose?.length || !leftEye?.length || !rightEye?.length) return 0;
    const tip = nose[3] || nose[Math.floor(nose.length / 2)];
    const le = leftEye[0];
    const re = rightEye[rightEye.length - 1];
    const midX = (le.x + re.x) / 2;
    const eyeDist = Math.abs(re.x - le.x) || 1;
    let yaw = (tip.x - midX) / eyeDist;
    if (mirrored) yaw = -yaw;
    return yaw;
  } catch (_) {
    return 0;
  }
}

export function classifyPose(yaw, { left = 0.22, right = 0.22, center = 0.12 } = {}) {
  if (yaw <= -left) return 'left';
  if (yaw >= right) return 'right';
  if (Math.abs(yaw) <= center) return 'center';
  return 'other';
}

export async function detectFacePose(input, { mirrored = true, minConfidence = 0.4 } = {}) {
  const faceapi = await ensureFaceApi();
  const opts = new faceapi.SsdMobilenetv1Options({ minConfidence });
  const det = await faceapi.detectSingleFace(input, opts).withFaceLandmarks();
  if (!det) return { found: false, yaw: 0, pose: 'none', box: null };
  const yaw = estimateYaw(det.landmarks, mirrored);
  const pose = classifyPose(yaw);
  return {
    found: true,
    yaw,
    pose,
    box: det.detection.box,
    score: det.detection.score,
  };
}

export async function compareIdAndSelfie(docDataUrl, selfieDataUrl) {
  const out = {
    ok: false,
    score: null,
    distance: null,
    docFaces: 0,
    selfieFaces: 0,
    provider: 'face-api-ssd-mobilenet',
  };
  try {
    const faceapi = await ensureFaceApi();
    const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 });
    const [docImg, selfImg] = await Promise.all([loadImage(docDataUrl), loadImage(selfieDataUrl)]);

    const [docDet, selfDet] = await Promise.all([
      faceapi.detectAllFaces(docImg, opts).withFaceLandmarks().withFaceDescriptors(),
      faceapi.detectAllFaces(selfImg, opts).withFaceLandmarks().withFaceDescriptors(),
    ]);

    out.docFaces = docDet.length;
    out.selfieFaces = selfDet.length;

    if (!docDet.length) {
      out.error = 'No face found on the ID photo — retake with a clear face';
      return out;
    }
    if (!selfDet.length) {
      out.error = 'No face found in the selfie — retake looking at the camera';
      return out;
    }

    const largest = (arr) =>
      arr.reduce((a, b) => {
        const aa = a.detection.box.width * a.detection.box.height;
        const bb = b.detection.box.width * b.detection.box.height;
        return bb > aa ? b : a;
      });

    const docFace = largest(docDet);
    const selfFace = largest(selfDet);
    const distance = faceapi.euclideanDistance(docFace.descriptor, selfFace.descriptor);
    const score = Math.max(0, Math.min(1, 1 - distance));

    out.ok = true;
    out.distance = Math.round(distance * 1000) / 1000;
    out.score = Math.round(score * 1000) / 1000;
    return out;
  } catch (e) {
    out.error = e.message || 'Face match failed';
    return out;
  }
}

export const STRONG_MATCH_SCORE = 0.45;

export const LIVENESS_CHALLENGES = [
  { id: 'center', label: 'Look straight at the camera', pose: 'center', holdMs: 700 },
  { id: 'left', label: 'Turn your head LEFT', pose: 'left', holdMs: 700 },
  { id: 'right', label: 'Turn your head RIGHT', pose: 'right', holdMs: 700 },
  { id: 'center2', label: 'Look straight again — hold still', pose: 'center', holdMs: 600 },
];
