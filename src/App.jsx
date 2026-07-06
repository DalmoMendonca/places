import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Play, Pause, ChevronDown, ChevronUp, Calendar, Trash2, AlertCircle, ImagePlus, Images, X } from 'lucide-react';
import logoUrl from './assets/places-logo.png';
import { format, subDays, startOfDay, endOfDay, parseISO } from 'date-fns';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import ParserWorker from './parser.worker.js?worker';
import ErrorBoundary from './ErrorBoundary';
import { enhanceWithDrivingRoute } from './services/mapbox.js';
import { isJsonFile, isMediaFile, parseMediaFiles } from './services/mediaMetadata.js';

function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// --- Components ---

const Button = ({ className, variant = 'primary', ...props }) => {
  const variants = {
    primary: 'bg-primary hover:bg-sky-600 text-white shadow-lg shadow-sky-500/20 active:shadow-none',
    secondary: 'bg-white hover:bg-zinc-50 text-zinc-700 border border-zinc-200 shadow-sm',
    ghost: 'hover:bg-zinc-100 text-zinc-500',
    danger: 'bg-red-50 hover:bg-red-100 text-red-600',
  };
  return (
    <button
      className={cn(
        'px-4 py-2 rounded-xl font-medium transition-all duration-200 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        className
      )}
      {...props}
    />
  );
};

const Card = ({ children, className }) => (
  <div className={cn('bg-white/90 backdrop-blur-xl border border-white/40 rounded-2xl p-6 shadow-glass', className)}>
    {children}
  </div>
);

const findLastIndexBefore = (locations, targetTime) => {
  let low = 0;
  let high = locations.length - 1;
  let result = -1;
  while (low <= high) {
    let mid = (low + high) >>> 1;
    if (locations[mid].t <= targetTime) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
};

const parseLocationText = (text) => new Promise((resolve, reject) => {
  const worker = new ParserWorker();

  worker.onmessage = (e) => {
    const { type, data, error } = e.data;
    worker.terminate();

    if (type === 'SUCCESS') {
      resolve(data);
    } else {
      reject(new Error(error || 'Could not parse location history'));
    }
  };

  worker.onerror = (error) => {
    worker.terminate();
    reject(new Error(error.message || 'Could not parse location history'));
  };

  worker.postMessage(text);
});

const mergeMediaItems = (existingItems, incomingItems) => {
  const itemsById = new Map(existingItems.map((item) => [item.id, item]));
  const duplicates = [];
  let added = 0;

  for (const item of incomingItems) {
    if (itemsById.has(item.id)) {
      duplicates.push(item);
    } else {
      itemsById.set(item.id, item);
      added += 1;
    }
  }

  return {
    items: Array.from(itemsById.values()).sort((a, b) => a.t - b.t),
    added,
    duplicates,
  };
};

const mediaItemsToLocations = (items) => (
  items.map(({ lat, lng, t }) => ({ lat, lng, t, mediaOnly: true }))
);

const getDefaultDateRange = (locations, mediaItems = []) => {
  const times = [
    ...locations.map((item) => item.t),
    ...mediaItems.map((item) => item.t),
  ].filter(Number.isFinite);

  if (!times.length) return null;

  const lastTime = Math.max(...times);
  const lastDate = new Date(lastTime);
  return {
    start: subDays(lastDate, 7),
    end: lastDate,
  };
};

const getTimelineBounds = (locations, mediaItems) => {
  const times = [];

  if (locations.length) {
    times.push(locations[0].t, locations[locations.length - 1].t);
  }

  if (mediaItems.length) {
    times.push(mediaItems[0].t, mediaItems[mediaItems.length - 1].t);
  }

  const finiteTimes = times.filter(Number.isFinite);
  if (!finiteTimes.length) return null;

  const start = Math.min(...finiteTimes);
  const end = Math.max(...finiteTimes);

  return {
    start,
    end: end > start ? end : start + 60000,
  };
};

const formatImportSummary = ({ jsonPointCount, mediaAdded, mediaSkipped, duplicates }) => {
  const parts = [];

  if (jsonPointCount) {
    parts.push(`Loaded ${jsonPointCount.toLocaleString()} location points`);
  }

  if (mediaAdded) {
    parts.push(`added ${mediaAdded.toLocaleString()} media ${mediaAdded === 1 ? 'item' : 'items'}`);
  }

  if (duplicates) {
    parts.push(`ignored ${duplicates.toLocaleString()} duplicate ${duplicates === 1 ? 'item' : 'items'}`);
  }

  if (mediaSkipped) {
    parts.push(`skipped ${mediaSkipped.toLocaleString()} without timestamp or GPS metadata`);
  }

  if (!parts.length) return '';
  return `${parts.join(', ')}.`;
};

const getClipboardFiles = (event) => {
  const directFiles = Array.from(event.clipboardData?.files || []);
  const itemFiles = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);

  const filesByKey = new Map();

  for (const file of [...directFiles, ...itemFiles]) {
    const key = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
    filesByKey.set(key, file);
  }

  return Array.from(filesByKey.values());
};

