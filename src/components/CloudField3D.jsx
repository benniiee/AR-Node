import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { cloudDeck, cloudShape, cloudSkyMode, seededRandom } from '../cloudSky';

/**
 * The real-time 3D sky over the 2D map.
 *
 * The canvas lives in its own Leaflet pane (`cloudSky`, z-index 398), not on top of the map:
 * the whole Leaflet map pane is one stacking context at z-index 400, so a normal element –
 * however high its z-index – can only sit below or above every marker, label and route. As a
 * pane, the clouds slot in exactly where they belong: above the 2.5D buildings (395–397) and
 * below campus labels and the route (399), the floor guide (410) and the pins (600).
 *
 * Each cloud is anchored to a latitude/longitude inside the map's bounding box, drawn in the
 * pane's own layer coordinates, so panning, zooming and rotating the map keep a cloud over
 * that piece of campus. They drift west at a real wind speed and re-enter from the east edge.
 *
 * They are drawn the way the 2.5D buildings are: extruded up-screen (north) from their ground
 * point and squashed to the map's tilt, with a soft shadow below them, so they sit on the map
 * instead of looking like flat stickers on top of it. Every cloud has its own seeded shape
 * (cloudSky.js), so none of them is the same as the rest.
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
const TILT = 0.55;
// Extra canvas around the viewport, so a cloud sliding in from the edge is never clipped.
const MARGIN = 140;
const RAIN_DROPS = 80;
const RAIN_SPAN = 3.2;

const PALETTES = {
    clear: { color: 0xffffff, haze: 0xdfe9f7, opacity: 0.9, drift: 1, shadow: 0.14 },
    overcast: { color: 0xccd5e3, haze: 0xd9e2ef, opacity: 0.95, drift: 1.2, shadow: 0.2 },
    rain: { color: 0x9fabbd, haze: 0xcdd8e7, opacity: 0.97, drift: 1.45, shadow: 0.26 },
    heat: { color: 0xfff9ee, haze: 0xffe7bb, opacity: 0.86, drift: 0.7, shadow: 0.18 },
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
            canvas.className = 'cloud-field-3d';
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
            const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 1, 400);
            camera.position.z = 100;

            scene.add(new THREE.AmbientLight(0xf2f7ff, 1.15));
            scene.add(new THREE.HemisphereLight(0xdbe8ff, 0x8fa3c0, 1.05));
            const keyLight = new THREE.DirectionalLight(0xffffff, 3.1);
            keyLight.position.set(-0.45, 1, 0.8);
            scene.add(keyLight);

            const sphere = new THREE.SphereGeometry(1, 18, 12);
            const seed = Math.floor(Math.random() * 4294967295) || 1;
            const reduceMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

            const deck = cloudDeck(seed);
            const clouds = deck.map((spec) => {
                const shape = cloudShape(spec.seed);
                const material = new THREE.MeshLambertMaterial({
                    color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: true,
                });
                const group = new THREE.Group();
                for (const lobe of shape.lobes) {
                    const puff = new THREE.Mesh(sphere, material);
                    puff.position.set(lobe.x, lobe.y, lobe.z);
                    puff.scale.setScalar(lobe.r);
                    group.add(puff);
                }
                scene.add(group);
                return {
                    spec, shape, material, group,
                    lat: 0,
                    lng: 0,
                    px: 0,
                    widthFrac: spec.widthFrac,
                    speedMps: spec.speedMps,
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

            // Spread the deck over the visible bounding box: three columns by two rows,
            // jittered inside each cell, so they cover the campus instead of queueing along
            // the top edge. Every later cloud enters over the same box.
            const placeDeck = () => {
                const bounds = map.getBounds();
                const rand = seededRandom(seed + 7);
                const west = bounds.getWest();
                const south = bounds.getSouth();
                const spanLng = bounds.getEast() - west;
                const spanLat = bounds.getNorth() - south;
                clouds.forEach((cloud, index) => {
                    const col = index % 3;
                    const row = Math.floor(index / 3);
                    cloud.lng = west + ((col + 0.08 + rand() * 0.84) / 3) * spanLng;
                    cloud.lat = south + ((row + 0.05 + rand() * 0.9) / 2) * spanLat;
                    cloud.widthFrac = cloud.spec.widthFrac;
                    cloud.speedMps = cloud.spec.speedMps;
                    cloud.px = 0;
                });
            };

            // A cloud that drifted off the west edge comes back at the east edge, at a new
            // latitude; one the map was panned away from returns over the campus.
            const respawn = (cloud, fromEast) => {
                const bounds = map.getBounds();
                const west = bounds.getWest();
                const south = bounds.getSouth();
                const spanLng = bounds.getEast() - west;
                const spanLat = bounds.getNorth() - south;
                const rand = seededRandom((cloud.spec.seed + Date.now()) >>> 0);
                cloud.lat = south + (0.08 + rand() * 0.84) * spanLat;
                cloud.lng = fromEast ? bounds.getEast() + rand() * spanLng * 0.12 : west + (0.06 + rand() * 0.88) * spanLng;
                cloud.widthFrac = 0.15 + rand() * 0.15;
                cloud.speedMps = 4 + rand() * 9;
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
            let renderedMode = '';

            const frame = (now) => {
                raf = window.requestAnimationFrame(frame);
                const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
                last = now;
                const current = modeRef.current;
                if (document.hidden || !width || !height) {
                    return;
                }
                // Reduced motion keeps the sky still: draw again only when the weather changes.
                if (reduceMotion && current === renderedMode) {
                    return;
                }
                renderedMode = current;

                if (!clouds[0].lat) {
                    placeDeck();
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
                    canvas.style.left = `${originX}px`;
                    canvas.style.top = `${originY}px`;
                }

                // Clouds live inside the view; they may drift a little past the edge before they
                // come back from the east, but they are never parked outside it.
                const bounds = map.getBounds().pad(0.3);
                const west = bounds.getWest();
                const south = bounds.getSouth();
                const north = bounds.getNorth();
                const east = bounds.getEast();
                const spanLng = east - west;
                const spanLat = north - south;

                for (const cloud of clouds) {
                    // Drift west in real metres, so the cloud stays over the campus as the map moves.
                    cloud.lng -= (cloud.speedMps * palette.drift * animate * dt) / metresPerDegreeLng(cloud.lat);

                    // Past the padded west edge: the cloud is wholly off-screen, so it re-enters
                    // from the east at a fresh latitude instead of sliding back into view.
                    if (cloud.lng < west) {
                        respawn(cloud, true);
                    } else if (
                        cloud.lat < south - spanLat * 0.2
                        || cloud.lat > north + spanLat * 0.2
                        || cloud.lng > east + spanLng * 0.6
                    ) {
                        respawn(cloud, false);
                    }

                    const layerPoint = map.latLngToLayerPoint([cloud.lat, cloud.lng]);
                    const pointX = layerPoint.x - originX;
                    const pointY = layerPoint.y - originY;

                    const targetPx = viewWidth * cloud.widthFrac;
                    if (!cloud.px) {
                        cloud.px = targetPx;
                    }
                    cloud.px += (targetPx - cloud.px) * (dt > 0 ? 1 - Math.exp(-dt * 6) : 1);
                    const unit = cloud.px / cloud.shape.span;
                    const bobPx = Math.sin(time * 0.5 + cloud.spec.phase) * cloud.spec.bob * cloud.px * animate;
                    const baseY = height - pointY + bobPx;
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

                    targetColor.setHex(palette.color).lerp(hazeColor.setHex(palette.haze), (1 - cloud.spec.depth) * 0.5);
                    cloud.material.color.lerp(targetColor, ease);
                    cloud.material.opacity += ((0.86 + cloud.spec.depth * 0.1) * palette.opacity - cloud.material.opacity) * ease;

                    if (cloud.shadow) {
                        // Pooled below the footprint, as if the cloud floats above the campus.
                        cloud.shadow.position.set(
                            pointX - cloud.px * 0.04,
                            baseY - cloud.px * 0.06,
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

            const onContextLost = (event) => {
                event.preventDefault();
                window.cancelAnimationFrame(raf);
            };
            canvas.addEventListener('webglcontextlost', onContextLost);
            raf = window.requestAnimationFrame(frame);

            return () => {
                window.cancelAnimationFrame(raf);
                observer.disconnect();
                canvas.removeEventListener('webglcontextlost', onContextLost);
                for (const cloud of clouds) {
                    cloud.material.dispose();
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
