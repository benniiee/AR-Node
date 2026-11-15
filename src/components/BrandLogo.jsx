import React from 'react';

/**
 * The ARNode logo (logo/ folder, copied to public/pwa/ by the build), shown as it is: no
 * background tile. Decorative next to the "ARNode" wordmark, so alt="" (the wordmark
 * already says the name). Change the logo in logo/, never in public/.
 *
 * size: 'inline' scales with the wordmark's font size (1.3em); a number is a fixed pixel size.
 */
export const LOGO_SRC = '/pwa/icon-192.png';

export default function BrandLogo({ size = 'inline', className = '' }) {
    const px = typeof size === 'number' ? size : 28;
    return (
        <img
            className={`brand-logo${size === 'inline' ? ' brand-logo-inline' : ''}${className ? ` ${className}` : ''}`}
            src={LOGO_SRC} alt="" width={px} height={px} decoding="async" draggable="false"
            style={typeof size === 'number' ? { width: size, height: size } : undefined}
        />
    );
}
