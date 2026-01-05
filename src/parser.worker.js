/* eslint-disable no-restricted-globals */

self.onmessage = (e) => {
    const { data } = e;

    try {
        let json;
        // If it's a string, parse it. If it's already an object, use it.
        if (typeof data === 'string') {
            json = JSON.parse(data);
        } else {
            json = data;
        }

        const result = processData(json);
        self.postMessage({ type: 'SUCCESS', data: result });
    } catch (err) {
        self.postMessage({ type: 'ERROR', error: err.message });
    }
};

function processData(json) {
    let locations = [];

    // CASE 1: Semantic Location History (Root Array or 'timelineObjects')
    // The user's sample file is a root array of objects like { visit: ... } or { activity: ... }
    let timelineObjects = null;

    if (Array.isArray(json)) {
        timelineObjects = json; // Root array
    } else if (json.timelineObjects && Array.isArray(json.timelineObjects)) {
        timelineObjects = json.timelineObjects;
    }

    if (timelineObjects) {
        // Parse Semantic Format
        for (const item of timelineObjects) {
            // We are looking for "placeLocation" or "start/end" in activites with "geo:" prefix

            // 1. Visits
            if (item.visit) {
                const visit = item.visit;
                // Try topCandidate first
                let loc = visit.topCandidate?.placeLocation;
                // Sometimes in other formats it might be elsewhere, but sample shows topCandidate.placeLocation

                if (loc && typeof loc === 'string' && loc.startsWith('geo:')) {
                    const coords = parseGeoString(loc);
                    if (coords) {
                        const t = parseTime(item.startTime) || parseTime(item.endTime);
                        if (t) locations.push({ lat: coords.lat, lng: coords.lng, t });
                    }
                }
            }

            // 2. Activities (Movement)
            if (item.activity) {
                const activity = item.activity;
                // Activities have start and end points
                if (activity.start) {
                    const coords = parseGeoString(activity.start);
                    if (coords) {
                        const t = parseTime(item.startTime);
                        if (t) locations.push({ lat: coords.lat, lng: coords.lng, t });
                    }
                }
                if (activity.end) {
                    const coords = parseGeoString(activity.end);
                    if (coords) {
                        const t = parseTime(item.endTime);
                        if (t) locations.push({ lat: coords.lat, lng: coords.lng, t });
                    }
                }
            }
        }
    }
    // CASE 2: Raw Location History (Standard Takeout)
    else if (json.locations && Array.isArray(json.locations)) {
        // Parse Raw Format
        for (const l of json.locations) {
            if (l.latitudeE7 && l.longitudeE7) {
                const t = Number(l.timestampMs) || parseTime(l.timestamp);
                if (t) {
                    locations.push({
                        lat: l.latitudeE7 / 1e7,
                        lng: l.longitudeE7 / 1e7,
                        t: t
                    });
                }
            }
        }
    } else {
        throw new Error("Unknown JSON format. Could not find 'locations', 'timelineObjects', or root array.");
    }

    if (locations.length === 0) {
        throw new Error("No valid locations found in file.");
    }

    // Sort by time
    // Typed Arrays for performance would be better for massive data, but let's stick to objects for code clarity unless it crashes.
    // Optimization: Filter duplicates?
    locations.sort((a, b) => a.t - b.t);

    return locations;
}

function parseGeoString(str) {
    // Format: "geo:27.171937,-80.295489"
    try {
        if (typeof str !== 'string') return null;
        const clean = str.replace('geo:', '');
        const parts = clean.split(',');
        if (parts.length !== 2) return null;

        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);

        if (isFinite(lat) && isFinite(lng)) {
            return { lat, lng };
        }
        return null;
    } catch (e) {
        return null;
    }
}

function parseTime(t) {
    if (!t) return null;
    if (typeof t === 'number') return t;
    // ISO String
    const date = new Date(t);
    return date.getTime();
}
