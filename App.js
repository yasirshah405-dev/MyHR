import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Image, Linking, PermissionsAndroid, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { WebView } from 'react-native-webview';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from './src/supabase';

const employeeAppUrl = process.env.EXPO_PUBLIC_EMPLOYEE_APP_URL || 'https://myhr-cloudflare-rebuild.fruitmaster-myhr.workers.dev/?native=1';
const backendUrl = employeeAppUrl.split('/?')[0].replace(/\/$/, '');
const CLOUDFLARE_MODE = String(process.env.EXPO_PUBLIC_BACKEND_MODE || '').toLowerCase() === 'cloudflare' || /workers\.dev/i.test(employeeAppUrl);
const LOCATION_CHANNEL_ID = 'com.fruitmaster.employee:fruitmaster-background-location-v2';
const APP_VERSION = '1.0.36';
const APK_URL = 'https://github.com/yasirshah405-dev/MyHR/releases/latest/download/my-hr.apk';

// Load optional native modules only after the WebView has rendered. This keeps
// a stale/partially installed native module from crashing the app at launch;
// permissions and background services still load when they are needed.
let LocationModule;
let NotificationsModule;
let DeviceModule;
let FileSystemModule;
let SharingModule;
let LocationTaskModule;
let ApplicationModule;
let notificationPermissionRequest;
function getLocation() { return LocationModule || (LocationModule = require('expo-location')); }
function getNotifications() { return NotificationsModule || (NotificationsModule = require('expo-notifications')); }
function getDevice() { return DeviceModule || (DeviceModule = require('expo-device')); }
function getFileSystem() { return FileSystemModule || (FileSystemModule = require('expo-file-system/legacy')); }
function getSharing() { return SharingModule || (SharingModule = require('expo-sharing')); }
function getLocationTask() { return LocationTaskModule || (LocationTaskModule = require('./src/locationTask')); }
function getApplication() { return ApplicationModule || (ApplicationModule = require('expo-application')); }

function requestNativeNotificationPermission() {
  if (notificationPermissionRequest) return notificationPermissionRequest;
  notificationPermissionRequest = (async () => {
  const Notifications = getNotifications();
  const Device = getDevice();
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true })
  });
  if (!Device.isDevice) throw new Error('Push notifications require a physical Android or iPhone device.');
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('attendance', {
      name: 'Attendance reminders', importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250], lightColor: '#f28a00', sound: 'default'
    });
  }
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    // Request Android 13+ notification permission through the platform
    // permission API so the system Allow / Don't allow dialog opens directly
    // on the app screen. Expo's notification wrapper is retained for iOS and
    // older Android versions.
    if (Platform.OS === 'android' && Platform.Version >= 33 && PermissionsAndroid?.PERMISSIONS?.POST_NOTIFICATIONS) {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      status = result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
    } else {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
  }
  if (status !== 'granted') {
    const error = new Error('Allow notifications in phone Settings so employer reminders can reach this phone.');
    error.code = 'notifications-permission';
    throw error;
  }
  return Notifications;
  })().catch((error) => {
    notificationPermissionRequest = null;
    throw error;
  });
  return notificationPermissionRequest;
}

