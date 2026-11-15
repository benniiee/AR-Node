import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// NOTE: no React.StrictMode (same reason as mobile.jsx) — dev
// double-mounting breaks exclusive resources like XR sessions and the
// camera stream. Production builds are unaffected either way.
ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
);
