/**
 * Welcome (onboarding) slides shown after the splash, before Register / Sign in.
 * Admin → Welcome edits them; stored in app_state under `welcome_slides`.
 */
export const WELCOME_KEY = 'welcome_slides';
export const MAX_SLIDES = 5;
// Hero image box (px). The admin upload crops every image to exactly this size.
export const SLIDE_W = 1080;
export const SLIDE_H = 1140;
const MAX_IMAGE_CHARS = 900_000; // ~650 KB data URL
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export const DEFAULT_SLIDES = [
  { imageUrl: null, title: 'Signals you can act on', subtitle: 'Live entries, stops and three take-profit levels — updated as the market moves.' },
  { imageUrl: null, title: 'Auto-trade with your own keys', subtitle: 'Your exchange, your risk limits. Positions are sized for you and protected with SL and TP.' },
  { imageUrl: null, title: 'Alerts straight to Telegram', subtitle: 'Every READY, entry, take-profit and close lands on your phone the moment it happens.' },
];

export function sanitizeSlides(input) {
  if (!Array.isArray(input)) throw new Error('slides must be a list');
  if (input.length > MAX_SLIDES) throw new Error(`Maximum ${MAX_SLIDES} slides`);
  return input.map((s, i) => {
    const title = String(s?.title ?? '').trim().slice(0, 80);
    const subtitle = String(s?.subtitle ?? '').trim().slice(0, 200);
    let imageUrl = s?.imageUrl ? String(s.imageUrl).trim() : null;
    if (imageUrl) {
      const isHttp = /^https?:\/\/\S+$/i.test(imageUrl);
      if (!isHttp && !DATA_URL_RE.test(imageUrl)) throw new Error(`Slide ${i + 1}: image must be PNG / JPG / WebP or an https URL`);
      if (imageUrl.length > MAX_IMAGE_CHARS) throw new Error(`Slide ${i + 1}: image is too large (use a smaller photo)`);
    }
    if (!title && !subtitle && !imageUrl) throw new Error(`Slide ${i + 1} is empty — add a title, text or image, or delete it`);
    return { imageUrl, title, subtitle };
  });
}

export function slidesOrDefault(saved) {
  return Array.isArray(saved) && saved.length ? saved : DEFAULT_SLIDES;
}
