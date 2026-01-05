import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { motion, AnimatePresence } from 'framer-motion';
import { Map, Upload, Play, Pause, ChevronDown, ChevronUp, MapPin, Calendar, Trash2, AlertCircle } from 'lucide-react';
import logoUrl from './assets/places-logo.png';
import { format, subDays, isWithinInterval, startOfDay, endOfDay, parseISO } from 'date-fns';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import ParserWorker from './parser.worker.js?worker';
import ErrorBoundary from './ErrorBoundary';
import { enhanceWithDrivingRoute } from './services/mapbox.js';

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
  let result = 0;
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

// --- Optimised Map Layer ---
// This component handles the heavy lifting of direct Leaflet manipulation
const AnimatedPathLayer = ({ locations, progressRef, distRef }) => {



  const map = useMap();
  const polylineRef = useRef(null);
  const markerRef = useRef(null);
  const prevIndexRef = useRef(0);
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
    if (markerRef.current) markerRef.current.setOpacity(locations.length > 0 ? 1 : 0);

    return () => {
      if (polylineRef.current) polylineRef.current.remove();
      if (markerRef.current) markerRef.current.remove();
      polylineRef.current = null;
      markerRef.current = null;
    };
  }, [map]);


  // Auto Keep-In-View (Fit Bounds) - Static
  useEffect(() => {
    if (locations.length > 0 && map) {
      const bounds = L.latLngBounds(locations.map(l => [l.lat, l.lng]));
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16, animate: true, duration: 1.5 });
      }
    }
  }, [locations, map]);

  // Handle Data Changes
  useEffect(() => {
    prevIndexRef.current = 0;

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

      const startTime = locations[0].t;
      const endTime = locations[locations.length - 1].t;
      const targetTime = startTime + (p * (endTime - startTime));

      const lastIndex = findLastIndexBefore(locations, targetTime);
      const prevIndex = prevIndexRef.current;

      if (lastIndex !== prevIndex) {
        // Optimized: Slicing pre-computed coordinate arrays is extremely cheap
        // compared to mapping objects every frame.
        polylineRef.current.setLatLngs(coordsRef.current.slice(0, lastIndex + 1));

        const loc = locations[lastIndex];
        if (markerRef.current && loc) {
          markerRef.current.setLatLng([loc.lat, loc.lng]);

          // --- Stats (Odometer in Miles) ---
          const currentTotalKm = (cumulativeDistancesRef.current[lastIndex] / 1000);
          const currentTotalMiles = (currentTotalKm * 0.621371).toFixed(1);
          if (distRef.current) distRef.current.innerText = currentTotalMiles;

        }


        prevIndexRef.current = lastIndex;
      }

      animId = requestAnimationFrame(sync);
    };
    animId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(animId);
  }, [locations, progressRef, map]); // Removed viewMode


  return null;
}

// --- Main App ---

