import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

export const LOCATION_TASK_NAME = 'fruitmaster-background-location';
const employeeAppUrl = process.env.EXPO_PUBLIC_EMPLOYEE_APP_URL || 'https://myhr-cloudflare-rebuild.fruitmaster-myhr.workers.dev/?native=1';
const backendUrl = employeeAppUrl.split('/?')[0].replace(/\/$/, '');
const CLOUDFLARE_MODE = String(process.env.EXPO_PUBLIC_BACKEND_MODE || '').toLowerCase() === 'cloudflare' || /workers\.dev/i.test(employeeAppUrl);
const PENDING_LOCATION_KEY = 'fruitmaster.pending-location-pings.v1';
const LOCATION_STATUS_KEY = 'fruitmaster.location-status.v1';
const CLOUDFLARE_ACCESS_TOKEN_KEY = 'fruitmaster.cloudflare-access-token.v1';

export async function setNativeAccessToken(token) {
  try {
    if (token) await AsyncStorage.setItem(CLOUDFLARE_ACCESS_TOKEN_KEY, String(token));
    else await AsyncStorage.removeItem(CLOUDFLARE_ACCESS_TOKEN_KEY);
  } catch (_) { }
}

async function getNativeAccessToken() {
  try { return await AsyncStorage.getItem(CLOUDFLARE_ACCESS_TOKEN_KEY); } catch (_) { return null; }
}

async function readPending() {
  try {
    const value = await AsyncStorage.getItem(PENDING_LOCATION_KEY);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.slice(-24) : [];
  } catch (_) {
    return [];
  }
}

async function savePending(rows) {
  try {
    if (rows.length) await AsyncStorage.setItem(PENDING_LOCATION_KEY, JSON.stringify(rows.slice(-24)));
    else await AsyncStorage.removeItem(PENDING_LOCATION_KEY);
  } catch (_) {
    // Storage is best-effort; the next GPS event can still retry the API.
  }
}

async function saveLocationStatus(status) {
  try {
    await AsyncStorage.setItem(LOCATION_STATUS_KEY, JSON.stringify({ ...status, at: new Date().toISOString() }));
  } catch (_) {
    // Status is diagnostic only; a storage failure must not stop tracking.
  }
}

export async function getLocationStatus() {
  try {
    const value = await AsyncStorage.getItem(LOCATION_STATUS_KEY);
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

async function postWithTimeout(url, options, timeoutMs = 12000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, { ...options, ...(controller ? { signal: controller.signal } : {}) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sendPing(payload, accessToken) {
  let apiError = null;
  try {
    const response = await postWithTimeout(`${backendUrl}/api/native-location-ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload)
    });
    if (response.ok) return true;
    const body = await response.text().catch(() => '');
    if (response.status === 409) {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (_) { parsed = null; }
      if (parsed && parsed.inactive) {
      const inactiveError = new Error(parsed.error || 'Live location is inactive.');
        inactiveError.code = 'attendance-inactive';
        throw inactiveError;
      }
    }
    apiError = new Error(`Native location service returned ${response.status}${body ? `: ${body.slice(0, 240)}` : ''}`);
  } catch (requestError) {
    if (requestError && requestError.code === 'attendance-inactive') throw requestError;
    apiError = requestError;
  }

  console.warn('Background location ping failed:', apiError?.message || 'Location service unavailable');
  return false;
}

async function currentPosition() {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('GPS did not respond within 15 seconds. Turn on precise location and try again.')), 15000));
  return Promise.race([
    Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      maximumAge: 0,
      mayShowUserSettingsDialog: true
    }),
    timeout
  ]);
}

// Send one reading as soon as tracking is enabled. Android may wait for the
// first time/distance interval before invoking the background task, which made
// the employer see “no location” even though the service was running.
export async function sendCurrentLocationPing(accessToken) {
  try {
    const position = await currentPosition();
    const coords = position && position.coords;
    if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      throw new Error('The phone returned an invalid GPS reading.');
    }
    const payload = {
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: Number.isFinite(coords.accuracy) ? Math.min(500, Math.max(0, coords.accuracy)) : 500,
      source: 'managed-mobile'
    };
    const sent = await sendPing(payload, accessToken);
    if (!sent) throw new Error('GPS was read, but the location could not be saved for the employer.');
    await saveLocationStatus({ state: 'sent', latitude: payload.latitude, longitude: payload.longitude, accuracy: payload.accuracy });
    return payload;
  } catch (error) {
    if (error && error.code === 'attendance-inactive') {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => {});
      await savePending([]);
      await saveLocationStatus({ state: 'inactive', error: error.message || 'Live location is inactive.' });
      return { inactive: true };
    }
    await saveLocationStatus({ state: 'error', error: error && error.message || 'Location ping failed' });
    throw error;
  }
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn('Background location task failed:', error.message || error);
    return;
  }
  const locations = data?.locations || [];
  let accessToken = null;
  if (CLOUDFLARE_MODE) accessToken = await getNativeAccessToken();
  else {
    const { data: sessionResult, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionResult?.session) {
      await saveLocationStatus({ state: 'error', error: 'The signed-in employee session is unavailable.' });
      return;
    }
    let session = sessionResult.session;
    if (session.expires_at && session.expires_at * 1000 < Date.now() + 120000) {
      const refreshed = await supabase.auth.refreshSession().catch(() => null);
      if (!refreshed?.data?.session) {
        await saveLocationStatus({ state: 'error', error: 'The employee session expired before the location could be sent.' });
        return;
      }
      session = refreshed.data.session;
    }
    accessToken = session.access_token;
  }
  if (!accessToken) {
    await saveLocationStatus({ state: 'error', error: 'The signed-in employee session is unavailable.' });
    return;
  }
  const queued = await readPending();
  const current = locations.map((location) => location && location.coords).filter(Boolean).map((coords) => ({
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? Math.min(500, Math.max(0, coords.accuracy)) : 500,
    source: 'managed-mobile'
  }));
  const pending = [...queued, ...current].filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  const remaining = [];
  for (const payload of pending.slice(-24)) {
    try {
      if (!(await sendPing(payload, accessToken))) remaining.push(payload);
    } catch (pingError) {
      if (pingError && pingError.code === 'attendance-inactive') {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => {});
        await savePending([]);
        await saveLocationStatus({ state: 'inactive', error: pingError.message });
        return;
      }
      remaining.push(payload);
    }
  }
  await savePending(remaining);
  if (remaining.length === 0 && pending.length > 0) {
    const last = pending[pending.length - 1];
    await saveLocationStatus({ state: 'sent', latitude: last.latitude, longitude: last.longitude, accuracy: last.accuracy });
  } else if (remaining.length > 0) {
    await saveLocationStatus({ state: 'error', error: 'The location service is temporarily unavailable; the reading is queued for retry.' });
  }
});