const MIN_MEDIA_DISPLAY_MS = 500;

const MediaViewport = ({ item, index, total }) => {
  if (!total) return null;

  return (
    <div className="media-viewport pointer-events-auto w-[min(38vw,180px)] min-w-[124px] md:w-52 aspect-square overflow-hidden rounded-xl border border-white/70 bg-zinc-950 shadow-2xl shadow-slate-900/20 relative">
      {item ? (
        <>
          {item.type === 'video' ? (
            <video
              key={item.id}
              src={item.url}
              className="h-full w-full object-cover"
              muted
              autoPlay
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <img
              key={item.id}
              src={item.url}
              alt={item.name}
              className="h-full w-full object-cover"
              draggable="false"
            />
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2.5 pb-2 pt-8">
            <div className="flex items-end justify-between gap-2 text-white">
              <span className="truncate text-[11px] font-semibold">{format(item.t, 'MMM d, HH:mm')}</span>
              <span className="shrink-0 rounded-md bg-white/20 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                {index + 1}/{total}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-white/90 text-zinc-400">
          <Images className="h-7 w-7 text-[#00A6CE]" />
          <span className="text-xs font-bold tabular-nums">0/{total}</span>
        </div>
      )}
    </div>
  );
};

// --- Optimised Map Layer ---
// This component handles the heavy lifting of direct Leaflet manipulation
const AnimatedPathLayer = ({ locations, fitPoints, progressRef, distRef, timeBounds }) => {



  const map = useMap();
  const polylineRef = useRef(null);
  const markerRef = useRef(null);
  const prevIndexRef = useRef(-2);
  const coordsRef = useRef([]); // Pre-computed [lat, lng] pairs for speed
  const lastSyncProgressRef = useRef(-1);
  const cumulativeDistancesRef = useRef([]); // Pre-computed distances for odometer



  // Initial Setup
  useEffect(() => {
    if (!map) return;

    // Create Polyline
    if (!polylineRef.current) {
      polylineRef.current = L.polyline([], {
        color: '#0ea5e9',
        weight: 3,
        opacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);
    }

    // Create Marker with custom Pulsating icon
    if (!markerRef.current) {
      const pulseHtml = `
        <div class="relative flex items-center justify-center">
          <div class="absolute w-6 h-6 bg-[#00A6CE] rounded-full animate-ping opacity-75"></div>
          <div class="relative w-4 h-4 bg-[#00A6CE] rounded-full border-2 border-white shadow-lg"></div>
        </div>
      `;
      markerRef.current = L.marker([0, 0], {
        icon: L.divIcon({
          html: pulseHtml,
          className: '',
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        })
      }).addTo(map);
    }
    if (markerRef.current) markerRef.current.setOpacity(0);

    return () => {
      if (polylineRef.current) polylineRef.current.remove();
      if (markerRef.current) markerRef.current.remove();
      polylineRef.current = null;
      markerRef.current = null;
    };
  }, [map]);


  // Auto Keep-In-View (Fit Bounds) - Static
  useEffect(() => {
    if (fitPoints.length > 0 && map) {
      const bounds = L.latLngBounds(fitPoints.map(l => [l.lat, l.lng]));
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16, animate: true, duration: 1.5 });
      }
    }
  }, [fitPoints, map]);

  // Handle Data Changes
  useEffect(() => {
    prevIndexRef.current = -2;

    // Pre-compute coordinates ONCE when locations change
    coordsRef.current = locations.map(l => [l.lat, l.lng]);

    // Pre-compute cumulative distances for the odometer
    let currentDist = 0;
    const distances = [0];
    for (let i = 1; i < locations.length; i++) {
      const d = L.latLng(locations[i - 1].lat, locations[i - 1].lng).distanceTo(L.latLng(locations[i].lat, locations[i].lng));
      currentDist += d;
      distances.push(currentDist);
    }
    cumulativeDistancesRef.current = distances;

    if (locations.length > 0) {
      const first = locations[0];
      if (first && Number.isFinite(first.lat) && Number.isFinite(first.lng)) {
        // Reset Marker
        if (markerRef.current) {
          markerRef.current.setLatLng([first.lat, first.lng]);
          markerRef.current.setOpacity(1);
        }
      }
      if (polylineRef.current) polylineRef.current.setLatLngs([]);
    } else {
      if (polylineRef.current) polylineRef.current.setLatLngs([]);
      if (markerRef.current) markerRef.current.setOpacity(0);

    }
  }, [locations, map]);

  // Performance Hack: Direct update from external animation loop
  useEffect(() => {
    let animId;
    const sync = () => {
      if (!locations.length || !polylineRef.current) {
        animId = requestAnimationFrame(sync);
        return;
      }

      const p = progressRef.current;
      if (p === lastSyncProgressRef.current) {
        animId = requestAnimationFrame(sync);
        return;
      }
      lastSyncProgressRef.current = p;

      const startTime = timeBounds?.start ?? locations[0].t;
      const endTime = timeBounds?.end ?? locations[locations.length - 1].t;
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
        animId = requestAnimationFrame(sync);
        return;
      }
      const targetTime = startTime + (p * (endTime - startTime));

      const lastIndex = findLastIndexBefore(locations, targetTime);
      const prevIndex = prevIndexRef.current;

      if (lastIndex !== prevIndex) {
        // Optimized: Slicing pre-computed coordinate arrays is extremely cheap
        // compared to mapping objects every frame.
        polylineRef.current.setLatLngs(coordsRef.current.slice(0, lastIndex + 1));

        const loc = lastIndex >= 0 ? locations[lastIndex] : locations[0];
        if (markerRef.current && loc) {
          markerRef.current.setLatLng([loc.lat, loc.lng]);

          // --- Stats (Odometer in Miles) ---
          const currentTotalKm = ((cumulativeDistancesRef.current[lastIndex] || 0) / 1000);
          const currentTotalMiles = (currentTotalKm * 0.621371).toFixed(1);
          if (distRef.current) distRef.current.innerText = currentTotalMiles;

        }


        prevIndexRef.current = lastIndex;
      }

      animId = requestAnimationFrame(sync);
    };
    animId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(animId);
  }, [locations, progressRef, distRef, map, timeBounds]); // Removed viewMode


  return null;
}