export default function App() {
  const [rawData, setRawData] = useState(null);
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0); // 0 to 1

  // Controls
  const [dateRange, setDateRange] = useState(() => {
    // Try to parse URL params
    const params = new URLSearchParams(window.location.search);
    const s = params.get('start');
    const e = params.get('end');
    if (s && e) {
      try {
        return { start: parseISO(s), end: parseISO(e) };
      } catch (e) { }
    }
    return {
      start: subDays(new Date(), 7),
      end: new Date()
    };
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isEnhanced, setIsEnhanced] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [isBuffering, setIsBuffering] = useState(false);

  const progressRef = useRef(0);
  const lastTimeRef = useRef(0);
  const clockRef = useRef(null);
  const clockSubRef = useRef(null);
  const sliderRef = useRef(null);
  const distRef = useRef(null);
  const totalDistanceRef = useRef(0);





  // Animation loop driver (Ref-based for Zero-Lag)
  useEffect(() => {
    let animId;
    const step = (time) => {
      if (isPlaying && locations.length > 1) {
        const deltaMs = lastTimeRef.current ? (time - lastTimeRef.current) : 16;
        const startTime = locations[0].t;
        const endTime = locations[locations.length - 1].t;
        const totalTravelTime = endTime - startTime;
        const travelMsPerRealMs = 12000 * speed;
        const travelDelta = deltaMs * travelMsPerRealMs;

        progressRef.current = Math.min(1, progressRef.current + (travelDelta / totalTravelTime));

        if (progressRef.current >= 1) setIsPlaying(false);

        // Targeted UI updates (No React Re-render)
        syncUIToProgress();
      }
      lastTimeRef.current = time;
      animId = requestAnimationFrame(step);
    };
    animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, locations, speed]);

  const syncUIToProgress = () => {
    if (!locations.length) return;
    const p = progressRef.current;
    const startTime = locations[0].t;
    const total = locations[locations.length - 1].t - startTime;
    const currentTime = startTime + (p * total);

    if (clockRef.current) clockRef.current.innerText = format(currentTime, 'MMM dd, yyyy');
    if (clockSubRef.current) clockSubRef.current.innerText = format(currentTime, 'HH:mm:ss');
    if (sliderRef.current) sliderRef.current.value = p;
  };

  const handleScrub = (val) => {
    progressRef.current = val;
    syncUIToProgress();
  };

  // --- Handlers ---
  const workerRef = useRef(null);

  useEffect(() => {
    workerRef.current = new ParserWorker();

    workerRef.current.onmessage = (e) => {
      const { type, data, error } = e.data;
      if (type === 'SUCCESS') {
        const parsed = data;
        setRawData(parsed);
        // Default Range
        if (parsed.length > 0) {
          const lastTime = parsed[parsed.length - 1].t;
          const lastDate = new Date(lastTime);
          setDateRange({
            start: subDays(lastDate, 7),
            end: lastDate
          });
        }
        setProcessing(false);
      } else if (type === 'ERROR') {
        setError(error);
        setProcessing(false);
      }
    };

    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setProcessing(true);
    setError('');
    setIsPlaying(false);
    setLocations([]);

    const reader = new FileReader();
    reader.onload = (event) => {
      // Send string to worker
      workerRef.current.postMessage(event.target.result);
    };
    reader.onerror = () => {
      setError("Error reading file");
      setProcessing(false);
    }
    reader.readAsText(file);
  };

  const handleManualPaste = (e) => {
    const text = e.target.value;
    if (!text) return;

    setProcessing(true);
    setError('');
    setIsPlaying(false);
    setLocations([]);

    // Send string to worker directly
    workerRef.current.postMessage(text);
  }

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
    handleScrub(0);
  }, [rawData, dateRange.start, dateRange.end, isEnhanced]);


  // --- UI Render ---

  if (!rawData) {
    return (
      <div className="min-h-screen bg-[#f8fafc] text-zinc-900 flex flex-col items-center justify-center p-4 relative overflow-hidden font-sans">
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
                  <p className="text-sm font-medium text-zinc-700">Upload JSON</p>
                </div>

                <input type="file" className="hidden" accept=".json" onChange={handleFileUpload} />
              </label>
            </div>

            <div className="space-y-2">
              <textarea
                className="w-full h-24 bg-zinc-50 border border-zinc-200 rounded-xl p-3 text-xs font-mono text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all resize-none placeholder:text-zinc-300"
                placeholder='Paste raw JSON here...'
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
    <div className="h-screen w-screen bg-slate-50 overflow-hidden relative font-sans">
      <ErrorBoundary onReset={() => setRawData(null)}>
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
            progressRef={progressRef}
            distRef={distRef}
          />

        </MapContainer>
      </ErrorBoundary>

      <div className="absolute top-0 left-0 right-0 p-4 z-[500] pointer-events-none flex flex-col items-center gap-4">
        {/* Top Bar */}
        <div className="w-full flex justify-between items-start">
          {/* Clock & Odometer Display */}
          <div className="bg-white/90 backdrop-blur-xl border border-white/40 shadow-glass rounded-2xl px-8 py-3 text-center pointer-events-auto shadow-xl flex flex-col items-center">
            <div ref={clockRef} className="text-xl font-bold text-zinc-800 tabular-nums font-outfit">
              {locations.length > 0 ? format(locations[0].t, 'MMM dd, yyyy') : '...'}
            </div>
            <div ref={clockSubRef} className="text-xs text-[#00A6CE] font-bold uppercase tracking-widest mt-0.5">
              {locations.length > 0 ? format(locations[0].t, 'HH:mm:ss') : '--:--:--'}
            </div>
            <div className="mt-3 pt-3 border-t border-zinc-100 flex flex-col items-center">
              <div ref={distRef} className="text-lg font-black text-zinc-900 tabular-nums tracking-tight leading-none">0.0</div>
              <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-[0.2em] mt-1.5">Miles Traveled</div>
            </div>
          </div>




          {/* Actions */}
          <div className="space-x-2 pointer-events-auto flex">
            <Button variant="secondary" onClick={() => setRawData(null)} className="p-2 rounded-xl h-10 w-10 text-zinc-400 hover:text-red-500">
              <Trash2 className="w-5 h-5" />
            </Button>
          </div>

        </div>

      </div>


      <AnimatePresence>
        {showControls && (


          <motion.div
            initial={{ y: 200, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 200, opacity: 0 }}
            className="absolute bottom-0 left-0 right-0 p-6 z-[500]"
          >
            <Card className="max-w-xl mx-auto shadow-2xl shadow-blue-900/5 ring-1 ring-black/5">
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-100 pb-4">
                  <div className="flex items-center gap-3 text-sm text-zinc-600 bg-zinc-50 px-3 py-1.5 rounded-lg border border-zinc-100">
                    <Calendar className="w-4 h-4 text-zinc-400" />
                    <input
                      type="date"
                      value={format(dateRange.start, 'yyyy-MM-dd')}
                      onChange={e => e.target.value && setDateRange(prev => ({ ...prev, start: parseISO(e.target.value) }))}
                      className="bg-transparent border-none p-0 text-zinc-700 text-xs font-medium focus:ring-0 w-24"
                    />
                    <span className="text-zinc-300">→</span>
                    <input
                      type="date"
                      value={format(dateRange.end, 'yyyy-MM-dd')}
                      onChange={e => e.target.value && setDateRange(prev => ({ ...prev, end: parseISO(e.target.value) }))}
                      className="bg-transparent border-none p-0 text-zinc-700 text-xs font-medium focus:ring-0 w-24 text-right"
                    />
                  </div>

                  {/* Enhance Toggle */}
                  <button
                    onClick={() => setIsEnhanced(!isEnhanced)}
                    className={cn(
                      "text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg border transition-all",
                      isEnhanced
                        ? "bg-emerald-50 text-emerald-600 border-emerald-200"
                        : "bg-zinc-50 text-zinc-400 border-zinc-100 hover:border-zinc-300"
                    )}
                  >
                    {isEnhanced ? "Roads On" : "Roads Off"}
                  </button>

                  <div className="flex items-center gap-2 bg-zinc-50 px-3 py-1.5 rounded-lg border border-zinc-100">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase mr-1">Speed</span>
                    {[1, 2, 5, 10].map(s => (
                      <button
                        key={s}
                        onClick={() => setSpeed(s)}
                        className={cn(
                          "w-7 h-7 flex items-center justify-center rounded-md text-[10px] font-bold transition-all",
                          speed === s ? "bg-primary text-white" : "text-zinc-400 hover:bg-zinc-200"
                        )}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>

                  <Button
                    className="h-10 w-10 rounded-full p-0 flex items-center justify-center shrink-0"
                    onClick={() => {
                      if (!isPlaying && progressRef.current >= 1) {
                        handleScrub(0);
                      }
                      setIsPlaying(!isPlaying);
                    }}
                    disabled={isBuffering}
                  >
                    {isBuffering ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : isPlaying ? (
                      <Pause className="w-4 h-4 fill-current" />
                    ) : (
                      <Play className="w-4 h-4 fill-current ml-0.5" />
                    )}
                  </Button>
                </div>

                <div className="space-y-4">
                  <div className="relative group">
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
                  </div>
                </div>

              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setShowControls(!showControls)}
        className="absolute bottom-6 right-6 z-[500] bg-white shadow-soft p-3 rounded-full text-zinc-400 hover:text-zinc-600 transition-all md:hidden border border-zinc-100"
      >
        {showControls ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
      </button>
    </div>
  );
}
