const API_BASE = '/api';

let authToken = localStorage.getItem('admin_token') || null;

export function setToken(token) {
    authToken = token;
    if (token) {
        localStorage.setItem('admin_token', token);
    } else {
        localStorage.removeItem('admin_token');
    }
}

export function getToken() {
    return authToken;
}

async function request(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options.headers,
    };

    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers,
            credentials: 'include',
        });
    } catch {
        throw new Error('Cannot reach the server. Check your connection and try again.');
    }

    if (response.status === 401) {
        setToken(null);
        window.location.reload();
        throw new Error('Your session ended. Sign in again to continue.');
    }

    let data = null;
    try { data = await response.json(); } catch { /* empty or HTML body */ }

    if (!response.ok) {
        throw new Error(errorMessage(response.status, data));
    }

    return data;
}

/**
 * One plain sentence for the banner, never raw JSON. Laravel validation (422)
 * sends {message, errors: {field: [..]}}: the first field message is the most
 * specific one ("CCS has floor levels 0 to 2"), so it wins.
 */
function errorMessage(status, data) {
    const firstFieldError = data && data.errors && Object.values(data.errors).flat()[0];
    if (firstFieldError) return String(firstFieldError);
    if (data && data.message && !/^server error$/i.test(data.message)) return data.message;
    if (status === 403) return 'You do not have permission to do that.';
    if (status === 404) return 'That item no longer exists. Reload the data and try again.';
    if (status >= 500) return 'The server had a problem. Try again in a moment.';
    return 'That did not work. Try again.';
}

export const api = {
    // Auth
    login: (email, password) =>
        request('/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        }),

    logout: () =>
        request('/logout', { method: 'POST' }),

    getUser: () =>
        request('/user'),

    // Map data
    getMapData: () =>
        request('/map-data'),

    // Nodes
    getNodes: () =>
        request('/nodes'),

    createNode: (data) =>
        request('/nodes', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    updateNode: (id, data) =>
        request(`/nodes/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        }),

    deleteNode: (id) =>
        request(`/nodes/${id}`, { method: 'DELETE' }),

    // Two offices trade name + department in place (admin only)
    swapNodes: (nodeAId, nodeBId) =>
        request('/nodes/swap', {
            method: 'POST',
            body: JSON.stringify({ node_a_id: nodeAId, node_b_id: nodeBId }),
        }),

    // Labelled buildings (read: any logged-in user; write: admin only)
    getBuildings: () =>
        request('/buildings'),

    createBuilding: (data) =>
        request('/buildings', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    updateBuilding: (id, data) =>
        request(`/buildings/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        }),

    deleteBuilding: (id) =>
        request(`/buildings/${id}`, { method: 'DELETE' }),

    // Road / walkway network (read: any logged-in user; write: admin only)
    getPathways: () =>
        request('/pathways'),

    createPathway: (data) =>
        request('/pathways', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    updatePathway: (id, data) =>
        request(`/pathways/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        }),

    deletePathway: (id) =>
        request(`/pathways/${id}`, { method: 'DELETE' }),

    // Campus areas (Campus A, Campus B, ...): read by any staff, written by admins.
    getCampusAreas: () =>
        request('/campus-areas'),

    createCampusArea: (data) =>
        request('/campus-areas', { method: 'POST', body: JSON.stringify(data) }),

    updateCampusArea: (id, data) =>
        request(`/campus-areas/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

    deleteCampusArea: (id) =>
        request(`/campus-areas/${id}`, { method: 'DELETE' }),

    generatePathwayNodes: (id, data = {}) =>
        request(`/pathways/${id}/route-nodes`, {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    // Departments (list: any logged-in user; write: admin only)
    getDepartments: () =>
        request('/departments'),

    createDepartment: (data) =>
        request('/departments', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    updateDepartment: (id, data) =>
        request(`/departments/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        }),

    deleteDepartment: (id) =>
        request(`/departments/${id}`, { method: 'DELETE' }),

    // Users (admin only) — list faculty, create accounts, assign roles/departments
    getUsers: () =>
        request('/users'),

    createUser: (data) =>
        request('/users', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    updateUser: (id, data) =>
        request(`/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        }),

    deleteUser: (id) =>
        request(`/users/${id}`, { method: 'DELETE' }),

    // Students (admin only) — school ID + name + course + year level
    getStudents: () =>
        request('/students'),

    createStudent: (data) =>
        request('/students', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    updateStudent: (id, data) =>
        request(`/students/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        }),

    deleteStudent: (id) =>
        request(`/students/${id}`, { method: 'DELETE' }),

    // Admin password reset: returns { temporary_password, student } once.
    resetStudentPassword: (id) =>
        request(`/students/${id}/reset-password`, { method: 'POST' }),

    // Rain and heat model history (admin only): the Weather tab. days = 1 | 7 | 30 | 90.
    getWeatherHistory: (days) =>
        request(`/weather/history?days=${encodeURIComponent(days)}`),

    // "Update now" (admin only): fetch a fresh forecast without waiting for the 20-minute schedule.
    refreshWeather: () =>
        request('/weather/refresh', { method: 'POST' }),

    // Staircase links (two nodes on different floors = the ends of one stair)
    getNodeLinks: () =>
        request('/node-links'),

    createNodeLink: (data) =>
        request('/node-links', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    updateNodeLink: (id, data) =>
        request(`/node-links/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        }),

    deleteNodeLink: (id) =>
        request(`/node-links/${id}`, { method: 'DELETE' }),

    // Borders
    getBorders: () =>
        request('/borders'),

    createBorder: (data) =>
        request('/borders', {
            method: 'POST',
            body: JSON.stringify(data),
        }),

    deleteBorderGroup: (groupId) =>
        request(`/borders/group/${groupId}`, { method: 'DELETE' }),
};