// --- Main App ---

export default function App() {
  const [rawData, setRawData] = useState(null);
  const [routeMode, setRouteMode] = useState('none');
  const [mediaItems, setMediaItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [activeMediaId, setActiveMediaId] = useState(null);
  const [processing, setProcessing] = useState(false);

  // Controls
  const [dateRange, setDateRange] = useState(() => {
    // Try to parse URL params
    const params = new URLSearchParams(window.location.search);
    const s = params.get('start');
    const e = params.get('end');
    if (s && e) {
      try {
        return { start: parseISO(s), end: parseISO(e) };
      } catch {
        // Ignore invalid URL date params and fall back to the default range.
      }
    }
    return {
      start: subDays(new Date(), 7),
      end: new Date()
    };
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isEnhanced, setIsEnhanced] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [isBuffering, setIsBuffering] = useState(false);

  const progressRef = useRef(0);
  const lastTimeRef = useRef(0);
  const clockRef = useRef(null);
  const clockSubRef = useRef(null);
  const sliderRef = useRef(null);
  const distRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaItemsRef = useRef([]);
  const activeMediaIdRef = useRef(null);
  const mediaPlaybackRef = useRef({
    activeId: null,
    activeStartedAt: 0,
    lastTimelineTime: NaN,
    nextIndex: 0,
  });

  const filteredMediaItems = useMemo(() => {
    const s = startOfDay(dateRange.start).getTime();
    const e = endOfDay(dateRange.end).getTime();
    return mediaItems.filter((item) => item.t >= s && item.t <= e);
  }, [mediaItems, dateRange.start, dateRange.end]);

  const fitPoints = useMemo(() => (
    [...locations, ...filteredMediaItems]
  ), [locations, filteredMediaItems]);

  const timeBounds = useMemo(() => (
    getTimelineBounds(locations, filteredMediaItems)
  ), [locations, filteredMediaItems]);

  const canPlay = Boolean(timeBounds && (locations.length > 1 || filteredMediaItems.length > 0));

  const activeMediaIndex = useMemo(() => (
    activeMediaId ? filteredMediaItems.findIndex((item) => item.id === activeMediaId) : -1
  ), [activeMediaId, filteredMediaItems]);

  const activeMediaItem = activeMediaIndex >= 0 ? filteredMediaItems[activeMediaIndex] : null;

  useEffect(() => {
    mediaItemsRef.current = mediaItems;
  }, [mediaItems]);

  useEffect(() => {
    return () => {
      mediaItemsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  const getTimelineTimeForProgress = useCallback((progressValue) => {
    if (!timeBounds) return NaN;
    return timeBounds.start + (progressValue * (timeBounds.end - timeBounds.start));
  }, [timeBounds]);

  const setActiveMedia = useCallback((id) => {
    if (activeMediaIdRef.current === id) return;
    activeMediaIdRef.current = id;
    setActiveMediaId(id);
  }, []);

  const resetMediaPlayback = useCallback((timelineTime, frameTime = performance.now(), includeCurrent = true) => {
    if (!filteredMediaItems.length || !Number.isFinite(timelineTime)) {
      mediaPlaybackRef.current = {
        activeId: null,
        activeStartedAt: frameTime,
        lastTimelineTime: timelineTime,
        nextIndex: 0,
      };
      setActiveMedia(null);
      return;
    }

    const lookupTime = includeCurrent ? timelineTime : timelineTime - 1;
    const activeIndex = findLastIndexBefore(filteredMediaItems, lookupTime);
    const activeId = activeIndex >= 0 ? filteredMediaItems[activeIndex].id : null;

    mediaPlaybackRef.current = {
      activeId,
      activeStartedAt: frameTime,
      lastTimelineTime: timelineTime,
      nextIndex: Math.max(0, activeIndex + 1),
    };
    setActiveMedia(activeId);
  }, [filteredMediaItems, setActiveMedia]);

  const syncMediaToTimelineTime = useCallback((timelineTime, frameTime, shouldQueue = true) => {
    if (!filteredMediaItems.length || !Number.isFinite(timelineTime)) {
      resetMediaPlayback(timelineTime, frameTime);
      return false;
    }

    const state = mediaPlaybackRef.current;
    const movedBackwards = Number.isFinite(state.lastTimelineTime) && timelineTime < state.lastTimelineTime - 1;

    if (!shouldQueue || movedBackwards) {
      resetMediaPlayback(timelineTime, frameTime);
      return false;
    }

    state.lastTimelineTime = timelineTime;

    const nextItem = filteredMediaItems[state.nextIndex];
    const hasPendingDueItem = Boolean(nextItem && nextItem.t <= timelineTime);
    const canAdvance = !state.activeId || frameTime - state.activeStartedAt >= MIN_MEDIA_DISPLAY_MS;

    if (hasPendingDueItem && canAdvance) {
      state.activeId = nextItem.id;
      state.activeStartedAt = frameTime;
      state.nextIndex += 1;
      setActiveMedia(nextItem.id);
    }

    const followingItem = filteredMediaItems[state.nextIndex];
    return Boolean(followingItem && followingItem.t <= timelineTime);
  }, [filteredMediaItems, resetMediaPlayback, setActiveMedia]);

  const syncUIToProgress = useCallback(() => {
    if (!timeBounds) return;
    const p = progressRef.current;
    const currentTime = getTimelineTimeForProgress(p);

    if (clockRef.current) clockRef.current.innerText = format(currentTime, 'MMM dd, yyyy');
    if (clockSubRef.current) clockSubRef.current.innerText = format(currentTime, 'HH:mm:ss');
    if (sliderRef.current) sliderRef.current.value = p;
  }, [getTimelineTimeForProgress, timeBounds]);

  const handleScrub = useCallback((val) => {
    progressRef.current = val;
    syncUIToProgress();
    resetMediaPlayback(getTimelineTimeForProgress(val));
  }, [getTimelineTimeForProgress, resetMediaPlayback, syncUIToProgress]);

  useEffect(() => {
    resetMediaPlayback(getTimelineTimeForProgress(progressRef.current));
  }, [filteredMediaItems, getTimelineTimeForProgress, resetMediaPlayback]);





  // Animation loop driver (Ref-based for Zero-Lag)
  useEffect(() => {
    let animId;
    const step = (time) => {
      if (isPlaying && canPlay && timeBounds) {
        const deltaMs = lastTimeRef.current ? (time - lastTimeRef.current) : 16;
        const totalTravelTime = Math.max(1, timeBounds.end - timeBounds.start);
        const travelMsPerRealMs = 12000 * speed;
        const travelDelta = deltaMs * travelMsPerRealMs;

        progressRef.current = Math.min(1, progressRef.current + (travelDelta / totalTravelTime));

        const currentTime = getTimelineTimeForProgress(progressRef.current);
        const hasPendingMedia = syncMediaToTimelineTime(currentTime, time, true);

        if (progressRef.current >= 1 && !hasPendingMedia) setIsPlaying(false);

        // Targeted UI updates (No React Re-render)
        syncUIToProgress();
      }
      lastTimeRef.current = time;
      animId = requestAnimationFrame(step);
    };
    animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, canPlay, timeBounds, speed, getTimelineTimeForProgress, syncMediaToTimelineTime, syncUIToProgress]);

  // --- Handlers ---
  const resetJourney = useCallback(() => {
    mediaItems.forEach((item) => URL.revokeObjectURL(item.url));
    setMediaItems([]);
    setRawData(null);
    setRouteMode('none');
    setLocations([]);
    setError('');
    setImportNotice('');
    setActiveMedia(null);
    setIsPlaying(false);
    setIsEnhanced(true);
    progressRef.current = 0;
  }, [mediaItems, setActiveMedia]);

  const importFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    const jsonFiles = files.filter(isJsonFile);
    const mediaFiles = files.filter(isMediaFile);

    if (!jsonFiles.length && !mediaFiles.length) {
      setError('Choose a Google Timeline JSON file, photos, or videos.');
      return;
    }

    setProcessing(true);
    setError('');
    setImportNotice('');
    setIsPlaying(false);

    try {
      let parsedLocations = null;
      if (jsonFiles.length) {
        const parsedSets = await Promise.all(
          jsonFiles.map(async (file) => parseLocationText(await file.text()))
        );
        parsedLocations = parsedSets.flat().sort((a, b) => a.t - b.t);
      }

      let nextMediaItems = mediaItems;
      let mediaAdded = 0;
      let duplicateCount = 0;
      let mediaSkipped = 0;

      if (mediaFiles.length) {
        const mediaResult = await parseMediaFiles(mediaFiles);
        const merged = mergeMediaItems(mediaItems, mediaResult.items);
        merged.duplicates.forEach((item) => URL.revokeObjectURL(item.url));

        nextMediaItems = merged.items;
        mediaAdded = merged.added;
        duplicateCount = merged.duplicates.length;
        mediaSkipped = mediaResult.skipped.length;
        setMediaItems(nextMediaItems);
      }

      if (parsedLocations) {
        setRawData(parsedLocations);
        setRouteMode('location');
        setLocations([]);

        const range = getDefaultDateRange(parsedLocations, nextMediaItems);
        if (range) setDateRange(range);
      } else if (routeMode !== 'location' && nextMediaItems.length) {
        const mediaLocations = mediaItemsToLocations(nextMediaItems);
        setRawData(mediaLocations);
        setRouteMode('media');

        const range = getDefaultDateRange(mediaLocations, nextMediaItems);
        if (range) setDateRange(range);
      }

      const notice = formatImportSummary({
        jsonPointCount: parsedLocations?.length || 0,
        mediaAdded,
        mediaSkipped,
        duplicates: duplicateCount,
      });

      if (notice) setImportNotice(notice);

      if (!parsedLocations && mediaFiles.length && !mediaAdded && !duplicateCount && !rawData) {
        setError('No usable media metadata found. Photos and videos need embedded timestamp and GPS metadata.');
      }
    } catch (err) {
      setError(err.message || 'Could not import your files.');
    } finally {
      setProcessing(false);
    }
  }, [mediaItems, rawData, routeMode]);

  const handleFileUpload = useCallback((e) => {
    importFiles(e.target.files);
    e.target.value = '';
  }, [importFiles]);

  const handleManualPaste = useCallback(async (e) => {
    const text = e.target.value.trim();
    if (!text) return;

    setProcessing(true);
    setError('');
    setImportNotice('');
    setIsPlaying(false);
    setLocations([]);

    try {
      const parsed = await parseLocationText(text);
      setRawData(parsed);
      setRouteMode('location');

      const range = getDefaultDateRange(parsed, mediaItems);
      if (range) setDateRange(range);

      setImportNotice(formatImportSummary({ jsonPointCount: parsed.length }));
    } catch (err) {
      setError(err.message || 'Could not parse pasted JSON.');
    } finally {
      setProcessing(false);
    }
  }, [mediaItems]);

  const handleClipboardPaste = useCallback((event) => {
    const files = getClipboardFiles(event).filter((file) => isJsonFile(file) || isMediaFile(file));
    if (!files.length) return;

    event.preventDefault();
    importFiles(files);
  }, [importFiles]);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    importFiles(event.dataTransfer?.files);
  }, [importFiles]);

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
  }, []);

  useEffect(() => {
    window.addEventListener('paste', handleClipboardPaste);
    return () => window.removeEventListener('paste', handleClipboardPaste);
  }, [handleClipboardPaste]);

  useEffect(() => {
    if (!importNotice || processing) return undefined;

    const timer = window.setTimeout(() => setImportNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [importNotice, processing]);

  // --- Filtering & Enhancing ---

  useEffect(() => {
    if (!rawData) return;

    const s = startOfDay(dateRange.start).getTime();
    const e = endOfDay(dateRange.end).getTime();

    // 1. Basic Filter
    const filtered = rawData.filter(l => l.t >= s && l.t <= e);

    // 2. Enhance if enabled
    if (isEnhanced) {
      setIsBuffering(true);
      const timer = setTimeout(async () => {
        try {
          const routed = await enhanceWithDrivingRoute(filtered);
          setLocations(routed);
        } catch (err) {
          console.error(err);
          setLocations(filtered); // Fallback
        } finally {
          setIsBuffering(false);
        }
      }, 300);
      return () => clearTimeout(timer);
    } else {
      setLocations(filtered);
      setIsBuffering(false);
    }

    setIsPlaying(false);
    progressRef.current = 0;
    if (sliderRef.current) sliderRef.current.value = 0;
  }, [rawData, dateRange.start, dateRange.end, isEnhanced]);


  // --- UI Render ---

  if (!rawData) {
    return (
      <div
        className="min-h-screen bg-[#f8fafc] text-zinc-900 flex flex-col items-center justify-center p-4 relative overflow-hidden font-sans"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
          <div className="absolute -top-[10%] -left-[10%] w-[60%] h-[60%] bg-blue-200/30 rounded-full blur-[120px]" />
          <div className="absolute top-[40%] right-[0%] w-[50%] h-[50%] bg-rose-200/30 rounded-full blur-[120px]" />
        </div>

        <div className="z-10 max-w-lg w-full space-y-8 animate-in fade-in zoom-in duration-500">
          <div className="text-center space-y-4">
            <div className="flex justify-center mb-2">
              <div className="relative">
                <div className="w-24 h-24 bg-white/50 backdrop-blur-md rounded-3xl rotate-6 flex items-center justify-center shadow-xl shadow-cyan-100/50 border border-white/50 animate-in slide-in-from-top duration-700">
                  <img src={logoUrl} alt="Places Logo" className="w-16 h-16 object-contain -rotate-6" />
                </div>
                <div className="absolute -top-1 -right-1 w-6 h-6 bg-[#FDF08B] rounded-full shadow-md animate-bounce" />
              </div>
            </div>

            <h1 className="text-5xl font-bold tracking-tighter text-zinc-800 font-outfit">
              Oh, the Places<br /><span className="text-transparent bg-clip-text bg-gradient-to-r from-[#00A6CE] to-[#96D9C8]">You Went!</span>
            </h1>

            <p className="text-zinc-500 text-base leading-relaxed font-medium">
              Transform your Google location history into an animated journey.
            </p>

          </div>


          <Card className="space-y-6">
            <div className="space-y-2 group">
              <label
                className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-zinc-200 rounded-2xl cursor-pointer hover:bg-zinc-50 hover:border-primary/50 transition-all duration-300"
              >
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <div className="bg-primary/10 p-3 rounded-full mb-3 group-hover:scale-110 transition-transform">
                    <Upload className="w-6 h-6 text-primary" />
                  </div>
                  <p className="text-sm font-medium text-zinc-700">Upload JSON, photos, or videos</p>
                </div>

                <input
                  type="file"
                  className="hidden"
                  accept=".json,application/json,image/*,video/*"
                  multiple
                  onChange={handleFileUpload}
                />
              </label>
            </div>

            <div className="space-y-2">
              <textarea
                className="w-full h-24 bg-zinc-50 border border-zinc-200 rounded-xl p-3 text-xs font-mono text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all resize-none placeholder:text-zinc-300"
                placeholder='Paste raw JSON here, or paste photos/videos anywhere on this page...'
                onBlur={handleManualPaste}
              />
            </div>

            <AnimatePresence>
              {error && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="bg-red-50 text-red-600 text-sm p-3 rounded-xl flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                </motion.div>
              )}

              {processing && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center gap-3 py-2">
                  <div className="w-10 h-10 border-4 border-zinc-100 border-t-[#00A6CE] rounded-full animate-spin"></div>
                  <p className="text-sm font-bold text-zinc-400 uppercase tracking-widest">Processing your journey...</p>
                </motion.div>
              )}

              {importNotice && !processing && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="bg-emerald-50 text-emerald-700 text-sm p-3 rounded-xl flex items-center gap-2">
                    <Images className="w-4 h-4 shrink-0" />
                    {importNotice}
                  </div>
                </motion.div>
              )}

            </AnimatePresence>
          </Card>


          <div className="text-center space-y-2">
            <p className="text-xs text-zinc-400">
              Google Maps app &gt; Settings &gt; Location & privacy &gt; Export Timeline data<br />
              Made with ❤️ | <a href="https://hiredalmo.com" target="_blank" rel="noopener noreferrer">hiredalmo.com</a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-screen w-screen bg-slate-50 overflow-hidden relative font-sans"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <ErrorBoundary onReset={resetJourney}>
        <MapContainer
          center={[0, 0]}
          zoom={2}
          zoomControl={false}
          preferCanvas={true}
          className="h-full w-full z-0"
          style={{ background: '#f8fafc' }}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
          />

          <AnimatedPathLayer
            locations={locations}
            fitPoints={fitPoints}
            progressRef={progressRef}
            distRef={distRef}
            timeBounds={timeBounds}
          />

        </MapContainer>
      </ErrorBoundary>

      <div className="absolute top-0 left-0 right-0 p-3 md:p-4 z-[500] pointer-events-none flex flex-col items-center gap-3">
        <div className="w-full flex justify-between items-start gap-3">
          <div className="bg-white/90 backdrop-blur-xl border border-white/50 shadow-xl rounded-xl px-3.5 py-2.5 text-left pointer-events-auto min-w-[138px] max-w-[46vw]">
            <div ref={clockRef} className="text-base md:text-lg font-bold text-zinc-800 tabular-nums font-outfit leading-tight truncate">
              {timeBounds ? format(timeBounds.start, 'MMM dd, yyyy') : '...'}
            </div>
            <div ref={clockSubRef} className="text-[11px] md:text-xs text-[#00A6CE] font-bold uppercase tracking-widest mt-0.5 tabular-nums">
              {timeBounds ? format(timeBounds.start, 'HH:mm:ss') : '--:--:--'}
            </div>
            <div className="mt-2 pt-2 border-t border-zinc-100 flex items-baseline gap-1.5">
              <div ref={distRef} className="text-base md:text-lg font-black text-zinc-900 tabular-nums tracking-tight leading-none">0.0</div>
              <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-[0.16em]">mi</div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="pointer-events-auto flex items-center gap-1.5">
              {mediaItems.length > 0 && (
                <div className="h-9 px-2.5 rounded-lg bg-white/90 border border-white/60 shadow-sm flex items-center gap-1.5 text-[11px] font-bold text-zinc-500">
                  <Images className="w-4 h-4 text-[#00A6CE]" />
                  {filteredMediaItems.length}/{mediaItems.length}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".json,application/json,image/*,video/*"
                multiple
                onChange={handleFileUpload}
              />
              <Button
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                className="p-2 rounded-lg h-9 w-9 text-zinc-400 hover:text-[#00A6CE]"
                aria-label="Add photos or videos"
                title="Add photos or videos"
              >
                <ImagePlus className="w-[18px] h-[18px]" />
              </Button>
              <Button
                variant="secondary"
                onClick={resetJourney}
                className="p-2 rounded-lg h-9 w-9 text-zinc-400 hover:text-red-500"
                aria-label="Clear journey"
                title="Clear journey"
              >
                <Trash2 className="w-[18px] h-[18px]" />
              </Button>
            </div>
            <MediaViewport
              item={activeMediaItem}
              index={activeMediaIndex}
              total={filteredMediaItems.length}
            />
          </div>
        </div>

        <AnimatePresence>
          {(error || importNotice || processing) && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className={cn(
                "pointer-events-auto max-w-[calc(100vw-1.5rem)] md:max-w-md pl-3 pr-2 py-2 rounded-xl shadow-lg border text-sm font-medium flex items-center gap-2",
                error
                  ? "bg-red-50/95 border-red-100 text-red-600"
                  : "bg-white/95 border-white/60 text-zinc-600"
              )}
            >
              {error ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Images className="w-4 h-4 shrink-0 text-[#00A6CE]" />}
              <span className="min-w-0 flex-1">{processing ? 'Processing your files...' : error || importNotice}</span>
              {!processing && (
                <button
                  type="button"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                  onClick={() => {
                    setError('');
                    setImportNotice('');
                  }}
                  aria-label="Dismiss"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

      </div>


      <AnimatePresence>
        {showControls && (


          <motion.div
            initial={{ y: 200, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 200, opacity: 0 }}
            className="absolute bottom-0 left-0 right-0 p-3 md:p-4 z-[500] pointer-events-none"
          >
            <div className="pointer-events-auto max-w-2xl mx-auto rounded-2xl bg-white/[0.92] backdrop-blur-xl border border-white/60 shadow-2xl shadow-blue-900/10 ring-1 ring-black/5 px-3 py-3 md:px-4 md:py-3">
              <input
                ref={sliderRef}
                type="range"
                min="0"
                max="1"
                step="0.0001"
                defaultValue="0"
                onChange={(e) => handleScrub(parseFloat(e.target.value))}
                className="w-full h-1.5 bg-zinc-100 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none"
              />

              <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-3">
                <div className="min-w-0 flex flex-col gap-2">
                  <div className="flex items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-1.5 text-zinc-600">
                    <Calendar className="w-4 h-4 shrink-0 text-zinc-400" />
                    <input
                      type="date"
                      value={format(dateRange.start, 'yyyy-MM-dd')}
                      onChange={e => e.target.value && setDateRange(prev => ({ ...prev, start: parseISO(e.target.value) }))}
                      className="min-w-0 flex-1 bg-transparent border-none p-0 text-zinc-700 text-xs font-semibold focus:ring-0"
                    />
                    <span className="text-[11px] font-bold uppercase text-zinc-300">to</span>
                    <input
                      type="date"
                      value={format(dateRange.end, 'yyyy-MM-dd')}
                      onChange={e => e.target.value && setDateRange(prev => ({ ...prev, end: parseISO(e.target.value) }))}
                      className="min-w-0 flex-1 bg-transparent border-none p-0 text-zinc-700 text-xs font-semibold focus:ring-0 text-right"
                    />
                  </div>

                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <button
                      onClick={() => setIsEnhanced(!isEnhanced)}
                      className={cn(
                        "h-8 rounded-lg border px-3 text-[10px] font-bold uppercase tracking-wider transition-all",
                        isEnhanced
                          ? "bg-emerald-50 text-emerald-600 border-emerald-200"
                          : "bg-zinc-50 text-zinc-400 border-zinc-100 hover:border-zinc-300"
                      )}
                    >
                      {isEnhanced ? "Roads On" : "Roads Off"}
                    </button>

                    <div className="flex h-8 items-center gap-1 rounded-lg border border-zinc-100 bg-zinc-50 px-1.5">
                      <span className="px-1 text-[10px] font-bold text-zinc-400 uppercase">Speed</span>
                      {[1, 2, 5, 10].map(s => (
                        <button
                          key={s}
                          onClick={() => setSpeed(s)}
                          className={cn(
                            "w-7 h-6 flex items-center justify-center rounded-md text-[10px] font-bold transition-all",
                            speed === s ? "bg-primary text-white" : "text-zinc-400 hover:bg-zinc-200"
                          )}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <Button
                  className="h-12 w-12 rounded-full p-0 flex items-center justify-center shrink-0"
                  onClick={() => {
                    if (!isPlaying && progressRef.current >= 1) {
                      handleScrub(0);
                    }
                    if (!isPlaying && progressRef.current <= 0.0001) {
                      resetMediaPlayback(getTimelineTimeForProgress(progressRef.current), performance.now(), false);
                    }
                    setIsPlaying(!isPlaying);
                  }}
                  disabled={isBuffering || !canPlay}
                >
                  {isBuffering ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : isPlaying ? (
                    <Pause className="w-5 h-5 fill-current" />
                  ) : (
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                  )}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setShowControls(!showControls)}
        className={cn(
          "absolute right-3 z-[500] bg-white shadow-soft p-3 rounded-full text-zinc-400 hover:text-zinc-600 transition-all md:hidden border border-zinc-100",
          showControls ? "bottom-[calc(env(safe-area-inset-bottom)+132px)]" : "bottom-[calc(env(safe-area-inset-bottom)+16px)]"
        )}
      >
        {showControls ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
      </button>
    </div>
  );
}
