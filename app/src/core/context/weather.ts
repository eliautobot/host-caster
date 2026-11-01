// Weather from Open-Meteo (no key) + its geocoding search; device location via the Geolocation API.
import type { GeoPlace, Units, WeatherSnapshot } from '../types';
import { cached } from './cache';

const WMO: Record<number, string> = {
  0: 'clear skies',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'foggy',
  48: 'foggy with frost',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'rain showers',
  81: 'rain showers',
  82: 'heavy rain showers',
  85: 'snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with hail',
};

export function weatherCondition(code: number): string {
  return WMO[code] ?? 'mixed weather';
}

interface ForecastResponse {
  current?: { temperature_2m: number; apparent_temperature: number; weather_code: number };
  daily?: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
}

export function parseForecast(place: string, units: Units, res: ForecastResponse, fetchedAt: number): WeatherSnapshot {
  if (!res.current) throw new Error('No current weather in the response');
  const r = Math.round;
  return {
    place,
    temperature: r(res.current.temperature_2m),
    feelsLike: r(res.current.apparent_temperature),
    condition: weatherCondition(res.current.weather_code),
    high: res.daily?.temperature_2m_max[0] !== undefined ? r(res.daily.temperature_2m_max[0]) : undefined,
    low: res.daily?.temperature_2m_min[0] !== undefined ? r(res.daily.temperature_2m_min[0]) : undefined,
    precipitationChance: res.daily?.precipitation_probability_max[0] ?? undefined,
    units,
    fetchedAt,
  };
}

export async function fetchWeather(place: GeoPlace, units: Units): Promise<WeatherSnapshot> {
  const q = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    current: 'temperature_2m,apparent_temperature,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '1',
  });
  if (units === 'imperial') q.set('temperature_unit', 'fahrenheit');
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Weather service answered ${res.status}`);
  return parseForecast(place.name, units, (await res.json()) as ForecastResponse, Date.now());
}

/** The kv cache key of a place's weather. */
export const weatherKey = (place: GeoPlace, units: Units) => `weather:${place.lat.toFixed(2)},${place.lon.toFixed(2)}:${units}`;

/** Weather for the listener's place, cached 20 min, last snapshot when offline. */
export async function getWeather(place: GeoPlace, units: Units): Promise<WeatherSnapshot | undefined> {
  const c = await cached(weatherKey(place, units), 20 * 60_000, () => fetchWeather(place, units));
  // an old snapshot is still useful for a few hours ("it was raining earlier"), not for days
  if (!c.value || Date.now() - c.value.fetchedAt > 6 * 3600_000) return undefined;
  return c.value;
}

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
  country_code?: string;
}

/** City search for the About me page. */
export async function searchPlaces(query: string, lang = 'en'): Promise<(GeoPlace & { detail: string })[]> {
  if (query.trim().length < 2) return [];
  const q = new URLSearchParams({ name: query.trim(), count: '6', language: lang, format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${q}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Place search answered ${res.status}`);
  const j = (await res.json()) as { results?: GeoResult[] };
  return (j.results ?? []).map((r) => ({
    name: r.name,
    lat: r.latitude,
    lon: r.longitude,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
  }));
}

/** Device location -> a named place (reverse geocoding by BigDataCloud's free client endpoint). */
export async function locateMe(): Promise<GeoPlace> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) throw new Error('Location is not available here');
  const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(e.code === 1 ? 'Location access was blocked' : 'Could not find your location')), {
      maximumAge: 30 * 60_000,
      timeout: 15_000,
      enableHighAccuracy: false,
    }),
  );
  const lat = Math.round(pos.coords.latitude * 1000) / 1000;
  const lon = Math.round(pos.coords.longitude * 1000) / 1000;
  let name = '';
  try {
    const q = new URLSearchParams({ latitude: String(lat), longitude: String(lon), localityLanguage: 'en' });
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?${q}`, { signal: AbortSignal.timeout(8000) });
    const j = (await res.json()) as { city?: string; locality?: string; principalSubdivision?: string };
    name = j.city || j.locality || j.principalSubdivision || '';
  } catch {
    // keep coordinates only
  }
  return { name, lat, lon };
}
