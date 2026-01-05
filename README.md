# Oh, the Places You Went!

### [Live Demo](https://places.hiredalmo.com) | [Portfolio](https://hiredalmo.com/portfolio)

Google Maps had all my data, but the app wouldn't show me anything cool with it. So I built this to see what I could do with my own locationhistory and a basic web stack.

**Oh, the Places You Went!** is a high-performance visualization engine for Google Maps location history. It transforms years of raw, flat JSON data into a beautiful, animated narrative of your life’s movement.

## The Mission

Google Timeline offers a static list of points, separated into different days. I wanted to see more of a long-term journey. I built this app as a technical challenge to see if I could handle massive datasets (500MB+ JSON files) directly in the browser while maintaining a smooth 60fps animation, even on mobile devices.

## Performance Engineering

Handling hundreds of thousands of location points in a standard React app usually leads to "Page Unresponsive" errors. I solved this through a custom high-performance architecture:

### 1. Zero-Lag UI Engine
Most React apps suffer from "re-render lag" during high-frequency updates (like a clock or progress slider). I implemented a **Ref-based Animation Loop** that bypasses React's virtual DOM entirely for the playback phase.
- **Direct DOM Manipulation**: The clock, odometer, and slider are updated via `refs`, resulting in 0ms React diffing time during animation.
- **RequestAnimationFrame**: Synchronized with the browser's refresh rate for smoothness.

### 2. Multi-Threaded Data Processing
Parsing a 500MB JSON file blocks the main thread, freezing the UI. I offloaded the entire parsing and filtering logic to a **Web Worker**.
- **Streams API**: Efficiently processes massive files in the background.
- **Client-Side Privacy**: Data stays 100% on your machine; it never touches a server.

### 3. Binary Search Temporal Lookups
To find the exact location for a specific timestamp (e.g., "Where was I at 2:15 PM?"), a linear search is too slow ($O(n)$). I implemented a **Temporal Binary Search** ($O(\log n)$) to perform lookups fast, even with 100k+ points.

### 4. Canvas-Accelerated Mapping
SVG markers and traditional DOM-based polylines don't perform well on large datasets. This app utilizes **Leaflet's Canvas Renderer**:
- **Coordinate Caching**: Lat/Lng pairs are pre-computed and cached during the initial parse to avoid object allocation during the animation frames.
- **Bulk Rendering**: Updates the entire path trajectory in a single GPU-accelerated draw call.

### 5. Smart Routing (Mapbox Integration)
The "Roads On" feature uses the **Mapbox Directions API** to snap raw GPS "breadbox" points to real-world roads, creating a professional, drivable route visualization rather than just straight lines.

## Tech Stack

- **Framework**: React / Vite
- **Mapping**: Leaflet / Mapbox API
- **State Management**: Zero-render Ref-loops
- **Animations**: Framer Motion
- **Performance**: Web Workers / Canvas API
- **Styling**: Tailwind CSS (for that Dr. Seuss look)

## Getting Started

1.  **Export your Data**:
    - **Mobile**: Open the Google Maps app, go to your profile > Settings > Location & privacy > Export Timeline data.
    - **Desktop**: Go to [Google Takeout](https://takeout.google.com/). Select **Location History (Timeline)** in JSON format. Download and find `Records.json`.

2.  **Run Locally**:
    ```bash
    git clone https://github.com/dalmomendonca/places.git
    cd places
    npm install
    npm run dev
    ```

3.  **Deploy**:
    Connect to Netlify/Vercel. The project is pre-configured with a custom `netlify.toml` for optimized builds.

---

## 👨‍💻 About Me

I'm a developer obsessed with performance and storytelling through data. Check out more of my work at [hiredalmo.com](https://hiredalmo.com).

> [!NOTE]
> This project was built to demonstrate that personal data belongs to the user, and with the right tools, we can make it meaningful.