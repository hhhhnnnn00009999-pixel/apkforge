#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      🔥 ApkForge v6.0 — Ultimate APK Builder                  ║
 * ║   Real APK • Icon Resizing (jimp) • 22+ Permissions • SSE     ║
 * ║   Termux Ready • Single File                                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

// ═══════════════════ مكتبة معالجة الصور ═══════════════════
let imageLib = null;
let imageLibName = 'none';

const imageLibCandidates = [
    { name: 'jimp', type: 'jimp' },
    { name: '@lucasmod/sharp-termux', type: 'sharp' },
    { name: 'sharp', type: 'sharp' }
];

for (const candidate of imageLibCandidates) {
    try {
        imageLib = require(candidate.name);
        imageLibName = candidate.name;
        console.log('✅ Image library: ' + candidate.name);
        break;
    } catch (e) {}
}

if (!imageLib) {
    console.log('⚠️  No image library — icons will not be resized');
}

// ═══════════════════ الإعدادات ═══════════════════
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const BUILD_DIR = path.join(ROOT, 'builds');
const WORK_DIR = path.join(ROOT, 'workspaces');
const PROJECTS_DIR = path.join(ROOT, 'projects');

[BUILD_DIR, WORK_DIR, PROJECTS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ═══════════════════ الحالة ═══════════════════
const builds = new Map();
const clients = new Map();
const stats = { totalBuilds: 0, successful: 0, failed: 0, startTime: Date.now() };

// ═══════════════════ أدوات ═══════════════════
function uuid() {
    return crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
}

function which(cmd) {
    try {
        return execSync(`command -v ${cmd} 2>/dev/null`).toString().trim() || null;
    } catch { return null; }
}

function findAndroidJar() {
    const p = process.env.PREFIX || '/data/data/com.termux/files/usr';
    const candidates = [
        process.env.ANDROID_JAR,
        `${p}/opt/android-sdk/platforms/android-34/android.jar`,
        `${p}/opt/android-sdk/platforms/android-33/android.jar`,
        `${process.env.HOME}/android-sdk/platforms/android-34/android.jar`,
        '/opt/android-sdk/platforms/android-34/android.jar'
    ].filter(Boolean);
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
}

function findTool(name) {
    const p = process.env.PREFIX || '/data/data/com.termux/files/usr';
    const paths = [
        `${p}/bin/${name}`,
        `${p}/opt/android-build-tools/android-14/${name}`,
        `${process.env.HOME}/android-build-tools/${name}`,
        '/opt/android-build-tools/android-14/' + name
    ];
    for (const path of paths) if (fs.existsSync(path)) return path;
    return which(name);
}

function execAsync(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 100 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                err.stdout = stdout;
                reject(err);
            } else resolve({ stdout, stderr });
        });
    });
}

function broadcast(buildId, data) {
    const list = clients.get(buildId) || [];
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    list.forEach(res => { try { res.write(msg); } catch {} });
}

function updateBuild(buildId, patch) {
    const b = builds.get(buildId);
    if (b) {
        Object.assign(b, patch);
        broadcast(buildId, b);
    }
}

function logBuild(buildId, message, type = 'info') {
    const b = builds.get(buildId);
    if (!b) return;
    if (!b.logs) b.logs = [];
    b.logs.push({ t: Date.now(), message, type });
    broadcast(buildId, { logs: b.logs.slice(-1) });
}

// ═══════════════════ DEX (d8/dx) ═══════════════════
async function runDexTool(jarPath, outDir, minSdk = 21) {
    const dx = findTool('dx');
    const d8 = findTool('d8');

    if (dx) {
        try {
            const out = path.join(outDir, 'classes.dex');
            const cmd = `"${dx}" --dex --min-sdk-version=${minSdk} --output="${out}" "${jarPath}"`;
            await execAsync(cmd + ' 2>&1');
            return { tool: 'dx', success: true };
        } catch (e) {
            throw new Error('فشل dx: ' + (e.stdout || e.stderr || e.message));
        }
    }

    if (d8) {
        try {
            const cmd = `"${d8}" --min-api ${minSdk} --output "${outDir}" "${jarPath}"`;
            await execAsync(cmd + ' 2>&1');
            return { tool: 'd8', success: true };
        } catch (e) {
            throw new Error('فشل d8: ' + (e.stdout || e.stderr || e.message));
        }
    }

    throw new Error('لا يوجد dx ولا d8');
}

