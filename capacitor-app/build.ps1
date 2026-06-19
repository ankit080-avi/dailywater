# Builds the DailyWater debug APK. Mirrors MilkMate toolchain (Capacitor 8, SDK 36). ASCII-only.
$ErrorActionPreference = 'Continue'
$env:ANDROID_HOME     = 'D:\android-sdk'
$env:ANDROID_SDK_ROOT = 'D:\android-sdk'
$cap = 'D:\cl\dailywater\capacitor-app'
Set-Location $cap

Write-Host "================ [1/5] npm install ================"
npm install --no-audit --no-fund

Write-Host "================ [2/5] cap add android ================"
if (-not (Test-Path (Join-Path $cap 'android'))) {
  npx cap add android
} else {
  Write-Host "android/ already exists - skipping add"
}

Write-Host "================ [3/5] configure (SDK 36 + sdk.dir) ================"
$vg = Join-Path $cap 'android\variables.gradle'
if (Test-Path $vg) {
  $c = Get-Content $vg -Raw
  $c = $c -replace 'compileSdkVersion = \d+', 'compileSdkVersion = 36'
  $c = $c -replace 'targetSdkVersion = \d+',  'targetSdkVersion = 36'
  Set-Content $vg $c -Encoding ascii
}
Set-Content (Join-Path $cap 'android\local.properties') 'sdk.dir=D:\\android-sdk' -Encoding ascii

Write-Host "================ [4/5] cap sync ================"
npx cap sync android

Write-Host "================ [5/5] gradle assembleDebug ================"
Set-Location (Join-Path $cap 'android')
.\gradlew.bat assembleDebug --no-daemon

$apk = Join-Path $cap 'android\app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
  Copy-Item $apk 'D:\cl\dailywater\DailyWater.apk' -Force
  $mb = [math]::Round((Get-Item $apk).Length/1MB, 2)
  Write-Host ("BUILD OK -> D:\cl\dailywater\DailyWater.apk  " + $mb + " MB")
} else {
  Write-Host "BUILD FAILED - app-debug.apk not produced"
}
