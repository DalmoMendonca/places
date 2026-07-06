import exifr from 'exifr';

const VIDEO_SAMPLE_BYTES = 16 * 1024 * 1024;
const QUICKTIME_EPOCH_OFFSET_SECONDS = 2082844800;
const IMAGE_EXTENSION_PATTERN = /\.(avif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const VIDEO_EXTENSION_PATTERN = /\.(3gp|m4v|mov|mp4|qt)$/i;

export const isMediaFile = (file) => {
  if (!file) return false;
  return isImageFile(file) || isVideoFile(file);
};

export const isJsonFile = (file) => {
  if (!file) return false;
  return file.type === 'application/json' || /\.json$/i.test(file.name || '');
};

export async function parseMediaFiles(files) {
  const supported = Array.from(files).filter(isMediaFile);
  const settled = await Promise.all(
    supported.map(async (file) => {
      try {
        return { item: await parseMediaFile(file) };
      } catch (error) {
        return {
          skipped: {
            name: file.name || 'Pasted media',
            reason: error.message || 'Could not read metadata',
          },
        };
      }
    })
  );

  return {
    items: settled.map((result) => result.item).filter(Boolean),
    skipped: settled.map((result) => result.skipped).filter(Boolean),
  };
}

async function parseMediaFile(file) {
  const metadata = isVideoFile(file)
    ? await parseVideoMetadata(file)
    : await parseImageMetadata(file);

  if (!Number.isFinite(metadata.lat) || !Number.isFinite(metadata.lng)) {
    throw new Error('Missing GPS location metadata');
  }

  if (!Number.isFinite(metadata.t)) {
    throw new Error('Missing timestamp metadata');
  }

  const mediaType = isVideoFile(file) ? 'video' : 'image';

  return {
    id: buildMediaId(file, metadata),
    name: file.name || (mediaType === 'video' ? 'Pasted video' : 'Pasted photo'),
    type: mediaType,
    mimeType: file.type || '',
    size: file.size,
    t: metadata.t,
    lat: metadata.lat,
    lng: metadata.lng,
    url: URL.createObjectURL(file),
  };
}

function isImageFile(file) {
  return file.type?.startsWith('image/') || IMAGE_EXTENSION_PATTERN.test(file.name || '');
}

function isVideoFile(file) {
  return file.type?.startsWith('video/') || VIDEO_EXTENSION_PATTERN.test(file.name || '');
}

async function parseImageMetadata(file) {
  const metadata = await exifr.parse(file, {
    gps: true,
    xmp: true,
    tiff: true,
    exif: true,
    mergeOutput: true,
    reviveValues: true,
    translateKeys: true,
    translateValues: true,
    silentErrors: true,
  });

  if (!metadata) {
    throw new Error('Missing EXIF metadata');
  }

  const coords = getCoordinates(metadata);
  return {
    ...coords,
    t: getTimestamp(metadata, file),
  };
}

async function parseVideoMetadata(file) {
  const buffers = await readVideoMetadataBuffers(file);
  const texts = buffers.map((buffer) => decodeText(buffer));

  const coords = texts.map(extractIso6709Location).find(Boolean);
  const textTimestamp = texts.map(extractDateFromText).find(Number.isFinite);
  const mvhdTimestamp = buffers.map(extractMvhdTimestamp).find(Number.isFinite);

  return {
    ...(coords || {}),
    t: textTimestamp || mvhdTimestamp || getFileTimestamp(file),
  };
}

async function readVideoMetadataBuffers(file) {
  if (file.size <= VIDEO_SAMPLE_BYTES * 2) {
    return [await file.arrayBuffer()];
  }

  const first = await file.slice(0, VIDEO_SAMPLE_BYTES).arrayBuffer();
  const last = await file.slice(Math.max(0, file.size - VIDEO_SAMPLE_BYTES)).arrayBuffer();
  return [first, last];
}

function getCoordinates(metadata) {
  const lat = firstFinite(
    metadata.latitude,
    metadata.GPSLatitude,
    metadata['exif:GPSLatitude'],
    metadata['photoshop:GPSLatitude']
  );
  const lng = firstFinite(
    metadata.longitude,
    metadata.GPSLongitude,
    metadata['exif:GPSLongitude'],
    metadata['photoshop:GPSLongitude']
  );

  return { lat: normalizeCoordinate(lat), lng: normalizeCoordinate(lng) };
}

function getTimestamp(metadata, file) {
  const dateCandidates = [
    metadata.DateTimeOriginal,
    metadata.CreateDate,
    metadata.DateCreated,
    metadata.ModifyDate,
    metadata.DateTime,
    metadata.GPSDateTime,
    metadata['xmp:CreateDate'],
    metadata['photoshop:DateCreated'],
  ];

  for (const candidate of dateCandidates) {
    const parsed = parseDateCandidate(candidate, metadata);
    if (Number.isFinite(parsed)) return parsed;
  }

  return getFileTimestamp(file);
}

function parseDateCandidate(candidate, metadata = {}) {
  if (!candidate) return NaN;
  if (candidate instanceof Date) return candidate.getTime();
  if (typeof candidate === 'number') return candidate;

  if (typeof candidate !== 'string') return NaN;

  const trimmed = candidate.trim();
  if (!trimmed) return NaN;

  const normalizedExif = trimmed.replace(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(.*)$/,
    '$1-$2-$3T$4:$5:$6$7'
  );

  const offset = metadata.OffsetTimeOriginal || metadata.OffsetTimeDigitized || metadata.OffsetTime;
  const withOffset = offset && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalizedExif)
    ? `${normalizedExif}${String(offset).replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`
    : normalizedExif;

  const parsed = Date.parse(withOffset);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getFileTimestamp(file) {
  return file.lastModified ? file.lastModified : NaN;
}

function normalizeCoordinate(value) {
  if (Array.isArray(value)) {
    return dmsToDecimal(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  return Number.isFinite(value) ? value : NaN;
}

function dmsToDecimal(value) {
  const [degrees = 0, minutes = 0, seconds = 0] = value.map(Number);
  const direction = value.find((part) => typeof part === 'string');
  const sign = direction && /[SW]/i.test(direction) ? -1 : 1;
  return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
}

function firstFinite(...values) {
  return values.find((value) => Number.isFinite(normalizeCoordinate(value)));
}

function decodeText(buffer) {
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer)).replace(/\0/g, ' ');
}

function extractIso6709Location(text) {
  const pattern = /([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\//g;
  let match;

  while ((match = pattern.exec(text))) {
    const lat = Number.parseFloat(match[1]);
    const lng = Number.parseFloat(match[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

function extractDateFromText(text) {
  const match = text.match(
    /\b((?:19|20)\d{2})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/
  );

  if (!match) return NaN;

  const parsed = parseDateCandidate(match[0]);
  return isReasonableTimestamp(parsed) ? parsed : NaN;
}

function extractMvhdTimestamp(buffer) {
  const bytes = new Uint8Array(buffer);

  for (let i = 4; i < bytes.length - 16; i += 1) {
    if (!matchesAscii(bytes, i, 'mvhd')) continue;

    const version = bytes[i + 4];
    let quicktimeSeconds = NaN;

    if (version === 0) {
      quicktimeSeconds = readUint32(bytes, i + 8);
    } else if (version === 1 && i + 16 <= bytes.length) {
      quicktimeSeconds = Number(readUint64(bytes, i + 8));
    }

    const unixMs = (quicktimeSeconds - QUICKTIME_EPOCH_OFFSET_SECONDS) * 1000;
    if (isReasonableTimestamp(unixMs)) return unixMs;
  }

  return NaN;
}

function matchesAscii(bytes, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function readUint32(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function readUint64(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value = (value << 8n) + BigInt(bytes[offset + i]);
  }
  return value;
}

function isReasonableTimestamp(value) {
  if (!Number.isFinite(value)) return false;
  const date = new Date(value);
  return date.getUTCFullYear() >= 1990 && date.getUTCFullYear() <= 2100;
}

function buildMediaId(file, metadata) {
  return [
    file.name || 'pasted-media',
    file.size,
    file.lastModified || 0,
    Math.round(metadata.t),
    metadata.lat.toFixed(6),
    metadata.lng.toFixed(6),
  ].join('|');
}
