/** Country list + document frame hints for camera overlay */

export const COUNTRIES = [
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'IN', name: 'India' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'AU', name: 'Australia' },
  { code: 'CA', name: 'Canada' },
  { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'NP', name: 'Nepal' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'CN', name: 'China' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'TH', name: 'Thailand' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'PH', name: 'Philippines' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'KE', name: 'Kenya' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'AR', name: 'Argentina' },
  { code: 'TR', name: 'Turkey' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'QA', name: 'Qatar' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'BH', name: 'Bahrain' },
  { code: 'OM', name: 'Oman' },
  { code: 'RU', name: 'Russia' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'PL', name: 'Poland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'IE', name: 'Ireland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'GR', name: 'Greece' },
  { code: 'EG', name: 'Egypt' },
  { code: 'OTHER', name: 'Other' },
].sort((a, b) => a.name.localeCompare(b.name));

export const DOC_TYPES = [
  { id: 'national_id', label: 'National ID / NIC', icon: '🪪' },
  { id: 'passport', label: 'Passport', icon: '🛂' },
  { id: 'drivers_license', label: "Driver's license", icon: '🚘' },
];

/**
 * Camera overlay aspect ratio (width/height of the guide box).
 * Tuned roughly by doc type + a few country card formats.
 */
export function getDocFrame(countryCode, docType) {
  const cc = String(countryCode || '').toUpperCase();
  if (docType === 'passport') {
    return { aspect: 1.42, orient: 'landscape', label: 'Passport data page' };
  }
  if (docType === 'drivers_license') {
    return { aspect: 1.6, orient: 'landscape', label: "Driver's license" };
  }
  // National ID — some countries use portrait cards
  const portraitIds = new Set(['LK', 'DE', 'FR', 'IT', 'ES', 'PL', 'BE', 'AT', 'CH']);
  if (portraitIds.has(cc)) {
    return { aspect: 0.63, orient: 'portrait', label: 'National ID (front)' };
  }
  // Default credit-card style landscape ID
  return { aspect: 1.586, orient: 'landscape', label: 'National ID (front)' };
}

export function countryName(code) {
  const c = COUNTRIES.find((x) => x.code === code);
  return c ? c.name : code || '—';
}
