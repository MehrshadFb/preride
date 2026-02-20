import { useEffect, useState } from 'react';

export interface HourlyWindEntry {
  time: string;
  speed_kmh: number;
  direction_deg: number;
}

interface WindDataState {
  hourlyData: HourlyWindEntry[] | null;
  loading: boolean;
  error: string | null;
}

// ── Module-level cache (1 fetch per location per page-load session) ───────────
const cache = new Map<string, HourlyWindEntry[]>();
// De-duplicate concurrent fetches for the same key
const inflight = new Map<string, Promise<HourlyWindEntry[]>>();

function cacheKey(lat: number, lon: number, date: string): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)},${date}`;
}

function buildUrl(lat: number, lon: number, date: string): string {
  const url = (
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=windspeed_10m,winddirection_10m` +
    `&start_date=${date}&end_date=${date}` +
    `&timezone=auto&wind_speed_unit=kmh`
  );
  console.log(`[WindFetch] URL: ${url}`);
  return url;
}

// ── Core fetch (exported for use by useMultiPointWindData) ────────────────────
/** Fetch + cache a single lat/lon. Concurrent calls with the same key share one request. */
export async function fetchWindForPoint(lat: number, lon: number, date: string): Promise<HourlyWindEntry[]> {
  const key = cacheKey(lat, lon, date);
  if (cache.has(key)) {
    console.log(`[WindFetch] Cache HIT for key: ${key}`);
    return cache.get(key)!;
  }
  if (inflight.has(key)) {
    console.log(`[WindFetch] In-flight JOIN for key: ${key}`);
    return inflight.get(key)!;
  }

  console.log(`[WindFetch] Fetching NEW for key: ${key}`);

  const p = fetch(buildUrl(lat, lon, date))
    .then((r) => {
      if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
      return r.json();
    })
    .then((json) => {
      const times: string[] = json.hourly.time;
      const speeds: number[] = json.hourly.windspeed_10m;
      const dirs: number[] = json.hourly.winddirection_10m;

      console.log(`[WindInfo] Response for ${date}: ${times.length} intervals. Range: ${times[0]} to ${times[times.length - 1]}`);


      const entries: HourlyWindEntry[] = times.map((t, i) => ({
        time: t,
        speed_kmh: Math.round(speeds[i] * 10) / 10,
        direction_deg: Math.round(dirs[i]),
      }));

      // If API returns empty (e.g. far future/past), return empty array
      if (entries.length === 0) {
        throw new Error('No wind data available for this date');
      }

      cache.set(key, entries);
      inflight.delete(key);
      return entries;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });

  inflight.set(key, p);
  return p;
}

// ── Single-point hook (used for WindInfoPanel display) ────────────────────────
export function useWindData(lat: number, lon: number, date: string): WindDataState {
  const [state, setState] = useState<WindDataState>(() => {
    const cached = cache.get(cacheKey(lat, lon, date));
    return cached
      ? { hourlyData: cached, loading: false, error: null }
      : { hourlyData: null, loading: true, error: null };
  });

  useEffect(() => {
    let cancelled = false;
    setState(prev => prev.loading ? prev : { ...prev, loading: true, error: null });

    fetchWindForPoint(lat, lon, date)
      .then((data) => {
        if (!cancelled) setState({ hourlyData: data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ hourlyData: null, loading: false, error: String(err) });
      });
    return () => { cancelled = true; };
  }, [lat, lon, date]);

  return state;
}

// ── Helper: Concurrency-limited mapper ────────────────────────────────────────
async function pooledMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        // We can't easily return null here if R doesn't include it, 
        // but the caller of useMultiPointWindData expects (HourlyWindEntry[] | null).
        // So we'll let the error bubble or handle it in the fn wrapper.
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Multi-point hook: N points fetched in parallel, cached individually ───────
export function useMultiPointWindData(points: { lat: number; lon: number }[], date: string): {
  allData: (HourlyWindEntry[] | null)[];
  loading: boolean;
  error: string | null;
} {
  const [allData, setAllData] = useState<(HourlyWindEntry[] | null)[]>(
    () => points.map(({ lat, lon }) => cache.get(cacheKey(lat, lon, date)) ?? null),
  );

  // Check if any points are missing from cache for this date
  const needsFetch = points.some(({ lat, lon }) => !cache.has(cacheKey(lat, lon, date)));
  const [loading, setLoading] = useState(needsFetch);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // When points or date change, rebuild allData from cache first
    const fromCache = points.map(({ lat, lon }) => cache.get(cacheKey(lat, lon, date)) ?? null);
    const anyMissing = fromCache.some((d) => d === null);

    if (!anyMissing) {
      setAllData(fromCache);
      setLoading(false);
      setError(null);
      return;
    }

    setAllData(fromCache); // show whatever is cached immediately
    setLoading(true);
    setError(null);

    let cancelled = false;

    // Use pooledMap with concurrency limit of 3 to avoid Open-Meteo 429 errors
    // The wrapper handles errors by returning null for failed points
    const fetchSafe = (p: { lat: number; lon: number }) =>
      fetchWindForPoint(p.lat, p.lon, date).catch((err) => {
        console.warn(`Failed to fetch wind for ${p.lat},${p.lon}:`, err);
        return null;
      });

    pooledMap(points, fetchSafe, 3)
      .then((results) => {
        if (!cancelled) {
          // @ts-ignore - results includes nulls from catch, which matches our state type
          setAllData(results);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) { setError(String(err)); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [points, date]); // trigger fetch when date changes

  return { allData, loading, error };
}