async function registerNativePush(accessToken) {
  const Notifications = await requestNativeNotificationPermission();
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) throw new Error('The native notification project is not configured yet.');
  let tokenResult;
  try {
    tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
  } catch (error) {
    if (/FirebaseApp|FCM|google-services/i.test(String(error && error.message || error))) {
      throw permissionError('Android push notifications are not configured in this build. HR must add the Firebase Android configuration and rebuild the app.', 'firebase-config');
    }
    throw error;
  }
  const token = tokenResult && tokenResult.data;
  if (!token) throw new Error('Could not create a native notification token.');
  const response = await fetch(`${backendUrl}/api/native-push-register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ expoPushToken: token, platform: Platform.OS })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Could not register native notifications.');
  return token;
}

function permissionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function ensureLocationPermissions() {
  // Android only presents one runtime permission dialog at a time. Always
  // finish the notification dialog first so it cannot be skipped when the
  // WebView immediately asks for location.
  try { await requestNativeNotificationPermission(); } catch (_) { }
  const Location = getLocation();
  if (Platform.OS === 'android' && !(await Location.hasServicesEnabledAsync())) {
    throw permissionError('Turn on Location Services, then tap Retry live location.', 'location-services');
  }
  let foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== 'granted') foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') {
    throw permissionError('Allow location while using the app so attendance and live location can work.', 'location-permission');
  }
  let background = await Location.getBackgroundPermissionsAsync();
  if (background.status !== 'granted') {
    // Android 11+ opens the system permission screen for “Allow all the time”.
    // Request this only after foreground permission has been granted; Android
    // will otherwise silently refuse the request.
    background = await Location.requestBackgroundPermissionsAsync();
  }
  if (background.status !== 'granted') {
    throw permissionError('Allow “all the time” location in phone Settings so your employer can receive live location when the app is closed.', 'background-location-permission');
  }
}

async function startBackgroundTracking(accessToken) {
  const Location = getLocation();
  const Notifications = getNotifications();
  const { LOCATION_TASK_NAME, sendCurrentLocationPing } = getLocationTask();
  await ensureLocationPermissions();
  if (Platform.OS === 'android') {
    // Android requires a foreground-service notification for continuous
    // background location, but the channel can be made fully silent/hidden.
    // Delete the previous channel first so devices that already created the
    // old MIN channel pick up the hidden setting after this update.
    try { await Notifications.deleteNotificationChannelAsync(LOCATION_CHANNEL_ID); } catch (_) { }
    await Notifications.setNotificationChannelAsync(LOCATION_CHANNEL_ID, {
      name: 'Background service',
      importance: Notifications.AndroidImportance.NONE,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.SECRET,
      showBadge: false,
      sound: null,
      vibrationPattern: [],
      enableVibrate: false,
      enableLights: false,
      lightColor: '#f28a00'
    });
  }
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (!running) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 60000,
      distanceInterval: 50,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.AutomotiveNavigation,
      foregroundService: {
        notificationTitle: ' ',
        notificationBody: ' ',
        notificationColor: '#f28a00'
      }
    });
  }
  // Do not wait for Android's first time/distance callback. Send a reading
  // immediately so the employer can verify the employee link and see a
  // location as soon as tracking is enabled.
  let immediatePingError = null;
  let inactive = false;
  try {
    const result = await sendCurrentLocationPing(accessToken);
    inactive = Boolean(result && result.inactive);
  } catch (error) {
    immediatePingError = error;
  }
  return { immediatePingError, inactive };
}

async function stopBackgroundTracking() {
  const Location = getLocation();
  const { LOCATION_TASK_NAME } = getLocationTask();
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [tracking, setTracking] = useState(false);
  const [message, setMessage] = useState('');
  const [permissionIssue, setPermissionIssue] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const webViewRef = useRef(null);
  const overlayOpenRef = useRef('');
  const trackingStartedFor = useRef('');
  const nativeLocationActiveRef = useRef(false);
  const nativeSessionRef = useRef(null);
  const webViewLoadingTimerRef = useRef(null);

  const handleWebViewLoadStart = useCallback(() => {
    setLoading(true);
    if (webViewLoadingTimerRef.current) clearTimeout(webViewLoadingTimerRef.current);
    // Never leave the native splash over a usable WebView indefinitely when a
    // service worker or a slow network prevents onLoadEnd from firing.
    webViewLoadingTimerRef.current = setTimeout(() => setLoading(false), 12000);
  }, []);

  const handleWebViewLoadEnd = useCallback(() => {
    if (webViewLoadingTimerRef.current) clearTimeout(webViewLoadingTimerRef.current);
    webViewLoadingTimerRef.current = null;
    setLoading(false);
  }, []);

  const handleWebViewError = useCallback(() => {
    if (webViewLoadingTimerRef.current) clearTimeout(webViewLoadingTimerRef.current);
    webViewLoadingTimerRef.current = null;
    setLoading(false);
  }, []);

  const checkForUpdate = useCallback(async () => {
    try {
      let currentVersion = APP_VERSION;
      try {
        currentVersion = getApplication().nativeApplicationVersion || Constants.expoConfig?.version || APP_VERSION;
      } catch (_) {
        // Keep the fallback for older binaries where the optional module is unavailable.
      }
      const response = await fetch(`${backendUrl}/api/mobile-version?current=${encodeURIComponent(currentVersion)}`, { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (result && result.updateAvailable) setUpdateInfo(result);
    } catch (_) {
      // An update check must never block login or location tracking.
    }
  }, []);

  const enableTracking = useCallback(async (userId, accessToken) => {
    const Location = getLocation();
    const { LOCATION_TASK_NAME, sendCurrentLocationPing } = getLocationTask();
    const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
    if (trackingStartedFor.current === userId && alreadyRunning) {
      try {
        const result = await sendCurrentLocationPing(accessToken);
        if (result && result.inactive) {
          trackingStartedFor.current = '';
          await stopBackgroundTracking();
          setTracking(false);
          setPermissionIssue(null);
          setMessage('Live location is active continuously while you are signed in.');
          return;
        }
        setPermissionIssue(null);
        setMessage('Live location is active and the latest location was sent to your employer.');
      } catch (error) {
        setMessage(error.message || 'Live location could not be saved for your employer.');
      }
      setTracking(true);
      return;
    }
    trackingStartedFor.current = userId;
    try {
      const result = await startBackgroundTracking(accessToken);
      if (result && result.inactive) {
        trackingStartedFor.current = '';
        setTracking(false);
        setPermissionIssue(null);
        setMessage('Live location is active continuously while you are signed in.');
        return;
      }
      setTracking(true);
      if (result && result.immediatePingError) {
        setMessage(result.immediatePingError.message || 'Live location could not be saved for your employer.');
      } else {
        setPermissionIssue(null);
        setMessage('Live location is active and the latest location was sent to your employer.');
      }
    } catch (error) {
      trackingStartedFor.current = '';
      setMessage(error.message || 'Location permission could not be enabled.');
    }
  }, []);

  const restoreNativeServices = useCallback(async () => {
    try {
      if (CLOUDFLARE_MODE) {
        // The WebView sends the Cloudflare access token after restoring its
        // session. Native registration is completed from that bridge event.
        return;
      }
      const sessionResult = await supabase.auth.getSession();
      const session = sessionResult && sessionResult.data && sessionResult.data.session;
      if (!session || !session.access_token) return;
      nativeSessionRef.current = session;
      // Register push notifications in the background when a signed-in
      // employee opens the native app. Permission failures are intentionally
      // non-blocking; the More screen can request permission again later.
      try { await registerNativePush(session.access_token); } catch (_) { }
      // Location failures remain non-blocking while the signed-in WebView
      // restores its session; location is enabled only for an active session.
      setTracking(false);
    } catch (_) {
      // The WebView will send the session again after sign-in if native storage
      // has not finished restoring yet.
    }
  }, [enableTracking]);

  const retryNativeSetup = useCallback(async () => {
    const session = nativeSessionRef.current;
    if (!session) return;
    try {
      await registerNativePush(session.access_token);
      if (nativeLocationActiveRef.current) await enableTracking(session.user && session.user.id || 'signed-in-user', session.access_token);
      else { await stopBackgroundTracking(); setTracking(false); }
      setPermissionIssue(null);
      setMessage(nativeLocationActiveRef.current ? 'Notifications and live location are active.' : 'Notifications are active. Live location starts after employee sign-in.');
    } catch (error) {
      setPermissionIssue({ kind: error.code === 'notifications-permission' ? 'notifications' : 'location', code: error.code || 'setup', text: error.message || 'Permission could not be enabled.' });
      setMessage(error.message || 'Permission could not be enabled.');
    }
  }, [enableTracking]);

  const handleMessage = useCallback(async (event) => {
    let messageData;
    try { messageData = JSON.parse(event.nativeEvent.data); } catch (_) { return; }
    if (messageData.type === 'download-payslip') {
      try {
        const FileSystem = getFileSystem();
        const filename = String(messageData.filename || 'payslip.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
        const base64Encoding = (FileSystem.EncodingType && FileSystem.EncodingType.Base64) || 'base64';
        const payload = String(messageData.data || '');
        if (!payload) throw new Error('The payslip file was empty. Please try again.');

        // Save directly into the Android Downloads folder. This avoids the
        // private-cache share activity that caused force-closes on devices
        // without a compatible PDF viewer. Android asks the user to grant
        // Downloads access the first time, then the file is a normal PDF that
        // can be opened from Files/Downloads.
        const storage = FileSystem.StorageAccessFramework;
        if (Platform.OS === 'android' && storage) {
          const rootUri = storage.getUriForDirectoryInRoot('Download');
          const permission = await storage.requestDirectoryPermissionsAsync(rootUri);
          if (!permission || !permission.granted) throw new Error('Choose the Downloads folder to save the payslip.');
          let savedUri;
          try {
            savedUri = await storage.createFileAsync(permission.directoryUri, filename, 'application/pdf');
          } catch (_) {
            const suffix = `-${Date.now()}`;
            savedUri = await storage.createFileAsync(permission.directoryUri, filename.replace(/\.pdf$/i, `${suffix}.pdf`), 'application/pdf');
          }
          await FileSystem.writeAsStringAsync(savedUri, payload, { encoding: base64Encoding });
          setMessage('Payslip downloaded to the Downloads folder.');
          return;
        }

        const directory = FileSystem.documentDirectory || FileSystem.cacheDirectory;
        if (!directory) throw new Error('Device storage is unavailable.');
        const target = `${directory}${filename}`;
        await FileSystem.writeAsStringAsync(target, payload, { encoding: base64Encoding });
        setMessage('Payslip PDF saved on this device.');
      } catch (error) {
        setMessage(error.message || 'Payslip PDF could not be downloaded.');
      }
      return;
    }
    if (messageData.type === 'native-notification-request') {
      const session = nativeSessionRef.current;
      if (!session || !session.access_token) {
        setPermissionIssue({ kind: 'notifications', code: 'notifications-session', text: 'Sign in again so this app can enable Android notifications.' });
        return;
      }
      try {
        await registerNativePush(session.access_token);
        setPermissionIssue(null);
        setMessage('Notifications are active.');
      } catch (error) {
        setPermissionIssue({ kind: 'notifications', code: error.code || 'notifications', text: error.message || 'Notifications could not be enabled.' });
        setMessage(error.message || 'Notifications could not be enabled.');
      }
      return;
    }
    if (messageData.type === 'native-overlay-state') {
      overlayOpenRef.current = messageData.open ? String(messageData.overlay || '') : '';
      return;
    }
    if (messageData.type === 'native-location-state') {
      nativeLocationActiveRef.current = !!messageData.active;
      let session = nativeSessionRef.current;
      if (!session || !session.access_token) {
        const sessionResult = await supabase.auth.getSession();
        session = sessionResult && sessionResult.data && sessionResult.data.session;
        if (session) nativeSessionRef.current = session;
      }
      if (!session || !session.access_token) return;
      if (messageData.active) {
        await enableTracking(session.user && session.user.id || 'signed-in-user', session.access_token);
      } else {
        trackingStartedFor.current = '';
        await stopBackgroundTracking();
        setTracking(false);
        setMessage('Live location is off until the employee signs in.');
      }
      return;
    }
    if (messageData.type === 'supabase-signed-out') {
      nativeLocationActiveRef.current = false;
      trackingStartedFor.current = '';
      await stopBackgroundTracking();
      await supabase.auth.signOut();
      setTracking(false);
      setMessage('');
      return;
    }
    if (messageData.type === 'cloudflare-signed-out') {
      nativeLocationActiveRef.current = false;
      trackingStartedFor.current = '';
      await stopBackgroundTracking();
      try { await getLocationTask().setNativeAccessToken(null); } catch (_) { }
      nativeSessionRef.current = null;
      setTracking(false);
      setMessage('');
      return;
    }
    if (messageData.type === 'cloudflare-session' && messageData.session?.access_token) {
      const nativeSession = { access_token: messageData.session.access_token, user: messageData.user || null };
      nativeSessionRef.current = nativeSession;
      try {
        await getLocationTask().setNativeAccessToken(nativeSession.access_token);
        await registerNativePush(nativeSession.access_token);
        if (nativeLocationActiveRef.current) await enableTracking(nativeSession.user?.id || 'signed-in-user', nativeSession.access_token);
        setPermissionIssue(null);
        setMessage(nativeLocationActiveRef.current ? 'Notifications and live location are active.' : 'Notifications are active. Live location starts after employee sign-in.');
      } catch (error) {
        setPermissionIssue({ kind: error.code === 'notifications-permission' ? 'notifications' : 'setup', code: error.code || 'setup', text: error.message || 'Native services could not be enabled.' });
        setMessage(error.message || 'Native services could not be enabled.');
      }
      return;
    }
    if (messageData.type !== 'supabase-session' || !messageData.session) return;
    const nativeSession = messageData.session;
    if (!nativeSession.access_token || !nativeSession.refresh_token) return;
    nativeSessionRef.current = messageData.session;
    const result = await supabase.auth.setSession({ access_token: nativeSession.access_token, refresh_token: nativeSession.refresh_token });
    if (result.error) { setMessage('Location service could not connect to this account.'); return; }
    if (nativeLocationActiveRef.current) await enableTracking(nativeSession.user && nativeSession.user.id || 'signed-in-user', nativeSession.access_token);
  }, [enableTracking]);

  useEffect(() => {
    checkForUpdate();
    // Ask for Android notification permission on the first launch, before
    // sign-in. Token registration still happens after the employee session
    // is available, but permission must not depend on WebView timing.
    // Request immediately after the native screen mounts so Android presents
    // its real Allow / Don't allow dialog instead of waiting for sign-in or a
    // WebView callback.
    requestNativeNotificationPermission().catch((error) => {
      if (error && error.code === 'notifications-permission') {
        setPermissionIssue({ kind: 'notifications', code: error.code, text: error.message });
      }
    });
    restoreNativeServices();
    stopBackgroundTracking().then(() => setTracking(false)).catch(() => setTracking(false));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!next) setTracking(false);
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkForUpdate();
        restoreNativeServices();
      }
    });
    const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // An outdated binary must not be able to dismiss the update gate and
      // continue using the employee app. The user can leave Android normally,
      // but returning to this app keeps the mandatory update prompt visible.
      if (updateInfo) return true;
      if (overlayOpenRef.current && webViewRef.current) {
        // Close the WebView overlay directly. history.back() alone is not
        // reliable with Android's predictive-back/edge-swipe dispatcher.
        webViewRef.current.injectJavaScript('window.closeEmployeeOverlayFromNative ? window.closeEmployeeOverlayFromNative() : window.history.back(); true;');
        return true;
      }
      return false;
    });
    return () => { if (webViewLoadingTimerRef.current) clearTimeout(webViewLoadingTimerRef.current); listener.subscription.unsubscribe(); appState.remove(); backSubscription.remove(); };
  }, [checkForUpdate, restoreNativeServices, updateInfo]);

  const openPhoneSettings = useCallback(() => { Linking.openSettings().catch(() => {}); }, []);

  return <SafeAreaProvider>
    <StatusBar barStyle="light-content" backgroundColor="#032e42" translucent={false} />
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
    <WebView
      ref={webViewRef}
      source={{ uri: employeeAppUrl }}
      style={styles.webview}
      originWhitelist={['https://*', 'http://*']}
      javaScriptEnabled
      domStorageEnabled
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      setSupportMultipleWindows={false}
      onLoadStart={handleWebViewLoadStart}
      onLoadEnd={handleWebViewLoadEnd}
      onError={handleWebViewError}
      onMessage={handleMessage}
      onFileDownload={({ nativeEvent }) => {
        const downloadUrl = nativeEvent && nativeEvent.downloadUrl;
        // The payslip is delivered through the base64 bridge above. Do not try
        // to hand WebView blob/data URLs to Android's URL resolver.
        if (downloadUrl && !/^(blob:|data:)/i.test(downloadUrl)) Linking.openURL(downloadUrl).catch(() => {});
      }}
      allowsBackForwardNavigationGestures
      cacheEnabled
      mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
    />
    {loading && <View style={styles.loadingOverlay}><LoadingScreen /></View>}
    {updateInfo && <View style={styles.noticeOverlay}><View style={styles.noticeCard}><Text style={styles.noticeTitle}>Update required</Text><Text style={styles.noticeBody}>{updateInfo.message || `Install version ${updateInfo.latestVersion} to continue using My HR.`}</Text><View style={styles.noticeActions}><Text onPress={() => Linking.openURL(updateInfo.apkUrl || APK_URL)} style={styles.noticePrimary}>Update now</Text></View></View></View>}
    {permissionIssue && permissionIssue.kind !== 'notifications' && <View style={styles.noticeOverlay}><View style={styles.noticeCard}><Text style={styles.noticeTitle}>Live location needs permission</Text><Text style={styles.noticeBody}>{permissionIssue.text}</Text><View style={styles.noticeActions}><Text onPress={openPhoneSettings} style={styles.noticePrimary}>Open phone settings</Text><Text onPress={retryNativeSetup} style={styles.noticeSecondary}>Retry</Text></View></View></View>}
    
    </SafeAreaView>
  </SafeAreaProvider>;
}

function LoadingScreen() {
  return <View style={styles.loading}><View style={styles.loadingCard}><Image source={require('./assets/icon.png')} style={styles.logoImage} resizeMode="contain" /><Text style={styles.logoName}>My HR</Text><Text style={styles.logoByline}>Fruitmaster Agro Fresh Pvt. Ltd.</Text><Text style={styles.loadingLabel}>LOADING WORKSPACE</Text><ActivityIndicator size="small" color="#f28a00" /></View></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#eef7f2' },
  webview: { flex: 1, backgroundColor: '#eef7f2' },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 30, backgroundColor: '#eef7f2' },
  noticeOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 20, justifyContent: 'flex-end', padding: 16, backgroundColor: 'rgba(3,46,66,0.16)' },
  noticeCard: { backgroundColor: '#fff', borderRadius: 18, padding: 18, shadowColor: '#032e42', shadowOpacity: 0.18, shadowRadius: 12, elevation: 8 },
  noticeTitle: { color: '#032e42', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  noticeBody: { color: '#52636b', fontSize: 14, lineHeight: 21 },
  noticeActions: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 18 },
  noticePrimary: { color: '#d66b00', fontWeight: '800', fontSize: 14 },
  noticeSecondary: { color: '#315b69', fontWeight: '700', fontSize: 14 },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#eef7f2' },
  loadingCard: { width: 280, minHeight: 300, alignItems: 'center', justifyContent: 'center', paddingVertical: 28 },
  logoImage: { width: 168, height: 168, marginBottom: 12 },
  logoName: { color: '#032e42', fontSize: 28, fontWeight: '800', lineHeight: 32 },
  logoByline: { color: '#3b9154', fontSize: 14, fontWeight: '700', lineHeight: 20, textAlign: 'center', marginBottom: 18 },
  loadingLabel: { color: '#678274', fontSize: 11, letterSpacing: 2, marginBottom: 10 },
  trackingPill: { position: 'absolute', top: 32, right: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: 'rgba(7,53,73,0.88)' },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#45d483', marginRight: 6 },
  trackingText: { color: '#fff', fontSize: 11, fontWeight: '700' }
});