// ═══════════════════ أيقونة افتراضية PNG ═══════════════════
function generateDefaultIcon(hexColor) {
    const size = 192;
    const rgb = hexToRgb(hexColor);
    const rowLength = size * 4 + 1;
    const rawData = Buffer.alloc(rowLength * size);

    for (let y = 0; y < size; y++) {
        const rowStart = y * rowLength;
        rawData[rowStart] = 0;
        for (let x = 0; x < size; x++) {
            const off = rowStart + 1 + x * 4;
            const t = (x + y) / (size * 2);
            const cornerDist = Math.min(x, y, size - 1 - x, size - 1 - y);
            const alpha = cornerDist < 20 ? 0 : 255;
            rawData[off] = Math.round(rgb.r * (1 - t) + 245 * t);
            rawData[off + 1] = Math.round(rgb.g * (1 - t) + 158 * t);
            rawData[off + 2] = Math.round(rgb.b * (1 - t) + 11 * t);
            rawData[off + 3] = alpha;
        }
    }

    const compressed = zlib.deflateSync(rawData, { level: 9 });
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = makeChunk('IHDR', (() => {
        const b = Buffer.alloc(13);
        b.writeUInt32BE(size, 0);
        b.writeUInt32BE(size, 4);
        b[8] = 8; b[9] = 6; b[10] = 0; b[11] = 0; b[12] = 0;
        return b;
    })());
    const idat = makeChunk('IDAT', compressed);
    const iend = makeChunk('IEND', Buffer.alloc(0));
    return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

let crcTable = null;
function crc32(buf) {
    if (!crcTable) {
        crcTable = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    return {
        r: parseInt(hex.substr(0, 2), 16),
        g: parseInt(hex.substr(2, 2), 16),
        b: parseInt(hex.substr(4, 2), 16)
    };
}

// ═══════════════════ معالجة الأيقونات ═══════════════════
async function processIcon(iconBase64, themeColor, resDir, log) {
    const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

    let iconBuffer = null;
    let iconSource = 'generated';
    let originalSize = 0;

    if (iconBase64 && iconBase64.length > 100) {
        try {
            const b64 = iconBase64.replace(/^data:image\/\w+;base64,/, '');
            iconBuffer = Buffer.from(b64, 'base64');
            originalSize = iconBuffer.length;

            if (iconBuffer.length < 200) {
                throw new Error('الأيقونة صغيرة جداً: ' + iconBuffer.length + ' bytes');
            }

            const isPNG = iconBuffer[0] === 0x89 && iconBuffer[1] === 0x50;
            const isJPG = iconBuffer[0] === 0xFF && iconBuffer[1] === 0xD8;
            const isWEBP = iconBuffer.slice(0, 4).toString() === 'RIFF' && iconBuffer.slice(8, 12).toString() === 'WEBP';

            if (!isPNG && !isJPG && !isWEBP) {
                throw new Error('صيغة غير مدعومة (PNG/JPG/WEBP فقط)');
            }

            iconSource = 'uploaded';
            const fmt = isPNG ? 'PNG' : isJPG ? 'JPG' : 'WEBP';
            log('✓ أيقونة مستلمة: ' + (originalSize / 1024).toFixed(1) + ' KB، ' + fmt, 'success');
        } catch (e) {
            log('⚠️ فشل معالجة الأيقونة: ' + e.message, 'warn');
            iconBuffer = null;
        }
    }

    if (!iconBuffer) {
        iconBuffer = generateDefaultIcon(themeColor);
        log('ℹ️ استخدام أيقونة افتراضية', 'info');
    }

    for (const [name, size] of Object.entries(densities)) {
        const dir = path.join(resDir, `mipmap-${name}`);
        fs.mkdirSync(dir, { recursive: true });

        let finalBuffer = iconBuffer;

        if (imageLib && iconSource === 'uploaded') {
            try {
                if (imageLibName === 'jimp') {
                    const img = await imageLib.read(iconBuffer);
                    img.resize(size, size);
                    finalBuffer = await img.getBufferAsync(imageLib.MIME_PNG);
                } else {
                    finalBuffer = await imageLib(iconBuffer)
                        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                        .png({ compressionLevel: 9 })
                        .toBuffer();
                }
                log(`  ✓ ${name}: ${size}x${size} (${(finalBuffer.length / 1024).toFixed(1)} KB)`, 'info');
            } catch (e) {
                log(`  ⚠️ فشل تحجيم ${name}: ${e.message}`, 'warn');
                finalBuffer = iconBuffer;
            }
        }

        fs.writeFileSync(path.join(dir, 'ic_launcher.png'), finalBuffer);
        fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), finalBuffer);
    }

    return { iconSource, originalSize };
}

