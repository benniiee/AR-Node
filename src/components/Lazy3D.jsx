import React from 'react';
import { C } from '../uiTokens';

/**
 * A 3D preview that loads on demand. The previews pull in three.js (about 145 kB compressed);
 * loading one only when it is opened keeps three.js out of the first page load of both the
 * phone app and the admin console. The preview's CSS comes with it, and its space is held
 * while it loads so nothing jumps.
 *
 * @param {() => Promise<object>} load the dynamic import of the preview's file
 * @param {string} cssExport name of that file's CSS export
 * @param {string} loadingLabel shown while it loads
 */
export function lazyPreview(load, cssExport, loadingLabel) {
    const Preview = React.lazy(() => load().then((m) => ({
        default: (props) => <><style>{m[cssExport]}</style><m.default {...props} /></>,
    })));
    return function LazyPreview(props) {
        const holder = <div role="status" style={{ height: props.height ?? 210, display: 'grid', placeItems: 'center', color: C.muted, fontSize: 13 }}>{loadingLabel}</div>;
        return <React.Suspense fallback={holder}><Preview {...props} /></React.Suspense>;
    };
}

/** The staircase preview: the phone app's "Stairs in 3D" and the admin stair editor. */
export const StairPreview3D = lazyPreview(() => import('./StairPreview3D'), 'STAIR_PREVIEW_CSS', 'Loading the stairs...');

/** Building Studio: the building's department dresses its outside in 3D (opened from its card on the admin map). */
export const BuildingStudio = lazyPreview(() => import('./BuildingStudio'), 'STUDIO_CSS', 'Opening the Building Studio...');

/** A tree, bench, shed or gate among the campus buildings, with a person for scale (admin Objects tool). */
export const ObjectPreview3D = lazyPreview(() => import('./ObjectPreview3D'), 'OBJECT_PREVIEW_CSS', 'Loading the 3D preview...');
