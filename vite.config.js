import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Copies the logo from logo/ (the one place to change it) into Laravel's public/ on every
 * build and dev start: browser-tab favicons, install icons and the logo shown on the pages.
 * Files missing from logo/ are left as they are.
 */
const LOGO_FILES = {
    'favicon.ico': 'public/favicon.ico',
    'favicon-16x16.png': 'public/pwa/favicon-16x16.png',
    'favicon-32x32.png': 'public/pwa/favicon-32x32.png',
    'android-chrome-192x192.png': 'public/pwa/icon-192.png',
    'android-chrome-512x512.png': 'public/pwa/icon-512.png',
    'apple-touch-icon.png': 'public/pwa/apple-touch-icon.png',
};
function syncLogo() {
    return {
        name: 'arnode-sync-logo',
        buildStart() {
            fs.mkdirSync(path.resolve('public/pwa'), { recursive: true });
            for (const [from, to] of Object.entries(LOGO_FILES)) {
                const source = path.resolve('logo', from);
                if (fs.existsSync(source)) fs.copyFileSync(source, path.resolve(to));
            }
        },
    };
}

/**
 * The dev server answers URLs the way Laravel does once built (routes/web.php): the root opens the
 * student/visitor map, and the admin console lives at /admin. Without this, / served index.html (the
 * admin console) in dev only.
 */
function devRoutes() {
    return {
        name: 'arnode-dev-routes',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const [pathname, query = ''] = (req.url || '').split('?');
                const search = query ? `?${query}` : '';
                if (pathname === '/') {
                    res.statusCode = 302;
                    res.setHeader('Location', `/map${search}`);
                    res.end();
                    return;
                }
                if (pathname === '/admin' || pathname === '/admin/') req.url = `/index.html${search}`;
                next();
            });
        },
    };
}

/** TILE_FILE from src/campusMap.js: the campus base map archive the app reads. */
function campusTileFile() {
    const source = fs.readFileSync(path.resolve('src/campusMap.js'), 'utf8');
    const match = /export const TILE_FILE = '([\w-]+\.pmtiles)'/.exec(source);
    if (!match) throw new Error("src/campusMap.js must define export const TILE_FILE = '<name>.pmtiles'");
    return match[1];
}

/**
 * Writes public/sw.js (the /map app's service worker) on every build, from
 * resources/pwa/service-worker.js plus the files the "map" entry loads: its
 * chunks, the chunks it imports later (3D and AR views), their CSS and assets.
 * The admin console's own files are left out, so phones only store what they use.
 */
function mapServiceWorker() {
    let base = '/';
    return {
        name: 'arnode-map-service-worker',
        apply: 'build',
        configResolved(config) { base = config.base; },
        generateBundle(_options, bundle) {
            const files = new Set();
            const visit = (fileName) => {
                const item = bundle[fileName];
                if (!item || files.has(fileName)) return;
                files.add(fileName);
                if (item.type !== 'chunk') return;
                [...item.imports, ...item.dynamicImports].forEach(visit);
                item.viteMetadata?.importedCss?.forEach((f) => files.add(f));
                item.viteMetadata?.importedAssets?.forEach((f) => files.add(f));
            };
            Object.values(bundle)
                .filter((item) => item.type === 'chunk' && item.isEntry && item.name === 'map')
                .forEach((entry) => visit(entry.fileName));

            const urls = [...files].sort().map((f) => base + f);
            const source = fs.readFileSync(path.resolve('resources/pwa/service-worker.js'), 'utf8');
            const tileFile = campusTileFile();
            // The version changes when the code, the worker, the logo/icons, the manifest or the
            // campus map file change, so installed phones replace their saved copy.
            const hash = createHash('sha256').update(urls.join('\n')).update(source);
            const pwaDir = path.resolve('public/pwa');
            const saved = [
                ...(fs.existsSync(pwaDir) ? fs.readdirSync(pwaDir).sort().map((f) => path.join(pwaDir, f)) : []),
                path.resolve('public/map-manifest.json'), path.resolve('public/favicon.ico'), path.resolve(`storage/app/${tileFile}`),
            ];
            saved.filter((f) => fs.existsSync(f)).forEach((f) => hash.update(fs.readFileSync(f)));
            const version = hash.digest('hex').slice(0, 12);
            const worker = source
                .replace("'__ARNODE_VERSION__'", JSON.stringify(version))
                .replace("'__ARNODE_TILES__'", JSON.stringify(`/${tileFile}`))
                .replace('self.__ARNODE_PRECACHE__', JSON.stringify(urls, null, 4));
            fs.writeFileSync(path.resolve('public/sw.js'),
                `/* GENERATED by \`npm run build\` from resources/pwa/service-worker.js. Do not edit. */\n${worker}`);
        },
    };
}