// ═══════════════════ محرك البناء ═══════════════════
async function buildAPK(opts) {
    const startTime = Date.now();
    const {
        buildId, appName, packageName, versionName, versionCode,
        htmlSource, permissions, admobId, themeColor, enableJs,
        enableZoom, orientation, iconBase64, settings = {}
    } = opts;

    const workDir = path.join(WORK_DIR, buildId);
    const srcDir = path.join(workDir, 'src');
    const resDir = path.join(workDir, 'res');
    const assetsDir = path.join(workDir, 'assets');
    const classesDir = path.join(workDir, 'classes');
    const dexDir = path.join(workDir, 'dex');
    const compiledRes = path.join(workDir, 'compiled_res');

    [workDir, srcDir, resDir, assetsDir, classesDir, dexDir, compiledRes]
        .forEach(d => fs.mkdirSync(d, { recursive: true }));

    const progress = (p, s) => updateBuild(buildId, { progress: p, stage: s, status: 'building' });
    const log = (m, t) => logBuild(buildId, m, t);

    try {
        // 1. الهيكل
        progress(3, 'إنشاء هيكل المشروع');
        log('🚀 بدء البناء: ' + appName, 'info');

        const packagePath = packageName.replace(/\./g, '/');
        const javaDir = path.join(srcDir, 'java', packagePath);
        fs.mkdirSync(javaDir, { recursive: true });

        // 2. المانيفست
        progress(7, 'توليد AndroidManifest.xml');

        const s = {
            allowBackup: settings.allowBackup !== false,
            supportsRtl: settings.supportsRtl !== false,
            debuggable: settings.debuggable === true,
            hardwareAccel: settings.hardwareAccel !== false,
            usesCleartext: settings.usesCleartext !== false,
            minSdk: settings.minSdk || 21,
            targetSdk: settings.targetSdk || 34,
            screenOrientation: orientation === 'landscape' ? 'landscape'
                : orientation === 'auto' ? 'unspecified' : 'portrait',
            theme: '@android:style/Theme.Material.Light.NoActionBar',
            exportActivity: settings.exportActivity !== false,
            launchMode: settings.launchMode || 'singleTop',
            includeSplash: settings.includeSplash !== false,
            splashColor: settings.splashColor || themeColor || '#6366f1',
            splashDuration: settings.splashDuration || 1500,
            userAgent: settings.userAgent || '',
            enableDownloads: settings.enableDownloads !== false,
            enableFileUpload: settings.enableFileUpload !== false,
            enableGeolocation: settings.enableGeolocation !== false,
            enableFullscreen: settings.enableFullscreen === true,
            keepScreenOn: settings.keepScreenOn === true,
            enableConsole: settings.enableConsole === true,
            injectJs: settings.injectJs || '',
            appLanguage: settings.appLanguage || 'ar',
            deepLinkScheme: settings.deepLinkScheme || ''
        };

        const permissionsXml = permissions
            .map(p => `    <uses-permission android:name="android.permission.${p}" />`)
            .join('\n');

        const admobMeta = admobId ? `
        <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID"
                   android:value="${admobId}" />` : '';

        const deepLinkXml = s.deepLinkScheme ? `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${s.deepLinkScheme}" />
            </intent-filter>` : '';

        const splashActivity = s.includeSplash ? `
        <activity
            android:name="${packageName}.SplashActivity"
            android:exported="false"
            android:theme="@style/SplashTheme">
        </activity>` : '';

        const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}"
    android:versionCode="${versionCode}"
    android:versionName="${versionName}">

    <uses-sdk android:minSdkVersion="${s.minSdk}" android:targetSdkVersion="${s.targetSdk}" />
${permissionsXml}

    <application
        android:label="${appName}"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:theme="${s.theme}"
        android:hardwareAccelerated="${s.hardwareAccel}"
        android:usesCleartextTraffic="${s.usesCleartext}"
        android:allowBackup="${s.allowBackup}"
        android:supportsRtl="${s.supportsRtl}"
        android:debuggable="${s.debuggable}">${admobMeta}
${splashActivity}
        <activity
            android:name="${packageName}.MainActivity"
            android:exported="${s.exportActivity}"
            android:screenOrientation="${s.screenOrientation}"
            android:launchMode="${s.launchMode}"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize|uiMode">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>${deepLinkXml}
        </activity>
    </application>
</manifest>`;

        fs.writeFileSync(path.join(workDir, 'AndroidManifest.xml'), manifest);
        log('✓ تم توليد المانيفست', 'success');

        // 3. HTML + Assets
        progress(12, 'كتابة ملفات المشروع');
        fs.writeFileSync(path.join(assetsDir, 'index.html'), htmlSource, 'utf8');

        if (s.injectJs) {
            fs.writeFileSync(path.join(assetsDir, 'inject.js'), s.injectJs, 'utf8');
        }

        fs.writeFileSync(path.join(assetsDir, 'apkforge.json'), JSON.stringify({
            appName, packageName, versionName, versionCode,
            themeColor, settings: s, builtAt: new Date().toISOString()
        }, null, 2), 'utf8');

        // 4. Java
        progress(18, 'توليد MainActivity.java');

        const mainActivityJava = generateMainActivity(packageName, versionName, themeColor, s, enableJs, enableZoom);
        fs.writeFileSync(path.join(javaDir, 'MainActivity.java'), mainActivityJava);
        log('✓ تم توليد MainActivity.java', 'success');

        // 5. Splash
        if (s.includeSplash) {
            progress(22, 'توليد SplashActivity.java');
            const splashJava = `package ${packageName};

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;

public class SplashActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        new Handler().postDelayed(new Runnable() {
            @Override
            public void run() {
                startActivity(new Intent(SplashActivity.this, MainActivity.class));
                finish();
            }
        }, ${s.splashDuration});
    }
}`;
            fs.writeFileSync(path.join(javaDir, 'SplashActivity.java'), splashJava);
            log('✓ تم توليد SplashActivity.java', 'success');
        }

        // 6. الأيقونات
        progress(28, 'توليد الأيقونات بأحجام متعددة');
        const iconResult = await processIcon(iconBase64, themeColor, resDir, log);

        // 7. Splash Theme
        if (s.includeSplash) {
            const valuesDir = path.join(resDir, 'values');
            fs.mkdirSync(valuesDir, { recursive: true });
            const stylesXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="SplashTheme" parent="@android:style/Theme.Material.Light.NoActionBar">
        <item name="android:windowBackground">${s.splashColor}</item>
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowFullscreen">true</item>
    </style>
</resources>`;
            fs.writeFileSync(path.join(valuesDir, 'styles.xml'), stylesXml);
        }

        // 8. الأدوات
        progress(35, 'التحقق من أدوات البناء');

        const androidJar = findAndroidJar();
        if (!androidJar) throw new Error('❌ android.jar غير موجود');

        const javac = which('javac');
        if (!javac) throw new Error('❌ javac غير مثبت');

        const aapt2 = findTool('aapt2');
        if (!aapt2) throw new Error('❌ aapt2 غير مثبت');

        const d8 = findTool('d8');
        const dx = findTool('dx');
        if (!d8 && !dx) throw new Error('❌ لا يوجد d8 أو dx');

        const apksigner = findTool('apksigner');
        const zipalign = findTool('zipalign');

        log('✓ الأدوات جاهزة', 'success');

        // 9. ترجمة Java
        progress(42, 'ترجمة كود Java');

        const javaFiles = [];
        walkDir(javaDir, f => { if (f.endsWith('.java')) javaFiles.push(f); });

        const javacCmd = `"${javac}" -source 8 -target 8 -bootclasspath "${androidJar}" -encoding UTF-8 -d "${classesDir}" ${javaFiles.map(f => `"${f}"`).join(' ')}`;

        try {
            await execAsync(javacCmd + ' 2>&1');
            log('✓ تم ترجمة ' + javaFiles.length + ' ملفات Java', 'success');
        } catch (e) {
            const out = e.stdout || e.stderr || e.message;
            log('❌ فشل الترجمة:\n' + out, 'error');
            throw new Error('فشل ترجمة Java: ' + out.substring(0, 800));
        }

        // 10. classes.jar
        progress(50, 'حزم classes.jar');
        const classesJar = path.join(workDir, 'classes.jar');
        await execAsync(`cd "${classesDir}" && jar cf "${classesJar}" .`);

        // 11. DEX
        progress(58, 'تحويل إلى DEX');
        const dexResult = await runDexTool(classesJar, dexDir, s.minSdk);
        log('✓ تم إنشاء DEX (' + dexResult.tool + ')', 'success');

        // 12. aapt2 compile
        progress(66, 'تجميع الموارد');
        const resZip = path.join(compiledRes, 'res.zip');
        try {
            await execAsync(`"${aapt2}" compile --dir "${resDir}" -o "${resZip}" 2>&1`);
            log('✓ تم تجميع الموارد', 'success');
        } catch (e) {
            throw new Error('فشل aapt2 compile: ' + (e.stdout || e.stderr || e.message));
        }

        // 13. aapt2 link
        progress(74, 'ربط الموارد');
        const unsignedApk = path.join(workDir, 'unsigned.apk');
        const linkCmd = `"${aapt2}" link -o "${unsignedApk}" -I "${androidJar}" --manifest "${path.join(workDir, 'AndroidManifest.xml')}" -A "${assetsDir}" --java "${srcDir}" --min-sdk-version ${s.minSdk} --target-sdk-version ${s.targetSdk} --version-code ${versionCode} --version-name "${versionName}" "${resZip}"`;

        try {
            await execAsync(linkCmd + ' 2>&1');
            log('✓ تم ربط الموارد', 'success');
        } catch (e) {
            throw new Error('فشل aapt2 link: ' + (e.stdout || e.stderr || e.message));
        }

        // 14. إضافة dex
        progress(82, 'إضافة classes.dex');
        const finalUnsigned = path.join(workDir, 'final-unsigned.apk');
        fs.copyFileSync(unsignedApk, finalUnsigned);

        let dexFile = path.join(dexDir, 'classes.dex');
        if (!fs.existsSync(dexFile)) {
            const dexFiles = fs.readdirSync(dexDir).filter(f => f.endsWith('.dex'));
            if (dexFiles.length > 0) dexFile = path.join(dexDir, dexFiles[0]);
        }

        if (!fs.existsSync(dexFile)) throw new Error('❌ classes.dex غير موجود');

        try {
            await execAsync(`cd "${path.dirname(dexFile)}" && zip -j "${finalUnsigned}" "${path.basename(dexFile)}" 2>&1`);
            log('✓ تم إضافة ' + path.basename(dexFile), 'success');
        } catch (e) {
            throw new Error('فشل إضافة DEX: ' + (e.stdout || e.stderr || e.message));
        }

        // 15. التوقيع
        progress(90, 'توقيع APK');
        const keystorePath = path.join(workDir, 'debug.keystore');

        if (!fs.existsSync(keystorePath)) {
            try {
                await execAsync(
                    `keytool -genkeypair -v -keystore "${keystorePath}" -alias apkforge ` +
                    `-keyalg RSA -keysize 2048 -validity 10000 ` +
                    `-storepass apkforge -keypass apkforge ` +
                    `-dname "CN=ApkForge, OU=Dev, O=ApkForge, L=City, S=State, C=US" 2>&1`
                );
                log('✓ تم إنشاء keystore', 'success');
            } catch (e) {
                throw new Error('فشل إنشاء keystore: ' + (e.stdout || e.stderr || e.message));
            }
        }

        const safeName = appName.replace(/[^\w\u0600-\u06FF\s-]/g, '').trim().replace(/\s+/g, '_') || 'app';
        const signedApk = path.join(workDir, `${safeName}-signed.apk`);
        const alignedApk = path.join(workDir, `${safeName}-aligned.apk`);
        const finalApk = path.join(workDir, `${safeName}.apk`);

        if (apksigner) {
            try {
                await execAsync(
                    `"${apksigner}" sign --ks "${keystorePath}" --ks-pass pass:apkforge ` +
                    `--key-pass pass:apkforge --ks-key-alias apkforge ` +
                    `--out "${signedApk}" "${finalUnsigned}" 2>&1`
                );
                log('✓ تم التوقيع بـ apksigner', 'success');
            } catch (e) {
                log('⚠️ فشل apksigner — استخدام jarsigner', 'warn');
                await execAsync(
                    `jarsigner -keystore "${keystorePath}" -storepass apkforge -keypass apkforge ` +
                    `-signedjar "${signedApk}" "${finalUnsigned}" apkforge 2>&1`
                );
                log('✓ تم التوقيع بـ jarsigner', 'success');
            }
        } else {
            await execAsync(
                `jarsigner -keystore "${keystorePath}" -storepass apkforge -keypass apkforge ` +
                `-signedjar "${signedApk}" "${finalUnsigned}" apkforge 2>&1`
            );
            log('✓ تم التوقيع بـ jarsigner', 'success');
        }

        // 16. zipalign
        progress(95, 'تحسين APK');
        if (zipalign) {
            try {
                await execAsync(`"${zipalign}" -f 4 "${signedApk}" "${alignedApk}" 2>&1`);
                fs.copyFileSync(alignedApk, finalApk);
                log('✓ تم zipalign', 'success');
            } catch (e) {
                log('⚠️ فشل zipalign — استخدام الموقّع', 'warn');
                fs.copyFileSync(signedApk, finalApk);
            }
        } else {
            fs.copyFileSync(signedApk, finalApk);
        }

        // 17. النشر
        progress(98, 'التحضير للتنزيل');
        const publicDir = path.join(BUILD_DIR, buildId);
        fs.mkdirSync(publicDir, { recursive: true });
        const publicApk = path.join(publicDir, `${safeName}.apk`);
        fs.copyFileSync(finalApk, publicApk);

        // ═══ نسخ تلقائي إلى مجلد التنزيلات ═══
        try {
            const dlDir = path.join(process.env.HOME, 'storage', 'downloads', 'ApkForge');
            if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
            const stamp = new Date().toISOString().slice(0, 10);
            const dlName = safeName + '-' + stamp + '.apk';
            fs.copyFileSync(publicApk, path.join(dlDir, dlName));
            log('📱 APK محفوظ في: Download/ApkForge/' + dlName, 'success');
        } catch (e) {
            log('⚠️ فشل النسخ للتنزيلات: ' + e.message, 'warn');
        }

        const fileStat = fs.statSync(publicApk);
        progress(100, '✅ اكتمل البناء بنجاح');

        stats.totalBuilds++;
        stats.successful++;

        log('🎉 اكتمل! الحجم: ' + (fileStat.size / 1024 / 1024).toFixed(2) + ' MB', 'success');
        log('📦 الأيقونة: ' + (iconResult.iconSource === 'uploaded' ? 'مخصصة ✨' : 'افتراضية'), 'info');

        return {
            fileName: path.basename(publicApk),
            filePath: publicApk,
            fileSize: fileStat.size,
            duration: Date.now() - startTime,
            iconSource: iconResult.iconSource
        };

    } catch (err) {
        stats.failed++;
        log('💥 ' + err.message, 'error');
        throw err;
    }
}

