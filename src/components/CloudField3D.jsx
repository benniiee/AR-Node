import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import * as THREE from 'three';
import { cloudDeck, cloudShape, cloudSkyMode, seededRandom } from '../cloudSky';
import { CAMPUS_CENTER, campusLatLngBounds } from '../campusMap';
import { sunPosition } from '../sunShadow';

/**
 * The real-time 3D sky over the 2D map.
 *
 * The canvas lives in its own Leaflet pane (`cloudSky`, z-index 398), not on top of the map:
 * the whole Leaflet map pane is one stacking context at z-index 400, so a normal element –
 * however high its z-index – can only sit below or above every marker, label and route. As a
 * pane, the clouds slot in exactly where they belong: above the 2.5D buildings (395–397) and
 * below campus labels and the route (399), the floor guide (410) and the pins (600).
 *
 * Each cloud is anchored to a latitude/longitude inside the campus box with a real width in
 * metres, exactly as a building is anchored by its outline and its height. Panning and zooming
 * therefore never move or re-size the deck: the projection draws each cloud at the zoom the map
 * is drawn at, so one zoom step grows a cloud by the same factor as the buildings under it.
 * Mid-zoom the canvas rides Leaflet's own zoom animation (the `zoomanim` event, as a marker does),
 * so a cloud never slides off the ground it belongs to. They drift west at a real wind speed and
 * re-enter from the east edge of the campus.
 *
 * They are drawn the way the 2.5D buildings are: extruded up-screen (north) from their ground
 * point and squashed to the map's tilt, with a soft shadow below them, so they sit on the map
 * instead of looking like flat stickers on top of it. Each puff is lit from where the sun
 * actually stands over the campus (sunShadow.sunPosition, the call the buildings' walls are
 * shaded by), so a high sun lights the tops and a low one lights the side facing it while the
 * rest falls into shade - the same rule, so the volume matches the buildings'. Their shadow
 * falls away from the sun too. Every cloud has its own seeded shape (cloudSky.js), so none of
 * them is the same as the rest. They drift straight west at a gentle speed.
 *
 * Weather decides what they do, from the app's own state (useWeather):
 *   - raining now: clouds darken and pour rain from their flat base
 *   - heat mode:   the sun burns through them, with a slow warm glow and rotating rays
 *   - rain likely: grey, heavier clouds, still dry
 *   - otherwise:   soft white clouds
 *
 * Purely decorative: no pointer events, nothing for a screen reader, nothing to tap. three.js
 * loads with this file's chunk, only from the map screens. Rendering pauses while the tab is
 * hidden, holds still under prefers-reduced-motion, and cleans up on unmount.
 */

// The pane the clouds are drawn in. 398 is between campusFrontObjects (397) and campusTop
// (399): labels and the route stay above the clouds, the buildings stay below them.
const PANE = 'cloudSky';
const PANE_Z = 398;

// The map's 2.5D tilt: buildings lift straight up-screen, and so do clouds. 0.55 is the
// vertical squash that matches how tall the extruded buildings read at the same tilt.
const TILT = 0.9;
// Extra canvas around the viewport, so a cloud sliding in from the edge is never clipped.
const MARGIN = 140;
const RAIN_DROPS = 80;
// Share of the screen a cloud may cover before it starts thinning out, and where it is gone. A cloud
// is drawn at its real width (55-110 m), so a deep zoom puts one overhead; capping its size instead
// would make it swell and snap back during every pinch, so it fades rather than shrink.
const CLOUD_OVERHEAD_SHARE = 0.55;
const CLOUD_GONE_SHARE = 1.05;
const RAIN_SPAN = 3.2;

// Opacities sit at or near 1: a cumulus is a solid body, and translucent lobes showed their
// own sphere edges through each other as grey rings. Only the weather thins one out.
// `color` is the sunlit body, `shade` the hollows and undersides: a cumulus is white on top and
// cool blue-grey underneath, never one flat grey.
const PALETTES = {
    clear: { color: 0xffffff, shade: 0xb4c4da, haze: 0xdfe9f7, opacity: 1, drift: 1, shadow: 0.14 },
    overcast: { color: 0xd9e0eb, shade: 0x8c99ac, haze: 0xd9e2ef, opacity: 1, drift: 1.2, shadow: 0.2 },
    rain: { color: 0xacb8c9, shade: 0x6d7989, haze: 0xcdd8e7, opacity: 0.99, drift: 1.45, shadow: 0.26 },
    heat: { color: 0xfffaf0, shade: 0xd7c7a6, haze: 0xffe7bb, opacity: 0.97, drift: 0.7, shadow: 0.18 },
};

