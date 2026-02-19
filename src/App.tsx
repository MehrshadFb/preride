import { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './App.css';
import sampleRoute from './data/sampleRoute.geojson';

const DEM_SOURCE_ID = 'mapbox-dem';
const SKY_LAYER_ID = 'sky';
const ROUTE_SOURCE_ID = 'route';
const ROUTE_LAYER_ID = 'route-line';
const WIND_SOURCE_ID = 'wind-source';
const WIND_LAYER_ID = 'wind-layer';

type WindQuality = 'Low' | 'Medium' | 'High';

const QUALITY_SETTINGS = {
  Low: { count: 1000, speed: 0.15, fade: 0.95 },
  Medium: { count: 3000, speed: 0.25, fade: 0.9 },
  High: { count: 7000, speed: 0.35, fade: 0.85 },
  reset: 0.4,
};

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terrainOn, setTerrainOn] = useState(true);
  const [windOn, setWindOn] = useState(true);
  const [windQuality, setWindQuality] = useState<WindQuality>('Low'); // Start safe
  const [isAutoDowngraded, setIsAutoDowngraded] = useState(false);
  const [isSafe, setIsSafe] = useState(true);
  const [mapReady, setMapReady] = useState(false);

  // Refs for performance monitoring
  const framesRef = useRef(0);
  const lastCheckRef = useRef(performance.now());
  const lastFrameTime = useRef<number>(0);
  const rafRef = useRef<number>(0);
  const isInteracting = useRef(false);

  useEffect(() => {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token) {
      setError('Missing VITE_MAPBOX_TOKEN environment variable.');
      return;
    }

    if (map.current) return;

    mapboxgl.accessToken = token;

    try {
      if (mapContainer.current) {
        map.current = new mapboxgl.Map({
          container: mapContainer.current,
          style: 'mapbox://styles/mapbox/satellite-streets-v12',
          center: [-79.3832, 43.6532],
          zoom: 10,
          pitch: 45,
        });

        map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

        // Safety: WebGL context loss
        const canvas = map.current.getCanvas();
        const handleContextLost = (e: Event) => {
          e.preventDefault();
          setIsSafe(false);
          console.error('WebGL context lost. Disabling wind particles.');
        };
        canvas.addEventListener('webglcontextlost', handleContextLost);

        map.current.on('load', () => {
          const m = map.current!;

          // Process route into segments
          const routeFeature = (sampleRoute as GeoJSON.FeatureCollection).features.find(
            (f) => f.geometry.type === 'LineString'
          );

          let segments: GeoJSON.Feature<GeoJSON.LineString>[] = [];

          if (routeFeature) {
            const coords = (routeFeature.geometry as GeoJSON.LineString).coordinates;
            for (let i = 0; i < coords.length - 1; i++) {
              const segment: GeoJSON.Feature<GeoJSON.LineString> = {
                type: 'Feature',
                properties: {
                  score: (i % 100) / 100, // Synthetic score 0.0 - 0.99
                },
                geometry: {
                  type: 'LineString',
                  coordinates: [coords[i], coords[i + 1]],
                },
              };
              segments.push(segment);
            }
          }

          const segmentCollection: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: segments,
          };

          // Add route GeoJSON source
          m.addSource(ROUTE_SOURCE_ID, {
            type: 'geojson',
            data: segmentCollection,
          });

          // Add route line layer with data-driven styling
          m.addLayer({
            id: ROUTE_LAYER_ID,
            type: 'line',
            source: ROUTE_SOURCE_ID,
            layout: {
              'line-join': 'round',
              'line-cap': 'round',
            },
            paint: {
              // Interpolate score from 0 (Green) to 0.5 (Yellow) to 1 (Red)
              'line-color': [
                'interpolate',
                ['linear'],
                ['get', 'score'],
                0, '#22c55e',   // Green
                0.5, '#eab308', // Yellow
                1, '#ef4444'    // Red
              ],
              'line-width': 5,
              'line-opacity': 0.9,
            },
          });

          setMapReady(true);
        });
      }
    } catch (err) {
      console.error('Error initializing map:', err);
      setError('Failed to initialize map. Check console for details.');
    }

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  const enableTerrain = useCallback(() => {
    const m = map.current;
    if (!m) return;

    // Add DEM source only if not already present
    if (!m.getSource(DEM_SOURCE_ID)) {
      m.addSource(DEM_SOURCE_ID, {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      });
    }

    m.setTerrain({ source: DEM_SOURCE_ID, exaggeration: 1.3 });

    // Add sky layer only if not already present
    if (!m.getLayer(SKY_LAYER_ID)) {
      m.addLayer({
        id: SKY_LAYER_ID,
        type: 'sky',
        paint: {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 0.0],
          'sky-atmosphere-sun-intensity': 15,
        },
      });
    } else {
      m.setLayoutProperty(SKY_LAYER_ID, 'visibility', 'visible');
    }
  }, []);

  const disableTerrain = useCallback(() => {
    const m = map.current;
    if (!m) return;

    m.setTerrain(null);

    if (m.getLayer(SKY_LAYER_ID)) {
      m.setLayoutProperty(SKY_LAYER_ID, 'visibility', 'none');
    }
  }, []);

  const updateWindSettings = useCallback((quality: WindQuality, countOverride?: number) => {
    const m = map.current;
    if (!m || !m.getLayer(WIND_LAYER_ID)) return;

    const settings = QUALITY_SETTINGS[quality];
    // Use countOverride if provided (e.g. 0 for interaction), otherwise use setting
    const finalCount = countOverride !== undefined ? countOverride : settings.count;

    m.setPaintProperty(WIND_LAYER_ID, 'raster-particle-speed-factor', settings.speed);
    m.setPaintProperty(WIND_LAYER_ID, 'raster-particle-fade-opacity-factor', settings.fade);
    m.setPaintProperty(WIND_LAYER_ID, 'raster-particle-reset-rate-factor', QUALITY_SETTINGS.reset);
    m.setPaintProperty(WIND_LAYER_ID, 'raster-particle-count', finalCount);
  }, []);

  const enableWind = useCallback(() => {
    const m = map.current;
    if (!m || !isSafe) return; // Respect safety flag

    // Add wind source if not present
    if (!m.getSource(WIND_SOURCE_ID)) {
      m.addSource(WIND_SOURCE_ID, {
        type: 'raster-array',
        url: 'mapbox://rasterarrayexamples.gfs-winds',
        tileSize: 512,
      });
    }

    // Add wind layer if not present
    if (!m.getLayer(WIND_LAYER_ID)) {
      m.addLayer(
        {
          id: WIND_LAYER_ID,
          type: 'raster-particle',
          source: WIND_SOURCE_ID,
          'source-layer': 'gfs-winds',
          paint: {
            'raster-particle-speed-factor': QUALITY_SETTINGS[windQuality].speed,
            'raster-particle-fade-opacity-factor': QUALITY_SETTINGS[windQuality].fade,
            'raster-particle-reset-rate-factor': QUALITY_SETTINGS.reset,
            'raster-particle-count': QUALITY_SETTINGS[windQuality].count,
            'raster-particle-max-speed': 40,
            'raster-particle-color': [
              'interpolate',
              ['linear'],
              ['raster-particle-speed'],
              1.5,
              'rgba(134, 163, 171, 0.4)', // Light greenish-blue, low opacity
              15,
              'rgba(110, 185, 209, 0.8)', // Stronger blue
              30,
              'rgba(230, 0, 255, 0.8)'  // Purple for high speed
            ],
          },
        },
        ROUTE_LAYER_ID // Insert before route layer so wind is background
      );
    } else {
      m.setLayoutProperty(WIND_LAYER_ID, 'visibility', 'visible');
    }
  }, []);

  const disableWind = useCallback(() => {
    const m = map.current;
    if (!m) return;

    if (m.getLayer(WIND_LAYER_ID)) {
      m.setLayoutProperty(WIND_LAYER_ID, 'visibility', 'none');
    }
  }, []);

  // React to mapReady + terrainOn changes
  useEffect(() => {
    if (!mapReady) return;
    if (terrainOn) {
      enableTerrain();
    } else {
      disableTerrain();
    }
  }, [mapReady, terrainOn, enableTerrain, disableTerrain]);

  // React to mapReady + windOn changes
  useEffect(() => {
    if (!mapReady) return;
    if (windOn && isSafe) {
      enableWind();
    } else {
      disableWind();
    }
  }, [mapReady, windOn, isSafe, enableWind, disableWind]);

  // Effect to update settings when quality changes
  useEffect(() => {
    if (mapReady && windOn && isSafe) {
      updateWindSettings(windQuality);
    }
  }, [windQuality, mapReady, windOn, isSafe, updateWindSettings]);

  // Performance loop
  useEffect(() => {
    if (!mapReady || !windOn || !isSafe) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const startTime = performance.now();
    const loop = () => {
      const now = performance.now();

      // Warm up period (ignore first 2 seconds of heavy initialization)
      if (now - startTime < 2000) {
        lastFrameTime.current = now;
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const dt = now - lastCheckRef.current;

      // Safety check: frame gap too long? (indicates lag or stall)
      const frameGap = now - (lastFrameTime.current || now);
      lastFrameTime.current = now;

      if (frameGap > 200) {
        setIsSafe(false);
        return;
      }

      framesRef.current++;

      if (dt > 2000) {
        const fps = (framesRef.current * 1000) / dt;

        // Auto-downgrade
        if (fps < 25 && windQuality !== 'Low' && !isInteracting.current) {
          // Determine next lower quality
          setWindQuality(prev => {
            const next = prev === 'High' ? 'Medium' : 'Low';
            setIsAutoDowngraded(true);
            return next;
          });
        }

        // Reset
        framesRef.current = 0;
        lastCheckRef.current = now;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mapReady, windOn, isSafe, windQuality]);

  // Interaction handlers
  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;

    const startInteraction = () => {
      isInteracting.current = true;
      if (windOn && isSafe) updateWindSettings(windQuality, 1); // Hide particles (min 1)
    };

    const endInteraction = () => {
      isInteracting.current = false;
      if (windOn && isSafe) updateWindSettings(windQuality); // Restore particles
    };

    m.on('movestart', startInteraction);
    m.on('moveend', endInteraction);

    return () => {
      m.off('movestart', startInteraction);
      m.off('moveend', endInteraction);
    };
  }, [mapReady, windOn, isSafe, windQuality, updateWindSettings]);


  const handleToggle = () => setTerrainOn((prev) => !prev);
  const handleWindToggle = () => {
    setWindOn((prev) => !prev);
    if (!isSafe) setIsSafe(true); // Reset safety on toggle attempt
  };

  const handleZoomToRoute = useCallback(() => {
    const m = map.current;
    if (!m) return;

    const coords = (sampleRoute as GeoJSON.FeatureCollection).features
      .filter((f) => f.geometry.type === 'LineString')
      .flatMap((f) => (f.geometry as GeoJSON.LineString).coordinates as [number, number][]);

    if (coords.length === 0) return;

    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );

    m.fitBounds(bounds, { padding: 40 });
  }, []);

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'red' }}>
        <h1>Error: {error}</h1>
      </div>
    );
  }

  return (
    <>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Controls panel */}
      <div
        style={{
          position: 'absolute',
          top: '16px',
          left: '16px',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          fontFamily: "'Inter', sans-serif",
        }}
      >
        {/* Terrain toggle */}
        <div
          style={{
            background: 'rgba(15, 15, 25, 0.82)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '12px',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onClick={handleToggle}
          title={terrainOn ? 'Click to disable 3D terrain' : 'Click to enable 3D terrain'}
        >
          {/* Mountain icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={terrainOn ? '#34d399' : '#94a3b8'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="3 20 9 4 15 14 19 9 23 20 3 20" />
          </svg>

          <span style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 600, letterSpacing: '0.02em' }}>
            Terrain
          </span>

          {/* Toggle pill */}
          <div
            style={{
              width: '38px',
              height: '20px',
              borderRadius: '10px',
              background: terrainOn ? '#10b981' : '#334155',
              position: 'relative',
              transition: 'background 0.25s ease',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: '2px',
                left: terrainOn ? '20px' : '2px',
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.25s ease',
                boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
              }}
            />
          </div>

          <span style={{ color: terrainOn ? '#34d399' : '#64748b', fontSize: '12px', fontWeight: 500, minWidth: '20px' }}>
            {terrainOn ? 'On' : 'Off'}
          </span>
        </div>

        {/* Wind toggle */}
        <div
          style={{
            background: 'rgba(15, 15, 25, 0.82)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '12px',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onClick={handleWindToggle}
          title={windOn ? 'Click to disable wind particles' : 'Click to enable wind particles'}
        >
          {/* Wind icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={windOn ? '#60a5fa' : '#94a3b8'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" />
          </svg>

          <span style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 600, letterSpacing: '0.02em' }}>
            Wind
          </span>

          {/* Toggle pill */}
          <div
            style={{
              width: '38px',
              height: '20px',
              borderRadius: '10px',
              background: windOn ? '#3b82f6' : '#334155',
              position: 'relative',
              transition: 'background 0.25s ease',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: '2px',
                left: windOn ? '20px' : '2px',
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.25s ease',
                boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
              }}
            />
          </div>

          <span style={{ color: windOn ? '#60a5fa' : '#64748b', fontSize: '12px', fontWeight: 500, minWidth: '20px' }}>
            {windOn ? 'On' : 'Off'}
          </span>
        </div>

        {/* Wind Quality Selector */}
        {windOn && isSafe && (
          <div style={{
            background: 'rgba(15, 15, 25, 0.82)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '12px',
            padding: '6px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            userSelect: 'none',
          }}>
            <label style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>
              Quality {isAutoDowngraded && <span style={{ color: '#eab308' }}>(Auto)</span>}
            </label>
            <select
              value={windQuality}
              onChange={(e) => {
                setWindQuality(e.target.value as WindQuality);
                setIsAutoDowngraded(false); // Reset auto flag on manual change
              }}
              style={{
                background: 'transparent',
                color: '#e2e8f0',
                border: 'none',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
                outline: 'none',
                paddingRight: '4px'
              }}
            >
              <option value="Low" style={{ color: 'black' }}>Low</option>
              <option value="Medium" style={{ color: 'black' }}>Medium</option>
              <option value="High" style={{ color: 'black' }}>High</option>
            </select>
          </div>
        )}

        {/* Safety Toast */}
        {!isSafe && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.9)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '8px',
            fontSize: '12px',
            fontWeight: 600,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            Wind animation disabled for performance
          </div>
        )}

        {/* Zoom to Route button */}
        <button
          id="zoom-to-route"
          onClick={handleZoomToRoute}
          style={{
            background: 'rgba(15, 15, 25, 0.82)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(249,115,22,0.45)',
            borderRadius: '12px',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            cursor: 'pointer',
            color: '#f97316',
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.02em',
            fontFamily: "'Inter', sans-serif",
            transition: 'border-color 0.2s, background 0.2s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(249,115,22,0.15)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(15, 15, 25, 0.82)';
          }}
        >
          {/* Route icon */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h18M3 12l4-4M3 12l4 4" />
          </svg>
          Zoom to Route
        </button>
      </div>

      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          bottom: '24px',
          right: '24px',
          zIndex: 10,
          background: 'rgba(15, 15, 25, 0.9)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '12px',
          padding: '16px',
          fontFamily: "'Inter', sans-serif",
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          color: '#e2e8f0',
          minWidth: '200px',
        }}
      >
        <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 }}>Route Difficulty</h4>

        {/* Gradient Bar */}
        <div
          style={{
            height: '12px',
            width: '100%',
            borderRadius: '6px',
            background: 'linear-gradient(to right, #22c55e, #eab308, #ef4444)',
            marginBottom: '8px',
          }}
        />

        {/* Labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>
          <span>Easy</span>
          <span>Moderate</span>
          <span>Brutal</span>
        </div>
      </div>
    </>
  );
}

export default App;