// ═══════════════════ MainActivity ═══════════════════
function generateMainActivity(packageName, versionName, themeColor, s, enableJs, enableZoom) {
    const jsEnabled = enableJs ? 'true' : 'false';
    const zoomEnabled = enableZoom ? 'true' : 'false';
    const geolocationEnabled = s.enableGeolocation ? 'true' : 'false';
    const downloadsEnabled = s.enableDownloads ? 'true' : 'false';
    const fileUploadEnabled = s.enableFileUpload ? 'true' : 'false';
    const fullscreen = s.enableFullscreen ? 'true' : 'false';
    const keepScreen = s.keepScreenOn ? 'true' : 'false';
    const consoleEnabled = s.enableConsole ? 'true' : 'false';
    const userAgentLine = s.userAgent
        ? `ws.setUserAgentString("${s.userAgent.replace(/"/g, '\\"')}");`
        : '';

    return `package ${packageName};

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

@SuppressLint("SetJavaScriptEnabled")
public class MainActivity extends Activity {

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_CHOOSER_RESULT = 1001;
    private long lastBackPress = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (${fullscreen}) {
            requestWindowFeature(Window.FEATURE_NO_TITLE);
            getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window w = getWindow();
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            w.setStatusBarColor(Color.parseColor("${themeColor}"));
        }

        if (${keepScreen}) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }

        java.util.Locale.setDefault(new java.util.Locale("${s.appLanguage}"));

        webView = new WebView(this);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(${jsEnabled});
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setBuiltInZoomControls(${zoomEnabled});
        ws.setDisplayZoomControls(false);
        ws.setGeolocationEnabled(${geolocationEnabled});
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(true);
        ws.setLoadsImagesAutomatically(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        ws.setDefaultTextEncodingName("UTF-8");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(${consoleEnabled});
        }

        ${userAgentLine}

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) { return handleUrl(url); }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    return handleUrl(request.getUrl().toString());
                }
                return false;
            }

            private boolean handleUrl(String url) {
                if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    return true;
                } catch (Exception e) { return false; }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    runOnUiThread(new Runnable() {
                        public void run() { request.grant(request.getResources()); }
                    });
                }
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                cb.invoke(origin, true, false);
            }

            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (!${fileUploadEnabled}) return false;
                filePathCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_RESULT);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                if (${consoleEnabled}) Log.d("ApkForge", cm.message());
                return true;
            }
        });

        ${downloadsEnabled ? `
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition,
                                        String mimetype, long contentLength) {
                try {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setMimeType(mimetype);
                    req.addRequestHeader("User-Agent", userAgent);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, android.webkit.URLUtil.guessFileName(url, disposition, mimetype));
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    dm.enqueue(req);
                    Toast.makeText(MainActivity.this, "⏬ جاري التحميل...", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                }
            }
        });
        ` : ''}

        webView.addJavascriptInterface(new Bridge(), "ApkForge");
        webView.loadUrl("file:///android_asset/index.html");
    }

    public class Bridge {
        @JavascriptInterface public void toast(String msg) {
            final String m = msg;
            runOnUiThread(new Runnable() {
                public void run() { Toast.makeText(MainActivity.this, m, Toast.LENGTH_SHORT).show(); }
            });
        }

        @JavascriptInterface public void vibrate(int ms) {
            try {
                android.os.Vibrator v = (android.os.Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(ms);
            } catch (Exception e) {}
        }

        @JavascriptInterface public String getVersion() { return "${versionName}"; }
        @JavascriptInterface public String getPackage() { return "${packageName}"; }

        @JavascriptInterface public String getDeviceInfo() {
            return "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ") " + Build.MANUFACTURER + " " + Build.MODEL;
        }

        @JavascriptInterface public void log(String msg) { Log.d("ApkForge-JS", msg); }

        @JavascriptInterface public void openUrl(String url) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) {}
        }

        @JavascriptInterface public void shareText(String text) {
            try {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(i, "مشاركة"));
            } catch (Exception e) {}
        }

        @JavascriptInterface public void copyToClipboard(String text) {
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(android.content.ClipData.newPlainText("ApkForge", text));
            } catch (Exception e) {}
        }

        @JavascriptInterface public void exitApp() {
            runOnUiThread(new Runnable() {
                public void run() { finish(); }
            });
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == FILE_CHOOSER_RESULT) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
                filePathCallback = null;
            }
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView.canGoBack()) { webView.goBack(); return true; }
            long now = System.currentTimeMillis();
            if (now - lastBackPress < 2000) { finish(); }
            else {
                lastBackPress = now;
                Toast.makeText(this, "اضغط رجوع مرة أخرى للخروج", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}`;
}

