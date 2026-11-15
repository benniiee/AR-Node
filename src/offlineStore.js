// Tiny IndexedDB key-value store for the offline copy (map + rain status).
//
// IndexedDB rather than localStorage: the map is 100 KB+ of JSON, localStorage
// is capped near 5 MB and blocks the page while it reads. The store is created
// once; every method returns a promise and may reject (private browsing,
// storage full), so callers wrap it - offline data must never break the app.

const DB_NAME = 'ar-node-offline';
const STORE = 'kv';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** @returns {{get: Function, set: Function, del: Function}|null} null when IndexedDB is unavailable */
export function createIdbStore() {
    if (typeof indexedDB === 'undefined') return null;

    let dbPromise = null;
    const db = () => {
        dbPromise = dbPromise || openDb();

        return dbPromise;
    };
    const run = async (mode, fn) => {
        const database = await db();

        return new Promise((resolve, reject) => {
            const tx = database.transaction(STORE, mode);
            const request = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
        });
    };

    return {
        get: (key) => run('readonly', (s) => s.get(key)),
        set: (key, value) => run('readwrite', (s) => s.put(value, key)),
        del: (key) => run('readwrite', (s) => s.delete(key)),
    };
}

export const offlineStore = createIdbStore();
