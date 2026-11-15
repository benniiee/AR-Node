import React from 'react';
import ReactDOM from 'react-dom/client';
import MobileNav from './components/MobileNav';
import MapGate from './components/MapGate';
import TooltipLayer from './components/TooltipLayer';
import { registerServiceWorker } from './pwa';

// Installable, offline-capable app (production builds only; see src/pwa.js).
registerServiceWorker();

// NOTE: no React.StrictMode here on purpose. StrictMode double-invokes
// effects in dev, which mounts the 3D view's Three.js renderer, camera stream
// and sensor listeners twice; the camera and sensors are single-owner
// resources, so the second mount fights the first. Production builds are
// unaffected either way.
//
// MapGate asks first: student sign-in, or "view as visitor (guest)".
ReactDOM.createRoot(document.getElementById('root')).render(
    <>
        <MapGate>
            {({ session, signOut, signIn }) => <MobileNav session={session} onSignOut={signOut} onSignIn={signIn} />}
        </MapGate>
        {/* One readable tooltip for every title/data-tip in the app (TooltipLayer.jsx). */}
        <TooltipLayer />
    </>
);