// ═══════════════════ Walk Directory ═══════════════════
function walkDir(dir, cb) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory()) walkDir(full, cb);
        else cb(full);
    }
}

// ═══════════════════ HTTP Helpers ═══════════════════
async function readJSON(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => {
            body += c;
            if (body.length > 100 * 1024 * 1024) { reject(new Error('Payload too large')); req.destroy(); }
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

// ═══════════════════ HTTP Server ═══════════════════
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (pathname === '/' || pathname === '/index.html') {
        try {
            const ui = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(ui);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('❌ ui.html غير موجود');
        }
    }

    if (pathname === '/api/health') {
        const tools = {
            androidJar: findAndroidJar(),
            javac: which('javac'),
            aapt2: findTool('aapt2'),
            d8: findTool('d8'),
            dx: findTool('dx'),
            apksigner: findTool('apksigner'),
            zipalign: findTool('zipalign'),
            keytool: which('keytool'),
            jar: which('jar'),
            zip: which('zip'),
            imageLib: imageLib ? imageLibName : null
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            ok: true, version: '6.0.0', uptime: process.uptime(),
            platform: process.platform, builds: builds.size, stats, tools
        }));
    }

    if (pathname === '/api/build' && req.method === 'POST') {
        try {
            const payload = await readJSON(req);
            const { appName, packageName, htmlSource } = payload;

            if (!appName || !packageName || !htmlSource) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'الحقول المطلوبة ناقصة' }));
            }

            const buildId = uuid();
            builds.set(buildId, {
                id: buildId, status: 'queued', progress: 0,
                stage: 'في قائمة الانتظار', createdAt: Date.now(),
                appName, packageName, logs: []
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ buildId, status: 'queued' }));

            setImmediate(async () => {
                try {
                    const result = await buildAPK({
                        buildId, appName, packageName,
                        versionName: payload.versionName || '1.0.0',
                        versionCode: parseInt(payload.versionCode) || 1,
                        htmlSource,
                        permissions: payload.permissions || ['INTERNET'],
                        admobId: payload.admobId || '',
                        themeColor: payload.themeColor || '#6366f1',
                        enableJs: payload.enableJs !== false,
                        enableZoom: payload.enableZoom === true,
                        orientation: payload.orientation || 'portrait',
                        iconBase64: payload.iconBase64 || null,
                        settings: payload.settings || {}
                    });

                    updateBuild(buildId, {
                        status: 'success', progress: 100, stage: '✅ اكتمل',
                        downloadUrl: `/downloads/${buildId}/${result.fileName}`,
                        fileSize: result.fileSize, duration: result.duration,
                        iconSource: result.iconSource
                    });
                } catch (err) {
                    console.error('[Build Error]', err);
                    updateBuild(buildId, {
                        status: 'error', stage: '❌ فشل',
                        error: (err.message || String(err)).substring(0, 3000)
                    });
                }
            });
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    if (pathname.startsWith('/api/status/')) {
        const b = builds.get(pathname.split('/').pop());
        if (!b) { res.writeHead(404); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(b));
    }

    if (pathname.startsWith('/api/stream/')) {
        const buildId = pathname.split('/').pop();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        if (!clients.has(buildId)) clients.set(buildId, []);
        clients.get(buildId).push(res);
        const b = builds.get(buildId);
        if (b) res.write(`data: ${JSON.stringify(b)}\n\n`);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
        req.on('close', () => {
            clearInterval(ping);
            const list = clients.get(buildId) || [];
            const idx = list.indexOf(res);
            if (idx > -1) list.splice(idx, 1);
        });
        return;
    }

    if (pathname === '/api/history') {
        const list = Array.from(builds.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(list));
    }

    if (pathname === '/api/project/save' && req.method === 'POST') {
        const payload = await readJSON(req);
        const id = payload.id || uuid();
        fs.writeFileSync(path.join(PROJECTS_DIR, id + '.json'), JSON.stringify(payload, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id, ok: true }));
    }

    if (pathname === '/api/project/list') {
        const files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
        const list = files.map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8')); }
            catch { return null; }
        }).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(list));
    }

    if (pathname.startsWith('/api/project/delete/')) {
        const id = pathname.split('/').pop();
        const f = path.join(PROJECTS_DIR, id + '.json');
        if (fs.existsSync(f)) fs.unlinkSync(f);
        res.writeHead(200); return res.end('{"ok":true}');
    }

    if (pathname.startsWith('/downloads/')) {
        const parts = pathname.replace('/downloads/', '').split('/');
        const buildId = parts[0];
        const fileName = parts.slice(1).join('/');
        const filePath = path.join(BUILD_DIR, buildId, fileName);
        if (!filePath.startsWith(BUILD_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
        if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Length': stat.size,
            'Content-Disposition': `attachment; filename="${fileName}"`
        });
        return fs.createReadStream(filePath).pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — Not Found');
});

server.listen(PORT, HOST, () => {
    const tools = {
        javac: which('javac'),
        aapt2: findTool('aapt2'),
        d8: findTool('d8'),
        dx: findTool('dx'),
        apksigner: findTool('apksigner'),
        zipalign: findTool('zipalign')
    };
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║      🔥 ApkForge v6.0 — Ultimate APK Builder                  ║
╠═══════════════════════════════════════════════════════════════╣
║  🌐  http://${HOST}:${PORT}                                    
║  📁  Builds: ${BUILD_DIR}
║  📦  Image Lib: ${imageLib ? '✅ ' + imageLibName : '❌ none'}
╠═══════════════════════════════════════════════════════════════╣
║  🛠️  Tools:                                                   
║      javac:      ${tools.javac || '❌'}
║      aapt2:      ${tools.aapt2 || '❌'}
║      d8:         ${tools.d8 || '❌'}
║      dx:         ${tools.dx || '❌'}
║      apksigner:  ${tools.apksigner || '❌'}
║      zipalign:   ${tools.zipalign || '❌'}
╚═══════════════════════════════════════════════════════════════╝
    `);
});

process.on('SIGINT', () => {
    console.log('\n⏹️  إيقاف الخادم...');
    server.close(() => process.exit(0));
});
