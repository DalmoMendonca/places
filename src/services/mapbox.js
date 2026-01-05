import mbPolyline from '@mapbox/polyline';

const MAPBOX_TOKEN = 'pk.eyJ1IjoiZGFsbW9tZW5kb25jYSIsImEiOiJjbWswOTQwMXQ1Y3hnM2dxMXN5emNqMGx1In0.PjQePfVN79oF2-9tkMY2Yw';
const BASE_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';

/**
 * Fetches driving route for a set of coordinates.
 * Mapbox Max: 25 coords per request.
 * We must batch.
 */
export async function enhanceWithDrivingRoute(locations) {
    if (!locations || locations.length < 2) return locations;

    // 1. Simplify/Sample if too many?
    // For now, let's just take all of them. If > 1000, probably too slow?
    // Let's assume user filters to a reasonable week.

    // 2. Chunk into groups of 25
    // Note: Directions API requires endpoints of chunks to overlap to connect them?
    // Batch 1: 0 - 24
    // Batch 2: 24 - 49 (Point 24 is repeated as start)
    const chunkSize = 25;
    const chunks = [];

    for (let i = 0; i < locations.length; i += (chunkSize - 1)) {
        const chunk = locations.slice(i, i + chunkSize);
        if (chunk.length < 2) break;
        chunks.push(chunk);
    }

    // 3. Process each chunk
    const results = [];

    // We process sequentially to check progress? or Promise.all?
    // Promise.all might hit rate limits. Let's do batches of 5 requests or just sequential.
    // Sequential for safety.

    for (const chunk of chunks) {
        try {
            const coordsString = chunk.map(l => `${l.lng},${l.lat}`).join(';');
            const url = `${BASE_URL}/${coordsString}?overview=full&geometries=polyline&access_token=${MAPBOX_TOKEN}`;

            const response = await fetch(url);
            if (!response.ok) {
                console.warn("Mapbox API Error:", response.status);
                // Fallback: return straight line for this chunk
                results.push(...chunk.slice(0, -1)); // Don't allow duplicates
                continue;
            }

            const data = await response.json();
            if (data.routes && data.routes[0]) {
                const route = data.routes[0];
                const decoded = mbPolyline.decode(route.geometry);

                // Mapbox returns [lat, lng].
                // We need to interpolate timestamps.
                // Chunk Start Time: chunk[0].t
                // Chunk End Time: chunk[layer].t
                const startTime = chunk[0].t;
                const endTime = chunk[chunk.length - 1].t;
                const duration = endTime - startTime;

                const detailedPoints = decoded.map((pt, idx) => {
                    const progress = idx / (decoded.length - 1);
                    return {
                        lat: pt[0],
                        lng: pt[1],
                        t: startTime + (duration * progress)
                    };
                });

                // Push points (exclude last one to avoid duplication with next chunk start)
                // UNLESS it's the very last chunk.
                const isLastChunk = (chunk === chunks[chunks.length - 1]);

                if (isLastChunk) {
                    results.push(...detailedPoints);
                } else {
                    results.push(...detailedPoints.slice(0, -1));
                }

            } else {
                // Fallback
                const isLastChunk = (chunk === chunks[chunks.length - 1]);
                if (isLastChunk) results.push(...chunk);
                else results.push(...chunk.slice(0, -1));
            }

        } catch (err) {
            console.error("Route fetch failed", err);
            const isLastChunk = (chunk === chunks[chunks.length - 1]);
            if (isLastChunk) results.push(...chunk);
            else results.push(...chunk.slice(0, -1));
        }
    }

    return results;
}
