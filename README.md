# My HR mobile app

This is the single employee app. It displays the same deployed Employee App interface inside the native shell and keeps the native location task running in the background. The default build points to the Cloudflare Worker deployment. After an employee signs in to the embedded Employee App, its Cloudflare access token is shared with the native tracker, which writes GPS pings through `/api/native-location-ping`.

The native shell also registers an Expo push token after login. Attendance reminders and employer-sent reminders are delivered through the native Android notification service, so they can arrive while the app is in the background or has been closed normally. Android will not deliver any app notification after the user force-stops the app; reopening it is required by Android in that state. If Android does not show the background-location prompt, use the app's **Open phone settings** button and set Location to **Allow all the time**.

## One-time notification database setup

Run `../supabase/native-push-notifications-migration.sql` in the Supabase SQL Editor before installing the APK. This creates the server-side token table used by the native notification endpoints. The existing employee location migration must also already be installed for background live-location pings.

## Run locally

1. Install Node.js and Android Studio (or Xcode for iOS development).
2. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_EMPLOYEE_APP_URL` to the Cloudflare Worker URL with `?native=1` if you use another deployment. Set `EXPO_PUBLIC_BACKEND_MODE=cloudflare` for a non-`workers.dev` custom domain.
3. Run `npm install` and `npx expo start`.
4. Test on a physical phone. Simulators do not provide reliable background GPS.

## Build for phones

The production APK is built by GitHub Actions with Gradle and published to the repository's GitHub Release. No Expo build or Expo download URL is used. For a local Android build, run `npm install`, then `npm run build:android` from this directory. The employee must grant background location permission; the app displays a persistent Android notification while tracking is active.

## Releases

Every push to `main` that changes the app source runs `.github/workflows/build-apk.yml`. The workflow builds a release APK, increments the Android version code, and uploads `my-hr.apk` to a versioned GitHub Release.

## Build manually with Android Studio (Windows)

1. In PowerShell, enter this folder and regenerate the native project after JavaScript changes:
   `Set-Location "C:\Users\Hp\Documents\Codex\2026-10-07\ex\work\vercel-production-20261007\mobile"`
   `npx expo prebuild --platform android --no-install`
2. Open the `android` folder in Android Studio. In **Settings → Build, Execution, Deployment → Build Tools → Gradle**, choose the Android Studio JDK or a JDK 17 installation. The project uses Gradle 8.14.3; JDK 25 is not supported by this generated build.
3. In **File → Project Structure → SDK Location**, select `C:\Users\Hp\AppData\Local\Android\Sdk`. Install Android SDK Platform 36, Android SDK Build-Tools 36.0.0, Platform-Tools, and NDK 27.1.12297006 if Android Studio asks.
4. Choose **Build → Generate App Bundles or APKs → Generate APKs**. The signed debug-key release APK is written to `android\app\build\outputs\apk\release\app-release.apk`.

If Android Studio reports that the SDK is missing, create `android\local.properties` with `sdk.dir=C:/Users/Hp/AppData/Local/Android/Sdk`, then sync the project again. Install the APK on a physical Android phone; background location and push notifications cannot be verified reliably on an emulator.