/** Metres per degree of longitude at this latitude. */
function metresPerDegreeLng(lat) {
    const metres = 111320 * Math.cos((lat * Math.PI) / 180);
    return Math.abs(metres) || 1;
}

/** A soft sun: warm disc, halo and long rays, drawn once into a sprite texture. */
function sunTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return null;
    }
    const glow = ctx.createRadialGradient(128, 128, 8, 128, 128, 126);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    glow.addColorStop(0.2, 'rgba(255, 246, 214, 0.9)');
    glow.addColorStop(0.5, 'rgba(255, 219, 150, 0.32)');
    glow.addColorStop(1, 'rgba(255, 196, 120, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    ctx.translate(128, 128);
    for (let i = 0; i < 12; i += 1) {
        ctx.rotate(Math.PI / 6);
        const ray = ctx.createLinearGradient(0, 0, 0, -126);
        ray.addColorStop(0, 'rgba(255, 238, 196, 0.45)');
        ray.addColorStop(1, 'rgba(255, 226, 160, 0)');
        ctx.fillStyle = ray;
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.lineTo(0, -126);
        ctx.lineTo(6, 0);
        ctx.closePath();
        ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

/** The soft pool of shadow a cloud casts on the map below it. */
function shadowTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return null;
    }
    const pool = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    pool.addColorStop(0, 'rgba(18, 26, 42, 0.55)');
    pool.addColorStop(0.55, 'rgba(18, 26, 42, 0.24)');
    pool.addColorStop(1, 'rgba(18, 26, 42, 0)');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

/**
 * @param {{ weather?: object, mapRef?: { current: object|null } }} props
 *        `weather` is the live useWeather state; `mapRef` is the screen's Leaflet map ref
 *        (MobileNav / AdminMap), which anchors every cloud to its own lat / lng.
 */
export default function CloudField3D({ weather, mapRef }) {
    const mode = cloudSkyMode(weather);
    const modeRef = useRef(mode);

    useEffect(() => {
        modeRef.current = mode;
    }, [mode]);

    useEffect(() => {
        let stopped = false;
        let teardown = null;

        const boot = () => {
            if (stopped) {
                return;
            }
            const map = mapRef ? mapRef.current : null;
            if (!map) {
                window.setTimeout(boot, 150);
                return;
            }
            teardown = start(map);
        };

        const start = (map) => {
            const container = map.getContainer();
            if (!container) {
                return null;
            }

            if (!map.getPane(PANE)) {
                const created = map.createPane(PANE);
                created.style.zIndex = String(PANE_Z);
            }
            const pane = map.getPane(PANE);
            pane.style.pointerEvents = 'none';

            const canvas = document.createElement('canvas');
            // leaflet-zoom-animated: transform-origin top left, plus Leaflet's own 0.25 s transform
            // transition while a zoom runs. Without it the canvas is the one layer on the map that
            // does not move with the gesture.
            canvas.className = 'cloud-field-3d leaflet-zoom-animated';
            canvas.setAttribute('aria-hidden', 'true');
            canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
            pane.appendChild(canvas);

            let renderer;
            try {
                renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
            } catch {
                canvas.remove();
                return null; // No WebGL: the map simply has no sky, never a broken page.
            }
            renderer.setClearColor(0x000000, 0);

            const scene = new THREE.Scene();
            // World units are CSS pixels of the canvas, so a cloud's size and its point on the
            // map are both expressed in pixels and move with the map's own projection.
            // Wide depth range on purpose: a cloud is scaled up around its centre, so at a deep
            // zoom its lobes reach hundreds of pixels towards the camera. With the old narrow range
            // they crossed the near plane and were clipped away, which is what turned a cloud into
            // a hollow ring. The range is only used for draw order here, so size costs nothing.
            const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -2000, 4000);
            camera.position.z = 100;

            // ── The sun ────────────────────────────────────────────────────
            // Each puff is lit from where the sun actually stands over the campus, never from a
            // fixed corner: x is east, y is north (up-screen, the way the 2.5D lift goes) and z is
            // straight up from the map. A high sun lights the tops of the lobes, a low one lights
            // the side facing it and leaves the other in shade, so a cloud has the volume the
            // buildings get from their walls - and its pool of shade is thrown the other way.
            const sunDirection = new THREE.Vector3(0.4, 0.5, 0.75).normalize();
            const sunState = { awayEast: -0.4, awayNorth: -0.5, shadowReach: 0.16 };
            const aimAtSun = (nowMs) => {
                const sun = sunPosition(new Date(nowMs), CAMPUS_CENTER[0], CAMPUS_CENTER[1]);
                const alt = Math.max(0, Math.min(88, sun.altitudeDeg)) * (Math.PI / 180);
                const az = sun.azimuthDeg * (Math.PI / 180);
                sunDirection.set(Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt));
                // Shade falls directly away from the sun, and further the lower it sits.
                sunState.awayEast = -Math.sin(az);
                sunState.awayNorth = -Math.cos(az);
                sunState.shadowReach = Math.min(0.45, 0.14 / Math.max(0.13, Math.tan(alt)));
            };

            // ── Shading a puff ─────────────────────────────────────────────
            // Lambert lighting on squashed spheres only ever gave flat grey ovals: the squash tilts
            // every normal sideways, so nothing faced the light. The body is shaded directly instead,
            // in the cloud's own axes (no lighting, no normal distortion): bright where it faces up
            // at the sky, sunlit on the side the sun is on, cool grey in the hollows, with a faint
            // bright rim along the silhouette - the way a real cumulus reads from above.
            // ── Realistic cloud shading ──────────────────────────────────
            // Vertex shader displaces sphere vertices with layered simplex-like noise so each
            // puff has a cauliflower surface instead of a smooth balloon. The noise is seeded
            // by the puff's world position (via uSeed) so no two puffs share a bump pattern.
            // The fragment shader adds:
            //   - soft ambient occlusion approximation (darker in hollows facing down)
            //   - subsurface scattering rim (warm glow where light passes through thin edges)
            //   - multi-octave detail lighting so the surface reads as textured, not flat
            //   - view-dependent Fresnel brightening on silhouette edges
            const CLOUD_VERTEX = `
                uniform float uSeed;
                varying vec3 vNormal;
                varying vec3 vWorldPos;
                varying float vDisplacement;

                // Simple 3D hash for vertex displacement (no texture needed).
                vec3 hash3(vec3 p) {
                    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
                             dot(p, vec3(269.5, 183.3, 246.1)),
                             dot(p, vec3(113.5, 271.9, 124.6)));
                    return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
                }

                // Gradient noise (smooth, no grid artefacts at this scale).
                float gnoise(vec3 p) {
                    vec3 i = floor(p);
                    vec3 f = fract(p);
                    vec3 u = f * f * (3.0 - 2.0 * f);
                    return mix(
                        mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                                dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                            mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                                dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
                        mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                                dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                            mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                                dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y),
                        u.z);
                }

                // Fractal Brownian motion: three octaves give cauliflower detail.
                float fbm(vec3 p) {
                    float v = 0.0;
                    float a = 0.5;
                    for (int i = 0; i < 3; i++) {
                        v += a * gnoise(p);
                        p *= 2.1;
                        a *= 0.45;
                    }
                    return v;
                }

                void main() {
                    vec3 n = normalize(normal);
                    // Seed the noise by the puff's own position so neighbours differ.
                    vec3 noisePos = position * 3.2 + vec3(uSeed);
                    float disp = fbm(noisePos) * 0.12;
                    // Extra high-frequency bumps on the top (the face the viewer sees).
                    float topBump = max(0.0, n.z) * gnoise(position * 7.0 + vec3(uSeed * 1.3)) * 0.06;
                    float totalDisp = disp + topBump;
                    vec3 displaced = position + n * totalDisp;
                    vNormal = n;
                    vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
                    vDisplacement = totalDisp;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
                }
            `;
            const CLOUD_FRAGMENT = `
                uniform vec3 uLight;
                uniform vec3 uBody;
                uniform vec3 uShade;
                uniform float uOpacity;
                varying vec3 vNormal;
                varying vec3 vWorldPos;
                varying float vDisplacement;
                void main() {
                    vec3 n = normalize(vNormal);

                    // How much this face looks up at the viewer / sky.
                    float up = clamp(n.z, 0.0, 1.0);

                    // Direct sun contribution: half-Lambert wrap so the shade side is never black.
                    float sun = clamp(dot(n, uLight) * 0.5 + 0.5, 0.0, 1.0);
                    sun = pow(sun, 0.85);  // soften the falloff

                    // Ambient-occlusion approximation: hollows (displaced inward) are darker.
                    float ao = smoothstep(-0.1, 0.08, vDisplacement);

                    // Combined lighting: sky-facing brightness, sun contribution, and AO.
                    float lit = clamp(up * 0.68 + sun * 0.42, 0.0, 1.0) * (0.72 + ao * 0.28);

                    // Base colour: shade in hollows, body colour on lit surfaces.
                    vec3 color = mix(uShade, uBody, smoothstep(0.08, 0.85, lit));

                    // Subsurface-scattering rim: thin edges glow warm where backlit.
                    float sss = pow(clamp(1.0 - up, 0.0, 1.0), 2.5);
                    float backlight = clamp(dot(-n, uLight), 0.0, 1.0);
                    color += vec3(1.0, 0.97, 0.92) * sss * backlight * 0.22;

                    // Fresnel brightening: silhouette edges catch ambient skylight.
                    float fresnel = pow(1.0 - up, 4.0);
                    color = mix(color, vec3(1.0), fresnel * 0.18);

                    // Displacement-based detail: bumps catch a little extra light.
                    color += vec3(1.0) * clamp(vDisplacement * 2.0, 0.0, 1.0) * 0.06;

                    gl_FragColor = vec4(color, uOpacity);
                }
            `;
            // Every cloud's uLight is this same vector, so one aim in the sun update moves them all.
            // uSeed is unique per puff, set when the mesh is created: it offsets the noise field
            // so adjoining puffs in one cloud don't share their bump pattern.
            const newCloudMaterial = (puffSeed = 0) => new THREE.ShaderMaterial({
                uniforms: {
                    uLight: { value: sunDirection },
                    uBody: { value: new THREE.Color(0xffffff) },
                    uShade: { value: new THREE.Color(0xb4c4da) },
                    uOpacity: { value: 1 },
                    uSeed: { value: puffSeed },
                },
                vertexShader: CLOUD_VERTEX,
                fragmentShader: CLOUD_FRAGMENT,
                transparent: true,
                depthWrite: true,
            });

            // Higher resolution sphere: 28×18 segments give smooth cauliflower bumps from the
            // noise displacement, while staying cheap enough for 18 clouds × ~8 lobes each.
            const sphere = new THREE.SphereGeometry(1, 28, 18);
            const seed = Math.floor(Math.random() * 4294967295) || 1;
            const reduceMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

            const deck = cloudDeck(seed);
            const clouds = deck.map((spec) => {
                const shape = cloudShape(spec.seed);
                const group = new THREE.Group();
                const materials = [];
                const puffRand = seededRandom(spec.seed + 42);

                // Main lobes: each gets its own material so its noise seed differs.
                for (const lobe of shape.lobes) {
                    const puffSeed = puffRand() * 1000;
                    const material = newCloudMaterial(puffSeed);
                    materials.push(material);
                    const puff = new THREE.Mesh(sphere, material);
                    puff.position.set(lobe.x, lobe.y, lobe.z);
                    puff.scale.setScalar(lobe.r);
                    group.add(puff);
                }

                // Extra detail puffs: small bumps around and on top of the main lobes to create
                // the cauliflower texture cumulus clouds have when seen from above, without
                // stretching the silhouette vertically.
                const detailCount = Math.min(shape.lobes.length, 3 + Math.floor(puffRand() * 4));
                for (let d = 0; d < detailCount; d += 1) {
                    const parent = shape.lobes[Math.floor(puffRand() * shape.lobes.length)];
                    const angle = puffRand() * Math.PI * 2;
                    const r = parent.r * (0.28 + puffRand() * 0.28);
                    const lift = parent.r * (0.15 + puffRand() * 0.55);
                    const spread = parent.r * (0.35 + puffRand() * 0.45);
                    const puffSeed = puffRand() * 1000;
                    const material = newCloudMaterial(puffSeed);
                    materials.push(material);
                    const detail = new THREE.Mesh(sphere, material);
                    detail.position.set(
                        parent.x + Math.cos(angle) * spread,
                        Math.max(r, parent.y + lift),
                        parent.z + Math.sin(angle) * spread * 0.45 + r * 0.3,
                    );
                    detail.scale.setScalar(r);
                    group.add(detail);
                }

                scene.add(group);
                return {
                    spec, shape, materials, group,
                    lat: 0,
                    lng: 0,
                    px: 0,
                    // Faded down for weather and when the cloud is directly overhead.
                    opacity: 1,
                    speedMps: spec.speedMps,
                    // How many times this cloud has crossed: only used to seed its next latitude,
                    // so a returning cloud lands somewhere new without a new random deck.
                    turns: 0,
                    rain: null,
                    rainGeometry: null,
                    rainMaterial: null,
                    drops: null,
                    shadow: null,
                };
            });

            const shadowMap = shadowTexture();
            const shadowMaterial = shadowMap ? new THREE.SpriteMaterial({
                map: shadowMap, color: 0x22304a, transparent: true, opacity: 0.12, depthWrite: false,
            }) : null;
            for (const cloud of clouds) {
                if (!shadowMaterial) {
                    break;
                }
                const shadow = new THREE.Sprite(shadowMaterial);
                scene.add(shadow);
                cloud.shadow = shadow;
            }

            // Rain is created the first time it is needed, then kept (faded out) for later.
            const ensureRain = (cloud) => {
                if (cloud.rain) {
                    return;
                }
                const rand = seededRandom(cloud.spec.seed + 101);
                const drops = new Float32Array(RAIN_DROPS * 4); // x, z, y, fall speed
                const positions = new Float32Array(RAIN_DROPS * 6);
                for (let i = 0; i < RAIN_DROPS; i += 1) {
                    drops[i * 4] = (rand() - 0.5) * 1.1;
                    drops[i * 4 + 1] = (rand() - 0.5) * 0.45;
                    drops[i * 4 + 2] = -rand() * RAIN_SPAN;
                    drops[i * 4 + 3] = 2.6 + rand() * 3.4;
                }
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                const material = new THREE.LineBasicMaterial({
                    color: 0xbed7ff, transparent: true, opacity: 0, depthWrite: false,
                });
                const lines = new THREE.LineSegments(geometry, material);
                lines.frustumCulled = false;
                scene.add(lines);
                cloud.rain = lines;
                cloud.rainGeometry = geometry;
                cloud.rainMaterial = material;
                cloud.drops = drops;
            };

            // Without a canvas texture there is no sun at all: never a plain white sprite.
            const sunMap = sunTexture();
            const sunMaterial = sunMap ? new THREE.SpriteMaterial({
                map: sunMap,
                color: 0xfff0cf,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            }) : null;
            const sun = sunMaterial ? new THREE.Sprite(sunMaterial) : null;
            if (sun) {
                sun.visible = false;
                scene.add(sun);
            }

            const targetColor = new THREE.Color();
            const hazeColor = new THREE.Color();

            // The canvas covers the viewport plus a margin, positioned in the pane's own layer
            // coordinates around the current centre, so the clouds stay glued to the map.
            let width = 0;
            let height = 0;
            let viewWidth = 0;
            let originX = 0;
            let originY = 0;
            // The lat/lng of the canvas's top-left corner: with it, the canvas can be placed at any
            // zoom, which is how it rides a zoom animation (see onZoomAnim).
            let anchor = map.getCenter();
            // True while Leaflet is running a zoom: the canvas is then being scaled by its own
            // transform and must not be redrawn or repositioned until the zoom settles.
            let animating = false;

            const resize = () => {
                const cssWidth = Math.max(1, container.clientWidth + MARGIN * 2);
                const cssHeight = Math.max(1, container.clientHeight + MARGIN * 2);
                viewWidth = Math.max(1, container.clientWidth);
                if (cssWidth === width && cssHeight === height) {
                    return;
                }
                width = cssWidth;
                height = cssHeight;
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
                renderer.setSize(width, height, false);
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
                camera.left = 0;
                camera.right = width;
                camera.top = height;
                camera.bottom = 0;
                camera.updateProjectionMatrix();
            };
            resize();
            const observer = new ResizeObserver(resize);
            observer.observe(container);

            // ── The sky's piece of campus ──────────────────────────────────
            // The cloud deck covers the campus box (the same one every map is locked to, and the
            // one the buildings and sun shadows are drawn in), never the screen. That is the whole
            // point: the view moves and zooms over a fixed sky, so a cloud keeps its place over the
            // campus and its real size, however the map is zoomed.
            const region = campusLatLngBounds();
            const regionWest = region.getWest();
            const regionSouth = region.getSouth();
            const regionEast = region.getEast();
            const regionNorth = region.getNorth();
            const regionSpanLng = regionEast - regionWest;
            const regionSpanLat = regionNorth - regionSouth;

            // Spread the deck over the campus in a grid (five columns, as many rows as the deck
            // needs - four for eighteen clouds), jittered inside each cell, so the whole box carries
            // clouds instead of them queueing along one edge. Seeded, so the same session keeps its
            // clouds in the same places however often the map is zoomed.
            const DECK_COLS = 5;
            const placeDeck = () => {
                const rand = seededRandom(seed + 7);
                const rows = Math.ceil(clouds.length / DECK_COLS);
                clouds.forEach((cloud, index) => {
                    const col = index % DECK_COLS;
                    const row = Math.floor(index / DECK_COLS);
                    cloud.lng = regionWest + ((col + 0.08 + rand() * 0.84) / DECK_COLS) * regionSpanLng;
                    cloud.lat = regionSouth + ((row + 0.05 + rand() * 0.9) / rows) * regionSpanLat;
                    cloud.px = 0;
                });
            };
            placeDeck();

            // A cloud that drifted off the west edge comes back over the east edge at a new
            // latitude. Its width and speed stay its own, so it is the same cloud returning rather
            // than a new one popping in.
            const respawn = (cloud) => {
                cloud.turns += 1;
                const rand = seededRandom((cloud.spec.seed + cloud.turns * 2654435761) >>> 0);
                cloud.lat = regionSouth + (0.06 + rand() * 0.88) * regionSpanLat;
                cloud.lng = regionEast + rand() * regionSpanLng * 0.08;
            };

            const updateRain = (cloud, dt) => {
                const { drops, rainGeometry, shape } = cloud;
                const positions = rainGeometry.attributes.position.array;
                const halfSpan = shape.span * 0.42;
                for (let i = 0; i < RAIN_DROPS; i += 1) {
                    drops[i * 4 + 2] -= drops[i * 4 + 3] * dt;
                    if (drops[i * 4 + 2] < -RAIN_SPAN) {
                        drops[i * 4 + 2] = 0;
                    }
                    const x = drops[i * 4] * halfSpan;
                    const y = drops[i * 4 + 2];
                    const z = drops[i * 4 + 1] + 0.3;
                    const at = i * 6;
                    positions[at] = x;
                    positions[at + 1] = y;
                    positions[at + 2] = z;
                    positions[at + 3] = x + 0.12; // a slight lean, as if blown
                    positions[at + 4] = y + 0.42;
                    positions[at + 5] = z;
                }
                rainGeometry.attributes.position.needsUpdate = true;
            };

            let raf = 0;
            let last = performance.now();
            let lastSunAt = 0;
            let renderedMode = '';

            const frame = (now) => {
                raf = window.requestAnimationFrame(frame);
                const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
                last = now;
                const current = modeRef.current;
                // Mid-zoom Leaflet already moved the map to the new zoom while the screen still shows
                // the animated in-between state: drawing now would land at the wrong scale. The canvas
                // keeps its old drawing, scaled by the transform, exactly like the tiles do.
                if (document.hidden || !width || !height || animating) {
                    return;
                }
                // Reduced motion keeps the sky still: draw again only when the weather changes.
                if (reduceMotion && current === renderedMode) {
                    return;
                }
                renderedMode = current;

                // The sun moves slowly: four times a minute is plenty, and it keeps the sun maths
                // off the per-frame path on a phone.
                if (now - lastSunAt > 15000) {
                    lastSunAt = now;
                    aimAtSun(now);
                }

                const time = now / 1000;
                const palette = PALETTES[current] || PALETTES.clear;
                const ease = dt > 0 ? 1 - Math.exp(-dt * 2.2) : 1;
                const animate = reduceMotion ? 0 : 1;

                // The canvas follows the map centre in leaflet's layer coordinates: the pane is
                // inside the map pane, so anything placed in layer coordinates moves with the
                // map on its own, and redrawing uses those same coordinates.
                const centre = map.getCenter();
                const worldOrigin = map.latLngToLayerPoint(centre);
                const nextOriginX = worldOrigin.x - width / 2;
                const nextOriginY = worldOrigin.y - height / 2;
                if (nextOriginX !== originX || nextOriginY !== originY) {
                    originX = nextOriginX;
                    originY = nextOriginY;
                    anchor = map.layerPointToLatLng(L.point(originX, originY));
                    // A transform, not left/top: the zoom animation scales this same transform.
                    L.DomUtil.setPosition(canvas, L.point(originX, originY));
                }

                for (const cloud of clouds) {
                    // Drift west in real metres, so the cloud stays over the campus as the map moves.
                    cloud.lng -= (cloud.speedMps * palette.drift * animate * dt) / metresPerDegreeLng(cloud.lat);

                    // Past the west edge of the campus it comes back over the east edge, at a new
                    // latitude: the deck keeps its size and its own clouds for as long as the map
                    // is open, and never re-randomises because the view changed.
                    if (cloud.lng < regionWest) {
                        respawn(cloud);
                    }

                    const ground = map.latLngToLayerPoint([cloud.lat, cloud.lng]);
                    const pointX = ground.x - originX;
                    const pointY = ground.y - originY;

                    // Its real width, projected the way the map projects everything else (metres ->
                    // degrees at its own latitude -> layer points), so zooming grows it with the
                    // buildings under it. No easing and no cap: a pinch must not leave the cloud at a
                    // size the map disagrees with, or it would swell on the way in and snap back.
                    const eastGround = map.latLngToLayerPoint([
                        cloud.lat,
                        cloud.lng + cloud.spec.widthM / metresPerDegreeLng(cloud.lat),
                    ]);
                    const fitted = Math.max(1, Math.abs(eastGround.x - ground.x));
                    cloud.px = fitted;
                    // Wide enough to be directly overhead (a deep zoom under a 55-110 m cloud): it
                    // thins out instead of covering the campus with white.
                    const overhead = Math.min(1, Math.max(0,
                        (fitted / viewWidth - CLOUD_OVERHEAD_SHARE) / (CLOUD_GONE_SHARE - CLOUD_OVERHEAD_SHARE)));
                    const unit = cloud.px / cloud.shape.span;
                    // Straight west at a steady height: a cloud keeps its latitude and its line on
                    // the map, with no bobbing and no drifting off course.
                    const baseY = height - pointY;
                    const onScreen = pointX + cloud.px / 2 > 0
                        && pointX - cloud.px / 2 < width
                        && baseY > -20
                        && baseY - cloud.shape.height * unit * TILT < height + 20;

                    cloud.group.visible = onScreen;
                    if (cloud.rain) {
                        cloud.rain.visible = false;
                    }
                    if (cloud.shadow) {
                        cloud.shadow.visible = onScreen;
                    }
                    if (!onScreen) {
                        continue;
                    }

                    // 2.5D: the cluster rises straight up-screen from its ground point (the same
                    // north lift the buildings use) and is squashed to the map's tilt.
                    cloud.group.position.set(pointX, baseY, -1 - cloud.spec.depth * 4);
                    cloud.group.scale.set(unit, unit * TILT, unit * 0.9);

                    // Distant clouds sit a little further into the haze than near ones.
                    const hazeMix = (1 - cloud.spec.depth) * 0.5;
                    targetColor.setHex(palette.color).lerp(hazeColor.setHex(palette.haze), hazeMix);
                    const bodyTarget = targetColor.clone();
                    targetColor.setHex(palette.shade).lerp(hazeColor.setHex(palette.haze), hazeMix * 0.6);
                    const shadeTarget = targetColor.clone();
                    cloud.opacity += ((0.97 + cloud.spec.depth * 0.03) * palette.opacity * (1 - overhead) - cloud.opacity) * ease;
                    for (const mat of cloud.materials) {
                        mat.uniforms.uBody.value.lerp(bodyTarget, ease);
                        mat.uniforms.uShade.value.lerp(shadeTarget, ease);
                        mat.uniforms.uOpacity.value = cloud.opacity;
                    }
                    cloud.group.visible = cloud.opacity > 0.01;

                    if (cloud.shadow) {
                        cloud.shadow.visible = cloud.opacity > 0.02;
                        // Pooled below the footprint and thrown away from the sun, the way the
                        // buildings' shadows fall at this hour.
                        const reach = cloud.px * sunState.shadowReach;
                        cloud.shadow.position.set(
                            pointX - cloud.px * 0.04 + sunState.awayEast * reach,
                            baseY - cloud.px * 0.06 + sunState.awayNorth * reach,
                            -7,
                        );
                        cloud.shadow.scale.set(cloud.px * 0.95, cloud.px * 0.32, 1);
                    }

                    if (current === 'rain') {
                        ensureRain(cloud);
                    }
                    if (cloud.rain && cloud.rainMaterial) {
                        cloud.rainMaterial.opacity += ((0.34 + cloud.spec.depth * 0.28) * (current === 'rain' ? 1 : 0) - cloud.rainMaterial.opacity) * ease;
                        cloud.rain.visible = cloud.rainMaterial.opacity > 0.01;
                        if (cloud.rain.visible) {
                            cloud.rain.position.set(pointX, baseY, -0.6);
                            cloud.rain.scale.setScalar(unit);
                            if (animate) {
                                updateRain(cloud, dt);
                            }
                        }
                    }
                }

                if (shadowMaterial) {
                    shadowMaterial.opacity += (palette.shadow - shadowMaterial.opacity) * ease;
                }

                if (sun && sunMaterial) {
                    sunMaterial.opacity += ((current === 'heat' ? 1 : 0) - sunMaterial.opacity) * ease;
                    sun.visible = sunMaterial.opacity > 0.01;
                    if (sun.visible) {
                        sun.position.set(width * 0.8, height * 0.82, -30);
                        sun.scale.setScalar(Math.min(width, height) * 0.55);
                        sunMaterial.rotation = time * 0.035 * animate;
                    }
                }

                renderer.render(scene, camera);
            };

            // ── Riding a zoom ──────────────────────────────────────────────
            // Leaflet animates every layer itself through `zoomanim` (tile levels, markers and image
            // overlays scale their own element and let CSS carry the transition). A canvas that only
            // positioned itself stayed put while the map grew underneath it, then jumped into place
            // when the zoom ended - a cloud appearing over the wrong building for the whole gesture.
            // So do what a marker does: move the canvas, at the new scale, to where the new view puts
            // its top-left corner, and leave the drawing inside alone until `zoomend`.
            const onZoomAnim = (event) => {
                animating = true;
                const scale = map.getZoomScale(event.zoom);
                const pos = map._latLngToNewLayerPoint(anchor, event.zoom, event.center);
                L.DomUtil.setTransform(canvas, pos, scale);
            };
            const onZoomEnd = () => {
                animating = false;
                const next = map.latLngToLayerPoint(anchor);
                originX = next.x;
                originY = next.y;
                L.DomUtil.setTransform(canvas, next, 1);
            };
            map.on('zoomanim', onZoomAnim);
            map.on('zoomend', onZoomEnd);

            const onContextLost = (event) => {
                event.preventDefault();
                window.cancelAnimationFrame(raf);
            };
            canvas.addEventListener('webglcontextlost', onContextLost);
            raf = window.requestAnimationFrame(frame);

            return () => {
                window.cancelAnimationFrame(raf);
                map.off('zoomanim', onZoomAnim);
                map.off('zoomend', onZoomEnd);
                observer.disconnect();
                canvas.removeEventListener('webglcontextlost', onContextLost);
                for (const cloud of clouds) {
                    for (const mat of cloud.materials) {
                        mat.dispose();
                    }
                    if (cloud.rainGeometry) {
                        cloud.rainGeometry.dispose();
                    }
                    if (cloud.rainMaterial) {
                        cloud.rainMaterial.dispose();
                    }
                }
                sphere.dispose();
                if (shadowMaterial) {
                    shadowMaterial.dispose();
                }
                if (shadowMap) {
                    shadowMap.dispose();
                }
                if (sunMaterial) {
                    sunMaterial.dispose();
                }
                if (sunMap) {
                    sunMap.dispose();
                }
                renderer.dispose();
                canvas.remove();
            };
        };

        boot();

        return () => {
            stopped = true;
            if (teardown) {
                teardown();
            }
        };
    }, [mapRef]);

    return null;
}
