// ==UserScript==
// @name         Universal Survey Solver (Gemini)
// @namespace    http://tampermonkey.net/
// @version      1.1.17
// @license      MIT
// @description  Enterprise survey solver with Auto-Farm mode, matrix batching, and custom widget support, powered by Google Gemini API
// @homepageURL  https://greasyfork.org/en/scripts/607189-universal-survey-solver-gemini
// @supportURL   https://greasyfork.org/en/scripts/607189-universal-survey-solver-gemini/feedback
// @updateURL    https://update.greasyfork.org/scripts/607189/Universal%20Survey%20Solver%20(Gemini).meta.js
// @downloadURL  https://update.greasyfork.org/scripts/607189/Universal%20Survey%20Solver%20(Gemini).user.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @connect      generativelanguage.googleapis.com
// @connect      update.greasyfork.org
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const isSubFrame = (() => {
        try { return window.top !== window.self; } catch (e) { return true; }
    })();
    if (isSubFrame) {
        const frameUrl = `${location.hostname}${location.pathname}`;
        if (/recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha|challenges\.cloudflare|doubleclick|googlesyndication|googletagmanager|google-analytics|stripe\.com|paypal\.com|accounts\.google|youtube\.com\/embed/i.test(frameUrl)) {
            return;
        }
        if (window.innerWidth < 360 || window.innerHeight < 260) {
            return;
        }
    }

    // open https://aistudio.google.com/api-keys and create an API key. Paste it below (or save via Setup Page / Tampermonkey menu so updates keep your key).
    const API_KEY = '';
    // Replace with the URL where you upload index.html (e.g. your GitHub Pages URL):
    const WELCOME_PAGE_URL = 'https://getsentrix.github.io/surveysolverjs/';
    const GREASYFORK_SCRIPT_URL = 'https://greasyfork.org/en/scripts/607189-universal-survey-solver-gemini';
    const GREASYFORK_META_URL = 'https://update.greasyfork.org/scripts/607189/Universal%20Survey%20Solver%20(Gemini).meta.js';
    const GREASYFORK_USERJS_URL = 'https://update.greasyfork.org/scripts/607189/Universal%20Survey%20Solver%20(Gemini).user.js';
    const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info?.script?.version) ? String(GM_info.script.version) : '1.1.17';
    const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // Strictly <= 1 check per 24h per Greasy Fork rules

    const MODEL_NAME = 'gemma-4-26b-a4b-it';
    const FALLBACK_MODELS = ['gemma-4-31b-it', 'gemini-3.5-flash-lite'];
    // Speed presets: 'fast', 'balanced' (human-calibrated default), 'human' (slower pacing)
    const SPEED_MODE = 'balanced';
    const REQUEST_TIMEOUT_MS = 12000;

    const GM_KEY_API = '__gt_gemini_api_key_v1';
    const GM_KEY_INSTALLED = '__gt_welcome_shown_v1';
    const GM_KEY_LAST_UPDATE_CHECK = '__gt_last_update_check_v1';
    const GM_KEY_LAST_REMOTE_VERSION = '__gt_last_remote_version_v1';
    const GM_KEY_PROFILE = '__gt_persona_profile_v1';
    const GM_KEY_AF_STATE = '__gt_af_state_v1';
    const GM_KEY_AF_HANDOFF = '__gt_af_handoff_v1';
    const GM_KEY_TRUE_AUTO = '__gt_true_auto_v1';
    const GM_KEY_RECENT_SURVEYS = '__gt_recent_surveys_v1';
    const GM_KEY_SESSION_MEM = '__gt_session_memory_v1';
    const GM_KEY_ACTIVE_LOCK = '__gt_active_tab_lock_v1';
    const GM_KEY_SELF_HEAL_LOGS = '__gt_self_heal_logs_v1';
    const GM_KEY_SELF_HEAL_TRY = '__gt_self_heal_try_v1';
    const AF_STATE_TTL_MS = 25 * 60 * 1000;
    const AF_HANDOFF_TTL_MS = 120 * 1000;
    const ACTIVE_LOCK_TTL_MS = 12 * 1000;
    const selfHealTriedSigs = new Set();
    const TAB_ID = (() => {
        try {
            let id = sessionStorage.getItem('__gt_tab_id_v1');
            if (!id) {
                id = `tab_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
                sessionStorage.setItem('__gt_tab_id_v1', id);
            }
            return id;
        } catch (e) {
            return `tab_${Math.random().toString(36).slice(2, 10)}`;
        }
    })();
    let registeredUpdateMenuVersion = '';

    // Private per-DOM-node tracking in WeakSet/WeakMap so host pages cannot inspect custom attributes
    const touchedElements = new WeakSet();
    const selectedChoiceKeys = new WeakMap();
    const startedVideoTargets = new WeakSet();
    const validationRetryCounts = new WeakMap();

    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
        } catch (e) {}
        return fallback;
    }

    function gmSet(key, val) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(key, val);
        } catch (e) {}
    }

    function getActiveApiKey() {
        const stored = String(gmGet(GM_KEY_API, '') || '').trim();
        if (stored) return stored;
        return String(API_KEY || '').trim();
    }

    function maskApiKey(key) {
        const k = String(key || '').trim();
        if (!k) return '';
        if (k.length <= 10) return '••••••••';
        return `${k.slice(0, 6)}••••••${k.slice(-4)}`;
    }

    function openExternalTab(url) {
        if (!url) return;
        try {
            if (typeof GM_openInTab === 'function') {
                GM_openInTab(url, { active: true, insert: true, setParent: true });
                return;
            }
        } catch (e) {}
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) {}
    }

    function isConfiguredWelcomeUrl(url) {
        return /^https?:\/\//i.test(url || '') && !/YOUR-USERNAME|YOUR-REPO/i.test(url || '');
    }

    function isOnWelcomePage() {
        if (!isConfiguredWelcomeUrl(WELCOME_PAGE_URL)) return false;
        try {
            const target = new URL(WELCOME_PAGE_URL);
            if (location.origin !== target.origin) return false;
            const normTargetPath = target.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '');
            const normHerePath = location.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '');
            return normHerePath === normTargetPath;
        } catch (e) {
            return false;
        }
    }

    function compareSemver(a, b) {
        const pa = String(a || '0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b || '0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const da = pa[i] || 0;
            const db = pb[i] || 0;
            if (da > db) return 1;
            if (da < db) return -1;
        }
        return 0;
    }

    function checkForScriptUpdate(manual = false) {
        const now = Date.now();
        const lastCheck = Number(gmGet(GM_KEY_LAST_UPDATE_CHECK, 0)) || 0;
        if (!manual && (now - lastCheck) < UPDATE_CHECK_INTERVAL_MS) return;
        gmSet(GM_KEY_LAST_UPDATE_CHECK, now);

        const emitUpdateStatus = (payload) => {
            window.dispatchEvent(new CustomEvent('gt:update-status', { detail: payload }));
        };

        if (manual) {
            emitUpdateStatus({ checking: true, currentVersion: SCRIPT_VERSION, installUrl: GREASYFORK_USERJS_URL });
            if (hudElement && !isProcessing && !autoFarmActive) {
                updateHUD('Checking updates...', 'info', 4000);
            }
        }

        const requestUrl = manual ? `${GREASYFORK_META_URL}?_=${now}` : GREASYFORK_META_URL;

        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url: requestUrl,
                nocache: true,
                headers: {
                    'Cache-Control': 'no-cache, no-store, max-age=0',
                    Pragma: 'no-cache'
                },
                timeout: 8000,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        emitUpdateStatus({ checking: false, error: `HTTP ${res.status}`, currentVersion: SCRIPT_VERSION, installUrl: GREASYFORK_USERJS_URL });
                        if (manual) {
                            if (hudElement) updateHUD(`Update check failed (${res.status})`, 'error', 3500);
                            else if (!isOnWelcomePage()) window.alert(`Update check failed (HTTP ${res.status}).`);
                        }
                        return;
                    }
                    const m = (res.responseText || '').match(/\/\/\s*@version\s+([^\s]+)/i);
                    const remoteVersion = m ? m[1].trim() : '';
                    if (!remoteVersion) {
                        emitUpdateStatus({ checking: false, error: 'Missing version', currentVersion: SCRIPT_VERSION, installUrl: GREASYFORK_USERJS_URL });
                        if (manual) {
                            if (hudElement) updateHUD('Could not read version', 'error', 3500);
                            else if (!isOnWelcomePage()) window.alert('Could not read latest version from Greasy Fork.');
                        }
                        return;
                    }
                    gmSet(GM_KEY_LAST_REMOTE_VERSION, remoteVersion);
                    const hasUpdate = compareSemver(remoteVersion, SCRIPT_VERSION) > 0;
                    emitUpdateStatus({
                        checking: false,
                        currentVersion: SCRIPT_VERSION,
                        remoteVersion,
                        hasUpdate,
                        installUrl: GREASYFORK_USERJS_URL
                    });

                    if (hasUpdate) {
                        if (typeof GM_registerMenuCommand === 'function' && registeredUpdateMenuVersion !== remoteVersion) {
                            registeredUpdateMenuVersion = remoteVersion;
                            try {
                                GM_registerMenuCommand(`⬆️ Update Available (v${remoteVersion})`, () => openExternalTab(GREASYFORK_USERJS_URL));
                            } catch (e) {}
                        }
                        if (hudElement && !isProcessing && !autoFarmActive) {
                            updateHUD(`Update v${remoteVersion} ready`, 'info', 8000);
                        }
                        if (manual && !isOnWelcomePage()) {
                            let confirmed = false;
                            try {
                                confirmed = window.confirm(`Universal Survey Solver v${remoteVersion} is available (you have v${SCRIPT_VERSION}). Open Greasy Fork installer now?`);
                            } catch (e) {
                                confirmed = false;
                            }
                            if (confirmed) {
                                openExternalTab(GREASYFORK_USERJS_URL);
                            }
                        }
                    } else if (manual) {
                        if (hudElement && !isProcessing && !autoFarmActive) {
                            updateHUD(`Up to date (v${SCRIPT_VERSION})`, 'active', 3000);
                        } else if (!isOnWelcomePage()) {
                            window.alert(`You are up to date (v${SCRIPT_VERSION}).`);
                        }
                    }
                },
                onerror: () => {
                    emitUpdateStatus({ checking: false, error: 'Network error', currentVersion: SCRIPT_VERSION, installUrl: GREASYFORK_USERJS_URL });
                    if (manual) {
                        if (hudElement) updateHUD('Update check failed', 'error', 3500);
                        else if (!isOnWelcomePage()) window.alert('Network error checking Greasy Fork for updates.');
                    }
                },
                ontimeout: () => {
                    emitUpdateStatus({ checking: false, error: 'Timeout', currentVersion: SCRIPT_VERSION, installUrl: GREASYFORK_USERJS_URL });
                    if (manual) {
                        if (hudElement) updateHUD('Update check timed out', 'error', 3500);
                        else if (!isOnWelcomePage()) window.alert('Timed out checking Greasy Fork for updates.');
                    }
                }
            });
        } catch (e) {}
    }

    function normalizePersonaProfile(raw) {
        const src = (raw && typeof raw === 'object') ? raw : {};
        const fields = ['name', 'email', 'age', 'gender', 'zip', 'location', 'job', 'income', 'household', 'politics', 'notes'];
        const out = {};
        for (const k of fields) {
            out[k] = String(src[k] || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        }
        return out;
    }

    function getSavedPersonaProfile() {
        try {
            const raw = gmGet(GM_KEY_PROFILE, '');
            if (!raw) return {};
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return normalizePersonaProfile(parsed);
        } catch (e) {
            return {};
        }
    }

    function compressPersonaProfile(p = getSavedPersonaProfile()) {
        if (!p || typeof p !== 'object') return '';
        const parts = [];
        if (p.name) parts.push(p.name);
        if (p.age) parts.push(`${p.age}yo`);
        if (p.gender) parts.push(p.gender);
        if (p.zip || p.location) parts.push([p.zip, p.location].filter(Boolean).join(' '));
        if (p.job) parts.push(p.job);
        if (p.income) parts.push(p.income);
        if (p.household) parts.push(p.household);
        if (p.politics) parts.push(p.politics);
        if (p.email) parts.push(p.email);
        if (p.notes) parts.push(p.notes);
        return parts.join(' | ');
    }

    function readSessionMemory() {
        try {
            const raw = gmGet(GM_KEY_SESSION_MEM, '');
            if (!raw) return [];
            const store = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const entry = store && store[location.origin];
            if (!entry || !Array.isArray(entry.items)) return [];
            if (Date.now() - (entry.ts || 0) > AF_STATE_TTL_MS) return [];
            return entry.items;
        } catch (e) {
            return [];
        }
    }

    function recordSessionAnswer(questionText, answerText) {
        const q = String(questionText || '').replace(/\s+/g, ' ').trim().slice(0, 65);
        const a = String(answerText || '').replace(/\s+/g, ' ').trim().slice(0, 55);
        if (!q || !a || q.length < 3) return;
        try {
            const raw = gmGet(GM_KEY_SESSION_MEM, '');
            const store = (raw && typeof raw === 'string') ? JSON.parse(raw) : ((raw && typeof raw === 'object') ? raw : {});
            const prev = (store[location.origin] && Date.now() - (store[location.origin].ts || 0) <= AF_STATE_TTL_MS && Array.isArray(store[location.origin].items))
                ? store[location.origin].items
                : [];
            const filtered = prev.filter(it => it.q !== q);
            filtered.push({ q, a });
            store[location.origin] = { ts: Date.now(), items: filtered.slice(-14) };
            gmSet(GM_KEY_SESSION_MEM, JSON.stringify(store));
        } catch (e) {}
    }

    function clearSessionMemory() {
        try {
            const raw = gmGet(GM_KEY_SESSION_MEM, '');
            const store = (raw && typeof raw === 'string') ? JSON.parse(raw) : ((raw && typeof raw === 'object') ? raw : {});
            if (store && store[location.origin]) {
                delete store[location.origin];
                gmSet(GM_KEY_SESSION_MEM, JSON.stringify(store));
            }
        } catch (e) {}
    }

    function buildConsistencySystemPrefix() {
        const lines = [];
        const compactProfile = compressPersonaProfile();
        if (compactProfile) {
            lines.push(`PERSONA (stay 100% consistent with these details): ${compactProfile}`);
        }
        const mem = readSessionMemory();
        if (mem.length > 0) {
            const summary = mem.slice(-10).map(it => `${it.q} -> ${it.a}`).join('; ');
            lines.push(`PRIOR ANSWERS IN THIS SURVEY (do not contradict): ${summary}`);
        }
        return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
    }

    function registerUserscriptMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        try {
            GM_registerMenuCommand('🔑 Set Gemini API Key', () => {
                const current = String(gmGet(GM_KEY_API, '') || '').trim();
                const input = window.prompt(
                    'Paste your Google AI Studio Gemini API key below (saved safely across Greasy Fork updates).\nLeave blank to revert to the key in the script file.',
                    current
                );
                if (input === null) return;
                const cleaned = input.trim();
                gmSet(GM_KEY_API, cleaned);
                if (hudElement) {
                    updateHUD(cleaned ? 'API key saved' : 'Using script key', 'active', 2500);
                }
            });
            GM_registerMenuCommand('👤 Persona Profile (Setup)', () => {
                openExternalTab(isConfiguredWelcomeUrl(WELCOME_PAGE_URL) ? `${WELCOME_PAGE_URL}#step-profile` : GREASYFORK_SCRIPT_URL);
            });
            GM_registerMenuCommand('📖 Open Setup & Instructions', () => {
                openExternalTab(isConfiguredWelcomeUrl(WELCOME_PAGE_URL) ? WELCOME_PAGE_URL : GREASYFORK_SCRIPT_URL);
            });
            GM_registerMenuCommand('🔄 Check for Updates (Greasy Fork)', () => {
                checkForScriptUpdate(true);
            });
            GM_registerMenuCommand('📋 Download Self-Heal Logs (.txt)', () => {
                exportSelfHealLogFile(true);
            });
        } catch (e) {}
    }

    function handleFirstInstallWelcome() {
        const alreadyInstalled = Boolean(gmGet(GM_KEY_INSTALLED, false));
        if (alreadyInstalled) return;
        // Mark immediately so future reloads, parallel tabs, and script updates NEVER reopen the welcome page
        gmSet(GM_KEY_INSTALLED, true);
        if (!isOnWelcomePage() && isConfiguredWelcomeUrl(WELCOME_PAGE_URL)) {
            openExternalTab(WELCOME_PAGE_URL);
        }
    }

    function initWelcomePageBridge() {
        if (!isOnWelcomePage()) return;
        const publishStatus = () => {
            if (!isOnWelcomePage()) return;
            const storedKey = String(gmGet(GM_KEY_API, '') || '').trim();
            const cachedRemote = String(gmGet(GM_KEY_LAST_REMOTE_VERSION, '') || '').trim();
            const cachedHasUpdate = cachedRemote ? compareSemver(cachedRemote, SCRIPT_VERSION) > 0 : false;
            const profile = getSavedPersonaProfile();
            window.dispatchEvent(new CustomEvent('gt:bridge-status', {
                detail: {
                    installed: true,
                    version: SCRIPT_VERSION,
                    hasSavedKey: storedKey.length > 0,
                    maskedKey: maskApiKey(storedKey),
                    profile,
                    compressedProfile: compressPersonaProfile(profile),
                    trueAuto: isTrueAutoEnabled(),
                    greasyforkUrl: GREASYFORK_SCRIPT_URL,
                    installUrl: GREASYFORK_USERJS_URL,
                    remoteVersion: cachedRemote || SCRIPT_VERSION,
                    hasUpdate: cachedHasUpdate
                }
            }));
        };

        window.addEventListener('gt:request-status', () => {
            if (!isOnWelcomePage()) return;
            publishStatus();
        });
        window.addEventListener('gt:save-api-key', (e) => {
            if (!isOnWelcomePage()) return;
            const key = String(e?.detail?.apiKey || '').trim();
            if (!key || key.length < 15) {
                window.dispatchEvent(new CustomEvent('gt:key-saved', {
                    detail: { ok: false, message: 'Please paste a valid Gemini API key.' }
                }));
                return;
            }
            gmSet(GM_KEY_API, key);
            window.dispatchEvent(new CustomEvent('gt:key-saved', {
                detail: { ok: true, maskedKey: maskApiKey(key) }
            }));
            publishStatus();
        });
        window.addEventListener('gt:clear-api-key', () => {
            if (!isOnWelcomePage()) return;
            gmSet(GM_KEY_API, '');
            publishStatus();
        });
        window.addEventListener('gt:save-profile', (e) => {
            if (!isOnWelcomePage()) return;
            const normalized = normalizePersonaProfile(e?.detail?.profile);
            const compressed = compressPersonaProfile(normalized);
            gmSet(GM_KEY_PROFILE, compressed ? JSON.stringify(normalized) : '');
            window.dispatchEvent(new CustomEvent('gt:profile-saved', {
                detail: { ok: true, compressed, profile: normalized }
            }));
            publishStatus();
        });
        window.addEventListener('gt:clear-profile', () => {
            if (!isOnWelcomePage()) return;
            gmSet(GM_KEY_PROFILE, '');
            window.dispatchEvent(new CustomEvent('gt:profile-saved', {
                detail: { ok: true, compressed: '', profile: {} }
            }));
            publishStatus();
        });
        window.addEventListener('gt:set-true-auto', (e) => {
            if (!isOnWelcomePage()) return;
            const enabled = Boolean(e?.detail?.enabled);
            setTrueAutoEnabled(enabled);
            window.dispatchEvent(new CustomEvent('gt:true-auto-saved', {
                detail: { ok: true, enabled: isTrueAutoEnabled() }
            }));
            publishStatus();
        });
        window.addEventListener('gt:check-update', () => {
            if (!isOnWelcomePage()) return;
            checkForScriptUpdate(true);
        });

        publishStatus();
    }

    const SPEED_PROFILES = {
        fast: {
            reloadResume: [420, 680],
            followupSettle: 220,
            preNextSolved: [950, 1550],
            preNextEmpty: [450, 720],
            postTransition: [300, 520],
            transitionPoll: 160,
            transitionSettle: 200,
            betweenBlocks: [110, 210],
            betweenClicks: [95, 175],
            keyDwell: [45, 82],
            typeBase: [26, 54],
            typeSpace: [45, 85],
            typeComma: [75, 130],
            typeSentence: [130, 215]
        },
        balanced: {
            reloadResume: [700, 1080],
            followupSettle: 320,
            preNextSolved: [1200, 2050],
            preNextEmpty: [680, 1100],
            postTransition: [480, 860],
            transitionPoll: 220,
            transitionSettle: 260,
            betweenBlocks: [170, 310],
            betweenClicks: [140, 280],
            keyDwell: [56, 116],
            typeBase: [52, 108],
            typeSpace: [80, 145],
            typeComma: [125, 215],
            typeSentence: [220, 380]
        },
        human: {
            reloadResume: [980, 1520],
            followupSettle: 460,
            preNextSolved: [1750, 2750],
            preNextEmpty: [950, 1550],
            postTransition: [760, 1280],
            transitionPoll: 320,
            transitionSettle: 350,
            betweenBlocks: [240, 440],
            betweenClicks: [210, 420],
            keyDwell: [68, 132],
            typeBase: [75, 165],
            typeSpace: [110, 210],
            typeComma: [185, 315],
            typeSentence: [330, 560]
        }
    };
    const SPD = SPEED_PROFILES[SPEED_MODE] || SPEED_PROFILES.balanced;

    function pickRangeDelay(val) {
        return Array.isArray(val) ? randomBetween(val[0], val[1]) : (Number(val) || 0);
    }

    // Occasional randomized 2-3s human-like pauses during Auto-Farm (set enabled: false to disable)
    const RANDOM_PAUSE = {
        enabled: true,
        minMs: 1900,
        maxMs: 3100,
        chanceBeforeSolve: 0.25,     // 25% chance to pause briefly before solving a page
        chanceBetweenBlocks: 0.18,   // 18% chance to hesitate between multi-block steps
        chanceBeforeNext: 0.30,      // 30% chance to pause before clicking Next
        chanceAfterTransition: 0.20, // 20% chance to pause after a page transition
        cooldownMs: 4500             // Minimum gap after a random pause so pauses never stack back-to-back
    };

    let cachedSelection = '';
    let hudHost = null;
    let hudElement = null;
    let statusDotEl = null;
    let statusTextEl = null;
    let solveBtnEl = null;
    let abortBtnEl = null;
    let autoBtnEl = null;
    let hideTimer = null;
    let isProcessing = false;
    let abortRequested = false;
    let autoFarmActive = false;
    let autoFarmLoopRunning = false;
    let lastSolveHadError = false;
    let lastRandomPauseAt = 0;

    const activeXhrs = new Set();
    const activeSleepResolvers = new Set();

    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;

    window.addEventListener('mousemove', (e) => {
        if (e.isTrusted) {
            mouseX = e.clientX;
            mouseY = e.clientY;
        }
    }, { passive: true });

    // --- Origin-Scoped & Cross-Origin Redirect Auto-Farm State in Extension Storage ---
    function getSurveyIdentityKey(urlStr = location.href) {
        try {
            const u = new URL(urlStr, location.href);
            const qp = u.searchParams;
            for (const key of ['sv', 'sid', 'survey_id', 'surveyid', 'study_id', 'form_id', 'project_id']) {
                const v = (qp.get(key) || '').trim();
                if (v) return `${u.origin}|${key}=${v}`;
            }
            const path = u.pathname || '/';
            const qualtricsMatch = path.match(/\/jfe\/form\/(SV_[A-Za-z0-9_-]+)/i);
            if (qualtricsMatch) return `${u.origin}|sv=${qualtricsMatch[1]}`;
            const gformMatch = path.match(/\/forms\/d\/(?:e\/)?([^/]+)/i);
            if (gformMatch) return `${u.origin}|gform=${gformMatch[1]}`;
            const smMatch = path.match(/\/r\/([^/]+)/i);
            if (smMatch) return `${u.origin}|r=${smMatch[1]}`;
            const surveySegMatch = path.match(/\/(?:surveys?|studies)\/([^/?#]+)/i);
            if (surveySegMatch) return `${u.origin}|s=${surveySegMatch[1]}`;
            return u.origin;
        } catch (e) {
            return location.origin;
        }
    }

    function isPanelReturnOrUtilityUrl(urlStr = location.href) {
        try {
            const u = new URL(urlStr, location.href);
            const full = `${u.hostname}${u.pathname}`.toLowerCase();
            if (isOnWelcomePage()) return true;
            if (/(?:^|\.)(?:gain\.gg|primeearn\.com|primeopinions?\.com|freecash\.com|heypiggy\.com|brandedsurveys\.com|attapoll\.com)$/i.test(u.hostname) &&
                /^\/(?:$|surveys|offers|earn|cashout|withdraw|rewards|profile|account)/i.test(u.pathname)) {
                return true;
            }
            if (/swagbucks\.com\/surveys/i.test(full)) return true;
            if (/\/(?:login|signin|sign-in|logout|dashboard|earnings|cashout|withdraw|rewards)(?:\/|$|\?)/i.test(u.pathname)) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    function readActiveTabLock() {
        try {
            const raw = gmGet(GM_KEY_ACTIVE_LOCK, '');
            if (!raw) return null;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return (parsed && typeof parsed === 'object') ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    function claimActiveTabLock(kind = 'survey') {
        try {
            gmSet(GM_KEY_ACTIVE_LOCK, JSON.stringify({
                tabId: TAB_ID,
                kind,
                origin: location.origin,
                ts: Date.now(),
                releasedAt: 0
            }));
        } catch (e) {}
    }

    function heartbeatActiveTabLock(kind = 'survey') {
        if (document.hidden) return;
        const lock = readActiveTabLock();
        if (!lock || lock.releasedAt || lock.tabId === TAB_ID || (Date.now() - (lock.ts || 0)) >= ACTIVE_LOCK_TTL_MS) {
            claimActiveTabLock(kind);
        }
    }

    function releaseActiveTabLock(clearAll = false) {
        try {
            if (clearAll) {
                gmSet(GM_KEY_ACTIVE_LOCK, '');
                return;
            }
            const lock = readActiveTabLock();
            if (lock && lock.tabId === TAB_ID) {
                gmSet(GM_KEY_ACTIVE_LOCK, JSON.stringify(Object.assign({}, lock, {
                    releasedAt: Date.now(),
                    ts: Date.now()
                })));
            }
        } catch (e) {}
    }

    function isOtherTabLockActive() {
        const lock = readActiveTabLock();
        if (!lock || !lock.tabId || lock.tabId === TAB_ID || lock.releasedAt) return false;
        return (Date.now() - (lock.ts || 0)) < ACTIVE_LOCK_TTL_MS;
    }

    function hasActiveSurveyLockElsewhere() {
        const lock = readActiveTabLock();
        if (!lock || !lock.tabId || lock.tabId === TAB_ID || lock.releasedAt) return false;
        return lock.kind === 'survey' && (Date.now() - (lock.ts || 0)) < ACTIVE_LOCK_TTL_MS;
    }

    function pauseAsOtherTab(msg = 'Paused: other tab active') {
        abortRequested = true;
        autoFarmActive = false;
        isProcessing = false;
        for (const req of activeXhrs) {
            try { if (req && typeof req.abort === 'function') req.abort(); } catch (e) {}
        }
        activeXhrs.clear();
        for (const wake of activeSleepResolvers) {
            try { wake(); } catch (e) {}
        }
        activeSleepResolvers.clear();
        syncGUIProcessingState();
        updateHUD(msg, 'info');
    }

    function stampAutoFarmHandoff(fromOfferWall = false) {
        try {
            if (!autoFarmActive || abortRequested || isOnWelcomePage()) return;
            gmSet(GM_KEY_AF_HANDOFF, JSON.stringify({
                ts: Date.now(),
                fromOrigin: location.origin,
                fromHref: location.href,
                fromOfferWall: Boolean(fromOfferWall),
                surveyKey: getSurveyIdentityKey()
            }));
        } catch (e) {}
    }

    function clearAutoFarmHandoff() {
        try { gmSet(GM_KEY_AF_HANDOFF, ''); } catch (e) {}
    }

    function readAutoFarmHandoff() {
        try {
            const raw = gmGet(GM_KEY_AF_HANDOFF, '');
            if (!raw) return null;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!parsed || typeof parsed !== 'object') return null;
            if (Date.now() - (parsed.ts || 0) > AF_HANDOFF_TTL_MS) {
                clearAutoFarmHandoff();
                return null;
            }
            return parsed;
        } catch (e) {
            return null;
        }
    }

    function readOriginAfStore() {
        try {
            const raw = gmGet(GM_KEY_AF_STATE, '');
            if (!raw) return {};
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function writeOriginAfEntry(entry) {
        try {
            const store = readOriginAfStore();
            const now = Date.now();
            for (const k of Object.keys(store)) {
                if (!store[k] || now - (store[k].ts || 0) > AF_STATE_TTL_MS) {
                    delete store[k];
                }
            }
            if (entry) {
                store[location.origin] = Object.assign({ ts: now, surveyKey: getSurveyIdentityKey() }, entry);
            } else {
                delete store[location.origin];
            }
            gmSet(GM_KEY_AF_STATE, JSON.stringify(store));
        } catch (e) {}
    }

    function isTrueAutoEnabled() {
        const raw = gmGet(GM_KEY_TRUE_AUTO, false);
        return raw === true || raw === 'true' || raw === 1 || raw === '1';
    }

    function setTrueAutoEnabled(enabled) {
        gmSet(GM_KEY_TRUE_AUTO, Boolean(enabled));
    }

    function isOfferWallPage(roots = null) {
        try {
            const docRoots = roots || [document];
            const isFeedbackModal = queryAllInRoots(docRoots, '[data-test-id="ps-feedback-comment"], [data-testid="ps-feedback-comment"]')
                .some(el => isElementVisible(el));
            const hasQualificationFlow = !isFeedbackModal && queryAllInRoots(
                docRoots,
                '[data-test-id="ps-qualification-next-button"], [data-test-id="ps-start-survey-btn"], [data-test-id="ps-question-answers-wrapper"], [data-test-id="ps-skip-question-button"], [data-test-id="ps-common-actions-button"]'
            ).some(el => isElementVisible(el));
            if (hasQualificationFlow) return false;
            if (isPanelReturnOrUtilityUrl(location.href)) return true;
            const primeCards = queryAllInRoots(docRoots, '.list-item.survey-item[data-test-id^="ps-survey-"]').filter(el => isElementVisible(el));
            if (primeCards.length >= 2) return true;
        } catch (e) {}
        return false;
    }

    function readRecentPickedSurveys() {
        try {
            const raw = gmGet(GM_KEY_RECENT_SURVEYS, '');
            const arr = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
            if (!Array.isArray(arr)) return [];
            const now = Date.now();
            return arr.filter(it => it && it.id && (now - (it.ts || 0)) <= 5 * 60 * 1000);
        } catch (e) {
            return [];
        }
    }

    function markSurveyPicked(id) {
        if (!id) return;
        const recent = readRecentPickedSurveys().filter(it => it.id !== id);
        recent.push({ id, ts: Date.now() });
        try { gmSet(GM_KEY_RECENT_SURVEYS, JSON.stringify(recent.slice(-20))); } catch (e) {}
    }

    function findOfferWallSurveyCards(roots) {
        const seen = new Set();
        const cards = [];

        const primeCards = queryAllInRoots(roots, '.list-item.survey-item[data-test-id^="ps-survey-"]')
            .filter(el => isElementVisible(el) && !isHudElement(el));
        for (const el of primeCards) {
            if (seen.has(el)) continue;
            seen.add(el);
            const id = el.getAttribute('data-test-id') || '';
            const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
            const minM = txt.match(/\b(\d+)\s*min\b/i);
            const rewardM = txt.match(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:coins?|pts|points)\b|\$(\d+(?:\.\d+)?)/i);
            const mins = minM ? Math.max(1, parseInt(minM[1], 10)) : 12;
            const reward = rewardM ? parseFloat((rewardM[1] || rewardM[2] || '0').replace(/,/g, '')) : 0;
            const score = (reward / mins) + (/\bnew\b/i.test(txt) ? 2 : 0);
            cards.push({ el, id: id || txt.slice(0, 60), text: txt, score });
        }

        if (cards.length === 0) {
            const genericCandidates = queryAllInRoots(
                roots,
                'a, button, [role="button"], [class*="survey" i], [class*="offer" i]'
            ).filter(el => {
                if (!isElementVisible(el) || isHudElement(el) || el.closest('header, nav, footer, [role="banner"], [role="navigation"]')) return false;
                const r = el.getBoundingClientRect();
                if (r.width < 110 || r.height < 42 || r.height > 230 || el.children.length > 10) return false;
                const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
                return /\b\d+\s*min\b/i.test(txt) && /\b(coins?|pts|points|usd|cents?)\b|\$\s*\d/i.test(txt) && txt.length < 140;
            });
            for (const el of genericCandidates) {
                if (cards.some(c => c.el.contains(el) || el.contains(c.el))) continue;
                const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
                const minM = txt.match(/\b(\d+)\s*min\b/i);
                const rewardM = txt.match(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:coins?|pts|points)\b|\$(\d+(?:\.\d+)?)/i);
                const mins = minM ? Math.max(1, parseInt(minM[1], 10)) : 12;
                const reward = rewardM ? parseFloat((rewardM[1] || rewardM[2] || '0').replace(/,/g, '')) : 0;
                const id = el.getAttribute('data-test-id') || el.getAttribute('data-testid') || el.getAttribute('href') || txt.slice(0, 60);
                cards.push({ el, id, text: txt, score: reward / mins });
            }
        }

        return cards;
    }

    function readAutoFarmFlag() {
        if (isOnWelcomePage()) return false;
        const onOfferWall = isOfferWallPage();
        const trueAuto = isTrueAutoEnabled();
        const currentKey = getSurveyIdentityKey();
        const entry = readOriginAfStore()[location.origin];

        // Returning to PrimeEarn / gain.gg/surveys or any offer wall stays stopped unless user explicitly enabled True Auto
        if (onOfferWall && !trueAuto) {
            writeOriginAfEntry(null);
            clearAutoFarmHandoff();
            return false;
        }

        // Never resume in a background/hidden tab
        if (document.hidden) {
            return false;
        }

        // Cross-origin redirect handoff (router -> survey or survey A -> survey B in active tab)
        const handoff = readAutoFarmHandoff();
        if (handoff && handoff.fromOrigin !== location.origin && (!entry || (handoff.ts || 0) >= (entry.ts || 0))) {
            const bootRoots = collectDocumentRoots();
            if (!onOfferWall && detectEndOfSurveyPage(bootRoots)) {
                clearAutoFarmHandoff();
                return false;
            }
            if (onOfferWall && !trueAuto) {
                clearAutoFarmHandoff();
                return false;
            }
            let navType = 'navigate';
            try {
                const navEntry = performance.getEntriesByType?.('navigation')?.[0];
                if (navEntry && navEntry.type) navType = navEntry.type;
            } catch (e) {}
            if (navType !== 'back_forward') {
                clearAutoFarmHandoff();
                clearSessionMemory();
                writeOriginAfEntry({ active: true, sig: '', count: 0, surveyKey: currentKey });
                return 'redirect';
            }
        }

        if (entry && entry.active && (Date.now() - (entry.ts || 0)) <= AF_STATE_TTL_MS) {
            if (entry.surveyKey && currentKey && entry.surveyKey !== currentKey) {
                clearSessionMemory();
                writeOriginAfEntry({ active: true, sig: '', count: 0, surveyKey: currentKey });
                return 'redirect';
            }
            return 'resume';
        }
        return false;
    }

    function writeAutoFarmFlag(enabled) {
        if (!enabled) {
            writeOriginAfEntry(null);
        } else {
            const prev = readOriginAfStore()[location.origin] || {};
            writeOriginAfEntry({ active: true, sig: prev.sig || '', count: prev.count || 0, surveyKey: getSurveyIdentityKey() });
        }
    }

    window.addEventListener('pagehide', () => {
        if (autoFarmActive && !abortRequested) {
            stampAutoFarmHandoff(isOfferWallPage());
            releaseActiveTabLock(false);
        }
    });
    window.addEventListener('beforeunload', () => {
        if (autoFarmActive && !abortRequested) {
            stampAutoFarmHandoff(isOfferWallPage());
            releaseActiveTabLock(false);
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && autoFarmActive && !abortRequested) {
            const onWall = isOfferWallPage();
            stampAutoFarmHandoff(onWall);
            if (!onWall) {
                releaseActiveTabLock(false);
                pauseAsOtherTab('Paused: tab in background');
            }
        }
    });

    function readReloadStuckState() {
        const entry = readOriginAfStore()[location.origin];
        if (!entry || (Date.now() - (entry.ts || 0)) > AF_STATE_TTL_MS) {
            return { sig: '', count: 0 };
        }
        return { sig: String(entry.sig || ''), count: parseInt(entry.count, 10) || 0 };
    }

    function writeReloadStuckState(sig, count) {
        const prev = readOriginAfStore()[location.origin];
        const active = prev ? Boolean(prev.active) : autoFarmActive;
        if (!active && (!sig || count <= 0)) {
            writeOriginAfEntry(null);
            return;
        }
        writeOriginAfEntry({
            active,
            sig: (!sig || count <= 0) ? '' : String(sig),
            count: (!sig || count <= 0) ? 0 : count
        });
    }

    function randomBetween(minMs, maxMs) {
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }

    async function maybeRandomHumanPause(chance, label = 'Auto-Farm: pacing...', dotType = 'farming') {
        if (!RANDOM_PAUSE.enabled || abortRequested) return false;
        if (Math.random() >= chance) return false;
        const now = Date.now();
        if (now - lastRandomPauseAt < RANDOM_PAUSE.cooldownMs) return false;

        const ms = randomBetween(RANDOM_PAUSE.minMs, RANDOM_PAUSE.maxMs);
        lastRandomPauseAt = now + ms;
        updateHUD(`${label} (${(ms / 1000).toFixed(1)}s)`, dotType);
        await abortableSleep(ms);
        return true;
    }

    // --- Single-Pass Shadow DOM & Same-Origin Iframe Root Collector ---
    function collectDocumentRoots(root = document, acc = []) {
        if (!root || acc.includes(root)) return acc;
        acc.push(root);
        const nodes = root.querySelectorAll('*');
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node.shadowRoot) collectDocumentRoots(node.shadowRoot, acc);
            if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
                try {
                    const doc = node.contentDocument;
                    if (doc && doc.documentElement) collectDocumentRoots(doc, acc);
                } catch (e) {}
            }
        }
        return acc;
    }

    function queryAllInRoots(roots, selector) {
        const results = [];
        for (let i = 0; i < roots.length; i++) {
            try {
                const found = roots[i].querySelectorAll(selector);
                for (let j = 0; j < found.length; j++) results.push(found[j]);
            } catch (e) {}
        }
        return results;
    }

    function triggerAbort(customMessage = 'Stopped', msgType = 'error') {
        abortRequested = true;
        autoFarmActive = false;
        writeAutoFarmFlag(false);
        clearAutoFarmHandoff();
        releaseActiveTabLock(true);

        for (const req of activeXhrs) {
            try {
                if (req && typeof req.abort === 'function') req.abort();
            } catch (e) {}
        }
        activeXhrs.clear();

        for (const wake of activeSleepResolvers) {
            try { wake(); } catch (e) {}
        }
        activeSleepResolvers.clear();

        isProcessing = false;
        syncGUIProcessingState();
        updateHUD(customMessage, msgType, 2500);
    }

    function abortableSleep(ms) {
        if (abortRequested) return Promise.resolve();
        return new Promise((resolve) => {
            let timer = null;
            const wake = () => {
                if (timer !== null) clearTimeout(timer);
                activeSleepResolvers.delete(wake);
                resolve();
            };
            activeSleepResolvers.add(wake);
            timer = setTimeout(wake, ms);
        });
    }

    function isHudElement(el) {
        if (!el || !hudHost) return false;
        if (el === hudHost) return true;
        try {
            if (hudHost.contains(el)) return true;
            const root = el.getRootNode ? el.getRootNode() : null;
            if (root && root.host && root.host === hudHost) return true;
        } catch (e) {}
        return false;
    }

    function getHudStyleCss() {
        return `
            :host {
                all: initial;
                position: fixed;
                right: 0;
                bottom: 0;
                width: 0;
                height: 0;
                overflow: visible;
                z-index: 2147483647;
                pointer-events: none;
            }
            .pill {
                position: fixed;
                bottom: 20px;
                right: 20px;
                pointer-events: auto;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 8px 6px 12px;
                border-radius: 9999px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 13px;
                font-weight: 500;
                line-height: 1;
                color: #ececec;
                background: rgba(33, 33, 33, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.08);
                user-select: none;
                transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s ease, padding 0.25s ease;
                max-width: calc(100vw - 16px);
                opacity: 0.96;
            }
            .pill:hover {
                opacity: 1;
                box-shadow: 0 10px 32px rgba(0, 0, 0, 0.36), 0 0 0 1px rgba(255, 255, 255, 0.14);
            }
            .pill.min {
                padding: 6px;
            }
            .pill.min .col {
                display: none !important;
            }
            .drag {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                cursor: grab;
                padding-right: 4px;
            }
            .drag:active {
                cursor: grabbing;
            }
            .dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background-color: #10a37f;
                flex-shrink: 0;
                transition: background-color 0.25s ease, transform 0.25s ease;
            }
            .dot.working {
                background-color: #f59e0b;
                animation: p 1.2s infinite ease-in-out;
            }
            .dot.active {
                background-color: #10a37f;
            }
            .dot.farming {
                background-color: #10a37f;
                animation: p 1.4s infinite ease-in-out;
            }
            .dot.error {
                background-color: #ef4444;
            }
            .dot.info {
                background-color: #ececec;
            }
            @keyframes p {
                0%, 100% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.35); opacity: 0.55; }
            }
            .txt {
                max-width: 155px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: #d4d4d4;
                font-size: 12.5px;
                letter-spacing: -0.01em;
                transition: color 0.2s ease;
            }
            .div {
                width: 1px;
                height: 16px;
                background: rgba(255, 255, 255, 0.1);
                margin: 0 2px;
            }
            .b {
                appearance: none;
                border: none;
                outline: none;
                background: rgba(255, 255, 255, 0.07);
                color: #ececec;
                font-family: inherit;
                font-size: 12px;
                font-weight: 500;
                padding: 6px 11px;
                border-radius: 9999px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                transition: background 0.16s ease, transform 0.12s ease, color 0.16s ease, box-shadow 0.16s ease;
            }
            .b:hover {
                background: rgba(255, 255, 255, 0.14);
            }
            .b:active {
                transform: scale(0.95);
            }
            .bp {
                background: #ececec;
                color: #171717;
                font-weight: 600;
            }
            .bp:hover {
                background: #ffffff;
            }
            .bs {
                background: rgba(239, 68, 68, 0.18);
                color: #fca5a5;
                box-shadow: inset 0 0 0 1px rgba(239, 68, 68, 0.35);
            }
            .bs:hover {
                background: rgba(239, 68, 68, 0.28);
                color: #ffffff;
            }
            .ba {
                background: rgba(16, 163, 127, 0.22);
                color: #6ee7b7;
                box-shadow: inset 0 0 0 1px rgba(16, 163, 127, 0.5);
            }
            .ba:hover {
                background: rgba(16, 163, 127, 0.32);
                color: #ffffff;
            }
            .bi {
                padding: 6px;
                width: 26px;
                height: 26px;
                justify-content: center;
                background: transparent;
                color: #9b9b9b;
            }
            .bi:hover {
                background: rgba(255, 255, 255, 0.08);
                color: #ececec;
            }
        `;
    }

    function syncGUIProcessingState() {
        if (!hudElement) return;
        const busy = isProcessing || autoFarmActive;
        if (solveBtnEl && abortBtnEl) {
            if (busy) {
                solveBtnEl.style.display = 'none';
                abortBtnEl.style.display = 'inline-flex';
            } else {
                solveBtnEl.style.display = 'inline-flex';
                abortBtnEl.style.display = 'none';
            }
        }
        if (autoBtnEl) {
            autoBtnEl.classList.toggle('ba', autoFarmActive);
            autoBtnEl.title = autoFarmActive
                ? 'Auto-Farm ON — click or press Alt+F / Alt+X to stop'
                : 'Auto-Farm: automatically solve and click Next (Alt+F)';
        }
    }

    function createHudSvg(width, height, svgAttrs, shapes) {
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.setAttribute('viewBox', '0 0 24 24');
        for (const [k, v] of Object.entries(svgAttrs)) {
            svg.setAttribute(k, v);
        }
        for (const [tag, attrs] of shapes) {
            const el = document.createElementNS(svgNS, tag);
            for (const [k, v] of Object.entries(attrs)) {
                el.setAttribute(k, v);
            }
            svg.appendChild(el);
        }
        return svg;
    }

    function createHudButton(className, title, children) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = className;
        btn.title = title;
        for (const child of children) {
            btn.appendChild(child);
        }
        return btn;
    }

    function initHUD() {
        if (hudElement) return hudElement;

        // Keep the HUD isolated from host page styles, selectors, and strict CSP checks
        hudHost = document.createElement('div');
        const shadow = hudHost.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = getHudStyleCss();

        hudElement = document.createElement('div');
        hudElement.className = 'pill';

        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag';
        dragHandle.title = 'Drag to move';

        statusDotEl = document.createElement('span');
        statusDotEl.className = 'dot active';

        statusTextEl = document.createElement('span');
        statusTextEl.className = 'txt col';
        statusTextEl.textContent = 'Ready';

        dragHandle.appendChild(statusDotEl);
        dragHandle.appendChild(statusTextEl);

        const divider = document.createElement('div');
        divider.className = 'div col';

        const solveLabel = document.createElement('span');
        solveLabel.textContent = 'Solve';
        solveBtnEl = createHudButton('b bp col', 'Solve question or page (Alt+A)', [
            createHudSvg(11, 11, { fill: 'currentColor' }, [['path', { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' }]]),
            solveLabel
        ]);

        const stopLabel = document.createElement('span');
        stopLabel.textContent = 'Stop';
        abortBtnEl = createHudButton('b bs col', 'Stop immediately (Alt+X)', [
            createHudSvg(10, 10, { fill: 'currentColor' }, [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }]]),
            stopLabel
        ]);
        abortBtnEl.style.display = 'none';

        const nextLabel = document.createElement('span');
        nextLabel.textContent = 'Next';
        const nextBtnEl = createHudButton('b col', 'Click Next / Continue (Alt+S)', [
            nextLabel,
            createHudSvg(11, 11, { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [['path', { d: 'M5 12h14M12 5l7 7-7 7' }]])
        ]);

        const autoLabel = document.createElement('span');
        autoLabel.textContent = 'Auto';
        autoBtnEl = createHudButton('b col', 'Auto-Farm: automatically solve and click Next (Alt+F)', [
            createHudSvg(11, 11, { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
                ['path', { d: 'M17 2l4 4-4 4' }],
                ['path', { d: 'M3 11v-1a4 4 0 0 1 4-4h14' }],
                ['path', { d: 'M7 22l-4-4 4-4' }],
                ['path', { d: 'M21 13v1a4 4 0 0 1-4 4H3' }]
            ]),
            autoLabel
        ]);

        const toggleBtnEl = createHudButton('b bi', 'Minimize / Expand', [
            createHudSvg(12, 12, { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }, [['path', { d: 'M6 12h12' }]])
        ]);

        hudElement.append(dragHandle, divider, solveBtnEl, abortBtnEl, nextBtnEl, autoBtnEl, toggleBtnEl);

        hudElement.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) e.preventDefault();
        });

        solveBtnEl.addEventListener('click', () => {
            if (!isProcessing && !autoFarmActive) runSolverEntry();
        });

        abortBtnEl.addEventListener('click', () => {
            triggerAbort();
        });

        nextBtnEl.addEventListener('click', () => {
            clickNextOrSubmitButton();
        });

        autoBtnEl.addEventListener('click', () => {
            toggleAutoFarm();
        });

        toggleBtnEl.addEventListener('click', () => {
            hudElement.classList.toggle('min');
        });

        let isDragging = false;
        let startX = 0, startY = 0, origRight = 20, origBottom = 20;
        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = hudElement.getBoundingClientRect();
            origRight = window.innerWidth - rect.right;
            origBottom = window.innerHeight - rect.bottom;
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            hudElement.style.right = `${Math.max(8, Math.min(window.innerWidth - 60, origRight - dx))}px`;
            hudElement.style.bottom = `${Math.max(8, Math.min(window.innerHeight - 40, origBottom - dy))}px`;
        }, { passive: true });
        window.addEventListener('mouseup', () => {
            isDragging = false;
        });

        shadow.append(style, hudElement);
        document.documentElement.appendChild(hudHost);
        return hudElement;
    }

    function updateHUD(text, type = 'info', autoHideMs = 0) {
        initHUD();
        clearTimeout(hideTimer);

        if (statusDotEl) {
            statusDotEl.className = `dot ${type || 'info'}`;
        }
        if (statusTextEl) {
            statusTextEl.textContent = text;
        }
        syncGUIProcessingState();

        if (autoHideMs > 0) {
            hideTimer = setTimeout(() => {
                if (!isProcessing && !autoFarmActive && statusTextEl && statusDotEl) {
                    statusTextEl.textContent = 'Ready';
                    statusDotEl.className = 'dot active';
                }
            }, autoHideMs);
        }
    }

    let subFrameActivated = !isSubFrame;

    if (!isSubFrame) {
        registerUserscriptMenuCommands();
        handleFirstInstallWelcome();

        if (isOnWelcomePage()) {
            initWelcomePageBridge();
            checkForScriptUpdate(false);
            return;
        }

        initHUD();
        setTimeout(() => checkForScriptUpdate(false), 3500);
        window.addEventListener('message', (e) => {
            if (e?.data?.__gtSurveyFrameActive && hudHost && !isProcessing && !autoFarmActive) {
                try {
                    if (findAllQuestionBlocksOnPage(collectDocumentRoots()).length === 0) {
                        hudHost.style.display = 'none';
                    }
                } catch (err) {}
            }
        });
    } else {
        const tryActivateSubFrame = () => {
            if (subFrameActivated) return true;
            try {
                if (findAllQuestionBlocksOnPage(collectDocumentRoots()).length > 0) {
                    subFrameActivated = true;
                    initHUD();
                    try { window.top.postMessage({ __gtSurveyFrameActive: true }, '*'); } catch (e) {}
                    const resumeMode = readAutoFarmFlag();
                    if (resumeMode && !autoFarmActive && !autoFarmLoopRunning) {
                        startAutoFarm(resumeMode);
                    }
                    return true;
                }
            } catch (e) {}
            return false;
        };
        if (!tryActivateSubFrame()) {
            let subObs = null;
            try {
                subObs = new MutationObserver(() => {
                    if (tryActivateSubFrame() && subObs) subObs.disconnect();
                });
                subObs.observe(document.documentElement || document.body, { childList: true, subtree: true });
                setTimeout(() => { if (subObs) subObs.disconnect(); }, 10000);
            } catch (e) {}
        }
    }

    document.addEventListener('selectionchange', () => {
        if (isProcessing) return;
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (text.length > 1) {
            cachedSelection = text;
        }
    });

    async function runSolverEntry() {
        if (isProcessing) return;
        isProcessing = true;
        abortRequested = false;
        syncGUIProcessingState();
        try {
            await executeUniversalAction(false);
        } finally {
            cachedSelection = '';
            isProcessing = false;
            abortRequested = false;
            syncGUIProcessingState();
        }
    }

    // --- Auto-Farm Engine ---
    function toggleAutoFarm() {
        if (autoFarmActive) {
            triggerAbort('Auto-Farm off', 'info');
        } else {
            startAutoFarm(false);
        }
    }

    function startAutoFarm(resumeMode = false) {
        const isRedirect = resumeMode === 'redirect';
        const isResume = Boolean(resumeMode);
        if (!isResume || isRedirect) {
            clearSessionMemory();
            writeReloadStuckState('', 0);
        }
        autoFarmActive = true;
        abortRequested = false;
        claimActiveTabLock(isOfferWallPage() ? 'offerwall' : 'survey');
        writeAutoFarmFlag(true);
        stampAutoFarmHandoff(isOfferWallPage());
        syncGUIProcessingState();
        if (!autoFarmLoopRunning) {
            runAutoFarmLoop(resumeMode);
        }
    }

    function isActuallyRenderedInViewport(el) {
        if (!el) return false;
        let curr = el;
        while (curr && curr.nodeType === 1) {
            const style = window.getComputedStyle(curr);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
                return false;
            }
            curr = curr.parentElement;
        }
        const r = el.getBoundingClientRect();
        if (r.width <= 10 || r.height <= 10) return false;
        // Must actually intersect the visible viewport (excludes off-screen -10000px hidden challenge frames)
        return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    }

    function isPassiveCaptchaBadge(el) {
        if (!el) return true;
        if (el.closest('.grecaptcha-badge')) return true;
        const src = (el.getAttribute('src') || '').toLowerCase();
        if (src.includes('size=invisible')) return true;
        const dataSize = (el.getAttribute('data-size') || '').toLowerCase();
        if (dataSize === 'invisible') return true;

        // Ignore floating fixed corner badges (e.g. reCAPTCHA v3 / Enterprise corner pill)
        const r = el.getBoundingClientRect();
        let curr = el;
        while (curr && curr.nodeType === 1 && curr !== document.body) {
            const st = window.getComputedStyle(curr);
            if (st.position === 'fixed') {
                const nearBottom = r.bottom >= window.innerHeight - 28;
                const nearSide = r.right >= window.innerWidth - 28 || r.left <= 28;
                if (nearBottom && nearSide && r.height <= 90 && r.width <= 300) {
                    return true;
                }
            }
            curr = curr.parentElement;
        }
        return false;
    }

    function hasSolvedCaptchaToken(roots, provider) {
        const selMap = {
            recaptcha: 'textarea[name="g-recaptcha-response"], textarea.g-recaptcha-response',
            hcaptcha: 'textarea[name="h-captcha-response"]',
            turnstile: 'input[name="cf-turnstile-response"]'
        };
        const sel = selMap[provider];
        if (!sel) return false;
        const fields = queryAllInRoots(roots, sel);
        return fields.some(f => (f.value || '').trim().length > 10);
    }

    // Returns null (no blocking CAPTCHA), 'overlay' (active challenge modal), or 'widget' (unsolved interactive checkbox)
    function detectBlockingCaptcha(roots, hasSurveyQuestions = false) {
        // 1. Active challenge popups / modals (bframe, hCaptcha challenge, Arkose/FunCaptcha, GeeTest)
        const overlayFrames = queryAllInRoots(
            roots,
            'iframe[src*="recaptcha" i][src*="bframe" i], iframe[src*="hcaptcha" i][src*="challenge" i], iframe[src*="arkoselabs" i], iframe[src*="funcaptcha" i], iframe[src*="geetest" i]'
        );
        for (const frame of overlayFrames) {
            if (!isActuallyRenderedInViewport(frame) || isPassiveCaptchaBadge(frame)) continue;
            const r = frame.getBoundingClientRect();
            if (r.width >= 200 && r.height >= 200) {
                return 'overlay';
            }
        }

        // 2. Interactive inline CAPTCHA widgets (v2 checkbox, hCaptcha checkbox, visible Turnstile)
        const recaptchaAnchors = queryAllInRoots(roots, 'iframe[src*="recaptcha" i][src*="anchor" i]');
        for (const frame of recaptchaAnchors) {
            if (isPassiveCaptchaBadge(frame) || !isActuallyRenderedInViewport(frame)) continue;
            const r = frame.getBoundingClientRect();
            if (r.width >= 150 && r.height >= 50 && !hasSolvedCaptchaToken(roots, 'recaptcha')) {
                return 'widget';
            }
        }

        const hcaptchaFrames = queryAllInRoots(roots, 'iframe[src*="hcaptcha" i]');
        for (const frame of hcaptchaFrames) {
            if (isPassiveCaptchaBadge(frame) || !isActuallyRenderedInViewport(frame)) continue;
            const r = frame.getBoundingClientRect();
            if (r.width >= 150 && r.height >= 50 && !hasSolvedCaptchaToken(roots, 'hcaptcha')) {
                return 'widget';
            }
        }

        const turnstileFrames = queryAllInRoots(roots, 'iframe[src*="challenges.cloudflare.com" i], iframe[src*="turnstile" i]');
        for (const frame of turnstileFrames) {
            if (isPassiveCaptchaBadge(frame) || !isActuallyRenderedInViewport(frame)) continue;
            const r = frame.getBoundingClientRect();
            if (r.width >= 150 && r.height >= 45 && !hasSolvedCaptchaToken(roots, 'turnstile')) {
                return 'widget';
            }
        }

        // 3. Image/text CAPTCHA gates (detected even when the CAPTCHA renders its own text input)
        const bodyText = (document.body?.innerText || '').slice(0, 2500);
        if (/\b(?:please\s+)?(?:enter|type)\s+(?:the\s+)?(?:text|characters?|letters?|numbers?|words?|code)\s+(?:that\s+)?(?:you\s+see|shown|displayed)?\s*(?:in\s+the\s+image|above|below)/i.test(bodyText)) {
            return 'overlay';
        }

        // 4. Text-only CAPTCHA gate check ONLY when there are no normal survey questions on the page
        if (!hasSurveyQuestions) {
            if (/\b(i['’]?m not a robot|verify you are human|complete the captcha|prove you are human|type the characters you see|please check the box below to proceed)\b/i.test(bodyText)) {
                return 'widget';
            }
        }

        return null;
    }

    function detectEndOfSurveyPage(cachedRoots = null) {
        try {
            const roots = cachedRoots || collectDocumentRoots();
            const hasForwardBtn = Boolean(findNextOrSubmitButton(roots));
            if (hasForwardBtn) return false;
            const hasActiveInputs = queryAllInRoots(
                roots,
                'input:not([type="hidden"]), select, textarea, [role="radio"], [role="checkbox"], [role="listbox"][aria-expanded], [data-testid^="option-"]'
            ).some(el => isElementVisible(el) && !isHudElement(el));
            if (hasActiveInputs) return false;
        } catch (e) {}

        const bodyText = (document.body?.innerText || '').slice(0, 3000);
        if (/\b(thank you for completing|survey (?:is )?complete|you have completed|unfortunately[,\s]+you (?:did not|do not) qualify|not a match for this survey|screened out|quota full|redirecting you back|your response has been recorded)\b/i.test(bodyText)) {
            return true;
        }
        if (/\bthank you for (?:participating|taking|your time)\b/i.test(bodyText) &&
            !/\b(will take|minutes to complete|to begin|to continue|click next|confidentiality notice|attention[- ]check)\b/i.test(bodyText)) {
            return true;
        }
        return false;
    }

    function getPageSignature(roots, blocks) {
        const promptSample = blocks
            .slice(0, 4)
            .map(b => {
                const p = (b.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 220);
                const firstKey = b.choices?.[0]?.input?.name || b.choices?.[0]?.input?.id || b.rows?.[0]?.input?.name || b.element?.id || '';
                return `${b.type}:${firstKey}:${p}:${isBlockAnswered(b) ? '1' : '0'}`;
            })
            .join('|');
        const nextBtn = findNextOrSubmitButton(roots);
        const nextLabel = nextBtn ? (nextBtn.innerText || nextBtn.value || nextBtn.closest('[button-title]')?.getAttribute('button-title') || nextBtn.id || 'next').trim().slice(0, 20) : 'none';
        const bodySnippet = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        return `${location.origin}${location.pathname}${location.hash}#${blocks.length}#${nextLabel}#${promptSample || bodySnippet}`;
    }

    async function waitForPageTransition(prevSignature, maxWaitMs = 4500, prevUrl = location.href) {
        const start = Date.now();
        let domMutated = false;
        let observer = null;

        try {
            observer = new MutationObserver(() => {
                domMutated = true;
            });
            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'disabled', 'hidden', 'aria-hidden']
            });
        } catch (e) {}

        try {
            while (!abortRequested && autoFarmActive && (Date.now() - start) < maxWaitMs) {
                await abortableSleep(SPD.transitionPoll);
                if (abortRequested || !autoFarmActive) return false;

                if (domMutated || location.href !== prevUrl) {
                    domMutated = false;
                    await abortableSleep(SPD.transitionSettle);
                    if (abortRequested || !autoFarmActive) return false;

                    const freshRoots = collectDocumentRoots();
                    const freshBlocks = findAllQuestionBlocksOnPage(freshRoots);
                    const freshSig = getPageSignature(freshRoots, freshBlocks);
                    if (freshSig !== prevSignature) return true;
                }
            }
        } finally {
            if (observer) {
                try { observer.disconnect(); } catch (e) {}
            }
        }
        return false;
    }

    function findVideoGateOnPage(roots) {
        const videoCandidates = queryAllInRoots(
            roots,
            '.video__container, #sproutvideo-player-container, .sproutvideo-player, [class*="video-player" i], [class*="video__container" i], video, iframe[src*="sproutvideo" i], iframe[src*="vimeo" i], iframe[src*="youtube" i], iframe[src*="wistia" i], iframe[src*="jwplayer" i], iframe[src*="brightcove" i], iframe[title*="video" i], iframe[title*="player" i]'
        ).filter(el => isElementVisible(el) && !isHudElement(el));

        if (videoCandidates.length === 0) return null;

        const firstEl = videoCandidates[0];
        const container = firstEl.closest('.video__container, #sproutvideo-player-container, [class*="video-player" i], [class*="video__container" i], .treatment') || firstEl.parentElement || firstEl;
        const overlayPlay = queryAllInRoots(roots, '.video__overlay, [class*="video__overlay" i], [class*="play-button" i], [class*="big-play" i], button[aria-label*="play" i], [role="button"][aria-label*="play" i], svg.feather-play')
            .find(el => isElementVisible(el) && !isHudElement(el) && (container.contains(el) || el.contains(firstEl)));
        const videoEl = container.querySelector('video') || (firstEl.tagName === 'VIDEO' ? firstEl : null);
        const iframe = container.querySelector('iframe') || (firstEl.tagName === 'IFRAME' ? firstEl : null);
        const progressBar = container.querySelector('.progress__bar, [class*="progress__bar" i], [role="progressbar"]');
        const playTarget = overlayPlay ? (overlayPlay.closest('button, [role="button"], .video__overlay, [class*="video__overlay" i]') || overlayPlay) : null;

        return { container, playTarget, videoEl, iframe, progressBar };
    }

    function readVideoProgressPercent(gate) {
        if (!gate) return null;
        if (gate.videoEl && isFinite(gate.videoEl.duration) && gate.videoEl.duration > 0) {
            return Math.max(0, Math.min(100, (gate.videoEl.currentTime / gate.videoEl.duration) * 100));
        }
        if (gate.progressBar) {
            const ariaNow = parseFloat(gate.progressBar.getAttribute('aria-valuenow') || '');
            if (!isNaN(ariaNow)) return Math.max(0, Math.min(100, ariaNow));
            const styleW = (gate.progressBar.getAttribute('style') || '').match(/width\s*:\s*(\d+(?:\.\d+)?)%/i);
            if (styleW && styleW[1]) return Math.max(0, Math.min(100, parseFloat(styleW[1])));
        }
        return null;
    }

    async function ensureVideoPlaybackStarted(gate) {
        if (!gate || !gate.container || startedVideoTargets.has(gate.container) || abortRequested) return;
        startedVideoTargets.add(gate.container);

        updateHUD('Starting video...', 'farming');
        try { gate.container.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (e) {}

        const clickTarget = (gate.playTarget && isElementVisible(gate.playTarget))
            ? gate.playTarget
            : ((gate.videoEl && gate.videoEl.paused && !gate.videoEl.ended) ? gate.videoEl : (gate.iframe || gate.container));

        if (clickTarget && isElementVisible(clickTarget)) {
            await triggerNativeClick(clickTarget, null, null);
        }
        if (gate.videoEl && gate.videoEl.paused && !gate.videoEl.ended) {
            try { await gate.videoEl.play(); } catch (e) {}
        }
    }

    async function runAutoFarmLoop(resumeMode = false) {
        if (autoFarmLoopRunning) return;
        autoFarmLoopRunning = true;

        try {
            const isRedirect = resumeMode === 'redirect';
            const isResume = Boolean(resumeMode);
            if (isRedirect) {
                updateHUD('Redirected: Auto-Farm...', 'farming');
                await abortableSleep(randomBetween(SPD.reloadResume[0], SPD.reloadResume[1]));
            } else if (isResume) {
                updateHUD('Auto-Farm resuming...', 'farming');
                await abortableSleep(randomBetween(SPD.reloadResume[0], SPD.reloadResume[1]));
            } else {
                updateHUD('Auto-Farm active', 'farming');
            }

            const persistedStuck = (isResume && !isRedirect) ? readReloadStuckState() : { sig: '', count: 0 };
            if (!isResume || isRedirect) writeReloadStuckState('', 0);
            let currentLoopSurveyKey = getSurveyIdentityKey();
            let lastStuckSignature = persistedStuck.sig;
            let sameSignatureClicks = persistedStuck.count;
            let emptyIdleTicks = 0;

            while (autoFarmActive && !abortRequested) {
                const onOfferWallNow = isOfferWallPage();
                if (isOtherTabLockActive()) {
                    if (onOfferWallNow && isTrueAutoEnabled() && hasActiveSurveyLockElsewhere()) {
                        updateHUD('Standby: survey active', 'info');
                        await abortableSleep(1500);
                        continue;
                    }
                    pauseAsOtherTab();
                    return;
                }
                if (document.hidden) {
                    if (onOfferWallNow && isTrueAutoEnabled()) {
                        updateHUD('Standby: survey tab open', 'info');
                        await abortableSleep(1500);
                        continue;
                    }
                    releaseActiveTabLock(false);
                    pauseAsOtherTab('Paused: tab in background');
                    return;
                }
                heartbeatActiveTabLock(onOfferWallNow ? 'offerwall' : 'survey');

                const liveSurveyKey = getSurveyIdentityKey();
                if (liveSurveyKey !== currentLoopSurveyKey) {
                    currentLoopSurveyKey = liveSurveyKey;
                    lastStuckSignature = '';
                    sameSignatureClicks = 0;
                    emptyIdleTicks = 0;
                    lastRandomPauseAt = 0;
                    clearSessionMemory();
                    writeReloadStuckState('', 0);
                    updateHUD('New survey: Auto-Farm...', 'farming');
                    await abortableSleep(randomBetween(SPD.reloadResume[0], SPD.reloadResume[1]));
                    continue;
                }

                // Refresh cross-origin handoff token while active and inspect page blocks
                stampAutoFarmHandoff();
                const roots = collectDocumentRoots();

                // Offer-wall / survey-list guard (e.g. PrimeEarn, gain.gg/surveys)
                if (isOfferWallPage(roots)) {
                    if (!isTrueAutoEnabled()) {
                        triggerAbort('Stopped on survey list (True Auto off)', 'info');
                        return;
                    }

                    // Dismiss post-survey feedback/rating modal if blocking offer cards
                    const closeModalBtn = queryAllInRoots(roots, '[data-test-id="close-modal-button"], [data-testid="close-modal-button"]')
                        .find(el => isElementVisible(el) && !isHudElement(el));
                    if (closeModalBtn) {
                        updateHUD('Closing modal...', 'farming');
                        await triggerNativeClick(closeModalBtn, null, null);
                        await abortableSleep(500);
                        continue;
                    }

                    const cards = findOfferWallSurveyCards(roots);
                    if (cards.length > 0) {
                        const recentIds = new Set(readRecentPickedSurveys().map(it => it.id));
                        let available = cards.filter(c => !recentIds.has(c.id));
                        if (available.length === 0) available = cards;
                        available.sort((a, b) => b.score - a.score);
                        const chosen = available[0];
                        markSurveyPicked(chosen.id);
                        updateHUD('True Auto: picking survey...', 'farming');
                        await abortableSleep(randomBetween(700, 1200));
                        if (abortRequested || !autoFarmActive) return;
                        if (document.hidden || isOtherTabLockActive()) continue;
                        writeAutoFarmFlag(true);
                        stampAutoFarmHandoff(true);
                        await triggerNativeClick(chosen.el, null, null);
                        await abortableSleep(2000);
                        if (abortRequested || !autoFarmActive) return;

                        // Wait in standby while the opened survey tab is active/open; only resume if it closes & focus returns
                        while (autoFarmActive && !abortRequested && isOfferWallPage()) {
                            if (!isTrueAutoEnabled()) {
                                triggerAbort('Stopped on survey list (True Auto off)', 'info');
                                return;
                            }
                            if (document.hidden || hasActiveSurveyLockElsewhere()) {
                                updateHUD('Standby: survey active', 'info');
                                await abortableSleep(1500);
                                continue;
                            }
                            if (isOtherTabLockActive()) {
                                pauseAsOtherTab();
                                return;
                            }
                            // Confirm no newly opened survey tab is still booting before picking another
                            await abortableSleep(1800);
                            if (abortRequested || !autoFarmActive) return;
                            if (document.hidden || hasActiveSurveyLockElsewhere()) continue;
                            claimActiveTabLock('offerwall');
                            break;
                        }
                        continue;
                    }
                }

                const initialBlocks = findAllQuestionBlocksOnPage(roots);

                // 1. Safety halt only on an active blocking CAPTCHA (ignores passive v3/invisible badges)
                const preCaptcha = detectBlockingCaptcha(roots, initialBlocks.length > 0);
                if (preCaptcha === 'overlay' || (preCaptcha === 'widget' && initialBlocks.length === 0)) {
                    triggerAbort('Paused: CAPTCHA', 'error');
                    return;
                }

                // 2. Solve all unanswered questions (including progressively revealed follow-ups & multi-item carousels)
                let progressivePass = 0;
                let solvedAnyOnPage = false;
                let lastProgressiveSig = '';
                let sameProgressiveCount = 0;

                while (autoFarmActive && !abortRequested && progressivePass < 50) {
                    const passRoots = progressivePass === 0 ? roots : collectDocumentRoots();
                    const blocks = progressivePass === 0 ? initialBlocks : findAllQuestionBlocksOnPage(passRoots);
                    const unanswered = blocks.filter(b => !isBlockAnswered(b));

                    if (unanswered.length === 0) break;

                    const passSig = `${getPageSignature(passRoots, blocks)}|u:${unanswered.map(b => (b.prompt || '').slice(-80)).join('^').slice(0, 160)}`;
                    if (passSig === lastProgressiveSig) {
                        sameProgressiveCount++;
                        if (sameProgressiveCount >= 2) break;
                    } else {
                        lastProgressiveSig = passSig;
                        sameProgressiveCount = 0;
                    }

                    if (progressivePass === 0) {
                        await maybeRandomHumanPause(RANDOM_PAUSE.chanceBeforeSolve, 'Auto-Farm: reading...', 'farming');
                        if (abortRequested || !autoFarmActive) return;
                    }

                    isProcessing = true;
                    syncGUIProcessingState();
                    const res = await executeUniversalAction(true);
                    isProcessing = false;
                    syncGUIProcessingState();

                    if (abortRequested || !autoFarmActive) return;

                    if (res && res.hadError) {
                        triggerAbort('Farm paused: API error', 'error');
                        return;
                    }

                    if (res && res.solved > 0) {
                        solvedAnyOnPage = true;
                    } else {
                        break;
                    }

                    progressivePass++;
                    await abortableSleep(SPD.followupSettle);
                    if (abortRequested || !autoFarmActive) return;

                    // Carousels (e.g. Confirmit .cf-carousel) animate 350-750ms between items; wait briefly if transitioning
                    const hasActiveCarousel = passRoots.some(r => r.querySelector('.cf-carousel, [class*="carousel" i]'));
                    if (hasActiveCarousel) {
                        for (let cPoll = 0; cPoll < 4; cPoll++) {
                            const checkRoots = collectDocumentRoots();
                            const checkBlocks = findAllQuestionBlocksOnPage(checkRoots);
                            const checkSig = `${getPageSignature(checkRoots, checkBlocks)}|u:${checkBlocks.filter(b => !isBlockAnswered(b)).map(b => (b.prompt || '').slice(-80)).join('^').slice(0, 160)}`;
                            if (checkBlocks.some(b => !isBlockAnswered(b)) && checkSig !== passSig) break;
                            await abortableSleep(180);
                            if (abortRequested || !autoFarmActive) return;
                        }
                    }
                }

                if (abortRequested || !autoFarmActive) return;

                // 3. Re-evaluate page state after blurring active inputs cleanly
                const activeField = document.activeElement;
                if (activeField && !isHudElement(activeField) && (activeField.tagName === 'INPUT' || activeField.tagName === 'TEXTAREA' || activeField.isContentEditable)) {
                    try { activeField.blur(); } catch (e) {}
                    await abortableSleep(160);
                    if (abortRequested || !autoFarmActive) return;
                }

                let postRoots = collectDocumentRoots();
                let postBlocks = findAllQuestionBlocksOnPage(postRoots);
                const postCaptcha = detectBlockingCaptcha(postRoots, postBlocks.length > 0);
                if (postCaptcha) {
                    triggerAbort('Paused: CAPTCHA', 'error');
                    return;
                }

                let stillUnanswered = postBlocks.filter(b => !isBlockAnswered(b));
                if (stillUnanswered.length > 0) {
                    await abortableSleep(400);
                    if (abortRequested || !autoFarmActive) return;
                    isProcessing = true;
                    syncGUIProcessingState();
                    let retryRes = null;
                    try {
                        retryRes = await executeUniversalAction(true);
                    } finally {
                        isProcessing = false;
                        syncGUIProcessingState();
                    }
                    if (abortRequested || !autoFarmActive) return;
                    if (retryRes && retryRes.hadError) {
                        triggerAbort('Farm paused: API error', 'error');
                        return;
                    }
                    if (retryRes && retryRes.solved > 0) solvedAnyOnPage = true;
                    postRoots = collectDocumentRoots();
                    postBlocks = findAllQuestionBlocksOnPage(postRoots);
                    stillUnanswered = postBlocks.filter(b => !isBlockAnswered(b));
                }
                let nextBtn = findNextOrSubmitButton(postRoots);
                const videoGate = stillUnanswered.length === 0 ? findVideoGateOnPage(postRoots) : null;

                // Watch video gate (click once to start, wait until video completes / Next unlocks)
                if (videoGate && !nextBtn) {
                    await ensureVideoPlaybackStarted(videoGate);
                    if (abortRequested || !autoFarmActive) return;

                    const videoWaitStart = Date.now();
                    const maxVideoWaitMs = 6 * 60 * 1000;
                    while (!abortRequested && autoFarmActive && (Date.now() - videoWaitStart) < maxVideoWaitMs) {
                        if (getSurveyIdentityKey() !== currentLoopSurveyKey) break;
                        postRoots = collectDocumentRoots();
                        nextBtn = findNextOrSubmitButton(postRoots);
                        if (nextBtn) {
                            await abortableSleep(randomBetween(320, 560));
                            if (abortRequested || !autoFarmActive) return;
                            postRoots = collectDocumentRoots();
                            nextBtn = findNextOrSubmitButton(postRoots);
                            if (nextBtn) break;
                        }

                        const liveGate = findVideoGateOnPage(postRoots) || videoGate;
                        const pct = readVideoProgressPercent(liveGate);
                        const videoEnded = Boolean(liveGate.videoEl?.ended) || (pct !== null && pct >= 99);
                        if (videoEnded) {
                            updateHUD('Video done, waiting Next...', 'farming');
                        } else if (pct !== null && pct > 0) {
                            updateHUD(`Watching video (${Math.round(pct)}%)...`, 'farming');
                        } else {
                            updateHUD('Watching video...', 'farming');
                        }

                        await abortableSleep(750);
                    }
                    if (abortRequested || !autoFarmActive) return;
                    if (getSurveyIdentityKey() !== currentLoopSurveyKey) continue;
                    postBlocks = findAllQuestionBlocksOnPage(postRoots);
                }

                // If Next is present but briefly disabled (e.g. async enable or short countdown), wait for it to unlock
                const needsUndetectedAnswer = postBlocks.length === 0 && /\b(please select (?:an )?answer|select an option to continue|please answer)\b/i.test((document.body?.innerText || '').slice(0, 2000));
                if (!nextBtn && stillUnanswered.length === 0 && !needsUndetectedAnswer && findNextOrSubmitButton(postRoots, true)) {
                    updateHUD('Waiting for Next...', 'farming');
                    const unlockStart = Date.now();
                    while (!abortRequested && autoFarmActive && (Date.now() - unlockStart) < 15000) {
                        await abortableSleep(350);
                        if (abortRequested || !autoFarmActive) return;
                        postRoots = collectDocumentRoots();
                        nextBtn = findNextOrSubmitButton(postRoots);
                        if (nextBtn) break;
                    }
                    postBlocks = findAllQuestionBlocksOnPage(postRoots);
                }

                // If nothing to solve and no Next button, check for end screen or brief SPA loading state
                if (postBlocks.length === 0 && !nextBtn) {
                    if (detectEndOfSurveyPage(postRoots)) {
                        clearSessionMemory();
                        triggerAbort('Auto-Farm finished', 'active');
                        return;
                    }
                    emptyIdleTicks++;
                    if (emptyIdleTicks === 5 && !isOfferWallPage(postRoots)) {
                        const healSig = getPageSignature(postRoots, postBlocks);
                        const rescued = await attemptLastResortAiNavigation('waiting_for_page', postRoots, postBlocks, healSig);
                        if (abortRequested || !autoFarmActive) return;
                        if (rescued) {
                            emptyIdleTicks = 0;
                            continue;
                        }
                    }
                    if (emptyIdleTicks >= 10) {
                        triggerAbort('Farm stopped: no page', 'info');
                        return;
                    }
                    updateHUD('Waiting for page...', 'farming');
                    await abortableSleep(1500);
                    continue;
                }
                emptyIdleTicks = 0;

                if (!nextBtn) {
                    if (detectEndOfSurveyPage(postRoots)) {
                        clearSessionMemory();
                        triggerAbort('Auto-Farm finished', 'active');
                        return;
                    }

                    // Auto-advancing single-choice/chat UIs (e.g. Quest Mindshare) transition without a Next button
                    if (solvedAnyOnPage && stillUnanswered.length === 0) {
                        updateHUD('Waiting for next question...', 'farming');
                        const autoAdvStart = Date.now();
                        let nextAppeared = false;
                        while (!abortRequested && autoFarmActive && (Date.now() - autoAdvStart) < 4500) {
                            await abortableSleep(250);
                            if (abortRequested || !autoFarmActive) return;
                            if (getSurveyIdentityKey() !== currentLoopSurveyKey) {
                                nextAppeared = true;
                                break;
                            }
                            const advRoots = collectDocumentRoots();
                            nextBtn = findNextOrSubmitButton(advRoots);
                            if (nextBtn) {
                                postRoots = advRoots;
                                postBlocks = findAllQuestionBlocksOnPage(advRoots);
                                break;
                            }
                            const advBlocks = findAllQuestionBlocksOnPage(advRoots);
                            if (advBlocks.some(b => !isBlockAnswered(b)) || advBlocks.length === 0) {
                                nextAppeared = true;
                                break;
                            }
                            if (detectEndOfSurveyPage(advRoots)) {
                                clearSessionMemory();
                                triggerAbort('Auto-Farm finished', 'active');
                                return;
                            }
                        }
                        if (nextAppeared) {
                            await abortableSleep(SPD.followupSettle);
                            continue;
                        }
                    }

                    if (!nextBtn) {
                        if (detectEndOfSurveyPage(postRoots)) {
                            clearSessionMemory();
                            triggerAbort('Auto-Farm finished', 'active');
                            return;
                        }
                        const healSig = getPageSignature(postRoots, postBlocks);
                        const rescued = await attemptLastResortAiNavigation('no_next_button', postRoots, postBlocks, healSig);
                        if (abortRequested || !autoFarmActive) return;
                        if (rescued) continue;
                        triggerAbort('Farm paused: no Next', 'info');
                        return;
                    }
                }

                // Never blindly click Next when detected required blocks remain unanswered
                if (stillUnanswered.length > 0) {
                    const healSig = getPageSignature(postRoots, postBlocks);
                    const rescued = await attemptLastResortAiNavigation('unanswered_field', postRoots, postBlocks, healSig);
                    if (abortRequested || !autoFarmActive) return;
                    if (rescued) continue;
                    writeReloadStuckState('', 0);
                    triggerAbort('Paused: unanswered field', 'error');
                    return;
                }

                // Guard against infinite retry loops on validation-blocked pages (persists across full page reloads)
                const sigBeforeClick = getPageSignature(postRoots, postBlocks);
                const maxSameSigAttempts = stillUnanswered.length > 0 ? 2 : 3;
                if (!solvedAnyOnPage && sigBeforeClick === lastStuckSignature) {
                    sameSignatureClicks++;
                    if (sameSignatureClicks >= maxSameSigAttempts) {
                        const rescued = await attemptLastResortAiNavigation('stuck_retry_limit', postRoots, postBlocks, sigBeforeClick);
                        if (abortRequested || !autoFarmActive) return;
                        if (rescued) {
                            lastStuckSignature = '';
                            sameSignatureClicks = 0;
                            writeReloadStuckState('', 0);
                            continue;
                        }
                        writeReloadStuckState('', 0);
                        triggerAbort(
                            stillUnanswered.length > 0 ? 'Paused: unanswered field' : 'Farm paused: stuck',
                            'error'
                        );
                        return;
                    }
                } else {
                    lastStuckSignature = sigBeforeClick;
                    sameSignatureClicks = 1;
                }
                writeReloadStuckState(lastStuckSignature, sameSignatureClicks);

                // 4. Guaranteed settle break before clicking Next (always pauses cleanly after answering or retrying)
                const didRandomPause = await maybeRandomHumanPause(RANDOM_PAUSE.chanceBeforeNext, 'Auto-Farm: pausing...', 'farming');
                if (abortRequested || !autoFarmActive) return;
                if (!didRandomPause) {
                    const useSolvedBreak = solvedAnyOnPage || sameSignatureClicks > 1;
                    const preNextRange = useSolvedBreak ? SPD.preNextSolved : SPD.preNextEmpty;
                    const preNextDelay = randomBetween(preNextRange[0], preNextRange[1]);
                    updateHUD('Auto-Farm: Next...', 'farming');
                    await abortableSleep(preNextDelay);
                    if (abortRequested || !autoFarmActive) return;
                }

                if (isOtherTabLockActive()) {
                    pauseAsOtherTab();
                    return;
                }
                const prevPageUrl = location.href;
                stampAutoFarmHandoff();
                const clickRoots = collectDocumentRoots();
                const clicked = await clickNextOrSubmitButton(true, clickRoots);
                if (!clicked) {
                    triggerAbort('Farm paused: no Next', 'info');
                    return;
                }

                // 5. Wait for either full page reload (ends script naturally) or SPA DOM transition
                const changed = await waitForPageTransition(sigBeforeClick, 4500, prevPageUrl);
                if (abortRequested || !autoFarmActive) return;

                if (changed) {
                    lastStuckSignature = '';
                    sameSignatureClicks = 0;
                    writeReloadStuckState('', 0);
                    const didPostPause = await maybeRandomHumanPause(RANDOM_PAUSE.chanceAfterTransition, 'Auto-Farm: pausing...', 'farming');
                    if (abortRequested || !autoFarmActive) return;
                    if (!didPostPause) {
                        await abortableSleep(randomBetween(SPD.postTransition[0], SPD.postTransition[1]));
                    }
                } else {
                    await abortableSleep(350);
                }
            }
        } finally {
            autoFarmLoopRunning = false;
            isProcessing = false;
            syncGUIProcessingState();
        }
    }

    document.addEventListener('keydown', async (e) => {
        if (e.repeat) return;

        // Emergency instant abort + stop Auto-Farm (Alt+X)
        if (e.altKey && (e.key === 'x' || e.key === 'X')) {
            e.preventDefault();
            triggerAbort();
            return;
        }

        // Toggle Auto-Farm mode (Alt+F)
        if (e.altKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            toggleAutoFarm();
            return;
        }

        // Next / Continue button hotkey (Alt+S)
        if (e.altKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            clickNextOrSubmitButton();
            return;
        }

        // Primary Universal Solver hotkey (Alt+A)
        if (e.altKey && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            if (!autoFarmActive) await runSolverEntry();
        }
    });

    function findNextOrSubmitButton(cachedRoots = null, includeDisabled = false) {
        const roots = cachedRoots || collectDocumentRoots();
        const rawCandidates = queryAllInRoots(
            roots,
            '#btn_continue, #NextButton, #cm-NextButton, #movenextbtn, #movesubmitbtn, #sg_NextButton, #sg_SubmitButton, input[name="sGizmoNextButton"], input[name="sGizmoSubmitButton"], .sg-next-button, .sg-submit-button, .cf-navigation-next, .cf-navigation__button, .cm-navigation-next-button, #submitQuestion, #next, .NextButton, [data-test-id="ps-qualification-next-button"] button, [data-test-id="ps-start-survey-btn"] button, [data-test-id="ps-common-actions-button"], [data-testid="confirm-selection"], [data-testid="submit-text"], [data-testid*="confirm" i][tabindex="0"], [data-testid*="next" i][tabindex="0"], [data-testid*="continue" i][tabindex="0"], [data-testid*="submit" i][tabindex="0"], input[type="submit"], button[type="submit"], input[type="button"], input[type="image"], button, a[role="button"], [role="button"], a.btn, a[id*="submit" i], a[id*="next" i], a[id*="continue" i], a[class*="next" i], a[class*="continue" i]'
        );

        const knownForwardIds = /^(next\d*|continue|submit|btn_continue|NextButton|cm-NextButton|movenextbtn|movesubmitbtn|sg_NextButton|sg_SubmitButton|sGizmoNextButton|sGizmoSubmitButton|submitQuestion|submitButton|submitBtn|submit_btn|btnSubmit|next_button|forwardbutton|btnNext|nextBtn|next-button|continue-button|submit-button|continue_btn|next_btn|ps-qualification-next-button|ps-start-survey-btn|ps-common-actions-button|confirm-selection|submit-text)$/i;
        const nextWordRx = /^(next|continue|submit|proceed|forward|participate|take\s*survey|go\s*to\s*survey|launch\s*survey|enter\s*survey|next\s*page|next\s*question|save\s*(?:&|and)\s*continue|start|start\s*survey|begin|get\s*started|let'?s\s*go|agree\s*(?:&|and)\s*continue|accept\s*(?:&|and)\s*continue|i\s*agree|i\s*accept|finish|complete|done|confirm|confirm\s*(?:my\s*)?selections?|send)$/i;
        const forwardArrowOnlyRx = /^(?:[>>»›→➜➔▶▸►➡❯❱⇒⇨⟶⟹]+|->+)$/;
        const backArrowOnlyRx = /^(?:[<<«‹←◀◂◄⬅❮❰⇐⇦↩↶⟵⟸]+|<-+)$/;
        const rejectTextRx = /\b(back|goback|go\s*back|step\s*back|previous|prev|return|prior|earlier|undo|cancel|exit|logout|log\s*out|close|disagree|decline|no\s*thanks|skip\s*survey|skip\s*question|can'?t\s*answer|quit|reset|clear|privacy|terms|cookie|help|support|contact\s*(?:form\s*)?owner|edit\s*(?:this\s*)?form|arrow_back(?:_ios(?:_new)?)?|navigate_before|chevron_left|keyboard_arrow_left|arrow_left|west)\b/i;
        const rejectAttrWordRx = /\b(back|goback|go\s*back|prev|previous|cancel|exit|close|logout|reset|clear|undo|return|skip\s*question|arrow\s*left|chevron\s*left|angle\s*left|caret\s*left|icon\s*left|p\s*btn\s*icon\s*left)\b/i;
        const rejectAttrCompactRx = /(?:^|[\s_-])(?:moveprev(?:btn)?|moveback(?:btn)?|goback|backbtn|prevbtn|previousbtn|btnback|btnprev|GeGHKb|X5DuWc|CHu7sb|FqYDPb)(?:$|[\s_-])/i;
        const forwardAttrRx = /(?:^|[\s_-])(btn_continue|continue|nextbutton|next[-_]?button|next[-_]?btn|continue[-_]?btn|submit[-_]?btn|submitquestion|submitbutton|start[-_]?survey[-_]?btn|cf[-_]?navigation[-_]?next|cm[-_]?navigation[-_]?next[-_]?button|cm[-_]?nextbutton|movenext|nextpage|chevron[-_]?right|arrow[-_]?right|forward|next\d*)(?:$|[\s_-])/i;
        const splitAttrWords = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
        const isLeftPointingSvg = (btn) => {
            if (btn.querySelector('.p-btn-icon--left, [class*="arrow-left" i], [class*="chevron-left" i], [class*="angle-left" i], [class*="caret-left" i], [data-icon*="left" i], [data-icon*="back" i]')) return true;
            const polys = btn.querySelectorAll('svg polyline[points], svg polygon[points]');
            for (const poly of polys) {
                const nums = (poly.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter(n => !Number.isNaN(n));
                if (nums.length === 6) {
                    const [x0, , x1, , x2] = nums;
                    if (x1 < x0 - 1 && x1 < x2 - 1) return true;
                }
            }
            return false;
        };

        // Unwrap any container down to its real clickable control and deduplicate
        const seen = new Set();
        const unique = [];
        for (const el of rawCandidates) {
            let candidate = el;
            const tag = candidate.tagName;
            if (tag !== 'BUTTON' && tag !== 'INPUT' && tag !== 'A') {
                const innerNative = candidate.querySelector('input[type="submit"], button[type="submit"], button, input[type="button"], a[role="button"], a.btn');
                if (innerNative && isElementVisible(innerNative)) {
                    candidate = innerNative;
                }
            }
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            if (!isElementVisible(candidate)) continue;
            const isSurveyNavButton = candidate.matches('.cf-navigation-next, .cf-navigation__button, .cm-navigation-next-button') || Boolean(candidate.closest('.cf-navigation, .cf-page__navigation, .cm-survey-navigation, .cm-navigation-buttons, [role="form"], form'));
            if (candidate.closest('header, nav, [role="banner"], .bootstrap-select') || isHudElement(candidate)) continue;
            if (candidate.closest('[role="navigation"]') && !isSurveyNavButton) continue;
            if (candidate.classList.contains('dropdown-toggle') || candidate.getAttribute('data-toggle') === 'dropdown' || candidate.getAttribute('data-bs-toggle') === 'dropdown') continue;
            if (!includeDisabled && (candidate.disabled || candidate.getAttribute('aria-disabled') === 'true' || candidate.classList.contains('disabled') || candidate.classList.contains('is-disabled') || candidate.classList.contains('p-disabled') || candidate.classList.contains('p-btn--disabled'))) continue;
            unique.push(candidate);
        }

        let bestBtn = null;
        let bestScore = 0;

        for (const btn of unique) {
            const tag = btn.tagName;
            const btnType = (btn.getAttribute('type') || btn.type || '').toLowerCase();
            const rawActionHost = btn.closest('.common-actions, [button-title]') || btn.parentElement?.closest('[data-test-id]');
            const hostControlCount = rawActionHost ? rawActionHost.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a.btn').length : 0;
            const actionHost = (rawActionHost && hostControlCount <= 1) ? rawActionHost : null;
            const hostTitle = (actionHost?.getAttribute('button-title') || '').trim();
            const hostTestId = (actionHost?.getAttribute('data-test-id') || '').trim();
            const hostClass = typeof actionHost?.className === 'string' ? actionHost.className : '';
            const rawLabel = (
                (tag === 'INPUT' ? btn.value : btn.innerText) ||
                btn.value ||
                btn.innerText ||
                btn.getAttribute('aria-label') ||
                btn.title ||
                btn.alt ||
                hostTitle ||
                ''
            ).replace(/\s+/g, ' ').trim();
            const normalized = rawLabel.replace(/^[\s«»‹›<>→←⬅➡❯❮←→➜➔▶▸►•·\-–—]+|[\s«»‹›<>→←⬅➡❯❮←→➜➔▶▸►•·\-–—!]+$/g, '').trim();
            const childMeta = Array.from(btn.querySelectorAll('svg, i, span, img')).map(ch => {
                const imgSrcName = (ch.getAttribute('src') || '').split('/').pop().split('?')[0];
                return `${ch.getAttribute('aria-label') || ''} ${ch.getAttribute('title') || ''} ${ch.getAttribute('alt') || ''} ${ch.getAttribute('data-icon') || ''} ${imgSrcName} ${typeof ch.className === 'string' ? ch.className : ''}`;
            }).join(' ');
            const selfSrcName = (tag === 'INPUT' && btnType === 'image') ? (btn.getAttribute('src') || '').split('/').pop().split('?')[0] : '';
            const fullTextForReject = [
                rawLabel,
                normalized,
                btn.innerText,
                btn.textContent,
                btn.value,
                btn.getAttribute('aria-label'),
                btn.title,
                btn.alt,
                hostTitle
            ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
            const onclickAttr = (btn.getAttribute('onclick') || '').replace(/\breturn\b/gi, ' ');
            const attrSig = `${btn.id || ''} ${btn.name || ''} ${btn.value || ''} ${selfSrcName} ${btn.getAttribute('aria-label') || ''} ${btn.title || ''} ${btn.getAttribute('data-test-id') || ''} ${btn.getAttribute('data-testid') || ''} ${btn.getAttribute('data-action') || ''} ${btn.getAttribute('data-direction') || ''} ${btn.getAttribute('data-nav') || ''} ${btn.getAttribute('jsname') || ''} ${onclickAttr} ${typeof btn.className === 'string' ? btn.className : ''} ${childMeta} ${hostTestId} ${hostClass}`;
            const splitAttrSig = splitAttrWords(attrSig);

            if (
                rejectTextRx.test(fullTextForReject) ||
                rejectAttrCompactRx.test(attrSig) ||
                rejectAttrWordRx.test(splitAttrSig) ||
                backArrowOnlyRx.test(rawLabel) ||
                isLeftPointingSvg(btn)
            ) {
                continue;
            }
            if ((/[«←‹⬅❮❰⇐⇦⟵⟸]/.test(rawLabel) || /<-/.test(rawLabel)) && !(/[»→›➜➔➡❯❱⇒⇨⟶⟹]/.test(rawLabel) || /->/.test(rawLabel))) {
                continue;
            }
            // Skip choice cards with role="button" (e.g. CloudResearch Sentry options)
            if (btn.classList.contains('choice-option') || btn.classList.contains('random-choice')) {
                continue;
            }

            let score = 0;
            const isKnownId = knownForwardIds.test(btn.id || '') || knownForwardIds.test(btn.getAttribute('name') || '') || knownForwardIds.test(btn.getAttribute('data-test-id') || '') || knownForwardIds.test(btn.getAttribute('data-testid') || '') || knownForwardIds.test(hostTestId) || btn.classList.contains('sg-next-button') || btn.classList.contains('sg-submit-button');
            const isExactWord = nextWordRx.test(normalized);
            const isArrowOnly = !normalized && (forwardArrowOnlyRx.test(rawLabel) || (!rawLabel && !!btn.querySelector('.p-btn-icon--right svg, svg, [class*="chevron-right" i], [class*="arrow-right" i]')));
            const isForwardAttr = forwardAttrRx.test(attrSig) || !!btn.querySelector('.p-btn-icon--right');
            const isSubmit = (tag === 'INPUT' || tag === 'BUTTON') && (btnType === 'submit' || (btnType === 'image' && (isKnownId || isExactWord || isForwardAttr)));

            if (isKnownId) score += 100;
            if (isExactWord) score += 75;
            else if (isArrowOnly && (isKnownId || isForwardAttr)) score += 45;
            else if (isSubmit && rawLabel.length <= 32) score += 22;
            else if (isForwardAttr && (tag === 'BUTTON' || tag === 'INPUT' || (tag === 'A' && btn.classList.contains('btn'))) && rawLabel.length <= 32) score += 22;

            if (score === 0) continue;

            if (isSubmit) score += 24;
            else if (tag === 'BUTTON' || tag === 'INPUT') score += 18;
            if (isForwardAttr) score += 15;
            if (btn.getAttribute('name') && /^(continue|next|submit)$/i.test(btn.getAttribute('name'))) score += 20;

            if (score >= bestScore) {
                bestScore = score;
                bestBtn = btn;
            }
        }

        return bestBtn;
    }

    async function clickNextOrSubmitButton(silentIfAuto = false, cachedRoots = null) {
        if (!silentIfAuto) abortRequested = false;
        const btn = findNextOrSubmitButton(cachedRoots);
        if (btn) {
            const label = ((btn.innerText || btn.value || btn.getAttribute('aria-label') || btn.title || btn.closest('[button-title]')?.getAttribute('button-title') || '')).replace(/\s+/g, ' ').trim();
            await triggerNativeClick(btn, null, null);
            updateHUD(silentIfAuto ? `Auto: ${label || 'Next'}` : `Clicked: ${label || 'Next'}`, silentIfAuto ? 'farming' : 'active', silentIfAuto ? 0 : 2000);
            return true;
        }
        if (!silentIfAuto) updateHUD('No Next button found', 'error', 2000);
        return false;
    }

    async function executeUniversalAction(fromAutoFarm = false) {
        lastSolveHadError = false;
        if (abortRequested) return { solved: 0, hadError: false, hadBlocks: false };

        const sel = window.getSelection();
        const liveSelection = sel ? sel.toString().trim() : '';
        const rawSelection = fromAutoFarm ? '' : (liveSelection || cachedSelection);
        const activeTarget = fromAutoFarm ? null : getActiveTarget();

        // 1. Explicitly focused single text/numeric/date input (manual mode only)
        if (activeTarget && !isSpecifyInput(activeTarget) && !isSearchOrFilterInput(activeTarget)) {
            const prompt = rawSelection || extractPromptAboveGroup(activeTarget) || findPromptAboveElement(activeTarget);
            await executeTextTyping(activeTarget, prompt || 'Answer the prompt.');
            return { solved: lastSolveHadError ? 0 : 1, hadError: lastSolveHadError, hadBlocks: true };
        }

        // 2. Highlighted lines of options (manual mode only)
        if (rawSelection) {
            const lines = rawSelection.split('\n').map(l => l.trim()).filter(l => l.length > 1);
            if (lines.length >= 2) {
                const parsed = separateQuestionAndOptionLines(lines);
                const questionText = parsed.questionText || findQuestionHeaderNearRange() || 'Select the best option.';
                const rawChoices = resolveChoicesFromHighlightedLines(parsed.optionLines);
                const cleanChoices = sanitizeChoices(rawChoices, questionText);

                if (cleanChoices.length >= 2) {
                    await executeMultipleChoice(questionText, cleanChoices);
                    return { solved: lastSolveHadError ? 0 : 1, hadError: lastSolveHadError, hadBlocks: true };
                }
            }
        }

        // 3. Full page scan (single-pass shadow DOM roots)
        const roots = collectDocumentRoots();
        const allBlocks = findAllQuestionBlocksOnPage(roots);

        if (allBlocks.length === 0) {
            if (!fromAutoFarm) updateHUD('No questions detected', 'error', 3000);
            return { solved: 0, hadError: false, hadBlocks: false };
        }

        const sharedConcept = extractSharedTopConcept(allBlocks[0]?.element);
        const unansweredBlocks = allBlocks.filter(b => !isBlockAnswered(b));

        if (unansweredBlocks.length === 0) {
            if (!fromAutoFarm) updateHUD('All questions answered', 'active', 2500);
            return { solved: 0, hadError: false, hadBlocks: true };
        }

        // 4. Targeted vs full-page batch resolution
        const targetBlock = pickTargetBlock(unansweredBlocks, rawSelection);

        if (rawSelection || unansweredBlocks.length === 1) {
            await solveSingleBlock(targetBlock, sharedConcept, rawSelection, roots);
            const didSolve = !lastSolveHadError && (!targetBlock.element?.isConnected || isBlockAnswered(targetBlock) || targetBlock.skippedBlankTrap);
            return { solved: didSolve ? 1 : 0, hadError: lastSolveHadError, hadBlocks: true };
        } else {
            updateHUD(`Solving ${unansweredBlocks.length} questions...`, 'working');
            let solvedCount = 0;

            // Batch multiple standalone choices/select blocks into 1 API call (max 8 per batch)
            const batchable = [];
            const sequential = [];
            for (const b of unansweredBlocks) {
                if (b.type === 'choices' || b.type === 'select') {
                    batchable.push(b);
                } else {
                    sequential.push(b);
                }
            }

            if (batchable.length >= 2) {
                for (let offset = 0; offset < batchable.length; offset += 8) {
                    if (abortRequested) return { solved: solvedCount, hadError: lastSolveHadError, hadBlocks: true };
                    const chunk = batchable.slice(offset, offset + 8).filter(b => !isBlockAnswered(b));
                    if (chunk.length === 0) continue;
                    if (chunk.length === 1) {
                        await solveSingleBlock(chunk[0], sharedConcept, '', roots);
                        if (abortRequested || lastSolveHadError) return { solved: solvedCount, hadError: lastSolveHadError, hadBlocks: true };
                        solvedCount++;
                    } else {
                        const batchSolved = await solveChoiceAndSelectBatch(chunk, sharedConcept);
                        if (abortRequested || lastSolveHadError) return { solved: solvedCount + batchSolved, hadError: lastSolveHadError, hadBlocks: true };
                        solvedCount += batchSolved;
                    }
                    if (fromAutoFarm && (offset + 8 < batchable.length || sequential.length > 0)) {
                        const paused = await maybeRandomHumanPause(RANDOM_PAUSE.chanceBetweenBlocks, 'Auto-Farm: reading...', 'farming');
                        if (!paused) await abortableSleep(pickRangeDelay(SPD.betweenBlocks));
                    } else {
                        await abortableSleep(pickRangeDelay(SPD.betweenBlocks));
                    }
                }
            } else {
                sequential.unshift(...batchable);
            }

            for (let i = 0; i < sequential.length; i++) {
                if (abortRequested) return { solved: solvedCount, hadError: lastSolveHadError, hadBlocks: true };
                const b = sequential[i];
                if (isBlockAnswered(b)) continue;
                updateHUD(`Solving (${solvedCount + 1}/${unansweredBlocks.length})...`, 'working');
                await solveSingleBlock(b, sharedConcept, '', roots);
                if (abortRequested || lastSolveHadError) {
                    return { solved: solvedCount, hadError: lastSolveHadError, hadBlocks: true };
                }
                solvedCount++;
                if (fromAutoFarm && i + 1 < sequential.length) {
                    const paused = await maybeRandomHumanPause(RANDOM_PAUSE.chanceBetweenBlocks, 'Auto-Farm: reading...', 'farming');
                    if (!paused) await abortableSleep(pickRangeDelay(SPD.betweenBlocks));
                } else {
                    await abortableSleep(pickRangeDelay(SPD.betweenBlocks));
                }
            }
            if (!abortRequested && !fromAutoFarm) {
                updateHUD(`Done (${solvedCount} solved)`, 'active', 3000);
            }
            return { solved: solvedCount, hadError: lastSolveHadError, hadBlocks: true };
        }
    }

    function getFieldValidationErrorText(el) {
        if (!el) return '';
        const parts = [];
        try {
            const described = (el.getAttribute('aria-describedby') || '').trim().split(/\s+/).filter(Boolean);
            const root = el.getRootNode ? el.getRootNode() : document;
            for (const id of described) {
                const ref = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
                if (ref && isElementVisible(ref)) {
                    const t = (ref.innerText || '').replace(/\s+/g, ' ').trim();
                    if (t) parts.push(t);
                }
            }
            const container = el.closest('.question-body, fieldset, [class*="question" i], form') || el.parentElement;
            if (container) {
                const errEls = container.querySelectorAll('[role="alert"], .q-error, .q-word-count__text--error, [class*="error" i], .invalid-feedback');
                for (const errEl of errEls) {
                    if (errEl === el || !isElementVisible(errEl)) continue;
                    const t = (errEl.innerText || '').replace(/\s+/g, ' ').trim();
                    if (t && !parts.includes(t)) parts.push(t);
                }
            }
        } catch (e) {}
        const combined = parts.join(' ').trim();
        const isMarkedInvalid = el.getAttribute('aria-invalid') === 'true' ||
            /\b(error|invalid)\b/i.test(typeof el.className === 'string' ? el.className : '');
        if (combined && (isMarkedInvalid || /\b(maximum|minimum|at\s+least|at\s+most|no\s+more\s+than|up\s+to|exact(?:ly)?|box(?:es)?|you\s+checked|allowed|characters?|chars?|words?|required|invalid|too\s+(?:long|short))\b/i.test(combined))) {
            return combined;
        }
        return isMarkedInvalid ? 'Field marked invalid' : '';
    }

    function isBlockAnswered(b) {
        if (!b || b.skippedBlankTrap) return true;
        if (b.type === 'number_grid') {
            return b.rows.every(r => (r.input.value || '').trim() !== '');
        }
        if (b.type === 'text_list') {
            return b.rows.every(r => (r.input.value || r.input.textContent || '').trim() !== '');
        }
        if (b.type === 'matrix_grid') {
            if (!b.rows.every(r => r.choices.some(c => (c.input && c.input.checked) || isChoiceMarkedSelected(c, r.rowHeader || b.prompt)))) return false;
            return !(getFieldValidationErrorText(b.element) && (validationRetryCounts.get(b.element) || 0) < 1);
        }
        if (b.type === 'choices') {
            if (!b.choices.some(c => (c.input && c.input.checked) || isChoiceMarkedSelected(c, b.prompt))) return false;
            const errProbe = b.choices[0]?.input || b.element;
            return !(getFieldValidationErrorText(errProbe) && (validationRetryCounts.get(b.element) || 0) < 1);
        }
        if (b.type === 'select') {
            return b.element.selectedIndex > 0 && b.element.value !== '' && !/^(select|choose|--)/i.test(b.element.options[b.element.selectedIndex]?.text);
        }
        if (b.type === 'custom_dropdown') {
            if (touchedElements.has(b.element)) return true;
            const txt = (b.element.innerText || b.element.value || '').trim();
            return txt.length > 0 && !/^(select|choose|please select|--|click to select)/i.test(txt);
        }
        if (b.type === 'range') {
            return touchedElements.has(b.element) ||
                Boolean(b.element.closest?.('.activated'));
        }
        if (b.type === 'rank_sort') {
            return b.cards.filter(c => c.classList.contains('sq-ranksort-card-dropped')).length >= b.requiredRanks;
        }
        if (b.type === 'text') {
            const hasText = (b.element.value || b.element.textContent || '').trim().length > 0;
            if (!hasText) return false;
            if (getFieldValidationErrorText(b.element) && (validationRetryCounts.get(b.element) || 0) < 1) {
                return false;
            }
            return true;
        }
        return false;
    }

    function buildSelectionStamp(promptText, choiceText) {
        const p = (promptText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const t = (choiceText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return `${p}::${t}`;
    }

    function stampCustomChoiceSelected(choice, promptText) {
        if (!choice || choice.input || !choice.target) return;
        const stamp = buildSelectionStamp(promptText, choice.text);
        try {
            selectedChoiceKeys.set(choice.target, stamp);
            if (choice.wrapper) selectedChoiceKeys.set(choice.wrapper, stamp);
        } catch (e) {}
    }

    function getAriaLabelledByText(el) {
        if (!el) return '';
        const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
        if (ids.length === 0) return '';
        const root = el.getRootNode ? el.getRootNode() : document;
        const parts = [];
        for (const id of ids) {
            try {
                const ref = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
                if (ref && isElementVisible(ref)) {
                    const txt = (ref.innerText || '').replace(/\s+/g, ' ').trim();
                    if (txt) parts.push(txt);
                }
            } catch (e) {}
        }
        return parts.join('\n').trim();
    }

    function isMarkedSelectedNode(node) {
        if (!node || !node.getAttribute) return false;
        if (
            node.getAttribute('aria-checked') === 'true' ||
            node.getAttribute('aria-selected') === 'true' ||
            node.getAttribute('aria-pressed') === 'true' ||
            node.getAttribute('data-selected') === 'true' ||
            node.getAttribute('data-checked') === 'true' ||
            node.getAttribute('data-state') === 'checked' ||
            node.getAttribute('data-state') === 'on'
        ) {
            return true;
        }
        if (node instanceof SVGElement && node.tagName.toLowerCase() !== 'svg') return false;
        if (node.classList) {
            for (const tok of node.classList) {
                if (/^(?:not|non|un|de)[_-]?(?:selected|checked|active)$/i.test(tok)) continue;
                if (
                    /(?:^|[_-])(?:selected|checked)$/i.test(tok) ||
                    /^(?:selected|checked|active)$/i.test(tok) ||
                    /^(?:is|state)[_-](?:selected|checked|active)$/i.test(tok)
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    function isChoiceMarkedSelected(c, promptText = '') {
        if (!c || !c.target) return false;
        const nodes = [];
        for (const cand of [c.target, c.ariaEl, c.wrapper, c.label]) {
            if (cand && !nodes.includes(cand)) nodes.push(cand);
        }
        for (const el of nodes) {
            if (isMarkedSelectedNode(el)) return true;
            if (promptText && selectedChoiceKeys.get(el) === buildSelectionStamp(promptText, c.text)) {
                return true;
            }
            if (el.querySelector) {
                const nestedState = el.querySelector('[aria-checked="true"], [aria-selected="true"], [data-selected="true"], [data-checked="true"], [data-state="checked"], [class*="selected" i], [class*="checked" i]');
                if (nestedState && isMarkedSelectedNode(nestedState)) return true;
            }
            if (el.querySelector('svg[data-icon*="dot-circle" i], svg[data-icon*="circle-dot" i], svg[data-icon*="check-circle" i], svg[data-icon*="circle-check" i], svg[data-icon*="check-square" i], svg[data-icon*="square-check" i], .fa-dot-circle, .fa-circle-dot, .fa-check-circle, .fa-circle-check, .fa-check-square, .fa-square-check')) {
                return true;
            }
        }
        return false;
    }

    function findLabelForInput(inp) {
        if (!inp) return null;
        const root = inp.getRootNode ? inp.getRootNode() : document;
        const isLabelBoxVisible = (lbl) => {
            if (!lbl) return false;
            try {
                const st = window.getComputedStyle(lbl);
                if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
                const r = lbl.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            } catch (e) {
                return false;
            }
        };
        if (inp.id) {
            try {
                const forLabels = Array.from(root.querySelectorAll(`label[for="${CSS.escape(inp.id)}"]`));
                if (forLabels.length > 0) {
                    return (
                        forLabels.find(lbl => isLabelBoxVisible(lbl) && (lbl.innerText || '').trim().length > 0) ||
                        forLabels.find(lbl => isLabelBoxVisible(lbl)) ||
                        forLabels.find(lbl => (lbl.innerText || '').trim().length > 0) ||
                        forLabels[0]
                    );
                }
            } catch (e) {}
        }
        const ariaLabelledBy = inp.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
            const firstId = ariaLabelledBy.trim().split(/\s+/)[0];
            if (firstId) {
                const refEl = (root.getElementById ? root.getElementById(firstId) : null) || document.getElementById(firstId);
                if (refEl) return refEl;
            }
        }
        const parentLabel = inp.closest('label');
        if (parentLabel) return parentLabel;
        if (inp.parentElement) {
            const siblingLabel = inp.parentElement.querySelector('label');
            if (siblingLabel) return siblingLabel;
        }
        return null;
    }

    function isSpecifyInput(inp) {
        if (!inp) return false;
        const idName = `${inp.id || ''} ${inp.name || ''} ${typeof inp.className === 'string' ? inp.className : ''}`;
        if (/(?:~TEXT$|_text$|_oe$|_sp$|_other$|otherText|txtOther|other_?input|other_?specify|specify_?other|open[-_]?end[-_]?other|cm-other-specify)/i.test(idName)) {
            return true;
        }

        // 1. Structural check: walk up to 4 ancestor wrappers; if any wrapper contains EXACTLY 1 visible choice toggle,
        //    this text box is a companion "Other / Specify" field belonging to that single choice row.
        const toggleSelector = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
        const getChoiceToggles = (scope) => Array.from(scope.querySelectorAll(toggleSelector)).filter(t => {
            if (!isElementVisible(t)) return false;
            const sig = `${t.id || ''} ${t.name || ''} ${typeof t.className === 'string' ? t.className : ''}`;
            return !/(?:^|[\s_-])(?:next|prev|back|nextbtn|prevbtn)(?:$|[\s_-])/i.test(sig);
        });
        let anc = inp.parentElement;
        for (let depth = 0; depth < 4 && anc && anc !== document.body; depth++) {
            const toggles = getChoiceToggles(anc);
            if (toggles.length === 1) {
                return true;
            }
            if (toggles.length > 1) break;
            anc = anc.parentElement;
        }

        // 2. Semantic row container check (for nested table/list/label rows)
        const row = inp.closest('tr, li, [class*="choice" i], [class*="option" i], [class*="Selection" i], label');
        if (row && getChoiceToggles(row).length === 1) {
            return true;
        }

        // 3. Visual same-row check: if a radio/checkbox sits on the exact same horizontal line to the left of this input
        const inpRect = inp.getBoundingClientRect();
        if (inpRect.width > 0 && inpRect.height > 0) {
            const inpMidY = inpRect.top + inpRect.height / 2;
            const scope = inp.closest('fieldset, form, table, [class*="question" i], [role="group"]') || document.body;
            if (scope) {
                const nearbyToggles = scope.querySelectorAll(toggleSelector);
                for (let i = 0; i < nearbyToggles.length; i++) {
                    const t = nearbyToggles[i];
                    const tr = t.getBoundingClientRect();
                    if (tr.width === 0 && tr.height === 0) continue;
                    const tMidY = tr.top + tr.height / 2;
                    if (Math.abs(tMidY - inpMidY) <= 24 && tr.right <= inpRect.left + 8) {
                        return true;
                    }
                }
            }
        }

        // 4. Text-based check: "Other" or "Other (specify)" next to this input inside a choice question
        const placeholder = (inp.placeholder || '').trim();
        const ariaLabel = (inp.getAttribute('aria-label') || '').trim();
        const parentText = (inp.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
        const prevText = (inp.previousElementSibling?.innerText || '').replace(/\s+/g, ' ').trim();
        const combined = `${placeholder} ${ariaLabel} ${parentText} ${prevText}`;

        if (/\bother\b[\s,:\-()]*.*?\bspecify\b|\bspecify\s+other\b/i.test(combined)) {
            return true;
        }
        if (/^other\s*:?$/i.test(parentText) || /^other\s*:?$/i.test(prevText) || /^(?:please\s+)?specify\s*:?$/i.test(placeholder) || /^(?:please\s+)?specify\s*:?$/i.test(ariaLabel)) {
            const scope = inp.closest('fieldset, form, [class*="question" i], [role="group"]') || document.body;
            if (scope && scope.querySelector(toggleSelector)) {
                return true;
            }
        }
        return false;
    }

    function isSearchOrFilterInput(inp) {
        if (!inp || inp.tagName === 'TEXTAREA' || inp.isContentEditable) return false;
        const typeAttr = (inp.getAttribute('type') || '').toLowerCase();
        const roleAttr = (inp.getAttribute('role') || '').toLowerCase();
        if (typeAttr === 'search' || roleAttr === 'searchbox') return true;
        if (inp.closest('[role="search"], .bs-searchbox, .select2-search, .select2-search--dropdown, .choices__list--dropdown')) return true;

        const placeholder = (inp.getAttribute('placeholder') || '').trim();
        const ariaLabel = (inp.getAttribute('aria-label') || '').trim();
        const titleAttr = (inp.getAttribute('title') || '').trim();
        const searchLabelRx = /^\s*(?:search|filter|type\s+to\s+(?:search|filter)|find\s+(?:an?\s+)?(?:option|item|answer)|quick\s*(?:search|filter))(?:\b|\.{2,3}|…|$)/i;
        if (searchLabelRx.test(placeholder) || searchLabelRx.test(ariaLabel) || searchLabelRx.test(titleAttr)) {
            return true;
        }

        const attrSig = `${inp.id || ''} ${inp.name || ''} ${typeof inp.className === 'string' ? inp.className : ''} ${inp.getAttribute('data-testid') || ''}`;
        if (/(?:^|[\s_-])(search|filter|searchbox|search[-_]?input|filter[-_]?input|option[-_]?search|choice[-_]?filter|typeahead)(?:$|[\s_-])/i.test(attrSig)) {
            // Confirm this is a list filter box rather than a standalone question about search engines
            const scope = inp.closest('form, fieldset, [role="dialog"], main, section') || document.body;
            const choiceCount = scope ? scope.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]').length : 0;
            if (choiceCount >= 2) return true;
        }

        return false;
    }

    function isUtilityOrLanguageSelect(sel) {
        if (!sel || sel.tagName !== 'SELECT') return false;

        // 1. Inside top/bottom page navigation chrome or site translate/language widgets (e.g. Google Translate .goog-te-combo)
        if (
            sel.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"], #google_translate_element, .goog-te-gadget, .skiptranslate, app-language, [class*="lang-switch" i], [class*="language-select" i]') ||
            sel.matches('.goog-te-combo, [aria-label*="translate" i]')
        ) {
            return true;
        }

        // 2. Inside a dedicated language/locale/theme/currency form (e.g. action="/.../set-language")
        const form = sel.closest('form');
        const formAction = (form?.getAttribute('action') || '').trim();
        if (/(?:set|change|switch|update)[-_]?(?:lang|language|locale|currency|theme)|\/(?:lang|language|locale)(?:\/|$|\?)/i.test(formAction)) {
            return true;
        }

        const lbl = findLabelForInput(sel);
        const labelTxt = (lbl?.innerText || sel.getAttribute('aria-label') || sel.title || '').replace(/\s+/g, ' ').trim();
        const attrSig = `${sel.id || ''} ${sel.name || ''} ${typeof sel.className === 'string' ? sel.className : ''} ${sel.getAttribute('data-testid') || ''}`;
        const onchangeAttr = (sel.getAttribute('onchange') || '').trim();
        const triggersSubmitOrNav = /\b(?:form\.submit|submit\s*\(|location(?:\.href)?|reload|setLang|changeLang)/i.test(onchangeAttr);
        const looksLikeLangAttr = /(?:^|[\s_-])(?:id_)?(lang|language|locale|i18n|translation|currency|theme)(?:$|[\s_-])/i.test(attrSig);
        const looksLikeShortLangLabel = /^(?:select\s+|change\s+|choose\s+)?(?:language|locale|idioma|langue|sprache)\s*:?$/i.test(labelTxt);

        // Check whether options look like language/locale choices (e.g. "English (en)", "French (fr)", "Spanish (es)")
        const opts = Array.from(sel.options || []);
        const langOptRx = /^(?:english|french|français|spanish|español|german|deutsch|italian|italiano|portuguese|português|dutch|nederlands|russian|chinese|japanese|korean|arabic|hindi|polish|turkish|swedish)(?:\s*\([a-z]{2}(?:-[a-z]{2})?\))?$/i;
        const langOptCount = opts.filter(o => langOptRx.test((o.text || '').trim())).length;
        const looksLikeLangOptions = opts.length >= 2 && langOptCount >= Math.min(2, opts.length);

        // 3. Auto-submitting / auto-navigating language or utility dropdown
        if (triggersSubmitOrNav && (looksLikeLangAttr || looksLikeShortLangLabel || looksLikeLangOptions)) {
            return true;
        }

        // 4. Standalone language/utility switcher sitting outside any survey <form> alongside real survey content
        const selectedOpt = sel.options?.[sel.selectedIndex];
        const hasRealSelection = !!(selectedOpt && (selectedOpt.value || '').trim() !== '' && !/^(select|choose|please\s+select|--|$)/i.test((selectedOpt.text || '').trim()));
        if ((hasRealSelection || !form) && (looksLikeShortLangLabel || (looksLikeLangAttr && looksLikeLangOptions) || triggersSubmitOrNav)) {
            const otherInputs = Array.from(document.querySelectorAll('form textarea, form input, form select, form label, .review_block_numbers, [class*="question" i], textarea, input[type="radio"], input[type="checkbox"], input[type="text"], input[type="number"], [role="radio"], [role="checkbox"], [contenteditable="true"]'))
                .filter(el => el !== sel && (!form || !form.contains(el)) && isElementVisible(el) && !isHudElement(el) && !isSearchOrFilterInput(el));
            if (otherInputs.length > 0) {
                return true;
            }
        }

        return false;
    }

    function isNumericTotalOrReadOnlyInput(inp) {
        if (!inp) return true;
        if (inp.disabled || inp.readOnly) return true;
        const idName = `${inp.id || ''} ${inp.name || ''} ${inp.className || ''} ${inp.getAttribute('aria-label') || ''}`.toLowerCase();
        if (/\b(total|sum|remaining)\b/i.test(idName)) return true;
        const row = inp.closest('tr, div, li');
        if (row) {
            const rowTxt = (row.innerText || '').replace(/\s+/g, ' ').trim();
            if (/^(total|sum|total\s*:|sum\s*:)/i.test(rowTxt)) return true;
        }
        return false;
    }

    function isHoneypotOrHiddenInput(el) {
        if (!el) return true;
        if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('data-exclude') === '1') return true;
        const tabIdx = el.getAttribute('tabindex');
        if (tabIdx !== null && parseInt(tabIdx, 10) < 0) return true;

        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 14) return true;
        if (r.right < -50 || r.bottom < -50 || r.left > window.innerWidth + 200) return true;

        let curr = el.parentElement;
        for (let i = 0; i < 6 && curr && curr !== document.body; i++) {
            const st = window.getComputedStyle(curr);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return true;
            if ((st.overflow === 'hidden' || st.overflowY === 'hidden') && curr.getBoundingClientRect().height <= 2) return true;
            curr = curr.parentElement;
        }

        const attrSig = `${el.id || ''} ${el.name || ''} ${typeof el.className === 'string' ? el.className : ''}`;
        if (/(?:^|[\s_-])(honeypot|honey[-_]?pot|bot[-_]?trap|hp[-_]?field|trap[-_]?input|decoy|ra__\d+)(?:$|[\s_-])/i.test(attrSig)) {
            return true;
        }
        return false;
    }

    function isExplicitlyRequiredInput(el) {
        if (!el) return false;
        if (el.required || el.getAttribute('aria-required') === 'true') return true;
        const cls = typeof el.className === 'string' ? el.className : '';
        if (/(?:^|[\s_-])required(?:$|[\s_-])/i.test(cls)) return true;
        return false;
    }

    function isOptionalOrUnnecessaryTextInput(el, promptText, existingNonTextBlocks) {
        if (!el) return true;
        if (isHoneypotOrHiddenInput(el)) return true;

        const required = isExplicitlyRequiredInput(el);
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim();
        const cleanPrompt = (promptText || '').replace(/\s+/g, ' ').trim();
        const combinedText = `${cleanPrompt} ${placeholder} ${ariaLabel}`;

        const optionalRx = /\b(optional|if\s+applicable|if\s+you\s+(?:have\s+any|would\s+like|wish\s+to|selected|answered|chose)|additional\s+comments?|any\s+other\s+comments?|anything\s+else\s+you(?:'d|\s+would)\s+like|leave\s+blank\s+if|not\s+required|voluntary|feel\s+free\s+to|if\s+(?:yes|no|other),?\s*(?:please\s*)?(?:explain|specify|describe|tell\s+us))\b/i;

        // If the page already has a primary non-text question (radio, checkbox, select, matrix, slider, number grid),
        // be strict about whether a text box is truly a separate required question vs. an unnecessary/optional box.
        if (existingNonTextBlocks.length > 0) {
            // 1. Inside the exact same question container as an already-detected choice/select/matrix block -> companion/comment box, skip!
            const qContainer = el.closest('.cf-question, .cm-question, fieldset, .QuestionOuter, .question, .question-container, [class*="question-wrapper" i], [id*="question" i]');
            if (qContainer && existingNonTextBlocks.some(b => qContainer.contains(b.element))) {
                return true;
            }

            // 2. Explicitly optional or conditional follow-up text -> skip unless HTML marks it required
            if (!required && optionalRx.test(combinedText)) {
                return true;
            }

            // 3. No distinct prompt of its own (empty, too short, or just repeating a primary block's prompt) -> skip unless required
            if (!required) {
                if (cleanPrompt.length < 6) return true;
                const normP = cleanPrompt.toLowerCase();
                const duplicatesPrimaryPrompt = existingNonTextBlocks.some(b => {
                    const bp = (b.prompt || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    return bp.length >= 8 && (bp === normP || bp.includes(normP) || normP.includes(bp));
                });
                if (duplicatesPrimaryPrompt) return true;
            }
        } else {
            // Even when it's the only input on the page, never type into an explicitly optional comment box on a pure info/continue screen
            if (!required && /\b(optional\s+comments?|additional\s+comments?\s*\(optional\)|leave\s+blank\s+if\s+none)\b/i.test(combinedText)) {
                return true;
            }
        }

        return false;
    }

    function extractSharedTopConcept(firstQuestionEl = null) {
        if (!firstQuestionEl) return '';
        const firstRect = firstQuestionEl.getBoundingClientRect();

        const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, div, section, fieldset'))
            .filter(el => {
                if (!isElementVisible(el) || isHudElement(el) || el.closest('header, nav, footer, [role="banner"], [role="navigation"]')) return false;
                if (el.contains(firstQuestionEl) || firstQuestionEl.contains(el)) return false;
                if (el.children.length > 4) return false;
                const r = el.getBoundingClientRect();
                return r.bottom <= firstRect.top - 10;
            });

        const lines = [];
        for (const el of candidates) {
            const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (txt.length > 80 && txt.length < 1200) {
                if (!lines.some(s => s.includes(txt) || txt.includes(s))) {
                    lines.push(txt);
                }
            }
        }
        const joined = lines.join('\n\n');
        return joined.length > 900 ? joined.slice(0, 900) : joined;
    }

    function getBootstrapSelectContainer(selectEl) {
        if (!selectEl || selectEl.tagName !== 'SELECT') return null;
        const next = selectEl.nextElementSibling;
        if (next && next.classList?.contains('bootstrap-select')) return next;
        const parentWrapper = selectEl.closest('.bootstrap-select');
        if (parentWrapper) return parentWrapper;
        if (selectEl.id) {
            try {
                const root = selectEl.getRootNode ? selectEl.getRootNode() : document;
                const toggle = root.querySelector(`.bootstrap-select button[data-id="${CSS.escape(selectEl.id)}"]`);
                if (toggle) return toggle.closest('.bootstrap-select');
            } catch (e) {}
        }
        return null;
    }

    function getSelectVisualElement(selectEl) {
        if (!selectEl || selectEl.tagName !== 'SELECT') return selectEl;
        if (isElementVisible(selectEl)) return selectEl;
        const bsContainer = getBootstrapSelectContainer(selectEl);
        if (bsContainer) {
            const toggle = bsContainer.querySelector('button.dropdown-toggle, [data-toggle="dropdown"], [data-bs-toggle="dropdown"]');
            if (toggle && isElementVisible(toggle)) return toggle;
            if (isElementVisible(bsContainer)) return bsContainer;
        }
        return selectEl;
    }

    function isSelectOrProxyVisible(selectEl) {
        if (!selectEl) return false;
        if (isElementVisible(selectEl)) return true;
        const visual = getSelectVisualElement(selectEl);
        return visual !== selectEl && isElementVisible(visual);
    }

    function findAllQuestionBlocksOnPage(roots) {
        const blocks = [];
        const handledInputs = new Set();
        const handledCardElements = new Set();

        const allVisibleInputs = queryAllInRoots(
            roots,
            'input:not([type="hidden"]), select, textarea, [role="radio"], [role="checkbox"], [role="combobox"], [role="listbox"][aria-expanded]'
        ).filter(el => (el.tagName === 'SELECT' ? isSelectOrProxyVisible(el) : isElementVisible(el)) && !isHudElement(el) && !isSearchOrFilterInput(el) && !isUtilityOrLanguageSelect(el));

        // A. Numeric Tables / Constant-Sum Grids
        const allNumInputs = queryAllInRoots(
            roots,
            'input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"]'
        ).filter(inp => isElementVisible(inp) && !isNumericTotalOrReadOnlyInput(inp) && !isSpecifyInput(inp) && !isHudElement(inp));

        if (allNumInputs.length >= 2) {
            const gridMap = new Map();
            for (const inp of allNumInputs) {
                const container = inp.closest('.cf-question, .cf-grid-layout, [class*="numeric-list" i], [class*="grid-layout" i], table, [class*="matrix" i], [class*="constant" i], form, fieldset') || inp.parentElement;
                if (!gridMap.has(container)) gridMap.set(container, []);
                gridMap.get(container).push(inp);
            }

            for (const [, inps] of gridMap.entries()) {
                const unhandled = inps.filter(inp => !handledInputs.has(inp));
                if (unhandled.length >= 2) {
                    const rows = [];
                    for (const inp of unhandled) {
                        handledInputs.add(inp);
                        rows.push({ label: extractRowLabelForInput(inp) || 'Item', input: inp });
                    }
                    const prompt = extractPromptAboveGroup(unhandled[0], allVisibleInputs) || 'Please enter a number in each row.';
                    const isAnswered = unhandled.every(inp => (inp.value || '').trim() !== '');
                    blocks.push({ type: 'number_grid', rows, prompt, isAnswered, element: unhandled[0] });
                }
            }
        }

        // B. Stacked Text Lists & Constant-Sum Text Inputs
        const allTextInputs = queryAllInRoots(
            roots,
            'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="number"]):not([type="range"]):not([type="file"]):not([type="image"]), textarea'
        ).filter(inp => isElementVisible(inp) && !inp.disabled && !inp.readOnly && !handledInputs.has(inp) && !isSpecifyInput(inp) && !isSearchOrFilterInput(inp) && !isHoneypotOrHiddenInput(inp) && !isHudElement(inp) && inp.getAttribute('role') !== 'combobox');

        if (allTextInputs.length >= 2) {
            const textGroupMap = new Map();
            for (const inp of allTextInputs) {
                let parent = inp.parentElement;
                while (parent && parent !== document.body) {
                    const count = parent.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="number"]):not([type="range"]), textarea').length;
                    if (count >= 2 && count <= 15) break;
                    parent = parent.parentElement;
                }
                const container = parent || document.body;
                if (!textGroupMap.has(container)) textGroupMap.set(container, []);
                textGroupMap.get(container).push(inp);
            }

            for (const [, inps] of textGroupMap.entries()) {
                const cleanInps = inps.filter(inp => !isSpecifyInput(inp) && !handledInputs.has(inp) && !isNumericTotalOrReadOnlyInput(inp));
                if (cleanInps.length >= 2) {
                    const prompt = extractPromptAboveGroup(cleanInps[0], allVisibleInputs) || findPromptAboveElement(cleanInps[0]) || 'Please list your responses.';
                    const isNumericAllocationOrGrid = /\b(total\s+100|sum\s+to\s+\d+|add\s+up\s+to\s+\d+|enter\s+a\s+number|how\s+many|number\s+of|percentage)\b/i.test(prompt) &&
                        cleanInps.every(inp => inp.tagName === 'INPUT' && (inp.size <= 6 || (inp.maxLength > 0 && inp.maxLength <= 5) || inp.getBoundingClientRect().width <= 110));

                    const rows = [];
                    for (const inp of cleanInps) {
                        handledInputs.add(inp);
                        rows.push({ label: extractRowLabelForInput(inp) || 'Item', input: inp });
                    }
                    const isAnswered = cleanInps.every(inp => (inp.value || inp.textContent || '').trim().length > 0);
                    blocks.push({
                        type: isNumericAllocationOrGrid ? 'number_grid' : 'text_list',
                        rows,
                        prompt,
                        isAnswered,
                        element: cleanInps[0]
                    });
                }
            }
        }

        // C. Radio Groups + Batched Matrix Grid Detection
        const radios = queryAllInRoots(roots, 'input[type="radio"]')
            .filter(r => isElementVisible(r) && !handledInputs.has(r) && !isHudElement(r));
        const nameGroups = new Map();
        let unnamedRowCounter = 0;
        const rowContainerMap = new Map();

        for (const r of radios) {
            let groupKey = r.name;
            if (!groupKey) {
                const rowContainer = r.closest('tr, [role="radiogroup"], fieldset, [data-test-id="ps-question-answers-wrapper"], .question-answers, [class*="row" i], [class*="question" i]') || r.parentElement;
                if (!rowContainerMap.has(rowContainer)) {
                    rowContainerMap.set(rowContainer, `__unnamed_group_${unnamedRowCounter++}`);
                }
                groupKey = rowContainerMap.get(rowContainer);
            }
            if (!nameGroups.has(groupKey)) nameGroups.set(groupKey, []);
            nameGroups.get(groupKey).push(r);
        }

        const singleRadioBlocks = [];
        for (const [, groupRadios] of nameGroups.entries()) {
            const unhandled = groupRadios.filter(r => !handledInputs.has(r));
            if (unhandled.length >= 2) {
                const choices = unhandled.map(inp => {
                    handledInputs.add(inp);
                    const label = findLabelForInput(inp);
                    const text = cleanOptionText(getLabelForInput(inp, label) || inp.value || '');
                    const target = label || inp.closest('.cm-response-container, td, li, [class*="choice" i], [class*="option" i], [class*="Selection" i], [class*="item" i]') || inp.parentElement || inp;
                    return {
                        text,
                        target,
                        label,
                        input: inp,
                        isChecked: inp.checked || !!(label && label.classList.contains('p-checked'))
                    };
                }).filter(c => c.text.length > 0);

                if (choices.length >= 2) {
                    const isAnswered = choices.some(c => c.isChecked);
                    const rowHeader = extractMatrixRowPrompt(choices[0].input);
                    const matrixContainer = choices[0].input.closest('table, [class*="matrix" i], [class*="grid" i], fieldset');
                    const distinctTexts = new Set(choices.map(c => c.text.toLowerCase())).size;

                    singleRadioBlocks.push({
                        type: 'choices',
                        choices,
                        isAnswered,
                        rowHeader,
                        matrixContainer,
                        distinctTexts,
                        element: choices[0].target
                    });
                }
            }
        }

        // Batch sibling radio rows sharing identical distinct column headers into a single matrix_grid
        const matrixGroups = new Map();
        const standaloneRadioBlocks = [];
        for (const rb of singleRadioBlocks) {
            if (rb.rowHeader && rb.matrixContainer && rb.distinctTexts >= 2) {
                const sig = rb.choices.map(c => c.text.toLowerCase()).join('|');
                if (!matrixGroups.has(rb.matrixContainer)) matrixGroups.set(rb.matrixContainer, new Map());
                const bySig = matrixGroups.get(rb.matrixContainer);
                if (!bySig.has(sig)) bySig.set(sig, []);
                bySig.get(sig).push(rb);
            } else {
                standaloneRadioBlocks.push(rb);
            }
        }

        for (const [container, bySig] of matrixGroups.entries()) {
            for (const [, rows] of bySig.entries()) {
                if (rows.length >= 2) {
                    const columns = rows[0].choices.map(c => c.text);
                    const isAnswered = rows.every(r => r.isAnswered);
                    const anchor = container.tagName === 'TABLE' ? container : rows[0].element;
                    const prompt = extractPromptAboveGroup(anchor, allVisibleInputs) || 'Rate each statement below.';
                    blocks.push({
                        type: 'matrix_grid',
                        rows,
                        columns,
                        isAnswered,
                        prompt,
                        element: rows[0].element
                    });
                } else {
                    standaloneRadioBlocks.push(rows[0]);
                }
            }
        }

        for (const rb of standaloneRadioBlocks) {
            const basePrompt = extractPromptAboveGroup(rb.element, allVisibleInputs);
            rb.prompt = rb.rowHeader && !basePrompt.includes(rb.rowHeader)
                ? `${basePrompt}\nRow Item: ${rb.rowHeader}`.trim()
                : basePrompt;
            blocks.push(rb);
        }

        // D. Checkbox Groups (supports column-grouped Decipher grids as well as standard row/list groups)
        const checkboxes = queryAllInRoots(roots, 'input[type="checkbox"]')
            .filter(cb => isElementVisible(cb) && !handledInputs.has(cb) && !isHudElement(cb));

        const colGroupTables = new Set();
        for (const cb of checkboxes) {
            const tbl = cb.closest('table');
            if (!tbl || colGroupTables.has(tbl)) continue;
            const settings = tbl.getAttribute('data-settings') || '';
            const isColGrouped = /\bgroup-by-col\b/i.test(settings) ||
                Boolean(tbl.querySelector('tr.row-col-legends th[scope="col"]') && tbl.querySelector('input[type="checkbox"].exclusive'));
            if (isColGrouped) colGroupTables.add(tbl);
        }

        for (const tbl of colGroupTables) {
            const tblCbs = checkboxes.filter(cb => !handledInputs.has(cb) && tbl.contains(cb));
            const colMap = new Map();
            for (const cb of tblCbs) {
                const td = cb.closest('td, th');
                const tr = cb.closest('tr');
                if (!td || !tr) continue;
                let colCursor = 0;
                for (const cell of Array.from(tr.children)) {
                    if (window.getComputedStyle(cell).display === 'none') continue;
                    if (cell === td) break;
                    colCursor += (cell.colSpan || 1);
                }
                if (!colMap.has(colCursor)) colMap.set(colCursor, []);
                colMap.get(colCursor).push(cb);
            }
            const basePrompt = extractPromptAboveGroup(tbl, allVisibleInputs) || 'Please select all that apply.';
            for (const [, colCbs] of colMap.entries()) {
                if (colCbs.length < 2) continue;
                const colHeader = getMatrixColumnHeaderForCell(colCbs[0]);
                const choices = colCbs.map(inp => {
                    handledInputs.add(inp);
                    const rowText = extractMatrixRowPrompt(inp) || getLabelForInput(inp, findLabelForInput(inp)) || inp.value || '';
                    const visTarget = inp.closest('td')?.querySelector('.fir-icon') || inp.closest('td.clickableCell, td') || findLabelForInput(inp) || inp;
                    return {
                        text: cleanOptionText(rowText),
                        target: visTarget,
                        label: null,
                        input: inp,
                        isChecked: inp.checked
                    };
                }).filter(c => c.text.length > 0);
                if (choices.length >= 2) {
                    const isAnswered = choices.some(c => c.isChecked);
                    const prompt = colHeader ? `${basePrompt}\nItem / Column: ${colHeader}` : basePrompt;
                    blocks.push({ type: 'choices', choices, isAnswered, prompt, element: choices[0].target });
                }
            }
        }

        const remainingCheckboxes = checkboxes.filter(cb => !handledInputs.has(cb));
        if (remainingCheckboxes.length >= 2) {
            const cbContainerMap = new Map();
            for (const cb of remainingCheckboxes) {
                const isMatrixRow = Boolean(extractMatrixRowPrompt(cb));
                let container = !isMatrixRow
                    ? cb.closest('.QuestionOuter, .QuestionBody, .cf-question, .cm-question, fieldset, [role="group"]')
                    : null;
                if (!container) {
                    let parent = cb.parentElement;
                    while (parent && parent !== document.body) {
                        const count = parent.querySelectorAll('input[type="checkbox"]').length;
                        if (count >= 2 && count <= 100) {
                            if (!isMatrixRow && parent.matches('tr, .row, [class*="row" i]') && parent.closest('table, .ChoiceStructure, [class*="grid" i], [class*="choice" i]')) {
                                parent = parent.parentElement;
                                continue;
                            }
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    container = parent || document.body;
                }
                if (!cbContainerMap.has(container)) cbContainerMap.set(container, []);
                cbContainerMap.get(container).push(cb);
            }

            for (const [, cbs] of cbContainerMap.entries()) {
                const unhandled = cbs.filter(cb => !handledInputs.has(cb));
                if (unhandled.length >= 2) {
                    const choices = unhandled.map(inp => {
                        handledInputs.add(inp);
                        const label = findLabelForInput(inp);
                        const text = cleanOptionText(getLabelForInput(inp, label) || inp.value || '');
                        const target = label || inp.closest('.cm-response-container, td, li, [class*="choice" i], [class*="option" i], [class*="Selection" i], [class*="item" i]') || inp.parentElement || inp;
                        return {
                            text,
                            target,
                            label,
                            input: inp,
                            isChecked: inp.checked || !!(label && label.classList.contains('p-checked'))
                        };
                    }).filter(c => c.text.length > 0);

                    if (choices.length >= 2) {
                        const isAnswered = choices.some(c => c.isChecked);
                        const prompt = extractPromptAboveGroup(choices[0].target, allVisibleInputs) || 'Please select all that apply.';
                        blocks.push({ type: 'choices', choices, isAnswered, prompt, element: choices[0].target });
                    }
                }
            }
        }

        // D2. Explicit ARIA Role Groups
        const ariaChoices = queryAllInRoots(roots, '[role="radio"], [role="checkbox"], [role="option"]')
            .filter(el => isElementVisible(el) && !handledInputs.has(el) && !handledCardElements.has(el) && !el.closest('select, [role="listbox"][aria-expanded]') && !isHudElement(el));

        if (ariaChoices.length >= 2) {
            const ariaGroupMap = new Map();
            for (const el of ariaChoices) {
                const innerInput = el.querySelector('input[type="radio"], input[type="checkbox"]');
                if (innerInput && handledInputs.has(innerInput)) continue;

                let container = el.closest('[role="radiogroup"], [role="group"], [role="listbox"], fieldset, tr');
                if (!container) {
                    let p = el.parentElement;
                    while (p && p !== document.body) {
                        const cnt = p.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]').length;
                        if (cnt >= 2 && cnt <= 100) { container = p; break; }
                        p = p.parentElement;
                    }
                }
                container = container || document.body;
                if (!ariaGroupMap.has(container)) ariaGroupMap.set(container, []);
                ariaGroupMap.get(container).push(el);
            }

            for (const [, els] of ariaGroupMap.entries()) {
                const unhandled = els.filter(el => !handledCardElements.has(el));
                if (unhandled.length >= 2) {
                    const choices = unhandled.map(el => {
                        handledCardElements.add(el);
                        const answerRow = el.closest('.cf-radio-answer, .cf-checkbox-answer, .cf-grid-answer, .cf-carousel__answer, [class*="answer-button" i]');
                        if (answerRow) handledCardElements.add(answerRow);
                        const innerInput = el.querySelector('input[type="radio"], input[type="checkbox"]');
                        if (innerInput) handledInputs.add(innerInput);
                        const text = cleanOptionText(
                            el.innerText ||
                            getAriaLabelledByText(el) ||
                            el.getAttribute('aria-label') ||
                            answerRow?.innerText ||
                            ''
                        );
                        return {
                            text,
                            target: answerRow || el,
                            ariaEl: el,
                            label: el.tagName === 'LABEL' ? el : el.querySelector('label'),
                            input: innerInput || null,
                            isChecked: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || !!(innerInput && innerInput.checked)
                        };
                    }).filter(c => c.text.length > 0);

                    if (choices.length >= 2) {
                        const isAnswered = choices.some(c => c.isChecked);
                        const prompt = extractPromptAboveGroup(choices[0].target, allVisibleInputs) || 'Select the best option.';
                        blocks.push({ type: 'choices', choices, isAnswered, prompt, element: choices[0].target });
                    }
                }
            }
        }

        // D2. Decipher Rank-Sort Widgets (.sq-ranksort)
        const rankSorts = queryAllInRoots(roots, '.sq-ranksort')
            .filter(rs => isElementVisible(rs) && !isHudElement(rs));
        for (const rs of rankSorts) {
            const cards = Array.from(rs.querySelectorAll('ul.sq-ranksort-cards > li.sq-ranksort-card'));
            const buckets = Array.from(rs.querySelectorAll('ul.sq-ranksort-buckets > li'));
            if (cards.length < 2 || buckets.length < 1) continue;
            rs.querySelectorAll('select').forEach(sel => handledInputs.add(sel));
            cards.forEach(c => handledCardElements.add(c));
            const requiredRanks = Math.min(buckets.length, cards.length);
            const droppedCount = cards.filter(c => c.classList.contains('sq-ranksort-card-dropped')).length;
            const bucketLabels = Array.from(rs.querySelectorAll('ul.sq-ranksort-buckets > li.sq-ranksort-bucket .sq-ranksort-bucket-text'))
                .map(b => cleanOptionText(b.innerText)).filter(Boolean);
            const prompt = cleanOptionText(rs.querySelector('.question-text')?.innerText) ||
                extractPromptAboveGroup(rs, allVisibleInputs) ||
                'Rank the top items.';
            blocks.push({
                type: 'rank_sort',
                element: rs,
                cards,
                buckets,
                bucketLabels,
                requiredRanks,
                isAnswered: droppedCount >= requiredRanks,
                prompt
            });
        }

        // E. Custom Div / Card Groups (supports wrapped [role="button"] / Tailwind / FontAwesome choice cards, excludes nav bars & overlaps)
        const navActionLabelRx = /^(?:[\s«»‹›<>→←⬅➡❯❮]+)?(next(?:\s*(?:page|step|question))?|continue|proceed|forward|submit|back|go\s*back|previous(?:\s*(?:page|step|question))?|prev|return|cancel|close|exit|finish|done|start(?:\s*survey)?|begin|save(?:\s*(?:&|and)\s*continue)?|reset(?:\s*form)?|clear(?:\s*(?:form|all|selection|answers?))?|skip(?:\s*(?:question|survey))?|i\s*can'?t\s*answer(?:\s*this\s*question)?|contact\s*(?:form\s*)?owner|edit\s*(?:this\s*)?form)(?:[\s«»‹›<>→←⬅➡❯❮!]+)?$/i;
        const formNavControlRx = /^(?:back|go\s*back|previous(?:\s*(?:page|step|question))?|prev|next(?:\s*(?:page|step|question))?|submit|clear\s*form|reset\s*form|edit\s*this\s*form|contact\s*form\s*owner)$/i;
        const resolveInteractiveCard = (el) => {
            if (!el) return el;
            if (el.matches('button, [role="button"], [data-testid^="option-"], .choice-option, [class*="choice-option" i]')) return el;
            const innerAction = el.querySelector('[role="button"], button, [data-testid^="option-"], .choice-option, [class*="choice-option" i]');
            if (innerAction && isElementVisible(innerAction)) return innerAction;
            const tabOverlay = el.querySelector('div[tabindex="0"], [tabindex="0"]');
            if (tabOverlay && isElementVisible(tabOverlay) && window.getComputedStyle(tabOverlay).cursor === 'pointer') {
                return tabOverlay;
            }
            if (el.matches('label')) return el;
            const innerLabel = el.querySelector('label');
            if (innerLabel && isElementVisible(innerLabel)) return innerLabel;
            return el;
        };

        const allContainers = queryAllInRoots(roots, 'fieldset, [class*="question" i], [class*="survey" i], [class*="choices" i], [class*="options" i], div');
        for (const c of allContainers) {
            if (!isElementVisible(c) || isHudElement(c) || c.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')) continue;
            if (blocks.some(b => c.contains(b.element) || b.element.contains(c))) continue;

            const children = Array.from(c.children).filter(child => {
                if (!isElementVisible(child) || child.tagName === 'A' || child.querySelector('a[href]') || handledCardElements.has(child)) return false;
                if (child.matches('[data-testid="confirm-selection"], [data-testid="submit-text"]') || child.querySelector('[data-testid="confirm-selection"], [data-testid="submit-text"]')) return false;
                if (isSearchOrFilterInput(child)) return false;
                const nestedInp = child.querySelector('input');
                if (nestedInp && isSearchOrFilterInput(nestedInp)) return false;
                const h = child.getBoundingClientRect().height;
                return h >= 24 && h <= 160;
            });
            if (children.length >= 2 && children.length <= 100) {
                const firstTag = children[0].tagName;
                const uniformTags = children.every(ch => ch.tagName === firstTag);
                if (!uniformTags) continue;

                const resolvedPairs = children.map(ch => ({ wrapper: ch, card: resolveInteractiveCard(ch) }));
                // Reject action/navigation bars (e.g. Google Forms [Back, Next] + [Clear form] wrapper)
                const hasMultiButtonWrapper = resolvedPairs.some(({ wrapper }) =>
                    !wrapper.matches('label, button, [role="button"], [data-testid^="option-"], .choice-option, [class*="choice-option" i]') &&
                    wrapper.querySelectorAll('button, [role="button"], a[href]').length > 1
                );
                if (hasMultiButtonWrapper) continue;

                const navArrowOnlyRx = /^[«»‹›<>→←⬅➡❯❮▲▼▶◀]+$/;
                const allNavButtons = resolvedPairs.every(p => {
                    const cTxt = cleanOptionText(p.card.innerText || p.wrapper.innerText);
                    const wTxt = cleanOptionText(p.wrapper.innerText);
                    return navActionLabelRx.test(cTxt) || navActionLabelRx.test(wTxt) || navArrowOnlyRx.test(cTxt) || navArrowOnlyRx.test(wTxt);
                });
                const allLegalLinks = resolvedPairs.every(p => /^(?:terms(?:\s*(?:&|and)\s*conditions)?|privacy\s*policy|cookie\s*policy)$/i.test(cleanOptionText(p.card.innerText || p.wrapper.innerText)));
                const hasExplicitFormNav = children.length <= 4 && resolvedPairs.some(({ wrapper, card }) => {
                    const cTxt = cleanOptionText(card.innerText || wrapper.innerText);
                    const jsname = card.getAttribute('jsname') || '';
                    return formNavControlRx.test(cTxt) || /^(GeGHKb|OCpkoe|X5DuWc|CHu7sb|FqYDPb)$/.test(jsname) || (card.tagName === 'BUTTON' && card.type === 'submit');
                });
                if (allNavButtons || allLegalLinks || hasExplicitFormNav) continue;

                const looksLikeCards = resolvedPairs.every(({ wrapper, card }) => {
                    if (handledCardElements.has(card)) return false;
                    if (card.tagName === 'BUTTON' && card.type === 'submit') return false;
                    // Never mistake rows containing text/number/select inputs (e.g., numeric lists) for clickable choice cards
                    const nonChoiceInput = wrapper.querySelector('input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), textarea, select');
                    if (nonChoiceInput && !isSpecifyInput(nonChoiceInput)) return false;
                    const cStyle = window.getComputedStyle(card);
                    const wStyle = card === wrapper ? cStyle : window.getComputedStyle(wrapper);
                    const txt = cleanOptionText(card.innerText || wrapper.innerText);
                    const cardTestId = card.getAttribute('data-testid') || '';
                    const isInteractive = (
                        cStyle.cursor === 'pointer' ||
                        wStyle.cursor === 'pointer' ||
                        card.tagName === 'LABEL' ||
                        card.tagName === 'BUTTON' ||
                        card.getAttribute('role') === 'button' ||
                        cardTestId.startsWith('option-') ||
                        (card.getAttribute('tabindex') === '0' && cStyle.cursor === 'pointer') ||
                        !!wrapper.querySelector('input[type="radio"], input[type="checkbox"], [role="button"], [data-testid^="option-"], [class*="radio" i], [class*="check" i], [class*="choice" i], [class*="option" i], svg[data-icon*="circle" i], svg[data-icon*="square" i]')
                    );
                    return isInteractive && txt.length > 0 && txt.length < 250 && !txt.endsWith('?');
                });

                if (looksLikeCards) {
                    const prompt = extractPromptAboveGroup(resolvedPairs[0].card, allVisibleInputs);
                    if (prompt) {
                        const choices = resolvedPairs.map(({ wrapper, card }) => {
                            handledCardElements.add(wrapper);
                            handledCardElements.add(card);
                            const inp = card.querySelector('input') || wrapper.querySelector('input') || null;
                            const text = cleanOptionText(card.innerText || wrapper.innerText);
                            const choiceObj = {
                                text,
                                target: card,
                                wrapper: wrapper !== card ? wrapper : null,
                                label: inp ? (card.tagName === 'LABEL' ? card : (card.querySelector('label') || wrapper.querySelector('label'))) : null,
                                input: inp,
                                isChecked: false
                            };
                            choiceObj.isChecked = !!(inp ? inp.checked : isChoiceMarkedSelected(choiceObj, prompt));
                            return choiceObj;
                        }).filter(ch => ch.text.length > 0);

                        if (choices.length >= 2) {
                            const isAnswered = choices.some(ch => ch.isChecked);
                            blocks.push({ type: 'choices', choices, isAnswered, prompt, element: choices[0].target });
                        }
                    }
                }
            }
        }

        // F. Native Dropdowns (<select>, including bootstrap-select selectpicker proxies)
        const selects = queryAllInRoots(roots, 'select').filter(s => isSelectOrProxyVisible(s) && !s.disabled && !isHudElement(s) && !isUtilityOrLanguageSelect(s));
        for (const s of selects) {
            const isAnswered = s.selectedIndex > 0 && s.value !== '' && !/^(select|choose|--)/i.test(s.options[s.selectedIndex]?.text);
            const prompt = extractPromptForSelect(s, allVisibleInputs);
            blocks.push({ type: 'select', element: s, isAnswered, prompt });
        }

        // F1. Custom ARIA / JS Dropdowns (including Google Forms collapsible [role="listbox"][aria-expanded])
        const customDropdowns = queryAllInRoots(roots, '[role="combobox"], [aria-haspopup="listbox"], [role="listbox"][aria-expanded], .select2-selection, .choices__inner')
            .filter(el => {
                if (!isElementVisible(el) || isHudElement(el) || el.closest('header, nav, footer, [role="banner"], [role="navigation"]')) return false;
                if (blocks.some(b => b.element === el || b.element.contains(el) || el.contains(b.element) || (b.type === 'select' && (getSelectVisualElement(b.element) === el || getBootstrapSelectContainer(b.element)?.contains(el))))) return false;
                return true;
            });
        for (const cd of customDropdowns) {
            const prompt = extractPromptAboveGroup(cd, allVisibleInputs) || findPromptAboveElement(cd) || 'Select the most appropriate option.';
            blocks.push({ type: 'custom_dropdown', element: cd, isAnswered: false, prompt });
        }

        // F2. Range Sliders (<input type="range">, excluding video/audio player volume & seek scrubbers)
        const isMediaControlSlider = (r) => {
            const sig = `${r.getAttribute('aria-label') || ''} ${r.title || ''} ${r.id || ''} ${r.name || ''} ${typeof r.className === 'string' ? r.className : ''}`;
            if (/\b(volume|audio|mute|seek|scrub|timeline|playback)\b/i.test(sig)) return true;
            if (r.closest('.video__volume, [class*="volume" i], [class*="scrubber" i], [class*="seek" i]')) return true;
            if (r.closest('.video__container, #sproutvideo-player-container, [class*="video-player" i], [class*="audio-player" i]') && !r.closest('[class*="question" i]')) return true;
            return false;
        };
        const ranges = queryAllInRoots(roots, 'input[type="range"], [role="slider"]')
            .filter(r => isElementVisible(r) && !r.disabled && r.getAttribute('aria-disabled') !== 'true' && !handledInputs.has(r) && !isHudElement(r) && !isMediaControlSlider(r));
        for (const r of ranges) {
            handledInputs.add(r);
            const isAnswered = touchedElements.has(r) ||
                Boolean(r.closest('.activated'));
            const basePrompt = extractPromptAboveGroup(r, allVisibleInputs) || findPromptAboveElement(r) || '';
            const itemLabel = getAriaLabelledByText(r) || extractRowLabelForInput(r) || '';
            let scaleLegend = '';
            const qScope = r.closest('.QuestionBody, .QuestionOuter, [class*="question" i]');
            if (qScope) {
                const lbls = Array.from(qScope.querySelectorAll('.labels-container ul.labels li')).map(li => (li.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
                const nums = Array.from(qScope.querySelectorAll('.labels-container ul.numbers li')).map(li => (li.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
                if (lbls.length > 0 && lbls.length === nums.length) {
                    scaleLegend = `Scale: ${nums.map((n, i) => `${n} = ${lbls[i]}`).join(' | ')}`;
                } else if (lbls.length > 0) {
                    scaleLegend = `Scale labels: ${lbls.join(' | ')}`;
                }
            }
            const prompt = [basePrompt, itemLabel && !basePrompt.includes(itemLabel) ? `Item: ${itemLabel}` : '', scaleLegend]
                .filter(Boolean).join('\n') || 'Select a rating on the slider.';
            blocks.push({ type: 'range', element: r, isAnswered, prompt });
        }

        // G. Standalone Text / Number / Date / Email Inputs & Textareas
        const existingNonTextBlocks = blocks.filter(b => b.type !== 'text' && b.type !== 'text_list');
        const remainingTextInputs = queryAllInRoots(
            roots,
            'textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="range"]):not([type="file"]):not([type="image"]), [contenteditable="true"]'
        ).filter(t => isElementVisible(t) && !t.disabled && !t.readOnly && !handledInputs.has(t) && !isSpecifyInput(t) && !isSearchOrFilterInput(t) && !isNumericTotalOrReadOnlyInput(t) && !isHoneypotOrHiddenInput(t) && !isHudElement(t) && t.getAttribute('role') !== 'combobox');

        for (const t of remainingTextInputs) {
            const prompt = extractPromptAboveGroup(t, allVisibleInputs) || findPromptAboveElement(t) || '';
            if (isOptionalOrUnnecessaryTextInput(t, prompt, existingNonTextBlocks)) continue;
            const isAnswered = (t.value || t.textContent || '').trim().length > 0;
            blocks.push({ type: 'text', element: t, isAnswered, prompt });
        }

        // Sort blocks naturally top-to-bottom across the page
        blocks.sort((a, b) => {
            const ea = a.type === 'select' ? getSelectVisualElement(a.element) : a.element;
            const eb = b.type === 'select' ? getSelectVisualElement(b.element) : b.element;
            const ra = ea.getBoundingClientRect();
            const rb = eb.getBoundingClientRect();
            return Math.abs(ra.top - rb.top) > 10 ? ra.top - rb.top : ra.left - rb.left;
        });

        return blocks;
    }

    function extractMatrixRowPrompt(inputEl) {
        if (!inputEl) return '';
        const tr = inputEl.closest('tr');
        if (!tr) return '';
        const headerCell = tr.querySelector('th, td:first-child, [class*="row-label" i], [class*="Statement" i]');
        if (headerCell && !headerCell.contains(inputEl)) {
            const txt = (headerCell.innerText || '').replace(/\s+/g, ' ').trim();
            if (txt.length > 1 && txt.length < 250) return txt;
        }
        return '';
    }

    function extractPromptAboveGroup(firstOptionEl, cachedInputs = null) {
        if (!firstOptionEl) return '';
        const targetEl = firstOptionEl.tagName === 'SELECT' ? getSelectVisualElement(firstOptionEl) : firstOptionEl;
        const rawRect = targetEl.getBoundingClientRect();
        let effectiveTop = rawRect.top;
        let effectiveBottom = rawRect.bottom;
        let scrollAnc = targetEl.parentElement;
        for (let i = 0; i < 12 && scrollAnc && scrollAnc !== document.body && scrollAnc !== document.documentElement; i++) {
            const st = window.getComputedStyle(scrollAnc);
            if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && scrollAnc.scrollHeight > scrollAnc.clientHeight + 4) {
                const sr = scrollAnc.getBoundingClientRect();
                if (sr.height > 0) {
                    effectiveTop = Math.max(effectiveTop, sr.top);
                    effectiveBottom = Math.min(effectiveBottom, sr.bottom);
                }
                break;
            }
            scrollAnc = scrollAnc.parentElement;
        }
        const rect = { top: effectiveTop, bottom: Math.max(effectiveTop, effectiveBottom), left: rawRect.left, right: rawRect.right, width: rawRect.width, height: rawRect.height };
        const root = targetEl.getRootNode ? targetEl.getRootNode() : document;
        const queryScope = root.querySelectorAll ? root : document;

        // CMIX (.cm-question) group prompt
        const cmQuestion = targetEl.closest('.cm-question');
        if (cmQuestion) {
            const cmParts = [];
            for (const qEl of cmQuestion.querySelectorAll('.cm-qintro, .cm-qtext')) {
                if (!isElementVisible(qEl) || qEl.contains(targetEl)) continue;
                const t = (qEl.innerText || '').replace(/\s+/g, ' ').trim();
                if (t && !cmParts.includes(t)) cmParts.push(t);
            }
            if (cmParts.length > 0) return cmParts.join('\n');
        }

        // Confirmit / Forsta / Toluna (.cf-question) or ARIA labelledby group prompt
        const cfQuestion = targetEl.closest('.cf-question');
        if (cfQuestion) {
            const cfParts = [];
            for (const qEl of cfQuestion.querySelectorAll('.cf-question__title, .cf-question__text, .cf-question__instruction')) {
                if (!isElementVisible(qEl) || qEl.contains(targetEl)) continue;
                const t = (qEl.innerText || '').replace(/\s+/g, ' ').trim();
                if (t && !cfParts.includes(t)) cfParts.push(t);
            }
            const carouselScope = targetEl.closest('.cf-carousel, [class*="carousel" i]') || cfQuestion.querySelector('.cf-carousel, [class*="carousel" i]');
            if (carouselScope) {
                let itemText = '';
                for (const itemEl of carouselScope.querySelectorAll('.cf-carousel__text, .cf-carousel__item-text, .cf-carousel__content-item-text, .cf-grid-answer__text, [class*="carousel" i][class*="text" i], [class*="carousel" i][class*="title" i]')) {
                    if (!isElementVisible(itemEl) || itemEl.contains(targetEl) || targetEl.contains(itemEl)) continue;
                    const t = (itemEl.innerText || '').replace(/\s+/g, ' ').trim();
                    if (t) { itemText = t; break; }
                }
                if (!itemText) {
                    for (const cand of carouselScope.querySelectorAll('h1, h2, h3, h4, strong, p, div, span')) {
                        if (!isElementVisible(cand) || cand.contains(targetEl) || targetEl.contains(cand)) continue;
                        if (cand.closest('button, [role="button"], [role="radio"], [role="checkbox"], [role="radiogroup"], .cf-list, [class*="paging" i], [class*="dots" i]')) continue;
                        if (cand.children.length > 2) continue;
                        const cr = cand.getBoundingClientRect();
                        if (cr.bottom > rect.top + 8) continue;
                        const t = (cand.innerText || '').replace(/\s+/g, ' ').trim();
                        if (t.length >= 2 && t.length <= 120 && !cfParts.includes(t)) {
                            itemText = t;
                            break;
                        }
                    }
                }
                if (itemText && !cfParts.some(p => p.includes(itemText))) {
                    cfParts.push(`Item: ${itemText}`);
                }
            }
            if (cfParts.length > 0) return cfParts.join('\n');
        }
        const labelledGroup = targetEl.closest('[role="radiogroup"][aria-labelledby], [role="group"][aria-labelledby]');
        if (labelledGroup) {
            const labelledTxt = getAriaLabelledByText(labelledGroup);
            if (labelledTxt.length >= 4) return labelledTxt;
        }

        // Conversational / side-by-side chat prompt layouts (e.g. Quest Mindshare [data-testid="message-text"] + [data-testid="instructions"])
        const chatMessages = Array.from(queryScope.querySelectorAll('[data-testid="message-text"]'))
            .filter(el => isElementVisible(el) && !isHudElement(el) && !el.contains(targetEl) && !targetEl.contains(el))
            .filter(el => el.getBoundingClientRect().top <= rect.bottom + 140);
        if (chatMessages.length > 0) {
            chatMessages.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
            const activeMsg = (chatMessages[chatMessages.length - 1].innerText || '').replace(/\s+/g, ' ').trim();
            if (activeMsg.length >= 4) {
                const instrEl = Array.from(queryScope.querySelectorAll('[data-testid="instructions"]'))
                    .filter(el => isElementVisible(el) && !isHudElement(el))
                    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
                    .pop();
                const instrTxt = instrEl ? (instrEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
                return instrTxt && !/^please\s+select\s+one$/i.test(instrTxt)
                    ? `${activeMsg}\n(${instrTxt})`
                    : activeMsg;
            }
        }

        const inputs = cachedInputs || Array.from(queryScope.querySelectorAll(
            'input:not([type="hidden"]), select, textarea, [role="radio"], [role="checkbox"], [role="combobox"], [role="listbox"][aria-expanded]'
        )).filter(el => (el.tagName === 'SELECT' ? isSelectOrProxyVisible(el) : isElementVisible(el)) && !isHudElement(el) && !isSearchOrFilterInput(el) && !isUtilityOrLanguageSelect(el));

        let upperBoundaryY = rect.top - 400;
        for (let i = 0; i < inputs.length; i++) {
            const prevInp = inputs[i];
            const prevRectEl = prevInp.tagName === 'SELECT' ? getSelectVisualElement(prevInp) : prevInp;
            if (prevInp === firstOptionEl || prevRectEl === targetEl || targetEl.contains(prevRectEl)) continue;
            const pr = prevRectEl.getBoundingClientRect();
            if (pr.bottom <= rect.top - 4 && pr.bottom > upperBoundaryY) {
                upperBoundaryY = pr.bottom + 2;
            }
        }

        const candidates = Array.from(queryScope.querySelectorAll('h1, h2, h3, h4, legend, p, div, span, label, strong, b'))
            .filter(el => {
                if (!isElementVisible(el) || isHudElement(el) || el.closest('header, nav, footer')) return false;
                if (el.contains(targetEl) || targetEl.contains(el)) return false;
                const isExplicitQuestionText = el.matches('.cf-question__text, .cf-question__title, .QuestionText, .question-text, [class*="question__text" i]');
                if (!isExplicitQuestionText && el.children.length > 3) return false;
                const r = el.getBoundingClientRect();
                return r.top >= upperBoundaryY && (rect.top - r.bottom) >= -15 && r.height > 8;
            });

        candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

        const lines = [];
        for (const el of candidates) {
            const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (txt.length < 4 || txt.length > 500) continue;
            if (/^(select one|select all|all that apply|required|\*|next|back|continue|i can'?t answer this question|search\.{0,3}|filter\.{0,3}|question\s+\d+\s*(?:of|\/)\s*\d+)$/i.test(txt)) continue;
            if (!lines.some(l => l.includes(txt) || txt.includes(l))) {
                lines.push(txt);
            }
        }
        return lines.join('\n');
    }

    function pickTargetBlock(unansweredBlocks, rawSelection) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && rawSelection) {
            const selRange = sel.getRangeAt(0);
            const selRect = selRange.getBoundingClientRect();
            if (selRect.width > 0 && selRect.height > 0) {
                const following = unansweredBlocks.filter(b => {
                    const r = b.element.getBoundingClientRect();
                    return r.top >= selRect.bottom - 40;
                });
                if (following.length > 0) {
                    following.sort((a, b) => a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top);
                    return following[0];
                }
            }

            const clean = rawSelection.toLowerCase();
            const matched = unansweredBlocks.find(b => (b.prompt || '').toLowerCase().includes(clean) || clean.includes((b.prompt || '').toLowerCase()));
            if (matched) return matched;
        }

        let closest = unansweredBlocks[0];
        let minDist = Infinity;
        for (const b of unansweredBlocks) {
            const rect = b.element.getBoundingClientRect();
            const cx = Math.max(rect.left, Math.min(mouseX, rect.right));
            const cy = Math.max(rect.top, Math.min(mouseY, rect.bottom));
            const dist = Math.hypot(mouseX - cx, mouseY - cy);
            if (dist < minDist) {
                minDist = dist;
                closest = b;
            }
        }
        return closest;
    }

    function detectBlankTrap(prompt) {
        if (!prompt) return false;
        return /\b(leave\s+(?:this|the)\s+(?:question|box|field|item)\s+blank|do\s+not\s+(?:answer|select|fill|enter)\s+this\s+(?:question|box|field|item)|skip\s+this\s+question)\b/i.test(prompt);
    }

    async function solveRankSort(block, fullPrompt) {
        if (abortRequested) return;
        const alreadyDropped = block.cards.filter(c => c.classList.contains('sq-ranksort-card-dropped')).length;
        const needed = Math.max(0, block.requiredRanks - alreadyDropped);
        if (needed === 0) return;

        const available = block.cards
            .filter(c => !c.classList.contains('sq-ranksort-card-dropped'))
            .map(c => ({
                el: c,
                text: cleanOptionText(c.querySelector('.sq-ranksort-card-text')?.innerText || c.innerText)
            }))
            .filter(item => item.text.length > 0);
        if (available.length === 0) return;

        const rankDesc = block.bucketLabels?.length
            ? `Ranks to fill (in order): ${block.bucketLabels.slice(alreadyDropped, alreadyDropped + needed).join(' -> ')}`
            : `Pick ${needed} items in rank order (most important first).`;
        const opts = available.map((it, i) => `[${i}] ${it.text}`).join('\n');
        const userContent = `${fullPrompt}\n${rankDesc}\n\nAvailable Items:\n${opts}`;
        const systemInstruction = `${buildConsistencySystemPrefix()}You are a consistent adult survey participant ranking items.
RULES:
1. Pick exactly ${Math.min(needed, available.length)} distinct 0-based indices in rank order (highest rank first).
2. Stay consistent with your persona and prior answers.
3. Output strictly JSON with NO extra keys: {"ranked": [<idx1>, <idx2>, ...]}`;

        updateHUD(`Ranking top ${needed}...`, 'working');
        let picks = [];
        try {
            const res = await callGeminiJSON(userContent, systemInstruction, 120);
            const arr = Array.isArray(res?.ranked) ? res.ranked : (Array.isArray(res) ? res : []);
            const seen = new Set();
            for (const v of arr) {
                const idx = parseInt(v, 10);
                if (!isNaN(idx) && idx >= 0 && idx < available.length && !seen.has(idx)) {
                    seen.add(idx);
                    picks.push(idx);
                    if (picks.length >= needed) break;
                }
            }
        } catch (err) {
            if (abortRequested) return;
            console.warn('[Gemini Typer] RankSort fallback:', err.message);
        }

        // Fill any missing slots deterministically so validation never blocks
        for (let i = 0; picks.length < Math.min(needed, available.length) && i < available.length; i++) {
            if (!picks.includes(i)) picks.push(i);
        }

        const chosenTexts = [];
        for (const idx of picks) {
            if (abortRequested) return;
            const item = available[idx];
            if (!item) continue;
            chosenTexts.push(item.text);
            await triggerNativeClick(item.el);
            await abortableSleep(pickRangeDelay(SPD.betweenClicks));
        }

        if (!abortRequested && chosenTexts.length > 0) {
            recordSessionAnswer(block.prompt || fullPrompt, chosenTexts.join(' > '));
            updateHUD(`Ranked ${chosenTexts.length} items`, 'active', 2500);
        }
    }

    async function solveSingleBlock(block, sharedConcept = '', rawSelection = '', roots = null) {
        if (abortRequested) return;
        const cleanShared = sharedConcept && !(block.prompt || '').includes(sharedConcept) ? sharedConcept : '';
        const errProbe = block.choices?.[0]?.input || block.element;
        const validationErr = errProbe ? getFieldValidationErrorText(errProbe) : '';
        if (validationErr && block.element) {
            validationRetryCounts.set(block.element, (validationRetryCounts.get(block.element) || 0) + 1);
        }
        const fullPrompt = [
            cleanShared,
            block.prompt || rawSelection || 'Answer the prompt.',
            validationErr ? `Validation Error to Fix: ${validationErr}` : ''
        ]
            .filter(Boolean)
            .join('\n\n');

        if (detectBlankTrap(fullPrompt)) {
            block.skippedBlankTrap = true;
            updateHUD('Skipped blank-trap check', 'active', 2200);
            return;
        }

        if (block.type === 'matrix_grid') {
            await solveMatrixGrid(block, fullPrompt);
        } else if (block.type === 'rank_sort') {
            await solveRankSort(block, fullPrompt);
        } else if (block.type === 'number_grid') {
            await solveNumberGrid(block, fullPrompt);
        } else if (block.type === 'text_list') {
            await solveTextList(block, fullPrompt);
        } else if (block.type === 'choices') {
            const trapIdx = detectTrapDirective(fullPrompt, block.choices);
            if (trapIdx !== -1) {
                if (abortRequested) return;
                await triggerNativeClick(block.choices[trapIdx].target, block.choices[trapIdx].input, block.choices[trapIdx].label);
                stampCustomChoiceSelected(block.choices[trapIdx], block.prompt);
                recordSessionAnswer(block.prompt || fullPrompt, block.choices[trapIdx].text);
                await handleSpecifyInputForChoice(block.choices[trapIdx], fullPrompt);
                updateHUD(`Selected: ${block.choices[trapIdx].text.slice(0, 28)}...`, 'active', 2500);
                return;
            }
            await executeMultipleChoice(fullPrompt, block.choices, block.prompt);
        } else if (block.type === 'select') {
            await executeSelectDropdown(block.element, fullPrompt);
        } else if (block.type === 'custom_dropdown') {
            await executeCustomDropdown(block.element, fullPrompt, roots);
        } else if (block.type === 'range') {
            await executeRangeSlider(block.element, fullPrompt);
        } else if (block.type === 'text') {
            await executeTextTyping(block.element, fullPrompt);
        }
    }

    function getValidSelectChoices(selectEl) {
        return Array.from(selectEl.options)
            .filter(opt => {
                const txt = opt.text.trim();
                const val = opt.value.trim();
                if (!val && !txt) return false;
                if (opt.disabled) return false;
                if (opt.index === 0 && /^(select|choose|please select|--|$)/i.test(txt)) return false;
                return true;
            })
            .map(opt => ({ text: opt.text.trim(), value: opt.value, index: opt.index }));
    }

    async function applySelectChoice(selectEl, chosen) {
        if (!selectEl || !chosen || abortRequested) return;
        if (selectEl.selectedIndex === chosen.index && selectEl.value === chosen.value) return;

        const bsContainer = getBootstrapSelectContainer(selectEl);
        if (bsContainer) {
            const toggleBtn = bsContainer.querySelector('button.dropdown-toggle, [data-toggle="dropdown"], [data-bs-toggle="dropdown"]');
            const menu = bsContainer.querySelector('.dropdown-menu.open, .dropdown-menu');
            const isOpen = bsContainer.classList.contains('open') || bsContainer.classList.contains('show') || menu?.classList.contains('show');
            if (!isOpen && toggleBtn) {
                await triggerNativeClick(toggleBtn, null, null);
                await abortableSleep(60);
                if (abortRequested) return;
            }

            const items = Array.from(bsContainer.querySelectorAll('ul.dropdown-menu.inner > li, .dropdown-menu li'));
            let targetLi = bsContainer.querySelector(`ul.dropdown-menu.inner > li[data-original-index="${chosen.index}"], .dropdown-menu li[data-original-index="${chosen.index}"]`);
            if (!targetLi) {
                const wantText = chosen.text.trim().toLowerCase();
                targetLi = items.find(li => ((li.querySelector('.text')?.textContent || li.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()) === wantText) || null;
            }
            if (targetLi) {
                const clickTarget = targetLi.querySelector('a, button') || targetLi;
                await triggerNativeClick(clickTarget, null, null);
                await abortableSleep(50);
            }

            // Ensure underlying <select> and visual label stay synced even if selectpicker intercepted or skipped native events
            if (selectEl.selectedIndex !== chosen.index || selectEl.value !== chosen.value) {
                const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
                if (descriptor && descriptor.set) {
                    descriptor.set.call(selectEl, chosen.value);
                } else {
                    selectEl.value = chosen.value;
                }
                selectEl.selectedIndex = chosen.index;
                if (selectEl.options[chosen.index]) {
                    selectEl.options[chosen.index].selected = true;
                }
                selectEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                selectEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                selectEl.dispatchEvent(new Event('blur', { bubbles: true }));
            }

            if (toggleBtn) {
                const filterOpt = toggleBtn.querySelector('.filter-option, .filter-option-inner-inner');
                if (filterOpt && filterOpt.textContent.trim() !== chosen.text.trim()) {
                    filterOpt.textContent = chosen.text;
                }
                toggleBtn.setAttribute('title', chosen.text);
                if (bsContainer.classList.contains('open') || bsContainer.classList.contains('show')) {
                    await triggerNativeClick(toggleBtn, null, null);
                }
            }
            return;
        }

        selectEl.scrollIntoView({ behavior: 'auto', block: 'nearest' });
        selectEl.focus();
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(selectEl, chosen.value);
        } else {
            selectEl.value = chosen.value;
        }
        selectEl.selectedIndex = chosen.index;
        if (selectEl.options[chosen.index]) {
            selectEl.options[chosen.index].selected = true;
        }
        selectEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        selectEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        selectEl.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    async function solveChoiceAndSelectBatch(blocks, sharedConcept = '') {
        let solved = 0;
        const llmItems = [];

        for (const b of blocks) {
            if (abortRequested) return solved;
            const promptText = b.prompt || 'Select the best option.';
            if (detectBlankTrap(promptText)) {
                b.skippedBlankTrap = true;
                solved++;
                continue;
            }
            if (b.type === 'choices') {
                const trapIdx = detectTrapDirective(promptText, b.choices);
                if (trapIdx !== -1) {
                    await triggerNativeClick(b.choices[trapIdx].target, b.choices[trapIdx].input, b.choices[trapIdx].label);
                    stampCustomChoiceSelected(b.choices[trapIdx], b.prompt);
                    recordSessionAnswer(promptText, b.choices[trapIdx].text);
                    await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                    await handleSpecifyInputForChoice(b.choices[trapIdx], promptText);
                    solved++;
                    continue;
                }
                const isMulti = /select all|all that apply|which of the following|any of the following|choose all/i.test(promptText) ||
                    (b.choices[0]?.input && b.choices[0].input.type === 'checkbox') ||
                    (b.choices[0]?.target && b.choices[0].target.getAttribute('role') === 'checkbox');
                llmItems.push({ block: b, prompt: promptText, choices: b.choices, isMulti });
            } else if (b.type === 'select') {
                const choices = getValidSelectChoices(b.element);
                if (choices.length === 0) continue;
                const trapIdx = detectTrapDirective(promptText, choices);
                if (trapIdx !== -1) {
                    await applySelectChoice(b.element, choices[trapIdx]);
                    recordSessionAnswer(promptText, choices[trapIdx].text);
                    await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                    solved++;
                    continue;
                }
                llmItems.push({ block: b, prompt: promptText, choices, isMulti: false });
            }
        }

        if (llmItems.length === 0 || abortRequested) return solved;

        try {
            updateHUD(`Batching ${llmItems.length} questions...`, 'working');
            const header = sharedConcept ? `Shared Context:\n${sharedConcept}\n\n` : '';
            const formatted = llmItems.map((item, qIdx) => {
                const mode = item.isMulti ? 'MULTI' : 'SINGLE';
                const opts = item.choices.map((c, i) => `[${i}] ${c.text}`).join(' | ');
                return `Q${qIdx} (${mode}): ${item.prompt}\nOptions: ${opts}`;
            }).join('\n\n');

            const userContent = `${header}${formatted}`;
            const systemInstruction = `${buildConsistencySystemPrefix()}You are a consistent adult survey participant answering ${llmItems.length} questions.
RULES:
1. Obey any trap/attention-check instructions strictly.
2. Keep demographic/brand/opinion answers strictly consistent with your persona and prior answers.
3. For SINGLE pick [index]; for MULTI pick 1-2 realistic indices (or exact matches for factual checks). Avoid "Other"/"None" when standard brands exist. For rating/opinion scales (1-5, 1-10, agree/disagree), pick a realistic varied mid-to-positive rating rather than defaulting to [0].
4. Output strictly JSON with NO extra keys: {"answers": [[idx], [idx], ...]} containing exactly ${llmItems.length} arrays.`;

            const maxTokens = Math.max(120, llmItems.length * 16 + 40);
            const res = await callGeminiJSON(userContent, systemInstruction, maxTokens);
            if (abortRequested) return solved;

            const answers = Array.isArray(res.answers) ? res.answers : Object.values(res);
            for (let i = 0; i < llmItems.length; i++) {
                if (abortRequested) return solved;
                const item = llmItems[i];
                const rawEntry = answers[i];
                const rawArr = Array.isArray(rawEntry) ? rawEntry : [rawEntry];
                let valid = rawArr.map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 0 && n < item.choices.length);

                if (valid.length === 0) {
                    // Clean per-block fallback if a single batch slot was missing
                    await solveSingleBlock(item.block, sharedConcept);
                    if (!lastSolveHadError) solved++;
                    continue;
                }

                if (!item.isMulti) valid = [valid[0]];
                else valid = sanitizeMultiSelectIndices(valid, item.choices, extractMaxSelectionCap(item.prompt));

                if (item.block.type === 'select') {
                    await applySelectChoice(item.block.element, item.choices[valid[0]]);
                    recordSessionAnswer(item.prompt, item.choices[valid[0]].text);
                    await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                } else {
                    const chosenTexts = [];
                    for (const idx of valid) {
                        if (abortRequested) return solved;
                        const ch = item.choices[idx];
                        chosenTexts.push(ch.text);
                        await triggerNativeClick(ch.target, ch.input, ch.label);
                        stampCustomChoiceSelected(ch, item.block.prompt);
                        await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                        await handleSpecifyInputForChoice(ch, item.prompt);
                    }
                    recordSessionAnswer(item.prompt, chosenTexts.join(', '));
                }
                solved++;
            }
            if (!abortRequested) {
                updateHUD(`Batch solved (${solved})`, 'active', 2200);
            }
            return solved;
        } catch (err) {
            if (abortRequested) return solved;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
            return solved;
        }
    }

    async function solveMatrixGrid(block, fullPrompt) {
        try {
            const pendingRows = block.rows.filter(r => !r.choices.some(c => c.input ? c.input.checked : isChoiceMarkedSelected(c)));
            if (pendingRows.length === 0) return;

            const llmRows = [];
            for (const row of pendingRows) {
                const trapIdx = detectTrapDirective(row.rowHeader, row.choices);
                if (trapIdx !== -1) {
                    await triggerNativeClick(row.choices[trapIdx].target, row.choices[trapIdx].input, row.choices[trapIdx].label);
                    await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                } else {
                    llmRows.push(row);
                }
            }

            if (llmRows.length === 0 || abortRequested) {
                if (!abortRequested) updateHUD(`Grid solved (${pendingRows.length} rows)`, 'active', 2500);
                return;
            }

            updateHUD(`Solving ${llmRows.length}-row grid...`, 'working');
            const colList = block.columns.map((c, i) => `[${i}]: "${c}"`).join(', ');
            const rowList = llmRows.map((r, i) => `Row [${i}]: "${r.rowHeader}"`).join('\n');

            const userContent = `Grid Question:\n${fullPrompt}\n\nColumns:\n${colList}\n\nStatements / Rows:\n${rowList}`;
            const systemInstruction = `${buildConsistencySystemPrefix()}You are an authentic human participant completing a survey matrix grid.
RULES:
1. Choose one column index (0 to ${block.columns.length - 1}) for each of the ${llmRows.length} rows.
2. Read each row carefully! If a row instructs you to pick a specific column (e.g. "Please select Strongly Disagree"), obey it strictly.
3. Avoid straight-lining (selecting the exact same column for every row); vary ratings naturally matching your persona and prior answers.
4. Output strictly JSON: {"selections": [colIdx0, colIdx1, ...]}.`;

            const maxTokens = Math.max(120, llmRows.length * 8 + 40);
            const res = await callGeminiJSON(userContent, systemInstruction, maxTokens);
            if (abortRequested) return;

            const selections = Array.isArray(res.selections) ? res.selections : Object.values(res);
            for (let i = 0; i < llmRows.length; i++) {
                if (abortRequested) return;
                const row = llmRows[i];
                let colIdx = parseInt(selections[i], 10);
                if (isNaN(colIdx) || colIdx < 0 || colIdx >= row.choices.length) {
                    colIdx = Math.min(row.choices.length - 1, Math.max(0, Math.floor(row.choices.length * 0.7)));
                }
                const chosen = row.choices[colIdx];
                if (chosen) {
                    await triggerNativeClick(chosen.target, chosen.input, chosen.label);
                    await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                }
            }
            if (!abortRequested) {
                updateHUD(`Grid solved (${pendingRows.length} rows)`, 'active', 2500);
            }
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    async function executeCustomDropdown(triggerEl, fullPrompt, cachedRoots = null) {
        try {
            updateHUD('Opening dropdown...', 'working');
            if (triggerEl.getAttribute('aria-expanded') !== 'true') {
                await triggerNativeClick(triggerEl, null, null);
                await abortableSleep(randomBetween(180, 290));
                if (abortRequested) return;
            }

            const roots = collectDocumentRoots();
            const optionPool = triggerEl.getAttribute('role') === 'listbox'
                ? Array.from(triggerEl.querySelectorAll('[role="option"]'))
                : queryAllInRoots(
                    roots,
                    '[role="option"], .select2-results__option, .choices__item--choice, [class*="menu-option" i], [class*="dropdown-item" i]'
                );
            const visibleOptions = optionPool.filter(el => isElementVisible(el) && !isHudElement(el) && el.getAttribute('aria-disabled') !== 'true');

            if (visibleOptions.length === 0) {
                if (triggerEl.tagName === 'INPUT' && !triggerEl.readOnly && !triggerEl.disabled) {
                    await executeTextTyping(triggerEl, fullPrompt);
                    touchedElements.add(triggerEl);
                    return;
                }
                touchedElements.add(triggerEl);
                updateHUD('No dropdown options found', 'error', 2200);
                return;
            }

            const choices = visibleOptions.map(el => ({
                text: cleanOptionText(el.innerText || el.getAttribute('aria-label') || ''),
                target: el
            })).filter(c => c.text.length > 0 && !/^(select|choose|please select|--)$/i.test(c.text));

            if (choices.length === 0) {
                touchedElements.add(triggerEl);
                return;
            }

            const selectedIndices = await queryGeminiForChoice(fullPrompt, choices);
            if (abortRequested) return;

            const chosen = choices[selectedIndices[0]] || choices[0];
            await triggerNativeClick(chosen.target, null, null);
            touchedElements.add(triggerEl);
            recordSessionAnswer(fullPrompt, chosen.text);
            updateHUD(`Selected: ${chosen.text.slice(0, 26)}`, 'active', 2500);
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    async function handleSpecifyInputForChoice(choice, fullPrompt) {
        if (abortRequested || !choice || !/\b(other|specify)\b/i.test(choice.text)) return;
        const specAttrId = choice.input?.getAttribute('data-specify');
        const container = (choice.target || choice.input)?.closest('.cm-response-container, tr, li, [class*="choice" i], [class*="option" i], div');
        if (!container && !specAttrId) return;

        const findBox = () => {
            if (specAttrId) {
                const byId = document.getElementById(specAttrId);
                if (byId) return byId;
            }
            return container ? container.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea') : null;
        };
        let specifyBox = findBox();
        if (!specifyBox || !isElementVisible(specifyBox)) {
            await abortableSleep(180);
            if (abortRequested) return;
            specifyBox = findBox();
        }
        if (specifyBox && isElementVisible(specifyBox) && !specifyBox.disabled && !specifyBox.readOnly && !(specifyBox.value || '').trim()) {
            try {
                const specText = await queryGeminiForText(`${fullPrompt}\nThe participant selected "${choice.text}". Provide a realistic short specification:`, '', { maxChars: 35 }, 'SHORT_ENTITY');
                if (!abortRequested && specText) {
                    const fitted = fitToConstraints(specText, { maxChars: 35 }, 'SHORT_ENTITY');
                    clearTargetContent(specifyBox);
                    await simulateTyping(specifyBox, fitted, { maxChars: 35 });
                }
            } catch (e) {}
        }
    }

    async function executeRangeSlider(rangeEl, promptText) {
        try {
            updateHUD('Adjusting slider...', 'working');
            const isNativeRange = rangeEl.tagName === 'INPUT';
            const rawMin = isNativeRange ? rangeEl.min : rangeEl.getAttribute('aria-valuemin');
            const rawMax = isNativeRange ? rangeEl.max : rangeEl.getAttribute('aria-valuemax');
            const rawStep = isNativeRange ? rangeEl.step : (rangeEl.getAttribute('step') || rangeEl.getAttribute('aria-step'));
            const rawStart = isNativeRange ? rangeEl.value : rangeEl.getAttribute('aria-valuenow');
            const min = (rawMin !== null && rawMin !== '' && !isNaN(Number(rawMin))) ? Number(rawMin) : 0;
            const max = (rawMax !== null && rawMax !== '' && !isNaN(Number(rawMax))) ? Number(rawMax) : 100;
            const step = (rawStep !== null && rawStep !== '' && !isNaN(Number(rawStep)) && Number(rawStep) > 0) ? Number(rawStep) : 1;
            const startVal = (rawStart !== null && rawStart !== '' && !isNaN(Number(rawStart))) ? Number(rawStart) : NaN;
            const currentVal = isNaN(startVal) ? (min + max) / 2 : startVal;

            const userContent = `Survey Prompt:\n${promptText}\nSlider Range: min=${min}, max=${max}, step=${step}`;
            const systemInstruction = `${buildConsistencySystemPrefix()}Output strictly JSON: {"value": number} with a realistic numeric slider value between ${min} and ${max} matching your persona and prior answers.`;
            const res = await callGeminiJSON(userContent, systemInstruction);
            if (abortRequested) return;

            let val = typeof res.value === 'number' ? res.value : parseFloat(res.value);
            if (isNaN(val)) val = Math.round((min + max) * 0.75);

            val = Math.max(min, Math.min(max, val));
            if (step > 0) val = Math.round((val - min) / step) * step + min;

            // Simulate pointer drag from current thumb position to target value before committing
            rangeEl.scrollIntoView({ behavior: 'auto', block: 'center' });
            const rect = rangeEl.getBoundingClientRect();
            const span = (max - min) || 1;
            const startRatio = Math.max(0, Math.min(1, (currentVal - min) / span));
            const endRatio = Math.max(0, Math.min(1, (val - min) / span));
            const clampX = (x) => Math.max(rect.left + 4, Math.min(rect.right - 4, x));
            const startX = clampX(rect.left + rect.width * startRatio);
            const endX = clampX(rect.left + rect.width * endRatio);
            const midY = rect.top + rect.height / 2 + (Math.random() - 0.5) * Math.min(4, rect.height * 0.3);
            const mkMouseOpts = (x, y) => ({
                bubbles: true, cancelable: true, composed: true,
                clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY
            });

            await movePointerWithTrajectory(startX, midY, rangeEl);
            if (abortRequested) return;
            try { rangeEl.dispatchEvent(new PointerEvent('pointerdown', mkMouseOpts(startX, midY))); } catch (e) {}
            try { rangeEl.dispatchEvent(new MouseEvent('mousedown', mkMouseOpts(startX, midY))); } catch (e) {}
            try { rangeEl.focus({ preventScroll: true }); } catch (e) {}

            const dragSteps = randomBetween(4, 7);
            const setter = isNativeRange ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set : null;
            for (let s = 1; s <= dragSteps; s++) {
                if (abortRequested) return;
                const t = s / dragSteps;
                const curStepVal = currentVal + (val - currentVal) * t;
                const snapped = s === dragSteps ? val : (step > 0 ? Math.round((curStepVal - min) / step) * step + min : curStepVal);
                const px = startX + (endX - startX) * t;
                const py = midY + (Math.random() - 0.5) * 2;
                mouseX = px;
                mouseY = py;
                if (isNativeRange) {
                    if (setter) setter.call(rangeEl, String(snapped));
                    else rangeEl.value = String(snapped);
                }
                const moveOpts = mkMouseOpts(px, py);
                try { rangeEl.dispatchEvent(new PointerEvent('pointermove', moveOpts)); } catch (e) {}
                try { rangeEl.dispatchEvent(new MouseEvent('mousemove', moveOpts)); } catch (e) {}
                try { document.dispatchEvent(new MouseEvent('mousemove', moveOpts)); } catch (e) {}
                if (isNativeRange) {
                    rangeEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                }
                await abortableSleep(randomBetween(28, 62));
            }
            const endOpts = mkMouseOpts(endX, midY);
            try { rangeEl.dispatchEvent(new PointerEvent('pointerup', endOpts)); } catch (e) {}
            try { rangeEl.dispatchEvent(new MouseEvent('mouseup', endOpts)); } catch (e) {}
            try { document.dispatchEvent(new MouseEvent('mouseup', endOpts)); } catch (e) {}
            if (!isNativeRange) {
                try { rangeEl.dispatchEvent(new MouseEvent('click', endOpts)); } catch (e) {}
            } else {
                rangeEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
            try { rangeEl.blur(); } catch (e) {}

            touchedElements.add(rangeEl);
            recordSessionAnswer(promptText, String(val));
            updateHUD(`Slider: ${val}`, 'active', 2500);
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    async function solveTextList(block, prompt) {
        try {
            updateHUD(`Solving ${block.rows.length} fields...`, 'working');
            const rowList = block.rows.map((r, i) => `[${i}]: ${r.label}`).join('\n');

            const userContent = `Survey Prompt:\n${prompt}\n\nList Fields to fill:\n${rowList}`;
            const systemInstruction = `${buildConsistencySystemPrefix()}You are an authentic survey participant completing a list of specific named items (such as radio stations, brands, stores, websites, or products).
RULES:
1. Provide a realistic, specific proper name, call sign, or frequency for each field matching your persona/location where relevant (e.g. "101.9 The Mix", "103.5 KISS FM", or "None").
2. DO NOT WRITE SENTENCES. DO NOT WRITE CONVERSATIONAL NARRATIVES. Output strictly short proper names or entities.
3. Output strictly a JSON object: {"answers": ["item0", "item1", "item2"]}.`;

            const res = await callGeminiJSON(userContent, systemInstruction);
            if (abortRequested) return;
            const answers = Array.isArray(res.answers) ? res.answers : Object.values(res);

            for (let i = 0; i < block.rows.length; i++) {
                if (abortRequested) return;
                const val = answers[i] !== undefined ? String(answers[i]).trim() : 'None';
                const input = block.rows[i].input;
                clearTargetContent(input);
                await simulateTyping(input, val, {});
                recordSessionAnswer(`${prompt} (${block.rows[i].label})`, val);
                if (abortRequested) return;
                await abortableSleep(randomBetween(90, 190));
            }
            if (!abortRequested) {
                updateHUD(`Filled ${block.rows.length} fields`, 'active', 2500);
            }
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    function detectConstantSumTarget(prompt) {
        const m = (prompt || '').match(/\b(?:total|sum\s+to|add\s+up\s+to|equal|must\s+equal|allocate|distribute)\s+(\d{2,4})\s*%?/i);
        if (m) return parseInt(m[1], 10);
        if (/\b100\s*%/i.test(prompt || '') && /\b(total|sum|percent|percentage|allocate)\b/i.test(prompt || '')) return 100;
        return null;
    }

    async function solveNumberGrid(block, prompt) {
        try {
            updateHUD(`Solving ${block.rows.length} rows...`, 'working');
            const rowBounds = block.rows.map(r => {
                const rawMin = r.input.getAttribute('min');
                const rawMax = r.input.getAttribute('max');
                const min = rawMin !== null && rawMin !== '' && !isNaN(Number(rawMin)) ? Number(rawMin) : null;
                const max = rawMax !== null && rawMax !== '' && !isNaN(Number(rawMax)) ? Number(rawMax) : null;
                const unitText = getAriaLabelledByText(r.input);
                return { min, max, unitText };
            });
            const rowList = block.rows.map((r, i) => {
                const b = rowBounds[i];
                const rangeNote = (b.min !== null || b.max !== null)
                    ? ` [valid range: ${b.min ?? 0}..${b.max ?? 'unlimited'}]`
                    : '';
                const labelText = (b.unitText && b.unitText.toLowerCase().includes(r.label.toLowerCase())) ? b.unitText : r.label;
                return `[${i}]: ${labelText}${rangeNote}`;
            }).join('\n');
            const constantSumTarget = detectConstantSumTarget(prompt);
            const sharedMax = rowBounds.every(b => b.max !== null && b.max === rowBounds[0].max) ? rowBounds[0].max : null;
            const sharedMin = rowBounds.every(b => b.min !== null && b.min === rowBounds[0].min) ? rowBounds[0].min : null;
            const rangeSummary = (sharedMin !== null || sharedMax !== null)
                ? `Each value must be within [${sharedMin ?? 0}..${sharedMax ?? 'unlimited'}].`
                : '';

            const userContent = `Survey Instructions: ${prompt}\n${rangeSummary ? rangeSummary + '\n' : ''}\nDevice/Item Rows:\n${rowList}`;
            const systemInstruction = constantSumTarget
                ? `${buildConsistencySystemPrefix()}You are an authentic survey participant completing a constant-sum allocation grid.
Provide realistic integer values for all ${block.rows.length} rows matching your persona/household so their exact sum equals ${constantSumTarget}. ${rangeSummary}
Output strictly a JSON object formatted as: {"counts": [val0, val1, ...]}. No text explanations.`
                : `${buildConsistencySystemPrefix()}You are an authentic survey participant answering financial account count, device count, hours, or quantity questions.
For each row, provide a realistic integer value matching your persona and prior answers. ${rangeSummary}
Output strictly a JSON object formatted as: {"counts": [count0, count1, count2]}. No text explanations.`;

            const res = await callGeminiJSON(userContent, systemInstruction);
            if (abortRequested) return;
            let counts = (Array.isArray(res.counts) ? res.counts : Object.values(res)).map((n, i) => {
                const parsed = parseInt(n, 10);
                let val = isNaN(parsed) ? (rowBounds[i]?.min ?? 0) : parsed;
                if (rowBounds[i]?.min !== null && val < rowBounds[i].min) val = rowBounds[i].min;
                if (rowBounds[i]?.max !== null && val > rowBounds[i].max) val = rowBounds[i].max;
                return val;
            });

            while (counts.length < block.rows.length) {
                const b = rowBounds[counts.length];
                counts.push(b?.min !== null ? b.min : 0);
            }
            counts = counts.slice(0, block.rows.length);

            if (constantSumTarget && block.rows.length > 0) {
                const currentSum = counts.reduce((a, b) => a + b, 0);
                if (currentSum !== constantSumTarget) {
                    const diff = constantSumTarget - currentSum;
                    const adjustIdx = counts.findIndex((c, idx) => {
                        const lo = rowBounds[idx]?.min ?? 0;
                        const hi = rowBounds[idx]?.max ?? Infinity;
                        return c + diff >= lo && c + diff <= hi;
                    });
                    if (adjustIdx !== -1) {
                        counts[adjustIdx] += diff;
                    } else if (!rowBounds.some(b => (b.min ?? 0) > 0)) {
                        counts.fill(0);
                        counts[0] = constantSumTarget;
                    }
                }
            }

            for (let i = 0; i < block.rows.length; i++) {
                if (abortRequested) return;
                const b = rowBounds[i];
                const fallbackVal = b?.min !== null ? String(b.min) : '0';
                const val = counts[i] !== undefined ? String(counts[i]) : fallbackVal;
                const inp = block.rows[i].input;
                clearTargetContent(inp);
                await simulateTyping(inp, val, { minVal: b?.min ?? null, maxVal: b?.max ?? null });
                recordSessionAnswer(`${prompt} (${block.rows[i].label})`, val);
                if (abortRequested) return;
                await abortableSleep(randomBetween(90, 180));
            }
            if (!abortRequested) {
                updateHUD(`Completed ${block.rows.length} rows`, 'active', 2500);
            }
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    function focusTextTarget(target) {
        if (!target || abortRequested) return;
        try { target.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (e) {}
        const rect = target.getBoundingClientRect();
        const cx = rect.left + Math.min(Math.max(rect.width / 2, 4), 40);
        const cy = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
        try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
        try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
        try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) {} }
        try { target.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
        try { target.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
        try { target.click(); } catch (e) {}
    }

    function setInputValue(input, value) {
        if (abortRequested || !input) return;
        focusTextTarget(input);
        const strVal = String(value);
        if (input.isContentEditable) {
            input.textContent = strVal;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: strVal, inputType: 'insertText' }));
            input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            try { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); } catch (e) {}
            try { if (document.activeElement === input) input.blur(); } catch (e) {}
            return;
        }
        const prevVal = input.value;
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
            setter.call(input, strVal);
        } else {
            input.value = strVal;
        }
        const tracker = input._valueTracker;
        if (tracker) tracker.setValue(prevVal === strVal ? '' : prevVal);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: strVal, inputType: 'insertText' }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: strVal.slice(-1) || '0' }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        try { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); } catch (e) {}
        try { if (document.activeElement === input) input.blur(); } catch (e) {}
    }

    function classifyTextInput(input, promptText, rowLabel) {
        const fullContext = `${promptText} ${rowLabel} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-label') || ''}`.toLowerCase();
        const typeAttr = (input.getAttribute('type') || 'text').toLowerCase();
        const inputMode = (input.getAttribute('inputmode') || '').toLowerCase();
        const maxLen = parseInt(input.getAttribute('maxlength'), 10) || 0;

        if (typeAttr === 'date' || /\b(?:dd\/mm\/yyyy|mm\/dd\/yyyy)\b/i.test(fullContext)) return 'DATE_INPUT';
        if (typeAttr === 'email') return 'EMAIL_INPUT';

        if (typeAttr === 'number' || inputMode === 'numeric' ||
            /\b(zip\s*code|postal|how old|your age|birth\s*year|enter a number|enter number|phone\s*number)\b/i.test(fullContext)) {
            return 'NUMERIC_SINGLE';
        }

        if (/\b(scale (?:from|of)?\s*\d+\s*(?:to|-)\s*\d+|rate (?:from)?\s*\d+|from 0-10|from 1-10|0 to 10|1 to 10)\b/i.test(fullContext)) {
            return 'NUMERIC_SCALE';
        }

        if (/\b(radio\s*station|station\s*\d+|brand\s*\d+|store\s*\d+|website\s*\d+|item\s*\d+|specify|name of|city|state|company|employer|carrier|job\s*title|school|car\s*make|model)\b/i.test(fullContext) ||
            /\b(please\s*list\s*the\s*(?:radio\s*stations|brands|stores|websites|names))\b/i.test(fullContext) ||
            (maxLen > 0 && maxLen <= 40 && !/\b(why|explain|describe|minimum)\b/i.test(fullContext))) {
            return 'SHORT_ENTITY';
        }

        return 'OPEN_ENDED';
    }

    async function executeTextTyping(target, promptText) {
        const rowLabel = extractRowLabelForInput(target);
        const mode = classifyTextInput(target, promptText, rowLabel);
        let constraints = extractDOMConstraints(target, promptText);

        const typeValueOnTarget = async (el, valStr, cstr) => {
            if (mode === 'DATE_INPUT') {
                setInputValue(el, valStr);
                return;
            }
            clearTargetContent(el);
            updateHUD('Typing response...', 'working');
            await simulateTyping(el, valStr, cstr);
            const currentVal = (el.isContentEditable ? el.textContent : el.value) || '';
            if (!abortRequested && currentVal.trim().length === 0 && valStr.length > 0) {
                setInputValue(el, valStr);
            }
        };

        try {
            updateHUD(`Generating ${mode.toLowerCase().replace('_', ' ')}...`, 'working');
            const responseText = await queryGeminiForText(promptText, rowLabel, constraints, mode);
            if (abortRequested) return;
            let fittedText = fitToConstraints(responseText, constraints, mode);

            // Re-acquire the text input if an SPA framework re-mounted it while waiting on the API
            if (!target || !target.isConnected) {
                const freshRoots = collectDocumentRoots();
                const freshBlocks = findAllQuestionBlocksOnPage(freshRoots);
                const replacement = freshBlocks.find(b => b.type === 'text' && !isBlockAnswered(b));
                if (replacement && replacement.element) {
                    target = replacement.element;
                } else {
                    return;
                }
            }

            await typeValueOnTarget(target, fittedText, constraints);
            if (!abortRequested) {
                await abortableSleep(200);
            }

            // Self-heal once if post-typing client validation reveals a tighter limit or error
            const postErr = !abortRequested ? getFieldValidationErrorText(target) : '';
            if (postErr && (validationRetryCounts.get(target) || 0) < 1) {
                validationRetryCounts.set(target, (validationRetryCounts.get(target) || 0) + 1);
                constraints = extractDOMConstraints(target, `${promptText}\n${postErr}`);
                updateHUD('Adjusting length...', 'working');
                const retryRaw = await queryGeminiForText(`${promptText}\n[FIX VALIDATION ERROR: ${postErr}]`, rowLabel, constraints, mode);
                if (!abortRequested && retryRaw) {
                    fittedText = fitToConstraints(retryRaw, constraints, mode);
                    await typeValueOnTarget(target, fittedText, constraints);
                    if (!abortRequested) await abortableSleep(180);
                }
            }

            if (!abortRequested) {
                const finalTyped = ((target.isContentEditable ? target.textContent : target.value) || fittedText || '').trim();
                if (finalTyped) recordSessionAnswer(promptText, finalTyped);
                updateHUD('Completed', 'active', 2500);
            }
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    function buildPayloadForModel(baseBody, modelName) {
        const genConfig = Object.assign({}, baseBody.generationConfig || {});
        if (/^gemma-4/i.test(modelName)) {
            genConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
        } else {
            delete genConfig.thinkingConfig;
        }
        return Object.assign({}, baseBody, { generationConfig: genConfig });
    }

    function extractCandidateText(data) {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const answerParts = parts
            .filter(p => !p.thought && typeof p.text === 'string' && p.text.trim().length > 0)
            .map(p => p.text);
        if (answerParts.length > 0) {
            return answerParts.join('').trim();
        }
        // Fallback if model returned only a single unlabeled text part
        for (let i = parts.length - 1; i >= 0; i--) {
            if (typeof parts[i].text === 'string' && parts[i].text.trim().length > 0) {
                return parts[i].text.trim();
            }
        }
        return '';
    }

    function parseModelJSON(rawText) {
        if (!rawText) throw new Error('Empty JSON response from model.');
        let clean = rawText.trim();
        // Strip markdown code fences if present
        const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced && fenced[1]) clean = fenced[1].trim();
        try {
            return JSON.parse(clean);
        } catch (e) {
            // Find the last complete JSON object in case of leading reasoning text
            const start = clean.lastIndexOf('{');
            const end = clean.lastIndexOf('}');
            if (start !== -1 && end > start) {
                try {
                    return JSON.parse(clean.slice(start, end + 1));
                } catch (e2) {}
            }
            const firstStart = clean.indexOf('{');
            if (firstStart !== -1 && end > firstStart) {
                return JSON.parse(clean.slice(firstStart, end + 1));
            }
            throw e;
        }
    }

    function sendGeminiRequestWithRetry(body, retriesPerModel = 1) {
        const modelQueue = [MODEL_NAME, ...FALLBACK_MODELS.filter(m => m && m !== MODEL_NAME)];

        return new Promise((resolve, reject) => {
            const tryModel = (modelIdx, remainingRetries) => {
                if (abortRequested) {
                    reject(new Error('Aborted'));
                    return;
                }
                const activeKey = getActiveApiKey();
                if (!activeKey) {
                    reject(new Error('No API key set. Use Tampermonkey menu -> Set Gemini API Key.'));
                    return;
                }
                const currentModel = modelQueue[modelIdx];
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${encodeURIComponent(activeKey)}`;
                const payload = buildPayloadForModel(body, currentModel);

                let reqHandle = null;
                const handleTransientFailure = async (errMsg) => {
                    if (abortRequested) return reject(new Error('Aborted'));
                    if (remainingRetries > 0) {
                        await abortableSleep(450);
                        if (abortRequested) return reject(new Error('Aborted'));
                        tryModel(modelIdx, remainingRetries - 1);
                        return;
                    }
                    if (modelIdx + 1 < modelQueue.length) {
                        await abortableSleep(180);
                        if (abortRequested) return reject(new Error('Aborted'));
                        tryModel(modelIdx + 1, retriesPerModel);
                        return;
                    }
                    reject(new Error(errMsg));
                };

                reqHandle = GM_xmlhttpRequest({
                    method: 'POST',
                    url: url,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(payload),
                    timeout: REQUEST_TIMEOUT_MS,
                    ontimeout: async () => {
                        activeXhrs.delete(reqHandle);
                        await handleTransientFailure(`Timeout (${currentModel})`);
                    },
                    onload: async (res) => {
                        activeXhrs.delete(reqHandle);
                        if (abortRequested) return reject(new Error('Aborted'));

                        if (res.status === 429 || res.status >= 500) {
                            await handleTransientFailure(`HTTP ${res.status} (${currentModel})`);
                            return;
                        }

                        let data;
                        try {
                            data = JSON.parse(res.responseText);
                        } catch (err) {
                            await handleTransientFailure(`HTTP ${res.status} invalid JSON`);
                            return;
                        }

                        if (data.error) {
                            const msg = data.error.message || `API Error (${res.status})`;
                            if (/quota|rate|overloaded|unavailable|exhausted|high demand/i.test(msg)) {
                                await handleTransientFailure(msg);
                                return;
                            }
                            // If a model rejects an argument (e.g. model-specific param), fail over cleanly before giving up
                            if (res.status === 400 && modelIdx + 1 < modelQueue.length) {
                                tryModel(modelIdx + 1, retriesPerModel);
                                return;
                            }
                            reject(new Error(msg));
                            return;
                        }
                        resolve(data);
                    },
                    onerror: async () => {
                        activeXhrs.delete(reqHandle);
                        await handleTransientFailure('Network error reaching Gemini API.');
                    },
                    onabort: () => {
                        activeXhrs.delete(reqHandle);
                        reject(new Error('Aborted'));
                    }
                });
                if (reqHandle) activeXhrs.add(reqHandle);
            };

            tryModel(0, retriesPerModel);
        });
    }

    function queryGeminiForText(prompt, rowLabel, constraints, mode) {
        return new Promise((resolve, reject) => {
            let contextualPrompt = rowLabel ? `${prompt}\nSpecific Field: ${rowLabel}` : prompt;
            let systemInstruction = '';
            let maxTokens = 300;
            let temp = 0.5;

            const personaPrefix = buildConsistencySystemPrefix();
            if (mode === 'DATE_INPUT') {
                systemInstruction = `${personaPrefix}Output ONLY a valid ISO date formatted strictly as YYYY-MM-DD (e.g. 1990-06-15). No words.`;
                maxTokens = 30;
                temp = 0.1;
            } else if (mode === 'EMAIL_INPUT') {
                systemInstruction = `${personaPrefix}Output ONLY a realistic personal email address matching your persona if given (e.g. jordan.ellis89@gmail.com). No words.`;
                maxTokens = 40;
                temp = 0.2;
            } else if (mode === 'NUMERIC_SINGLE') {
                if (constraints.minVal !== null || constraints.maxVal !== null) {
                    contextualPrompt += `\n[ALLOWED RANGE: ${constraints.minVal ?? 'any'} to ${constraints.maxVal ?? 'any'}]`;
                }
                systemInstruction = `${personaPrefix}Output ONLY a single realistic whole integer matching the question and your persona (e.g. age, 5-digit ZIP, count, or dollar amount). No letters, no punctuation, no words.`;
                maxTokens = 20;
                temp = 0.1;
            } else if (mode === 'NUMERIC_SCALE') {
                systemInstruction = `${personaPrefix}Output ONLY a single realistic integer rating score matching your persona and prior answers (e.g. 7, 8, 9). No words or sentences.`;
                maxTokens = 15;
                temp = 0.2;
            } else if (mode === 'SHORT_ENTITY') {
                systemInstruction = `${personaPrefix}You are an authentic survey participant answering a specific entity, station, or brand field.
RULES:
1. Output ONLY the clean, specific proper name, brand, station frequency, or call letters (e.g. "101.9 The Mix", "WBEZ", "Tide", "None").
2. DO NOT WRITE FULL SENTENCES. DO NOT WRITE CONVERSATIONAL NARRATIVES.
3. Keep it strictly under 30 characters. Plain text only.`;
                maxTokens = 40;
                temp = 0.35;
            } else {
                if (constraints.minChars > 0) {
                    contextualPrompt += `\n[MINIMUM REQUIREMENT: The final text must have at least ${constraints.minChars} characters. Never output less.]`;
                }
                if (constraints.maxChars > 0) {
                    const targetMax = constraints.maxChars > 40 ? Math.max(constraints.minChars || 0, Math.floor(constraints.maxChars * 0.85)) : constraints.maxChars;
                    contextualPrompt += `\n[MAXIMUM LIMIT: Must NOT exceed ${constraints.maxChars} characters total. Keep response concise around ${targetMax} characters or fewer.]`;
                }
                if (constraints.minWords > 0) {
                    contextualPrompt += `\n[MINIMUM WORDS: Write at least ${constraints.minWords} words.]`;
                }
                if (constraints.maxWords > 0) {
                    contextualPrompt += `\n[MAXIMUM WORDS: Do not exceed ${constraints.maxWords} words.]`;
                }
                const styleVariants = [
                    'Write casually like texting or filling a quick form on a phone — use contractions, concrete specifics, and slightly loose punctuation.',
                    'Sound direct and practical, mentioning one small personal detail or frustration without sounding polished or essay-like.',
                    'Keep it conversational and everyday (like "honestly...", "mainly just...", or starting straight with the point). Vary sentence rhythm.',
                    'Reply naturally in 1-2 blunt, unpretentious sentences with real-world examples instead of abstract buzzwords.'
                ];
                const pickedStyle = styleVariants[Math.floor(Math.random() * styleVariants.length)];
                systemInstruction = `${personaPrefix}You are a real person quickly typing an open-ended survey answer.
1. Voice: ${pickedStyle}
2. Anti-AI rules: Never use "I believe", "Overall", "Additionally", "Furthermore", "enhance", "streamline", "seamless", "user experience", or balanced pros/cons summaries.
3. Constraints: Satisfy any minimum/maximum character or word counts strictly. Plain text only, no quotes, bullets, or markdown.`;
                maxTokens = 350;
                temp = 0.78;
            }

            const body = {
                contents: [{ parts: [{ text: contextualPrompt }] }],
                systemInstruction: { parts: [{ text: systemInstruction }] },
                generationConfig: {
                    temperature: temp,
                    maxOutputTokens: maxTokens
                }
            };

            sendGeminiRequestWithRetry(body)
                .then((data) => {
                    const result = extractCandidateText(data);
                    if (!result) {
                        reject(new Error('Model returned an empty payload.'));
                        return;
                    }
                    resolve(result);
                })
                .catch(reject);
        });
    }

    function fitToConstraints(text, constraints, mode) {
        let res = text.trim().replace(/^["']|["']$/g, '');

        if (mode === 'DATE_INPUT') {
            if (constraints.ddMmYyyy) {
                const dmy = res.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
                if (dmy) return dmy[1];
                const iso = res.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
                if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
                return '15/06/1990';
            }
            const isoMatch = res.match(/\d{4}-\d{2}-\d{2}/);
            return isoMatch ? isoMatch[0] : '1990-06-15';
        }

        if (mode === 'NUMERIC_SINGLE' || mode === 'NUMERIC_SCALE') {
            if (constraints.isFiveDigitZip) {
                const zip5 = res.match(/\b(\d{5})\b/);
                if (zip5 && zip5[1]) return zip5[1];
            }
            let digits = res.replace(/\D/g, '');
            if (!digits) digits = '0';
            if (constraints.minVal !== null || constraints.maxVal !== null) {
                let num = parseInt(digits, 10);
                if (!isNaN(num)) {
                    if (constraints.minVal !== null && num < constraints.minVal) num = Math.ceil(constraints.minVal);
                    if (constraints.maxVal !== null && num > constraints.maxVal) num = Math.floor(constraints.maxVal);
                    digits = String(num);
                }
            }
            return digits;
        }

        if (mode === 'SHORT_ENTITY') {
            res = res.replace(/^(i usually listen to|i listen to|i like|my favorite is|favorite station is)\s+/i, '').trim();
            if (res.length > 35) res = res.slice(0, 35).trim();
            return res;
        }

        if (constraints.maxWords > 0) {
            const words = res.split(/\s+/).filter(Boolean);
            if (words.length > constraints.maxWords) {
                res = words.slice(0, constraints.maxWords).join(' ').replace(/[,;:\-]+$/, '');
                if (!/[.!?]$/.test(res) && (!constraints.maxChars || res.length < constraints.maxChars)) res += '.';
            }
        }

        if (constraints.maxChars > 0 && res.length > constraints.maxChars) {
            const sub = res.slice(0, constraints.maxChars);
            const lastPunct = Math.max(sub.lastIndexOf('.'), sub.lastIndexOf('!'), sub.lastIndexOf('?'));

            if (lastPunct >= (constraints.minChars || 0) && lastPunct > sub.length * 0.45) {
                res = sub.slice(0, lastPunct + 1).trim();
            } else {
                const subForPeriod = res.slice(0, Math.max(1, constraints.maxChars - 1));
                const lastSpace = subForPeriod.lastIndexOf(' ');
                if (lastSpace >= (constraints.minChars || 0) && lastSpace > 0) {
                    res = subForPeriod.slice(0, lastSpace).trim();
                    if (!/[.!?]$/.test(res) && res.length < constraints.maxChars) res += '.';
                } else {
                    res = sub.trim();
                }
            }
        }
        return res;
    }

    function clearTargetContent(target) {
        if (abortRequested || !target) return;
        focusTextTarget(target);
        if (target.isContentEditable) {
            if ((target.textContent || '').length === 0) return;
            const range = document.createRange();
            range.selectNodeContents(target);
            const sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
            }
            try { document.execCommand('delete', false, null); } catch (e) {}
            if (target.textContent.length > 0) target.textContent = '';
            target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
            target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        } else {
            const prevVal = target.value || '';
            if (prevVal.length === 0) return;
            const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) {
                setter.call(target, '');
            } else {
                target.value = '';
            }
            const tracker = target._valueTracker;
            if (tracker) tracker.setValue(prevVal);
            target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
            target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
    }

    function extractDOMConstraints(target, promptText = '') {
        let minChars = parseInt(target.getAttribute('minlength'), 10) || 0;
        let maxChars = parseInt(target.getAttribute('maxlength'), 10) || 0;
        if (maxChars <= 0 || maxChars > 50000) maxChars = 0;

        let minWords = 0;
        let maxWords = 0;

        let scanText = promptText + ' ';
        const describedIds = (target.getAttribute('aria-describedby') || '').trim().split(/\s+/).filter(Boolean);
        const root = target.getRootNode ? target.getRootNode() : document;
        for (const id of describedIds) {
            try {
                const ref = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
                if (ref) scanText += ' ' + (ref.innerText || '');
            } catch (e) {}
        }
        let node = target.parentElement;
        for (let i = 0; i < 4 && node; i++) {
            scanText += ' ' + (node.innerText || '');
            node = node.parentElement;
        }

        const minCharMatch = scanText.match(/(?:minimum|at\s+least)\s+(?:of\s+)?(\d+)\s*(?:characters?|chars?)\b/i);
        if (minCharMatch) minChars = Math.max(minChars, parseInt(minCharMatch[1], 10));

        const applyMaxCharsCap = (parsed) => {
            if (parsed > 0) maxChars = maxChars > 0 ? Math.min(maxChars, parsed) : parsed;
        };
        const maxCharMatch = scanText.match(/(?:maximum|max(?:\s+of)?|up\s+to|no\s+more\s+than|under|below|less\s+than|limit(?:\s+of|:)?)\s*(\d+)\s*(?:characters?|chars?)\b|\b(\d+)[\s-]*(?:character|char)\s*(?:limit|max|maximum)\b/i);
        if (maxCharMatch) applyMaxCharsCap(parseInt(maxCharMatch[1] || maxCharMatch[2], 10));
        const slashCharMatch = scanText.match(/\b\d+\s*\/\s*(\d+)\s*(?:characters?|chars?)\b/i);
        if (slashCharMatch) applyMaxCharsCap(parseInt(slashCharMatch[1], 10));
        const currentLen = (target.isContentEditable ? target.textContent : target.value || '').trim().length;
        if (currentLen === 0) {
            const remCharMatch = scanText.match(/\b(\d+)\s*(?:characters?|chars?)\s*(?:remaining|left)\b/i);
            if (remCharMatch) applyMaxCharsCap(parseInt(remCharMatch[1], 10));
        }

        const minWordMatch = scanText.match(/(?:minimum|at\s+least)\s+(?:of\s+)?(\d+)\s*words?\b/i);
        if (minWordMatch) minWords = parseInt(minWordMatch[1], 10);

        const maxWordMatch = scanText.match(/(?:maximum|max(?:\s+of)?|up\s+to|no\s+more\s+than|under|below|less\s+than|limit(?:\s+of|:)?)\s*(\d+)\s*words?\b/i);
        if (maxWordMatch) maxWords = parseInt(maxWordMatch[1], 10);
        const slashWordMatch = scanText.match(/\b\d+\s*\/\s*(\d+)\s*words?\b/i);
        if (slashWordMatch) {
            const pw = parseInt(slashWordMatch[1], 10);
            if (pw > 0) maxWords = maxWords > 0 ? Math.min(maxWords, pw) : pw;
        }

        const rawMinVal = target.getAttribute('min');
        const rawMaxVal = target.getAttribute('max');
        const minVal = rawMinVal !== null && rawMinVal !== '' && !isNaN(Number(rawMinVal)) ? Number(rawMinVal) : null;
        const maxVal = rawMaxVal !== null && rawMaxVal !== '' && !isNaN(Number(rawMaxVal)) ? Number(rawMaxVal) : null;
        const isFiveDigitZip = /\b(5-digit|five-digit|zip\s*code|postal\s*code)\b/i.test(scanText);
        const ddMmYyyy = /\bdd\/mm\/yyyy\b/i.test(scanText);

        return { minChars, maxChars, minWords, maxWords, minVal, maxVal, isFiveDigitZip, ddMmYyyy };
    }

    function calculateTypingDelay(char, prevChar) {
        if (/[.!?]/.test(prevChar)) return randomBetween(SPD.typeSentence[0], SPD.typeSentence[1]);
        if (/[,;:]/.test(prevChar)) return randomBetween(SPD.typeComma[0], SPD.typeComma[1]);
        if (char === ' ') return randomBetween(SPD.typeSpace[0], SPD.typeSpace[1]);
        if (Math.random() < 0.04) return randomBetween(SPD.typeComma[0], SPD.typeComma[1]);
        return randomBetween(SPD.typeBase[0], SPD.typeBase[1]);
    }

    const PUNCT_KEY_MAP = {
        ' ': ['Space', 32, false],
        '\n': ['Enter', 13, false],
        '-': ['Minus', 189, false],
        '_': ['Minus', 189, true],
        '=': ['Equal', 187, false],
        '+': ['Equal', 187, true],
        '[': ['BracketLeft', 219, false],
        '{': ['BracketLeft', 219, true],
        ']': ['BracketRight', 221, false],
        '}': ['BracketRight', 221, true],
        '\\': ['Backslash', 220, false],
        '|': ['Backslash', 220, true],
        ';': ['Semicolon', 186, false],
        ':': ['Semicolon', 186, true],
        "'": ['Quote', 222, false],
        '"': ['Quote', 222, true],
        ',': ['Comma', 188, false],
        '<': ['Comma', 188, true],
        '.': ['Period', 190, false],
        '>': ['Period', 190, true],
        '/': ['Slash', 191, false],
        '?': ['Slash', 191, true],
        '`': ['Backquote', 192, false],
        '~': ['Backquote', 192, true],
        '!': ['Digit1', 49, true],
        '@': ['Digit2', 50, true],
        '#': ['Digit3', 51, true],
        '$': ['Digit4', 52, true],
        '%': ['Digit5', 53, true],
        '^': ['Digit6', 54, true],
        '&': ['Digit7', 55, true],
        '*': ['Digit8', 56, true],
        '(': ['Digit9', 57, true],
        ')': ['Digit0', 48, true]
    };

    function resolveKeyDescriptor(char) {
        if (/^[a-z]$/.test(char)) {
            const upper = char.toUpperCase();
            return { key: char, code: `Key${upper}`, keyCode: upper.charCodeAt(0), shiftKey: false };
        }
        if (/^[A-Z]$/.test(char)) {
            return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), shiftKey: true };
        }
        if (/^[0-9]$/.test(char)) {
            return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), shiftKey: false };
        }
        const mapped = PUNCT_KEY_MAP[char];
        if (mapped) {
            return { key: char, code: mapped[0], keyCode: mapped[1], shiftKey: mapped[2] };
        }
        return { key: char, code: '', keyCode: char.toUpperCase().charCodeAt(0) || 0, shiftKey: false };
    }

    async function simulateTyping(target, text, constraints = {}) {
        if (abortRequested || !target) return;
        focusTextTarget(target);
        let prevChar = '';

        for (let i = 0; i < text.length; i++) {
            if (abortRequested || !target.isConnected) break;
            const currentLen = target.isContentEditable ? (target.textContent?.length || 0) : (target.value?.length || 0);
            if (constraints.maxChars > 0 && currentLen >= constraints.maxChars) break;

            const char = text[i];
            if (document.activeElement !== target) {
                try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) {} }
            }

            const kd = resolveKeyDescriptor(char);
            if (kd.shiftKey) {
                target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, location: 1, shiftKey: true, bubbles: true, cancelable: true, composed: true }));
            }

            const keyInit = { key: kd.key, code: kd.code, keyCode: kd.keyCode, which: kd.keyCode, shiftKey: kd.shiftKey, bubbles: true, cancelable: true, composed: true };
            target.dispatchEvent(new KeyboardEvent('keydown', keyInit));
            if (char !== '\n') {
                const cpCode = char.charCodeAt(0);
                target.dispatchEvent(new KeyboardEvent('keypress', { key: kd.key, code: kd.code, keyCode: cpCode, which: cpCode, charCode: cpCode, shiftKey: kd.shiftKey, bubbles: true, cancelable: true, composed: true }));
            }
            try {
                target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: char === '\n' ? 'insertLineBreak' : 'insertText', data: char }));
            } catch (e) {}

            if (target.isContentEditable) {
                const beforeLen = target.textContent?.length || 0;
                let inserted = false;
                if (document.activeElement === target) {
                    try { inserted = document.execCommand('insertText', false, char); } catch (e) { inserted = false; }
                }
                const afterLen = target.textContent?.length || 0;
                if (!inserted || afterLen <= beforeLen) {
                    insertFallback(target, char, constraints);
                }
            } else {
                insertFallback(target, char, constraints);
            }

            // Realistic key hold dwell (keydown -> keyup)
            await abortableSleep(pickRangeDelay(SPD.keyDwell));
            if (abortRequested || !target.isConnected) break;

            target.dispatchEvent(new KeyboardEvent('keyup', keyInit));
            if (kd.shiftKey) {
                target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, location: 1, shiftKey: false, bubbles: true, composed: true }));
            }

            const flightDelay = calculateTypingDelay(char, prevChar);
            prevChar = char;
            await abortableSleep(flightDelay);
        }

        target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        target.dispatchEvent(new Event('blur', { bubbles: true }));
        try { target.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); } catch (e) {}
        try { if (document.activeElement === target) target.blur(); } catch (e) {}
    }

    function insertFallback(target, char, constraints = {}) {
        if (abortRequested || !target) return;
        if (target.isContentEditable) {
            const currentLen = target.textContent?.length || 0;
            if (constraints.maxChars > 0 && currentLen >= constraints.maxChars) return;

            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && target.contains(sel.anchorNode)) {
                const range = sel.getRangeAt(0);
                range.deleteContents();
                const node = document.createTextNode(char);
                range.insertNode(node);
                range.setStartAfter(node);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            } else {
                target.textContent += char;
            }
        } else {
            const val = target.value || '';
            if (constraints.maxChars > 0 && val.length >= constraints.maxChars) return;

            let start = val.length;
            let end = val.length;
            try {
                if (typeof target.selectionStart === 'number' && typeof target.selectionEnd === 'number') {
                    start = target.selectionStart;
                    end = target.selectionEnd;
                }
            } catch (e) {}

            const updated = val.slice(0, start) + char + val.slice(end);
            const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

            if (set) {
                set.call(target, updated);
            } else {
                target.value = updated;
            }

            const tracker = target._valueTracker;
            if (tracker) tracker.setValue(val);

            try {
                target.selectionStart = target.selectionEnd = start + char.length;
            } catch (e) {}
        }

        target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
    }

    function extractMaxSelectionCap(text) {
        if (!text) return null;
        const wordMap = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
        const m = String(text).match(/(?:up\s+to|at\s+most|no\s+more\s+than|max(?:imum)?(?:\s+of)?|select\s+only|choose\s+only|pick\s+only|top)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
        if (!m) return null;
        const raw = m[1].toLowerCase();
        const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : (wordMap[raw] || null);
        return (n && n > 0) ? n : null;
    }

    function sanitizeMultiSelectIndices(selectedIndices, choices, maxCap = null) {
        if (selectedIndices.length <= 1) return selectedIndices;

        const regularIndices = [];
        const exclusiveIndices = [];

        for (const idx of selectedIndices) {
            const text = (choices[idx]?.text || '').toLowerCase().trim();
            const isExclusive = /^(none|none of the above|i did not|no,?\s+none|n\/a|not applicable|don'?t know|prefer not to answer)\b/i.test(text);
            const isOther = /^other\b/i.test(text);

            if (isExclusive) {
                exclusiveIndices.push(idx);
            } else if (!isOther) {
                regularIndices.push(idx);
            }
        }

        let res = regularIndices.length > 0
            ? regularIndices
            : (exclusiveIndices.length > 0 ? [exclusiveIndices[0]] : selectedIndices);
        if (maxCap && res.length > maxCap) res = res.slice(0, maxCap);
        return res;
    }

    function detectTrapDirective(prompt, choices) {
        if (!prompt || !choices || choices.length === 0) return -1;
        const patterns = [
            /(?:select|choose|pick|click|mark|check|answer)\s+(?:the\s+(?:option|answer|box)\s+(?:for\s+)?)?["'“‘]([^"'”’]+)["'”’]/i,
            /(?:select|choose|pick|click|mark)\s+([A-Za-z0-9\s/-]+?)\s+(?:from the options|from below|as the answer|as your answer|below|to continue|for this question|on this row)/i,
            /(?:for\s+this\s+(?:row|question|item),?\s*)?(?:please\s+)?(?:select|choose|pick|click|mark)\s+([A-Za-z0-9\s/-]+?)(?:\.|,|!|$)/i,
            /select\s+option\s+([A-Za-z0-9]+)/i
        ];

        for (const pat of patterns) {
            const m = prompt.match(pat);
            if (m && m[1]) {
                const target = m[1].toLowerCase().trim().replace(/[.,!?;:]+$/, '');
                if (!target) continue;

                const idx = choices.findIndex(c => c.text.toLowerCase().trim() === target);
                if (idx !== -1) return idx;
            }
        }
        return -1;
    }

    async function executeMultipleChoice(prompt, choices, stampPrompt = '') {
        try {
            updateHUD('Deciding option...', 'working');
            const selectedIndices = await queryGeminiForChoice(prompt, choices);
            if (abortRequested) return;

            if (!selectedIndices || selectedIndices.length === 0) {
                updateHUD('No option selected', 'error', 3000);
                return;
            }

            const isCheckboxGroup = choices.some(c => c.input && c.input.type === 'checkbox');
            const selectedSet = new Set(selectedIndices);
            if (isCheckboxGroup) {
                for (let i = 0; i < choices.length; i++) {
                    if (abortRequested) return;
                    if (choices[i]?.input?.checked && !selectedSet.has(i)) {
                        await triggerNativeClick(choices[i].target, choices[i].input, choices[i].label, false);
                        await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                    }
                }
            }

            const chosenTexts = [];
            for (const idx of selectedIndices) {
                if (abortRequested) return;
                if (choices[idx]) {
                    chosenTexts.push(choices[idx].text);
                    if (!isCheckboxGroup || !choices[idx].input?.checked) {
                        await triggerNativeClick(choices[idx].target, choices[idx].input, choices[idx].label);
                        await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                    }
                    stampCustomChoiceSelected(choices[idx], stampPrompt || prompt);
                    await handleSpecifyInputForChoice(choices[idx], prompt);
                }
            }

            if (!abortRequested) {
                if (chosenTexts.length > 0) recordSessionAnswer(stampPrompt || prompt, chosenTexts.join(', '));
                const chosenLabels = selectedIndices.map(i => choices[i]?.text).filter(Boolean).join(', ');
                updateHUD(`Selected: ${chosenLabels.slice(0, 28)}...`, 'active', 3000);
            }
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    function queryGeminiForChoice(prompt, choices) {
        return new Promise((resolve, reject) => {
            const isMultiSelect = /select all|all that apply|which of the following|any of the following|choose all/i.test(prompt) ||
                                  (choices[0]?.input && choices[0].input.type === 'checkbox') ||
                                  (choices[0]?.target && choices[0].target.getAttribute('role') === 'checkbox');

            const choicesFormatted = choices.map((c, i) => `Option [${i}]: "${c.text}"`).join('\n');
            const userContent = `Survey Context / Question:\n${prompt}\n\nAvailable Options:\n${choicesFormatted}`;

            const systemInstruction = `${buildConsistencySystemPrefix()}You are an authentic adult participant completing a web survey.
Mode: ${isMultiSelect ? 'MULTI-SELECT (select all that apply; 1-2 realistic items for brand lists, exact matches for factual checks)' : 'SINGLE-SELECT (choose exactly 1 index)'}.
RULES:
1. Obey trap/attention-check instructions strictly (highest priority).
2. Stay strictly consistent with your persona and prior answers in this survey.
3. Avoid "Other"/"None"/"Don't know" when standard well-known brands are listed.
4. For rating/opinion scales (1-5, 1-10, agree/disagree, satisfaction), choose a realistic varied mid-to-positive rating (e.g. 6-9 on 1-10, 3-4 on 1-5) matching a genuine customer rather than defaulting to index 0.
5. Output strictly JSON with NO explanations or extra keys: {"selected": [<0-based index>]}`;

            const body = {
                contents: [{ parts: [{ text: userContent }] }],
                systemInstruction: { parts: [{ text: systemInstruction }] },
                generationConfig: {
                    temperature: 0.35,
                    maxOutputTokens: 80,
                    responseMimeType: "application/json"
                }
            };

            sendGeminiRequestWithRetry(body)
                .then((data) => {
                    const rawText = extractCandidateText(data);
                    if (!rawText) {
                        reject(new Error('Empty response from model.'));
                        return;
                    }

                    const parsed = parseModelJSON(rawText);
                    const rawIndices = Array.isArray(parsed.selected) ? parsed.selected : [parseInt(parsed.selected, 10)];
                    const validIndices = rawIndices.map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 0 && n < choices.length);
                    const sanitized = sanitizeMultiSelectIndices(validIndices, choices, extractMaxSelectionCap(prompt));
                    resolve(sanitized);
                })
                .catch(reject);
        });
    }

    async function movePointerWithTrajectory(targetX, targetY, hoverTarget) {
        if (abortRequested) return;
        const startX = (typeof mouseX === 'number' && !isNaN(mouseX)) ? mouseX : window.innerWidth * 0.4;
        const startY = (typeof mouseY === 'number' && !isNaN(mouseY)) ? mouseY : window.innerHeight * 0.5;
        const dist = Math.hypot(targetX - startX, targetY - startY);
        const steps = dist < 25 ? 2 : Math.min(8, Math.max(4, Math.round(dist / 140)));
        const arcOffset = (Math.random() - 0.5) * Math.min(34, dist * 0.14);
        const docTarget = hoverTarget || document.elementFromPoint(targetX, targetY) || document.body;

        for (let i = 1; i <= steps; i++) {
            if (abortRequested) return;
            const t = i / steps;
            const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const arc = Math.sin(t * Math.PI) * arcOffset;
            const px = Math.round((startX + (targetX - startX) * eased + arc * 0.5) * 10) / 10;
            const py = Math.round((startY + (targetY - startY) * eased + arc) * 10) / 10;
            mouseX = px;
            mouseY = py;
            const moveTarget = document.elementFromPoint(px, py) || docTarget;
            if (moveTarget && !isHudElement(moveTarget)) {
                try { moveTarget.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true, clientX: px, clientY: py })); } catch (e) {}
                try { moveTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: px, clientY: py })); } catch (e) {}
            }
            await abortableSleep(randomBetween(8, 18));
        }

        if (abortRequested || !docTarget) return;
        const hoverOpts = { bubbles: true, cancelable: true, composed: true, clientX: targetX, clientY: targetY };
        try { docTarget.dispatchEvent(new PointerEvent('pointerover', hoverOpts)); } catch (e) {}
        try { docTarget.dispatchEvent(new MouseEvent('mouseover', hoverOpts)); } catch (e) {}
        try { docTarget.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, hoverOpts, { bubbles: false }))); } catch (e) {}
        try { docTarget.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, hoverOpts, { bubbles: false }))); } catch (e) {}
        await abortableSleep(randomBetween(36, 86));
    }

    async function triggerNativeClick(target, input, label = null, desiredChecked = true) {
        if (abortRequested) return;
        const resolvedLabel = label || findLabelForInput(input);
        const primaryNode = resolvedLabel || target || input;
        if (!primaryNode) return;

        const preRect = primaryNode.getBoundingClientRect();
        const needsCenter = !input && (preRect.top < 70 || preRect.bottom > window.innerHeight - 90);
        primaryNode.scrollIntoView({ behavior: 'auto', block: needsCenter ? 'center' : 'nearest' });

        const rect = primaryNode.getBoundingClientRect();
        // Randomize click coordinates off exact geometric center within inner 50% of hit box
        const jitterX = (Math.random() - 0.5) * Math.max(0, Math.min(rect.width * 0.44, 48));
        const jitterY = (Math.random() - 0.5) * Math.max(0, Math.min(rect.height * 0.44, 14));
        const cx = rect.left + rect.width / 2 + jitterX;
        const cy = rect.top + rect.height / 2 + jitterY;

        const root = primaryNode.getRootNode ? primaryNode.getRootNode() : document;
        const pointFinder = typeof root.elementFromPoint === 'function' ? root : document;
        let hitEl = (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight)
            ? pointFinder.elementFromPoint(cx, cy)
            : null;
        if (hitEl && isHudElement(hitEl)) hitEl = null;

        let clickNode = (hitEl && (primaryNode === hitEl || primaryNode.contains(hitEl))) ? hitEl : primaryNode;
        if (!input && hitEl && hitEl !== clickNode) {
            const hitInteractive = (hitEl.getAttribute?.('tabindex') === '0' || window.getComputedStyle(hitEl).cursor === 'pointer');
            if ((target && (target === hitEl || target.contains(hitEl))) || hitInteractive) {
                clickNode = hitEl;
            }
        }
        if (typeof SVGElement !== 'undefined' && clickNode instanceof SVGElement) {
            clickNode = clickNode.closest('button, a, [role="button"], label, [tabindex]') || primaryNode;
        }
        if (!input && primaryNode.tagName === 'BUTTON') {
            clickNode = primaryNode;
        }
        await movePointerWithTrajectory(cx, cy, clickNode);
        if (abortRequested) return;

        const mouseOpts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };

        const fireEventsOn = async (node) => {
            if (!node || abortRequested) return;
            try { node.dispatchEvent(new PointerEvent('pointerdown', mouseOpts)); } catch (e) {}
            try { node.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch (e) {}
            if (typeof node.focus === 'function') {
                try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
            }
            await abortableSleep(randomBetween(42, 88));
            if (abortRequested) return;
            try { node.dispatchEvent(new PointerEvent('pointerup', mouseOpts)); } catch (e) {}
            try { node.dispatchEvent(new MouseEvent('mouseup', mouseOpts)); } catch (e) {}
            try {
                if (typeof node.click === 'function') {
                    node.click();
                } else {
                    node.dispatchEvent(new MouseEvent('click', mouseOpts));
                }
            } catch (e) {}
        };

        await fireEventsOn(clickNode);
        if (abortRequested) return;

        if (input && (input.type === 'radio' || input.type === 'checkbox')) {
            const wantChecked = input.type === 'radio' ? true : desiredChecked;
            if (wantChecked) {
                if (!input.checked) {
                    try { input.click(); } catch (e) {}
                }
                if (!input.checked) {
                    input.checked = true;
                    const tracker = input._valueTracker;
                    if (tracker) tracker.setValue(false);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));

                    const elementsToMark = [resolvedLabel, target, input].filter(Boolean);
                    for (const el of elementsToMark) {
                        if (el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', 'true');
                        if (el.classList.contains('q-radio') || el.classList.contains('q-checkbox') || el.tagName === 'LABEL') {
                            el.classList.add('q-checked');
                            if (el.classList.contains('p-radio-label') || el.classList.contains('p-checkbox-label')) {
                                el.classList.add('p-checked');
                            }
                        }
                    }
                }
            } else {
                if (input.checked) {
                    try { input.click(); } catch (e) {}
                }
                if (input.checked) {
                    input.checked = false;
                    const tracker = input._valueTracker;
                    if (tracker) tracker.setValue(true);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));

                    const elementsToUnmark = [resolvedLabel, target, input].filter(Boolean);
                    for (const el of elementsToUnmark) {
                        if (el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', 'false');
                        el.classList.remove('q-checked', 'p-checked');
                    }
                }
            }
        } else if (!input && target) {
            if (target !== clickNode && target.getAttribute('aria-checked') === 'false') {
                await fireEventsOn(target);
            } else {
                const uncheckedCtrl = target.querySelectorAll('[role="radio"][aria-checked="false"], [role="checkbox"][aria-checked="false"]');
                if (uncheckedCtrl.length === 1 && uncheckedCtrl[0] !== clickNode) {
                    await fireEventsOn(uncheckedCtrl[0]);
                }
            }
        }
    }

    async function executeSelectDropdown(selectEl, promptText) {
        const choices = getValidSelectChoices(selectEl);
        if (choices.length === 0) return;

        try {
            updateHUD('Selecting dropdown...', 'working');
            const selectedIndices = await queryGeminiForChoice(promptText, choices);
            if (abortRequested) return;

            if (!selectedIndices || selectedIndices.length === 0) return;

            const chosen = choices[selectedIndices[0]] || choices[0];
            await applySelectChoice(selectEl, chosen);
            recordSessionAnswer(promptText, chosen.text);
            updateHUD(`Selected: ${chosen.text.slice(0, 26)}`, 'active', 3000);
        } catch (err) {
            if (abortRequested) return;
            lastSolveHadError = true;
            updateHUD(`Error: ${err.message}`, 'error', 4500);
            console.error('[Gemini Typer]', err);
        }
    }

    function extractRowLabelForInput(input) {
        let curr = input.parentElement;
        for (let i = 0; i < 4 && curr && curr !== document.body; i++) {
            const labelEl = curr.querySelector('label, th, td:first-child, [class*="label" i], [class*="text" i], [class*="title" i], strong, b');
            if (labelEl && !labelEl.contains(input)) {
                const txt = (labelEl.innerText || '').replace(/\s+/g, ' ').trim();
                if (txt.length > 2 && txt.length < 200) return txt;
            }
            let prev = input.previousElementSibling;
            while (prev) {
                const txt = (prev.innerText || '').replace(/\s+/g, ' ').trim();
                if (txt.length > 2 && txt.length < 200) return txt;
                prev = prev.previousElementSibling;
            }
            curr = curr.parentElement;
        }
        return '';
    }

    function getMatrixColumnHeaderForCell(inp) {
        if (!inp) return '';
        const td = inp.closest('td, th');
        const tr = inp.closest('tr');
        const table = inp.closest('table');
        if (!td || !tr || !table) return '';

        let targetColStart = 0;
        for (const cell of Array.from(tr.children)) {
            if (window.getComputedStyle(cell).display === 'none') continue;
            if (cell === td) break;
            targetColStart += (cell.colSpan || 1);
        }

        const headerRows = [];
        for (const hRow of Array.from(table.querySelectorAll('thead tr, tr'))) {
            if (hRow === tr) break;
            if (window.getComputedStyle(hRow).display === 'none') continue;
            if (hRow.classList.contains('rowGroup') || hRow.querySelectorAll('th, td').length < 2) continue;
            headerRows.push(hRow);
        }
        // Prefer the most specific bottom-most header row above the data row (skipping broad colGroup banners first)
        for (let i = headerRows.length - 1; i >= 0; i--) {
            const hRow = headerRows[i];
            let cursor = 0;
            for (const hCell of Array.from(hRow.children)) {
                if (window.getComputedStyle(hCell).display === 'none') continue;
                const span = hCell.colSpan || 1;
                if (targetColStart >= cursor && targetColStart < cursor + span) {
                    const txt = (hCell.innerText || '').replace(/\s+/g, ' ').trim();
                    if (txt.length > 0 && txt.length < 120) return txt;
                    break;
                }
                cursor += span;
            }
        }
        return '';
    }

    function getLabelForInput(inp, resolvedLabel = null) {
        if (resolvedLabel && (resolvedLabel.innerText || '').trim()) {
            return resolvedLabel.innerText.trim();
        }
        const ariaLabelledBy = inp.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
            const root = inp.getRootNode ? inp.getRootNode() : document;
            const parts = ariaLabelledBy.trim().split(/\s+/).map(id => {
                const el = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
                return el ? (el.innerText || '').trim() : '';
            }).filter(Boolean);
            if (parts.length > 0) return parts.join(' ');
        }
        const directAria = (inp.getAttribute('aria-label') || inp.title || '').trim();
        if (directAria) return directAria;

        const colHeader = getMatrixColumnHeaderForCell(inp);
        if (colHeader) return colHeader;

        const cell = inp.closest('.cm-response-container, td, li, [class*="choice" i], [class*="option" i], [class*="item" i]');
        if (cell && cell.querySelectorAll('input[type="radio"], input[type="checkbox"]').length === 1) {
            const txt = (cell.innerText || '').trim();
            if (txt) return txt;
        }
        if (inp.id) {
            try {
                const root = inp.getRootNode ? inp.getRootNode() : document;
                const anyTextLbl = Array.from(root.querySelectorAll(`label[for="${CSS.escape(inp.id)}"]`))
                    .find(l => (l.textContent || '').trim().length > 0);
                if (anyTextLbl) return anyTextLbl.textContent.trim();
            } catch (e) {}
        }
        return '';
    }

    function extractPromptForSelect(selectEl, cachedInputs = null) {
        if (selectEl.id) {
            try {
                const root = selectEl.getRootNode ? selectEl.getRootNode() : document;
                const lbl = root.querySelector(`label[for="${CSS.escape(selectEl.id)}"]`);
                if (lbl && lbl.innerText.trim().length > 3) return lbl.innerText.trim();
            } catch (e) {}
        }
        const visualEl = getSelectVisualElement(selectEl);
        return extractPromptAboveGroup(visualEl, cachedInputs) || findPromptAboveElement(visualEl) || 'Select the most appropriate option';
    }

    function findPromptAboveElement(element) {
        let curr = element.parentElement;
        for (let i = 0; i < 4 && curr; i++) {
            const header = curr.querySelector('h1, h2, h3, h4, legend, .QuestionText, .question-text, [class*="instruction" i], p');
            if (header && !header.contains(element) && (header.innerText || '').trim().length > 6) {
                return header.innerText.trim();
            }
            curr = curr.parentElement;
        }
        return null;
    }

    function getActiveTarget() {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) {
            el = el.shadowRoot.activeElement;
        }
        if (!el || el === document.body || el === document.documentElement || isHudElement(el)) return null;
        if (el.isContentEditable || el.tagName === 'TEXTAREA') return el;
        if (el.tagName === 'INPUT') {
            const t = (el.type || 'text').toLowerCase();
            if (!['radio', 'checkbox', 'button', 'submit', 'reset', 'hidden', 'range', 'file', 'image'].includes(t)) {
                return el;
            }
        }
        return null;
    }

    function isClippedByHorizontalContainer(el, rect) {
        if (!el || !rect || rect.width <= 0 || rect.height <= 0) return false;
        let curr = el.parentElement;
        for (let i = 0; i < 7 && curr && curr !== document.body && curr !== document.documentElement; i++) {
            const st = window.getComputedStyle(curr);
            if (st.overflowX === 'hidden' || st.overflowX === 'clip') {
                const ar = curr.getBoundingClientRect();
                if (ar.width > 0 && (rect.right <= ar.left + 2 || rect.left >= ar.right - 2)) {
                    return true;
                }
            }
            curr = curr.parentElement;
        }
        return false;
    }

    function isElementVisible(el) {
        if (!el) return false;
        if (el.closest('[inert], .cf-carousel__content-item[aria-hidden="true"], .cf-carousel__item[aria-hidden="true"], [role="tabpanel"][aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const isNativeToggle = el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox');

        if (isNativeToggle) {
            if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0 && r.width >= 4 && r.height >= 4 && !isClippedByHorizontalContainer(el, r)) {
                return true;
            }
            const lbl = findLabelForInput(el);
            const firIcon = el.closest('td, th, .cell')?.querySelector('.fir-icon');
            const wrapper = el.closest('label, .cm-response-container, .cf-radio-answer, .cf-checkbox-answer, td.clickableCell, td, li, div');
            for (const container of [lbl, firIcon, wrapper]) {
                if (!container) continue;
                const cStyle = window.getComputedStyle(container);
                if (cStyle.display === 'none' || cStyle.visibility === 'hidden' || parseFloat(cStyle.opacity) === 0) continue;
                const cr = container.getBoundingClientRect();
                if (cr.width > 0 && cr.height > 0 && !isClippedByHorizontalContainer(container, cr)) return true;
            }
            return false;
        }

        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
        return r.width > 0 && r.height > 0 && !isClippedByHorizontalContainer(el, r);
    }

    function cleanOptionText(str) {
        return (str || '').replace(/\s+/g, ' ').replace(/^[*•\s()-]+/, '').trim();
    }

    function separateQuestionAndOptionLines(lines) {
        let questionText = '';
        let splitIdx = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const isQuestionOrInstruction =
                /\?|:$/.test(line) ||
                /^(which|what|how|who|where|when|why|please|select|choose|rate|do you|in the past|thinking about|to ensure|help us)/i.test(line) ||
                /all that apply|minimum \d+|characters/i.test(line);

            if (isQuestionOrInstruction && i < 3 && splitIdx === i) {
                questionText += (questionText ? ' ' : '') + line;
                splitIdx = i + 1;
            } else {
                break;
            }
        }

        const optionLines = (splitIdx > 0 && splitIdx < lines.length) ? lines.slice(splitIdx) : lines;
        return { questionText, optionLines };
    }

    function sanitizeChoices(choices, promptText) {
        const cleanPrompt = promptText.toLowerCase().replace(/[^a-z0-9]/g, '');
        const seenInputs = new Set();
        const results = [];

        for (const choice of choices) {
            const cleanText = choice.text.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!cleanText || cleanText.length < 1) continue;

            if (cleanPrompt.includes(cleanText) && cleanText.length > 20) continue;
            if (/\?$/.test(choice.text.trim()) && choice.text.length > 25) continue;

            if (choice.input) {
                if (seenInputs.has(choice.input)) continue;
                seenInputs.add(choice.input);
            }
            results.push(choice);
        }
        return results;
    }

    function resolveChoicesFromHighlightedLines(lines) {
        const results = [];
        const seenTexts = new Set();

        for (const line of lines) {
            const cleanLine = line.replace(/^[*•\s\d.)-]+/, '').trim();
            if (!cleanLine || seenTexts.has(cleanLine)) continue;

            const xpath = `//*[not(self::script) and not(self::style) and text()[contains(normalize-space(.), ${JSON.stringify(cleanLine)})]]`;
            const snapshot = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            let targetEl = null;

            for (let i = 0; i < snapshot.snapshotLength; i++) {
                const item = snapshot.snapshotItem(i);
                if (item.offsetParent === null || isHudElement(item)) continue;
                if (item.matches('h1, h2, h3, h4, legend, .QuestionText, .question-text, [class*="header" i], [class*="title" i]')) continue;
                targetEl = item;
                break;
            }

            if (targetEl) {
                const row = targetEl.closest('tr, li, label, .cell, [class*="choice" i], [class*="option" i], [class*="element" i], div');
                if (!row) continue;

                const inputElement = row.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], .fir-icon, .fir-checkbox');
                seenTexts.add(cleanLine);
                const clickTarget = targetEl.closest('label') || row || inputElement;
                results.push({ text: cleanLine, target: clickTarget, input: inputElement });
            }
        }
        return results;
    }

    function findQuestionHeaderNearRange() {
        const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend, .QuestionText, .question-text, [class*="title" i], [class*="instruction" i], [class*="header" i], p, div'))
            .filter(h => isElementVisible(h) && !isHudElement(h) && h.children.length <= 2);

        for (const h of candidates) {
            const txt = (h.innerText || '').replace(/\s+/g, ' ').trim();
            if (txt.length > 8 && txt.length < 400) {
                if (txt.includes('?') || txt.endsWith(':') || /^(please select|which of|how often|what is|rate the|select all|to ensure|help us|thinking about|in the past|please list)/i.test(txt)) {
                    return txt;
                }
            }
        }
        return null;
    }

    function readSelfHealLogs() {
        try {
            const raw = gmGet(GM_KEY_SELF_HEAL_LOGS, '');
            const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function formatSelfHealLogsText(logs) {
        if (!logs.length) return 'No self-heal AI recovery events logged yet.\n';
        return logs.map((entry, idx) => {
            return [
                `============================================================`,
                `[${idx + 1}] ${entry.timestamp || ''} | Outcome: ${entry.outcome || 'unknown'} | Trigger: ${entry.triggerReason || ''}`,
                `URL: ${entry.url || ''}`,
                `Title: ${entry.title || ''}`,
                `Clicked / Actions: ${JSON.stringify(entry.actionsTaken || [])}`,
                `--- SYSTEM PROMPT ---`,
                entry.systemPrompt || '',
                `--- USER PROMPT ---`,
                entry.userPrompt || '',
                `--- MODEL RAW RESPONSE ---`,
                entry.rawResponse || JSON.stringify(entry.parsedResponse || {}),
                ``
            ].join('\n');
        }).join('\n');
    }

    function exportSelfHealLogFile(notifyIfEmpty = false) {
        const logs = readSelfHealLogs();
        if (!logs.length) {
            if (notifyIfEmpty) updateHUD('No self-heal logs yet', 'info', 2500);
            return;
        }
        const text = formatSelfHealLogsText(logs);
        const filename = 'survey-solver-selfheal-log.txt';
        try {
            if (typeof GM_download === 'function') {
                const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
                GM_download({
                    url: dataUrl,
                    name: filename,
                    saveAs: false,
                    conflictAction: 'overwrite',
                    onerror: () => {
                        try {
                            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = filename;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 4000);
                        } catch (e) {}
                    }
                });
                return;
            }
        } catch (e) {}
        try {
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body?.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        } catch (e) {}
    }

    function saveSelfHealLogEntry(entry, downloadFile = false) {
        try {
            const logs = readSelfHealLogs();
            logs.push(entry);
            gmSet(GM_KEY_SELF_HEAL_LOGS, JSON.stringify(logs.slice(-30)));
        } catch (e) {}
        if (downloadFile) {
            exportSelfHealLogFile(false);
        }
    }

    function collectLastResortCandidates(roots) {
        const raw = queryAllInRoots(
            roots,
            'button, a, input:not([type="hidden"]), select, textarea, [role="button"], [role="radio"], [role="checkbox"], [role="option"], [role="link"], [tabindex]:not([tabindex="-1"]), [onclick], .__flexgrid_row > div, ._rowpicker [tabindex="0"], [class*="choice" i], [class*="option" i]'
        );
        // Also pick up visible pointer elements inside main survey containers (custom JS cards/buttons)
        const pointerEls = queryAllInRoots(roots, 'form div, main div, .question div, .answers div, [class*="flexgrid" i] div');
        for (const el of pointerEls) {
            if (!el || isHudElement(el) || !isElementVisible(el)) continue;
            if (window.getComputedStyle(el).cursor === 'pointer') raw.push(el);
        }

        const rejectUtilRx = /\b(privacy|terms(?:\s+of\s+use)?|cookie|accessibility|support|help|logout|log\s*out|sign\s*out|back|previous|goback|go\s*back|step\s*back)\b/i;
        const candidates = [];
        const seen = new Set();

        for (const el of raw) {
            if (!el || seen.has(el) || !isElementVisible(el) || isHudElement(el)) continue;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            if (el.closest('header, nav, footer, [role="banner"], [role="contentinfo"]') && !el.closest('form')) continue;

            const r = el.getBoundingClientRect();
            if (r.width < 12 || r.height < 12 || r.height > 320 || r.width > window.innerWidth * 0.98) continue;

            // Avoid bloated wrapper containers holding multiple distinct sub-buttons
            const nestedActionCount = el.querySelectorAll('button, input:not([type="hidden"]), a[href], [role="button"], [role="radio"], [role="checkbox"]').length;
            if (nestedActionCount > 1) continue;

            const tag = el.tagName;
            const role = el.getAttribute('role') || '';
            const type = (el.getAttribute('type') || el.type || '').toLowerCase();
            const text = (
                el.innerText ||
                el.value ||
                el.getAttribute('aria-label') ||
                el.title ||
                el.alt ||
                ''
            ).replace(/\s+/g, ' ').trim();
            const parentText = (!text && el.parentElement)
                ? (el.parentElement.innerText || '').replace(/\s+/g, ' ').trim()
                : '';
            const labelText = (text || parentText).slice(0, 110);
            const sigText = `${labelText} ${el.id || ''} ${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''}`;
            if (rejectUtilRx.test(sigText)) continue;
            if (!labelText && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && !el.id && !el.getAttribute('onclick')) continue;

            // Deduplicate wrappers that share the exact same rect/text, keeping the most specific clickable element
            const existingIdx = candidates.findIndex(c =>
                (c.el.contains(el) || el.contains(c.el)) &&
                c.labelText === labelText
            );
            if (existingIdx !== -1) {
                const prev = candidates[existingIdx].el;
                const elMoreSpecific = (el.getAttribute('tabindex') === '0' && window.getComputedStyle(el).cursor === 'pointer') ||
                    (prev.contains(el) && (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' || role === 'button'));
                if (!elMoreSpecific) continue;
                candidates.splice(existingIdx, 1);
            }

            seen.add(el);
            const input = (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') ? el : (el.querySelector('input, select, textarea') || null);
            const cls = (typeof el.className === 'string' ? el.className : '').trim().slice(0, 40);
            const desc = `[${candidates.length}] <${tag.toLowerCase()}${type ? `:${type}` : ''}${role ? ` role=${role}` : ''}> text="${labelText}"${el.id ? ` id="${el.id}"` : ''}${cls ? ` class="${cls}"` : ''} rect=(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)})`;
            candidates.push({ el, input, labelText, desc });
            if (candidates.length >= 40) break;
        }
        return candidates;
    }

    async function attemptLastResortAiNavigation(triggerReason, roots, blocks, pageSig) {
        if (abortRequested || !autoFarmActive || document.hidden || isOfferWallPage(roots)) return false;
        if (detectEndOfSurveyPage(roots) || detectBlockingCaptcha(roots, blocks.length > 0)) return false;
        if (!pageSig || selfHealTriedSigs.has(pageSig)) return false;

        try {
            const rawPrev = gmGet(GM_KEY_SELF_HEAL_TRY, '');
            const prev = rawPrev ? (typeof rawPrev === 'string' ? JSON.parse(rawPrev) : rawPrev) : null;
            if (prev && prev.sig === pageSig && prev.url === location.href && (Date.now() - (prev.ts || 0)) < 45000) {
                return false;
            }
            gmSet(GM_KEY_SELF_HEAL_TRY, JSON.stringify({ sig: pageSig, url: location.href, ts: Date.now() }));
        } catch (e) {}
        selfHealTriedSigs.add(pageSig);

        const candidates = collectLastResortCandidates(roots);
        if (candidates.length === 0) return false;

        const alerts = queryAllInRoots(roots, '[role="alert"], .question-error, .hasError, .error, .invalid-feedback')
            .filter(el => isElementVisible(el) && !isHudElement(el))
            .map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 4)
            .join(' | ');
        const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
        const userPrompt = [
            `Trigger: ${triggerReason}`,
            `URL: ${location.href}`,
            `Title: ${document.title}`,
            alerts ? `Visible Errors/Alerts: ${alerts}` : '',
            `Page Text Snippet:\n${pageText}`,
            `Interactive Elements:\n${candidates.map(c => c.desc).join('\n')}`
        ].filter(Boolean).join('\n\n');

        const systemPrompt = `${buildConsistencySystemPrefix()}You are a last-resort UI recovery agent for a survey runner that is stuck or missing a detected question/Next button.
Analyze the page text, any visible error alerts, and the numbered interactive elements.
Decide the exact element index (or short ordered sequence of up to 3 indices, e.g. answer option then Next/Submit) to click — or text to type into an input — to progress forward in the survey.
RULES:
1. NEVER click footer Help/Privacy/Terms links, cookie settings, or Back/Cancel/Logout buttons.
2. If an error alert asks to fix an answer (or an unanswered choice option blocks Submit/Next), click the valid option first and then the forward/Submit button if present.
3. If there is genuinely no survey action possible (blank spinner / end page / captcha), set "action": "none".
4. Output strictly JSON: {"action":"click"|"type"|"none","indices":[<0-based ints>],"text":"<only if action=type>","reason":"<brief reason>"}`;

        updateHUD('AI fallback: inspecting...', 'working');
        let rawResponse = '';
        let parsed = null;
        try {
            const data = await sendGeminiRequestWithRetry({
                contents: [{ parts: [{ text: userPrompt }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { temperature: 0.15, maxOutputTokens: 220, responseMimeType: 'application/json' }
            });
            rawResponse = extractCandidateText(data) || '';
            parsed = parseModelJSON(rawResponse || '{}');
        } catch (err) {
            saveSelfHealLogEntry({
                timestamp: new Date().toISOString(),
                triggerReason,
                url: location.href,
                title: document.title,
                systemPrompt,
                userPrompt,
                rawResponse: err?.message || 'API error',
                parsedResponse: null,
                actionsTaken: [],
                outcome: 'error'
            }, false);
            return false;
        }

        if (abortRequested || !autoFarmActive) return false;
        const action = String(parsed?.action || 'none').toLowerCase();
        const indices = Array.isArray(parsed?.indices)
            ? parsed.indices.map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 0 && n < candidates.length).slice(0, 3)
            : [];

        const actionsTaken = [];
        if (action === 'type' && indices.length > 0 && typeof parsed?.text === 'string' && parsed.text.trim()) {
            const targetCand = candidates[indices[0]];
            const inp = targetCand.input || targetCand.el;
            await executeTextTypingWithValue(inp, parsed.text.trim());
            actionsTaken.push({ index: indices[0], type: 'type', desc: targetCand.desc, text: parsed.text.trim() });
            if (indices.length > 1) {
                for (const idx of indices.slice(1)) {
                    const nextCand = candidates[idx];
                    if (nextCand) {
                        await triggerNativeClick(nextCand.el, nextCand.input, null);
                        actionsTaken.push({ index: idx, type: 'click', desc: nextCand.desc });
                        await abortableSleep(pickRangeDelay(SPD.betweenClicks));
                    }
                }
            }
        } else if (action === 'click' && indices.length > 0) {
            for (const idx of indices) {
                if (abortRequested) break;
                const cand = candidates[idx];
                if (!cand || !cand.el?.isConnected) continue;
                actionsTaken.push({ index: idx, type: 'click', desc: cand.desc });
                await triggerNativeClick(cand.el, cand.input, null);
                await abortableSleep(pickRangeDelay(SPD.betweenClicks));
            }
        }

        let outcome = 'none';
        if (actionsTaken.length > 0) {
            const changed = await waitForPageTransition(pageSig, 3500, location.href);
            outcome = changed ? 'advanced' : 'attempted_no_transition';
            if (changed) {
                updateHUD('AI self-healed! (logged)', 'active', 3500);
            }
        }

        saveSelfHealLogEntry({
            timestamp: new Date().toISOString(),
            triggerReason,
            url: location.href,
            title: document.title,
            systemPrompt,
            userPrompt,
            rawResponse,
            parsedResponse: parsed,
            actionsTaken,
            outcome
        }, outcome === 'advanced' || actionsTaken.length > 0);

        return outcome === 'advanced';
    }

    async function executeTextTypingWithValue(el, textVal) {
        if (!el || abortRequested) return;
        const val = String(textVal || '').trim();
        if (!val) return;
        el.scrollIntoView({ behavior: 'auto', block: 'nearest' });
        try { el.focus(); } catch (e) {}
        if (el.isContentEditable) {
            el.textContent = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function callGeminiJSON(userPrompt, systemPrompt, maxOutputTokens = 400) {
        const body = {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: maxOutputTokens,
                responseMimeType: 'application/json'
            }
        };

        return sendGeminiRequestWithRetry(body).then((data) => {
            const raw = extractCandidateText(data);
            return parseModelJSON(raw || '{}');
        });
    }

    // Auto-resume Auto-Farm across full page navigations and cross-origin survey redirects within the same tab
    const bootFarmMode = readAutoFarmFlag();
    if (bootFarmMode && subFrameActivated && !autoFarmActive && !autoFarmLoopRunning) {
        startAutoFarm(bootFarmMode);
    }
})();