export default defineConfig(({ mode, command }) => {
    const env = loadEnv(mode, process.cwd(), '');
    // Extra Host names the dev server accepts (e.g. a tunnel such as ngrok),
    // comma-separated: VITE_ALLOWED_HOSTS=my-tunnel.ngrok-free.dev
    // Vite blocks unknown Host headers by default and only accepts exact names.
    const allowedHosts = (env.VITE_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);

    return {
    // mapServiceWorker writes public/sw.js (the installable /map app's offline copy) on every build.
    plugins: [react(), syncLogo(), mapServiceWorker(), devRoutes()],
    root: '.',
    // The build lives in public/admin/, so its asset URLs must start with
    // /admin/ (the dev server keeps serving from /).
    base: command === 'build' ? '/admin/' : '/',
    // Do not copy Laravel's public/ (index.php, the storage link) into the
    // build: a copied index.php made /admin/ answer 500.
    publicDir: false,
    build: {
        outDir: 'public/admin',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: 'index.html',
                map: 'map.html',
                // /iphone-check: the install check form for iPhone users (plain page, no React).
                check: 'iphone-check.html',
            },
            output: {
                // Libraries change far less often than the app's own code. In files of their own,
                // an app update leaves them saved on the phone: only the changed app code is downloaded
                // again. three stays apart because only the 3D and AR views (loaded on demand) use it.
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined;
                    if (/[\\/]node_modules[\\/]three[\\/]/.test(id)) return 'three';
                    if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
                    if (/[\\/]node_modules[\\/]qrcode-generator[\\/]/.test(id)) return undefined; // the QR sheet loads it on demand
                    return 'maps'; // Leaflet, Protomaps and what they need
                },
            },
        },
    },
    server: {
        host: '0.0.0.0',
        port: 5173,
        allowedHosts: true,
        proxy: {
            // The API stays local: the tunnel only needs to reach Vite, and
            // Vite forwards /api to the Laravel backend (port 8005).
            //
            // Keep every target below in sync with the `php artisan serve`
            // port in package.json. A stale port here fails silently: Vite
            // answers with 500 and the frontend sees a dead API rather than
            // a connection error.
            '/api': {
                target: 'http://localhost:8005',
                changeOrigin: true,
            },
            '/sanctum': {
                target: 'http://localhost:8005',
                changeOrigin: true,
            },
            // Campus vector tiles: same backend as /api (relative URL works
            // in both dev and production builds). One pattern for every archive
            // (university.pmtiles, ...): an archive the proxy
            // misses is answered with index.html, and PMTiles then fails with
            // "Wrong magic number" and renders an empty grid.
            '^/[\\w-]+\\.pmtiles$': {
                target: 'http://localhost:8005',
                changeOrigin: true,
            },
            // Logo files (favicons, app icons, install manifest) live in Laravel's public/,
            // which the dev server does not serve (publicDir: false).
            '/favicon.ico': { target: 'http://localhost:8005', changeOrigin: true },
            '/pwa': { target: 'http://localhost:8005', changeOrigin: true },
            '/map-manifest.json': { target: 'http://localhost:8005', changeOrigin: true },
        },
    },
    };
});
