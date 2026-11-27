// ==============================================
// ==============================================
// ARTHEIM - STUDENT SCRIPT
// COMPLETE OPTIMIZED VERSION
// ==============================================
// ==============================================
// ---- Force re-login on version bump ----
// Bump this string to log out every student on their next page load.
// Format: any unique string; I like "<release-date>-<n>".
const SESSION_VERSION = "2026-11-23-1";
(function enforceSessionVersion() {
    try {
        const stored = localStorage.getItem("appSessionVersion");
        if (stored === SESSION_VERSION) return;

        // Version changed → drop the Supabase auth token + local caches.
        // We do NOT clear unrelated keys (they may hold e.g. UI prefs).
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            // Supabase token key is `sb-<project-ref>-auth-token`
            // Local app data keys we own:
            const ownedKeys = [
                "completedQuests", "questGrades", "questAccepted",
                "questStartTimes", "studentWorks", "earnedBadges",
                "selfAssessments", "expTotal", "expLog",
                "studentProfile", "cachedQuests",
                "cachedQuestsVersion", "cachedQuestsTimestamp",
                "rubricLocked", "pendingSelfAssessmentQuest"
            ];
            if (k.startsWith("sb-") || ownedKeys.includes(k)) {
                keysToRemove.push(k);
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        localStorage.setItem("appSessionVersion", SESSION_VERSION);

        // Also drop the in-memory Supabase session (best-effort).
        // We don't await it — a reload is coming.
        if (window.supabase?.auth?.signOut) {
            window.supabase.auth.signOut().catch(() => {});
        }

        // Reload so every module reinitializes with an empty session.
        // Use replace() so the back button doesn't skip the reload.
        location.replace(location.pathname);
    } catch (e) {
        console.warn("[session] version enforcement failed:", e);
    }
})();
// ==============================================
// SECTION 1: GLOBAL STATE & CACHE MANAGEMENT
// ==============================================

// --- Global State Object (NEW - For caching) ---
const AppState = {
    studentData: {
        completedQuests: null,
        questGrades: null,
        questAccepted: null,
        questStartTimes: null,
        earnedBadges: null,
        interestState: null,
        loaded: false,
        lastLoadTime: null
    },
    teacherData: {
        customTimers: {},
        classDuration: 75,
        loaded: false,
        requiredQuests: [],           
        requiredQuestsLoaded: false   
    },
    questRelationships: {
        leadsTo: {},
        prerequisites: {}
    },
    relationshipsBuilt: false
};

// --- Teacher Data Cache (framework, teacherId, name, selected standards) ---
const TeacherCache = {
    framework: null,          // 'ncas' | 'ib-myp' | 'igcse'
    teacherId: null,          // teacher UUID
    teacherName: null,        // teacher display name
    classDuration: null,      // minutes per class (from class_settings)
    selectedStandards: {},    // questId -> [standardCode, ...]  (null means "none set")
    loaded: false             // true once framework+teacherId are resolved
};

function invalidateTeacherCache() {
    TeacherCache.framework = null;
    TeacherCache.teacherId = null;
    TeacherCache.teacherName = null;
    TeacherCache.classDuration = null;
    TeacherCache.selectedStandards = {};
    TeacherCache.loaded = false;
}

// --- Original Global Variables ---
let isAddingHotspots = false;
let rubricLocked = {};
let completedQuests = loadQuestData();
let questGrades = loadQuestGrades() || {};
let currentQuestId = null;
let scale = 1;
let quests = {};
let questTimers = {};
let questStartTimes = loadQuestStartTimes();
let questAccepted = loadQuestAccepted();
let studentWorks = loadStudentWorks();
let hotspotPositions = {};
let activeQuestId = null;
let badgesData = null;
let earnedBadges = loadEarnedBadges();
let isSaving = false;
let isLoadingFromCloud = false;
let currentTeacherName = null;
let currentTeacherFramework = 'ncas';
let pathfinderQuestions = null;
let allMVPQuests = null;
let currentPathfinderAnswers = {};
let helpModal = null;
let helpBtn = null;
let closeBtn = null;
let realtimeSubscription = null;
let currentUserId = null;
let cachedQuests = null;
let cachedCustomTimer = null;
let cachedClassDuration = null;
let cachedTimerQuestId = null;
let _lastDisplayedTime = '';
let _lastActiveQuestId = null;
let _animationFrameId = null;
let _pendingInterestWrite = false;
let isSavingWork = false;
let _lastUpdateTime = 0;
const QUEST_CACHE_VERSION = '2026-05-25-v1';
const QUEST_CACHE_KEY = 'cachedQuests';
const QUEST_CACHE_VERSION_KEY = 'cachedQuestsVersion';
const QUEST_CACHE_TIMESTAMP_KEY = 'cachedQuestsTimestamp';
const QUEST_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;
let cachedScheduleData = {
    noClassDays: [],
    weekendSettings: { saturday_is_class: false, sunday_is_class: false },
    frequencyDays: []
};
let currentContestForSubmission = null;

// --- EXP SYSTEM STATE ---
let expTotal = 0;
let expLog = {};              // { "quest:quest42": 50, "badge:master_perspective": 100, ... }
let _expSaveDebounce = null;

const EXP_RULES = {
    FORMATIVE_COMPLETE:    30,
    SUMMATIVE_COMPLETE:   120,
    VOTE:                  15,
    SUBMIT_ART_BATTLE:     40,
    COMMENT:                5,
    BADGE_UNLOCKED:       70,   // first Quest Completer tier
    BADGE_TIER_2:         120,   // Quest Completer II
    BADGE_TIER_3:         200,   // Quest Completer III
    FIRST_UPLOAD_OF_WEEK:  7,
    EXTRA_UPLOAD_SAME_WEEK: 3,
    ALL_STANDARDS_HIGH:     5,   // every self-assessed standard ≥ 3.5
    BEFORE_TIME_FORMATIVE:  5,
    BEFORE_TIME_SUMMATIVE: 20,
    GIFT_FORMATIVE:        15,
    GIFT_SUMMATIVE:        50
};


window.raceJitterInterval = null;

// --- Cache Invalidation Functions (NEW) ---
function invalidateStudentDataCache() {
    AppState.studentData.loaded = false;
    AppState.studentData.lastLoadTime = null;
}

function invalidateTeacherDataCache() {
    AppState.teacherData.loaded = false;
    AppState.teacherData.customTimers = {};
}

function invalidateAllCaches() {
    invalidateStudentDataCache();
    invalidateTeacherDataCache();
    invalidateTeacherCache();
}

// ==============================================
// SECTION 1b: SUPABASE AUTH GUARD
// ==============================================
// Wraps any Supabase write so that an expired JWT is refreshed
// transparently, then the write is retried exactly once.
//
// Usage:
//   const { error } = await guardAuth(() =>
//       window.supabase.from('student_progress').update({...}).eq('user_id', id)
//   );
//
// The callback must return a Supabase thenable (the result of .update(),
// .upsert(), .insert(), .delete(), or .select()).

async function guardAuth(callback) {
    let result = await callback();

    const isAuthError =
        result?.error &&
        (
            result.error.code === 'PGRST303' ||
            result.error.code === 'PGRST301' ||
            /jwt/i.test(result.error.message || '') ||
            result.status === 401
        );

    if (!isAuthError) return result;



    const { error: refreshError } = await window.supabase.auth.refreshSession();
    if (refreshError) {

        return result; // give up, return the original error
    }

    // Retry exactly once with the refreshed token
    result = await callback();

    if (result?.error) {

    } else {
    }
    return result;
}

// Proactive refresh: if the session is close to expiring (within 60s),
// refresh it before we even attempt a write.
async function ensureFreshSession() {
    try {
        const { data: { session } } = await window.supabase.auth.getSession();
        if (!session) return false;

        const expiresAt = session.expires_at * 1000; // → ms
        const msUntilExpiry = expiresAt - Date.now();

        if (msUntilExpiry > 60_000) return true; // still fresh


        const { error } = await window.supabase.auth.refreshSession();
        if (error) {

            return false;
        }
        return true;
    } catch (e) {

        return false;
    }
}
// ==============================================
// SECTION 2: QUEST RELATIONSHIP BUILDER (NEW)
// ==============================================

function buildQuestRelationships() {
    if (AppState.relationshipsBuilt && Object.keys(AppState.questRelationships.leadsTo).length > 0) {
        return; // Already built
    }
    

    const questKeys = Object.keys(quests);
    
    // Reset
    AppState.questRelationships.leadsTo = {};
    AppState.questRelationships.prerequisites = {};
    
    for (const questId of questKeys) {
        const quest = quests[questId];
        if (!quest) continue;
        
        // Store prerequisites
        if (quest.prerequisites && quest.prerequisites.length) {
            AppState.questRelationships.prerequisites[questId] = quest.prerequisites;
            
            // Build reverse lookup (leads to)
            for (const prereqId of quest.prerequisites) {
                if (!AppState.questRelationships.leadsTo[prereqId]) {
                    AppState.questRelationships.leadsTo[prereqId] = [];
                }
                if (!AppState.questRelationships.leadsTo[prereqId].includes(questId)) {
                    AppState.questRelationships.leadsTo[prereqId].push(questId);
                }
            }
        } else {
            AppState.questRelationships.prerequisites[questId] = [];
        }
    }
    
    AppState.relationshipsBuilt = true;

}

// ==============================================
// SECTION 3: PREVENT HTML MISTAKES BY TEACHERS
// ==============================================

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ==============================================
// SECTION 4: STANDARD/DOMAIN NAMES
// ==============================================

const STANDARD_NAMES = {
    "Art.FA.CR.1.1.IA": "Generate: Conceptualize artistic ideas",
    "Art.FA.CR.1.2.IA": "Practice: Organize and develop ideas",
    "Art.FA.CR.2.1.IA": "Explore: Refine artistic work",
    "Art.FA.CR.2.3.IA": "Transform: Document creative process",
    "Art.FA.CR.3.1.IA": "Reflect: Reflect on artistic process",
    "Art.FA.PR.6.1.IA": "Analyze: Convey meaning through presentation",
    "Art.FA.RE.8.1.8A": "Interpret: Interpret intent and meaning",
    "Art.FA.CN.10.1.IA": "Document: Synthesize and relate knowledge"
};
const STANDARD_SHORT_NAMES = {
    "Art.FA.CR.1.1.IA": "Generate",
    "Art.FA.CR.1.2.IA": "Practice",
    "Art.FA.CR.2.1.IA": "Explore",
    "Art.FA.CR.2.3.IA": "Transform",
    "Art.FA.CR.3.1.IA": "Reflect",
    "Art.FA.PR.6.1.IA": "Analyze",
    "Art.FA.RE.8.1.8A": "Interpret",
    "Art.FA.CN.10.1.IA": "Document"
};
const IB_CRITERIA_MAPPING = {
    "A": {
        name: "A: Knowing & Understanding",
        ncasStandards: ["Art.FA.CN.10.1.IA", "Art.FA.PR.6.1.IA"]
    },
    "B": {
        name: "B: Developing Skills", 
        ncasStandards: ["Art.FA.CR.1.2.IA", "Art.FA.CR.2.1.IA", "Art.FA.CR.2.3.IA"]
    },
    "C": {
        name: "C: Thinking Creatively",
        ncasStandards: ["Art.FA.CR.1.1.IA"]
    },
    "D": {
        name: "D: Responding",
        ncasStandards: ["Art.FA.CR.3.1.IA", "Art.FA.RE.8.1.8A"]
    }
};
const IB_BANDS = {
    "7-8": "Excellent (7-8)",
    "5-6": "Good (5-6)", 
    "3-4": "Satisfactory (3-4)",
    "1-2": "Limited (1-2)"
};
const IGCSE_MAPPING = {};

// ==============================================
// SECTION 5: ACTIVE QUEST FLOATING BUTTON
// ==============================================

function updateActiveQuestButton(timestamp) {
    if (document.hidden) {
        _animationFrameId = requestAnimationFrame(updateActiveQuestButton);
        return;
    }
    
    if (timestamp && timestamp - _lastUpdateTime < 1000) {
        _animationFrameId = requestAnimationFrame(updateActiveQuestButton);
        return;
    }
    _lastUpdateTime = timestamp || Date.now();
    
    const button = document.getElementById('floating-active-quest');
    const timerSpan = document.getElementById('active-quest-timer');
    
    if (!button || !timerSpan) {
        _animationFrameId = requestAnimationFrame(updateActiveQuestButton);
        return;
    }
    
    let activeQuestId = null;
    for (const [questId, isAccepted] of Object.entries(questAccepted)) {
        if (isAccepted === true && !completedQuests[questId]) {
            activeQuestId = questId;
            break;
        }
    }
    
    if (!activeQuestId) {
        if (button.style.display !== 'none') {
            button.style.display = 'none';
        }
        if (_animationFrameId) {
            cancelAnimationFrame(_animationFrameId);
            _animationFrameId = null;
        }
        return;
    }
    
    button.style.display = 'flex';
    button.dataset.questId = activeQuestId;
    
    const remaining = calculateRemainingMinutes(activeQuestId);
    const quest = quests[activeQuestId];
    
    let totalMinutes = quest?.timer?.allottedMinutes || 75;
    const customTimer = getCustomTimerForQuestSync(activeQuestId);
    const classDuration = getClassDurationSync();
    if (customTimer !== null) {
        totalMinutes = customTimer * classDuration;
    }
    
    let timeString;
    let warningClass = '';
    let timesUpClass = '';
    
    if (remaining <= 0) {
        timeString = '⏰ TIME UP!';
        timesUpClass = 'times-up';
    } else if ((remaining / totalMinutes) * 100 <= 30) {
        timeString = formatTime(remaining, true);
        warningClass = 'warning';
    } else {
        timeString = formatTime(remaining, true);
    }
    
    if (timeString !== _lastDisplayedTime) {
        timerSpan.textContent = timeString;
        _lastDisplayedTime = timeString;
    }
    
    button.classList.remove('warning', 'times-up');
    if (timesUpClass) button.classList.add(timesUpClass);
    if (warningClass) button.classList.add(warningClass);
    
    _animationFrameId = requestAnimationFrame(updateActiveQuestButton);
}

function setupActiveQuestButton() {
    const button = document.getElementById('floating-active-quest');
    if (!button) return;
    
    const newButton = button.cloneNode(true);
    button.parentNode.replaceChild(newButton, button);
    
    newButton.addEventListener('click', function() {
        const questId = this.dataset.questId;
        if (questId) {
            const questOverlay = document.getElementById('quest-overlay');
            if (questOverlay) questOverlay.style.display = 'none';
            openQuest(questId);
        }
    });
}

function startActiveQuestTimerUpdates() {
    if (_animationFrameId) {
        cancelAnimationFrame(_animationFrameId);
        _animationFrameId = null;
    }
    _lastDisplayedTime = '';
    _lastUpdateTime = 0;
    updateActiveQuestButton(Date.now());
}

function stopActiveQuestTimerUpdates() {
    if (_animationFrameId) {
        cancelAnimationFrame(_animationFrameId);
        _animationFrameId = null;
    }
    _lastDisplayedTime = '';
}

// ==============================================
// SECTION 6: LOCAL STORAGE HELPERS
// ==============================================

function loadEarnedBadges() {
    const data = localStorage.getItem("earnedBadges");
    return data ? JSON.parse(data) : {};
}

function saveEarnedBadges() {
    localStorage.setItem("earnedBadges", JSON.stringify(earnedBadges));
}

function loadStudentWorks() {
    const data = localStorage.getItem("studentWorks");
    if (data) {
        try {
            return JSON.parse(data);
        } catch (e) {

            return {};
        }
    }
    return {};
}

function saveStudentWorks() {
    localStorage.setItem("studentWorks", JSON.stringify(studentWorks));
}

// ==============================================
// SECTION 7: WORK OVERLAY SYSTEM
// ==============================================

function handlePreviewClick(e) {
    e.stopPropagation();
    const preview = document.getElementById("image-preview");
    if (!preview || !preview.src || preview.src === "") return;
    const overlay = document.getElementById("work-overlay");
    const questId = overlay?.dataset.questId;
    if (questId && studentWorks[questId]) {
        const work = studentWorks[questId];
        const quest = quests[questId];
        openFullscreenFromWork(work, quest);
    } else {
        openFullscreenImageSimple(preview.src);
    }
}
// ==============================================
// WORK OVERLAY — UI STATE MACHINE
// ==============================================

// Snapshot of the form state when the overlay opens.
// Used to decide "is the form dirty?" (Rule Y).
let _workOverlaySnapshot = null;

/**
 * Read the current state of the overlay and update:
 *   - preview image visibility
 *   - PDF status line
 *   - Save button enabled/disabled
 *   - Delete-image / Delete-PDF / Delete-all enabled/disabled
 */
function updateWorkOverlayUI() {
    const overlay = document.getElementById("work-overlay");
    if (!overlay) return;
    const questId = overlay.dataset.questId;
    if (!questId) return;

    // --- Current file inputs ---
    const imageInput = document.getElementById("work-image");
    const pdfInput = document.getElementById("work-research-pdf");
    const pickedImage = imageInput?.files?.[0] || null;
    const pickedPdf = pdfInput?.files?.[0] || null;

    // --- Saved work (from local cache) ---
    const saved = studentWorks[questId] || null;
    const savedImageUrl = saved?.image && saved.image !== "pending" ? saved.image : null;
    const savedPdfUrl = saved?.research_pdf_url || null;
    const savedPdfName = saved?.research_pdf_name || null;

    // --- Current text fields ---
    const title = document.getElementById("work-title")?.value.trim() || "";
    const size = document.getElementById("work-size")?.value.trim() || "";
    const media = document.getElementById("work-media")?.value.trim() || "";
    const description = document.getElementById("work-description")?.value.trim() || "";

    // --- Quest info (for MVP description rule) ---
    const quest = quests[questId];
    const isMVP = quest?.style === "mvp";

    // ----------------------------------------------------------------
    // 1. PREVIEW IMAGE
    // ----------------------------------------------------------------
    const preview = document.getElementById("image-preview");
    if (preview) {
        if (pickedImage) {
            // Newly picked file preview (live)
            const reader = new FileReader();
            reader.onload = (e) => {
                preview.src = e.target.result;
                preview.style.display = "block";
            };
            reader.readAsDataURL(pickedImage);
        } else if (savedImageUrl) {
            preview.src = savedImageUrl;
            preview.style.display = "block";
        } else {
            preview.src = "";
            preview.style.display = "none";
        }
    }

    // ----------------------------------------------------------------
    // 2. PDF STATUS LINE
    // ----------------------------------------------------------------
    const pdfStatus = document.getElementById("work-pdf-status");
    if (pdfStatus) {
        if (pickedPdf) {
            // Newly picked (not yet saved)
            const sizeKb = (pickedPdf.size / 1024).toFixed(1);
            pdfStatus.innerHTML = `📎 Selected: ${escapeHtml(pickedPdf.name)} (${sizeKb} KB)`;
            pdfStatus.style.display = "block";
        } else if (savedPdfUrl) {
            // Saved on the server
            pdfStatus.innerHTML = `📄 Current research: <a href="${savedPdfUrl}" target="_blank">${escapeHtml(savedPdfName || "research.pdf")}</a>`;
            pdfStatus.style.display = "block";
        } else {
            pdfStatus.innerHTML = "";
            pdfStatus.style.display = "none";
        }
    }

    // ----------------------------------------------------------------
    // 3. DELETE BUTTONS
    // ----------------------------------------------------------------
    const delImageBtn = document.getElementById("delete-image-btn");
    const delPdfBtn = document.getElementById("delete-pdf-btn");
    const delAllBtn = document.getElementById("delete-all-btn");

    if (delImageBtn) delImageBtn.disabled = !(pickedImage || savedImageUrl);
    if (delPdfBtn) delPdfBtn.disabled = !(pickedPdf || savedPdfUrl);
    if (delAllBtn) delAllBtn.disabled = !(savedImageUrl || savedPdfUrl);

    // ----------------------------------------------------------------
    // 4. SAVE BUTTON
    // ----------------------------------------------------------------
    // Rule X (never saved): enable when title+size+media+image are all present,
    //                       plus description if quest is MVP.
    // Rule Y (something saved): enable only when the form is dirty.
    const saveBtn = document.querySelector(".save-work");

    const hasAnySaved = !!(savedImageUrl || savedPdfUrl || saved?.title || saved?.description);

    let shouldEnableSave = false;

    if (!hasAnySaved) {
        // Rule X — brand-new work
        const hasImage = !!(pickedImage || savedImageUrl);
        const baseValid = title && size && media && hasImage;
        const descriptionValid = isMVP ? description.length > 0 : true;
        shouldEnableSave = baseValid && descriptionValid;
    } else {
        // Rule Y — dirty check
        const snap = _workOverlaySnapshot;
        const isDirty =
            !snap ||
            pickedImage !== snap.pickedImage ||
            pickedPdf !== snap.pickedPdf ||
            title !== snap.title ||
            size !== snap.size ||
            media !== snap.media ||
            description !== snap.description;

        // Even when dirty, the form must still be valid
        const hasImage = !!(pickedImage || savedImageUrl);
        const baseValid = title && size && media && hasImage;
        const descriptionValid = isMVP ? description.length > 0 : true;

        shouldEnableSave = isDirty && baseValid && descriptionValid;
    }

    if (saveBtn) saveBtn.disabled = !shouldEnableSave;
}

/**
 * Snapshot the current overlay state — called when the overlay opens
 * and after a successful save.
 */
function snapshotWorkOverlay() {
    const overlay = document.getElementById("work-overlay");
    if (!overlay) return;
    const questId = overlay.dataset.questId;

    const imageInput = document.getElementById("work-image");
    const pdfInput = document.getElementById("work-research-pdf");

    _workOverlaySnapshot = {
        questId,
        pickedImage: imageInput?.files?.[0] || null,
        pickedPdf: pdfInput?.files?.[0] || null,
        title: document.getElementById("work-title")?.value.trim() || "",
        size: document.getElementById("work-size")?.value.trim() || "",
        media: document.getElementById("work-media")?.value.trim() || "",
        description: document.getElementById("work-description")?.value.trim() || ""
    };
}

async function saveWorkData() {
    // Prevent multiple simultaneous saves
    if (isSavingWork) {

        return;
    }

    const overlay = document.getElementById("work-overlay");
    const questId = overlay.dataset.questId;

    if (!questId) {
        alert("Error: No quest associated with this work.");
        return;
    }

    // ---- DECLARATIONS FIRST (before any use) ----
    const title = document.getElementById("work-title").value;
    const size = document.getElementById("work-size").value;
    const media = document.getElementById("work-media").value;
    const description = document.getElementById("work-description").value;
    const imageInput = document.getElementById("work-image");
    const imageFile = imageInput.files[0];
    const pdfInput = document.getElementById("work-research-pdf");
    const pdfFile = pdfInput ? pdfInput.files[0] : null;

    // ---- Confirm-replace block (only when a NEW image is picked) ----
    if (imageFile && studentWorks[questId] && studentWorks[questId].image && studentWorks[questId].image !== "pending") {
        const confirmResave = confirm("You have selected a new image. This will replace your saved artwork. Continue?");
        if (!confirmResave) {
            return;
        }

        // Since the work is being replaced, clear the old self-assessment
        localStorage.removeItem('pendingSelfAssessment_' + questId);
        localStorage.removeItem('pendingSelfAssessmentQuest');

        // Clear the submitted self-assessment locally
        if (window.selfAssessments && window.selfAssessments[questId]) {
            delete window.selfAssessments[questId];
            localStorage.setItem('selfAssessments', JSON.stringify(window.selfAssessments));
        }

        // Clear the submitted self-assessment in the cloud
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (session) {
                const { data: progress } = await window.supabase
                    .from('student_progress')
                    .select('self_assessments')
                    .eq('user_id', session.user.id)
                    .maybeSingle();

                if (progress?.self_assessments?.[questId]) {
                    const updated = { ...progress.self_assessments };
                    delete updated[questId];
                    await window.supabase
                        .from('student_progress')
                        .update({ self_assessments: updated })
                        .eq('user_id', session.user.id);
                }
            }
        } catch (e) {

        }
    }

    // ---- Validation ----
    if (!title) {
        alert("Please enter a title for your work.");
        return;
    }

    // An image is "present" if either a new one was picked OR one is already saved
    const saved = studentWorks[questId] || {};
    const hasSavedImage = saved.image && saved.image !== "pending";
    const hasImage = !!imageFile || hasSavedImage;

    if (!hasImage) {
        alert("Please upload an image of your work.");
        return;
    }

    // Check file size (only if a new image was actually picked)
    if (imageFile && imageFile.size > 5 * 1024 * 1024) {
        alert("Image is very large (over 5MB). It will be compressed but may take a moment.");
    }

    // Set lock
    isSavingWork = true;

    const workData = {
        title: title,
        size: size,
        media: media,
        description: description,
        lastModified: new Date().toISOString()
    };

    // Store in local studentWorks
    studentWorks[questId] = {
        ...workData,
        image: "pending"
    };
    saveStudentWorks();

    // Show saving indicator
    const saveBtn = document.querySelector(".save-work");
    if (saveBtn) {
        saveBtn.textContent = "Saving...";
        saveBtn.disabled = true;
    }

    // Use a unique upload ID to prevent duplicates
    const uploadId = `${questId}_${Date.now()}`;

    // --- Upload PDF first (if any) ---
    let pdfMeta = null;
    if (pdfFile) {
        pdfMeta = await uploadResearchPdf(questId, pdfFile);
        if (!pdfMeta) {
            isSavingWork = false;
            if (saveBtn) { saveBtn.textContent = "Save"; saveBtn.disabled = false; }
            return;
        }
    }

    // --- EXP: capture submission facts BEFORE the async cloud save,
    // so the fact is present even if the DB write fails and we retry ---
    const _expFacts = {
        submittedAt: new Date().toISOString(),
        submittedAtWeek: getISOWeekKey(),
        beforeDeadline: (function () {
            // No timer, no deadline → no before-deadline fact to record
            if (!questStartTimes[questId]) return false;
            return calculateRemainingMinutes(questId) > 0;
        })()
    };

    saveWorkToCloud(questId, workData, imageFile, uploadId, pdfMeta, _expFacts).then(async success => {
        if (saveBtn) {
            saveBtn.textContent = "Save";
            saveBtn.disabled = false;
        }

        isSavingWork = false;

        if (success) {
            // --- EXP: attach facts to the local mirror so it's available
            // even before the next cloud reload ---
            if (!studentWorks[questId]) studentWorks[questId] = {};
            studentWorks[questId].expFacts = _expFacts;
            saveStudentWorks();

            alert("🎨 Work saved successfully!");
            await loadCloudWorksIntoGallery();
            snapshotWorkOverlay();
            closeWorkOverlay();

            // AUTO-TRIGGER SELF-ASSESSMENT
            window._selfAssessmentPending = true;

            // Grab the freshly-saved image URL from memory (avoids a redundant DB fetch)
            const freshImageUrl = studentWorks[questId]?.image_url
                                || studentWorks[questId]?.image
                                || null;

            setTimeout(() => {
                openRubricPopup(questId, true, freshImageUrl);
            }, 400);

            // Refresh gallery if visible
            const galleryOverlay = document.getElementById("gallery-overlay");
            if (galleryOverlay && galleryOverlay.style.display === "flex") {
                renderGalleryItems();
            }
        } else {
            alert("Work saved locally only. Please try saving to cloud again later.");
        }
    }).catch(err => {
        isSavingWork = false;
        if (saveBtn) {
            saveBtn.textContent = "Save";
            saveBtn.disabled = false;
        }
        alert("Error saving work. Please try again.");

    });
}

// ==============================================
// DELETE HANDLERS (work overlay)
// ==============================================

/**
 * Handle click on "Delete image 🗑️".
 * - If a new image is picked but not saved: just clear the input.
 * - If a saved image exists: delete it from storage + DB, keep PDF + row.
 */
async function handleDeleteImageClick() {
    const overlay = document.getElementById("work-overlay");
    const questId = overlay?.dataset?.questId;
    if (!questId) return;

    const imageInput = document.getElementById("work-image");
    const pickedImage = imageInput?.files?.[0] || null;
    const saved = studentWorks[questId] || {};
    const savedImageUrl = saved?.image && saved.image !== "pending" ? saved.image : null;

    // Case 1: only a newly-picked (unsaved) image is present
    if (pickedImage && !savedImageUrl) {
        if (!confirm("Remove the selected image?")) return;
        imageInput.value = "";
        updateWorkOverlayUI();
        return;
    }

    // Case 2: saved image exists → delete from storage + DB
    if (savedImageUrl) {
        if (!confirm("Delete the saved image for this quest? The rest of the work (title, description, PDF) will be kept.")) return;

        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) return;

            // Delete from storage
            const fileName = `${session.user.id}/${questId}.jpg`;
            await window.supabase.storage
                .from('student-works')
                .remove([fileName]);

            // Null the DB image_url (keep the rest of the row)
            const { error } = await window.supabase
                .from('student_works')
                .update({ image_url: null })
                .eq('user_id', session.user.id)
                .eq('quest_id', questId);

            if (error) {

                alert("Failed to delete image: " + error.message);
                return;
            }

            // Update local cache
            if (studentWorks[questId]) {
                delete studentWorks[questId].image;
                delete studentWorks[questId].image_url;
                saveStudentWorks();
            }

            // Clear any picked file too
            if (imageInput) imageInput.value = "";

            updateWorkOverlayUI();
        } catch (e) {

            alert("Error deleting image.");
        }
    }
}

/**
 * Handle click on "Delete PDF 🗑️".
 * - If a new PDF is picked but not saved: just clear the input.
 * - If a saved PDF exists: delete it from storage + DB, keep image + row.
 */
async function handleDeletePdfClick() {
    const overlay = document.getElementById("work-overlay");
    const questId = overlay?.dataset?.questId;
    if (!questId) return;

    const pdfInput = document.getElementById("work-research-pdf");
    const pickedPdf = pdfInput?.files?.[0] || null;
    const saved = studentWorks[questId] || {};
    const savedPdfUrl = saved?.research_pdf_url || null;

    // Case 1: only a newly-picked (unsaved) PDF is present
    if (pickedPdf && !savedPdfUrl) {
        if (!confirm("Remove the selected PDF?")) return;
        pdfInput.value = "";
        updateWorkOverlayUI();
        return;
    }

    // Case 2: saved PDF exists → delete from storage + DB
    if (savedPdfUrl) {
        if (!confirm("Delete the saved research PDF for this quest? The rest of the work (image, title, description) will be kept.")) return;

        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) return;

            // Delete from research bucket
            const fileName = `${session.user.id}/${questId}.pdf`;
            await window.supabase.storage
                .from('student-research')
                .remove([fileName]);

            // Null the DB research fields
            const { error } = await window.supabase
                .from('student_works')
                .update({
                    research_pdf_url: null,
                    research_pdf_name: null,
                    research_pdf_uploaded_at: null
                })
                .eq('user_id', session.user.id)
                .eq('quest_id', questId);

            if (error) {

                alert("Failed to delete PDF: " + error.message);
                return;
            }

            // Update local cache
            if (studentWorks[questId]) {
                delete studentWorks[questId].research_pdf_url;
                delete studentWorks[questId].research_pdf_name;
                saveStudentWorks();
            }

            // Clear picked file
            if (pdfInput) pdfInput.value = "";

            updateWorkOverlayUI();
        } catch (e) {

            alert("Error deleting PDF.");
        }
    }
}

/**
 * Handle click on "Delete all".
 * Wipes the entire work: image + PDF (storage + DB row) + local cache + form fields.
 */
async function handleDeleteAllClick() {
    const overlay = document.getElementById("work-overlay");
    const questId = overlay?.dataset?.questId;
    if (!questId) return;

    if (!confirm("Delete ALL data for this quest? The image, research PDF, title, description — everything will be removed permanently.")) return;

    try {
        const { data: { session } } = await window.supabase.auth.getSession();
        if (!session) return;

        // Remove both storage files (best-effort, ignore missing)
        await window.supabase.storage.from('student-works').remove([`${session.user.id}/${questId}.jpg`]);
        await window.supabase.storage.from('student-research').remove([`${session.user.id}/${questId}.pdf`]);

        // Delete the DB row
        const { error } = await window.supabase
            .from('student_works')
            .delete()
            .eq('user_id', session.user.id)
            .eq('quest_id', questId);

        if (error) {

            alert("Failed to delete: " + error.message);
            return;
        }

        // Clear local cache
        delete studentWorks[questId];
        saveStudentWorks();

        // Clear form fields + file inputs
        const imageInput = document.getElementById("work-image");
        const pdfInput = document.getElementById("work-research-pdf");
        if (imageInput) imageInput.value = "";
        if (pdfInput) pdfInput.value = "";

        document.getElementById("work-title").value = "";
        document.getElementById("work-size").value = "";
        document.getElementById("work-media").value = "";
        document.getElementById("work-description").value = "";

        updateWorkOverlayUI();
        snapshotWorkOverlay();

        alert("All work data for this quest has been deleted.");
    } catch (e) {

        alert("Error deleting work.");
    }
}

/**
 * Legacy shim — if anything still calls deleteWorkImage(),
 * it now routes to the "delete all" flow.
 */
async function deleteWorkImage() {
    return handleDeleteAllClick();
}

function initializeWorkOverlay() {
    // --- The bottom "Finished Work" button on the quest ---
    const finishedWorkBtn = document.getElementById("finished-work-btn");
    if (finishedWorkBtn) {
        finishedWorkBtn.removeAttribute("onclick");
        // Clone to strip any old listeners
        const freshBtn = finishedWorkBtn.cloneNode(true);
        finishedWorkBtn.parentNode.replaceChild(freshBtn, finishedWorkBtn);
        freshBtn.addEventListener("click", function (e) {
            e.preventDefault();
            if (!currentQuestId) {
                alert("Please open a quest first to add your work.");
                return;
            }
            openWorkOverlay(currentQuestId);
        });
    }

    // --- Close buttons ---
    const closeButtons = document.querySelectorAll(
        "#work-overlay .close-overlay, #work-overlay button[onclick='closeWorkOverlay()']"
    );
    closeButtons.forEach(btn => {
        btn.removeAttribute("onclick");
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener("click", function (e) {
            e.preventDefault();
            closeWorkOverlay();
        });
    });

        // --- Clone the file inputs FIRST, so all references point to the live ones ---
    let imageInput = document.getElementById("work-image");
    let pdfInput = document.getElementById("work-research-pdf");

    if (imageInput) {
        const fresh = imageInput.cloneNode(true);
        imageInput.parentNode.replaceChild(fresh, imageInput);
        imageInput = fresh;
    }
    if (pdfInput) {
        const fresh = pdfInput.cloneNode(true);
        pdfInput.parentNode.replaceChild(fresh, pdfInput);
        pdfInput = fresh;
    }

    // --- Upload buttons trigger the (cloned, live) file inputs ---
    const uploadImageBtn = document.getElementById("upload-image-btn");
    const uploadPdfBtn = document.getElementById("upload-pdf-btn");

    if (uploadImageBtn && imageInput) {
        const fresh = uploadImageBtn.cloneNode(true);
        uploadImageBtn.parentNode.replaceChild(fresh, uploadImageBtn);
        fresh.addEventListener("click", () => imageInput.click());
    }
    if (uploadPdfBtn && pdfInput) {
        const fresh = uploadPdfBtn.cloneNode(true);
        uploadPdfBtn.parentNode.replaceChild(fresh, uploadPdfBtn);
        fresh.addEventListener("click", () => pdfInput.click());
    }

    // --- Image input change ---
    if (imageInput) {
        imageInput.addEventListener("change", function (e) {
            const file = e.target.files[0];
            if (!file) { updateWorkOverlayUI(); return; }
            if (file.size > 5 * 1024 * 1024) {
                alert("File is too large. Please select an image under 5 MB.");
                this.value = "";
                updateWorkOverlayUI();
                return;
            }
            if (!file.type.startsWith("image/")) {
                alert("Please select an image file.");
                this.value = "";
                updateWorkOverlayUI();
                return;
            }
            updateWorkOverlayUI();
        });
    }

    // --- PDF input change ---
    if (pdfInput) {
        pdfInput.addEventListener("change", function (e) {
            const file = e.target.files[0];
            if (!file) { updateWorkOverlayUI(); return; }
            if (file.type !== "application/pdf") {
                alert("Please select a PDF file.");
                this.value = "";
                updateWorkOverlayUI();
                return;
            }
            if (file.size > 5 * 1024 * 1024) {
                alert("PDF is too large. Maximum 5 MB.");
                this.value = "";
                updateWorkOverlayUI();
                return;
            }
            updateWorkOverlayUI();
        });
    }

    // --- Delete buttons ---
    const delImageBtn = document.getElementById("delete-image-btn");
    const delPdfBtn = document.getElementById("delete-pdf-btn");
    const delAllBtn = document.getElementById("delete-all-btn");

    if (delImageBtn) {
        const fresh = delImageBtn.cloneNode(true);
        delImageBtn.parentNode.replaceChild(fresh, delImageBtn);
        fresh.addEventListener("click", handleDeleteImageClick);
    }
    if (delPdfBtn) {
        const fresh = delPdfBtn.cloneNode(true);
        delPdfBtn.parentNode.replaceChild(fresh, delPdfBtn);
        fresh.addEventListener("click", handleDeletePdfClick);
    }
    if (delAllBtn) {
        const fresh = delAllBtn.cloneNode(true);
        delAllBtn.parentNode.replaceChild(fresh, delAllBtn);
        fresh.addEventListener("click", handleDeleteAllClick);
    }

    // --- Text fields → live UI update (for Save button enablement) ---
    ["work-title", "work-size", "work-media", "work-description"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const fresh = el.cloneNode(true);
        el.parentNode.replaceChild(fresh, el);
        fresh.addEventListener("input", updateWorkOverlayUI);
    });

    // --- Save button ---
    const saveBtn = document.querySelector(".save-work");
    if (saveBtn) {
        const fresh = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(fresh, saveBtn);
        fresh.addEventListener("click", function (e) {
            e.preventDefault();
            if (fresh.disabled) return;
            saveWorkData();
        });
    }
}

function openFullscreenFromWork(work, quest) {
    const overlay = document.getElementById("fullscreen-image-overlay");
    const fullscreenImg = document.getElementById("fullscreen-image");
    const titleEl = document.getElementById("fullscreen-title");
    const detailsEl = document.getElementById("fullscreen-details");
    const descriptionEl = document.getElementById("fullscreen-description");
    if (!overlay || !fullscreenImg) return;
    fullscreenImg.src = work.image;
    titleEl.textContent = work.title || quest?.title || "Artwork";
    let details = [];
    if (quest && quest.title) details.push(`Quest: ${quest.title}`);
    if (work.size) details.push(`Size: ${work.size}`);
    if (work.media) details.push(`Media: ${work.media}`);
    if (work.lastModified) {
        const date = new Date(work.lastModified);
        details.push(`Last modified: ${date.toLocaleDateString()}`);
    }
    detailsEl.textContent = details.join(" • ");
    descriptionEl.textContent = work.description || (quest?.description ? `Quest: ${quest.description}` : "No description");
    overlay.style.display = "flex";
    overlay.currentWork = work;
    overlay.currentQuest = quest;
    const escHandler = function(e) {
        if (e.key === "Escape") {
            closeFullscreenImage();
            document.removeEventListener("keydown", escHandler);
        }
    };
    document.addEventListener("keydown", escHandler);
    overlay.escHandler = escHandler;
}

function openFullscreenImageSimple(imageSrc) {
    const overlay = document.getElementById("fullscreen-image-overlay");
    const fullscreenImg = document.getElementById("fullscreen-image");
    const titleEl = document.getElementById("fullscreen-title");
    const detailsEl = document.getElementById("fullscreen-details");
    const descriptionEl = document.getElementById("fullscreen-description");
    if (!overlay || !fullscreenImg) return;
    fullscreenImg.src = imageSrc;
    titleEl.textContent = "Image Preview";
    detailsEl.textContent = "";
    descriptionEl.textContent = "";
    overlay.style.display = "flex";
    const escHandler = function(e) {
        if (e.key === "Escape") {
            closeFullscreenImage();
            document.removeEventListener("keydown", escHandler);
        }
    };
    document.addEventListener("keydown", escHandler);
    overlay.escHandler = escHandler;
}

function closeWorkOverlay() {
    const overlay = document.getElementById("work-overlay");
    if (overlay) overlay.style.display = "none";
}

// ==============================================
// SECTION 8: TEACHER FRAMEWORK DETECTION
// ==============================================

async function detectTeacherFramework() {
    // --- CACHE HIT: framework already resolved this session ---
    if (TeacherCache.framework !== null) {
        return TeacherCache.framework;
    }

    const profile = loadStudentProfile();
    if (!profile || !profile.teacher_code) {

        TeacherCache.framework = 'ncas';
        TeacherCache.loaded = true;
        return 'ncas';
    }

    // Fetch framework AND id in one query, cache both
    const { data: teacher, error } = await window.supabase
        .from('teachers')
        .select('id, framework, name')
        .eq('class_code', profile.teacher_code)
        .single();

    if (error || !teacher) {

        TeacherCache.framework = 'ncas';
        TeacherCache.loaded = true;
        return 'ncas';
    }

    TeacherCache.framework = teacher.framework || 'ncas';
    TeacherCache.teacherId = teacher.id;
    TeacherCache.teacherName = teacher.name;
    TeacherCache.loaded = true;


    return TeacherCache.framework;
}

function getQuestsFileForFramework(framework) {
    switch(framework) {
        case 'ib-myp':
            return 'quests-ib-myp.json';
        case 'igcse':
            return 'quests-igcse.json';
        default:
            return 'quests.json';
    }
}
// ==============================================
// SECTION 8b: EXP SYSTEM — CORE HELPERS
// ==============================================

/**
 * Load EXP state from localStorage. Called once at startup.
 * The cloud version (loadStudentDataFromCloud) will overwrite these
 * values after login if the student has progress on the server.
 */
function loadExpFromLocal() {
    try {
        const total = localStorage.getItem("expTotal");
        const log = localStorage.getItem("expLog");
        expTotal = total ? parseInt(total, 10) || 0 : 0;
        expLog = log ? JSON.parse(log) : {};
    } catch (e) {

        expTotal = 0;
        expLog = {};
    }
}

function saveExpToLocal() {
    localStorage.setItem("expTotal", String(expTotal));
    localStorage.setItem("expLog", JSON.stringify(expLog));
}

/**
 * Level curve: level N requires 100 * N * (N+1) / 2 total EXP.
 * L0 = 0–99, L1 = 100–299, L2 = 300–599, L3 = 600–999, ...
 */
function getLevelInfo(totalExp) {
    let level = 0;
    while (true) {
        const nextLevelTotal = 100 * (level + 1) * (level + 2) / 2;
        if (totalExp < nextLevelTotal) break;
        level++;
    }
    const currentLevelFloor = level === 0 ? 0 : (100 * level * (level + 1) / 2);
    const nextLevelCeil = 100 * (level + 1) * (level + 2) / 2;
    return {
        level,
        current: totalExp - currentLevelFloor,
        needed: nextLevelCeil - currentLevelFloor,
        total: totalExp
    };
}

/**
 * Recompute expTotal from expLog. expLog is the source of truth;
 * expTotal is a derived cache. Call this after ANY mutation of expLog.
 */
function recomputeExpTotal() {
    expTotal = Object.values(expLog).reduce((s, v) => s + (v || 0), 0);
    saveExpToLocal();
    scheduleExpSaveToCloud();
    renderExpBar();

    // Detect level changes and persist them (fire-and-forget)
    _syncLevelToCloud();

    return expTotal;
}

/**
 * Compares the student's computed level to what's stored on the server,
 * and writes the new level + timestamp when they differ.
 *
 * Fire-and-forget: never awaited, never blocks UI, never throws.
 * Rate-limited to one DB check every 30 seconds per session.
 */
let _lastLevelSyncCheck = 0;
let _lastSyncedLevel = null;

async function _syncLevelToCloud() {
    const now = Date.now();
    if (now - _lastLevelSyncCheck < 30_000) return;
    _lastLevelSyncCheck = now;

    try {
        const computed = getLevelInfo(expTotal).level;

        // Skip the DB hit if we already know the synced level matches
        if (_lastSyncedLevel !== null && _lastSyncedLevel === computed) return;

        const { data: { session } } = await window.supabase.auth.getSession();
        if (!session) return;

        const { data: row } = await window.supabase
            .from('student_progress')
            .select('current_level')
            .eq('user_id', session.user.id)
            .maybeSingle();

        const stored = row?.current_level ?? null;

        if (stored === computed) {
            _lastSyncedLevel = computed;
            return;
        }

        const { error } = await window.supabase
            .from('student_progress')
            .update({
                current_level: computed,
                level_reached_at: new Date().toISOString()
            })
            .eq('user_id', session.user.id);

        if (error) {

            _lastLevelSyncCheck = 0; // allow retry on next award
        } else {
            _lastSyncedLevel = computed;

        }
    } catch (e) {

    }
}

/**
 * Award EXP. Dedupes by sourceKey when provided — calling twice with the
 * same key silently does nothing. Use stable keys (see naming table below).
 */
// Session-level guard: keys we've already celebrated this page-load.
// Prevents the modal/banner from re-firing when reconcile re-adds the same key.
const _celebratedKeys = new Set();

/**
 * Award EXP.
 * @param {number} amount
 * @param {string|null} sourceKey
 * @param {string} reason
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false]  — if true, do NOT show level-up modal
 *                                         or pulse/badge notifications.
 *                                         Used by reconcileExp().
 */
function addExp(amount, sourceKey = null, reason = "", opts = {}) {
    if (!amount || amount <= 0) return 0;
    if (sourceKey && expLog[sourceKey] !== undefined) return 0;

    const silent = opts.silent === true;

    const beforeLevel = getLevelInfo(expTotal).level;
    if (sourceKey) expLog[sourceKey] = amount;
    recomputeExpTotal();  // this already calls scheduleExpSaveToCloud + renderExpBar

    // Only pulse the bar if this is a "real" award AND we haven't
    // already celebrated this key this session.
    const isNewCelebration = !silent && sourceKey && !_celebratedKeys.has(sourceKey);
    if (isNewCelebration) _celebratedKeys.add(sourceKey);

    if (isNewCelebration) {
        renderExpBar({ delta: amount });
    }

    const afterLevel = getLevelInfo(expTotal).level;



    if (afterLevel > beforeLevel && isNewCelebration) {

        showLevelUpNotification(beforeLevel, afterLevel);
    }
    return amount;
}

/**
 * Remove EXP by prefix. Matches keys that equal the prefix OR start
 * with "<prefix>:" — so revokeExpPrefix("quest:quest42") also nukes
 * "quest:quest42", "before_time:quest42" (via prefix "before_time:quest42"),
 * etc. Caller decides which prefixes to clear.
 */
function revokeExpPrefix(prefix) {
    // Tolerate callers passing "test:" instead of "test"
    const cleanPrefix = prefix.endsWith(":") ? prefix.slice(0, -1) : prefix;
    let removed = 0;
    for (const key of Object.keys(expLog)) {
        if (key === cleanPrefix || key.startsWith(cleanPrefix + ":")) {
            removed += expLog[key] || 0;
            delete expLog[key];
        }
    }
    if (removed > 0) {

        recomputeExpTotal();
    }
    return removed;
}

/**
 * Cloud persistence — debounced so multiple awards in one tick
 * only hit the DB once.
 */
function scheduleExpSaveToCloud() {
    clearTimeout(_expSaveDebounce);
    _expSaveDebounce = setTimeout(saveExpToCloud, 800);
}

async function saveExpToCloud() {
    if (isLoadingFromCloud) return;
    await ensureFreshSession();
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return;
    const { error } = await guardAuth(() =>
        window.supabase
            .from("student_progress")
            .update({
                exp_total: expTotal,
                exp_log: expLog,
                updated_at: new Date().toISOString()
            })
            .eq("user_id", session.user.id)
    );
    if (error) console.error("[EXP] cloud save failed:", error);
}

/**
 * ISO week key, e.g. "2026-W41". Used for weekly upload bonuses.
 */
function getISOWeekKey(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Achievement EXP. Achievements are derived from completedQuests, so we
 * re-run this after every state change; the sourceKey dedupes.
 */
function checkAchievementExp() {
    if (!achievementsData) return;
    for (const ach of achievementsData) {
        const key = `achievement:${ach.title}`;
        if (expLog[key] !== undefined) continue;
        const complete = ach.questsNeeded.every(qid => completedQuests[qid]);
        if (!complete) continue;
        const amount = ach.exp || 0;
        if (amount <= 0) continue;

        const firstTimeThisSession = !_celebratedKeys.has(key);
        _celebratedKeys.add(key);

        addExp(amount, key, `Achievement: ${ach.title}`, { silent: !firstTimeThisSession });

        if (firstTimeThisSession && typeof showBadgeNotification === "function") {
            showBadgeNotification(`🏆 ${ach.title} (+${amount} EXP)`);
        }
    }
}

/**
 * Badge EXP. Awarded on first earn (any tier) and on tier upgrades.
 * Tier-1 (first earn) = 100, tier-2 = 150, tier-3 = 200.
 * Non-progression badges (path/skill) are one-time at 100.
 * Keys: "badge:<id>:t1", "badge:<id>:t2", "badge:<id>:t3".
 */
function checkBadgeExp() {
    if (!badgesData || !earnedBadges) return;
    for (const badge of badgesData) {
        const info = earnedBadges[badge.id];
        if (!info || !info.earned) continue;

        let key, amount;
        if (badge.progression && info.level) {
            const tier = typeof info.level === "number"
                ? info.level
                : ({"I": 1, "II": 2, "III": 3}[String(info.level).toUpperCase()] || 1);
            const tierAmounts = {
                1: EXP_RULES.BADGE_UNLOCKED,
                2: EXP_RULES.BADGE_TIER_2,
                3: EXP_RULES.BADGE_TIER_3
            };
            amount = tierAmounts[tier] || EXP_RULES.BADGE_UNLOCKED;
            key = `badge:${badge.id}:t${tier}`;
        } else {
            amount = EXP_RULES.BADGE_UNLOCKED;
            key = `badge:${badge.id}`;
        }

        if (expLog[key] !== undefined) continue;   // already awarded

        // Mark the key BEFORE addExp so the notification only fires once
        // even if reconcile runs several times in one session.
        const firstTimeThisSession = !_celebratedKeys.has(key);
        _celebratedKeys.add(key);

        addExp(amount, key, `Badge: ${badge.name}`, { silent: !firstTimeThisSession });

        if (firstTimeThisSession && typeof showBadgeNotification === "function") {
            showBadgeNotification(`🎖️ ${badge.name} (+${amount} EXP)`);
        }
    }
}

/**
 * Weekly upload bonus reconciler. Ensures the "first upload of the week"
 * bonus only stands if at least one upload exists in that week, and
 * removes any stale weekly keys whose quest IDs no longer exist.
 */
function reconcileWeeklyUploadBonuses() {
    // Weeks that still have at least one upload recorded
    const weeksWithUploads = new Set();
    for (const key of Object.keys(expLog)) {
        const m = key.match(/^upload:([^:]+):(.+)$/);
        if (m) weeksWithUploads.add(m[2]);
    }
    // First-of-week bonus keys without a matching upload → revoke
    for (const key of Object.keys(expLog)) {
        const m = key.match(/^first_upload:(.+)$/);
        if (m && !weeksWithUploads.has(m[1])) {
            delete expLog[key];
        }
    }
    recomputeExpTotal();
}

/**
 * Full EXP reconciler. Idempotent — safe to call after any state change.
 * Order matters: revoke derived EXP first, then re-derive.
 */
async function reconcileExp() {
    // ---- 1. REVOKE anything whose source no longer exists ----
    reconcileQuestExp();          // quests deleted / ungraded / uncompleted
    reconcileAllGiftExp();        // gift threshold no longer met
    reconcileWeeklyUploadBonuses(); // first-upload bonus with no upload
    reconcileBadgeAndAchievementExp();

    // ---- 2. RE-AWARD what's still valid ----
    if (typeof checkAllBadges === "function") checkAllBadges(false);
    checkBadgeExp();
    checkAchievementExp();

    try { await syncExpFromGradedWork(); } catch (e) { console.warn("[EXP] sync failed:", e); }

    // ---- 3. Recompute total (this updates level + saves + bar) ----
    recomputeExpTotal();
}

/**
 * Revokes badge and achievement EXP for badges/achievements that are
 * no longer earned (e.g. the student's completed quests were reduced).
 */
function reconcileBadgeAndAchievementExp() {
    // 1. Rebuild earnedBadges from the current state. This makes
    //    `stillEarned` below reflect reality.
    recomputeEarnedBadges();

    // 2. Achievements: revoke EXP if any needed quest is no longer complete.
    if (Array.isArray(achievementsData)) {
        for (const ach of achievementsData) {
            const key = `achievement:${ach.title}`;
            if (expLog[key] === undefined) continue;
            const stillComplete = ach.questsNeeded.every(qid => completedQuests[qid]);
            if (!stillComplete) {
                delete expLog[key];

            }
        }
    }

    // 3. Badges: revoke EXP if the badge is no longer earned.
    if (Array.isArray(badgesData)) {
        for (const badge of badgesData) {
            const prefix = `badge:${badge.id}`;
            const info = earnedBadges?.[badge.id];
            const stillEarned = info && info.earned;
            if (stillEarned) continue;

            for (const key of Object.keys(expLog)) {
                if (key === prefix || key.startsWith(prefix + ":")) {
                    delete expLog[key];

                }
            }
        }
    }
}

/**
 * Rebuilds `earnedBadges` from scratch based on the CURRENT state of
 * completedQuests. Teacher-awarded badges are preserved (they're not
 * derived from quest completion, so they never auto-expire).
 *
 * After this runs:
 *   - any badge whose requirements are no longer met is gone
 *   - any badge whose requirements ARE still met is kept (with its
 *     original earnedAt, so the "earned on" date doesn't reset)
 *   - progression badges are re-evaluated at their current tier
 *     (so a student who loses a summative can drop from tier III to II)
 */
function recomputeEarnedBadges() {
    if (!Array.isArray(badgesData)) return;

    // Snapshot the old data so we can preserve earnedAt timestamps
    const oldBadges = { ...earnedBadges };
    const newBadges = {};

    for (const badge of badgesData) {
        // Teacher-awarded badges are never revoked automatically
        if (badge.teacherAwarded) {
            if (oldBadges[badge.id]?.earned) {
                newBadges[badge.id] = oldBadges[badge.id];
            }
            continue;
        }

        // Preserve earnedAt if the student had earned this before
        const previousEarnedAt = oldBadges[badge.id]?.earnedAt;

        if (badge.progression) {
            // Progression badges: re-evaluate the tier from scratch
            const fakeEarned = {};
            const prev = earnedBadges;
            earnedBadges = fakeEarned;   // temporarily swap so checkProgressionBadge writes here
            const earned = checkProgressionBadge(badge);
            earnedBadges = prev;

            if (earned && fakeEarned[badge.id]) {
                newBadges[badge.id] = {
                    ...fakeEarned[badge.id],
                    earnedAt: previousEarnedAt || fakeEarned[badge.id].earnedAt
                };
            }
        } else if (badge.checkFunction) {
            let earned = false;
            if (badge.checkFunction === "checkPathMastery") {
                earned = checkPathMastery(badge.params);
            } else if (badge.checkFunction === "checkColorExpert") {
                earned = checkColorExpert(badge.params);
            } else if (badge.checkFunction === "checkPerspectivePro") {
                earned = checkPerspectivePro(badge.params);
            }
            if (earned) {
                newBadges[badge.id] = {
                    earned: true,
                    earnedAt: previousEarnedAt || new Date().toISOString()
                };
            }
        }
    }

    earnedBadges = newBadges;
    saveEarnedBadges();

    // Push to cloud so the change survives the next login
    if (typeof saveBadgesToCloud === "function" && !isLoadingFromCloud) {
        saveBadgesToCloud().catch(e => console.warn("[badges] cloud save failed:", e));
    }



    // Refresh the profile badge grid if it's currently open
    if (typeof renderBadges === "function") {
        const profileOverlay = document.getElementById("profile-overlay");
        if (profileOverlay && profileOverlay.style.display === "flex") {
            renderBadges();
        }
    }
}

// ==============================================
// SECTION 8c: DEFERRED EXP — SUBMISSION-FACT SYSTEM
// ==============================================
//
// EXP tied to a submission is awarded only when the teacher grades it.
// Facts captured at submit time (submittedAt, submittedAtWeek, beforeDeadline)
// live in `expFacts` on studentWorks[questId] and in the DB column
// `student_works.exp_metadata`. The award happens in syncExpFromGradedWork().

/**
 * Returns true if the quest has at least one graded standard that is
 * considered "earned" for EXP purposes.
 *
 * - Excludes `teacher_comment` and `completed_at` (bookkeeping keys).
 * - Treats `0`, null, undefined, "" as "no grade" — a 0 is a legitimate
 *   teacher-assigned score but it does not count for EXP.
 * - Framework-agnostic: works for NCAS (numeric), IB (bands), IGCSE (letters).
 */
function hasAnyEarnedGradeForQuest(questId) {
    const quest = quests[questId];
    if (!quest) return false;
    const column = quest.style === "mvp" ? "mvpGrade" : "grade";
    const grades = questGrades[questId]?.[column];
    if (!grades || typeof grades !== "object") return false;

    return Object.entries(grades).some(([key, v]) => {
        if (key === "teacher_comment") return false;
        if (key === "completed_at") return false;
        if (v === null || v === undefined || v === "") return false;
        // `0` (number or numeric string) does NOT count
        if (typeof v === "number" && v === 0) return false;
        if (typeof v === "string" && v.trim() === "0") return false;
        return true;
    });
}

/**
 * Sync deferred EXP for every completed quest whose submission facts
 * were captured at upload time.
 *
 * Idempotent — every award is keyed in expLog, so calling this repeatedly
 * is safe and cheap.
 *
 * Called from:
 *   - refreshStudentData()          (after cloud load)
 *   - reconcileExp()                (at the end, after badge/achievement reset)
 */
async function syncExpFromGradedWork() {
    if (!completedQuests) return;

    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (isCompleted !== true) continue;

        // Gate: only award if the teacher actually graded something
        if (!hasAnyEarnedGradeForQuest(questId)) continue;

        const quest = quests[questId];

        // --- Quest completion EXP (once per quest) ---
        const completionKey = `quest:${questId}`;
        if (expLog[completionKey] === undefined && quest) {
            addExp(
                quest.style === "mvp" ? EXP_RULES.SUMMATIVE_COMPLETE : EXP_RULES.FORMATIVE_COMPLETE,
                completionKey,
                `${quest.style === "mvp" ? "Summative" : "Formative"} complete: ${quest.title || questId}`
            );
        }

        const work = studentWorks[questId];
        const facts = work?.expFacts;
        if (!facts || !facts.submittedAtWeek) continue;

        const week = facts.submittedAtWeek;

        // --- 1. First upload of that (submission) week ---
        const firstKey = `first_upload:${week}`;
        if (expLog[firstKey] === undefined) {
            addExp(
                EXP_RULES.FIRST_UPLOAD_OF_WEEK,
                firstKey,
                `First upload of week ${week} (awarded at grade time)`
            );
        }

        // --- 2. Per-quest upload bonus for that week ---
        const uploadKey = `upload:${questId}:${week}`;
        if (expLog[uploadKey] === undefined) {
            addExp(
                EXP_RULES.EXTRA_UPLOAD_SAME_WEEK,
                uploadKey,
                `Upload bonus for ${questId} (week ${week})`
            );
        }

        // --- 3. Before-deadline bonus (once per quest) ---
        const beforeKey = `before_time:${questId}`;
        if (facts.beforeDeadline === true && expLog[beforeKey] === undefined) {
            const isMVP = quest?.style === "mvp";
            addExp(
                isMVP ? EXP_RULES.BEFORE_TIME_SUMMATIVE : EXP_RULES.BEFORE_TIME_FORMATIVE,
                beforeKey,
                `Before-deadline bonus (${isMVP ? "summative" : "formative"}): ${questId}`
            );
        }

        // --- 4. All-standards-high bonus (numeric only, ≥ 3.5) ---
        const highKey = `high_standards:${questId}`;
        if (expLog[highKey] === undefined) {
            const assessment = window.selfAssessments?.[questId];
            if (assessment && typeof assessment === "object") {
                const entries = Object.entries(assessment).filter(
                    ([k]) => k !== "teacher_comment" && k !== "completed_at"
                );
                if (entries.length > 0) {
                    let allNumericHigh = true;
                    for (const [, v] of entries) {
                        const num = parseFloat(v);
                        if (isNaN(num)) { allNumericHigh = false; break; }
                        if (num < 3.5) { allNumericHigh = false; break; }
                    }
                    if (allNumericHigh) {
                        addExp(
                            EXP_RULES.ALL_STANDARDS_HIGH,
                            highKey,
                            `All standards ≥ 3.5 for ${questId}`
                        );
                    }
                }
            }
        }

        // --- 5. Gift EXP for featured quests (threshold met) ---
        // Only awarded if the quest was featured by the teacher in the week
        // the student submitted, and the grade currently meets the threshold.
        // Revocation is handled separately by reconcileAllGiftExp().
        const giftKey = `gift:${week}:${questId}`;
        if (expLog[giftKey] === undefined) {
            const wasFeatured = await _wasQuestFeaturedInWeek(questId, week);
            if (wasFeatured && meetsGiftThreshold(questId)) {
                const amount = quest?.style === "mvp"
                    ? EXP_RULES.GIFT_SUMMATIVE
                    : EXP_RULES.GIFT_FORMATIVE;
                addExp(
                    amount,
                    giftKey,
                    `Gift bonus (${quest?.style === "mvp" ? "summative" : "formative"}): ${questId}`
                );
            }
        }
    }
}

/**
 * Returns true if the given quest was featured by the student's teacher
 * during the given week key.
 * Cached per (questId, weekKey) to avoid hammering the DB during a sync loop.
 */
const _featuredWeekCache = new Map();

async function _wasQuestFeaturedInWeek(questId, weekKey) {
    const cacheKey = `${questId}::${weekKey}`;
    if (_featuredWeekCache.has(cacheKey)) return _featuredWeekCache.get(cacheKey);

    if (!TeacherCache.teacherId) {
        TeacherCache.framework = null;
        TeacherCache.loaded = false;
        await detectTeacherFramework();
    }
    if (!TeacherCache.teacherId) {
        _featuredWeekCache.set(cacheKey, false);
        return false;
    }

    const { data, error } = await window.supabase
        .from('teacher_featured_quests')
        .select('id')
        .eq('teacher_id', TeacherCache.teacherId)
        .eq('quest_id', questId)
        .eq('week_key', weekKey)
        .maybeSingle();

    if (error) {

        _featuredWeekCache.set(cacheKey, false);
        return false;
    }

    const wasFeatured = !!data;
    _featuredWeekCache.set(cacheKey, wasFeatured);
    return wasFeatured;
}

function invalidateFeaturedWeekCache() {
    _featuredWeekCache.clear();
}

/**
 * Award EXP for approved art battle submissions.
 * Called when the student opens the Art Battle overlay (no realtime —
 * they see the reward the next time they check the contest).
 *
 * Idempotent — keyed by contest ID.
 */
async function syncArtBattleSubmissionExp() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return;

    const { data: submissions, error } = await window.supabase
        .from('art_battle_submissions')
        .select('contest_id, status')
        .eq('student_id', session.user.id)
        .eq('status', 'approved');

    if (error) {

        return;
    }

    for (const sub of (submissions || [])) {
        const key = `submit_battle:${sub.contest_id}`;
        if (expLog[key] === undefined) {
            addExp(
                EXP_RULES.SUBMIT_ART_BATTLE,
                key,
                `Art battle submission approved (contest ${sub.contest_id})`
            );
        }
    }
}



/**
 * Reconciles gift EXP.
 *
 * NEW RULE (no revocation): a gift EXP award, once given, is permanent.
 * We do NOT revoke it because the threshold is no longer met.
 *
 * We DO still clean up genuinely invalid keys:
 *   - the quest no longer exists in `quests`
 *   - the key's week doesn't match the student's acceptance week for that quest
 *     (defensive; this shouldn't happen once the acceptance-week anchoring is in)
 */
function reconcileAllGiftExp() {
    for (const key of Object.keys(expLog)) {
        if (!key.startsWith("gift:")) continue;

        // gift:<week>:<questId>
        const parts = key.split(":");
        if (parts.length < 3) continue;
        const week = parts[1];
        const questId = parts.slice(2).join(":");

        // Quest gone → revoke (the completion itself is meaningless now).
        if (!quests[questId]) {
            delete expLog[key];
            continue;
        }

        // Week no longer matches the acceptance week → revoke (stale key
        // from before the fix, or an acceptance-time change via cancel + re-accept).
        const acceptIso = questStartTimes[questId] || null;
        const acceptWeek = acceptIso ? getISOWeekKeyFromDate(acceptIso) : null;
        if (acceptWeek && week !== acceptWeek) {
            delete expLog[key];
            continue;
        }

        // Otherwise: keep. No threshold-based revocation.
    }
}
/**
 * Revokes EXP for quests whose grade is no longer valid.
 * A quest's grade is "no longer valid" if:
 *   - the quest no longer exists in `quests` (deleted by teacher), OR
 *   - the student is no longer marked as completed on it, OR
 *   - the teacher has cleared all grades for it (no earned grade remains).
 *
 * Cleans up every per-quest key:
 *   quest:<questId>
 *   upload:<questId>:<week>
 *   before_time:<questId>
 *   high_standards:<questId>
 *   gift:<week>:<questId>
 */
function reconcileQuestExp() {
    // Build the set of questIds that currently have a valid, graded completion.
    const validQuestIds = new Set();
    for (const [questId, isCompleted] of Object.entries(completedQuests || {})) {
        if (isCompleted !== true) continue;
        if (!quests[questId]) continue;                  // quest deleted
        if (!hasAnyEarnedGradeForQuest(questId)) continue; // grades cleared
        validQuestIds.add(questId);
    }

    let revoked = 0;

    for (const key of Object.keys(expLog)) {
        // --- quest:<questId> ---
        if (key.startsWith("quest:")) {
            const questId = key.slice("quest:".length);
            if (!validQuestIds.has(questId)) {
                revoked += expLog[key] || 0;
                delete expLog[key];
            }
            continue;
        }

        // --- before_time:<questId> ---
        if (key.startsWith("before_time:")) {
            const questId = key.slice("before_time:".length);
            if (!validQuestIds.has(questId)) {
                revoked += expLog[key] || 0;
                delete expLog[key];
            }
            continue;
        }

        // --- high_standards:<questId> ---
        if (key.startsWith("high_standards:")) {
            const questId = key.slice("high_standards:".length);
            if (!validQuestIds.has(questId)) {
                revoked += expLog[key] || 0;
                delete expLog[key];
            }
            continue;
        }

        // --- upload:<questId>:<week> ---
        if (key.startsWith("upload:")) {
            const parts = key.split(":");        // ["upload", questId, week]
            const questId = parts[1];
            if (!validQuestIds.has(questId)) {
                revoked += expLog[key] || 0;
                delete expLog[key];
            }
            continue;
        }

        // --- gift:<week>:<questId> ---  (also handled by reconcileAllGiftExp,
        //                                but we revoke here too for consistency)
        if (key.startsWith("gift:")) {
            const parts = key.split(":");        // ["gift", week, questId]
            const questId = parts.slice(2).join(":");
            if (!validQuestIds.has(questId)) {
                revoked += expLog[key] || 0;
                delete expLog[key];
            }
            continue;
        }
    }

    if (revoked > 0) {

    }
    return revoked;
}
/**
 * Removes EXP keys that should never exist in production:
 *   - anything starting with "test:"
 *   - anything starting with "debug:"
 *   - anything starting with "tmp:"
 *
 * Safe to call on every reconcile — it only deletes matches, never awards.
 */
function purgeDebugExpKeys() {
    const badPrefixes = ["test:", "debug:", "tmp:"];
    let removed = 0;
    for (const key of Object.keys(expLog)) {
        if (badPrefixes.some(p => key.startsWith(p))) {
            removed += expLog[key] || 0;
            delete expLog[key];
        }
    }
    if (removed > 0) {

    }
    return removed;
}

// ==============================================
// SECTION 8d: EXP BAR RENDERING & LEVEL-UP
// ==============================================

/**
 * Render the EXP bar under the profile button.
 * Safe to call at any time — if the DOM elements are missing, it no-ops.
 *
 * @param {Object} [opts]
 * @param {number} [opts.delta]  — when set, plays the pulse animation
 *                                 and shows a floating "+N" indicator.
 * @param {number} [opts.fromLevel] — when set, plays nothing special;
 *                                    level-up is handled separately.
 */
let _lastRenderedLevel = null;

function renderExpBar(opts = {}) {
    const wrap = document.getElementById("exp-bar-wrap");
    const fill = document.getElementById("exp-bar-fill");
    const levelText = document.getElementById("exp-level-text");
    if (!wrap || !fill || !levelText) {
        // Even if the nav bar isn't on this page, still refresh the profile overlay's bar
        if (typeof renderProfileExpBar === 'function') renderProfileExpBar();
        return;
    }

    // Mirror to the profile overlay's bar (if present)
    if (typeof renderProfileExpBar === 'function') renderProfileExpBar();

    const info = getLevelInfo(expTotal);
    const pct = info.needed > 0
        ? Math.max(0, Math.min(100, (info.current / info.needed) * 100))
        : 0;

    // Bar fill width
    fill.style.width = pct.toFixed(2) + "%";

    // Level text
    const newLevelLabel = `Lv ${info.level}`;
    if (levelText.textContent !== newLevelLabel) {
        levelText.textContent = newLevelLabel;
    }

        // --- Custom tooltip (instant, unlike native title) ---
    // --- Custom tooltip (instant, unlike native title) ---
    if (!wrap._expTooltipHooked) {
        wrap._expTooltipHooked = true;

        // Remove any orphaned tooltip from a previous session
        document.querySelectorAll(".exp-bar-tooltip").forEach(el => el.remove());

        const tip = document.createElement("div");
        tip.className = "exp-bar-tooltip";
        document.body.appendChild(tip);

        const show = (e) => {
            const cur = getLevelInfo(expTotal);
            tip.innerHTML = `<span class="exp-bar-tooltip-level">Lv ${cur.level}</span>`
                          + `${cur.current} / ${cur.needed} EXP`;
            tip.classList.add("show");
            position(e);
        };
        const hide = () => tip.classList.remove("show");
        const position = (e) => {
            const rect = wrap.getBoundingClientRect();
            const tr = tip.getBoundingClientRect();

            const left = rect.right - tr.width;
            tip.style.left = `${left}px`;

            let top = rect.bottom + 6;
            if (top + tr.height > window.innerHeight - 8) {
                top = rect.top - tr.height - 6;
            }
            tip.style.top = `${top}px`;

            if (left < 8) {
                tip.style.left = "8px";
            }
        };

        wrap.addEventListener("mouseenter", show);
        wrap.addEventListener("mousemove", position);
        wrap.addEventListener("mouseleave", hide);
    }

    // Pulse + floating delta
    if (opts.delta && opts.delta > 0) {
        fill.classList.remove("exp-pulse");
        void fill.offsetWidth;   // force reflow to restart animation
        fill.classList.add("exp-pulse");

        const float = document.createElement("div");
        float.className = "exp-float";
        float.textContent = `+${opts.delta}`;
        wrap.appendChild(float);
        void float.offsetWidth;
        float.classList.add("go");
        setTimeout(() => float.remove(), 1200);
    }

    _lastRenderedLevel = info.level;
}

/**
 * Render the EXP bar inside the profile overlay.
 * Reads expTotal via getLevelInfo() and populates the DOM elements
 * created in Step D1. Safe to call even if the profile overlay
 * isn't visible (the elements just get updated off-screen).
 */
function renderProfileExpBar() {
    const levelEl   = document.getElementById("profile-exp-level");
    const fillEl    = document.getElementById("profile-exp-bar-fill");
    const numbersEl = document.getElementById("profile-exp-numbers");
    const totalEl   = document.getElementById("profile-exp-total");

    if (!levelEl || !fillEl || !numbersEl || !totalEl) return;

    const info = getLevelInfo(expTotal);
    const pct = info.needed > 0
        ? Math.max(0, Math.min(100, (info.current / info.needed) * 100))
        : 0;

    levelEl.textContent   = `Lv ${info.level}`;
    numbersEl.textContent = `${info.current} / ${info.needed}`;
    totalEl.textContent   = `${expTotal} EXP total`;
    fillEl.style.width    = pct.toFixed(2) + "%";
}
/**
 * Level-up celebration.
 * Fires whenever addExp crosses a level threshold.
 */
function showLevelUpNotification(fromLevel, toLevel) {
    // Don't stack multiple modals if several level-ups happen in one sync
    const existing = document.getElementById("levelup-overlay");
    if (existing) {
        // Update the text and re-trigger the pop animation
        const lvlEl = existing.querySelector(".levelup-level");
        if (lvlEl) lvlEl.textContent = `LEVEL ${toLevel}`;
        const box = existing.querySelector(".levelup-box");
        if (box) {
            box.style.animation = "none";
            void box.offsetWidth;
            box.style.animation = "";
        }
        return;
    }

    const overlay = document.createElement("div");
    overlay.id = "levelup-overlay";
    overlay.className = "show";
    overlay.innerHTML = `
        <div class="levelup-box">
            <div class="levelup-crown">👑</div>
            <div class="levelup-title">LEVEL UP!</div>
            <div class="levelup-level">LEVEL ${toLevel}</div>
            <div class="levelup-sub">You reached a new rank. Keep creating!</div>
            <div class="levelup-sub">Get your coin with your teacher!</div>
            <button class="levelup-btn" id="levelup-close-btn">CONTINUE</button>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => {
        overlay.classList.remove("show");
        setTimeout(() => overlay.remove(), 250);
    };

    document.getElementById("levelup-close-btn").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
    });
    // Auto-dismiss after 6s in case the student walks away
    setTimeout(() => {
        if (document.getElementById("levelup-overlay")) close();
    }, 6000);
}

// ==============================================
// SECTION 8e: FEATURED QUESTS (student side)
// ==============================================

/** Cached list of featured quests for the current week. */
let _featuredQuestsCache = null;
let _featuredQuestsCacheTime = 0;
const FEATURED_QUESTS_CACHE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch the current week's featured quests for this student's teacher.
 * Returns an array of { id, questId, giftName, giftImageUrl, weekKey }.
 * Cached for FEATURED_QUESTS_CACHE_MS to avoid hammering the DB.
 */
async function loadFeaturedQuestsForStudent(forceRefresh = false) {
    if (!forceRefresh && _featuredQuestsCache !== null
        && (Date.now() - _featuredQuestsCacheTime) < FEATURED_QUESTS_CACHE_MS) {
        return _featuredQuestsCache;
    }

    const profile = loadStudentProfile();
    if (!profile || !profile.teacher_code) {
        _featuredQuestsCache = [];
        _featuredQuestsCacheTime = Date.now();
        return [];
    }

    if (!TeacherCache.teacherId) {
        TeacherCache.framework = null;
        TeacherCache.loaded = false;
        await detectTeacherFramework();
    }
    if (!TeacherCache.teacherId) {
        _featuredQuestsCache = [];
        _featuredQuestsCacheTime = Date.now();
        return [];
    }

    const weekKey = getISOWeekKey();

    let query = window.supabase
        .from('teacher_featured_quests')
        .select('quest_id, gift_name, gift_image_url, week_key, class_id')
        .eq('teacher_id', TeacherCache.teacherId)
        .eq('week_key', weekKey);

    // Filter by the student's class if they have one
    if (profile.class_id) {
        query = query.eq('class_id', profile.class_id);
    } else {
        // No class → nothing applies (matches required-quests behavior)
        _featuredQuestsCache = [];
        _featuredQuestsCacheTime = Date.now();
        return [];
    }

    const { data, error } = await query;

    if (error) {

        _featuredQuestsCache = [];
        _featuredQuestsCacheTime = Date.now();
        return [];
    }

    // Deduplicate by quest_id (defensive — unique constraint should prevent this,
    // but we protect against stale data or future schema changes)
    const byQuest = new Map();
    for (const row of (data || [])) {
        if (!byQuest.has(row.quest_id)) {
            byQuest.set(row.quest_id, {
                questId: row.quest_id,
                giftName: row.gift_name,
                giftImageUrl: row.gift_image_url,
                weekKey: row.week_key
            });
        }
    }

    _featuredQuestsCache = Array.from(byQuest.values());
    _featuredQuestsCacheTime = Date.now();
    return _featuredQuestsCache;
}

function invalidateFeaturedQuestsCache() {
    _featuredQuestsCache = null;
    _featuredQuestsCacheTime = 0;
}

/**
 * Render the lower-left panel with silhouettes for each featured quest.
 * Called on load, on demand, and after any state that might change things
 * (e.g. after grading updates the student's completed quests).
 */
async function renderFeaturedQuestsPanel() {
    const panel = document.getElementById("featured-quests-panel");
    if (!panel) return;

    const featured = await loadFeaturedQuestsForStudent();
    if (!featured || featured.length === 0) {
        panel.classList.remove("visible");
        panel.innerHTML = "";
        panel.setAttribute("aria-hidden", "true");
        return;
    }

    const weekKey = getISOWeekKey();
    const claimMap = await loadGiftClaimsForWeek(weekKey);

    panel.innerHTML = "";
    let renderedCount = 0;

    for (const item of featured) {
        const state = await getGiftStateForQuest(item.questId, claimMap);
        if (state === null) continue;             // quest gone
        if (state === "gone") continue;           // already revealed

        const quest = quests[item.questId];
        if (!quest) continue;

        const el = document.createElement("div");
        el.className = "featured-quest-item";
        el.dataset.questId = item.questId;
        el.dataset.state = state;

        const img = document.createElement("img");
        img.draggable = false;
        img.alt = quest.title || item.questId;

        if (state === "gift-box") {
            img.src = "charimage/gift-box.png";
            img.classList.add("gift-box-img");
            el.title = "You earned a gift! Click to open it.";
            el.classList.add("gift-box");
        } else {
            img.src = quest.character || "profile.png";
            img.classList.add("silhouette-img");
            if (state === "retry") {
                el.title = "You didn't reach the threshold yet. Click for details.";
                el.classList.add("retry");
            } else {
                el.title = "Featured quest this week";
            }
        }

        el.appendChild(img);

        el.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state === "gift-box") {
                const claim = claimMap.get(item.questId);
                if (!claim) {
                    openGiftRevealModal(
                        item.questId,
                        item.giftName,
                        item.giftImageUrl,
                        null
                    );
                } else {
                    openGiftRevealModal(
                        item.questId,
                        claim.gift_name || item.giftName,
                        claim.gift_image_url || item.giftImageUrl,
                        claim.id
                    );
                }
            } else if (state === "retry") {
                showGiftRetryPopup(item.questId);
            } else {
                openQuest(item.questId);
            }
        });

        panel.appendChild(el);
        renderedCount++;
    }

    if (renderedCount === 0) {
        panel.classList.remove("visible");
        panel.setAttribute("aria-hidden", "true");
    } else {
        panel.classList.add("visible");
        panel.setAttribute("aria-hidden", "false");
    }
}

// ==============================================
// SECTION 8f: GIFT REVEAL + THRESHOLD LOGIC
// ==============================================

/** Threshold wording per framework. */
const GIFT_THRESHOLD_TEXT = {
    ncas:   "You need a grade of 3 or higher on every standard.",
    "ib-myp": "You need a band of 5-6 or higher on every criterion.",
    igcse:  "You need a grade of B or higher on every assessment objective."
};

/**
 * Returns true if every *graded* standard for this quest meets the gift
 * threshold for the current framework.
 * - Ignores ungraded standards (partial grades still pass).
 * - Requires at least one graded standard (empty = fail).
 * - Rejects 0s for NCAS (a 0 doesn't count as earning).
 */
function meetsGiftThreshold(questId) {
    const quest = quests[questId];
    if (!quest) return false;

    const column = quest.style === "mvp" ? "mvpGrade" : "grade";
    const grades = questGrades[questId]?.[column];
    if (!grades || typeof grades !== "object") return false;

    const framework = TeacherCache.framework || "ncas";

    let anyGraded = false;
    for (const [key, value] of Object.entries(grades)) {
        if (key === "teacher_comment" || key === "completed_at") continue;
        if (value === null || value === undefined || value === "") continue;

        anyGraded = true;

        if (framework === "ncas") {
            const num = parseFloat(value);
            if (isNaN(num)) return false;
            if (num < 3) return false;
        } else if (framework === "ib-myp") {
            const s = String(value).trim();
            if (s === "7-8" || s === "5-6") continue;
            const num = parseFloat(s);
            if (!isNaN(num) && num >= 5) continue;
            return false;
        } else if (framework === "igcse") {
            const s = String(value).trim().toUpperCase();
            if (s === "A*" || s === "A" || s === "B") continue;
            return false;
        }
    }

    return anyGraded;
}

/**
 * Returns the state of a featured quest tile for the current student:
 *   "silhouette" — not yet completed (or completed but not graded)
 *   "retry"      — completed + graded + below threshold
 *   "gift-box"   — completed + graded + meets threshold + claim not revealed
 *   "gone"       — gift already revealed
 *   null         — quest doesn't exist (skip entirely)
 */
async function getGiftStateForQuest(questId, claimMap) {
    const quest = quests[questId];
    if (!quest) return null;

    const isCompleted = completedQuests[questId] === true;

    // Look up existing claim for this student/quest/week
    const claim = claimMap?.get(questId) || null;
    if (claim) {
        if (claim.revealed_at) return "gone";
        return "gift-box";
    }

    // No claim yet
    if (!isCompleted) return "silhouette";

    // Completed: is it graded?
    const hasGrades = hasAnyEarnedGradeForQuest(questId);
    if (!hasGrades) return "silhouette";   // still awaiting grade

    // Graded: does it meet the threshold?
    if (meetsGiftThreshold(questId)) return "gift-box";  // gift earned (server may not have a claim yet)
    return "retry";
}

/**
 * Fetch this student's gift claims for the given week, keyed by questId.
 * Returns an empty Map if not logged in or on error.
 */
async function loadGiftClaimsForWeek(weekKey) {
    const map = new Map();
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return map;

    const { data, error } = await window.supabase
        .from('gift_claims')
        .select('id, quest_id, gift_name, gift_image_url, revealed_at')
        .eq('student_id', session.user.id)
        .eq('week_key', weekKey);

    if (error) {

        return map;
    }

    for (const row of (data || [])) {
        map.set(row.quest_id, row);
    }
    return map;
}

/**
 * The retry popup. Reuses the structure/conventions of the
 * restriction popups you already have.
 */
function showGiftRetryPopup(questId) {
    const quest = quests[questId];
    const title = quest?.title || questId;
    const framework = TeacherCache.framework || "ncas";
    const thresholdText = GIFT_THRESHOLD_TEXT[framework] || GIFT_THRESHOLD_TEXT.ncas;

    // Remove any prior popup
    document.querySelectorAll(".gift-retry-popup").forEach(el => el.remove());

    const popup = document.createElement("div");
    popup.className = "gift-retry-popup";
    popup.innerHTML = `
        <div class="gift-retry-popup-inner">
            <div class="gift-retry-popup-title">⚠️ Not quite there yet</div>
            <div class="gift-retry-popup-body">
                <p><strong>${escapeHtml(title)}</strong></p>
                <p>Sorry, you did not reach the minimum grade for a reward.</p>
                <p class="gift-retry-threshold">${escapeHtml(thresholdText)}</p>
                <p>You can redo the work and submit again!</p>
            </div>
            <div class="gift-retry-popup-actions">
                <button class="gift-retry-open-btn">Open quest</button>
                <button class="gift-retry-close-btn">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(popup);

    // Wire buttons
    popup.querySelector(".gift-retry-open-btn").addEventListener("click", () => {
        popup.remove();
        openQuest(questId);
    });
    popup.querySelector(".gift-retry-close-btn").addEventListener("click", () => {
        popup.remove();
    });
    popup.addEventListener("click", (e) => {
        if (e.target === popup) popup.remove();
    });
}

/**
 * The gift reveal modal controller.
 * Opens the modal with the given gift data, wires all interactions,
 * persists revealed_at on close.
 */
let _giftRevealState = null;

function openGiftRevealModal(questId, giftName, giftImageUrl, claimId) {
    const overlay = document.getElementById("gift-reveal-overlay");
    const boxWrap = document.getElementById("gift-reveal-box-wrap");
    const resultEl = document.getElementById("gift-reveal-result");
    const hintEl = document.getElementById("gift-reveal-hint");
    const flashEl = document.getElementById("gift-reveal-flash");
    const giftImgEl = document.getElementById("gift-reveal-gift-img");
    const messageEl = document.getElementById("gift-reveal-message");
    const confettiEl = document.getElementById("gift-reveal-confetti");

    if (!overlay || !boxWrap || !resultEl) return;

    // Reset
    boxWrap.classList.remove("hidden", "winding");
    resultEl.style.display = "none";
    hintEl.classList.remove("hidden");
    flashEl.classList.remove("fire");
    confettiEl.innerHTML = "";

    giftImgEl.src = giftImageUrl;
    messageEl.innerHTML =
        `You earned <strong>${giftName}</strong>.<br>` +
        `See your teacher to claim your reward!`;

    // Store state for the reveal step
    _giftRevealState = {
        questId,
        giftName,
        giftImageUrl,
        claimId,
        woundUp: false,
        revealing: false
    };

    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");

    // Play the sound when the box appears (user already clicked to open modal)
    playGiftRevealSound();

    // Click the box → wind up
    const onBoxClick = () => {
        if (!_giftRevealState || _giftRevealState.woundUp) return;
        _giftRevealState.woundUp = true;

        boxWrap.classList.add("winding");

        // After the wind-up, flash + reveal
        setTimeout(() => {
            if (!_giftRevealState) return;
            _giftRevealState.revealing = true;
            flashEl.classList.add("fire");

            setTimeout(() => {
                boxWrap.classList.add("hidden");
                hintEl.classList.add("hidden");
                resultEl.style.display = "block";
                startConfetti(confettiEl);
            }, 240);   // hide box near peak of flash
        }, 1500);       // wind-up duration
    };

    boxWrap.addEventListener("click", onBoxClick);

    // Close
    const close = async () => {
    // Blur any focused element inside the overlay before hiding it,
    // otherwise the browser blocks aria-hidden and logs a warning.
    if (document.activeElement && overlay.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
    boxWrap.removeEventListener("click", onBoxClick);
    confettiEl.innerHTML = "";

        // Persist revealed_at if the reveal actually happened
        if (_giftRevealState && _giftRevealState.claimId) {
            try {
                await window.supabase
                    .from("gift_claims")
                    .update({ revealed_at: new Date().toISOString() })
                    .eq("id", _giftRevealState.claimId);
            } catch (e) {

            }
        }

        _giftRevealState = null;

        // Refresh the panel so the tile disappears
        invalidateFeaturedQuestsCache();
        renderFeaturedQuestsPanel();
    };

    document.getElementById("gift-reveal-close-btn").onclick = close;
    overlay.onclick = (e) => {
        if (e.target === overlay) close();
    };
}

/**
 * Confetti — a lightweight DOM-based particle system.
 * No canvas, no external library. Good enough for a short burst.
 */
function startConfetti(container) {
    if (!container) return;
    const colors = ["#ffd700", "#ff6b6b", "#4ecdc4", "#95e1d3", "#f38181", "#aa96da", "#ffffff"];
    const count = 90;
    for (let i = 0; i < count; i++) {
        const piece = document.createElement("div");
        piece.className = "confetti-piece";
        const color = colors[Math.floor(Math.random() * colors.length)];
        const size = 6 + Math.random() * 8;
        const left = Math.random() * 100;
        const duration = 1.8 + Math.random() * 1.6;
        const delay = Math.random() * 0.6;
        piece.style.background = color;
        piece.style.left = `${left}%`;
        piece.style.width = `${size}px`;
        piece.style.height = `${size * 1.4}px`;
        piece.style.animationDuration = `${duration}s`;
        piece.style.animationDelay = `${delay}s`;
        piece.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
        container.appendChild(piece);
    }
    // Clean up after the longest animation finishes
    setTimeout(() => {
        if (container) container.innerHTML = "";
    }, 4500);
}

/**
 * Sound — plays sounds/gift-reveal.mp3 if it exists.
 * Silent no-op if missing. Logs a warning once per session.
 */
let _giftSoundWarned = false;
function playGiftRevealSound() {
    try {
        const audio = new Audio("sounds/gift-reveal.mp3");
        audio.volume = 0.6;
        const p = audio.play();
        if (p && p.catch) {
            p.catch(() => {
                if (!_giftSoundWarned) {

                    _giftSoundWarned = true;
                }
            });
        }
    } catch (e) {
        if (!_giftSoundWarned) {

            _giftSoundWarned = true;
        }
    }
}

// ==============================================
// SECTION 8g: MYSTERY GIFT TAB (all-time list)
// ==============================================

let _mysteryGiftCache = null;
let _mysteryGiftCacheTime = 0;
const MYSTERY_GIFT_CACHE_MS = 5 * 60 * 1000;

/**
 * Load every mystery gift the teacher created for this student's class,
 * LEFT-merged with this student's claim state on each.
 *
 * Visibility on the UI is driven ONLY by `revealedAt` — never by
 * `completedQuests` — so a student who completes the quest late still
 * sees the silhouette if they never opened the box.
 *
 * Returns an array of:
 *   { questId, weekKey, giftName, giftImageUrl, revealedAt, earnedAt }
 * sorted oldest → newest by week_key.
 */
async function loadAllMysteryGiftsForStudent(forceRefresh = false) {
    if (!forceRefresh && _mysteryGiftCache !== null
        && (Date.now() - _mysteryGiftCacheTime) < MYSTERY_GIFT_CACHE_MS) {
        return _mysteryGiftCache;
    }

    const profile = loadStudentProfile();
    if (!profile || !profile.teacher_code || !profile.class_id) {
        _mysteryGiftCache = [];
        _mysteryGiftCacheTime = Date.now();
        return [];
    }

    // Make sure we know the teacher id
    if (!TeacherCache.teacherId) {
        TeacherCache.framework = null;
        TeacherCache.loaded = false;
        await detectTeacherFramework();
    }
    if (!TeacherCache.teacherId) {
        _mysteryGiftCache = [];
        _mysteryGiftCacheTime = Date.now();
        return [];
    }

    // --- 1. All gifts created for this class ---
    const { data: featured, error: featuredErr } = await window.supabase
        .from('teacher_featured_quests')
        .select('quest_id, week_key, gift_name, gift_image_url')
        .eq('teacher_id', TeacherCache.teacherId)
        .eq('class_id', profile.class_id)
        .order('week_key', { ascending: true });   // older first

    if (featuredErr) {

        _mysteryGiftCache = [];
        _mysteryGiftCacheTime = Date.now();
        return [];
    }

    if (!featured || featured.length === 0) {
        _mysteryGiftCache = [];
        _mysteryGiftCacheTime = Date.now();
        return [];
    }

    // --- 2. This student's claims on those quests ---
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {
        _mysteryGiftCache = [];
        _mysteryGiftCacheTime = Date.now();
        return [];
    }

    const { data: claims, error: claimsErr } = await window.supabase
        .from('gift_claims')
        .select('quest_id, week_key, revealed_at, earned_at')
        .eq('student_id', session.user.id)
        .eq('teacher_id', TeacherCache.teacherId);

    if (claimsErr) {

    }

    const claimMap = new Map();
    for (const c of (claims || [])) {
        claimMap.set(`${c.quest_id}::${c.week_key}`, c);
    }

    // --- 3. Merge ---
    const rows = featured.map(f => {
        const claim = claimMap.get(`${f.quest_id}::${f.week_key}`) || null;
        return {
            questId:      f.quest_id,
            weekKey:      f.week_key,
            giftName:     f.gift_name,
            giftImageUrl: f.gift_image_url,
            revealedAt:   claim?.revealed_at || null,
            earnedAt:     claim?.earned_at   || null
        };
    });

    _mysteryGiftCache = rows;
    _mysteryGiftCacheTime = Date.now();
    return rows;
}

function invalidateMysteryGiftCache() {
    _mysteryGiftCache = null;
    _mysteryGiftCacheTime = 0;
}

/**
 * Format "2026-W41" → "Week of Oct 6, 2026" (ISO week Monday).
 * Falls back to the raw key on any parse issue.
 */
function formatWeekKey(weekKey) {
    try {
        const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
        if (!m) return weekKey;
        const year = parseInt(m[1], 10);
        const week = parseInt(m[2], 10);
        // ISO week 1 contains Jan 4
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const dayOfWeek = jan4.getUTCDay() || 7;
        const week1Monday = new Date(jan4);
        week1Monday.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));
        const target = new Date(week1Monday);
        target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
        return target.toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric'
        });
    } catch {
        return weekKey;
    }
}

/**
 * Render the mystery gift list into #mystery-gift-list.
 */
async function renderMysteryGiftList() {
    const container = document.getElementById('mystery-gift-list');
    if (!container) return;

    container.innerHTML = `<div class="mystery-gift-empty">Loading…</div>`;

    const rows = await loadAllMysteryGiftsForStudent();

    if (!rows || rows.length === 0) {
        container.innerHTML = `<div class="mystery-gift-empty">
            No mystery gifts have been set for your class yet.
        </div>`;
        return;
    }

    container.innerHTML = '';

    // Ensure a shared tooltip element exists
    let tooltip = document.getElementById('mystery-gift-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'mystery-gift-tooltip';
        tooltip.className = 'mystery-gift-tooltip';
        document.body.appendChild(tooltip);
    }

    for (const row of rows) {
        const quest = quests[row.questId];
        if (!quest) continue;   // skip gifts for quests that no longer exist

        const isRevealed = row.revealedAt !== null && row.revealedAt !== undefined;

        const item = document.createElement('div');
        item.className = 'mystery-gift-item';
        item.dataset.revealed = isRevealed ? '1' : '0';
        item.dataset.questId = row.questId;

        // --- Character ---
        const charWrap = document.createElement('div');
        charWrap.className = 'mystery-gift-char';

        const img = document.createElement('img');
        img.draggable = false;
        img.src = quest.character || 'profile.png';
        img.alt = isRevealed ? (quest.title || row.questId) : 'Mystery gift';
        charWrap.appendChild(img);

        // --- Completed badge (only when revealed) ---
        if (isRevealed) {
            const badge = document.createElement('div');
            badge.className = 'mystery-gift-badge';
            const badgeImg = document.createElement('img');
            badgeImg.src = 'completed.png';
            badgeImg.alt = 'Revealed';
            badge.appendChild(badgeImg);
            charWrap.appendChild(badge);
        }

        item.appendChild(charWrap);

        // --- Caption ---
        const caption = document.createElement('div');
        caption.className = 'mystery-gift-caption';

        const titleEl = document.createElement('span');
        titleEl.className = 'title';
        titleEl.textContent = isRevealed ? (quest.title || row.questId) : '???';

        const weekEl = document.createElement('span');
        weekEl.className = 'week';
        weekEl.textContent = formatWeekKey(row.weekKey);

        caption.appendChild(titleEl);
        caption.appendChild(weekEl);
        item.appendChild(caption);

        // --- Tooltip (only when revealed) ---
        if (isRevealed) {
            const claimedDate = new Date(row.revealedAt);
            const claimedText = `Reward claimed on ${claimedDate.toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric'
            })}`;

            item.addEventListener('mouseenter', () => {
                tooltip.textContent = claimedText;
                tooltip.classList.add('show');
            });
            item.addEventListener('mousemove', (e) => {
                const tr = tooltip.getBoundingClientRect();
                let left = e.clientX + 14;
                let top  = e.clientY + 14;
                if (left + tr.width + 8 > window.innerWidth) left = e.clientX - tr.width - 14;
                if (top + tr.height + 8 > window.innerHeight) top = e.clientY - tr.height - 14;
                tooltip.style.left = left + 'px';
                tooltip.style.top  = top + 'px';
            });
            item.addEventListener('mouseleave', () => {
                tooltip.classList.remove('show');
            });
        }

        // --- Click → open quest, hide overlay, remember to reopen ---
        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Hide the achievements overlay
            const achOverlay = document.getElementById('achievements-overlay');
            if (achOverlay) achOverlay.style.display = 'none';

            // Flag so closeQuest() reopens this overlay
            window._reopenAchievementsAfterQuest = true;
            window._reopenAchievementsTab = 'mysterygift';

            // Hide any lingering tooltip
            if (tooltip) tooltip.classList.remove('show');

            if (typeof openQuest === 'function') openQuest(row.questId);
        });

        container.appendChild(item);
    }

    if (container.children.length === 0) {
        container.innerHTML = `<div class="mystery-gift-empty">
            No mystery gifts to show.
        </div>`;
    }
}

// ==============================================
// SECTION 9: INTEREST TOGGLE (MVP quests only)
// ==============================================

function renderInterestToggle(questId, quest) {
    const label = document.getElementById("quest-interest-label");
    const checkbox = document.getElementById("quest-interest-checkbox");
    if (!label || !checkbox) return;

    // Only MVP quests get the toggle
    if (!quest || quest.style !== "mvp") {
        label.style.display = "none";
        checkbox.checked = false;
        checkbox.onchange = null;
        return;
    }

    // Ensure interest map exists
    if (!window.interestState) window.interestState = {};

    // Set initial checked state (from cache; the cloud load will refresh it)
    checkbox.checked = window.interestState[questId] === true;

    // Show it
    label.style.display = "inline-flex";

    // Wire the change handler (clone-free: just reassign onchange)
        checkbox.onchange = () => {
        const interested = checkbox.checked;

        // Update in-memory state
        if (interested) {
            window.interestState[questId] = true;
        } else {
            delete window.interestState[questId];
        }

        // Fire-and-forget — no need to block the UI on the DB write.
        saveInterestToCloud().catch(e => console.warn("Interest save failed:", e));
    };
}

async function saveInterestToCloud() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return;

    _pendingInterestWrite = true;

    try {
        const userId = session.user.id;

        const { data: existing } = await window.supabase
            .from('student_progress')
            .select('completed_quests, quest_grades, quest_accepted, quest_start_times, earned_badges, self_assessments')
            .eq('user_id', userId)
            .maybeSingle();

        const row = {
            user_id: userId,
            is_interested: window.interestState || {},
            updated_at: new Date().toISOString(),
            completed_quests: existing?.completed_quests || {},
            quest_grades: existing?.quest_grades || {},
            quest_accepted: existing?.quest_accepted || {},
            quest_start_times: existing?.quest_start_times || {},
            earned_badges: existing?.earned_badges || {},
            self_assessments: existing?.self_assessments || {}
        };

        const { error } = await window.supabase
            .from('student_progress')
            .upsert(row, { onConflict: 'user_id' });

        if (error) {

        } else {

        }
    } finally {
        _pendingInterestWrite = false;
    }
}
// ==============================================
// SECTION 9b: QUEST PROGRESS TREE — overlay open/close
// ==============================================

async function openQuestTree() {
    const overlay = document.getElementById("quest-tree-overlay");
    if (!overlay) return;

    // 1. Show the overlay immediately — feels instant.

    overlay.style.display = "block";
        // Always open on the Quest Progress Tree tab
    if (typeof initializeTreeTabs === 'function') {
        initializeTreeTabs();
    }

    if (typeof invalidateTreeCompletedCache === 'function') {
        invalidateTreeCompletedCache();    // ← NEW
    }
    const avatarEl = document.getElementById("tree-student-avatar");
    const profile = loadStudentProfile();
    if (avatarEl && profile && profile.character) {
        avatarEl.src = profile.character;
    }
    // 2. Render trees + required block + free assignments from in-memory data.
    //    The required block shows "Loading…" and fills in async.
    renderQuestTree();

    // 3. Draw SVG connectors for the trees that are already rendered.
    requestAnimationFrame(() => {
        redrawAllTreeConnectors();
        setTimeout(redrawAllTreeConnectors, 50);
    });

    // 4. Refresh student data in the background.
    //    When it resolves, re-render so the freshest state wins.
    if (typeof loadStudentDataFromCloud === 'function') {
        loadStudentDataFromCloud()
            .then(() => {
                renderQuestTree();
                requestAnimationFrame(redrawAllTreeConnectors);
            })
            .catch(e => console.warn("Background student data load failed:", e));
    }
}

function closeQuestTree() {
    const overlay = document.getElementById("quest-tree-overlay");
    if (overlay) overlay.style.display = "none";
}

function initializeTreeTabs() {
    const tabBtns = document.querySelectorAll('#quest-tree-overlay .tree-tab-btn');
    const tabPanels = document.querySelectorAll('#quest-tree-overlay .tree-tab-content');

    if (!tabBtns.length || !tabPanels.length) return;

    function activateTab(tabKey) {
        // Toggle buttons
        tabBtns.forEach(btn => {
            const isActive = btn.dataset.treeTab === tabKey;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        // Toggle panels
        tabPanels.forEach(panel => {
            const panelKey = panel.id.replace(/^tree-tab-/, '');
            panel.style.display = (panelKey === tabKey) ? 'block' : 'none';
        });

        // Redraw tree connectors if we just switched back to the tree tab
        if (tabKey === 'quest-tree' && typeof redrawAllTreeConnectors === 'function') {
            requestAnimationFrame(() => redrawAllTreeConnectors());
        }

                // Remember the current tab so openQuestTree can default to it if needed
        window._lastTreeTab = tabKey;

        // Load the Completed Quests panel content on demand
        if (tabKey === 'completed' && typeof renderTreeCompletedPanel === 'function') {
            renderTreeCompletedPanel();
        }
    }

    // Wire each button (clone-strip to avoid duplicate listeners on re-init)
    tabBtns.forEach(btn => {
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => {
            activateTab(fresh.dataset.treeTab);
        });
    });

    // Always open on the Quest Progress Tree tab
    activateTab('quest-tree');
}

function initializeQuestTree() {
    const closeBtn = document.getElementById("close-quest-tree");
    if (closeBtn) {
        const fresh = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(fresh, closeBtn);
        fresh.addEventListener("click", closeQuestTree);
    }

    const overlay = document.getElementById("quest-tree-overlay");
    if (overlay) {
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeQuestTree();
        });
    }
    initializeTreeTabs();
}

function renderQuestTree() {
    renderTreeGrid();
    renderRequiredBlock();
    renderFreeAssignments();
}

// ---------------------------------------------------------------
// Main grid: one tree per interested summative
// ---------------------------------------------------------------
function renderTreeGrid() {
    const grid = document.getElementById("tree-grid");
    if (!grid) return;

    const interests = window.interestState || {};
    const interestedIds = Object.keys(interests).filter(id => interests[id] === true);

    // Only keep ones that actually exist in the loaded quests
    // (protects against stale interest IDs for deleted quests)
    const validIds = interestedIds.filter(id => quests[id]);

    if (validIds.length === 0) {
        grid.innerHTML = `<div class="tree-empty-state">
            You haven't shown interest in any summative quest yet.<br>
            Open a summative quest and check the box next to its name to plan your path.
        </div>`;
        return;
    }

    grid.innerHTML = "";

    // Sort by numeric quest id so trees are ordered predictably
    validIds.sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ""), 10) || 0;
        const nb = parseInt(b.replace(/\D/g, ""), 10) || 0;
        return na - nb;
    });

    for (const summativeId of validIds) {
        const tree = buildTreeBlock(summativeId);
        if (tree) grid.appendChild(tree);
    }
}

// ---------------------------------------------------------------
// Build one tree block for a summative
// ---------------------------------------------------------------
function buildTreeBlock(summativeId) {
    const summative = quests[summativeId];
    if (!summative) return null;

    const block = document.createElement("div");
    block.className = "tree-block";

    // ---- Summative node (top) ----
    const summativeNode = document.createElement("div");
    summativeNode.className = "tree-node-summative";
    summativeNode.dataset.treeRole = "summative";
    summativeNode.textContent = summative.title || summativeId;
    summativeNode.addEventListener("click", () => {
        closeQuestTree();
        setTimeout(() => openQuest(summativeId), 100);
    });
    block.appendChild(summativeNode);

    // ---- "Completed" stamp (top-right corner) ----
    if (completedQuests[summativeId] === true) {
        const badge = document.createElement("div");
        badge.className = "tree-completed-badge";
        const img = document.createElement("img");
        img.src = "completed.png";   // adjust the path if it lives elsewhere
        img.alt = "Completed";
        badge.appendChild(img);
        block.appendChild(badge);
}

    // ---- Prerequisites ----
    const prereqIds = Array.isArray(summative.prerequisites)
        ? summative.prerequisites.filter(id => quests[id])
        : [];

    if (prereqIds.length === 0) {
        const note = document.createElement("div");
        note.className = "tree-no-prereqs";
        note.textContent = "No prerequisites";
        block.appendChild(note);
        return block;
    }

    // ---- Row of formatives ----
    const row = document.createElement("div");
    row.className = "tree-formatives-row";

    for (const prereqId of prereqIds) {
        const prereqQuest = quests[prereqId];
        const isLit = questAccepted[prereqId] === true || completedQuests[prereqId] === true;

        const node = document.createElement("div");
        node.className = "tree-node-formative";
        node.dataset.treeRole = "formative";
        node.dataset.questId = prereqId;
        node.dataset.lit = isLit ? "1" : "0";
        node.textContent = prereqQuest.title || prereqId;
        if (isLit) node.classList.add("lit");

        node.addEventListener("click", () => {
            closeQuestTree();
            setTimeout(() => openQuest(prereqId), 100);
        });

        row.appendChild(node);
    }

    block.appendChild(row);

    // ---- SVG overlay (empty for now; filled by drawTreeConnectors) ----
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("tree-svg");
    block.appendChild(svg);

    return block;
}

// ---------------------------------------------------------------
// Required block — inserted into the same grid as the trees
// ---------------------------------------------------------------
function renderRequiredBlock() {
    const grid = document.getElementById("tree-grid");
    if (!grid) return;

    // Build the block as a grid cell
    const block = document.createElement("div");
    block.className = "tree-required-block";

    const title = document.createElement("div");
    title.className = "tree-required-title";
    title.textContent = "Required Quests";
    block.appendChild(title);

    const list = document.createElement("div");
    list.className = "tree-required-list";
    list.id = "tree-required-list";
    block.appendChild(list);

    grid.appendChild(block);

    // Fill the list asynchronously — do NOT await here.
    // The block exists immediately with a "Loading…" placeholder;
    // the list swaps in when the query resolves.
    renderRequiredQuestList();

    // Position the block in the grid (existing layout logic)
    requestAnimationFrame(() => {
        applyRequiredBlockSpan(grid, block);
    });
}

async function renderRequiredQuestList() {
    const list = document.getElementById("tree-required-list");
    if (!list) return;

    // Synchronous placeholder — visible before the await below.
    list.innerHTML = `<div class="tree-required-empty">Loading…</div>`;

    const questIds = await getRequiredQuestIds();

    // Filter out quests that no longer exist
    const validIds = questIds.filter(id => quests[id]);

    if (validIds.length === 0) {
        list.innerHTML = `<div class="tree-required-empty">
            No required quests at this time.
        </div>`;
        return;
    }

    // Sort by numeric ID for stable ordering
    validIds.sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ""), 10) || 0;
        const nb = parseInt(b.replace(/\D/g, ""), 10) || 0;
        return na - nb;
    });

    list.innerHTML = "";
    for (const questId of validIds) {
        const quest = quests[questId];
        const isCompleted = completedQuests[questId] === true;

        const item = document.createElement("div");
        item.className = "tree-required-item";
        if (isCompleted) item.classList.add("completed");
        item.textContent = quest.title || questId;

        item.addEventListener("click", () => {
            closeQuestTree();
            setTimeout(() => openQuest(questId), 100);
        });

        list.appendChild(item);
    }
}
/**
 * Draws the connector lines for one tree block.
 * Must be called AFTER the block is in the DOM.
 */
function drawTreeConnectors(block) {
    const svg = block.querySelector(".tree-svg");
    const summativeNode = block.querySelector('[data-tree-role="summative"]');
    if (!svg || !summativeNode) return;

    const formativeNodes = block.querySelectorAll('[data-tree-role="formative"]');
    if (formativeNodes.length === 0) return;

    const blockRect = block.getBoundingClientRect();

    // Match the SVG to the block's current pixel size
    const svgWidth = blockRect.width;
    const svgHeight = blockRect.height;
    svg.setAttribute("width", svgWidth);
    svg.setAttribute("height", svgHeight);
    svg.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);

    // Clear previous drawing
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Summative bottom-center
    const summRect = summativeNode.getBoundingClientRect();
    const startX = summRect.left - blockRect.left + summRect.width / 2;
    const startY = summRect.bottom - blockRect.top;

    // Pick a bar Y halfway between the summative bottom and the
    // top of the FIRST formative row (whichever formative is topmost).
    let topmostFormativeY = Infinity;
    for (const node of formativeNodes) {
        const r = node.getBoundingClientRect();
        const top = r.top - blockRect.top;
        if (top < topmostFormativeY) topmostFormativeY = top;
    }
    const gap = Math.max(10, topmostFormativeY - startY);
    const barY = startY + gap * 0.5;

    // Shared vertical stub: summative bottom → bar
    const topStub = document.createElementNS("http://www.w3.org/2000/svg", "line");
    topStub.setAttribute("x1", startX);
    topStub.setAttribute("y1", startY);
    topStub.setAttribute("x2", startX);
    topStub.setAttribute("y2", barY);
    topStub.setAttribute("stroke", "#cccccc");
    topStub.setAttribute("stroke-width", "2");
    svg.appendChild(topStub);

    // One L-shaped path per formative
    for (const node of formativeNodes) {
        const r = node.getBoundingClientRect();
        const targetX = r.left - blockRect.left + r.width / 2;
        const targetY = r.top - blockRect.top;

        const isLit = node.dataset.lit === "1";
        const strokeColor = isLit ? "#4a90d9" : "#cccccc";

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        // From the bar at the summative's x, go horizontally to the
        // formative's x, then vertically down to its top.
        path.setAttribute(
            "d",
            `M ${startX} ${barY} L ${targetX} ${barY} L ${targetX} ${targetY}`
        );
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", strokeColor);
        path.setAttribute("stroke-width", "2");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
    }
}

/**
 * Redraw connectors for every tree block currently in the tree grid.
 */
function redrawAllTreeConnectors() {
    const blocks = document.querySelectorAll("#tree-grid .tree-block");
    for (const block of blocks) drawTreeConnectors(block);
}

// ---------------------------------------------------------------
// Required block (stub for now — real data in step 9)
// ---------------------------------------------------------------
function applyRequiredBlockSpan(grid, block) {
    if (!grid || !block) return;

    const gridStyle = window.getComputedStyle(grid);
    const columnGap = parseFloat(gridStyle.columnGap) || 0;
    const minColumnWidth = 360;   // matches grid-template minmax

    const gridWidth = grid.clientWidth;
    const columnCount = Math.max(
        1,
        Math.floor((gridWidth + columnGap) / (minColumnWidth + columnGap))
    );

    const treeCount = grid.querySelectorAll(".tree-block").length;

    if (treeCount === 0) {
        // No trees — required block spans the full grid width
        block.style.gridColumn = `1 / -1`;
        return;
    }

    const treesInLastRow = treeCount % columnCount;

    if (treesInLastRow === 0) {
        // Last tree row is full → required block starts a new row, spans all columns
        block.style.gridColumn = `1 / -1`;
    } else {
        // Last tree row has a free last column → put the required block there.
        // Any columns between the last tree and the last column stay empty.
        block.style.gridColumn = `${columnCount}`;
    }
}

// ---------------------------------------------------------------
// Free assignments strip
// ---------------------------------------------------------------
function renderFreeAssignments() {
    const list = document.getElementById("tree-free-list");
    if (!list) return;

    const interests = window.interestState || {};
    const interestedSummativeIds = Object.keys(interests).filter(id => interests[id] === true);

    // --- Step 1: collect every formative that is a prerequisite of an interested summative ---
    const claimedFormatives = new Set();
    for (const summativeId of interestedSummativeIds) {
        const summative = quests[summativeId];
        if (!summative || !Array.isArray(summative.prerequisites)) continue;
        for (const prereqId of summative.prerequisites) {
            claimedFormatives.add(prereqId);
        }
    }

    // --- Step 2: gather candidates = every formative the student has accepted OR completed ---
    //     Using a Set to dedupe (a quest can be both accepted and completed in
    //     some edge cases when data hasn't been synced).
    const candidateIds = new Set();
    for (const [questId, isAccepted] of Object.entries(questAccepted || {})) {
        if (isAccepted === true) candidateIds.add(questId);
    }
    for (const [questId, isCompleted] of Object.entries(completedQuests || {})) {
        if (isCompleted === true) candidateIds.add(questId);
    }

    // --- Step 3: filter out quests that don't exist, are summatives, or are claimed by a tree ---
    const freeIds = [];
    for (const questId of candidateIds) {
        const quest = quests[questId];
        if (!quest) continue;                          // not loaded / deleted
        if (quest.style === "mvp") continue;           // MVP quests aren't "free assignments"
        if (claimedFormatives.has(questId)) continue;  // already shown in an interested tree
        freeIds.push(questId);
    }

    // --- Step 4: render, sorted by quest number for stability ---
    freeIds.sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ""), 10) || 0;
        const nb = parseInt(b.replace(/\D/g, ""), 10) || 0;
        return na - nb;
    });

    if (freeIds.length === 0) {
        list.innerHTML = `<div class="tree-free-empty">No free assignments yet.</div>`;
        return;
    }

    list.innerHTML = "";
    for (const questId of freeIds) {
        const quest = quests[questId];
        const item = document.createElement("div");
        item.className = "tree-free-item";
        item.textContent = quest.title || questId;
        item.addEventListener("click", () => {
            closeQuestTree();
            setTimeout(() => openQuest(questId), 100);
        });
        list.appendChild(item);
    }
}

// ==============================================================
// SECTION 9c: REQUIRED QUESTS (student side)
// ==============================================================

/* for the student's class. */
async function getRequiredQuestIds() {
    // ---- Cache hit ----
    if (AppState.teacherData.requiredQuestsLoaded) {
        return AppState.teacherData.requiredQuests || [];
    }

    // ---- Ensure we know who the teacher is ----
    if (!TeacherCache.teacherId) {
        TeacherCache.framework = null;
        TeacherCache.loaded = false;
        await detectTeacherFramework();
    }
    if (!TeacherCache.teacherId) {

        return [];
    }

    // ---- Resolve the student's class ----
    const profile = loadStudentProfile();
    const classId = profile?.class_id || null;

    if (!classId) {
        // No class → no per-class requirements apply (we don't support
        // teacher-wide / NULL class_id requirements).
        AppState.teacherData.requiredQuests = [];
        AppState.teacherData.requiredQuestsLoaded = true;
        return [];
    }

    const { data, error } = await window.supabase
        .from('teacher_quest_requirements')
        .select('quest_id')
        .eq('teacher_id', TeacherCache.teacherId)
        .eq('class_id', classId);

    if (error) {

        // Don't cache on error — allow a retry next open.
        return [];
    }

    const questIds = (data || []).map(r => r.quest_id);

    AppState.teacherData.requiredQuests = questIds;
    AppState.teacherData.requiredQuestsLoaded = true;
    return questIds;
}

/**
 * Clears the required-quests cache so the next call re-queries.
 */
function invalidateRequiredQuestsCache() {
    AppState.teacherData.requiredQuestsLoaded = false;
    AppState.teacherData.requiredQuests = [];
}

// ==============================================
// SECTION 9d: COMPLETED QUESTS TAB (tree overlay)
// ==============================================

// Cache the last computed panel so tab switches don't recompute.
let _treeCompletedCache = null;
let _treeCompletedCacheTime = 0;
const TREE_COMPLETED_CACHE_MS = 3 * 1000; // 3 seconds — short, so updates feel snappy

/**
 * Build the data model for the Completed Quests panel.
 * Returns: { categories: [ { key, label, weight, quests: [ ... ] } ] }
 *
 * Each quest entry:
 *   {
 *     questId, title, style,
 *     completedAt,               // Date or null
 *     perCategoryAvg,            // number (avg of this quest's standards in THIS category)
 *     perCategoryPercent,        // number 0-100
 *     shareOfCategory,           // number 0-100 (equal share: 100 / nQuests in category)
 *     standards: [ { code, name, grade } ]
 *   }
 */
function buildTreeCompletedModel() {
    const model = { categories: [] };

    const categoryOrder = [
        { key: 'resolvedArtworks',    label: 'Resolved Artworks',              weight: 45 },
        { key: 'artStudy',            label: 'Art Study',                      weight: 20 },
        { key: 'independentResearch', label: 'Independent Art Research',       weight: 15 },
        { key: 'collaboration',       label: 'Art Community Collaboration',    weight: 10 },
        { key: 'materialCare',        label: 'Art Material and Resources Care',weight: 10 }
    ];

    // Map DB category string → bucket key
    const categoryToBucket = {
        'Resolved Artworks':                'resolvedArtworks',
        'Art Study':                        'artStudy',
        'Art Community Collaboration':      'collaboration',
        'Art Material and Resources Care':  'materialCare'
    };

    // Initialize category buckets
    const buckets = {};
    for (const c of categoryOrder) {
        buckets[c.key] = { ...c, quests: [] };
    }

    // ---- Pass 1: collect quests into buckets ----
    for (const [questId, isCompleted] of Object.entries(completedQuests || {})) {
        if (isCompleted !== true) continue;

        const quest = quests[questId];
        if (!quest) continue;

        const column = quest.style === 'mvp' ? 'mvpGrade' : 'grade';
        const grades = questGrades?.[questId]?.[column];
        if (!grades || typeof grades !== 'object') continue;

        const baseCategory = resolveQuestBaseCategory(quest);
        const baseBucket = categoryToBucket[baseCategory] || 'artStudy';

        // Group this quest's standards by target bucket
        // (a quest can touch multiple buckets if it has CN.10.1.IA)
        const standardsByBucket = {};

        // Preserve rubric order using the quest's rubric definition
        const rubricItems = getRubricItemsForQuest(quest);
        const rubricOrderIndex = new Map();
        rubricItems.forEach((item, idx) => rubricOrderIndex.set(item.code, idx));

        // Iterate grades but sort by rubric order so the display matches the quest
        const gradedEntries = Object.entries(grades)
            .filter(([code]) => code !== 'teacher_comment' && code !== 'completed_at')
            .map(([code, raw]) => ({ code, raw, num: parseFloat(raw) }))
            .filter(e => !isNaN(e.num))
            .sort((a, b) => {
                const ia = rubricOrderIndex.has(a.code) ? rubricOrderIndex.get(a.code) : 999;
                const ib = rubricOrderIndex.has(b.code) ? rubricOrderIndex.get(b.code) : 999;
                return ia - ib;
            });

        for (const entry of gradedEntries) {
            // ============================================================
            // HEADS UP (MS): this line contains the CN standard code.
            // For the middle school site, change 'Art.FA.CN.10.1.IA'
            // to the MS CN standard code.
            // ============================================================
            const bucketKey = (entry.code === INDEPENDENT_RESEARCH_STANDARD)
                ? 'independentResearch'
                : baseBucket;

            if (!standardsByBucket[bucketKey]) standardsByBucket[bucketKey] = [];
            standardsByBucket[bucketKey].push({
                code: entry.code,
                name: getStandardShortName(entry.code, quest),
                grade: entry.num
            });
        }

        // One entry per bucket this quest touched
        for (const [bucketKey, stds] of Object.entries(standardsByBucket)) {
            if (!stds.length) continue;

            const avg = stds.reduce((s, x) => s + x.grade, 0) / stds.length;

            // Completion date — from questGrades if available, else null
            const completedAt = _getQuestCompletionDate(questId);

            buckets[bucketKey].quests.push({
                questId,
                title: quest.title || questId,
                style: quest.style || '',
                completedAt,
                perCategoryAvg: avg,
                perCategoryPercent: gradeToPercent(avg) ?? 0,
                standards: stds
            });
        }
    }

    // ---- Pass 2: sort, compute shares ----
    for (const cat of Object.values(buckets)) {
        // Sort: most recent first; quests without a date fall to the bottom,
        // then tie-broken by quest number descending.
        cat.quests.sort((a, b) => {
            const ta = a.completedAt ? a.completedAt.getTime() : 0;
            const tb = b.completedAt ? b.completedAt.getTime() : 0;
            if (tb !== ta) return tb - ta;

            const na = parseInt(a.questId.replace(/\D/g, ''), 10) || 0;
            const nb = parseInt(b.questId.replace(/\D/g, ''), 10) || 0;
            return nb - na;
        });

        const n = cat.quests.length;
        const share = n > 0 ? (100 / n) : 0;
        for (const q of cat.quests) {
            q.shareOfCategory = share;
        }
    }

    model.categories = categoryOrder.map(c => buckets[c.key]);
    return model;
}

/**
 * Resolve the completion date for a quest, preferring graded-at, falling
 * back to updated_at, then to questStartTimes.
 */
function _getQuestCompletionDate(questId) {
    const g = questGrades?.[questId];
    if (g) {
        if (g.updated_at) return new Date(g.updated_at);
        if (g.graded_at)  return new Date(g.graded_at);
    }
    if (questStartTimes?.[questId]) return new Date(questStartTimes[questId]);
    return null;
}

/**
 * Returns the rubric items array (standards / criteria / AOs) for a quest,
 * or [] if none exist. Used to preserve rubric order.
 */
function getRubricItemsForQuest(quest) {
    if (!quest || !quest.rubric) return [];
    if (Array.isArray(quest.rubric.standards))              return quest.rubric.standards;
    if (Array.isArray(quest.rubric.criteria))               return quest.rubric.criteria;
    if (Array.isArray(quest.rubric.assessment_objectives))  return quest.rubric.assessment_objectives;
    return [];
}

/**
 * Short descriptor for a standard code (e.g. "Generate", "Reflect").
 * Prefers STANDARD_SHORT_NAMES if the code is known, else falls back
 * to whatever the rubric item provides, else empty string.
 */
function getStandardShortName(code, quest) {
    if (typeof STANDARD_SHORT_NAMES === 'object' && STANDARD_SHORT_NAMES[code]) {
        return STANDARD_SHORT_NAMES[code];
    }
    // Search the quest's own rubric
    const items = getRubricItemsForQuest(quest);
    const match = items.find(i => i.code === code);
    if (match) {
        if (match.name) return match.name;
        // Some rubric shapes use `shortName` or the standard code as a fallback
        if (match.shortName) return match.shortName;
    }
    // Fallback: last segment of the code, or the code itself
    return code;
}

/**
 * Render the Completed Quests panel into #tree-completed-panel.
 */
function renderTreeCompletedPanel() {
    const panel = document.getElementById('tree-completed-panel');
    if (!panel) return;

    // Cheap cache — avoid rebuilding within a few seconds
    const now = Date.now();
    if (_treeCompletedCache && (now - _treeCompletedCacheTime) < TREE_COMPLETED_CACHE_MS) {
        return; // panel already showing fresh content
    }

    const model = buildTreeCompletedModel();
    _treeCompletedCache = model;
    _treeCompletedCacheTime = now;

    panel.innerHTML = '';

    // Heading
    const heading = document.createElement('div');
    heading.className = 'tree-completed-heading';
    heading.textContent = 'Completed Quests';
    panel.appendChild(heading);

    // Accordions
    for (const cat of model.categories) {
        const acc = buildCategoryAccordion(cat);
        panel.appendChild(acc);
    }

    if (model.categories.every(c => c.quests.length === 0)) {
        const empty = document.createElement('div');
        empty.className = 'tree-completed-empty';
        empty.textContent = 'No completed quests yet.';
        panel.appendChild(empty);
    }
}

/**
 * Build one category accordion.
 */
function buildCategoryAccordion(cat) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-completed-category';

    // --- Header (clickable) ---
    const header = document.createElement('div');
    header.className = 'tree-completed-category-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

    const arrow = document.createElement('span');
    arrow.className = 'tree-completed-cat-arrow';
    arrow.textContent = '▶';

    const label = document.createElement('span');
    label.className = 'tree-completed-cat-label';
    label.textContent = cat.label;

    const count = document.createElement('span');
    count.className = 'tree-completed-cat-count';
    count.textContent = `(${cat.quests.length} ${cat.quests.length === 1 ? 'quest' : 'quests'})`;

    const weight = document.createElement('span');
    weight.className = 'tree-completed-cat-weight';
    weight.textContent = `${cat.weight}%`;

    header.appendChild(arrow);
    header.appendChild(label);
    header.appendChild(count);
    header.appendChild(weight);
    wrap.appendChild(header);

    // --- Body ---
    const body = document.createElement('div');
    body.className = 'tree-completed-category-body';

    if (cat.quests.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tree-completed-cat-empty';
        empty.textContent = 'No completed quests in this category.';
        body.appendChild(empty);
    } else {
        for (const q of cat.quests) {
            body.appendChild(buildQuestRow(q));
        }
    }

    wrap.appendChild(body);

    // Toggle (starts closed)
    header.addEventListener('click', () => toggleCategory(wrap));
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCategory(wrap);
        }
    });

    return wrap;
}

function toggleCategory(wrapEl) {
    const isOpen = wrapEl.classList.toggle('expanded');
    const arrow = wrapEl.querySelector('.tree-completed-cat-arrow');
    if (arrow) arrow.textContent = isOpen ? '▼' : '▶';
}

/**
 * Build the 4-row grid for a single quest.
 *
 * Row 1: Quest title  —  Share of category: X% of graded standards
 * Row 2: Quest average (left)  |  Standard1  |  Standard2  | ...
 * Row 3: (values)              |  grade1     |  grade2     | ...
 */
function buildQuestRow(q) {
    const row = document.createElement('div');
    row.className = 'tree-completed-quest';

    // --- Character image (overlaps the left border) ---
    const quest = quests[q.questId];
    if (quest?.character) {
        const charWrap = document.createElement('div');
        charWrap.className = 'tree-completed-quest-char';

        const img = document.createElement('img');
        img.src = quest.character;
        img.alt = quest.title || q.questId;
        img.draggable = false;

        charWrap.appendChild(img);
        row.appendChild(charWrap);
    }

    // --- Row 1: title + share ---
    const titleLine = document.createElement('div');
    titleLine.className = 'tree-completed-quest-title-line';

    const titleEl = document.createElement('span');
    titleEl.className = 'tree-completed-quest-title';
    titleEl.textContent = q.title;

    const shareEl = document.createElement('span');
    shareEl.className = 'tree-completed-quest-share';
    shareEl.textContent = `Share of category: ${q.shareOfCategory.toFixed(1)}% of graded standards`;

    titleLine.appendChild(titleEl);
    titleLine.appendChild(shareEl);
    row.appendChild(titleLine);

    // --- Grid: N columns = 1 (quest avg) + N standards ---
    const grid = document.createElement('div');
    grid.className = 'tree-completed-quest-grid';
    grid.style.gridTemplateColumns = `minmax(140px, 1.4fr) repeat(${q.standards.length}, minmax(90px, 1fr))`;

    // Header cells
    const avgHeader = document.createElement('div');
    avgHeader.className = 'tree-completed-cell tree-completed-cell-header';
    avgHeader.textContent = 'Quest average';
    grid.appendChild(avgHeader);

    for (const std of q.standards) {
        const cell = document.createElement('div');
        cell.className = 'tree-completed-cell tree-completed-cell-header';

        const codeEl = document.createElement('div');
        codeEl.className = 'tree-completed-std-code';
        codeEl.textContent = std.code;

        const nameEl = document.createElement('div');
        nameEl.className = 'tree-completed-std-name';
        nameEl.textContent = std.name;

        cell.appendChild(codeEl);
        cell.appendChild(nameEl);
        grid.appendChild(cell);
    }

    // Value cells
    const avgValue = document.createElement('div');
    avgValue.className = 'tree-completed-cell tree-completed-cell-value tree-completed-cell-avg';
    avgValue.textContent = `${q.perCategoryAvg.toFixed(2)} / 4 → ${q.perCategoryPercent.toFixed(2)}%`;
    grid.appendChild(avgValue);

    for (const std of q.standards) {
        const cell = document.createElement('div');
        cell.className = 'tree-completed-cell tree-completed-cell-value';
        cell.textContent = formatGradeDisplay(std.grade);
        grid.appendChild(cell);
    }

    row.appendChild(grid);
    return row;
}

function formatGradeDisplay(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'number') {
        // Show integer without decimals, else one decimal place
        return Number.isInteger(v) ? String(v) : v.toFixed(1);
    }
    return String(v);
}

/**
 * Invalidate the panel cache. Called after data refreshes.
 */
function invalidateTreeCompletedCache() {
    _treeCompletedCache = null;
    _treeCompletedCacheTime = 0;
}

// ==============================================
// SECTION 10: STUDENT PROFILE
// ==============================================

function saveStudentProfile(profile) {
    localStorage.setItem("studentProfile", JSON.stringify(profile));
}

function loadStudentProfile() {
    const data = localStorage.getItem("studentProfile");
    return data ? JSON.parse(data) : null;
}

function updateProfileUI() {
    const profile = loadStudentProfile();
    if (!profile) return;
    const avatar = document.getElementById("student-avatar");
    const name = document.getElementById("student-name");
    const profileBtn = document.querySelector(".profile-btn"); 
    const profileBtnImg = profileBtn ? profileBtn.querySelector("img") : null;
    if (avatar) avatar.src = profile.character;
    if (name) name.innerText = profile.name;
    if (profileBtnImg) {
        profileBtnImg.src = profile.character;
    }
        renderExpBar();
        if (typeof renderProfileExpBar === 'function') renderProfileExpBar();
}

function debugStudentProfile() {
    const profile = loadStudentProfile();





}

// ==============================================
// SECTION 11: LOGIN / LOGOUT
// ==============================================

async function handleLoginSubmit() {
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    const messageEl = document.getElementById("login-message");
    if (!email || !password) {
        if (messageEl) messageEl.textContent = "Please enter email and password";
        return;
    }
    if (messageEl) messageEl.textContent = "Logging in...";
    const { data, error } = await window.supabase.auth.signInWithPassword({
        email: email,
        password: password
    });
    if (error) {
        if (messageEl) messageEl.textContent = error.message;
        return;
    }
    const { data: profile, error: profileError } = await window.supabase
        .from('profiles')
        .select('grade_level')
        .eq('id', data.user.id)
        .single();
    if (profileError) {
        if (messageEl) messageEl.textContent = 'Error checking student profile';
        return;
    }
    if (profile?.grade_level === 'ms') {
        messageEl.textContent = 'This is the High School portal. Please use the Middle School portal.';
        await window.supabase.auth.signOut();
        setTimeout(() => {
            window.location.href = 'ms-index.html';
        }, 1500);
        return;
    }
    currentUserId = data.user.id;
    _lastSyncedLevel = null;
    _lastLevelSyncCheck = 0;
    document.getElementById("welcome-overlay").style.display = "none";
    await checkQuestCacheValidity();
    if (!quests || Object.keys(quests).length === 0) {
        messageEl.textContent = "Loading quests...";
        await new Promise((resolve) => {
            const checkQuests = setInterval(() => {
                if (quests && Object.keys(quests).length > 0) {
                    clearInterval(checkQuests);
                    resolve();
                }
            }, 100);
        });
    }
    messageEl.textContent = "Loading your data...";
await loadStudentDataFromCloud(true, true); // Force fresh load on login
TeacherCache.selectedStandards = {};
invalidateRequiredQuestsCache();

invalidateFeaturedQuestsCache();
try {
    await renderFeaturedQuestsPanel();
} catch (e) {
    console.warn("[featured] post-login render failed:", e);
}
updateProfileUI();
startActiveQuestTimerUpdates();

// ─── FIX: reload quests now that we know the teacher, then re-add hotspots ───
try {
    const freshQuests = await getAllQuestsForStudent(true);
    quests = freshQuests;
    cachedQuests = freshQuests;
    cachedQuestsIncludeCustom = true;

    // Rebuild relationships and the MVP dropdown
    AppState.relationshipsBuilt = false;
    buildQuestRelationships();
    buildPathQuests(true);

    // Remove old hotspots and re-add (this now includes custom quests)
    document.querySelectorAll('.hotspot.custom-quest-hotspot').forEach(h => h.remove());
    await addCustomQuestHotspots();
    bindHotspots();
} catch (e) {

}
// ─────────────────────────────────────────────────────────────────────────────

setTimeout(() => {
    setupRealtimeRefresh();
}, 1000);
}
function initializeLoginEnterKey() {
    const emailInput = document.getElementById("login-email");
    const passwordInput = document.getElementById("login-password");
    if (!emailInput || !passwordInput) return;

    const handleKey = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        handleLoginSubmit();
    };

    // Clone to avoid stacking listeners if this ever runs twice
    [emailInput, passwordInput].forEach(input => {
        const fresh = input.cloneNode(true);
        input.parentNode.replaceChild(fresh, input);
        fresh.addEventListener("keydown", handleKey);
    });
}

async function logout() {

    stopActiveQuestTimerUpdates();
    try {
        const { error } = await window.supabase.auth.signOut();
        if (error) {

            alert("Logout failed: " + error.message);
            return;
        }
        localStorage.removeItem('sb-qzxvwoyigrrpdywvhckk-auth-token');
        localStorage.clear();
        completedQuests = {};
        questGrades = {};
        studentWorks = {};
        rubricLocked = {};
        questAccepted = {};
        questStartTimes = {};
        earnedBadges = {};
        earnedBadges = {};
        expTotal = 0;
        expLog = {};
        localStorage.removeItem("expTotal");
        localStorage.removeItem("expLog");
        _celebratedKeys.clear();
        _lastRenderedLevel = null;
        _lastRenderedLevel = null;
        invalidateFeaturedQuestsCache();
        invalidateMysteryGiftCache();
        invalidateFeaturedWeekCache();
        invalidateAllCaches();
        _lastSyncedLevel = null;
        _lastLevelSyncCheck = 0;

        setTimeout(() => {
            window.location.reload();
        }, 500);
    } catch (err) {

    }
}

// ==============================================
// SECTION 12: MAP CONFIG & HELPERS
// ==============================================

// Single map — no map switching
function getMapForQuest(questId) {
    return "map1";
}

// ==============================================
// SECTION 13: SUMMATIVE PATH MENU (AUTO-BUILT)
// ==============================================

// Maps the dropdown's camelCase values to the human-readable
// path names stored inside each quest's `path` array.
const PATH_KEY_TO_NAME = {
    paintersPath:     "Painter Path",
    sketcherPath:     "Sketcher Path",
    watercoloursPath: "Watercolor Path",
    "3DPath":         "3D Path"
};

// Auto-built from `quests`. Populated once by buildPathQuests().
// Shape: { paintersPath: [ {id, title, style}, ... ], ... }
let _pathQuestsQuestCount = -1;

function buildPathQuests(force = false) {
    const currentCount = Object.keys(quests).length;

    // Skip if nothing changed and caller didn't force it
    if (!force && currentCount === _pathQuestsQuestCount) {
        return;
    }

    pathQuests = {};
    for (const key of Object.keys(PATH_KEY_TO_NAME)) {
        pathQuests[key] = [];
    }

    for (const [id, quest] of Object.entries(quests)) {
        if (!quest || quest.style !== "mvp") continue;

        const questPaths = Array.isArray(quest.path)
            ? quest.path
            : (quest.path ? [quest.path] : []);   // ← tolerate string shape too

        if (questPaths.length === 0) continue;

        for (const key of Object.keys(PATH_KEY_TO_NAME)) {
            const humanName = PATH_KEY_TO_NAME[key];
            if (questPaths.includes(humanName)) {
                pathQuests[key].push({
                    id,
                    title: quest.title,
                    style: "mvp"
                });
            }
        }
    }

    for (const key of Object.keys(pathQuests)) {
        pathQuests[key].sort((a, b) => {
            const na = parseInt(a.id.replace(/\D/g, ""), 10) || 0;
            const nb = parseInt(b.id.replace(/\D/g, ""), 10) || 0;
            return na - nb;
        });
    }

    _pathQuestsQuestCount = currentCount;

    console.log("pathQuests auto-built:", Object.fromEntries(
        Object.entries(pathQuests).map(([k, v]) => [k, v.length])
    ));
}

// ==============================================
// SECTION 14: HOTSPOT POSITIONING
// ==============================================

function initializeHotspotPositions() {
    document.querySelectorAll(".hotspot").forEach(hotspot => {
        const id = hotspot.dataset.city;
        const left = hotspot.style.left || hotspot.dataset.left;
        const top = hotspot.style.top || hotspot.dataset.top;
        if (left && top) {
            hotspotPositions[id] = { left: left, top: top };
        }
    });
    if (Object.keys(hotspotPositions).length === 0) {
        calculateHotspotPositions();
    }
}

function calculateHotspotPositions() {
    const mapImage = document.getElementById("map-image");
    const mapContainer = document.getElementById("map-container");
    if (!mapImage || !mapContainer) return;
    if (!mapImage.complete) {
        mapImage.onload = () => calculateHotspotPositions();
        return;
    }
    const mapRect = mapImage.getBoundingClientRect();
    const containerRect = mapContainer.getBoundingClientRect();
    document.querySelectorAll(".hotspot").forEach(hotspot => {
        const id = hotspot.dataset.city;
        const rect = hotspot.getBoundingClientRect();
        const leftPercent = ((rect.left + rect.width/2 - mapRect.left) / mapRect.width) * 100;
        const topPercent = ((rect.top + rect.height/2 - mapRect.top) / mapRect.height) * 100;
        hotspotPositions[id] = {
            left: `${leftPercent}%`,
            top: `${topPercent}%`
        };
    });
}
    function updateHotspotPositions() {
        const mapImage = document.getElementById("map-image");
        const mapContainer = document.getElementById("map-container");
        const floatingNav = document.getElementById("floating-nav");

        if (!mapImage || !mapContainer) return;

        const mapRect = mapImage.getBoundingClientRect();
        const containerRect = mapContainer.getBoundingClientRect();

        document.querySelectorAll(".hotspot").forEach(hotspot => {
            const id = hotspot.dataset.city;
            const position = hotspotPositions[id];

            if (position) {
                hotspot.style.left = position.left;
                hotspot.style.top = position.top;
                hotspot.style.transform = "translate(-50%, -50%)";
                // MS: All hotspots always visible
                hotspot.style.display = "block";
                hotspot.style.zIndex = "1000";
            }
        });
    }
// ==============================================
// SECTION 15: FLOATING NAVIGATION
// ==============================================

function initializeFloatingNavigation() {
    const floatingGallery = document.getElementById("floating-gallery");
    if (floatingGallery) {
        floatingGallery.addEventListener("click", () => {
            openGallery();
        });
    }
}

// ==============================================
// SECTION 16: BIND HOTSPOTS
// ==============================================

function bindHotspots() {
    document.querySelectorAll(".hotspot").forEach(hotspot => {
        const cityId = hotspot.dataset.city;

        // Prevent duplicate listeners by cloning the element
        // (cloneNode strips all existing event listeners)
        const freshHotspot = hotspot.cloneNode(true);
        hotspot.parentNode.replaceChild(freshHotspot, hotspot);

        // Accessibility: announce the quest name to screen readers
        const questForLabel = quests[cityId];
        if (questForLabel?.title) {
            freshHotspot.setAttribute("aria-label", `Quest: ${questForLabel.title}`);
}

        // Now attach exactly ONE listener to the fresh element
        if (cityId.startsWith('custom_')) {

            freshHotspot.addEventListener("click", () => {

                openQuest(cityId);
            });
        }
        else if (quests[cityId]?.style === "mvp") {
            freshHotspot.classList.add("mvp-hotspot");
            freshHotspot.addEventListener("click", () => {
                openQuest(cityId);
            });
        }
        else {
            freshHotspot.addEventListener("click", () => {
                openQuest(cityId);
            });
        }
    });
}

// ==============================================
// SECTION 16b: HOTSPOT HOVER TOOLTIPS
// ==============================================

function initializeHotspotTooltips() {
    // Skip entirely on touch-only devices
    const isTouchDevice = window.matchMedia("(hover: none)").matches;
    if (isTouchDevice) return;

    const mapContainer = document.getElementById("map-container");
    const tooltip = document.getElementById("hotspot-tooltip");
    if (!mapContainer || !tooltip) {

        return;
    }

    const titleTextEl = tooltip.querySelector(".hotspot-tooltip-title-text");
    const checkEl     = tooltip.querySelector(".hotspot-tooltip-check");
    const pathEl      = tooltip.querySelector(".hotspot-tooltip-path");

    const HOVER_DELAY_MS = 200;
    const OFFSET_X = 15;
    const OFFSET_Y = -10;
    const EDGE_PADDING = 8;

    let showTimer = null;
    let currentHotspot = null;
    let isVisible = false;
    let mouseX = 0;
    let mouseY = 0;

    // ----------------------------------------------------------------
    // Position the tooltip near the cursor, flipping at viewport edges
    // ----------------------------------------------------------------
    function positionTooltip() {
        // Reset to measure
        tooltip.style.left = "0px";
        tooltip.style.top  = "0px";

        const rect = tooltip.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = mouseX + OFFSET_X;
        let top  = mouseY + OFFSET_Y;

        // Flip horizontally if it would overflow the right edge
        if (left + rect.width + EDGE_PADDING > vw) {
            left = mouseX - rect.width - OFFSET_X;
        }
        // Flip vertically if it would overflow the top edge
        if (top < EDGE_PADDING) {
            top = mouseY + 20;
        }
        // Clamp to viewport
        left = Math.max(EDGE_PADDING, Math.min(left, vw - rect.width - EDGE_PADDING));
        top  = Math.max(EDGE_PADDING, Math.min(top,  vh - rect.height - EDGE_PADDING));

        tooltip.style.left = left + "px";
        tooltip.style.top  = top + "px";
    }

    // ----------------------------------------------------------------
    // Fill the tooltip contents from a hotspot's quest data
    // ----------------------------------------------------------------
    function populateTooltip(hotspot) {
        const questId = hotspot.dataset.city;
        const quest = quests[questId];
        if (!quest) return false;

        const isMVP = quest.style === "mvp";
        const isCompleted = completedQuests[questId] === true;

        // Title
        titleTextEl.textContent = quest.title || questId;

        // Green check — real element, shown only when completed
        checkEl.style.display = isCompleted ? "inline-block" : "none";

        // Path subtitle
        const paths = Array.isArray(quest.path)
            ? quest.path.join(", ")
            : (quest.path || "");
        pathEl.textContent = paths;

        // Color classes — completed wins over mvp (CSS declares it last)
        tooltip.classList.remove("mvp", "completed");
        if (isCompleted) {
            tooltip.classList.add("completed");
        } else if (isMVP) {
            tooltip.classList.add("mvp");
        }

        return true;
    }

    // ----------------------------------------------------------------
    // Show / hide
    // ----------------------------------------------------------------
    function showTooltip(hotspot) {
        if (!populateTooltip(hotspot)) return;
        currentHotspot = hotspot;
        isVisible = true;
        tooltip.style.display = "block";
        tooltip.setAttribute("aria-hidden", "false");
        positionTooltip();
        // Force reflow so the opacity transition fires
        void tooltip.offsetWidth;
        tooltip.classList.add("visible");
    }

    function hideTooltip() {
        isVisible = false;
        currentHotspot = null;
        tooltip.classList.remove("visible");
        tooltip.setAttribute("aria-hidden", "true");
        // Wait for the fade-out, then actually hide
        setTimeout(() => {
            if (!isVisible) tooltip.style.display = "none";
        }, 130);
    }

    // ----------------------------------------------------------------
    // Mouse handlers (delegated on map-container)
    // ----------------------------------------------------------------
    mapContainer.addEventListener("mouseover", (e) => {
        const hotspot = e.target.closest(".hotspot");
        if (!hotspot) return;

        // Already showing for this same hotspot? Nothing to do.
        if (currentHotspot === hotspot) return;

        // Switched hotspots while a tooltip was visible → swap instantly
        if (isVisible && currentHotspot) {
            clearTimeout(showTimer);
            showTooltip(hotspot);
            return;
        }

        // Fresh hover → delay before showing
        clearTimeout(showTimer);
        showTimer = setTimeout(() => {
            showTooltip(hotspot);
        }, HOVER_DELAY_MS);
    });

    mapContainer.addEventListener("mousemove", (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
        if (isVisible) positionTooltip();
    });

    mapContainer.addEventListener("mouseout", (e) => {
        const hotspot = e.target.closest(".hotspot");
        if (!hotspot) return;

        // Only hide if we're actually leaving the hotspot we care about
        const related = e.relatedTarget;
        if (related && hotspot.contains(related)) return;

        clearTimeout(showTimer);
        hideTooltip();
    });

    // Hide on scroll (map can be scrolled/panned) and on window blur
    window.addEventListener("blur", () => {
        clearTimeout(showTimer);
        if (isVisible) hideTooltip();
    });
}
// ==============================================
// SECTION 17: HOTSPOT VISIBILITY
// ==============================================

    function updateHotspotVisibility() {


        updateHotspotPositions();

        // All hotspots always visible on the single map
        document.querySelectorAll(".hotspot").forEach(hotspot => {
            hotspot.style.display = "block";
        });

        // Floating nav - always visible
        const floatingNav = document.getElementById("floating-nav");
        if (floatingNav) {
            floatingNav.style.display = "flex";
        }
    }


// ==============================================
// SECTION 18: OPEN QUEST (OPTIMIZED - INSTANT)
// ==============================================

async function openQuest(cityId) {
    // Build quest relationships once (synchronous, cheap after first call)
    buildQuestRelationships();

    if (cityId === "gallery") {
        openGallery();
        return;
    }

    const quest = quests[cityId];
    if (!quest) return;

    currentQuestId = cityId;
    const questBox = document.getElementById("quest-box");

    questBox.className = "";
    questBox.classList.remove("custom-quest");
    if (quest.teacher_quest === true || quest.is_custom === true) {
        questBox.classList.add("custom-quest");
    }
    if (quest.style) questBox.classList.add(quest.style);
    if (completedQuests[cityId]) questBox.classList.add("completed");

    // ===== RENDER EVERYTHING SYNCHRONOUSLY FROM MEMORY (instant) =====
    document.getElementById("quest-title").innerText = quest.title || "";
    renderInterestToggle(cityId, quest);
    document.getElementById("quest-rationale").textContent = "Rationale";  
    document.getElementById("quest-text").innerText = quest.description || "";
    document.getElementById("quest-character").src = quest.character || "";
    document.getElementById("quest-rubric").textContent = "Rubric";

        // EXP reward display is handled in a later step.
        renderQuestRewardField(cityId);

    const pathContainer = document.getElementById("quest-paths");
    if (pathContainer) {
        pathContainer.innerHTML = Array.isArray(quest.path) && quest.path.length ? quest.path.join(", ") : "No path assigned";
    }

    // Prerequisites (from pre-built cache)
    const prereqContainer = document.getElementById("quest-prereq-leads-prereq");
    if (prereqContainer) {
        const prereqIds = AppState.questRelationships.prerequisites[cityId] || [];
        if (prereqIds && prereqIds.length) {
            prereqContainer.innerHTML = prereqIds.map(id => {
                const completed = completedQuests[id] ? '<span class="prereq-check"> ✔</span>' : '';
                const questTitle = quests[id]?.title || id;
                return `<li><a href="#" onclick="openQuest('${id}')">${questTitle}</a>${completed}</li>`;
            }).join('');
        } else {
            prereqContainer.innerHTML = "<li>None</li>";
        }
    }

    // Timer controls (SYNCHRONOUS — uses cached values only)
    setupTimerControlsSync(cityId);

    const reqBox = document.getElementById("quest-requirements");
    if (reqBox) {
        reqBox.innerHTML = "";
        if (Array.isArray(quest.requirements)) {
            const ul = document.createElement("ul");
            quest.requirements.forEach(r => { const li = document.createElement("li"); li.textContent = r; ul.appendChild(li); });
            reqBox.appendChild(ul);
        }
    }

    const linksEl = document.getElementById("quest-links");
    if (linksEl) {
        linksEl.innerHTML = Array.isArray(quest.links)
            ? quest.links.map((l,i) => `<li><a href="${l.url || '#'}" target="_blank">${l.type || 'Sample'} ${i+1}</a></li>`).join("")
            : "";
    }

    const starsContainer = document.querySelector("#quest-box .difficulty .stars");
    if (starsContainer) {
        starsContainer.innerHTML = "";
        const difficulty = quest.difficulty || 0;
        for (let i = 1; i <= 3; i++) {
            const star = document.createElement("span");
            star.className = i <= difficulty ? "star solid" : "star outline";
            star.innerText = "★";
            starsContainer.appendChild(star);
        }
    }

        // --- Rationale cell click ---
    const rationaleCell = document.getElementById("quest-rationale-cell");
    if (rationaleCell) {
        const fresh = rationaleCell.cloneNode(true);
        rationaleCell.parentNode.replaceChild(fresh, rationaleCell);
        fresh.addEventListener("click", () => openRationalePopup(cityId));
    }

    // --- Rubric cell click ---
    const rubricCell = document.getElementById("quest-rubric-cell");
    if (rubricCell) {
        const fresh = rubricCell.cloneNode(true);
        rubricCell.parentNode.replaceChild(fresh, rubricCell);
        fresh.addEventListener("click", () => openRubricPopup(cityId));
    }

    // --- Finished Work cell click ---
    const workCell = document.getElementById("open-work-overlay");
    if (workCell) {
        const fresh = workCell.cloneNode(true);
        workCell.parentNode.replaceChild(fresh, workCell);
        fresh.addEventListener("click", () => {
            if (fresh.classList.contains("disabled")) return;
            if (!currentQuestId) {
                alert("Please open a quest first to add your work.");
                return;
            }
            const isAccepted = questAccepted[currentQuestId] === true;
            const isCompleted = completedQuests[currentQuestId] === true;
            const hasTimer = quests[currentQuestId]?.timer !== undefined;
            const canAccess = !hasTimer || isAccepted || isCompleted;
            if (!canAccess) {
                showAcceptQuestRestrictionPopup(currentQuestId);
                return;
            }
            openWorkOverlay(currentQuestId);
        });
    }

    // --- Cancel Quest cell (wire click once per open) ---
    // Note: enabled/disabled state is handled by updateRestrictedElementsVisibilitySync().
    const cancelCell = document.getElementById("cancel-quest-cell");
    if (cancelCell) {
        const fresh = cancelCell.cloneNode(true);
        cancelCell.parentNode.replaceChild(fresh, cancelCell);
        fresh.addEventListener("click", () => {
            if (fresh.classList.contains("disabled")) return;
            cancelQuest(cityId);
        });
    }

    // "Leads to" (from pre-built cache)
    const leadsContainer = document.getElementById("quest-prereq-leads-to");
    if (leadsContainer) {
        const leads = AppState.questRelationships.leadsTo[cityId] || [];
        if (leads.length > 0) {
            leadsContainer.innerHTML = leads.map(id => {
                const completed = completedQuests[id] ? '<span class="prereq-check"> ✔</span>' : '';
                const questTitle = quests[id]?.title || id;
                return `<li><a href="#" onclick="openQuest('${id}')">${questTitle}</a>${completed}</li>`;
            }).join('');
        } else {
            leadsContainer.innerHTML = "<li>None</li>";
        }
    }

    // Restricted elements (SYNCHRONOUS)
    updateRestrictedElementsVisibilitySync(cityId);

    // ===== SHOW OVERLAY IMMEDIATELY =====
    document.getElementById("quest-overlay").style.display = "block";

    // ===== BACKGROUND WORK (doesn't block UI) =====
    const isDataFresh = AppState.studentData.loaded &&
                        (Date.now() - AppState.studentData.lastLoadTime < 5000);

    if (!isDataFresh) {
        loadStudentDataFromCloud(false)
            .then(() => {
                // Refresh restricted elements in case accepted status changed
                updateRestrictedElementsVisibilitySync(cityId);
                setupTimerControlsSync(cityId);
            })
            .catch(err => console.error("Background student data load error:", err));
    }

    // Only fetch timer values if not cached
    if (cachedTimerQuestId !== cityId || cachedClassDuration === null) {
        cacheTimerValuesForQuest(cityId)
            .then(() => {
                // Update timer once data is ready
                if (currentQuestId === cityId) {
                    setupTimerControlsSync(cityId);
                    updateTimerDisplay(cityId);
                }
            })
            .catch(err => console.error("Background timer cache error:", err));
    } else {
        // Already cached - just make sure display is fresh
        updateTimerDisplay(cityId);
    }
}

// ==============================================
// SECTION 19: QUEST COMPLETION & DATA
// ==============================================

function markQuestCompleteFromWork(questId) {
    const quest = quests[questId];
    if (!quest) return;
    const wasAlreadyCompleted = completedQuests[questId] === true;
    completedQuests[questId] = true;

    // --- EXP: quest completion is now awarded in syncExpFromGradedWork,
    // which is called from refreshStudentData after cloud reload.
    if (activeQuestId === questId) {
        activeQuestId = null;
        if (questAccepted[questId]) {
            questAccepted[questId] = false;
            saveQuestAccepted();
        }
    }
    updateActiveQuestButton();
    stopActiveQuestTimerUpdates();
    updateBadgesAfterQuest();
    if (currentQuestId === questId) {
        const questBox = document.getElementById("quest-box");
        if (questBox) questBox.classList.add("completed");
        const questCheck = document.getElementById("quest-check");
        if (questCheck) questCheck.checked = true;
        const timerDisplay = document.getElementById("timer-display");
        if (timerDisplay) timerDisplay.textContent = "Completed";
    }
    saveQuestData();
    if (questAccepted[questId]) {
        stopQuestTimer(questId);
        questAccepted[questId] = false;
        saveQuestAccepted();
    }
    // Invalidate cache after completion
    invalidateStudentDataCache();
}

function saveQuestData() { 
    localStorage.setItem("completedQuests", JSON.stringify(completedQuests)); 
}

function loadQuestData() { 
    const saved = localStorage.getItem("completedQuests"); 
    return saved ? JSON.parse(saved) : {}; 
}

function saveQuestGrades() {
    localStorage.setItem("questGrades", JSON.stringify(questGrades));
}

function loadQuestGrades() {
    const data = localStorage.getItem("questGrades");
    return data ? JSON.parse(data) : {};
}

function saveQuestAccepted() {
    localStorage.setItem("questAccepted", JSON.stringify(questAccepted));
    autoSaveToCloud();
}

function loadQuestAccepted() {
    const data = localStorage.getItem("questAccepted");
    return data ? JSON.parse(data) : {};
}

function saveQuestStartTimes() {
    localStorage.setItem("questStartTimes", JSON.stringify(questStartTimes));
    autoSaveToCloud();
}

function loadQuestStartTimes() {
    const data = localStorage.getItem("questStartTimes");
    return data ? JSON.parse(data) : {};
}

function saveRubricLocks() {
    localStorage.setItem("rubricLocked", JSON.stringify(rubricLocked));
}

function renderQuestRewardField(questId) {
    const el = document.getElementById("quest-reward");
    if (!el) return;

    const quest = quests[questId];
    if (!quest) {
        el.innerHTML = "—";
        return;
    }

    // ============================================================
    // COMPLETED → show actual earned EXP + tooltip breakdown
    // ============================================================
    if (completedQuests[questId] === true) {
        const breakdown = getQuestExpBreakdown(questId);

        if (breakdown.total === 0) {
            el.innerHTML = `
                <div class="reward-exp-field">
                    <span class="reward-exp-base">+0 EXP</span>
                    <span class="reward-exp-max">(not yet awarded)</span>
                </div>
            `;
            return;
        }

        el.innerHTML = `
            <div class="reward-exp-field reward-exp-field-earned">
                <span class="reward-exp-base">+${breakdown.total} EXP</span>
                <span class="reward-exp-max">(${breakdown.entries.length} source${breakdown.entries.length === 1 ? '' : 's'})</span>
            </div>
        `;

        const innerField = el.querySelector('.reward-exp-field');
        bindQuestExpTooltip(innerField, breakdown);
        return;
    }

    // ============================================================
    // NOT COMPLETED → show potential (Step B logic, unchanged)
    // ============================================================
    const isMVP = quest.style === "mvp";
    const base = isMVP ? EXP_RULES.SUMMATIVE_COMPLETE : EXP_RULES.FORMATIVE_COMPLETE;

    let max = base;
    max += isMVP ? EXP_RULES.BEFORE_TIME_SUMMATIVE : EXP_RULES.BEFORE_TIME_FORMATIVE;
    max += EXP_RULES.EXTRA_UPLOAD_SAME_WEEK;
    max += EXP_RULES.ALL_STANDARDS_HIGH;

    const weekKey = getISOWeekKey();
    if (!expLog[`first_upload:${weekKey}`]) {
        max += EXP_RULES.FIRST_UPLOAD_OF_WEEK;
    }

    if (_isQuestFeaturedThisWeek(questId)) {
        max += isMVP ? EXP_RULES.GIFT_SUMMATIVE : EXP_RULES.GIFT_FORMATIVE;
    }

    el.innerHTML = `
        <div class="reward-exp-field">
            <span class="reward-exp-base">+${base} EXP</span>
            <span class="reward-exp-max">(up to +${max})</span>
        </div>
    `;
}

/**
 * Returns all EXP entries tied to a single quest ID.
 *
 * Matches these key patterns:
 *   quest:<questId>
 *   before_time:<questId>
 *   upload:<questId>:<week>
 *   high_standards:<questId>
 *   gift:<week>:<questId>
 *
 * Non-quest-specific EXP (first_upload:<week>, badge:*, achievement:*,
 * vote:*, submit_battle:*) is intentionally excluded.
 */
function getQuestExpBreakdown(questId) {
    const entries = [];
    const quest = quests[questId];

    for (const [key, amount] of Object.entries(expLog)) {
        if (!amount) continue;

        // quest:<id>
        if (key === `quest:${questId}`) {
            const label = quest?.style === "mvp" ? "Summative complete" : "Formative complete";
            entries.push({ label, amount });
            continue;
        }

        // before_time:<id>
        if (key === `before_time:${questId}`) {
            entries.push({ label: "Before-deadline bonus", amount });
            continue;
        }

        // upload:<id>:<week>
        if (key.startsWith(`upload:${questId}:`)) {
            const week = key.slice(`upload:${questId}:`.length);
            entries.push({ label: `Upload bonus (${week})`, amount });
            continue;
        }

        // high_standards:<id>
        if (key === `high_standards:${questId}`) {
            entries.push({ label: "All standards ≥ 3.5", amount });
            continue;
        }

        // gift:<week>:<id>
        if (key.startsWith("gift:") && key.endsWith(`:${questId}`)) {
            const week = key.slice(5, key.length - questId.length - 1);
            entries.push({ label: `Gift bonus (${week})`, amount });
            continue;
        }
    }

    // Stable display order: completion, before-deadline, upload, high, gift
    const order = [
        /^Summative complete$/,
        /^Formative complete$/,
        /^Before-deadline bonus$/,
        /^Upload bonus/,
        /^All standards/,
        /^Gift bonus/
    ];
    entries.sort((a, b) => {
        const ai = order.findIndex(r => r.test(a.label));
        const bi = order.findIndex(r => r.test(b.label));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const total = entries.reduce((s, e) => s + e.amount, 0);
    return { entries, total };
}

/**
 * Wire the hover tooltip onto the quest reward field.
 * Uses a single shared tooltip element for all quests.
 */
function bindQuestExpTooltip(anchorEl, breakdown) {
    // Ensure the shared tooltip exists
    let tip = document.getElementById("quest-exp-tooltip");
    if (!tip) {
        tip = document.createElement("div");
        tip.id = "quest-exp-tooltip";
        tip.className = "quest-exp-tooltip";
        document.body.appendChild(tip);
    }

    // Build HTML once
    const rowsHtml = breakdown.entries.map(e =>
        `<div class="quest-exp-tooltip-row">
            <span class="quest-exp-tooltip-label">${escapeHtml(e.label)}</span>
            <span class="quest-exp-tooltip-amount">+${e.amount}</span>
        </div>`
    ).join("");

    const html = `
        <div class="quest-exp-tooltip-title">Quest EXP breakdown</div>
        <div class="quest-exp-tooltip-rows">${rowsHtml}</div>
        <div class="quest-exp-tooltip-total">
            <span>Total</span>
            <span>+${breakdown.total}</span>
        </div>
    `;

    // Remove any previous listeners by cloning — safe because anchorEl
    // is freshly created by renderQuestRewardField each time openQuest runs
    const fresh = anchorEl.cloneNode(true);
    anchorEl.parentNode.replaceChild(fresh, anchorEl);

    const onEnter = () => {
        tip.innerHTML = html;
        tip.classList.add("show");
    };
    const onMove = (e) => {
        const tr = tip.getBoundingClientRect();
        let left = e.clientX + 14;
        let top  = e.clientY + 14;
        if (left + tr.width + 8 > window.innerWidth)  left = e.clientX - tr.width - 14;
        if (top  + tr.height + 8 > window.innerHeight) top  = e.clientY - tr.height - 14;
        tip.style.left = left + "px";
        tip.style.top  = top + "px";
    };
    const onLeave = () => tip.classList.remove("show");

    fresh.addEventListener("mouseenter", onEnter);
    fresh.addEventListener("mousemove", onMove);
    fresh.addEventListener("mouseleave", onLeave);
}

/**
 * Synchronous check: is this quest currently featured for the student's class?
 * Uses the already-loaded `_featuredQuestsCache` if available.
 * Falls back to false if the cache hasn't been populated yet.
 */
function _isQuestFeaturedThisWeek(questId) {
    if (!Array.isArray(_featuredQuestsCache)) return false;
    return _featuredQuestsCache.some(item => item.questId === questId);
}

// ==============================================
// SECTION 20: CANCEL QUEST
// ==============================================

async function cancelQuest(questId) {
    if (!questId) return;

    const quest = quests[questId];
    const title = quest?.title || questId;

    const confirmed = confirm(
        `Cancel the quest "${title}"?\n\n` +
        `⚠️ This will PERMANENTLY delete any progress you have submitted.\n\n` +
        `This cannot be undone. Continue?`
    );
    if (!confirmed) return;

    try {
        const { data: { session } } = await window.supabase.auth.getSession();

        if (session) {
            const userId = session.user.id;

            // --- Delete storage files (best-effort) ---
            await window.supabase.storage
                .from('student-works')
                .remove([`${userId}/${questId}.jpg`]);
            await window.supabase.storage
                .from('student-research')
                .remove([`${userId}/${questId}.pdf`]);

            // --- Delete the work DB row ---
            await window.supabase
                .from('student_works')
                .delete()
                .eq('user_id', userId)
                .eq('quest_id', questId);

            // --- Clear self-assessment (local + cloud) ---
            if (window.selfAssessments && window.selfAssessments[questId]) {
                delete window.selfAssessments[questId];
                localStorage.setItem('selfAssessments', JSON.stringify(window.selfAssessments));
            }
            localStorage.removeItem('pendingSelfAssessment_' + questId);
            localStorage.removeItem('pendingSelfAssessmentQuest');

            const { data: progress } = await window.supabase
                .from('student_progress')
                .select('self_assessments')
                .eq('user_id', userId)
                .maybeSingle();

            if (progress?.self_assessments?.[questId]) {
                const updated = { ...progress.self_assessments };
                delete updated[questId];
                await window.supabase
                    .from('student_progress')
                    .update({ self_assessments: updated })
                    .eq('user_id', userId);
            }
        }
    } catch (e) {

    }

    // --- Stop any running timer ---
    if (questTimers[questId]) {
        clearInterval(questTimers[questId]);
        delete questTimers[questId];
    }

    // --- Clear local work cache ---
    if (studentWorks[questId]) {
        delete studentWorks[questId];
        saveStudentWorks();
    }

    // --- Clear accepted / start time ---
    delete questAccepted[questId];
    delete questStartTimes[questId];
    saveQuestAccepted();
    saveQuestStartTimes();

    // --- Invalidate cache so next open is fresh ---
    invalidateStudentDataCache();

    // --- Refresh UI ---
    closeQuest();
    updateActiveQuestButton();
    checkAllQuestWarnings();
    if (typeof updateHotspotVisibility === "function") updateHotspotVisibility();

    alert(`Quest "${title}" has been cancelled. You can accept it again anytime.`);
}

// ==============================================
// SECTION 21: CLOSE QUEST
// ==============================================

function closeQuest() {
    if (currentQuestId && questTimers[currentQuestId]) {
        stopQuestTimer(currentQuestId);
    }
    document.getElementById("quest-overlay").style.display = "none";
    const pathSel = document.getElementById("path-selector");
    const mvpSel = document.getElementById("mvp-quests");
    if (pathSel) pathSel.value = "";
    if (mvpSel) {
        mvpSel.style.display = "none";
        mvpSel.innerHTML = '<option value="">Select MVP Quest</option>';
    }

    // --- Reopen the achievements overlay if we came from the Mystery Gift tab ---
    if (window._reopenAchievementsAfterQuest) {
        window._reopenAchievementsAfterQuest = false;
        const tabToOpen = window._reopenAchievementsTab || 'completed';
        window._reopenAchievementsTab = null;

        const achOverlay = document.getElementById("achievements-overlay");
        if (achOverlay) {
            achOverlay.style.display = "flex";

            // Restore the tab
            document.querySelectorAll("#achievements-overlay .tab-content")
                .forEach(tc => tc.style.display = "none");
            document.querySelectorAll("#achievements-overlay .tab-button")
                .forEach(b => b.classList.remove("active"));

            const tabEl = document.getElementById("tab-" + tabToOpen);
            const tabBtn = document.querySelector(
                `#achievements-overlay .tab-button[data-tab="${tabToOpen}"]`
            );
            if (tabEl) tabEl.style.display = "block";
            if (tabBtn) tabBtn.classList.add("active");

            // Refresh the mystery gift list (in case a gift got claimed while open)
            if (tabToOpen === "mysterygift" && typeof renderMysteryGiftList === 'function') {
                invalidateMysteryGiftCache();
                renderMysteryGiftList();
            }
        }
    }
}

// ==============================================
// SECTION 22: INVITATION HANDLING
// ==============================================

async function checkForInvitation() {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteToken = urlParams.get('invite');
    if (!inviteToken) return null;
    const { data: invitation, error } = await window.supabase
        .from('student_invitations')
        .select('*')
        .eq('token', inviteToken)
        .eq('used', false)
        .single();
    if (error || !invitation) {

        return null;
    }
    if (new Date(invitation.expires_at) < new Date()) {

        return null;
    }
    return invitation;
}

async function applyInvitationToForm() {
    const invitation = await checkForInvitation();
    if (invitation) {
        const teacherCodeInput = document.getElementById('student-teacher-code');
        if (teacherCodeInput) {
            teacherCodeInput.value = invitation.teacher_code;
            teacherCodeInput.disabled = true;
            teacherCodeInput.style.opacity = '0.7';
            const note = document.createElement('p');
            note.style.color = '#4caf50';
            note.style.fontSize = '12px';
            note.style.marginTop = '5px';
            note.innerHTML = '✓ Invitation verified! Your teacher code has been auto-filled.';
            teacherCodeInput.parentNode.insertBefore(note, teacherCodeInput.nextSibling);
        }
    }
}

async function markInvitationAsUsed(invitationToken) {
    if (!invitationToken) return;
    await window.supabase
        .from('student_invitations')
        .update({ used: true })
        .eq('token', invitationToken);
}

// ==============================================
// SECTION 23: STUDENT SETUP (CHARACTERS)
// ==============================================

let characters = [];

function initializeStudentSetup() {
    const profile = loadStudentProfile();
    if (profile && profile.name) {
        updateProfileUI();
        return;
    }
    showWelcomeOverlay();
}

function showWelcomeOverlay() {
    const welcomeOverlay = document.getElementById("welcome-overlay");
    if (welcomeOverlay) welcomeOverlay.style.display = "flex";
}

function showStudentSetupOverlay() {
    const overlay = document.getElementById("student-setup-overlay");
    if (!overlay) return;
    overlay.style.display = "flex";
    applyInvitationToForm();
    const submitBtn = document.getElementById("student-create-account-btn");
    const nameInput = document.getElementById("student-name-input");
    const emailInput = document.getElementById("student-email-input");
    const passwordInput = document.getElementById("student-password-input");
    const confirmPasswordInput = document.getElementById("student-confirm-password-input");
    const teacherCodeInput = document.getElementById("student-teacher-code");
    const characterDiv = document.getElementById("character-selection");
    const charactersList = document.getElementById("characters-list");

    if (!submitBtn || !nameInput || !emailInput || !passwordInput || !confirmPasswordInput || !teacherCodeInput) return;

    const newSubmitBtn = submitBtn.cloneNode(true);
    submitBtn.parentNode.replaceChild(newSubmitBtn, submitBtn);
    
    newSubmitBtn.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;
        const teacherCode = teacherCodeInput.value.trim();
        const messageEl = document.getElementById("setup-message");
        
        if (!name || !email || !password || !confirmPassword) {
            if (messageEl) messageEl.textContent = "Please fill in all fields";
            return;
        }
        if (password.length < 6) {
            if (messageEl) messageEl.textContent = "Password must be at least 6 characters";
            return;
        }
        if (password !== confirmPassword) {
            if (messageEl) messageEl.textContent = "Passwords do not match";
            return;
        }
        if (!teacherCode) {
            if (messageEl) messageEl.textContent = "Please enter your teacher code";
            return;
        }

        const { data: teacherData, error: teacherError } = await window.supabase
            .from('teachers')
            .select('id, class_code, max_students')
            .eq('class_code', teacherCode)
            .single();

        if (teacherError || !teacherData) {
            if (messageEl) messageEl.textContent = "Invalid teacher code. Please ask your teacher for the correct code.";
            return;
        }

        const { data: canAdd, error: canAddError } = await window.supabase
            .rpc('can_add_student', { teacher_code_param: teacherCode });

        if (canAddError) {

        } else if (!canAdd) {
            const maxStudents = teacherData.max_students || 50;
            if (messageEl) {
                messageEl.textContent = `This teacher has reached the maximum of ${maxStudents} students. Please contact your teacher.`;
                messageEl.style.color = '#000000';
            }
            return;
        }
        const teacherId = teacherData.id;

        if (messageEl) messageEl.textContent = "Creating account...";
        const { data, error } = await window.supabase.auth.signUp({
            email: email,
            password: password,
            options: { data: { display_name: name } }
        });
        if (error) {
            if (messageEl) messageEl.textContent = error.message;
            return;
        }
        const { error: profileError } = await window.supabase
            .from('profiles')
            .upsert({
                id: data.user.id,
                name: name,
                avatar_url: "profile.png",
                email: email,
                teacher_id: teacherId,
                teacher_code: teacherCode
            });
        if (profileError) console.error("Error saving profile:", profileError);
        const profile = { name: name, character: "profile.png" };
        saveStudentProfile(profile);
        updateProfileUI();
        const { error: loginError } = await window.supabase.auth.signInWithPassword({
            email: email,
            password: password
        });
        if (loginError) {
            if (messageEl) messageEl.textContent = "Account created! Please login.";
            setTimeout(() => {
                showWelcomeOverlay();
                document.getElementById("login-email").value = email;
            }, 2000);
            return;
        }
        nameInput.disabled = true;
        emailInput.disabled = true;
        passwordInput.disabled = true;
        confirmPasswordInput.disabled = true;
        teacherCodeInput.disabled = true;
        newSubmitBtn.style.display = "none";
        if (characterDiv) characterDiv.style.display = "block";
        loadCharacterSelectionForProfile(charactersList);
    });

    fetch("characters/characters.json")
        .then(res => res.json())
        .then(data => {
            characters = data.characters || [];
            if (charactersList) charactersList.innerHTML = "";
            characters.forEach(char => {
                const card = document.createElement("div");
                card.className = "character-card";
                card.innerHTML = `<img src="${char.image}" alt="${char.name}" /><div class="character-name">${char.name}</div>`;
                card.addEventListener("click", () => selectCharacter(char));
                if (charactersList) charactersList.appendChild(card);
            });
        });
}

async function selectCharacter(character) {
    const nameInput = document.getElementById("student-name-input");
    const teacherCodeInput = document.getElementById("student-teacher-code");
    const name = nameInput ? nameInput.value.trim() : "";
    const teacherCode = teacherCodeInput ? teacherCodeInput.value.trim() : "";
    if (!teacherCode) {
        alert("Please enter your teacher code before selecting a character.");
        return;
    }
    const profile = {
        name: name,
        character: character.image,
        teacher_code: teacherCode,
        class_id: null
    };
    saveStudentProfile(profile);
    updateProfileUI();
    await loadTeacherNameForProfile();
    const { data: { session } } = await window.supabase.auth.getSession();
    if (session) {
        await window.supabase
            .from('profiles')
            .upsert({
                id: session.user.id,
                name: name,
                avatar_url: character.image,
                email: session.user.email,
                teacher_code: teacherCode,
                class_id: null
            });
    }
    const urlParams = new URLSearchParams(window.location.search);
    const inviteToken = urlParams.get('invite');
    if (inviteToken) {
        await markInvitationAsUsed(inviteToken);
    }
    const setupOverlay = document.getElementById("student-setup-overlay");
    if (setupOverlay) setupOverlay.style.display = "none";
}

// ==============================================
// SECTION 24: CLOUD SAVE/LOAD FUNCTIONS (OPTIMIZED)
// ==============================================

async function saveStudentDataToCloud() {
    if (isLoadingFromCloud) {

        return false;
    }
    await ensureFreshSession();
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {

        return false;
    }
    const userId = session.user.id;
    const studentData = {
        user_id: userId,
        quest_accepted: questAccepted,
        quest_start_times: questStartTimes,
        exp_total: expTotal,
        exp_log: expLog,
        updated_at: new Date().toISOString()
    };
    console.log("Student saving ONLY timer data to cloud:", {
        acceptedCount: Object.keys(questAccepted).length
    });
    const { error } = await guardAuth(() =>
        window.supabase
            .from('student_progress')
            .upsert(studentData, { onConflict: 'user_id' })
    );
    if (error) {

        return false;
    }

    return true;
}

async function loadStudentDataFromCloud(forceRefresh = false, runReconcile = false) {
    if (!forceRefresh && AppState.studentData.loaded && AppState.studentData.lastLoadTime) {
        const cacheAge = Date.now() - AppState.studentData.lastLoadTime;
        if (cacheAge < 5000) {

            completedQuests = AppState.studentData.completedQuests || {};
            questGrades = AppState.studentData.questGrades || {};
            questAccepted = AppState.studentData.questAccepted || {};
            questStartTimes = AppState.studentData.questStartTimes || {};
            earnedBadges = AppState.studentData.earnedBadges || {};
            if (AppState.studentData.selfAssessments) {
                window.selfAssessments = AppState.studentData.selfAssessments;
            }
            if (AppState.studentData.interestState) {
                window.interestState = AppState.studentData.interestState;
            }
            return true;
        }
    }

    isLoadingFromCloud = true;


    try {
        const { data: { session } } = await window.supabase.auth.getSession();
        if (!session) {

            return false;
        }
        const userId = session.user.id;

        const { data, error } = await window.supabase
            .from('student_progress')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            if (error.code === 'PGRST116') {

                completedQuests = {};
                questGrades = {};
                earnedBadges = {};
                questAccepted = {};
                questStartTimes = {};
                window.selfAssessments = {};
                window.interestState = {};
                for (const questId in questTimers) {
                    clearInterval(questTimers[questId]);
                    delete questTimers[questId];
                }
                saveQuestData();
                saveQuestGrades();
                saveEarnedBadges();
                saveQuestAccepted();
                saveQuestStartTimes();
                localStorage.removeItem('selfAssessments');
                expTotal = 0;
                expLog = {};
                localStorage.removeItem("expTotal");
                localStorage.removeItem("expLog");
                try { await reconcileExp(); } catch (e) { console.warn("[EXP] reconcile failed:", e); }
            } else {

            }
        } else if (data) {
            const isEmpty = (!data.completed_quests || Object.keys(data.completed_quests).length === 0) &&
                            (!data.quest_grades || Object.keys(data.quest_grades).length === 0) &&
                            (!data.quest_accepted || Object.keys(data.quest_accepted).length === 0) &&
                            (!data.quest_start_times || Object.keys(data.quest_start_times).length === 0) &&
                            (!data.is_interested || Object.keys(data.is_interested).length === 0);

                    if (isEmpty) {

                    completedQuests = {};
                    questGrades = {};
                    earnedBadges = {};
                    questAccepted = {};
                    questStartTimes = {};
                    window.selfAssessments = {};

                    // PRESERVE local interest state — it may be newer than what's in the cloud
                    const localInterest = (window.interestState && Object.keys(window.interestState).length > 0)
                        ? window.interestState
                        : {};
                    window.interestState = localInterest;

                    for (const questId in questTimers) {
                        clearInterval(questTimers[questId]);
                        delete questTimers[questId];
                    }
                    saveQuestData();
                    saveQuestGrades();
                    saveEarnedBadges();
                    saveQuestAccepted();
                    saveQuestStartTimes();
                    localStorage.removeItem('selfAssessments');
                    expTotal = 0;
                    expLog = {};
                    localStorage.removeItem("expTotal");
                    localStorage.removeItem("expLog");
                    try { await reconcileExp(); } catch (e) { console.warn("[EXP] reconcile failed:", e); }
                    checkAllQuestWarnings();
                    if (typeof updateProfileStandardsTable === 'function') updateProfileStandardsTable();
                    if (typeof renderRadarChart === 'function') renderRadarChart();

                    // If we still have local interest, push it back up so it persists
                    if (Object.keys(localInterest).length > 0) {
                        try { await saveInterestToCloud(); } catch (e) { console.warn("Re-save interest failed:", e); }
                    }


                }
                else {





                if (data.completed_quests) completedQuests = data.completed_quests;
                if (data.quest_grades) questGrades = data.quest_grades;
                // --- EXP fields ---
                if (typeof data.exp_total === "number") {
                    expTotal = data.exp_total;
                } else {
                    expTotal = 0;
                }
                if (data.exp_log && typeof data.exp_log === "object") {
                    expLog = data.exp_log;
                } else {
                    expLog = {};
                }
                saveExpToLocal();
                if (data.earned_badges) {
                    const mergedBadges = { ...data.earned_badges, ...earnedBadges };
                    earnedBadges = mergedBadges;
                    saveEarnedBadges();
                }

                if (data.self_assessments) {
                    window.selfAssessments = data.self_assessments;
                    localStorage.setItem('selfAssessments', JSON.stringify(data.self_assessments));

                } else {
                    const localData = localStorage.getItem('selfAssessments');
                    if (localData) {
                        try {
                            window.selfAssessments = JSON.parse(localData);

                        } catch (e) {
                            window.selfAssessments = {};
                        }
                    } else {
                        window.selfAssessments = {};
                    }
                }

                // Guard: don't clobber local interest state if a write is still in flight.
                // Otherwise, a stale server value could overwrite a fresh local toggle.
                if (_pendingInterestWrite) {
                    // Keep local state as-is; the write will settle soon.
                    if (!window.interestState) window.interestState = {};
                } else if (data.is_interested && typeof data.is_interested === 'object') {
                    window.interestState = data.is_interested;

                } else {
                    window.interestState = {};
                }

                questAccepted = data.quest_accepted || {};
                questStartTimes = data.quest_start_times || {};

                saveQuestAccepted();
                saveQuestStartTimes();
                saveQuestData();
                if (typeof saveQuestGrades === 'function') saveQuestGrades();
                if (typeof saveQuestAccepted === 'function') saveQuestAccepted();
                saveEarnedBadges();

                if (currentQuestId && document.getElementById("quest-overlay").style.display === "block") {

                    setupTimerControlsSync(currentQuestId);
                    const acceptBtn = document.getElementById("quest-accept");
                    if (acceptBtn) {
                        const isAccepted = questAccepted[currentQuestId] === true;
                        if (isAccepted) {
                            acceptBtn.disabled = true;
                            acceptBtn.textContent = "Accepted";
                        } else {
                            acceptBtn.disabled = false;
                            acceptBtn.textContent = "Accept Quest";
                        }
                    }

                    if (quests[currentQuestId]?.style === "mvp" && typeof renderInterestToggle === 'function') {
                        renderInterestToggle(currentQuestId, quests[currentQuestId]);
                    }
                }

                if (typeof updateProfileStandardsTable === 'function') updateProfileStandardsTable();
                if (typeof renderRadarChart === 'function') renderRadarChart();

                if (currentQuestId && document.getElementById("rubric-overlay").style.display === "flex") {

                    openRubricPopup(currentQuestId);
                }

                if (document.getElementById("profile-overlay").style.display === "flex") {
                    if (typeof renderBadges === 'function') renderBadges();
                }


                // NOTE: reconcileExp() is intentionally NOT called here.
                // It runs after `isLoadingFromCloud` flips to false, so its
                // cloud writes (saveBadgesToCloud / saveExpToCloud) actually fire.
            
            }
        }

        const { data: profileData, error: profileError } = await window.supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (profileData && profileData.name) {
            const profile = {
                name: profileData.name,
                character: profileData.avatar_url || "profile.png",
                teacher_code: profileData.teacher_code,
                class_id: profileData.class_id,
                grade_level: profileData.grade_level
            };
            saveStudentProfile(profile);
            updateProfileUI();


        }

        AppState.studentData.completedQuests = { ...completedQuests };
        AppState.studentData.questGrades = { ...questGrades };
        AppState.studentData.questAccepted = { ...questAccepted };
        AppState.studentData.questStartTimes = { ...questStartTimes };
        AppState.studentData.earnedBadges = { ...earnedBadges };
        AppState.studentData.selfAssessments = { ...window.selfAssessments };
        AppState.studentData.interestState = { ...window.interestState };
        AppState.studentData.loaded = true;
        AppState.studentData.lastLoadTime = Date.now();

    } catch (err) {

    } finally {
        isLoadingFromCloud = false;

    }
        // Run the reconciler AFTER isLoadingFromCloud is false,
    // otherwise every cloud save it triggers is silently skipped.
    try {
        await reconcileExp();
    } catch (e) {

    }

    return true;
}

async function manualRefreshGrades() {

    invalidateStudentDataCache();
    await loadStudentDataFromCloud(true);
    alert("Data refreshed! Check your rubric and profile.");
}

// ==============================================
// SECTION 25: WORK CLOUD SAVE
// ==============================================

async function saveWorkToCloud(questId, workData, imageFile, uploadId = null, pdfMeta = null, expFacts = null) {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {

        return false;
    }

    const userId = session.user.id;
    let imageUrl = null;

    if (uploadId && window._activeUploads && window._activeUploads[uploadId]) {

        return false;
    }

    if (!window._activeUploads) window._activeUploads = {};
    if (uploadId) window._activeUploads[uploadId] = true;

    try {
        if (imageFile) {
            let fileToUpload = imageFile;
            if (imageFile.type.startsWith('image/')) {
                try {
                    fileToUpload = await compressImage(imageFile, 800, 0.8);
                } catch (error) {

                }
            }

            const fileExt = 'jpg';
            const fileName = `${userId}/${questId}.${fileExt}`;

            const { error } = await window.supabase.storage
                .from('student-works')
                .upload(fileName, fileToUpload, {
                    cacheControl: '86400',
                    upsert: true
                });

            if (error) {

                throw error;
            }

            const { data: urlData } = window.supabase.storage
                .from('student-works')
                .getPublicUrl(fileName);
            imageUrl = urlData.publicUrl + '?v=' + Date.now();
        }

        const { data: existingData } = await window.supabase
            .from('student_works')
            .select('id, research_pdf_url, research_pdf_name')
            .eq('user_id', userId)
            .eq('quest_id', questId)
            .maybeSingle();

        let error;

        // Resolve PDF fields:
        // - pdfMeta provided  → new upload, use it
        // - pdfMeta is null AND no input file selected → keep whatever's there
        // We only overwrite PDF fields when pdfMeta is provided.
        if (existingData) {
            const updateData = {
                image_url: imageUrl,
                title: workData.title,
                description: workData.description,
                size: workData.size,
                media: workData.media,
                grading_status: 'pending',
                uploaded_at: new Date().toISOString()
            };
            if (expFacts) updateData.exp_metadata = expFacts;

            if (!imageUrl) delete updateData.image_url;

            if (pdfMeta) {
                updateData.research_pdf_url = pdfMeta.url;
                updateData.research_pdf_name = pdfMeta.name;
                updateData.research_pdf_uploaded_at = new Date().toISOString();
            }

            const { error: updateError } = await window.supabase
                .from('student_works')
                .update(updateData)
                .eq('user_id', userId)
                .eq('quest_id', questId);

            error = updateError;
        } else {
            const insertData = {
                user_id: userId,
                quest_id: questId,
                image_url: imageUrl,
                title: workData.title,
                description: workData.description,
                size: workData.size,
                media: workData.media,
                grading_status: 'pending',
                uploaded_at: new Date().toISOString()
            };
            if (expFacts) insertData.exp_metadata = expFacts;
            if (pdfMeta) {
                insertData.research_pdf_url = pdfMeta.url;
                insertData.research_pdf_name = pdfMeta.name;
                insertData.research_pdf_uploaded_at = new Date().toISOString();
            }

            const { error: insertError } = await window.supabase
                .from('student_works')
                .insert(insertData);

            error = insertError;
        }

        if (error) {

            return false;
        }


        return true;

    } catch (err) {

        return false;
    } finally {
        if (uploadId && window._activeUploads) {
            delete window._activeUploads[uploadId];
        }
    }
}

function autoSaveToCloud() {
    if (isLoadingFromCloud) {

        return;
    }
    window.supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) {

            saveStudentDataToCloud();
        }
    }).catch(err => {

    });
}

// ==============================================
// SECTION 26: PATH DROPDOWN HANDLER
// ==============================================

function handlePathChange() {
    const path = this.value;
    const mvpSelector = document.getElementById("mvp-quests");
    if (!mvpSelector) return;

    // Rebuild if `quests` has grown since last build (safety net)
    buildPathQuests();

    if (path && pathQuests[path] && pathQuests[path].length) {
        mvpSelector.style.display = "inline";
        mvpSelector.innerHTML = '<option value="">Select MVP Quest</option>';
        pathQuests[path].forEach(q => {
            const opt = document.createElement("option");
            opt.value = q.id;
            opt.textContent = q.title;
            mvpSelector.appendChild(opt);
        });
    } else if (path && pathQuests[path]) {
        mvpSelector.style.display = "inline";
        mvpSelector.innerHTML = '<option value="">No MVP quests available</option>';
    } else {
        mvpSelector.style.display = "none";
        mvpSelector.innerHTML = '<option value="">Select MVP Quest</option>';
    }
}

// ==============================================
// SECTION 27: SEARCH ENGINE (FUZZY)
// ==============================================

function fuzzySearchQuests(term) {
    const words = term.split(/\s+/);
    return Object.entries(quests)
        .map(([id, quest]) => {
            const haystack = [
                quest.title,
                quest.description,
                ...(quest.requirements || []),
                ...(quest.path || [])
            ]
                .join(" ")
                .toLowerCase();
            let score = 0;
            words.forEach(word => {
                if (haystack.includes(word)) score++;
            });
            return score > 0 ? { id, quest, score } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
}

// ==============================================
// SECTION 28: RATIONALE POPUP LOGIC
// ==============================================

function openRationalePopup(questId) {
    const quest = quests[questId];
    if (!quest || !quest.rationale) return;
    document.getElementById("rationale-content").innerHTML = quest.rationale;
    playUnrollSound();
    document.getElementById("rationale-overlay").style.display = "flex";
}

function closeRationalePopup() {
    document.getElementById("rationale-overlay").style.display = "none";
}

function playUnrollSound() {
    const audio = document.getElementById("unroll-sound");
    if (!audio) return;
    audio.currentTime = 0;
    audio.volume = 0.25;
    audio.play();
}

function initializeRationaleOverlay() {
    const overlay = document.getElementById("rationale-overlay");
    const closeBtn = document.getElementById("rationale-close");
    if (!overlay || !closeBtn) return;
    closeBtn.addEventListener("click", closeRationalePopup);
    overlay.addEventListener("click", e => {
        if (e.target === overlay) closeRationalePopup();
    });
}

// ==============================================
// SECTION 29: ACHIEVEMENTS DATA
// ==============================================

const achievementsData = [
    {
        title: "The Master of Perspective",
        note: "Complete all perspective quests",
        questsNeeded: ["quest42","quest43","quest44","quest45","quest46", "quest47"],
        exp: 400
    },
    {
        title: "The Master of touch",
        note: "Complete quests that teach how to create different textures",
        questsNeeded: ["quest7","quest8","quest9","quest10","quest19","quest34","quest35", "quest64", "quest55"],
        exp: 600
    },
    {
        title: "The master of the East",
        note: "Complete all quests related to China\nPS: For 'The Story Tile of the Heart` use a chinese theme for the tile.",
        questsNeeded: ["quest56","quest49","quest50"],
        exp: 200
    },
    {
        title: "The Facemaster",
        note: "Complete all quests related to portrature (non mvp)",
        questsNeeded: ["quest18","quest20", "quest21","quest29","quest26","quest27","quest53"],
        exp: 500
    },
    {
        title: "That who understand the principles",
        note: "Complete all quest related to the Principles of Design",
        questsNeeded: ["quest59","quest60","quest61","quest62","quest63"],
        exp: 400
    },
    {
        title: "The Nature Chronicler",
        note: "Complete all landscape and natural subject quests.",
        questsNeeded: ["quest10","quest17","quest24","quest23","quest65"],
        exp: 400
    },
    {
        title: "The Abstract Visionary",
        note: "Explore non-representational and pattern-based art across paths.",
        questsNeeded: ["quest12","quest13","quest14","quest15","quest36"],
        exp: 400
    },
    {
        title: "The Traditionalist",
        note: "Complete all quests rooted in classical or cultural art traditions.",
        questsNeeded: ["quest49","quest50","quest54","quest67"],
        exp: 300
    },
    {
        title: "The Architectural Scholar",
        note: "Excel in architectural drawing, perspective, and structure.",
        questsNeeded: ["quest42", "quest43", "quest44", "quest25", "quest58", "quest66"],
        exp: 500
    },
    {
        title: "The Seasonal Storyteller",
        note: "Create art inspired by holidays and seasonal themes.",
        questsNeeded: ["quest51", "quest52"],
        exp: 150
    },
    {
        title: "The Still Life Connoisseur",
        note: "Excel at observing and rendering still life across mediums.",
        questsNeeded: ["quest5", "quest16", "quest22", "quest41"],
        exp: 350
    },
    {
        title: "The Light & Shadow Adept",
        note: "Master the use of value, light, and shadow across media.",
        questsNeeded: ["quest5", "quest8", "quest9", "quest33", "quest64"],
        exp: 400
    },
    {
        title: "The Acrylic Master",
        note: "Complete all quests that specifically cite 'acrylic painting'",
        questsNeeded: ["quest1", "quest4", "quest5", "quest6", "quest10", "quest11", "quest19", "quest33", "quest34", "quest35", "quest36", "quest37", "quest66"],
        exp: 800
    },
    {
        title: "The Water Sage",
        note: "Complete all watercolor-specific quests.",
        questsNeeded: ["quest32", "quest22", "quest23", "quest24", "quest25", "quest26", "quest27", "quest49", "quest50", "quest65"],
        exp: 600
    },
    {
        title: "The 3D Master",
        note: "Complete all 3D quests",
        questsNeeded: ["quest53", "quest54", "quest56", "quest57", "quest58", "quest59", "quest60", "quest61", "quest62", "quest63", "quest68"],
        exp: 700
    },
    {
        title: "The Sketch Master",
        note: "Complete all quests that specifically require pencil, ink or charcoal drawing\nPS: for this achievement, the quest 'Trial of Textured Cubes' need to be done pencil, charcoal or ink",
        questsNeeded: ["quest53", "quest54", "quest56", "quest57", "quest58", "quest59", "quest60", "quest61", "quest62", "quest63", "quest68"],
        exp: 700
    },
    {
        title: "The MVP Conquistador",
        note: "Complete all high-difficulty summative quests.",
        questsNeeded: ["quest4","quest11","quest16","quest27", "quest35", "quest36", "quest50", "quest66"],
        exp: 800
    },
];

// ==============================================
// SECTION 30: ACHIEVEMENTS OVERLAY FUNCTIONS
// ==============================================

function openAchievementsOverlay() {
    const rationaleOverlay = document.getElementById("rationale-overlay");
    if (rationaleOverlay && rationaleOverlay.style.display === "flex") {
        rationaleOverlay.style.display = "none";
    }
    const questOverlay = document.getElementById("quest-overlay");
    if (questOverlay && questOverlay.style.display === "block") {
        closeQuest();
    }

    const overlay = document.getElementById("achievements-overlay");
    overlay.style.display = "flex";

    // Wire close handlers the first time the overlay is opened.
    // Uses a flag on the overlay element itself, so this is idempotent.
    if (!overlay.dataset.closeWired) {
        overlay.dataset.closeWired = "1";

        // Backdrop: click on the overlay element itself (not a child)
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                closeAchievementsOverlay();
            }
        });

        // ✕: document-level delegation so it survives any inner rebuild
        document.addEventListener("click", (e) => {
            const ov = document.getElementById("achievements-overlay");
            if (!ov || ov.style.display !== "flex") return;
            if (e.target.closest("#close-achievements")) {
                e.preventDefault();
                closeAchievementsOverlay();
            }
        }, true);
    }
    invalidateResourcesCache();
    renderAchievementsList();
}

function closeAchievementsOverlay() {
    document.getElementById("achievements-overlay").style.display = "none";
}

function renderAchievementsList() {
    const container = document.getElementById("achievements-list");
    if (!container) return;
    container.innerHTML = "";
    achievementsData.forEach(item => {
        const completedCount = item.questsNeeded.filter(qid => completedQuests[qid]).length;
        const totalCount = item.questsNeeded.length;
        const div = document.createElement("div");
        div.classList.add("achievement-item");
        const header = document.createElement("div");
        header.classList.add("achievement-header");
        const expandBtn = document.createElement("button");
        expandBtn.classList.add("achievement-expand");
        expandBtn.innerText = "+";
        const title = document.createElement("h3");
        title.innerHTML = `
            ${item.title}
            <span class="achievement-progress">(${completedCount}/${totalCount})</span>
        `;
        header.appendChild(title);
        header.appendChild(expandBtn);
        div.appendChild(header);
        if (item.note) {
            const note = document.createElement("div");
            note.classList.add("achievement-note");
            note.innerText = item.note;
            div.appendChild(note);
        }
        const list = document.createElement("ul");
        list.classList.add("achievement-quests");
        item.questsNeeded.forEach(qid => {
            const completed = completedQuests[qid];
            const li = document.createElement("li");
            const link = document.createElement("a");
            link.href = "#";
            link.innerText = quests[qid]?.title || qid;
            if (completed) {
                link.innerHTML += " <span class='ach-check'>✓</span>";
            }
            link.addEventListener("click", (e) => {
                e.preventDefault();
                closeAchievementsOverlay();
                openQuest(qid);
            });
            li.appendChild(link);
            list.appendChild(li);
        });
        div.appendChild(list);
        container.appendChild(div);
        expandBtn.addEventListener("click", () => {
            div.classList.toggle("expanded");
            expandBtn.innerText = div.classList.contains("expanded") ? "−" : "+";
        });
    });
}


// ==============================================
// SECTION 30B: STUDENT RESOURCES TAB
// ==============================================

const RESOURCE_BUCKET_STUDENT = 'teacher-resources';

let _resourcesStudentCache = null;
let _resourcesStudentCacheTime = 0;
const RESOURCES_STUDENT_CACHE_MS = 60000;   // 60s TTL, like other student caches

function invalidateResourcesCache() {
    _resourcesStudentCache = null;
    _resourcesStudentCacheTime = 0;
}

async function loadResourcesForStudent(forceRefresh = false) {
    if (!forceRefresh && _resourcesStudentCache && (Date.now() - _resourcesStudentCacheTime) < RESOURCES_STUDENT_CACHE_MS) {
        return _resourcesStudentCache;
    }

    const profile = loadStudentProfile();
    if (!profile?.class_id) {
        _resourcesStudentCache = [];
        _resourcesStudentCacheTime = Date.now();
        return [];
    }

    const { data, error } = await guardAuth(() =>
        window.supabase
            .from('resources')
            .select(`
                id, title, description, resource_type,
                file_url, file_name, file_mime,
                link_url, created_at,
                resource_classes!inner(class_id)
            `)
            .eq('resource_classes.class_id', profile.class_id)
            .order('created_at', { ascending: false })
    );

    if (error) {
        console.warn('[resources] student load failed:', error);
        return [];
    }

    _resourcesStudentCache = data || [];
    _resourcesStudentCacheTime = Date.now();
    return _resourcesStudentCache;
}

function _resourceStudentIcon(r) {
    if (r.resource_type === 'link') return '🔗';
    const mime = r.file_mime || '';
    if (mime === 'application/pdf') return '📕';
    if (mime.startsWith('image/')) return '🖼️';
    return '📄';
}

function _resourceStudentMetaText(r) {
    if (r.resource_type === 'link') return 'Link';
    const parts = [];
    if (r.file_name) parts.push(r.file_name);
    return parts.join(' · ');
}

async function renderResourcesTab(forceRefresh = false) {
    const list = document.getElementById('resources-student-list');
    if (!list) return;

    list.innerHTML = '<div class="resources-student-empty">Loading…</div>';

    const resources = await loadResourcesForStudent(forceRefresh);

    if (!resources || resources.length === 0) {
        list.innerHTML = '<div class="resources-student-empty">No resources shared yet. Check back later!</div>';
        return;
    }

    list.innerHTML = '';

    for (const r of resources) {
        const card = document.createElement('a');
        card.className = 'resources-student-card';

        if (r.resource_type === 'link') {
            card.href = r.link_url;
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
        } else {
            card.href = r.file_url;
            card.download = r.file_name || '';
            card.target = '_blank';           // fallback if download is ignored
            card.rel = 'noopener noreferrer';
        }

        const icon = document.createElement('div');
        icon.className = 'resources-student-icon';
        icon.textContent = _resourceStudentIcon(r);
        card.appendChild(icon);

        const body = document.createElement('div');
        body.className = 'resources-student-body';

        const title = document.createElement('div');
        title.className = 'resources-student-title';
        title.textContent = r.title;
        body.appendChild(title);

        if (r.description) {
            const desc = document.createElement('div');
            desc.className = 'resources-student-desc';
            desc.textContent = r.description;
            body.appendChild(desc);
        }

        const metaText = _resourceStudentMetaText(r);
        if (metaText) {
            const meta = document.createElement('div');
            meta.className = 'resources-student-meta';
            meta.textContent = metaText;
            body.appendChild(meta);
        }

        card.appendChild(body);

        const arrow = document.createElement('div');
        arrow.className = 'resources-student-arrow';
        arrow.textContent = r.resource_type === 'link' ? '↗' : '⬇';
        card.appendChild(arrow);

        list.appendChild(card);
    }
}

// ==============================================
// SECTION 31: PATHFINDER SYSTEM
// ==============================================

async function loadPathfinderQuestions() {
    try {
        const response = await fetch('pathfinder-questions.json');
        pathfinderQuestions = await response.json();
        return pathfinderQuestions;
    } catch (error) {

        return null;
    }
}

function loadMVPQuests() {
    if (!quests || Object.keys(quests).length === 0) {

        return [];
    }
    allMVPQuests = Object.entries(quests)
        .filter(([id, quest]) => quest.style === 'mvp')
        .map(([id, quest]) => ({
            id,
            title: quest.title,
            path: Array.isArray(quest.path) ? quest.path[0] : quest.path || 'Unknown Path',
            description: quest.description || ''
        }));
    return allMVPQuests;
}

function renderPathfinderQuestions() {
    const container = document.getElementById('pathfinder-questions-container');
    const introContainer = document.getElementById('pathfinder-intro');
    const resultsContainer = document.getElementById('pathfinder-results-container');
    const submitContainer = document.getElementById('pathfinder-submit-container');
    if (!container) {

        return;
    }
    if (!pathfinderQuestions) {

        return;
    }
    if (resultsContainer) resultsContainer.style.display = 'none';
    if (submitContainer) submitContainer.style.display = 'block';
    container.style.display = 'block';
    if (introContainer) {
        introContainer.innerHTML = pathfinderQuestions.intro || '';
    }
    container.innerHTML = '';
    currentPathfinderAnswers = {};
    pathfinderQuestions.questions.forEach((question, index) => {
        const questionDiv = document.createElement('div');
        questionDiv.className = 'pathfinder-question';
        questionDiv.dataset.questionId = question.id;
        const header = document.createElement('h4');
        header.textContent = `${question.id}. ${question.text}`;
        questionDiv.appendChild(header);
        if (question.note) {
            const note = document.createElement('div');
            note.className = 'pathfinder-question-note';
            note.textContent = question.note;
            questionDiv.appendChild(note);
        }
        const answersDiv = document.createElement('div');
        answersDiv.className = 'pathfinder-answers';
        question.answers.forEach(answer => {
            const answerId = `q${question.id}_${answer.letter}`;
            const answerWrapper = document.createElement('div');
            answerWrapper.className = 'pathfinder-answer';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `question_${question.id}`;
            radio.value = answer.letter;
            radio.id = answerId;
            const label = document.createElement('label');
            label.htmlFor = answerId;
            label.innerHTML = `<strong>${answer.letter})</strong> ${answer.text}`;
            answerWrapper.appendChild(radio);
            answerWrapper.appendChild(label);
            answerWrapper.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT') {
                    radio.checked = true;
                    const event = new Event('change', { bubbles: true });
                    radio.dispatchEvent(event);
                }
            });
            radio.addEventListener('change', () => {
                document.querySelectorAll(`.pathfinder-question[data-question-id="${question.id}"] .pathfinder-answer`)
                    .forEach(el => el.classList.remove('selected'));
                answerWrapper.classList.add('selected');
                currentPathfinderAnswers[question.id] = answer.letter;
            });
            answersDiv.appendChild(answerWrapper);
        });
        questionDiv.appendChild(answersDiv);
        container.appendChild(questionDiv);
    });
}

function processPathfinderAnswers() {
    const totalQuestions = pathfinderQuestions.questions.length;
    const answeredCount = Object.keys(currentPathfinderAnswers).length;
    if (answeredCount < totalQuestions) {
        alert(`Please answer all ${totalQuestions} questions before finding your path.`);
        return null;
    }
    if (!allMVPQuests || allMVPQuests.length === 0) {
        allMVPQuests = loadMVPQuests();
    }
    const scores = {};
    allMVPQuests.forEach(quest => {
        scores[quest.id] = 0;
    });
    pathfinderQuestions.questions.forEach(question => {
        const answerLetter = currentPathfinderAnswers[question.id];
        const answerObj = question.answers.find(a => a.letter === answerLetter);
        if (answerObj && answerObj.score) {
            Object.entries(answerObj.score).forEach(([questId, points]) => {
                if (scores.hasOwnProperty(questId)) {
                    scores[questId] += points;
                }
            });
        }
    });
    const sortedQuests = Object.entries(scores)
        .filter(([id, score]) => score > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, score]) => {
            const quest = allMVPQuests.find(q => q.id === id);
            return { ...quest, score };
        });
    return sortedQuests;
}

function renderPathfinderResults(topQuests) {
    const questionsContainer = document.getElementById('pathfinder-questions-container');
    const resultsContainer = document.getElementById('pathfinder-results-container');
    const submitContainer = document.getElementById('pathfinder-submit-container');
    const resultMessageDiv = document.getElementById('pathfinder-result-message');
    const questListDiv = document.getElementById('pathfinder-quest-list');
    if (!resultsContainer || !questListDiv) {

        return;
    }
    if (!topQuests || topQuests.length === 0) {
        if (resultMessageDiv) {
            resultMessageDiv.innerHTML = '<p>No matching quests found. Try different answers!</p>';
        }
    } else {
        const topQuestIds = topQuests.map(q => q.id);
        let bestMessage = pathfinderQuestions.resultMessages.find(msg => 
            msg.keywords.some(keyword => topQuestIds.includes(keyword))
        );
        if (!bestMessage) {
            bestMessage = {
                message: "Your answers reveal a unique artistic path! The quests below match your interests. Choose the one that calls to you most strongly."
            };
        }
        if (resultMessageDiv) {
            resultMessageDiv.innerHTML = `<p>${bestMessage.message}</p>`;
        }
        questListDiv.innerHTML = '';
        topQuests.forEach((quest, index) => {
            const questElement = document.createElement('div');
            questElement.className = 'questlist-item';
            questElement.dataset.questId = quest.id;
            const isCompleted = completedQuests[quest.id] || false;
            const isActive = questAccepted[quest.id] || false;
            let pathDisplay = quest.path || 'Unknown Path';
            questElement.innerHTML = `
                <div class="questlist-header">
                    <h3 class="questlist-title">${index + 1}. ${quest.title || 'Untitled'}</h3>
                    <span class="questlist-id">${quest.id}</span>
                </div>
                <div class="questlist-details">
                    <div>
                        <span class="questlist-path">${pathDisplay}</span>
                    </div>
                    <div>
                        ${isCompleted ? '<span class="questlist-completed">✓ Completed</span>' : ''}
                        ${isActive ? '<span class="questlist-timer active">🔴 Active</span>' : ''}
                    </div>
                </div>
            `;
            questElement.addEventListener('click', () => {
                closeAchievementsOverlay();
                openQuest(quest.id);
            });
            questListDiv.appendChild(questElement);
        });
    }
    if (questionsContainer) questionsContainer.style.display = 'none';
    if (resultsContainer) resultsContainer.style.display = 'block';
    if (submitContainer) submitContainer.style.display = 'none';
}

function resetPathfinder() {
    const questionsContainer = document.getElementById('pathfinder-questions-container');
    const resultsContainer = document.getElementById('pathfinder-results-container');
    const submitContainer = document.getElementById('pathfinder-submit-container');
    if (questionsContainer) questionsContainer.style.display = 'block';
    if (resultsContainer) resultsContainer.style.display = 'none';
    if (submitContainer) submitContainer.style.display = 'block';
    renderPathfinderQuestions();
}

async function initializePathfinder() {
    await loadPathfinderQuestions();
    loadMVPQuests();
    renderPathfinderQuestions();
    const submitBtn = document.getElementById('pathfinder-submit');
    const retakeBtn = document.getElementById('pathfinder-retake');
    if (submitBtn) {
        const newSubmitBtn = submitBtn.cloneNode(true);
        submitBtn.parentNode.replaceChild(newSubmitBtn, submitBtn);
        newSubmitBtn.addEventListener('click', () => {
            const topQuests = processPathfinderAnswers();
            if (topQuests) {
                renderPathfinderResults(topQuests);
            }
        });
    }
    if (retakeBtn) {
        const newRetakeBtn = retakeBtn.cloneNode(true);
        retakeBtn.parentNode.replaceChild(newRetakeBtn, retakeBtn);
        newRetakeBtn.addEventListener('click', () => {
            resetPathfinder();
        });
    }
}

// ==============================================
// SECTION 32: ACHIEVEMENTS INITIALIZATION
// ==============================================

function initializeAchievementsSystem() {
    const achievementsBtn = document.getElementById("achievements-btn");
    if (achievementsBtn) {
        const newBtn = achievementsBtn.cloneNode(true);
        achievementsBtn.parentNode.replaceChild(newBtn, achievementsBtn);
        newBtn.addEventListener("click", openAchievementsOverlay);
    }
}

// ==============================================
// SECTION 33: RUBRIC POPUP - DISPLAY
// ==============================================

async function openRubricPopup(cityId, isSelfAssessment = false, knownImageUrl = undefined) {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {

        return;
    }

    const overlay = document.getElementById("rubric-overlay");
    const content = document.getElementById("rubric-content");
    const title = document.getElementById("rubric-title");
    const closeBtn = document.getElementById("close-rubric");

    document.getElementById("quest-overlay").style.display = "none";

    const quest = quests[cityId];
    if (!quest || !quest.rubric) {

        return;
    }

    currentQuestId = cityId;
    title.textContent = quest.rubric.overall || quest.title;

    const isSelfAssessmentMode = isSelfAssessment || window._selfAssessmentPending;

    // --- Show overlay IMMEDIATELY with a spinner so the student gets instant feedback ---
    content.innerHTML = `<div style="padding:40px; text-align:center; color:#f0e6d2; font-size:16px;">⏳ Loading rubric…</div>`;
    overlay.style.display = "flex";
    if (closeBtn) closeBtn.style.display = 'none';

    // --- Fire teacher/framework lookup and student_works fetch in PARALLEL ---
    // If we were given a known image URL (post-save path), skip the works fetch entirely.
    const frameworkPromise = detectTeacherFramework();

    const imagePromise = (knownImageUrl !== undefined)
        ? Promise.resolve(knownImageUrl)
        : window.supabase
            .from('student_works')
            .select('image_url')
            .eq('user_id', session.user.id)
            .eq('quest_id', cityId)
            .maybeSingle()
            .then(({ data }) => data?.image_url || null)
            .catch(err => { console.warn("Could not fetch work image:", err); return null; });

    const [framework, workImageUrl] = await Promise.all([frameworkPromise, imagePromise]);

    const isIGCSE = framework === 'igcse';
    const isIB = framework === 'ib-myp';
    const isNCAS = framework === 'ncas';

    // This will hit the cache if we already fetched it in this session,
    // or reuse TeacherCache.teacherId (populated above) for a single query.
    const selectedStandards = await getTeacherStandardsForQuest(cityId);
    
    const isNCASFormat = quest.rubric.standards && Array.isArray(quest.rubric.standards);
    const isIBFormat = quest.rubric.criteria && Array.isArray(quest.rubric.criteria);
    const isIGCSEFormat = quest.rubric.assessment_objectives && Array.isArray(quest.rubric.assessment_objectives);
    
    let itemsToShow = [];
    let gradeLevels = [];
    let headerLabel = '';
    let isMVP = quest.style === "mvp";
    let gradeOptions = [];
    let gradeMapping = {};
    let column = isMVP ? "mvpGrade" : "grade";
    
    if (isNCASFormat) {
        itemsToShow = quest.rubric.standards;
        gradeLevels = ['4', '3', '2', '1'];
        headerLabel = 'Standard';
        gradeOptions = [
            { value: '4', label: '4 - Excellent' },
            { value: '3.5', label: '3.5 - Strong' },
            { value: '3', label: '3 - Good' },
            { value: '2.5', label: '2.5 - Developing' },
            { value: '2', label: '2 - Satisfactory' },
            { value: '1.5', label: '1.5 - Limited' },
            { value: '1', label: '1 - Beginning' }
        ];
        gradeMapping = {
            '4': 4, '3.5': 3.5, '3': 3, '2.5': 2.5,
            '2': 2, '1.5': 1.5, '1': 1
        };
    } else if (isIBFormat) {
        itemsToShow = quest.rubric.criteria;
        gradeLevels = ['7-8', '5-6', '3-4', '1-2'];
        headerLabel = 'Criterion';
        gradeOptions = [
            { value: '7-8', label: '7-8 - Excellent' },
            { value: '5-6', label: '5-6 - Good' },
            { value: '3-4', label: '3-4 - Satisfactory' },
            { value: '1-2', label: '1-2 - Limited' }
        ];
        gradeMapping = {
            '7-8': 7.5, '5-6': 5.5, '3-4': 3.5, '1-2': 1.5
        };
    } else if (isIGCSEFormat) {
        itemsToShow = quest.rubric.assessment_objectives;
        gradeLevels = ['A*-A', 'B-C', 'D-E', 'F-G'];
        headerLabel = 'Assessment Objective';
        gradeOptions = [
            { value: 'A*', label: 'A* - Outstanding' },
            { value: 'A', label: 'A - Excellent' },
            { value: 'B', label: 'B - Good' },
            { value: 'C', label: 'C - Satisfactory' },
            { value: 'D', label: 'D - Limited' },
            { value: 'E', label: 'E - Basic' },
            { value: 'F', label: 'F - Weak' },
            { value: 'G', label: 'G - Very Weak' }
        ];
        gradeMapping = {
            'A*': 8, 'A': 7, 'B': 6, 'C': 5,
            'D': 4, 'E': 3, 'F': 2, 'G': 1
        };
    }
        if (selectedStandards && selectedStandards.length > 0) {
            itemsToShow = itemsToShow.filter(item => selectedStandards.includes(item.code));
        }
    
        if (itemsToShow.length === 0) {
        content.innerHTML = `<div class="rubric-empty-message">
            <p>📋 No ${headerLabel}s Selected</p>
            <p>Your teacher has not selected any ${headerLabel}s for this quest yet.</p>
            <p>Please check back later or contact your teacher.</p>
        </div>`;
        overlay.style.display = "flex";
        if (closeBtn) {
            closeBtn.style.display = 'block';
            closeBtn.onclick = () => {
                overlay.style.display = "none";
                document.getElementById("quest-overlay").style.display = "flex";
            };
        }
        return;
    }
    // workImageUrl is already resolved above (from Promise.all or knownImageUrl).
    // No duplicate fetch needed here.
    // Get existing self-assessment for this quest
    let selfAssessment = {};

    if (window.selfAssessments && window.selfAssessments[cityId]) {
        selfAssessment = window.selfAssessments[cityId];
    }
    
    let html = '';
    
    if (workImageUrl) {
        html += `
            <div class="self-assessment-header" style="display: flex; gap: 20px; align-items: center; margin-bottom: 15px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px;">
                <div class="self-assessment-image">
                    <img src="${workImageUrl}" alt="Your work" style="max-width: 150px; max-height: 150px; border-radius: 8px; border: 2px solid #ffd700; object-fit: cover;">
                </div>
                <div class="self-assessment-info">
                    ${isSelfAssessmentMode ? `
                        <h3 style="color: #ffd700; margin: 0;">📝 Self-Assessment Required</h3>
                        <p style="color: #f0e6d2; margin: 5px 0;">Review your work and honestly assess your performance.</p>
                        <p style="color: #ffd700; font-size: 14px; font-style: italic;">"The artist who judges their own work grows faster than any teacher can teach."</p>
                    ` : `
                        <h3 style="color: #ffd700; margin: 0;">📋 Your Work</h3>
                        <p style="color: #f0e6d2; margin: 5px 0;">Review your submitted work before viewing the rubric.</p>
                    `}
                </div>
            </div>
        `;
    } else if (isSelfAssessmentMode) {
        html += `
            <div class="self-assessment-header" style="margin-bottom: 15px; padding: 10px; background: rgba(255, 0, 0, 0.15); border-radius: 8px; border: 1px solid rgba(255, 0, 0, 0.3);">
                <p style="color: #ff8888; margin: 0;">⚠️ No work image found. Please submit your work before self-assessment.</p>
            </div>
        `;
    }
    
    html += `
        <div class="rubric-display-note" style="background: #2d2a94; padding: 10px; margin-bottom: 15px; border-radius: 5px;">
            ${isSelfAssessmentMode ? '📋 Select the grade you believe you deserve for each standard. Be honest!' : '📋 This rubric shows how your teacher will evaluate your work. Grades will appear here after your teacher reviews your submission.'}
        </div>
        <table class="rubric-table">
            <thead>
                <tr>
                    <th style="min-width: 120px;">${headerLabel}</th>
                    <th>${gradeLevels[0]}</th>
                    <th>${gradeLevels[1]}</th>
                    <th>${gradeLevels[2]}</th>
                    <th>${gradeLevels[3]}</th>
                    <th style="min-width: ${isSelfAssessmentMode ? '180px' : '100px'};">
                        ${isSelfAssessmentMode ? 'My Assessment' : 'Your Grade'}
                    </th>
                </tr>
            </thead>
            <tbody>
    `;
    
    let allSelected = true;
    const columnType = isMVP ? "mvpGrade" : "grade";
    
    itemsToShow.forEach(item => {
        const teacherGrade = questGrades[cityId]?.[columnType]?.[item.code] ?? "";
        const selfGrade = selfAssessment[item.code] || "";
        const hasTeacherGrade = teacherGrade !== "";
        const hasSelfGrade = selfGrade !== "";
        
        // Determine which level to highlight for teacher (yellow)
        let teacherHighlightLevel = null;
        if (hasTeacherGrade) {
            let gradeNum = parseFloat(teacherGrade);
            if (isIGCSE) {
                teacherHighlightLevel = gradeNum ? Math.ceil(gradeNum / 2) : null;
            } else if (isIB) {
                const bandNum = parseFloat(teacherGrade);
                if (bandNum >= 7) teacherHighlightLevel = 4;
                else if (bandNum >= 5) teacherHighlightLevel = 3;
                else if (bandNum >= 3) teacherHighlightLevel = 2;
                else if (bandNum >= 1) teacherHighlightLevel = 1;
            } else {
                // NCAS: 4, 3.5, 3, 2.5, 2, 1.5, 1
                // Map to levels 1-4
                if (gradeNum >= 4) teacherHighlightLevel = 4;
                else if (gradeNum >= 3) teacherHighlightLevel = 3;
                else if (gradeNum >= 2) teacherHighlightLevel = 2;
                else if (gradeNum >= 1) teacherHighlightLevel = 1;
            }
        }
        
        // Determine which level to highlight for self-assessment (teal)
        let selfHighlightLevel = null;
        if (hasSelfGrade) {
            // Convert self-grade string to number for comparison
            let selfNum = parseFloat(selfGrade);
            if (isIGCSE) {
                // IGCSE letter grades
                const gradeMap = { 'A*': 8, 'A': 7, 'B': 6, 'C': 5, 'D': 4, 'E': 3, 'F': 2, 'G': 1 };
                selfNum = gradeMap[selfGrade] || 0;
                selfHighlightLevel = selfNum ? Math.ceil(selfNum / 2) : null;
            } else if (isIB) {
                // IB bands
                if (selfGrade === '7-8') selfHighlightLevel = 4;
                else if (selfGrade === '5-6') selfHighlightLevel = 3;
                else if (selfGrade === '3-4') selfHighlightLevel = 2;
                else if (selfGrade === '1-2') selfHighlightLevel = 1;
            } else {
                // NCAS
                if (selfNum >= 4) selfHighlightLevel = 4;
                else if (selfNum >= 3) selfHighlightLevel = 3;
                else if (selfNum >= 2) selfHighlightLevel = 2;
                else if (selfNum >= 1) selfHighlightLevel = 1;
            }
        }
        
        let gradeDisplay = "—";
        if (hasTeacherGrade) {
            if (isIGCSE) {
                gradeDisplay = convertNumberToLetterGrade(parseInt(teacherGrade));
            } else if (isIB) {
                const numGrade = parseFloat(teacherGrade);
                if (numGrade >= 7) gradeDisplay = "7-8";
                else if (numGrade >= 5) gradeDisplay = "5-6";
                else if (numGrade >= 3) gradeDisplay = "3-4";
                else if (numGrade >= 1) gradeDisplay = "1-2";
                else gradeDisplay = teacherGrade;
            } else {
                gradeDisplay = teacherGrade;
            }
        }
        
        let dropdownOptions = '';
        if (isSelfAssessmentMode) {
            dropdownOptions += `<option value="">— Select —</option>`;
            gradeOptions.forEach(opt => {
                const selected = selfGrade === opt.value ? 'selected' : '';
                dropdownOptions += `<option value="${opt.value}" ${selected}>${opt.label}</option>`;
            });
        }
        
        if (isSelfAssessmentMode && !selfGrade) {
            allSelected = false;
        }
        
        // ==========================================
        // BUILD THE DESCRIPTION CELLS WITH HIGHLIGHTS
        // ==========================================
        // Level 4 cell
        let level4Class = '';
        if (teacherHighlightLevel === 4) level4Class = 'teacher-highlight';
        if (selfHighlightLevel === 4) level4Class = level4Class ? level4Class + ' self-highlight' : 'self-highlight';
        
        // Level 3 cell
        let level3Class = '';
        if (teacherHighlightLevel === 3) level3Class = 'teacher-highlight';
        if (selfHighlightLevel === 3) level3Class = level3Class ? level3Class + ' self-highlight' : 'self-highlight';
        
        // Level 2 cell
        let level2Class = '';
        if (teacherHighlightLevel === 2) level2Class = 'teacher-highlight';
        if (selfHighlightLevel === 2) level2Class = level2Class ? level2Class + ' self-highlight' : 'self-highlight';
        
        // Level 1 cell
        let level1Class = '';
        if (teacherHighlightLevel === 1) level1Class = 'teacher-highlight';
        if (selfHighlightLevel === 1) level1Class = level1Class ? level1Class + ' self-highlight' : 'self-highlight';
        
        // ==========================================
        // GRADE CELL DISPLAY
        // ==========================================
        let gradeCellContent = '';
        
        if (isSelfAssessmentMode) {
            // Self-assessment mode: dropdown + selected grade in teal
            gradeCellContent = `
                <div class="self-assessment-cell">
                    <select class="self-assessment-dropdown" data-standard="${item.code}" style="width: 100%; padding: 4px; border-radius: 4px; background: rgba(0,0,0,0.3); color: #f0e6d2; border: 1px solid rgba(255,215,0,0.3);">
                        ${dropdownOptions}
                    </select>
                    ${selfGrade ? `<div style="margin-top: 4px; background: rgba(0, 255, 200, 0.3); padding: 4px 8px; border-radius: 4px; font-size: 14px; color: #b0f0e0; text-align: center; font-weight: bold;">${selfGrade}</div>` : `<div style="margin-top: 4px; font-size: 11px; color: #666; text-align: center;">Select a grade</div>`}
                </div>
            `;
        } else {
            // Normal view: Show grades with colored backgrounds
            if (hasTeacherGrade && hasSelfGrade) {
                // BOTH exist: Teacher in YELLOW, Self in TEAL
                gradeCellContent = `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="background: rgba(255, 215, 0, 0.3); padding: 4px 8px; border-radius: 4px; font-weight: bold; text-align: center; font-size: 14px; color: #ffd700;">
                            ${gradeDisplay}
                        </div>
                        <div style="background: rgba(0, 255, 200, 0.25); padding: 4px 8px; border-radius: 4px; font-weight: bold; text-align: center; font-size: 14px; color: #b0f0e0;">
                            ${selfGrade}
                        </div>
                    </div>
                `;
            } else if (hasTeacherGrade) {
                // Only teacher grade - YELLOW
                gradeCellContent = `
                    <div style="background: rgba(255, 215, 0, 0.3); padding: 4px 8px; border-radius: 4px; font-weight: bold; text-align: center; font-size: 16px; color: #ffd700;">
                        ${gradeDisplay}
                    </div>
                `;
            } else if (hasSelfGrade) {
                // Only self-assessment - TEAL
                gradeCellContent = `
                    <div style="background: rgba(0, 255, 200, 0.25); padding: 4px 8px; border-radius: 4px; font-weight: bold; text-align: center; font-size: 16px; color: #b0f0e0;">
                        ${selfGrade}
                    </div>
                `;
            } else {
                // No grades yet
                gradeCellContent = `
                    <div style="font-size: 11px; color: #666; text-align: center; padding: 4px;">
                        ⏳ Awaiting grading
                    </div>
                `;
            }
        }
        
        html += `
            <tr>
                <td><strong>${item.code}</strong>${!isNCAS ? `<br><span style="font-size: 11px; color: #aaa;">${item.name}</span>` : ''}</td>
                <td class="${level4Class}">${item.levels[gradeLevels[0]] || ""}</td>
                <td class="${level3Class}">${item.levels[gradeLevels[1]] || ""}</td>
                <td class="${level2Class}">${item.levels[gradeLevels[2]] || ""}</td>
                <td class="${level1Class}">${item.levels[gradeLevels[3]] || ""}</td>
                <td>${gradeCellContent}</td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    const questGrade = (questGrades && questGrades[cityId]) ? questGrades[cityId] : null;
    const teacherComment = questGrade?.[column]?.teacher_comment || null;
    if (teacherComment && teacherComment.trim() !== '') {
        html += `
            <div class="teacher-comment-section" style="margin-top: 15px; padding: 12px; background: rgba(255, 215, 0, 0.1); border-radius: 8px; border-left: 3px solid #ffd700;">
                <div class="teacher-comment-label" style="color: #ffd700; font-weight: bold;">📝 Teacher's Feedback:</div>
                <div class="teacher-comment-content" style="color: #f0e6d2; margin-top: 5px;">${escapeHtml(teacherComment)}</div>
            </div>
        `;
    }
    
    if (isSelfAssessmentMode) {
        html += `
            <div class="self-assessment-footer" style="margin-top: 20px; padding-top: 15px; border-top: 1px solid rgba(255,215,0,0.2);">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                    <div>
                        <span style="color: #ffd700;">⚠️ Please complete all assessments before continuing</span>
                    </div>
                    <button id="submit-self-assessment-btn" class="auth-btn auth-btn-primary" ${allSelected ? '' : 'disabled'} style="${allSelected ? '' : 'opacity: 0.5; cursor: not-allowed;'} padding: 8px 20px;">
                        ${allSelected ? '✅ Submit Self-Assessment' : '⚠️ Complete all selections first'}
                    </button>
                </div>
                <p style="color: #999; font-size: 12px; margin-top: 8px; text-align: center;">Your self-assessment helps you reflect on your work. Be honest and thoughtful.</p>
            </div>
        `;
    }
    
    content.innerHTML = html;
    overlay.style.display = "flex";
    
    if (isSelfAssessmentMode) {
        const dropdowns = overlay.querySelectorAll('.self-assessment-dropdown');
        const submitBtn = document.getElementById('submit-self-assessment-btn');
        
        dropdowns.forEach(dropdown => {
            dropdown.addEventListener('change', function() {
                const tempAssessment = {};
                const allDropdowns = overlay.querySelectorAll('.self-assessment-dropdown');
                allDropdowns.forEach(d => {
                    if (d.value) {
                        tempAssessment[d.dataset.standard] = d.value;
                    }
                });
                localStorage.setItem('pendingSelfAssessment_' + cityId, JSON.stringify(tempAssessment));
                localStorage.setItem('pendingSelfAssessmentQuest', cityId);
                
                let allFilled = true;
                allDropdowns.forEach(d => {
                    if (!d.value) allFilled = false;
                });
                
                if (allFilled) {
                    submitBtn.disabled = false;
                    submitBtn.style.opacity = '1';
                    submitBtn.style.cursor = 'pointer';
                    submitBtn.textContent = '✅ Submit Self-Assessment';
                } else {
                    submitBtn.disabled = true;
                    submitBtn.style.opacity = '0.5';
                    submitBtn.style.cursor = 'not-allowed';
                    submitBtn.textContent = '⚠️ Complete all selections first';
                }
            });
        });
        
        if (submitBtn) {
            submitBtn.addEventListener('click', function() {
                const assessment = {};
                const allDropdowns = overlay.querySelectorAll('.self-assessment-dropdown');
                allDropdowns.forEach(d => {
                    if (d.value) {
                        assessment[d.dataset.standard] = d.value;
                    }
                });
                saveSelfAssessment(cityId, assessment);
            });
        }
        
        const pendingData = localStorage.getItem('pendingSelfAssessment_' + cityId);
        if (pendingData) {
            try {
                const pending = JSON.parse(pendingData);
                const dropdowns2 = overlay.querySelectorAll('.self-assessment-dropdown');
                dropdowns2.forEach(d => {
                    if (pending[d.dataset.standard]) {
                        d.value = pending[d.dataset.standard];
                        d.dispatchEvent(new Event('change'));
                    }
                });
                // Do NOT remove the pending key here — keep it until the student
                // actually submits, so an interrupted session can still be recovered.
                localStorage.setItem('pendingSelfAssessmentQuest', cityId);
            } catch (e) {

            }
        }
    }
    
    if (!isSelfAssessmentMode) {
        if (closeBtn) {
            closeBtn.style.display = 'block';
            closeBtn.onclick = () => {
                overlay.style.display = "none";
                document.getElementById("quest-overlay").style.display = "flex";
            };
        }
    } else {
        if (closeBtn) {
            closeBtn.style.display = 'none';
        }
    }
}

// ==============================================
// SECTION 33b: SELF-ASSESSMENT FUNCTIONS
// ==============================================

async function saveSelfAssessment(questId, assessment) {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {
        alert("Please log in to save your self-assessment.");
        return;
    }
    
    // Validate all standards have selections
    const quest = quests[questId];
    if (!quest || !quest.rubric) {
        alert("Quest not found.");
        return;
    }
    
    // Check which standards are selected (teacher-selected)
    const selectedStandards = await getTeacherStandardsForQuest(questId);
    let itemsToCheck = [];
    if (quest.rubric.standards) {
        itemsToCheck = quest.rubric.standards;
    } else if (quest.rubric.criteria) {
        itemsToCheck = quest.rubric.criteria;
    } else if (quest.rubric.assessment_objectives) {
        itemsToCheck = quest.rubric.assessment_objectives;
    }
    
    if (selectedStandards && selectedStandards.length > 0) {
        itemsToCheck = itemsToCheck.filter(item => selectedStandards.includes(item.code));
    }
    
    // Check if all standards have a selection
    for (const item of itemsToCheck) {
        if (!assessment[item.code]) {
            alert(`Please select a grade for ${item.code}`);
            return;
        }
    }
    
    // Save to database
    const userId = session.user.id;
    
    // Get existing progress
    const { data: progress, error: fetchError } = await window.supabase
        .from('student_progress')
        .select('self_assessments')
        .eq('user_id', userId)
        .maybeSingle();
    
    let selfAssessments = {};
    if (progress?.self_assessments) {
        selfAssessments = progress.self_assessments;
    }
    
    // Update with new assessment
    selfAssessments[questId] = assessment;
    
    // Save back to database
    const { error: saveError } = await window.supabase
        .from('student_progress')
        .update({
            self_assessments: selfAssessments,
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);
    
    if (saveError) {

        alert("Error saving your self-assessment. Please try again.");
        return;
    }
    
    // Also save locally
    if (!window.selfAssessments) window.selfAssessments = {};
    window.selfAssessments[questId] = assessment;
    localStorage.setItem('selfAssessments', JSON.stringify(window.selfAssessments));
    
    // Clear pending auto-save
    localStorage.removeItem('pendingSelfAssessment_' + questId);
    localStorage.removeItem('pendingSelfAssessmentQuest');
    
    // Close the rubric overlay (self-assessment mode)
    const overlay = document.getElementById("rubric-overlay");
    if (overlay) {
        overlay.style.display = "none";
    }
    document.getElementById("quest-overlay").style.display = "flex";
    
    // Show success message
    alert("✅ Self-assessment submitted successfully! You can now continue your journey.");
    
    // Clear the self-assessment pending flag
    window._selfAssessmentPending = false;
    
    // Update profile if open
    const profileOverlay = document.getElementById("profile-overlay");
    if (profileOverlay && profileOverlay.style.display === "flex") {
        if (typeof renderBadges === 'function') renderBadges();
    }
}

// ==============================================
// SECTION 34: REWARD OVERLAY
// ==============================================
function closeRewardsOverlay() {
    const overlay = document.getElementById("rewards-overlay");
    if (overlay) overlay.style.display = "none";

    // Hide any lingering tooltips
    document.querySelectorAll(".exp-breakdown-tooltip").forEach(el => el.remove());

    // Reopen the profile overlay if we came from there
    if (window._reopenProfileAfterRewards) {
        window._reopenProfileAfterRewards = false;
        const profileOverlay = document.getElementById("profile-overlay");
        if (profileOverlay) profileOverlay.style.display = "flex";
    }
}

/**
 * Render the full EXP breakdown into the given container.
 */
function renderExpBreakdown(container) {
    const groups = buildExpBreakdownGroups();
    const total = expTotal;
    const info = getLevelInfo(total);

    // Header
    const header = `
        <div class="exp-breakdown-header">
            <div class="exp-breakdown-total">
                <span class="exp-breakdown-total-label">Total</span>
                <span class="exp-breakdown-total-value">${total} EXP</span>
            </div>
            <div class="exp-breakdown-level">
                Level ${info.level} · ${info.current} / ${info.needed} to next
            </div>
        </div>
    `;

    // Nothing earned yet?
    const hasAny = groups.some(g => g.entries.length > 0);
    if (!hasAny) {
        container.innerHTML = header + `
            <div class="exp-breakdown-empty">
                You haven't earned any EXP yet.<br>
                Complete quests and earn badges to get started!
            </div>
        `;
        return;
    }

    // Groups
    let groupsHtml = "";
    for (const g of groups) {
        if (g.entries.length === 0) continue;   // hide empty groups here

        const groupTotal = g.entries.reduce((s, e) => s + e.amount, 0);
        const rows = g.entries.map(e => `
            <div class="exp-breakdown-row">
                <span class="exp-breakdown-row-label" title="${escapeHtml(e.rawKey)}">${escapeHtml(e.label)}</span>
                <span class="exp-breakdown-row-amount">+${e.amount}</span>
            </div>
        `).join("");

        groupsHtml += `
            <div class="exp-breakdown-group" data-group="${escapeHtml(g.key)}">
                <div class="exp-breakdown-group-header" role="button" tabindex="0">
                    <span class="exp-breakdown-group-arrow">▶</span>
                    <span class="exp-breakdown-group-label">${escapeHtml(g.label)}</span>
                    <span class="exp-breakdown-group-count">(${g.entries.length})</span>
                    <span class="exp-breakdown-group-total">+${groupTotal}</span>
                </div>
                <div class="exp-breakdown-group-body">
                    ${rows}
                </div>
            </div>
        `;
    }

    container.innerHTML = header + `<div class="exp-breakdown-groups">${groupsHtml}</div>`;

    // Wire accordion toggles
    container.querySelectorAll(".exp-breakdown-group-header").forEach(h => {
        h.addEventListener("click", () => {
            const group = h.closest(".exp-breakdown-group");
            if (group) toggleExpGroup(group);
        });
        h.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const group = h.closest(".exp-breakdown-group");
                if (group) toggleExpGroup(group);
            }
        });
    });
}

function toggleExpGroup(groupEl) {
    const isOpen = groupEl.classList.toggle("expanded");
    const arrow = groupEl.querySelector(".exp-breakdown-group-arrow");
    if (arrow) arrow.textContent = isOpen ? "▼" : "▶";
}

/**
 * Group expLog into display groups with human-readable labels.
 * Every entry:
 *   { rawKey, label, amount }
 */
function buildExpBreakdownGroups() {
    const groups = [
        { key: "quest",       label: "Quest completion",         entries: [] },
        { key: "timing",      label: "Upload & timing bonuses",  entries: [] },
        { key: "achievement", label: "Achievement bonuses",      entries: [] },
        { key: "badge",       label: "Badge bonuses",            entries: [] },
        { key: "gift",        label: "Gift bonuses",             entries: [] },
        { key: "battle",      label: "Art battle & community",   entries: [] },
        { key: "other",       label: "Other",                    entries: [] }
    ];

    const byKey = {};
    for (const g of groups) byKey[g.key] = g;

    for (const [key, amount] of Object.entries(expLog)) {
        if (!amount) continue;

        const entry = { rawKey: key, label: _labelForExpKey(key), amount };
        const group = _groupForExpKey(key);
        byKey[group].entries.push(entry);
    }

    // Sort entries within each group for stable display
    for (const g of groups) {
        g.entries.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
    }

    return groups;
}

function _groupForExpKey(key) {
    if (key.startsWith("quest:"))        return "quest";
    if (key.startsWith("before_time:"))  return "timing";
    if (key.startsWith("upload:"))       return "timing";
    if (key.startsWith("first_upload:")) return "timing";
    if (key.startsWith("high_standards:")) return "timing";
    if (key.startsWith("achievement:"))  return "achievement";
    if (key.startsWith("badge:"))        return "badge";
    if (key.startsWith("gift:"))         return "gift";
    if (key.startsWith("vote:"))         return "battle";
    if (key.startsWith("submit_battle:")) return "battle";
    return "other";
}

function _labelForExpKey(key) {
    // ---- Quest completion ----
    if (key.startsWith("quest:")) {
        const qid = key.slice(6);
        const q = quests[qid];
        return q ? `${qid} · ${q.title}` : `${qid} (deleted quest)`;
    }

    // ---- Timing / upload ----
    if (key.startsWith("before_time:")) {
        const qid = key.slice("before_time:".length);
        const q = quests[qid];
        const title = q ? q.title : "(deleted quest)";
        return `Before-deadline · ${qid} · ${title}`;
    }
    if (key.startsWith("upload:")) {
        const rest = key.slice("upload:".length);      // "quest11:2026-W41"
        const idx = rest.lastIndexOf(":");
        const qid = idx >= 0 ? rest.slice(0, idx) : rest;
        const week = idx >= 0 ? rest.slice(idx + 1) : "";
        return `Upload bonus · ${qid} · week ${week}`;
    }
    if (key.startsWith("first_upload:")) {
        const week = key.slice("first_upload:".length);
        return `First upload · week ${week}`;
    }
    if (key.startsWith("high_standards:")) {
        const qid = key.slice("high_standards:".length);
        const q = quests[qid];
        const title = q ? q.title : "(deleted quest)";
        return `All standards ≥ 3.5 · ${qid} · ${title}`;
    }

    // ---- Achievements ----
    if (key.startsWith("achievement:")) {
        return key.slice("achievement:".length);      // already human-readable
    }

    // ---- Badges ----
    if (key.startsWith("badge:")) {
        const rest = key.slice("badge:".length);
        // Format: badgeId[:tN]
        const tIndex = rest.lastIndexOf(":t");
        const badgeId = tIndex >= 0 ? rest.slice(0, tIndex) : rest;
        const tierSuffix = tIndex >= 0 ? rest.slice(tIndex) : "";
        if (Array.isArray(badgesData)) {
            const badge = badgesData.find(b => b.id === badgeId);
            if (badge) {
                const tierLabel = tierSuffix
                    ? ` (${tierSuffix.replace(":", "tier ")})`
                    : "";
                return `${badge.name}${tierLabel}`;
            }
        }
        return key;
    }

    // ---- Gifts ----
    if (key.startsWith("gift:")) {
        // gift:<week>:<questId>
        const rest = key.slice(5);
        const idx = rest.indexOf(":");
        if (idx < 0) return key;
        const week = rest.slice(0, idx);
        const qid = rest.slice(idx + 1);
        const q = quests[qid];
        const title = q ? q.title : "(deleted quest)";
        return `Gift · week ${week} · ${qid} · ${title}`;
    }

    // ---- Art battle ----
    if (key.startsWith("vote:")) {
        return `Art battle vote · ${key.slice(5)}`;
    }
    if (key.startsWith("submit_battle:")) {
        return `Art battle submission · ${key.slice("submit_battle:".length)}`;
    }

    // ---- Fallback ----
    return key;
}

async function openRewardsOverlay() {
    const overlay = document.getElementById("rewards-overlay");
    if (!overlay) {

        return;
    }

    // Hide the profile overlay while the breakdown is open
    const profileOverlay = document.getElementById("profile-overlay");
    if (profileOverlay && profileOverlay.style.display === "flex") {
        profileOverlay.style.display = "none";
        window._reopenProfileAfterRewards = true;
    } else {
        window._reopenProfileAfterRewards = false;
    }

    // Ensure the overlay's inner markup exists.
    // This is a safety net in case the served HTML is stale.
    if (!document.getElementById("rewards-content")) {
        overlay.innerHTML = `
            <div class="exp-breakdown-box">
                <span id="close-rewards" class="close-btn">✖</span>
                <h2 class="exp-breakdown-title">EXP Breakdown</h2>
                <div id="rewards-content" class="exp-breakdown-content"></div>
            </div>
        `;
    }

    const contentEl = document.getElementById("rewards-content");
    if (!contentEl) {

        return;
    }

    // Show the overlay, render content
    overlay.style.display = "flex";
    contentEl.innerHTML = `<div class="exp-breakdown-loading">Loading…</div>`;

    renderExpBreakdown(contentEl);
}

function initializeRewardsOverlay() {
    const overlay = document.getElementById("rewards-overlay");

    if (overlay) {
        // Delegate: any click inside the overlay is inspected.
        // - Click lands on the backdrop (overlay itself) → close.
        // - Click lands on #close-rewards (or any child with that id
        //   or a .close-btn class) → close.
        // This survives the button being re-created by openRewardsOverlay.
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                closeRewardsOverlay();
                return;
            }
            if (e.target.closest("#close-rewards")) {
                e.preventDefault();
                e.stopPropagation();
                closeRewardsOverlay();
                return;
            }
        });
    }

    // Wire the profile EXP block as the opener
    wireProfileExpOpener();
}

/**
 * Wire clicks on the profile overlay's EXP block to open the rewards overlay.
 * Called once at startup; also safe to call again after DOM rebuilds.
 */
function wireProfileExpOpener() {
    const block = document.getElementById("profile-exp-block");
    if (!block) return;

    // Avoid double-binding by marking the element
    if (block.dataset.expOpenerWired === "1") return;
    block.dataset.expOpenerWired = "1";

    block.style.cursor = "pointer";
    block.title = "Click to see your full EXP breakdown";

    block.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openRewardsOverlay();
    });
}

// ==============================================
// SECTION 35: TEACHER STANDARDS FILTERING
// ==============================================

async function getTeacherStandardsForQuest(questId) {
    // --- CACHE HIT: only trust POSITIVE results ---
    if (Object.prototype.hasOwnProperty.call(TeacherCache.selectedStandards, questId)) {
        const cached = TeacherCache.selectedStandards[questId];
        if (Array.isArray(cached) && cached.length > 0) {
            return cached;
        }
        // Cached value was null/empty — fall through and re-fetch,
        // in case the teacher has since updated it.
        delete TeacherCache.selectedStandards[questId];
    }

    // --- Resolve teacher id (retry if the previous attempt failed) ---
    if (!TeacherCache.teacherId) {
        // Force a fresh lookup, ignoring the framework cache,
        // because a stale 'ncas' fallback can hide the real teacher.
        TeacherCache.framework = null;
        TeacherCache.loaded = false;
        await detectTeacherFramework();
    }

    if (!TeacherCache.teacherId) {

        // Do NOT cache the null here — allow a retry next open.
        return null;
    }

    const { data, error } = await window.supabase
        .from('teacher_quest_standards')
        .select('selected_standards')
        .eq('teacher_id', TeacherCache.teacherId)
        .eq('quest_id', questId)
        .maybeSingle();

    if (error) {
        if (error.code !== 'PGRST116') {

        }
        // Don't cache on error — allow a retry next open.
        return null;
    }

    const result = data?.selected_standards || null;

    // Log the resolution so you can verify in the console.


    // Cache only when we actually got codes back.
    if (Array.isArray(result) && result.length > 0) {
        TeacherCache.selectedStandards[questId] = result;
    }

    return result;
}

async function loadTeacherNameForProfile() {
    const profile = loadStudentProfile();
    if (!profile || !profile.teacher_code) {
        const { data: { session } } = await window.supabase.auth.getSession();
        if (session) {
            const { data: profileData } = await window.supabase
                .from('profiles')
                .select('teacher_code')
                .eq('id', session.user.id)
                .single();
            if (profileData?.teacher_code) {
                const updatedProfile = { ...profile, teacher_code: profileData.teacher_code };
                saveStudentProfile(updatedProfile);
                profile.teacher_code = profileData.teacher_code;
            } else {
                return;
            }
        } else {
            return;
        }
    }
    const { data: teacher, error } = await window.supabase
        .from('teachers')
        .select('name')
        .eq('class_code', profile.teacher_code)
        .single();
    if (!error && teacher) {
        currentTeacherName = teacher.name;
        const teacherNameSpan = document.getElementById("profile-teacher-name");
        if (teacherNameSpan) {
            teacherNameSpan.textContent = currentTeacherName;
        }
    }
}

// ==============================================
// SECTION 36: 
// ==============================================

// ==============================================
// SECTION 37: PROFILE BUTTON HANDLER
// ==============================================

function initializeProfileSystem() {
    const profileBtn = document.getElementById("profile-btn");
    const profileOverlay = document.getElementById("profile-overlay");
    const profileClose = document.getElementById("profile-close");
    if (!profileBtn || !profileOverlay || !profileClose) return;

    initializeProfileSideTabs();   // <-- NEW

    const newProfileBtn = profileBtn.cloneNode(true);
    profileBtn.parentNode.replaceChild(newProfileBtn, profileBtn);
    newProfileBtn.addEventListener("click", async () => {
        await loadStudentDataFromCloud();
        await loadTeacherNameForProfile();
        profileOverlay.style.display = "flex";

        // Reset to Profile tab each time it opens
        if (typeof window.__activateProfileTab === 'function') {
            window.__activateProfileTab('profile');
        }

        updateProfileStandardsTable();
        renderRadarChart();
        updateProfileUI();
        if (typeof showAvatarChangeUI === 'function') showAvatarChangeUI();
        if (typeof renderBadges === 'function') renderBadges();
        if (typeof renderWeightedCategories === 'function') renderWeightedCategories();
        if (typeof renderProfileExpBar === 'function') renderProfileExpBar();
    });

    const newProfileClose = profileClose.cloneNode(true);
    profileClose.parentNode.replaceChild(newProfileClose, profileClose);
    newProfileClose.addEventListener("click", () => {
        profileOverlay.style.display = "none";
    });

    profileOverlay.addEventListener("click", (e) => {
        if (e.target === profileOverlay) {
            profileOverlay.style.display = "none";
        }
    });
}
// ==============================================
// SECTION 37b: PROFILE SIDE TABS
// ==============================================

function initializeProfileSideTabs() {
    const tabs = document.querySelectorAll('.profile-side-tab');
    const panes = {
        profile:   document.getElementById('profile-tab-profile'),
        completed: document.getElementById('profile-tab-completed')
    };
    const titleEl = document.getElementById('profile-title');

    function activate(tabKey) {
        tabs.forEach(btn => {
            const isActive = btn.dataset.profileTab === tabKey;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        Object.entries(panes).forEach(([key, pane]) => {
            if (pane) pane.classList.toggle('active', key === tabKey);
        });

        // Title swaps with the tab (keeps the header meaningful)
        if (titleEl) {
            titleEl.textContent = (tabKey === 'completed')
                ? 'Completed Quests'
                : "Student's Profile";
        }

        if (tabKey === 'completed') {
            // Render fresh (function has a 3s cache; invalidate so it's current)
            if (typeof invalidateTreeCompletedCache === 'function') invalidateTreeCompletedCache();
            if (typeof renderTreeCompletedPanel === 'function') renderTreeCompletedPanel();
        }
    }

    tabs.forEach(btn => {
        // Clone-and-replace to avoid duplicate listeners on re-init
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => activate(fresh.dataset.profileTab));
    });

    // Expose so the profile-open handler can reset to the Profile tab
    window.__activateProfileTab = activate;
}

// ==============================================
// SECTION 38: AVATAR CHANGE UI
// ==============================================

function showAvatarChangeUI() {
    const changeBtn = document.getElementById("change-avatar-btn");
    if (!changeBtn) return;
    const newChangeBtn = changeBtn.cloneNode(true);
    changeBtn.parentNode.replaceChild(newChangeBtn, changeBtn);
    newChangeBtn.addEventListener("click", () => {
        const setupOverlay = document.getElementById("student-setup-overlay");
        if (setupOverlay) {
            setupOverlay.style.display = "flex";
            const nameInput = document.getElementById("student-name-input");
            const emailInput = document.getElementById("student-email-input");
            const passwordInput = document.getElementById("student-password-input");
            const confirmInput = document.getElementById("student-confirm-password-input");
            const createBtn = document.getElementById("student-create-account-btn");
            const backLink = document.getElementById("back-to-login-link");
            const teacherCode = document.getElementById("student-teacher-code");

            // Hide account-creation fields (already there)
            if (nameInput) nameInput.style.display = "none";
            if (emailInput) emailInput.style.display = "none";
            if (passwordInput) passwordInput.style.display = "none";
            if (confirmInput) confirmInput.style.display = "none";
            if (createBtn) createBtn.style.display = "none";
            if (backLink) backLink.style.display = "none";

            // NEW: hide the heading, subtitle, and teacher code
            const headingEl = setupOverlay.querySelector(".scroll-body > h1");
            const subtitleEl = setupOverlay.querySelector(".scroll-body > p");
            if (headingEl) headingEl.style.display = "none";
            if (subtitleEl) subtitleEl.style.display = "none";
            if (teacherCode) teacherCode.style.display = "none";

            const characterDiv = document.getElementById("character-selection");
            if (characterDiv) characterDiv.style.display = "block";
            const charactersList = document.getElementById("characters-list");
            if (charactersList && charactersList.innerHTML === "") {
                loadCharacterSelectionForProfile(charactersList);
            }
        }
    });
}

function loadCharacterSelectionForProfile(container) {
    fetch("characters/characters.json")
        .then(res => res.json())
        .then(characters => {
            container.innerHTML = "";
            characters.forEach(charFile => {
                const img = document.createElement("img");
                img.src = "characters/" + charFile;
                img.classList.add("character-img");
                img.style.cssText = "width: 80px; height: 80px; cursor: pointer; border-radius: 50%; margin: 5px; border: 2px solid gold;";
                img.addEventListener("click", async () => {
                    const imagePath = "characters/" + charFile;
                    const currentProfile = loadStudentProfile();
                    const studentName = currentProfile ? currentProfile.name : "Student";
                    const profile = { name: studentName, character: imagePath };
                    saveStudentProfile(profile);
                    updateProfileUI();
                    const { data: { session } } = await window.supabase.auth.getSession();
                    if (session) {
                        const { error } = await window.supabase
                            .from('profiles')
                            .upsert({
                                id: session.user.id,
                                name: studentName,
                                avatar_url: imagePath,
                                email: session.user.email
                            });
                        if (error) console.error("Error saving avatar to cloud:", error);
                    }
                    const setupOverlay = document.getElementById("student-setup-overlay");
                    if (setupOverlay) setupOverlay.style.display = "none";
                });
                container.appendChild(img);
            });
        })
        .catch(err => console.error("Failed to load characters.json:", err));
}

function resetSetupOverlayVisibility() {
    const overlay = document.getElementById("student-setup-overlay");
    if (!overlay) return;
    ["student-name-input","student-email-input","student-password-input",
     "student-confirm-password-input","student-create-account-btn",
     "back-to-login-link","student-teacher-code"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "";
    });
    const heading = overlay.querySelector(".scroll-body > h1");
    const subtitle = overlay.querySelector(".scroll-body > p");
    if (heading) heading.style.display = "";
    if (subtitle) subtitle.style.display = "";
    const characterDiv = document.getElementById("character-selection");
    if (characterDiv) characterDiv.style.display = "none";
}

// ==============================================
// SECTION 39: MVP GRADE LOGIC
// ==============================================

function computeStandardAverage(isMVP, standardCode) {
    let sum = 0;
    let count = 0;
    for (const qid in questGrades) {
        const quest = quests[qid];
        if (!quest) continue;
        if (!completedQuests[qid]) continue;
        if (isMVP && quest.style !== "mvp") continue;
        if (!isMVP && quest.style === "mvp") continue;
        const column = isMVP ? "mvpGrade" : "grade";
        const raw = questGrades[qid]?.[column]?.[standardCode];
        if (raw !== null && raw !== undefined && !isNaN(raw)) {
            sum += raw;
            count++;
        }
    }
    return count ? (sum / count) : "";
}

// ==============================================
// SECTION 40: PROFILE GRADE AVERAGE
// ==============================================

async function updateProfileStandardsTable() {
    const tbody = document.getElementById("standards-table-body");
    if (!tbody) return;
    const framework = await detectTeacherFramework();
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    if (isIB) {
        await renderIBStandardsTable(tbody);
    } else if (isIGCSE) {
        await renderIGCSESTandardsTable(tbody);
    } else {
        await renderNCASStandardsTable(tbody);
    }
}

async function renderNCASStandardsTable(tbody) {
    const table = document.getElementById("standards-table");
    if (table) {
        const thead = table.querySelector("thead");
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th>Standard</th>
                    <th>Formative Grade</th>
                    <th>Summative Grade</th>
                </tr>
            `;
        }
    }
    const userId = window.currentUserId || (await getCurrentUserId());
    if (!userId) {

        tbody.innerHTML = '<tr><td colspan="3">Please log in to view standards</td></tr>';
        return;
    }
    const { data: progress, error } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) {

        tbody.innerHTML = '<tr><td colspan="3">Error loading standards</td></tr>';
        return;
    }
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    const mvpQuests = [];
    const regularQuests = [];
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = quests[questId];
        if (!quest) continue;
        if (quest.style === 'mvp') {
            mvpQuests.push(questId);
        } else {
            regularQuests.push(questId);
        }
    }
    const mvpScores = {};
    const mvpCounts = {};
    const regularScores = {};
    const regularCounts = {};
    for (const questId of mvpQuests) {
        const grades = questGrades[questId]?.mvpGrade || {};
        for (const [standard, grade] of Object.entries(grades)) {
            mvpScores[standard] = (mvpScores[standard] || 0) + grade;
            mvpCounts[standard] = (mvpCounts[standard] || 0) + 1;
        }
    }
    for (const questId of regularQuests) {
        const grades = questGrades[questId]?.grade || {};
        for (const [standard, grade] of Object.entries(grades)) {
            regularScores[standard] = (regularScores[standard] || 0) + grade;
            regularCounts[standard] = (regularCounts[standard] || 0) + 1;
        }
    }
    const standards = [
        { code: "Art.FA.CR.1.1.IA", name: "Generate" },
        { code: "Art.FA.CR.1.2.IA", name: "Practice" },
        { code: "Art.FA.CR.2.1.IA", name: "Explore" },
        { code: "Art.FA.CR.2.3.IA", name: "Transform" },
        { code: "Art.FA.CR.3.1.IA", name: "Reflect" },
        { code: "Art.FA.PR.6.1.IA", name: "Analyze" },
        { code: "Art.FA.RE.8.1.8A", name: "Interpret" },
        { code: "Art.FA.CN.10.1.IA", name: "Document" }
    ];
    tbody.innerHTML = '';
    for (const standard of standards) {
        const formativeAvg = regularCounts[standard.code] ? (regularScores[standard.code] / regularCounts[standard.code]).toFixed(2) : '—';
        const summativeAvg = mvpCounts[standard.code] ? (mvpScores[standard.code] / mvpCounts[standard.code]).toFixed(2) : '—';
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${standard.code}</strong><br><span style="font-size: 11px;">${standard.name}</span></td>
            <td>${formativeAvg}</td>
            <td>${summativeAvg}</td>
        `;
        tbody.appendChild(row);
    }
}

async function renderIBStandardsTable(tbody) {
    const table = document.getElementById("standards-table");
    if (table) {
        const thead = table.querySelector("thead");
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th>Criterion</th>
                    <th>Formative Grade</th>
                    <th>Summative Grade</th>
                </tr>
            `;
        }
    }
    const userId = window.currentUserId || (await getCurrentUserId());
    if (!userId) {

        tbody.innerHTML = '<tr><td colspan="3">Please log in to view standards</td></tr>';
        return;
    }
    const { data: progress, error } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests')
        .eq('user_id', userId)
        .maybeSingle();
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    const mvpQuests = [];
    const regularQuests = [];
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = quests[questId];
        if (!quest) continue;
        if (quest.style === 'mvp') {
            mvpQuests.push(questId);
        } else {
            regularQuests.push(questId);
        }
    }
    const mvpScores = { A: 0, B: 0, C: 0, D: 0 };
    const mvpCounts = { A: 0, B: 0, C: 0, D: 0 };
    const regularScores = { A: 0, B: 0, C: 0, D: 0 };
    const regularCounts = { A: 0, B: 0, C: 0, D: 0 };
    function addGradeToCriterion(criterionCode, grade, isMvp) {
        if (!grade || isNaN(grade)) return;
        const targetScores = isMvp ? mvpScores : regularScores;
        const targetCounts = isMvp ? mvpCounts : regularCounts;
        targetScores[criterionCode] = (targetScores[criterionCode] || 0) + grade;
        targetCounts[criterionCode] = (targetCounts[criterionCode] || 0) + 1;
    }
    for (const questId of regularQuests) {
        const quest = quests[questId];
        if (!quest || !quest.rubric?.criteria) continue;
        const grades = questGrades[questId]?.grade || {};
        quest.rubric.criteria.forEach(criterion => {
            const grade = grades[criterion.code];
            addGradeToCriterion(criterion.code, grade, false);
        });
    }
    for (const questId of mvpQuests) {
        const quest = quests[questId];
        if (!quest || !quest.rubric?.criteria) continue;
        const grades = questGrades[questId]?.mvpGrade || {};
        quest.rubric.criteria.forEach(criterion => {
            const grade = grades[criterion.code];
            addGradeToCriterion(criterion.code, grade, true);
        });
    }
    const criteria = [
        { code: "A", name: "A: Knowing & Understanding" },
        { code: "B", name: "B: Developing Skills" },
        { code: "C", name: "C: Thinking Creatively" },
        { code: "D", name: "D: Responding" }
    ];
    tbody.innerHTML = '';
    for (const criterion of criteria) {
        const formativeAvg = regularCounts[criterion.code] ? (regularScores[criterion.code] / regularCounts[criterion.code]).toFixed(2) : '—';
        const summativeAvg = mvpCounts[criterion.code] ? (mvpScores[criterion.code] / mvpCounts[criterion.code]).toFixed(2) : '—';
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${criterion.name}</strong></td>
            <td>${formativeAvg}</td>
            <td>${summativeAvg}</td>
        `;
        tbody.appendChild(row);
    }
}

async function renderIGCSESTandardsTable(tbody) {
    const table = document.getElementById("standards-table");
    if (table) {
        const thead = table.querySelector("thead");
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th>Assessment Objective</th>
                    <th>Grade</th>
                </tr>
            `;
        }
    }
    const userId = window.currentUserId || (await getCurrentUserId());
    if (!userId) {

        tbody.innerHTML = '<tr><td colspan="3">Please log in to view standards</td></tr>';
        return;
    }
    const { data: progress, error } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests')
        .eq('user_id', userId)
        .maybeSingle();
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    const allCompletedQuests = [];
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = quests[questId];
        if (!quest) continue;
        allCompletedQuests.push(questId);
    }
    const totalScores = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
    const totalCounts = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
    function addGradeToAO(aoCode, grade) {
        if (!grade || isNaN(grade)) return;
        totalScores[aoCode] = (totalScores[aoCode] || 0) + grade;
        totalCounts[aoCode] = (totalCounts[aoCode] || 0) + 1;
    }
    for (const questId of allCompletedQuests) {
        const quest = quests[questId];
        if (!quest || !quest.rubric?.assessment_objectives) continue;
        const column = quest.style === "mvp" ? "mvpGrade" : "grade";
        const grades = questGrades[questId]?.[column] || {};
        quest.rubric.assessment_objectives.forEach(ao => {
            const grade = grades[ao.code];
            addGradeToAO(ao.code, grade);
        });
    }
    const assessmentObjectives = [
        { code: "AO1", name: "AO1: Record" },
        { code: "AO2", name: "AO2: Explore & Select" },
        { code: "AO3", name: "AO3: Develop" },
        { code: "AO4", name: "AO4: Present" }
    ];
    tbody.innerHTML = '';
    for (const ao of assessmentObjectives) {
        const avgGrade = totalCounts[ao.code] ? (totalScores[ao.code] / totalCounts[ao.code]).toFixed(2) : '—';
        let displayGrade = avgGrade;
        if (avgGrade !== '—') {
            const numAvg = parseFloat(avgGrade);
            displayGrade = convertNumberToLetterGrade(Math.round(numAvg));
        }
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${ao.name}</strong></td>
            <td>${displayGrade}</td>
        `;
        tbody.appendChild(row);
    }
}

async function getCurrentUserId() {
    const { data: { session } } = await window.supabase.auth.getSession();
    return session?.user?.id;
}

function convertNumberToLetterGrade(number) {
    const gradeMap = {
        8: 'A*',
        7: 'A',
        6: 'B',
        5: 'C',
        4: 'D',
        3: 'E',
        2: 'F',
        1: 'G'
    };
    return gradeMap[number] || '';
}

function convertLetterGradeToNumber(letter) {
    if (!letter) return null;
    const upperLetter = letter.toString().toUpperCase().trim();
    const gradeMap = {
        'A*': 8,
        'A': 7,
        'B': 6,
        'C': 5,
        'D': 4,
        'E': 3,
        'F': 2,
        'G': 1
    };
    return gradeMap[upperLetter] || null;
}

// ==============================================
// SECTION 41: RADAR CHART
// ==============================================

async function computeDomainGrades() {
    const framework = await detectTeacherFramework();
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    if (isIB) {
        return computeIBDomainGrades();
    } else if (isIGCSE) {
        return computeIGCSEDomainGrades();
    } else {
        return computeNCASDomainGrades();
    }
}

function computeNCASDomainGrades() {
    const ncasDomains = {
        creating: [
            "Art.FA.CR.1.1.IA",
            "Art.FA.CR.1.2.IA",
            "Art.FA.CR.2.1.IA",
            "Art.FA.CR.2.3.IA",
            "Art.FA.CR.3.1.IA"
        ],
        presenting: ["Art.FA.PR.6.1.IA"],
        responding: ["Art.FA.RE.8.1.8A"],
        connecting: ["Art.FA.CN.10.1.IA"]
    };
    const domainGrades = {};
    for (const domain in ncasDomains) {
        let sum = 0;
        let count = 0;
        ncasDomains[domain].forEach(code => {
            const avg = computeStandardAverage(true, code);
            if (typeof avg === "number" && !isNaN(avg)) {
                sum += avg;
                count++;
            }
        });
        domainGrades[domain] = count ? sum / count : 0;
    }
    return domainGrades;
}

// ---------------------------------------------------------------
// NCAS weighted-grades radar model.
// Returns the SAME SHAPE as computeNCASDomainGrades (an object of
// key → number), but the keys are the 5 weighted categories and the
// values are percentages (0–100), not 0–4 averages.
//
// We deliberately DON'T include overallPercent — the chart is the
// five axes only, no sixth "overall" node.
// ---------------------------------------------------------------
function computeNCASWeightedDomainGrades() {
    const cats = calculateWeightedCategories();

    // Keys match WEIGHTED_CATEGORY_CONFIG, so the radar labels and
    // the profile's Weighted Grades panel stay in sync.
    return {
        resolvedArtworks:    cats.resolvedArtworks.percent,
        artStudy:            cats.artStudy.percent,
        independentResearch: cats.independentResearch.percent,
        collaboration:       cats.collaboration.percent,
        materialCare:        cats.materialCare.percent
    };
}

async function computeIBDomainGrades() {
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests')
        .eq('user_id', currentUserId || (await getCurrentUserId()))
        .maybeSingle();
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    const mvpQuests = [];
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = quests[questId];
        if (quest && quest.style === 'mvp') {
            mvpQuests.push(questId);
        }
    }
    const criteriaScores = { A: 0, B: 0, C: 0, D: 0 };
    const criteriaCounts = { A: 0, B: 0, C: 0, D: 0 };
    for (const questId of mvpQuests) {
        const quest = quests[questId];
        if (!quest || !quest.rubric?.criteria) continue;
        const grades = questGrades[questId]?.mvpGrade || {};
        quest.rubric.criteria.forEach(criterion => {
            const grade = grades[criterion.code];
            if (grade && typeof grade === 'number' && !isNaN(grade)) {
                criteriaScores[criterion.code] += grade;
                criteriaCounts[criterion.code]++;
            }
        });
    }
    const domainGrades = {
        "A: Knowing & Understanding": criteriaCounts.A ? criteriaScores.A / criteriaCounts.A : 0,
        "B: Developing Skills": criteriaCounts.B ? criteriaScores.B / criteriaCounts.B : 0,
        "C: Thinking Creatively": criteriaCounts.C ? criteriaScores.C / criteriaCounts.C : 0,
        "D: Responding": criteriaCounts.D ? criteriaScores.D / criteriaCounts.D : 0
    };
    return domainGrades;
}

async function computeIGCSEDomainGrades() {
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests')
        .eq('user_id', currentUserId || (await getCurrentUserId()))
        .maybeSingle();
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    const allCompletedQuests = [];
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        allCompletedQuests.push(questId);
    }
    const aoScores = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
    const aoCounts = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
    for (const questId of allCompletedQuests) {
        const quest = quests[questId];
        if (!quest || !quest.rubric?.assessment_objectives) continue;
        const column = quest.style === "mvp" ? "mvpGrade" : "grade";
        const grades = questGrades[questId]?.[column] || {};
        quest.rubric.assessment_objectives.forEach(ao => {
            const grade = grades[ao.code];
            if (grade && typeof grade === 'number' && !isNaN(grade)) {
                aoScores[ao.code] += grade;
                aoCounts[ao.code]++;
            }
        });
    }
    const domainGrades = {
        "AO1: Record": aoCounts.AO1 ? aoScores.AO1 / aoCounts.AO1 : 0,
        "AO2: Explore & Select": aoCounts.AO2 ? aoScores.AO2 / aoCounts.AO2 : 0,
        "AO3: Develop": aoCounts.AO3 ? aoScores.AO3 / aoCounts.AO3 : 0,
        "AO4: Present": aoCounts.AO4 ? aoScores.AO4 / aoCounts.AO4 : 0
    };
    return domainGrades;
}
// ---------------------------------------------------------------
// NCAS weighted-radar colors.
// Key order here matches the axis order used in renderRadarChart:
//   resolvedArtworks → artStudy → independentResearch → collaboration → materialCare
// The polygon fill uses a linear gradient between each adjacent pair.
// ---------------------------------------------------------------
const RADAR_AXIS_COLORS = {
    resolvedArtworks:    { hex: "#3fbf5f", rgb: [ 63, 191,  95] },  // green
    artStudy:            { hex: "#3f8fdf", rgb: [ 63, 143, 223] },  // blue
    independentResearch: { hex: "#9b6bd6", rgb: [155, 107, 214] },  // purple
    collaboration:       { hex: "#e05252", rgb: [224,  82,  82] },  // red
    materialCare:        { hex: "#e6c341", rgb: [230, 195,  65] }   // yellow
};

async function renderRadarChart() {
    const canvas = document.getElementById("radar-chart");
    const tooltip = document.getElementById("radar-tooltip");
    if (!canvas) return;
    const userId = window.currentUserId || (await getCurrentUserId());
    if (!userId) {

        return;
    }
    const framework = await detectTeacherFramework();
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    const isNCAS = framework === 'ncas';
    let radarData = {};
    let labels = [];
    let descriptions = {};
    if (isIB) {
        radarData = await computeIBDomainGrades();
        labels = ["A: Knowing & Understanding", "B: Developing Skills", "C: Thinking Creatively", "D: Responding"];
        descriptions = {
            "A: Knowing & Understanding": "Knowledge of art forms, genres, and movements. Understanding context and using correct terminology.",
            "B: Developing Skills": "Application of techniques, use of media, development of ideas, and artistic choices.",
            "C: Thinking Creatively": "Exploration of ideas, originality, problem-solving, and personal expression.",
            "D: Responding": "Reflection on own work, critique of artwork, and evaluation of artistic development."
        };
    } else if (isIGCSE) {
        radarData = await computeIGCSEDomainGrades();
        labels = ["AO1: Record", "AO2: Explore & Select", "AO3: Develop", "AO4: Present"];
        descriptions = {
            "AO1: Record": "Record ideas, observations and insights relevant to intentions. Document research and process.",
            "AO2: Explore & Select": "Explore and select appropriate resources, media, techniques and processes.",
            "AO3: Develop": "Develop ideas through investigations, demonstrating critical understanding of sources.",
            "AO4: Present": "Present a personal and meaningful response that realises intentions."
        };
        } else if (isNCAS) {
        radarData = computeNCASWeightedDomainGrades();
        labels = [
            "resolvedArtworks",
            "artStudy",
            "independentResearch",
            "collaboration",
            "materialCare"
        ];
        descriptions = {
            resolvedArtworks:    "Resolved Artworks (45% weight): Final, completed artworks that realise your intentions.",
            artStudy:            "Art Study (20% weight): Exercises, studies, and skill-building investigations.",
            independentResearch: "Independent Art Research (15% weight): Your own investigation and documentation (CN.10.1.IA).",
            collaboration:       "Art Community Collaboration (10% weight): Work engaging with the artistic community.",
            materialCare:        "Art Material & Resources Care (10% weight): Responsible use of materials and tools."
        };
    } else {
        radarData = { creating: 0, presenting: 0, responding: 0, connecting: 0 };
        labels = ["creating", "presenting", "responding", "connecting"];
        descriptions = {
            creating: "Creating", presenting: "Presenting", responding: "Responding", connecting: "Connecting"
        };
    }
    const values = labels.map(l => radarData[l] || 0);
    const isNCASChart = (framework === 'ncas');
    const chartMax = isNCASChart ? 100 : 4;   // NCAS plots 0–100, others stay 0–4    
    const ctx = canvas.getContext("2d");
    const size = 350;
    canvas.width = size;
    canvas.height = size;
    const centerX = size / 2;
    const centerY = size / 2;
    const maxRadius = 110;
    const steps = 4;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1;
    for (let s = 1; s <= steps; s++) {
        ctx.beginPath();
        const r = (maxRadius / steps) * s;
        for (let i = 0; i < labels.length; i++) {
            const angle = (Math.PI * 2 / labels.length) * i - Math.PI / 2;
            const x = centerX + r * Math.cos(angle);
            const y = centerY + r * Math.sin(angle);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
    }
    for (let i = 0; i < labels.length; i++) {
        const angle = (Math.PI * 2 / labels.length) * i - Math.PI / 2;
        const x = centerX + maxRadius * Math.cos(angle);
        const y = centerY + maxRadius * Math.sin(angle);
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(x, y);
        ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labelPositions = [];
    for (let i = 0; i < labels.length; i++) {
        const angle = (Math.PI * 2 / labels.length) * i - Math.PI / 2;
        const x = centerX + (maxRadius + 22) * Math.cos(angle);
        const y = centerY + (maxRadius + 22) * Math.sin(angle);
        let displayLabel = labels[i];
        if (isIB) {
            displayLabel = labels[i].charAt(0);
        } else if (isIGCSE) {
            displayLabel = labels[i].split(':')[0];
        } else if (isNCAS) {
            // Short axis labels for the 5-axis weighted chart
            const shortLabels = {
                resolvedArtworks:    "Resol. Art.",
                artStudy:            "Art Std.",
                independentResearch: "Ind. Art Res.",
                collaboration:       "Art Com. Colab.",
                materialCare:        "Mat. & Reso."
            };
            displayLabel = shortLabels[labels[i]] || labels[i];
     }
    ctx.fillText(displayLabel, x, y);
    }
        // ----- Polygon fill + stroke (NCAS = colored gradient, others = original) -----
    const ptPositions = [];
    for (let i = 0; i < values.length; i++) {
        const angle = (Math.PI * 2 / labels.length) * i - Math.PI / 2;
        let scaledValue = values[i];
        if (isIGCSE) scaledValue = values[i] / 2;
        const r = (scaledValue / chartMax) * maxRadius;
        ptPositions.push({
            x: centerX + r * Math.cos(angle),
            y: centerY + r * Math.sin(angle)
        });
    }

    ctx.beginPath();
    ptPositions.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();

        if (isNCASChart) {
        // ------------------------------------------------------------
        // Angular color wheel: sample a color at every angle around
        // the centroid, blending between the two nearest axis colors.
        //
        // Technique:
        //   1. Clip to the polygon (so we only paint inside the shape).
        //   2. Build N=360 thin wedge paths, one per degree.
        //   3. For each wedge, compute the blended color from the two
        //      axis colors straddling that angle, then fill the wedge.
        //
        // Result: green near the Resolved Artworks edge, smoothly
        // blending through blue in the sector between it and Art Study,
        // continuing around the wheel. The center is a perfect blend
        // of all five because every wedge converges there, giving a
        // soft multi-color hub instead of a single dominant color.
        // ------------------------------------------------------------

        const axisKeys = labels;   // same 5 keys, same order as the polygon points
        const colorsForAxis = axisKeys.map(k => RADAR_AXIS_COLORS[k]);

        // Angle for each axis vertex, measured from -π/2 (top), same
        // convention as the polygon drawing above.
        const axisAngles = axisKeys.map((_, i) =>
            (Math.PI * 2 / axisKeys.length) * i - Math.PI / 2
        );

        // Sample a blended color for an arbitrary angle around the circle.
        // Finds the two axis angles this angle lies between, and lerps.
        function colorAtAngle(theta) {
            // Normalize theta to the range of the first axis so we can
            // search between consecutive axis angles.
            const twoPi = Math.PI * 2;
            let t = ((theta - axisAngles[0]) % twoPi + twoPi) % twoPi;

            // Find the pair (i, i+1) whose angles straddle t.
            for (let i = 0; i < axisKeys.length; i++) {
                const a0 = ((axisAngles[i] - axisAngles[0]) % twoPi + twoPi) % twoPi;
                const a1raw = (axisAngles[(i + 1) % axisKeys.length] - axisAngles[0]) % twoPi;
                const a1 = (a1raw + twoPi) % twoPi;

                const end = (i === axisKeys.length - 1) ? twoPi : a1;
                if (t >= a0 && t <= end) {
                    const span = end - a0 || 1;
                    const f = (t - a0) / span;
                    const cA = colorsForAxis[i].rgb;
                    const cB = colorsForAxis[(i + 1) % axisKeys.length].rgb;
                    return [
                        Math.round(cA[0] + (cB[0] - cA[0]) * f),
                        Math.round(cA[1] + (cB[1] - cA[1]) * f),
                        Math.round(cA[2] + (cB[2] - cA[2]) * f)
                    ];
                }
            }
            return colorsForAxis[0].rgb;
        }

        // 1) Clip to polygon
        ctx.save();
        ctx.clip();

        // 2) Soft base so empty areas still read a bit
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(0, 0, size, size);

        // 3) Paint 360 wedges, each a sliver of one degree
        const SEGMENTS = 360;
        const outerR = maxRadius * 1.2;   // safely past any data point
        for (let s = 0; s < SEGMENTS; s++) {
            const a0 = (s / SEGMENTS) * Math.PI * 2 - Math.PI / 2;
            const a1 = ((s + 1) / SEGMENTS) * Math.PI * 2 - Math.PI / 2;
            const mid = (a0 + a1) / 2;
            const [r, g, b] = colorAtAngle(mid);

            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(centerX + outerR * Math.cos(a0), centerY + outerR * Math.sin(a0));
            ctx.lineTo(centerX + outerR * Math.cos(a1), centerY + outerR * Math.sin(a1));
            ctx.closePath();
            ctx.fillStyle = `rgba(${r},${g},${b},0.42)`;
            ctx.fill();
        }
        ctx.restore();

        // 4) Outline: per-edge average color (as before, unchanged)
        ctx.lineWidth = 2.5;
        for (let i = 0; i < labels.length; i++) {
            const a = ptPositions[i];
            const b = ptPositions[(i + 1) % ptPositions.length];
            const keyA = labels[i];
            const keyB = labels[(i + 1) % labels.length];
            const cA = RADAR_AXIS_COLORS[keyA];
            const cB = RADAR_AXIS_COLORS[keyB];
            if (!cA || !cB) continue;
            const mix = cA.rgb.map((v, k) => Math.round((v + cB.rgb[k]) / 2));
            ctx.strokeStyle = `rgb(${mix.join(",")})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }
    } else {
        ctx.fill();
        ctx.stroke();
    
    }
    ctx.fillStyle = "#fff";
    const pointPositions = [];
        values.forEach((val, i) => {
        const angle = (Math.PI * 2 / labels.length) * i - Math.PI / 2;
        let scaledValue = val;
        if (isIGCSE) scaledValue = val / 2;
        const r = (scaledValue / chartMax) * maxRadius;
        const x = centerX + r * Math.cos(angle);
        const y = centerY + r * Math.sin(angle);

        // NCAS: per-axis colored dots. Others: original white dots.
        let dotColor = "#fff";
        if (isNCASChart) {
            const c = RADAR_AXIS_COLORS[labels[i]];
            if (c) dotColor = c.hex;
        }
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(x, y, isNCASChart ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();

        // Thin dark halo so bright dots pop against bright gradients
        if (isNCASChart) {
            ctx.strokeStyle = "rgba(0,0,0,0.55)";
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        pointPositions.push({ x, y, label: labels[i] });
    });
    ctx.fillStyle = "#fff";
    canvas.onmousemove = (e) => {
        const container = document.getElementById("radar-chart-container");
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        let found = false;
        for (const pt of pointPositions) {
            const dist = Math.hypot(mouseX - pt.x, mouseY - pt.y);
            if (dist < 10) {
                tooltip.innerText = descriptions[pt.label] || pt.label;
                tooltip.style.opacity = 1;
                tooltip.style.left = (mouseX + 15) + "px";
                tooltip.style.top = (mouseY - 25) + "px";
                found = true;
                break;
            }
        }
        if (!found) {
            for (const lbl of labelPositions) {
                const dist = Math.hypot(mouseX - lbl.x, mouseY - lbl.y);
                if (dist < 40) {
                    tooltip.innerText = descriptions[lbl.label] || lbl.label;
                    tooltip.style.opacity = 1;
                    tooltip.style.left = (mouseX + 15) + "px";
                    tooltip.style.top = (mouseY - 25) + "px";
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            tooltip.style.opacity = 0;
        }
    };
}

// ==============================================
// SECTION 42: TIMER FUNCTIONS
// ==============================================

function formatTime(minutes, showClasses = true) {
    if (showClasses) {
        const classes = minutes / 75;
        const hours = Math.floor(minutes / 60);
        const mins = Math.floor(minutes % 60);
        const secs = Math.floor((minutes * 60) % 60);
        if (classes >= 1) {
            const wholeClasses = Math.floor(classes);
            const remainingMinutes = Math.round((classes - wholeClasses) * 75);
            if (wholeClasses > 0 && remainingMinutes > 0) {
                return `${wholeClasses} ${wholeClasses === 1 ? 'class' : 'classes'} ${remainingMinutes}m`;
            } else if (wholeClasses > 0) {
                return `${wholeClasses} ${wholeClasses === 1 ? 'class' : 'classes'}`;
            } else {
                return `${remainingMinutes}m`;
            }
        }
    }
    const hours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    const secs = Math.floor((minutes * 60) % 60);
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
}

function initializeQuestTimers() {
    for (const questId in questAccepted) {
        if (questAccepted[questId] && questStartTimes[questId]) {
            startQuestTimer(questId);
        }
    }
    checkAllQuestWarnings();
    updateActiveQuestButton();
    startActiveQuestTimerUpdates();
}

function startQuestTimer(questId) {
    if (questTimers[questId]) clearInterval(questTimers[questId]);
    questTimers[questId] = setInterval(() => {
        checkAllQuestWarnings();
        if (currentQuestId === questId) {
            const remaining = updateTimerDisplay(questId);
            if (remaining <= 0) stopQuestTimer(questId);
        }
    }, 1000);
    updateTimerDisplay(questId);
}

function stopQuestTimer(questId) {
    if (questTimers[questId]) {
        clearInterval(questTimers[questId]);
        delete questTimers[questId];
    }
}

// ==============================================
// SECTION 43: BACKGROUND TIMER CHECK
// ==============================================

function startBackgroundTimerCheck() {
    setInterval(() => {
        for (const questId in questAccepted) {
            if (questAccepted[questId] && !completedQuests[questId]) {
                if (currentQuestId === questId) updateTimerDisplay(questId);
                const remaining = calculateRemainingMinutes(questId);
                if (remaining <= 0) {
                    const questBox = document.getElementById("quest-box");
                    if (questBox && currentQuestId === questId) {
                        questBox.classList.add("times-up");
                        questBox.classList.remove("warning");
                    }
                }
            }
        }
    }, 60000);
}

function calculateRemainingMinutes(questId) {
    if (!questStartTimes[questId]) return 0;
    const quest = quests[questId];
    if (!quest) return 0;

    // Lazy-load the schedule if a timer actually needs it and we
    // don't have it yet. This is fire-and-forget; the next tick
    // (1s later) will use the real values. Until then, isClassDay()
    // falls back to its current default (weekends off).
    if (!_scheduleLoaded && cachedScheduleData.noClassDays.length === 0) {
        ensureScheduleLoaded();
    }

    const classDuration = getClassDurationSync();
    let totalMinutes;
    const customTimer = getCustomTimerForQuestSync(questId);
    if (customTimer !== null) {
        totalMinutes = customTimer * classDuration;
    } else if (quest.timer) {
        totalMinutes = quest.timer.allottedMinutes;
    } else {
        return 0;
    }
    const startTime = new Date(questStartTimes[questId]);
    const now = new Date();
    let elapsedClassDays = 0;
    const current = new Date(startTime);
    const today = new Date(now);
    current.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    while (current < today) {
        if (isClassDay(current)) {
            elapsedClassDays++;
        }
        current.setDate(current.getDate() + 1);
    }
    const elapsedMinutes = elapsedClassDays * classDuration;
    const remainingMinutes = Math.max(0, totalMinutes - elapsedMinutes);
    return remainingMinutes;
}

function updateTimerDisplay(questId) {
    if (!questStartTimes[questId]) return;
    const remaining = calculateRemainingMinutes(questId);
    const timerDisplay = document.getElementById("timer-display");
    const questBox = document.getElementById("quest-box");
    if (timerDisplay && questBox && currentQuestId === questId) {
        timerDisplay.textContent = formatTime(remaining, true);
        const quest = quests[questId];
        let totalMinutes = quest?.timer?.allottedMinutes || 75;
        if (cachedCustomTimer !== null && cachedClassDuration) {
            totalMinutes = cachedCustomTimer * cachedClassDuration;
        }
        const remainingPercent = totalMinutes > 0 ? (remaining / totalMinutes) * 100 : 0;
        const warningThreshold = 30;
        if (remaining <= 0) {
            questBox.classList.add("times-up");
            questBox.classList.remove("warning");
            timerDisplay.textContent = "TIME'S UP!";
        } else if (remainingPercent <= warningThreshold) {
            questBox.classList.add("warning");
            questBox.classList.remove("times-up");
        } else {
            questBox.classList.remove("warning", "times-up");
        }
    }
    checkAllQuestWarnings();
    return remaining;
}

// ==============================================
// SECTION 44: START ACTIVE QUEST TIMER UPDATES
// ==============================================

function startActiveQuestTimerUpdates() {
    if (window._activeQuestTimerInterval) {
        clearInterval(window._activeQuestTimerInterval);
        window._activeQuestTimerInterval = null;
    }
    updateActiveQuestButton();
    window._activeQuestTimerInterval = setInterval(() => {
        updateActiveQuestButton();
    }, 1000);
}

function acceptQuest(questId) {
    const quest = quests[questId];
    if (!quest || !quest.timer) return;
    const check = canAcceptQuest(questId);
    if (!check.allowed) {
        if (check.reason === "active_quest") {
            showRestrictionPopup(check.activeQuestId);
        } else if (check.reason === "prerequisites") {
            let message = "";
            if (check.required === 2) {
                message = `This MVP quest requires at least 2 completed formative quests. You have completed ${check.completed} of the required ${check.required}.`;
            } else {
                message = `This MVP quest requires completing its formative quest first.`;
            }
            showPrerequisitePopup(message, check.prerequisites);
        }
        return;
    }
    if (confirm(`Accept "${quest.title}"?\n\nYou will have ${formatTime(quest.timer.allottedMinutes, true)} to complete this quest.`)) {
        if (activeQuestId && activeQuestId !== questId) {
            questAccepted[activeQuestId] = false;
            stopQuestTimer(activeQuestId);
        }
        questAccepted[questId] = true;
        questStartTimes[questId] = new Date().toISOString();
        saveQuestAccepted();
        saveQuestStartTimes();
        const acceptBtn = document.getElementById("quest-accept");
        if (acceptBtn) {
            acceptBtn.disabled = true;
            acceptBtn.textContent = "Accepted";
        }
        const timerDisplay = document.getElementById("timer-display");
        if (timerDisplay) timerDisplay.style.display = "block";
        startQuestTimer(questId);
        saveQuestData();
        updateActiveQuestButton();
        startActiveQuestTimerUpdates();
        const finishedWorkBtn = document.getElementById("finished-work-btn");
        const linksContainer = document.getElementById("quest-links");
        if (finishedWorkBtn) {
            finishedWorkBtn.style.opacity = "1";
            finishedWorkBtn.style.cursor = "pointer";
            finishedWorkBtn.removeAttribute('disabled');
            finishedWorkBtn.title = "Upload your finished work";
            const newBtn = finishedWorkBtn.cloneNode(true);
            finishedWorkBtn.parentNode.replaceChild(newBtn, finishedWorkBtn);
            newBtn.addEventListener("click", (e) => {
                e.preventDefault();
                if (!currentQuestId) {
                    alert("Please open a quest first to add your work.");
                    return;
                }
                openWorkOverlay(currentQuestId);
            });
        }
        if (linksContainer) {
            linksContainer.style.opacity = "1";
            linksContainer.style.pointerEvents = "auto";
            linksContainer.title = "";
        }
        updateTimerDisplay(questId);
        // Invalidate cache after accepting
        invalidateStudentDataCache();

        // ── NEW: Resource reminder ──────────────────────────────
        // Fires only when the quest's own rubric includes the
        // Independent Art Research standard (CN.10.1.IA).
        if (questHasResearchStandard(quest)) {
            showResourceReminderPopup();
        }
        // ────────────────────────────────────────────────────────
    }
}

function resetQuestTimer(questId) {
    delete questStartTimes[questId];
    delete questAccepted[questId];
    saveQuestStartTimes();
    saveQuestAccepted();
    stopQuestTimer(questId);
    const questBox = document.getElementById("quest-box");
    if (questBox && currentQuestId === questId) {
        questBox.classList.remove("warning", "times-up");
    }
    const timerDisplay = document.getElementById("timer-display");
    if (timerDisplay && currentQuestId === questId) {
        timerDisplay.textContent = "";
        timerDisplay.style.display = "none";
    }
    const acceptBtn = document.getElementById("quest-accept");
    if (acceptBtn && currentQuestId === questId) {
        acceptBtn.disabled = false;
        acceptBtn.textContent = "Accept Quest";
    }
    const questCheck = document.getElementById("quest-check");
    if (questCheck && currentQuestId === questId) {
        questCheck.disabled = false;
        questCheck.title = "";
    }
    // Invalidate cache after reset
    invalidateStudentDataCache();
}

function setupTimerControls(questId) {
    const quest = quests[questId];
    const acceptBtn = document.getElementById("quest-accept");
    const timerDisplay = document.getElementById("timer-display");
    if (!quest || !acceptBtn || !timerDisplay) return;
    const customTimer = getCustomTimerForQuest(questId);
    if (customTimer !== null || quest.timer) {
        acceptBtn.style.display = "block";
        if (questAccepted[questId]) {
            acceptBtn.disabled = true;
            acceptBtn.textContent = "Accepted";
            timerDisplay.style.display = "block";
            if (!questTimers[questId] && questStartTimes[questId]) {
                startQuestTimer(questId);
            }
        } else {
            acceptBtn.disabled = false;
            acceptBtn.textContent = "Accept Quest";
            timerDisplay.style.display = "none";
        }
        const newAcceptBtn = acceptBtn.cloneNode(true);
        acceptBtn.parentNode.replaceChild(newAcceptBtn, acceptBtn);
        newAcceptBtn.addEventListener("click", () => {
            if (!questAccepted[questId]) {
                acceptQuestWithCustomTimer(questId);
            }
        });
    } else {
        acceptBtn.style.display = "none";
        timerDisplay.style.display = "none";
        document.getElementById("quest-box").classList.add("no-timer");
    }
    const questCheck = document.getElementById("quest-check");
    if (questCheck) {
        questCheck.disabled = false;
        questCheck.title = "";
    }
}


// ==============================================
// SECTION 44b: SYNCHRONOUS TIMER CONTROLS (for instant quest open)
// ==============================================

function setupTimerControlsSync(questId) {
    const quest = quests[questId];
    let acceptCell = document.getElementById("quest-accept-cell");

    if (!quest || !acceptCell) return;

    // Clone the cell to drop any previously-attached listeners
    const freshCell = acceptCell.cloneNode(true);
    acceptCell.parentNode.replaceChild(freshCell, acceptCell);
    acceptCell = freshCell;

    // Grab children from the LIVE cell (after cloning)
    const acceptText = acceptCell.querySelector("#quest-accept");
    const timerDisplay = acceptCell.querySelector("#timer-display");

    if (!acceptText || !timerDisplay) return;

    const customTimer = getCustomTimerForQuestSync(questId);

    if (customTimer !== null || quest.timer) {
        if (questAccepted[questId]) {
            acceptText.style.display = "none";
            timerDisplay.style.display = "block";
            acceptCell.classList.add("disabled");

            if (!questTimers[questId] && questStartTimes[questId]) {
                startQuestTimer(questId);
            }
            updateTimerDisplay(questId);
        } else {
            acceptText.style.display = "block";
            timerDisplay.style.display = "none";
            acceptCell.classList.remove("disabled");
        }

        acceptCell.addEventListener("click", () => {
            if (acceptCell.classList.contains("disabled")) return;
            if (!questAccepted[questId]) {
                acceptQuestWithCustomTimer(questId);
            }
        });
    } else {
        acceptCell.style.display = "none";
        const questBox = document.getElementById("quest-box");
        if (questBox) questBox.classList.add("no-timer");
    }
}

// ==============================================
// SECTION 44c: QUEST RESOURCE REMINDER
// ==============================================

const RESOURCE_REMINDER_STANDARD = 'Art.FA.CN.10.1.IA';

function questHasResearchStandard(quest) {
    const standards = quest?.rubric?.standards;
    if (!Array.isArray(standards)) return false;
    return standards.some(s => s.code === RESOURCE_REMINDER_STANDARD);
}

function showResourceReminderPopup() {
    const popup = document.getElementById('quest-resource-reminder-popup');
    if (!popup) return;

    popup.style.display = 'flex';

    const dismissBtn = document.getElementById('quest-resource-reminder-dismiss');
    const openBtn    = document.getElementById('quest-resource-reminder-open');

    const close = () => { popup.style.display = 'none'; };

    // Clone to strip stale listeners (popup can fire many times)
    if (dismissBtn) {
        const fresh = dismissBtn.cloneNode(true);
        dismissBtn.parentNode.replaceChild(fresh, dismissBtn);
        fresh.addEventListener('click', close);
    }

    if (openBtn) {
        const fresh = openBtn.cloneNode(true);
        openBtn.parentNode.replaceChild(fresh, openBtn);
        fresh.addEventListener('click', () => {
            close();
            if (typeof openAchievementsOverlay === 'function') {
                openAchievementsOverlay();
                // Let the overlay render, then switch to the Resources tab
                setTimeout(() => {
                    const tabBtn = document.querySelector('.tab-button[data-tab="resources"]');
                    if (tabBtn) tabBtn.click();
                }, 60);
            }
        });
    }

    // Backdrop click closes
    if (!popup.dataset.backdropWired) {
        popup.dataset.backdropWired = '1';
        popup.addEventListener('click', (e) => {
            if (e.target === popup) popup.style.display = 'none';
        });
    }

    // ESC closes
    if (!popup.dataset.escWired) {
        popup.dataset.escWired = '1';
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const p = document.getElementById('quest-resource-reminder-popup');
            if (p && p.style.display === 'flex') p.style.display = 'none';
        });
    }
}

// ==============================================
// SECTION 45: CUSTOM TIMER FUNCTIONS (OPTIMIZED)
// ==============================================

async function getCustomTimerForQuest(questId) {
    // --- OPTIMIZATION: Check cache first ---
    if (AppState.teacherData.loaded && AppState.teacherData.customTimers[questId] !== undefined) {
        return AppState.teacherData.customTimers[questId];
    }
    
    const profile = loadStudentProfile();
    if (!profile || !profile.teacher_code) return null;
    const { data: teacher } = await window.supabase
        .from('teachers')
        .select('id')
        .eq('class_code', profile.teacher_code)
        .maybeSingle();
    if (!teacher) return null;
    let query = window.supabase
        .from('teacher_quest_standards')
        .select('timer_classes')
        .eq('teacher_id', teacher.id)
        .eq('quest_id', questId);
    if (profile.class_id) {
        const { data, error } = await query.eq('class_id', profile.class_id).maybeSingle();
        if (!error && data?.timer_classes !== null && data?.timer_classes !== undefined) {
            AppState.teacherData.customTimers[questId] = data.timer_classes;
            AppState.teacherData.loaded = true;
            return data.timer_classes;
        }
        const { data: globalData, error: globalError } = await query.is('class_id', null).maybeSingle();
        if (!globalError && globalData?.timer_classes !== null && globalData?.timer_classes !== undefined) {
            AppState.teacherData.customTimers[questId] = globalData.timer_classes;
            AppState.teacherData.loaded = true;
            return globalData.timer_classes;
        }
    } else {
        const { data, error } = await query.is('class_id', null).maybeSingle();
        if (!error && data?.timer_classes !== null && data?.timer_classes !== undefined) {
            AppState.teacherData.customTimers[questId] = data.timer_classes;
            AppState.teacherData.loaded = true;
            return data.timer_classes;
        }
    }
    AppState.teacherData.customTimers[questId] = null;
    AppState.teacherData.loaded = true;
    return null;
}

async function getClassDuration() {
    const profile = loadStudentProfile();
    if (!profile || !profile.class_id) return 75;
    const { data } = await window.supabase
        .from('class_settings')
        .select('class_duration_minutes')
        .eq('class_id', profile.class_id)
        .single();
    const duration = data?.class_duration_minutes || 75;
    AppState.teacherData.classDuration = duration;
    return duration;
}

async function acceptQuestWithCustomTimer(questId) {
    const quest = quests[questId];
    if (!quest) return;

    const check = canAcceptQuest(questId);
    if (!check.allowed) {
        if (check.reason === "active_quest") {
            showRestrictionPopup(check.activeQuestId);
        } else if (check.reason === "prerequisites") {
            let message = "";
            if (check.required === 2) {
                message = `This MVP quest requires at least 2 completed formative quests. You have completed ${check.completed} of the required ${check.required}.`;
            } else {
                message = `This MVP quest requires completing its formative quest first.`;
            }
            showPrerequisitePopup(message, check.prerequisites);
        }
        return;
    }

    const customTimerClasses = await getCustomTimerForQuest(questId);
    const classDuration = await getClassDuration();

    let allottedMinutes;
    if (customTimerClasses !== null) {
        allottedMinutes = customTimerClasses * classDuration;
    } else if (quest.timer) {
        allottedMinutes = quest.timer.allottedMinutes;
    } else {
        allottedMinutes = 75;
    }

    const timeText = formatTime(allottedMinutes, true);

    if (confirm(`Accept "${quest.title}"?\n\nYou will have ${timeText} to complete this quest.`)) {
        if (activeQuestId && activeQuestId !== questId) {
            questAccepted[activeQuestId] = false;
            stopQuestTimer(activeQuestId);
        }

        questAccepted[questId] = true;
        questStartTimes[questId] = new Date().toISOString();

        if (customTimerClasses !== null) {
            questTimers[questId] = { allottedMinutes: allottedMinutes, classDuration: classDuration };
        }

        saveQuestAccepted();
        saveQuestStartTimes();

        invalidateStudentDataCache();

        startQuestTimer(questId);
        saveQuestData();

        setupTimerControlsSync(questId);
        updateTimerDisplay(questId);
        updateRestrictedElementsVisibilitySync(questId);

        if (typeof updateActiveQuestButton === "function") updateActiveQuestButton();
        if (typeof startActiveQuestTimerUpdates === "function") startActiveQuestTimerUpdates();
    }
}

function getCustomTimerForQuestSync(questId) {
    // Check per-quest cache first
    if (cachedTimerQuestId === questId && cachedCustomTimer !== null) {
        return cachedCustomTimer;
    }
    // Fall back to AppState cache (populated by preCacheAllTimerValues)
    if (AppState.teacherData.loaded && AppState.teacherData.customTimers[questId] !== undefined) {
        return AppState.teacherData.customTimers[questId];
    }
    return null;
}

function getClassDurationSync() {
    return cachedClassDuration || AppState.teacherData.classDuration || 75;
}

async function cacheTimerValuesForQuest(questId) {
    // --- OPTIMIZATION: Check cache first ---
    if (AppState.teacherData.loaded && AppState.teacherData.customTimers[questId] !== undefined) {
        cachedCustomTimer = AppState.teacherData.customTimers[questId];
        cachedClassDuration = AppState.teacherData.classDuration;
        cachedTimerQuestId = questId;
        return;
    }
    cachedTimerQuestId = questId;
    cachedCustomTimer = await getCustomTimerForQuest(questId);
    cachedClassDuration = await getClassDuration();
    // Store in cache
    AppState.teacherData.customTimers[questId] = cachedCustomTimer;
    AppState.teacherData.classDuration = cachedClassDuration;
    AppState.teacherData.loaded = true;
}

function checkAllQuestWarnings() {
    const overlay = document.getElementById("map-warning-overlay");
    if (!overlay) return;
    let hasWarning = false;
    let hasTimeUp = false;
    for (const [questId, isAccepted] of Object.entries(questAccepted)) {
        if (isAccepted === true && !completedQuests[questId]) {
            const remaining = calculateRemainingMinutes(questId);
            const quest = quests[questId];
            let totalMinutes = quest?.timer?.allottedMinutes || 75;
            const customTimer = getCustomTimerForQuestSync(questId);
            const classDuration = getClassDurationSync();
            if (customTimer !== null) {
                totalMinutes = customTimer * classDuration;
            }
            const remainingPercent = totalMinutes > 0 ? (remaining / totalMinutes) * 100 : 0;
            if (remaining <= 0) {
                hasTimeUp = true;
            } else if (remainingPercent <= 30) {
                hasWarning = true;
            }
        }
    }
    overlay.classList.remove("warning", "times-up");
    if (hasTimeUp) {
        overlay.classList.add("times-up");

    } else if (hasWarning) {
        overlay.classList.add("warning");

    }
}

// ==============================================
// SECTION 46: SCHEDULE DATA FOR TIMER
// ==============================================
// ==============================================
// Lazy schedule loader — fire-and-forget, in-flight guarded.
// Called from calculateRemainingMinutes() when a timer actually
// needs class-day data and it hasn't been loaded yet.
// ==============================================
let _scheduleLoadPromise = null;
let _scheduleLoaded = false;

function ensureScheduleLoaded() {
    if (_scheduleLoaded) return _scheduleLoadPromise;
    if (_scheduleLoadPromise) return _scheduleLoadPromise;

    _scheduleLoadPromise = loadScheduleForStudent()
        .then(() => {
            _scheduleLoaded = true;
            // Re-evaluate any active quest warnings now that we know the real schedule
            if (typeof checkAllQuestWarnings === "function") {
                checkAllQuestWarnings();
            }
        })
        .catch(err => {

            // Allow a retry on the next call
            _scheduleLoadPromise = null;
        });

    return _scheduleLoadPromise;
}

async function loadScheduleForStudent() {
    const profile = loadStudentProfile();
    if (!profile || !profile.teacher_code) {

        return;
    }
    

    
    // First, get the teacher's ID and class code from the teacher_code
    const { data: teacher, error: teacherError } = await window.supabase
        .from('teachers')
        .select('id, class_code')
        .eq('class_code', profile.teacher_code)
        .single();
    
    if (teacherError || !teacher) {

        return;
    }
    
    const teacherId = teacher.id;
    const teacherClassCode = teacher.class_code;

    
    // Try multiple approaches to find schedule data
    
    // APPROACH 1: Try class-specific schedule (if student has class_id)
    let classId = profile.class_id;
    let noClassDays = [];
    let weekendSettings = { saturday_is_class: false, sunday_is_class: false };
    let frequencyDays = [];
    
    if (classId) {

        
        // Load no-class days for this class
        const { data: classNoClassDays, error: classNoError } = await window.supabase
            .from('class_schedule_overrides')
            .select('date, reason, notes, is_class_day')
            .eq('class_id', classId);
        
        if (!classNoError && classNoClassDays && classNoClassDays.length > 0) {
            noClassDays = classNoClassDays;

        } else {

        }
        
        // Load weekend settings for this class
        const { data: classWeekendSettings, error: weekendError } = await window.supabase
            .from('class_weekend_settings')
            .select('saturday_is_class, sunday_is_class')
            .eq('class_id', classId)
            .maybeSingle();
        
        if (!weekendError && classWeekendSettings) {
            weekendSettings = classWeekendSettings;

        } else {

        }
        
        // Load frequency rules for this class
        const { data: classFrequencyRules, error: freqError } = await window.supabase
            .from('class_schedule_rules')
            .select('type, days')
            .eq('class_id', classId)
            .maybeSingle();
        
        if (!freqError && classFrequencyRules && classFrequencyRules.type === 'custom') {
            frequencyDays = classFrequencyRules.days || [];

        } else {

        }
    }
    
    // APPROACH 2: If no class-specific data, try using the teacher's class_code
    if (noClassDays.length === 0) {

        
        // Find all classes with this teacher_code
        const { data: classes, error: classesError } = await window.supabase
            .from('classes')
            .select('id')
            .eq('teacher_id', teacherId);
        
        if (!classesError && classes && classes.length > 0) {
            // Try each class to find schedule data
            for (const cls of classes) {

                
                // Try to load no-class days
                const { data: classNoClassDays } = await window.supabase
                    .from('class_schedule_overrides')
                    .select('date, reason, notes, is_class_day')
                    .eq('class_id', cls.id);
                
                if (classNoClassDays && classNoClassDays.length > 0) {
                    noClassDays = classNoClassDays;

                    break;
                }
            }
        }
    }
    
    // APPROACH 3: If still no data, try to find ANY schedule data (for display purposes)
    if (noClassDays.length === 0) {

        
        // Try to get ANY schedule overrides (ignoring class_id filter)
        const { data: anyOverrides, error: anyError } = await window.supabase
            .from('class_schedule_overrides')
            .select('date, reason, notes, is_class_day')
            .limit(10);
        
        if (!anyError && anyOverrides && anyOverrides.length > 0) {

            // We found data, but it might be for other classes
            // Let's filter by teacher_id if possible
            noClassDays = anyOverrides;
        }
    }
    
    // Store the loaded data
    cachedScheduleData.noClassDaysDetails = noClassDays;
    cachedScheduleData.noClassDays = noClassDays.map(d => d.date);
    cachedScheduleData.weekendSettings = weekendSettings;
    cachedScheduleData.frequencyDays = frequencyDays;
    
    console.log("Schedule loaded successfully:", {
        noClassDays: cachedScheduleData.noClassDays.length,
        weekendSettings: cachedScheduleData.weekendSettings,
        frequencyDays: cachedScheduleData.frequencyDays
    });
    
    // Log the actual dates for debugging
    if (cachedScheduleData.noClassDays.length > 0) {

    }
      _scheduleLoaded = true;
}

function isClassDay(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    const dayOfWeek = date.getDay();
    if (cachedScheduleData.noClassDays.includes(dateStr)) {
        return false;
    }
    if (dayOfWeek === 6) {
        return cachedScheduleData.weekendSettings.saturday_is_class;
    }
    if (dayOfWeek === 0) {
        return cachedScheduleData.weekendSettings.sunday_is_class;
    }
    if (cachedScheduleData.frequencyDays.length > 0) {
        const jsDay = dayOfWeek === 0 ? 7 : dayOfWeek;
        return cachedScheduleData.frequencyDays.includes(jsDay);
    }
    return true;
}

function countClassDays(startDate, endDate) {
    let classDays = 0;
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
        if (isClassDay(current)) {
            classDays++;
        }
        current.setDate(current.getDate() + 1);
    }
    return classDays;
}

// ==============================================
// SECTION 47: STUDENT CALENDAR
// ==============================================

let currentCalendarDate = new Date();
let calendarQuestData = null;

async function openStudentCalendar() {
    await loadStudentDataFromCloud();
    await loadScheduleForStudent();
    await loadQuestCalendarData();
    renderStudentCalendar();
    document.getElementById('calendar-modal').style.display = 'flex';
}

async function loadQuestCalendarData() {
    const { data: { session } } = await window.supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {

        return;
    }
    calendarQuestData = {
        activeQuest: null,
        completedQuests: []
    };
    const { data: progress, error } = await window.supabase
        .from('student_progress')
        .select('completed_quests, quest_grades, quest_accepted, quest_start_times')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) {

        return;
    }
    if (!progress) return;
    const completedQuests = progress.completed_quests || {};
    const questGrades = progress.quest_grades || {};
    const questAccepted = progress.quest_accepted || {};
    const questStartTimes = progress.quest_start_times || {};


    for (const [questId, isAccepted] of Object.entries(questAccepted)) {
        if (isAccepted === true && !completedQuests[questId]) {
            const quest = quests[questId];
            const startTime = new Date(questStartTimes[questId]);
            if (isNaN(startTime.getTime())) {

                continue;
            }
            const classDuration = await getClassDuration();
            const customTimer = await getCustomTimerForQuest(questId);
            let totalMinutes;
            if (customTimer !== null) {
                totalMinutes = customTimer * classDuration;
            } else if (quest.timer) {
                totalMinutes = quest.timer.allottedMinutes;
            } else {
                continue;
            }
            const dueDate = calculateDueDate(startTime, totalMinutes, classDuration);
            calendarQuestData.activeQuest = {
                id: questId,
                title: quest.title,
                startDate: startTime,
                dueDate: dueDate,
                totalMinutes: totalMinutes
            };

            break;
        }
    }
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (isCompleted === true) {
            const quest = quests[questId];
            if (!quest) {

                continue;
            }
            const startTime = questStartTimes[questId];
            let completedDate = null;
            const grades = questGrades[questId];
            console.log(`Processing completed quest ${questId}:`, {
                startTime: startTime,
                grades: grades
            });
            if (grades) {
                if (grades.updated_at) {
                    completedDate = new Date(grades.updated_at);
                } else if (grades.graded_at) {
                    completedDate = new Date(grades.graded_at);
                } else {
                    completedDate = startTime ? new Date(startTime) : new Date();
                    if (startTime) {
                        completedDate.setDate(completedDate.getDate() + 1);
                    }
                }
            } else {
                completedDate = startTime ? new Date(startTime) : new Date();
                if (startTime) {
                    completedDate.setDate(completedDate.getDate() + 1);
                }
            }
            calendarQuestData.completedQuests.push({
                id: questId,
                title: quest.title,
                startDate: startTime ? new Date(startTime) : null,
                completedDate: completedDate,
                dueDate: null
            });

        }
    }

}

function calculateDueDate(startDate, totalMinutes, classDuration) {
    const totalClassPeriods = Math.ceil(totalMinutes / classDuration);
    let classDaysCount = 0;
    const currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);
    while (classDaysCount < totalClassPeriods) {
        if (isClassDay(currentDate)) {
            classDaysCount++;
        }
        if (classDaysCount < totalClassPeriods) {
            currentDate.setDate(currentDate.getDate() + 1);
        }
    }
    return currentDate;
}

function renderStudentCalendar() {
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    document.getElementById('calendar-month-year').textContent = `${monthNames[month]} ${year}`;
    let firstDay = new Date(year, month, 1).getDay();
    firstDay = firstDay === 0 ? 6 : firstDay - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const grid = document.getElementById('student-calendar-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const totalCells = firstDay + daysInMonth;
    const numRows = Math.ceil(totalCells / 7);
    const totalGridCells = numRows * 7;
    for (let i = 0; i < totalGridCells; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        const dayNumber = i - firstDay + 1;
        const isCurrentMonth = dayNumber >= 1 && dayNumber <= daysInMonth;
        if (isCurrentMonth) {
            const currentDate = new Date(year, month, dayNumber);
            currentDate.setHours(0, 0, 0, 0);
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
            const daySpan = document.createElement('div');
            daySpan.className = 'calendar-day-number';
            daySpan.textContent = dayNumber;
            cell.appendChild(daySpan);
            const statuses = [];
            const scheduleEntry = cachedScheduleData.noClassDaysDetails?.find(d => d.date === dateStr);
            const isTeacherNoClassDay = scheduleEntry && scheduleEntry.is_class_day === false;
            if (isTeacherNoClassDay) {
                statuses.push({
                    type: 'no-class',
                    priority: 1,
                    color: 'rgba(255, 0, 0, 0.35)',
                    label: `🚫 No Class: ${scheduleEntry.reason || 'Teacher scheduled'}`,
                    fullText: scheduleEntry.reason || 'No Class'
                });
            }
            if (scheduleEntry?.notes) {
                statuses.push({
                    type: 'note',
                    priority: 2,
                    color: 'rgba(76, 175, 80, 0.35)',
                    label: `📝 Note: ${scheduleEntry.notes}`,
                    fullText: scheduleEntry.notes
                });
            }
            if (calendarQuestData.completedQuests && calendarQuestData.completedQuests.length > 0) {
                for (const completed of calendarQuestData.completedQuests) {
                    if (completed.startDate && completed.completedDate) {
                        const start = new Date(completed.startDate);
                        start.setHours(0, 0, 0, 0);
                        const completion = new Date(completed.completedDate);
                        completion.setHours(0, 0, 0, 0);
                        if (currentDate >= start && currentDate <= completion) {
                            statuses.push({
                                type: 'completed',
                                priority: 3,
                                color: 'rgba(100, 100, 100, 0.35)',
                                label: `✅ Completed: ${completed.title}`,
                                questId: completed.id,
                                isCompletedDate: currentDate.getTime() === completion.getTime()
                            });
                        }
                    }
                }
            }
            if (calendarQuestData.activeQuest) {
                const startDate = new Date(calendarQuestData.activeQuest.startDate);
                startDate.setHours(0, 0, 0, 0);
                const dueDate = new Date(calendarQuestData.activeQuest.dueDate);
                dueDate.setHours(0, 0, 0, 0);
                if (currentDate >= startDate && currentDate <= dueDate) {
                    const alreadyCompleted = statuses.some(s => s.type === 'completed' && s.questId === calendarQuestData.activeQuest.id);
                    if (!alreadyCompleted) {
                        statuses.push({
                            type: 'active',
                            priority: 4,
                            color: 'rgba(0, 150, 255, 0.35)',
                            label: `📘 Active: ${calendarQuestData.activeQuest.title}`,
                            questId: calendarQuestData.activeQuest.id,
                            isStartDate: currentDate.getTime() === startDate.getTime(),
                            isDueDate: currentDate.getTime() === dueDate.getTime()
                        });
                    }
                }
            }
            const uniqueStatuses = [];
            const seenTypes = new Set();
            for (const status of statuses) {
                if (!seenTypes.has(status.type)) {
                    seenTypes.add(status.type);
                    uniqueStatuses.push(status);
                }
            }
            uniqueStatuses.sort((a, b) => a.priority - b.priority);
            if (uniqueStatuses.length === 1) {
                cell.style.background = uniqueStatuses[0].color;
            } else if (uniqueStatuses.length === 2) {
                cell.style.background = `linear-gradient(to bottom, 
                    ${uniqueStatuses[0].color} 0%, 
                    ${uniqueStatuses[0].color} 35%,
                    ${uniqueStatuses[1].color} 65%,
                    ${uniqueStatuses[1].color} 100%)`;
            } else if (uniqueStatuses.length === 3) {
                cell.style.background = `linear-gradient(to bottom, 
                    ${uniqueStatuses[0].color} 0%, 
                    ${uniqueStatuses[0].color} 25%,
                    ${uniqueStatuses[1].color} 40%,
                    ${uniqueStatuses[1].color} 60%,
                    ${uniqueStatuses[2].color} 75%,
                    ${uniqueStatuses[2].color} 100%)`;
            } else if (uniqueStatuses.length >= 4) {
                const segmentPercent = 100 / uniqueStatuses.length;
                const gradientStops = [];
                uniqueStatuses.forEach((status, index) => {
                    const startPercent = index * segmentPercent;
                    const endPercent = (index + 1) * segmentPercent;
                    const overlap = segmentPercent * 0.15;
                    gradientStops.push(`${status.color} ${startPercent}%`);
                    gradientStops.push(`${status.color} ${endPercent - overlap}%`);
                    if (index < uniqueStatuses.length - 1) {
                        gradientStops.push(`${uniqueStatuses[index + 1].color} ${endPercent - overlap}%`);
                    }
                });
                cell.style.background = `linear-gradient(to bottom, ${gradientStops.join(', ')})`;
            }
            if (uniqueStatuses.length > 0) {
                const tooltipLines = [`📅 ${currentDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`];
                tooltipLines.push('━━━━━━━━━━━━━━━━━');
                for (const status of uniqueStatuses) {
                    tooltipLines.push(status.label);
                }
                cell.setAttribute('data-tooltip', tooltipLines.join('\n'));
            } else {
                cell.setAttribute('data-tooltip', '');
            }
            for (const status of uniqueStatuses) {
                if (status.type === 'completed' && status.isCompletedDate) {
                    const checkSpan = document.createElement('div');
                    checkSpan.className = 'calendar-completed-check';
                    checkSpan.innerHTML = '✅';
                    checkSpan.title = `Completed: ${status.label}`;
                    cell.appendChild(checkSpan);
                    break;
                }
            }
            for (const status of uniqueStatuses) {
                if (status.type === 'active' && status.isStartDate && calendarQuestData.activeQuest) {
                    const questNameSpan = document.createElement('div');
                    questNameSpan.className = 'calendar-quest-name';
                    questNameSpan.textContent = `${calendarQuestData.activeQuest.title.substring(0, 15)}...`;
                    questNameSpan.title = calendarQuestData.activeQuest.title;
                    questNameSpan.addEventListener('click', (e) => {
                        e.stopPropagation();
                        document.getElementById('calendar-modal').style.display = 'none';
                        openQuest(calendarQuestData.activeQuest.id);
                    });
                    cell.appendChild(questNameSpan);
                    break;
                }
            }
            for (const status of uniqueStatuses) {
                if (status.type === 'active' && status.isDueDate && calendarQuestData.activeQuest) {
                    cell.classList.add('quest-due');
                    const dueSpan = document.createElement('div');
                    dueSpan.className = 'calendar-quest-name';
                    dueSpan.textContent = `Due: ${calendarQuestData.activeQuest.title.substring(0, 10)}...`;
                    dueSpan.title = calendarQuestData.activeQuest.title;
                    dueSpan.addEventListener('click', (e) => {
                        e.stopPropagation();
                        document.getElementById('calendar-modal').style.display = 'none';
                        openQuest(calendarQuestData.activeQuest.id);
                    });
                    cell.appendChild(dueSpan);
                    break;
                }
            }
        } else {
            cell.style.visibility = 'hidden';
            cell.style.pointerEvents = 'none';
        }
        grid.appendChild(cell);
    }
}

function calendarPrevMonth() {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
    renderStudentCalendar();
}

function calendarNextMonth() {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
    renderStudentCalendar();
}

function setupCalendarTooltipDelegation() {
    const grid = document.getElementById('student-calendar-grid');
    if (!grid) return;
    const tooltip = document.createElement('div');
    tooltip.id = 'calendar-custom-tooltip';
    tooltip.className = 'calendar-tooltip';
    document.body.appendChild(tooltip);
    grid.addEventListener('mousemove', (e) => {
        const cell = e.target.closest('.calendar-day');
        if (!cell) {
            tooltip.style.display = 'none';
            return;
        }
        const tooltipText = cell.getAttribute('data-tooltip');
        if (tooltipText && tooltipText !== '') {
            tooltip.innerHTML = tooltipText.replace(/\n/g, '<br>');
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = (e.clientY - 10) + 'px';
        } else {
            tooltip.style.display = 'none';
        }
    });
    grid.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
    });
}

// ==============================================
// SECTION 48: RESTRICTED ELEMENTS VISIBILITY
// ==============================================

function updateRestrictedElementsVisibility(questId) {
    const isAccepted = questAccepted[questId] === true;
    const isCompleted = completedQuests[questId] === true;
    const hasTimer = quests[questId]?.timer !== undefined;
    const canAccess = !hasTimer || isAccepted || isCompleted;
    const finishedWorkBtn = document.getElementById("finished-work-btn");
    const linksContainer = document.getElementById("quest-links");
    if (finishedWorkBtn) {
        const newBtn = finishedWorkBtn.cloneNode(true);
        finishedWorkBtn.parentNode.replaceChild(newBtn, finishedWorkBtn);
        if (!canAccess) {
            newBtn.style.opacity = "0.5";
            newBtn.style.cursor = "not-allowed";
            newBtn.title = "You must accept this quest first";
            newBtn.addEventListener("click", (e) => {
                e.preventDefault();
                showAcceptQuestRestrictionPopup(questId);
            });
        } else {
            newBtn.style.opacity = "1";
            newBtn.style.cursor = "pointer";
            newBtn.title = "Upload your finished work";
            newBtn.addEventListener("click", (e) => {
                e.preventDefault();
                if (!currentQuestId) {
                    alert("Please open a quest first to add your work.");
                    return;
                }
                openWorkOverlay(currentQuestId);
            });
        }
    }
    if (linksContainer) {
        if (!canAccess) {
            linksContainer.style.opacity = "0.5";
            linksContainer.style.pointerEvents = "none";
            linksContainer.title = "You must accept this quest first";
        } else {
            linksContainer.style.opacity = "1";
            linksContainer.style.pointerEvents = "auto";
            linksContainer.title = "";
        }
    }
    const cancelCell = document.getElementById("cancel-quest-cell");
    if (cancelCell) {
        const cancelEnabled = isAccepted && !isCompleted;
        cancelCell.classList.toggle("disabled", !cancelEnabled);
    }
}

// ==============================================
// SECTION 48b: SYNCHRONOUS RESTRICTED ELEMENTS (for instant quest open)
// ==============================================

function updateRestrictedElementsVisibilitySync(questId) {
    const isAccepted = questAccepted[questId] === true;
    const isCompleted = completedQuests[questId] === true;
    const hasTimer = quests[questId]?.timer !== undefined;
    const canAccess = !hasTimer || isAccepted || isCompleted;

    // --- Finished Work cell ---
    const workCell = document.getElementById("open-work-overlay");
    if (workCell) {
        if (!canAccess) {
            workCell.classList.add("disabled");
            workCell.title = "You must accept this quest first";
        } else {
            workCell.classList.remove("disabled");
            workCell.title = "Upload your finished work";
        }
    }

    // --- Sample links container ---
    const linksContainer = document.getElementById("quest-links");
    if (linksContainer) {
        if (!canAccess) {
            linksContainer.style.opacity = "0.5";
            linksContainer.style.pointerEvents = "none";
            linksContainer.title = "You must accept this quest first";
        } else {
            linksContainer.style.opacity = "1";
            linksContainer.style.pointerEvents = "auto";
            linksContainer.title = "";
        }
    }

    // --- Cancel Quest cell ---
    const cancelCell = document.getElementById("cancel-quest-cell");
    if (cancelCell) {
        const cancelEnabled = isAccepted && !isCompleted;
        cancelCell.classList.toggle("disabled", !cancelEnabled);
    }
}

// ==============================================
// SECTION 49: RESTRICTION POPUPS
// ==============================================

function showAcceptQuestRestrictionPopup(questId) {
    const quest = quests[questId];
    const popup = document.getElementById("accept-quest-restriction-popup");
    const messageEl = document.getElementById("accept-quest-restriction-message");
    if (messageEl) {
        messageEl.innerText = `You must accept the quest "${quest?.title || questId}" first before accessing samples or uploading work.`;
    }
    if (popup) popup.style.display = "flex";
}

function closeAcceptQuestRestrictionPopup() {
    const popup = document.getElementById("accept-quest-restriction-popup");
    if (popup) popup.style.display = "none";
}

// ==============================================
// SECTION 50: WORK OVERLAY FUNCTIONS
// ==============================================

async function openWorkOverlay(questId) {
    await loadCloudWorksIntoGallery();

    const overlay = document.getElementById("work-overlay");
    if (!overlay) {

        return;
    }

    const targetQuestId = questId || currentQuestId;
    if (!targetQuestId) {

        return;
    }

    overlay.style.display = "flex";
    overlay.dataset.questId = targetQuestId;

    // Reset file inputs
    const imageInput = document.getElementById("work-image");
    const pdfInput = document.getElementById("work-research-pdf");
    if (imageInput) imageInput.value = "";
    if (pdfInput) pdfInput.value = "";

    // Prefill text fields from saved work (or blank)
    const saved = studentWorks[targetQuestId] || {};
    document.getElementById("work-title").value = saved.title || "";
    document.getElementById("work-size").value = saved.size || "";
    document.getElementById("work-media").value = saved.media || "";
    document.getElementById("work-description").value = saved.description || "";

    // Update buttons, preview, PDF status
    updateWorkOverlayUI();

    // Snapshot for dirty-check (Rule Y)
    snapshotWorkOverlay();
}

// ==============================================
// SECTION 51: JSON PROFILE SAVE/LOAD SYSTEM
// ==============================================

function collectStudentData() {
    const studentProfile = loadStudentProfile() || {
        name: document.getElementById('student-name')?.textContent || 'Unnamed Artist',
        character: document.getElementById('student-avatar')?.src || 'profile.png'
    };
    const studentData = {
        name: studentProfile.name,
        character: studentProfile.character,
        studentProfile: studentProfile,
        timestamp: new Date().toISOString(),
        completedQuests: completedQuests,
        questGrades: questGrades,
        rubricLocked: rubricLocked,
        questAccepted: questAccepted,
        questStartTimes: questStartTimes,
        works: studentWorks,
        earnedBadges: earnedBadges,
        standards: {},
        appName: "Artheim",
        version: "1.0",
        exportDate: new Date().toLocaleString()
    };
    document.querySelectorAll('#standards-table tbody tr').forEach(row => {
        const standard = row.getAttribute('data-standard');
        const gradeCell = row.children[1];
        const mvpCell = row.querySelector('.mvp-cell');
        if (standard) {
            studentData.standards[standard] = {
                regular: gradeCell?.textContent.trim() || '',
                mvp: mvpCell?.textContent.trim() || ''
            };
        }
    });
    return studentData;
}

function saveProfileAsJSON() {
    const studentData = collectStudentData();
    const jsonString = JSON.stringify(studentData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const studentName = document.getElementById('student-name')?.textContent || 'Student';
    const sanitizedName = studentName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const dateStr = new Date().toISOString().split('T')[0];
    const link = document.createElement('a');
    link.download = `Artheim-${sanitizedName}-${dateStr}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    const completedCount = Object.values(studentData.completedQuests || {}).filter(v => v).length;
    const gradedCount = Object.keys(studentData.questGrades || {}).length;
    alert(`✅ Profile saved successfully!\n\nFilename: ${link.download}\nCompleted quests: ${completedCount}\nGraded quests: ${gradedCount}\n\nSave this file to backup your progress.`);
}

function loadProfileFromJSON(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const jsonString = e.target.result;
            const studentData = JSON.parse(jsonString);
            if (!studentData.appName || studentData.appName !== "Artheim") {
                throw new Error('This is not a valid Artheim profile file.');
            }
            const completedCount = Object.values(studentData.completedQuests || {}).filter(v => v).length;
            const gradedCount = Object.keys(studentData.questGrades || {}).length;
            if (confirm(`Load profile for "${studentData.name}"?\n\nCompleted quests: ${completedCount}\nGraded quests: ${gradedCount}\nExport date: ${studentData.exportDate || 'Unknown'}\n\nThis will OVERRIDE all current progress and grades.`)) {
                loadStudentData(studentData);
            }
        } catch (error) {

            alert('Error loading profile: ' + error.message);
        }
    };
    reader.onerror = function() {
        alert('Error reading file. Please try again.');
    };
    reader.readAsText(file);
}

function loadStudentData(data) {
    const currentProfile = loadStudentProfile() || {};
    const currentStudentName = currentProfile.name || "";
    const loadedStudentName = data.name || "";
    const isSameStudent = (currentStudentName === loadedStudentName && currentStudentName !== "");
    if (!isSameStudent) {
        earnedBadges = {};
        completedQuests = {};
        questGrades = {};
        studentWorks = {};
        rubricLocked = {};
        questAccepted = {};
        questStartTimes = {};
        saveEarnedBadges();
        saveQuestData();
        saveQuestGrades();
        saveStudentWorks();
        saveRubricLocks();
        saveQuestAccepted();
        saveQuestStartTimes();
    }
    if (data.name) {
        const nameElement = document.getElementById("student-name");
        if (nameElement) nameElement.innerText = data.name;
        const profile = loadStudentProfile() || {};
        profile.name = data.name;
        if (data.character) profile.character = data.character;
        saveStudentProfile(profile);
    }
    if (data.character) {
        const avatar = document.getElementById("student-avatar");
        if (avatar) avatar.src = data.character;
        const profileBtn = document.querySelector(".profile-btn img");
        if (profileBtn) profileBtn.src = data.character;
        const profile = loadStudentProfile() || {};
        profile.character = data.character;
        if (data.name) profile.name = data.name;
        saveStudentProfile(profile);
    }
    if (data.studentProfile) saveStudentProfile(data.studentProfile);
    if (data.completedQuests) {
        if (isSameStudent) {
            for (const key in completedQuests) delete completedQuests[key];
        }
        Object.assign(completedQuests, data.completedQuests);
        saveQuestData();
    }
    if (data.questGrades) {
        if (isSameStudent) {
            for (const key in questGrades) delete questGrades[key];
        }
        Object.assign(questGrades, data.questGrades);
        if (!isLoadingFromCloud) saveQuestGrades();
    }
    if (data.rubricLocked) {
        if (isSameStudent) {
            for (const key in rubricLocked) delete rubricLocked[key];
        }
        Object.assign(rubricLocked, data.rubricLocked);
        saveRubricLocks();
    }
    if (data.questAccepted) {
        if (isSameStudent) {
            for (const key in questAccepted) delete questAccepted[key];
        }
        Object.assign(questAccepted, data.questAccepted);
        saveQuestAccepted();
    }
    if (data.questStartTimes) {
        if (isSameStudent) {
            for (const key in questStartTimes) delete questStartTimes[key];
        }
        Object.assign(questStartTimes, data.questStartTimes);
        saveQuestStartTimes();
    }
    if (data.works) {
        if (isSameStudent) {
            for (const key in studentWorks) delete studentWorks[key];
        }
        Object.assign(studentWorks, data.works);
        saveStudentWorks();
    }

    if (data.standards) {
        Object.entries(data.standards).forEach(([standard, grades]) => {
            const row = document.querySelector(`tr[data-standard="${standard}"]`);
            if (row) {
                const gradeCell = row.children[1];
                const mvpCell = row.querySelector('.mvp-cell');
                if (gradeCell && grades.regular) gradeCell.textContent = grades.regular;
                if (mvpCell && grades.mvp) mvpCell.textContent = grades.mvp;
            }
        });
    }
    if (data.earnedBadges) {
        earnedBadges = data.earnedBadges;
    } else {
        earnedBadges = {};
    }
    saveEarnedBadges();
    if (badgesData) {
        const previousBadges = { ...earnedBadges };
        earnedBadges = {};
        badgesData.forEach(badge => {
            if (badge.teacherAwarded && previousBadges[badge.id]?.earned) {
                earnedBadges[badge.id] = previousBadges[badge.id];
                return;
            }
            if (badge.progression) {
                checkProgressionBadge(badge);
            } else if (badge.checkFunction) {
                let earned = false;
                if (badge.checkFunction === "checkPathMastery") {
                    earned = checkPathMastery(badge.params);
                } else if (badge.checkFunction === "checkColorExpert") {
                    earned = checkColorExpert(badge.params);
                } else if (badge.checkFunction === "checkPerspectivePro") {
                    earned = checkPerspectivePro(badge.params);
                }
                if (earned) {
                    earnedBadges[badge.id] = {
                        earned: true,
                        earnedAt: previousBadges[badge.id]?.earnedAt || new Date().toISOString()
                    };
                }
            }
        });
        const earnedCount = Object.values(earnedBadges).filter(b => b.earned).length;

    }
    saveEarnedBadges();
    updateProfileUI();
    updateProfileStandardsTable();
    renderRadarChart();
    renderAchievementsList();
    initializeQuestTimers();
    if (document.getElementById("profile-overlay").style.display === "flex") {
        if (typeof renderBadges === 'function') renderBadges();
    }
    setTimeout(() => {
        const completedCount = Object.values(completedQuests).filter(v => v).length;
        const gradedCount = Object.keys(questGrades).length;
        const worksCount = Object.keys(studentWorks).length;
        const badgesCount = Object.values(earnedBadges).filter(b => b.earned).length;
        alert(`✅ Profile for "${data.name || 'Student'}" loaded successfully!\n\nCompleted quests: ${completedCount}\nGraded quests: ${gradedCount}\nSaved works: ${worksCount}\nBadges earned: ${badgesCount}\n\nYour progress has been restored.`);
        const profileOverlay = document.getElementById('profile-overlay');
        if (profileOverlay) profileOverlay.style.display = 'none';
    }, 300);
}

window.ArtheimProfile = {
    saveProfileAsJSON,
    loadProfileFromJSON,
    collectStudentData,
    loadStudentData
};

// ==============================================
// SECTION 52: MINUTES TO CLASSES CONVERSION
// ==============================================

function convertMinutesToClasses(minutes) {
    if (typeof minutes !== 'number' || isNaN(minutes)) return "0 classes";
    const classes = Math.round(minutes / 75);
    return classes === 1 ? "1 class" : `${classes} classes`;
}

function convertMinutesToClassesDecimal(minutes, decimalPlaces = 1) {
    if (typeof minutes !== 'number' || isNaN(minutes)) return "0 classes";
    const classes = (minutes / 75).toFixed(decimalPlaces);
    return `${classes} classes`;
}

// ==============================================
// SECTION 53: QUEST RESTRICTION FUNCTIONS
// ==============================================

function getActiveQuestId() {
    for (const questId in questAccepted) {
        if (questAccepted[questId] && !completedQuests[questId]) {
            return questId;
        }
    }
    return null;
}

function updateActiveQuestId() {
    activeQuestId = getActiveQuestId();
    return activeQuestId;
}

function canAcceptQuest(questId) {
    updateActiveQuestId();
    const quest = quests[questId];
    if (!quest) return { allowed: false, reason: "Quest not found" };
    if (activeQuestId && activeQuestId !== questId) {
        return { 
            allowed: false, 
            reason: "active_quest",
            activeQuestId: activeQuestId
        };
    }
    if (quest.style === "mvp") {
        const prerequisites = quest.prerequisites || [];
        const completedPrereqs = prerequisites.filter(prereqId => completedQuests[prereqId]);
        const requiredPrereqs = prerequisites.length >= 2 ? 2 : prerequisites.length;
        if (completedPrereqs.length < requiredPrereqs) {
            return {
                allowed: false,
                reason: "prerequisites",
                prerequisites: prerequisites,
                completed: completedPrereqs.length,
                required: requiredPrereqs
            };
        }
    }
    return { allowed: true };
}

function initializeActiveQuest() {
    activeQuestId = getActiveQuestId();
}

// ==============================================
// SECTION 54: QUEST LIST FUNCTIONS
// ==============================================

function renderQuestList(filter = 'all') {
    const container = document.getElementById('questlist-container');
    if (!container) return;
    container.innerHTML = '';
    if (!quests || Object.keys(quests).length === 0) {
        container.innerHTML = '<div class="questlist-empty">Loading quests...</div>';
        return;
    }
    let filteredQuests = [];
    switch(filter) {
        case 'active':
            filteredQuests = Object.entries(quests).filter(([id, quest]) => 
                questAccepted[id] && quest.timer
            );
            break;
        case 'paintersPath':
        case 'sketcherPath':
        case 'watercoloursPath':
        case '3DPath':
            const pathMap = {
                'paintersPath': 'Painter Path',
                'sketcherPath': 'Sketcher Path', 
                'watercoloursPath': 'Watercolor Path',
                '3DPath': '3D Path'
            };
            const targetPath = pathMap[filter];
            filteredQuests = Object.entries(quests).filter(([id, quest]) => {
                if (!quest.path) return false;
                if (Array.isArray(quest.path)) {
                    return quest.path.includes(targetPath);
                }
                return false;
            });
            break;
        default:
            filteredQuests = Object.entries(quests);
    }
    filteredQuests.sort(([idA], [idB]) => {
        const numA = parseInt(idA.replace('quest', '')) || 0;
        const numB = parseInt(idB.replace('quest', '')) || 0;
        return numA - numB;
    });
    const countEl = document.getElementById('questlist-count');
    if (countEl) {
        countEl.textContent = `${filteredQuests.length} ${filter === 'all' ? 'total' : 'filtered'} quest${filteredQuests.length !== 1 ? 's' : ''}`;
    }
    if (filteredQuests.length === 0) {
        container.innerHTML = '<div class="questlist-empty">No quests match your filter</div>';
        return;
    }
    filteredQuests.forEach(([id, quest]) => {
        const isActive = questAccepted[id] && quest.timer && !completedQuests[id];
        const isCompleted = completedQuests[id];
        const isCustom = quest.teacher_quest === true || quest.is_custom === true;
        const questElement = document.createElement('div');
        questElement.className = `questlist-item ${isActive ? 'active' : ''} ${isCustom ? 'custom-quest-item' : ''}`;
        questElement.dataset.questId = id;
        let timerDisplay = '';
        if (quest.timer) {
            const allottedMinutes = quest.timer.allottedMinutes || 0;
            const classes = Math.round(allottedMinutes / 75);
            timerDisplay = `${classes} class${classes !== 1 ? 'es' : ''}`;
        }
        let pathDisplay = 'No path assigned';
        if (quest.path && Array.isArray(quest.path)) {
            pathDisplay = quest.path.join(', ');
        }
        questElement.innerHTML = `
            <div class="questlist-header">
                <h3 class="questlist-title">${quest.title || 'Untitled Quest'}</h3>
                <span class="questlist-id">${id}</span>
                ${isCustom ? '<span class="custom-quest-badge">📝 Custom</span>' : ''}
            </div>
            <div class="questlist-details">
                <div>
                    <span class="questlist-path">${pathDisplay}</span>
                    ${quest.timer ? `<span class="questlist-timer ${isActive ? 'active' : ''}">⏱ ${timerDisplay}</span>` : ''}
                </div>
                <div>
                    ${isCompleted ? '<span class="questlist-completed">✓ Completed</span>' : ''}
                    ${isActive ? '<span class="questlist-timer active">🔴 Active</span>' : ''}
                </div>
            </div>
        `;
        questElement.addEventListener('click', async () => {

            const achievementsOverlay = document.getElementById('achievements-overlay');
            if (achievementsOverlay) achievementsOverlay.style.display = 'none';

            const allQuests = await getAllQuestsForStudent();

            const quest = allQuests[id];

            if (quest) {

                openQuest(id);
            } else {

            }
        });    
        container.appendChild(questElement);
    });
}

function initializeQuestList() {
    const filterSelect = document.getElementById('questlist-filter');
    if (filterSelect) {
        filterSelect.addEventListener('change', (e) => {
            renderQuestList(e.target.value);
        });
    }
}

// ==============================================
// SECTION 55: LOAD TEACHER CUSTOM QUESTS
// ==============================================

async function loadTeacherCustomQuests() {
    const profile = loadStudentProfile();
    if (!profile || !profile.teacher_code) {
        return [];
    }
    const studentGrade = profile.grade_level || 'hs';
    const { data: teacher, error: teacherError } = await window.supabase
        .from('teachers')
        .select('id')
        .eq('class_code', profile.teacher_code)
        .single();
    if (teacherError || !teacher) {

        return [];
    }
    const { data, error } = await window.supabase
        .from('teacher_custom_quests')
        .select('*')
        .eq('teacher_id', teacher.id)
        .eq('deleted', false)
        .eq('grade_level', studentGrade);
    if (error) {

        return [];
    }
    return data || [];
}

async function getAllQuestsForStudent(forceRefresh = false) {
    if (forceRefresh) {

        cachedQuests = null;
        cachedQuestsIncludeCustom = false;
    }
    if (cachedQuests && cachedQuestsIncludeCustom && !forceRefresh) {

        return cachedQuests;
    }

    const baseQuests = await getQuests();
    const customQuests = await loadTeacherCustomQuests();
    const allQuests = { ...baseQuests };
    for (let i = 0; i < customQuests.length; i++) {
        const custom = customQuests[i];
        const customImages = [
            "charimage/custom1.gif",
            "charimage/custom2.gif",
            "charimage/custom3.gif",
            "charimage/custom4.gif",
            "charimage/custom5.gif"
        ];
        const imageIndex = i % customImages.length;
        const characterImage = customImages[imageIndex];
        allQuests[custom.quest_id] = {
            path: [custom.path],
            difficulty: custom.difficulty,
            title: custom.title,
            rationale: custom.rationale,
            description: custom.description,
            requirements: custom.requirements,
            rubric: custom.rubric,
            links: custom.links,
            character: characterImage,
            style: "custom",
            prerequisites: [],
            timer: { allottedMinutes: 75 },
            is_custom: true,
            teacher_quest: true,
            is_mvp: custom.is_mvp === true
        };
    }
    cachedQuests = allQuests;
    cachedQuestsIncludeCustom = true;

    return cachedQuests;
}

async function addCustomQuestHotspots() {
    if (isAddingHotspots) {

        return;
    }
    isAddingHotspots = true;

    try {
        const hasCustomQuests = Object.keys(quests).some(id => id.startsWith('custom_'));

        if (!hasCustomQuests) {

            const freshQuests = await getAllQuestsForStudent(true);
            quests = freshQuests;
            cachedQuests = freshQuests;
            cachedQuestsIncludeCustom = true;

            buildPathQuests();
            AppState.relationshipsBuilt = false;
            buildQuestRelationships();
        }

        if (!quests || Object.keys(quests).length === 0) {

            setTimeout(() => addCustomQuestHotspots(), 500);
            return;
        }

        const customQuests = await loadTeacherCustomQuests();


        const mapContainer = document.getElementById('map-container');
        if (!mapContainer) return;

        const existingHotspots = document.querySelectorAll('.hotspot.custom-quest-hotspot');
        existingHotspots.forEach(hotspot => hotspot.remove());

        // MS: All custom quests on single map
        const customPositions = [
            { top: "53.4%", left: "73.2%" },
            { top: "53.8%", left: "81.6%" },
            { top: "59.3%", left: "81.6%" },
            { top: "61.5%", left: "75.6%" },
            { top: "64%",   left: "83.4%" }
        ];

        for (let i = 0; i < customQuests.length && i < customPositions.length; i++) {
            const quest = customQuests[i];
            const pos = customPositions[i];

            if (!quests[quest.quest_id]) {

                continue;
            }

            const hotspot = document.createElement('div');
            hotspot.className = 'hotspot debug custom-quest-hotspot';
            hotspot.setAttribute('data-city', quest.quest_id);
            hotspot.style.top = pos.top;
            hotspot.style.left = pos.left;
            hotspot.style.position = 'absolute';
            hotspot.title = quest.title;

            hotspot.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (quests[quest.quest_id]) {
                    openQuest(quest.quest_id);
                } else {

                }
            });

            mapContainer.appendChild(hotspot);

        }

        updateHotspotVisibility();

    } catch (error) {

    } finally {
        isAddingHotspots = false;
    }
}
// ==============================================
// SECTION 56: RESPONSIVE HELPER FUNCTIONS
// ==============================================

function handleOrientationChange() {
    const isPortrait = window.innerHeight > window.innerWidth;
    if (isPortrait && window.innerWidth < 768) {
        document.querySelectorAll('.hotspot').forEach(hotspot => {
            hotspot.style.transform = 'translate(-50%, -50%) scale(1.2)';
        });
    } else {
        document.querySelectorAll('.hotspot').forEach(hotspot => {
            hotspot.style.transform = 'translate(-50%, -50%)';
        });
    }
    if (document.getElementById('profile-overlay').style.display === 'flex') {
        renderRadarChart();
    }
}

function initializeTouchEvents() {
    document.addEventListener('touchstart', function(e) {
        if (e.target.tagName === 'BUTTON' || 
            e.target.tagName === 'SELECT' ||
            e.target.classList.contains('hotspot') ||
            e.target.classList.contains('tab-button')) {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        }
    }, { passive: false });
    document.addEventListener('touchstart', function(e) {
        const target = e.target;
        if (target.tagName === 'BUTTON' || 
            target.classList.contains('tab-button') ||
            target.classList.contains('profile-btn-small') ||
            target.classList.contains('hotspot')) {
            target.classList.add('touch-active');
        }
    });
    document.addEventListener('touchend', function(e) {
        const target = e.target;
        if (target.classList.contains('touch-active')) {
            setTimeout(() => {
                target.classList.remove('touch-active');
            }, 150);
        }
    });
}

function adjustHotspotPositions() {
    updateHotspotPositions();
}

function initializeResponsiveBehaviors() {
    handleOrientationChange();
    adjustHotspotPositions();
    initializeTouchEvents();
    window.addEventListener('resize', () => {
        handleOrientationChange();
        adjustHotspotPositions();
    });
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            handleOrientationChange();
            adjustHotspotPositions();
        }, 300);
    });
}

// ==============================================
// SECTION 57: HELP MODAL
// ==============================================

window.closeHelpModal = function() {
    if (helpModal) {
        helpModal.style.display = 'none';
    }
};

function initializeHelpModal() {
    helpModal = document.getElementById('helpModal');
    helpBtn = document.getElementById('helpButton');
    closeBtn = document.getElementById('closeModalBtn');
    if (!helpModal || !helpBtn || !closeBtn) {

        return;
    }
    function openHelpModal(e) {
        e.preventDefault();
        e.stopPropagation();
        helpModal.style.display = 'block';
    }
    helpBtn.addEventListener('click', openHelpModal);
    closeBtn.addEventListener('click', window.closeHelpModal);
    window.addEventListener('click', function(event) {
        if (event.target === helpModal) {
            window.closeHelpModal();
        }
    });
}

// ==============================================
// SECTION 58: GALLERY FUNCTIONS
// ==============================================

function openGallery() {
    const overlay = document.getElementById("gallery-overlay");
    if (!overlay) return;
    const profile = loadStudentProfile() || {};
    const studentName = profile.name || "Student";
    const header = document.getElementById("gallery-student-name");
    if (header) {
        header.textContent = `${studentName}'s Art Gallery`;
    }
    renderGalleryItems();
    overlay.style.display = "flex";
}

function closeGallery() {
    const overlay = document.getElementById("gallery-overlay");
    if (overlay) overlay.style.display = "none";
}

async function loadCloudWorksIntoGallery() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {

        return;
    }
    const { data, error } = await window.supabase
        .from('student_works')
        .select('*')
        .eq('user_id', session.user.id);
    if (error) {

        return;
    }
    const cloudQuestIds = new Set();
    if (data && data.length > 0) {
        data.forEach(work => {
            cloudQuestIds.add(work.quest_id);
            studentWorks[work.quest_id] = {
                title: work.title || "",
                size: work.size || "",
                media: work.media || "",
                description: work.description || "",
                image: work.image_url || "",
                image_url: work.image_url || "",
                lastModified: work.uploaded_at || new Date().toISOString(),
                research_pdf_url: work.research_pdf_url || null,
                research_pdf_name: work.research_pdf_name || null,
                // --- EXP facts (submission-time snapshot) ---
                expFacts: (work.exp_metadata && typeof work.exp_metadata === "object")
                    ? work.exp_metadata
                    : null
            };
        });
    }
    for (let questId in studentWorks) {
        if (!cloudQuestIds.has(questId)) {
            delete studentWorks[questId];
        }
    }
    saveStudentWorks();
}

async function renderGalleryItems() {
    await loadCloudWorksIntoGallery();
    const galleryGrid = document.getElementById("gallery-grid");
    if (!galleryGrid) return;
    galleryGrid.innerHTML = "";
    const works = studentWorks || {};
    const worksArray = Object.entries(works);
    if (worksArray.length === 0) {
        galleryGrid.innerHTML = '<div class="gallery-empty">No artworks uploaded yet</div>';
        return;
    }
    worksArray.forEach(([questId, work]) => {
        if (!work.title && !work.image && !work.description) return;
        const galleryItem = document.createElement("div");
        galleryItem.className = "gallery-item";
        const quest = quests[questId];
        if (quest && quest.style === "mvp") {
            galleryItem.classList.add("mvp");
        }
        galleryItem.dataset.questId = questId;
        const thumbnailWrapper = document.createElement("div");
        thumbnailWrapper.className = "gallery-thumbnail-wrapper";
        const thumbnail = document.createElement("img");
        thumbnail.className = "gallery-thumbnail";
        if (work.image_url) {
            thumbnail.src = work.image_url;
            thumbnail.style.cursor = "pointer";
            thumbnail.addEventListener("click", (e) => {
                e.stopPropagation();
                openFullscreenImage(work, quest);
            });
        } else if (work.image) {
            thumbnail.src = work.image;
            thumbnail.style.cursor = "pointer";
            thumbnail.addEventListener("click", (e) => {
                e.stopPropagation();
                openFullscreenImage(work, quest);
            });
        } else {
            const questData = quests[questId];
            thumbnail.src = questData?.character || "placeholder.png";
            thumbnail.style.opacity = "0.7";
            thumbnail.style.cursor = "default";
        }
        thumbnail.alt = work.title || "Artwork";
        const title = document.createElement("div");
        title.className = "gallery-title";
        title.textContent = work.title || "Untitled";
        const info = document.createElement("div");
        info.className = "gallery-info";
        if (work.size || work.media) {
            info.textContent = [work.size, work.media].filter(Boolean).join(" • ");
            info.style.fontSize = "11px";
            info.style.opacity = "0.7";
            info.style.marginTop = "4px";
        }
        thumbnailWrapper.appendChild(thumbnail);
        galleryItem.appendChild(thumbnailWrapper);
        galleryItem.appendChild(title);
        if (info.textContent) galleryItem.appendChild(info);
                // NEW: research badge
        if (work.research_pdf_url) {
            const researchBadge = document.createElement("a");
            researchBadge.href = work.research_pdf_url;
            researchBadge.target = "_blank";
            researchBadge.textContent = "📄 Research";
            researchBadge.title = work.research_pdf_name || "Research document";
            researchBadge.style.cssText = `
                display: inline-block; margin-top: 6px; padding: 3px 8px;
                background: rgba(255,215,0,0.15); border: 1px solid #ffd700;
                color: #ffd700; border-radius: 4px; font-size: 11px;
                text-decoration: none;
            `;
            researchBadge.addEventListener("click", (e) => e.stopPropagation());
            galleryItem.appendChild(researchBadge);
        }
        galleryItem.addEventListener("click", (e) => {
            if (e.target === thumbnail) return;
            closeGallery();
            setTimeout(() => {
                if (quests[questId]) {
                    openQuest(questId);
                    setTimeout(() => {
                        openWorkOverlay(questId);
                    }, 100);
                }
            }, 100);
        });
        galleryGrid.appendChild(galleryItem);
    });
    if (galleryGrid.children.length === 0) {
        galleryGrid.innerHTML = '<div class="gallery-empty">No artworks uploaded yet</div>';
    }
}

function initializeGallery() {
    const closeBtn = document.getElementById("close-gallery");
    if (closeBtn) {
        closeBtn.addEventListener("click", closeGallery);
    }
    const overlay = document.getElementById("gallery-overlay");
    if (overlay) {
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeGallery();
        });
    }
}

// ==============================================
// SECTION 59: FULLSCREEN IMAGE VIEWER
// ==============================================

function initializeFullscreenViewer() {
    const overlay = document.getElementById("fullscreen-image-overlay");
    const closeBtn = document.getElementById("fullscreen-close");
    if (!overlay || !closeBtn) return;
    closeBtn.addEventListener("click", closeFullscreenImage);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeFullscreenImage();
    });
}

function openFullscreenImage(work, quest) {
    const overlay = document.getElementById("fullscreen-image-overlay");
    const fullscreenImg = document.getElementById("fullscreen-image");
    const titleEl = document.getElementById("fullscreen-title");
    const detailsEl = document.getElementById("fullscreen-details");
    const descriptionEl = document.getElementById("fullscreen-description");
    if (!overlay || !fullscreenImg) return;
    fullscreenImg.src = work.image || work.image_url;
    titleEl.textContent = work.title || "Untitled";
    let details = [];
    if (quest && quest.title) details.push(`Quest: ${quest.title}`);
    if (work.size) details.push(`Size: ${work.size}`);
    if (work.media) details.push(`Media: ${work.media}`);
    detailsEl.textContent = details.join(" • ");
    descriptionEl.textContent = work.description || "";
    overlay.style.display = "flex";
    const escHandler = function(e) {
        if (e.key === "Escape") {
            closeFullscreenImage();
            document.removeEventListener("keydown", escHandler);
        }
    };
    document.addEventListener("keydown", escHandler);
    overlay.escHandler = escHandler;
}

function closeFullscreenImage() {
    const overlay = document.getElementById("fullscreen-image-overlay");
    if (!overlay) return;
    overlay.style.display = "none";
    if (overlay.escHandler) {
        document.removeEventListener("keydown", overlay.escHandler);
        delete overlay.escHandler;
    }
}

// ==============================================
// SECTION 60: RESTRICTION POPUP FUNCTIONS
// ==============================================

function showRestrictionPopup(activeQuestId) {
    const popup = document.getElementById("restriction-popup");
    const link = document.getElementById("active-quest-link");
    const activeQuest = quests[activeQuestId];
    if (activeQuest) {
        link.textContent = `"${activeQuest.title}"`;
        link.onclick = (e) => {
            e.preventDefault();
            closeRestrictionPopup();
            const questOverlay = document.getElementById("quest-overlay");
            if (questOverlay && questOverlay.style.display === "block") {
                closeQuest();
            }
            setTimeout(() => {
                openQuest(activeQuestId);
            }, 100);
        };
    }
    popup.style.display = "flex";
}

function closeRestrictionPopup() {
    const popup = document.getElementById("restriction-popup");
    if (popup) popup.style.display = "none";
}

function showPrerequisitePopup(message, prerequisites) {
    const popup = document.getElementById("prerequisite-popup");
    const messageEl = document.getElementById("prerequisite-message");
    const listEl = document.getElementById("prerequisite-quests-list");
    if (messageEl) messageEl.textContent = message;
    if (prerequisites && prerequisites.length > 0) {
        let listHTML = "<ul style='list-style: none; padding: 0;'>";
        prerequisites.forEach(prereqId => {
            const quest = quests[prereqId];
            if (quest) {
                const completed = completedQuests[prereqId] ? "✓" : "✗";
                const color = completedQuests[prereqId] ? "#4CAF50" : "#ff6b6b";
                listHTML += `<li style='margin: 8px 0; color: ${color};'>${completed} ${quest.title}</li>`;
            }
        });
        listHTML += "</ul>";
        if (listEl) listEl.innerHTML = listHTML;
    }
    if (popup) popup.style.display = "flex";
}

function closePrerequisitePopup() {
    const popup = document.getElementById("prerequisite-popup");
    if (popup) popup.style.display = "none";
}

// ==============================================
// SECTION 61: QUEST CACHING (BANDWIDTH OPTIMIZATION)
// ==============================================

let cachedQuestsIncludeCustom = false;

async function getQuests() {
    if (cachedQuests) {

        return cachedQuests;
    }
    const framework = await detectTeacherFramework();
    const questsFile = getQuestsFileForFramework(framework);

    const response = await fetch(questsFile);
    const rawQuests = await response.json();
    const filteredQuests = {};
    for (const [key, value] of Object.entries(rawQuests)) {
        if (key.startsWith('quest') && value && typeof value === 'object') {
            filteredQuests[key] = value;
        }
    }
    cachedQuests = filteredQuests;

    return cachedQuests;
}

function refreshQuestsCache() {
    refreshAllQuestCaches();

}

function refreshAllQuestCaches() {
    cachedQuests = null;
    cachedQuestsIncludeCustom = false;
    localStorage.removeItem(QUEST_CACHE_KEY);
    localStorage.removeItem(QUEST_CACHE_VERSION_KEY);
    localStorage.removeItem(QUEST_CACHE_TIMESTAMP_KEY);

}

async function getQuestsWithLocalCache(forceRefresh = false) {
    if (forceRefresh) {

        cachedQuests = null;
        cachedQuestsIncludeCustom = false;
    }
    let teacherTimestamp = null;
    try {
        const { data: { session } } = await window.supabase.auth.getSession();
        if (session) {
            const { data: profile } = await window.supabase
                .from('profiles')
                .select('teacher_code')
                .eq('id', session.user.id)
                .single();
            if (profile?.teacher_code) {
                const { data: teacher } = await window.supabase
                    .from('teachers')
                    .select('quests_updated_at')
                    .eq('class_code', profile.teacher_code)
                    .single();
                teacherTimestamp = teacher?.quests_updated_at ? new Date(teacher.quests_updated_at).getTime() : null;
            }
        }
    } catch(e) {

    }
    const cachedTimestamp = localStorage.getItem(QUEST_CACHE_TIMESTAMP_KEY);
    const cacheAge = cachedTimestamp ? Date.now() - parseInt(cachedTimestamp) : Infinity;
    const isCacheExpired = cacheAge > QUEST_CACHE_DURATION;
    const teacherHasNewerQuests = teacherTimestamp && cachedTimestamp && teacherTimestamp > parseInt(cachedTimestamp);
    if (forceRefresh || teacherHasNewerQuests || isCacheExpired) {
        console.log("Refreshing quest cache...", {
            forceRefresh,
            teacherHasNewerQuests,
            isCacheExpired
        });
        const freshQuests = await getAllQuestsForStudent(true);
        cachedQuests = freshQuests;
        quests = freshQuests;
        localStorage.setItem(QUEST_CACHE_KEY, JSON.stringify(freshQuests));
        localStorage.setItem(QUEST_CACHE_VERSION_KEY, QUEST_CACHE_VERSION);
        localStorage.setItem(QUEST_CACHE_TIMESTAMP_KEY, Date.now().toString());
        return freshQuests;
    }
    const cached = localStorage.getItem(QUEST_CACHE_KEY);
    const storedVersion = localStorage.getItem(QUEST_CACHE_VERSION_KEY);
    if (cached && storedVersion === QUEST_CACHE_VERSION) {

        const parsedCache = JSON.parse(cached);
        cachedQuests = parsedCache;
        quests = parsedCache;
        return parsedCache;
    }

    const freshQuests = await getAllQuestsForStudent(true);
    cachedQuests = freshQuests;
    quests = freshQuests;
    localStorage.setItem(QUEST_CACHE_KEY, JSON.stringify(freshQuests));
    localStorage.setItem(QUEST_CACHE_VERSION_KEY, QUEST_CACHE_VERSION);
    localStorage.setItem(QUEST_CACHE_TIMESTAMP_KEY, Date.now().toString());
    return freshQuests;
}

async function checkQuestCacheValidity() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return false;
    const { data: profile } = await window.supabase
        .from('profiles')
        .select('teacher_code')
        .eq('id', session.user.id)
        .single();
    if (!profile?.teacher_code) return false;
    const { data: teacher } = await window.supabase
        .from('teachers')
        .select('quests_updated_at')
        .eq('class_code', profile.teacher_code)
        .single();
    if (!teacher?.quests_updated_at) return false;
    const cachedTimestamp = localStorage.getItem(QUEST_CACHE_TIMESTAMP_KEY);
    const teacherTimestamp = new Date(teacher.quests_updated_at).getTime();
    if (!cachedTimestamp || teacherTimestamp > parseInt(cachedTimestamp)) {

        refreshAllQuestCaches();
        return true;
    }

    return false;
}

// ==============================================
// SECTION 62: IMAGE COMPRESSION
// ==============================================

async function compressImage(file, maxWidth = 800, quality = 0.8) {
    return new Promise((resolve, reject) => {
        // Check if it's an image
        if (!file.type.startsWith('image/')) {
            resolve(file);
            return;
        }
        
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            
            // More aggressive resizing
            if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
            }
            
            // If image is very large, scale down even more
            if (width > 1200) {
                const scale = 1200 / width;
                width = 1200;
                height = height * scale;
            }
            
            canvas.width = width;
            canvas.height = height;
            
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, width, height);
            
            // Convert to JPEG with quality
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('Image compression failed'));
                    return;
                }
                
                // Create a new file from blob
                const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, '.jpg'), {
                    type: 'image/jpeg',
                    lastModified: Date.now()
                });
                

                
                resolve(compressedFile);
            }, 'image/jpeg', quality);
        };
        
        img.onerror = () => {
            reject(new Error('Failed to load image'));
        };
        
        img.src = URL.createObjectURL(file);
    });
}

// ==============================================
// SECTION 62B: RESEARCH PDF HELPERS
// ==============================================

const RESEARCH_PDF_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Upload a research PDF to the student-research bucket.
 * Returns { url, name } on success, or null on failure.
 */
async function uploadResearchPdf(questId, file) {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return null;

    if (file.size > RESEARCH_PDF_MAX_BYTES) {
        alert("PDF is too large. Maximum size is 5 MB.");
        return null;
    }
    if (file.type !== "application/pdf") {
        alert("Only PDF files are allowed for research documents.");
        return null;
    }

    const userId = session.user.id;
    const fileName = `${userId}/${questId}.pdf`;

    const { error } = await window.supabase.storage
        .from('student-research')
        .upload(fileName, file, {
            cacheControl: '86400',
            upsert: true,
            contentType: 'application/pdf'
        });

    if (error) {

        alert("Failed to upload research PDF: " + error.message);
        return null;
    }

    const { data: urlData } = window.supabase.storage
        .from('student-research')
        .getPublicUrl(fileName);

    return {
        url: urlData.publicUrl + '?v=' + Date.now(),
        name: file.name
    };
}

/**
 * Delete the research PDF for a quest from storage.
 */
async function deleteResearchPdfFromStorage(questId) {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return;

    const fileName = `${session.user.id}/${questId}.pdf`;
    await window.supabase.storage
        .from('student-research')
        .remove([fileName]);
}
// ==============================================
// SECTION 63: BADGE SYSTEM
// ==============================================

function loadBadgesFromJSON() {
    return fetch("badges.json")
        .then(res => {
            if (!res.ok) throw new Error("Failed to load badges.json");
            return res.json();
        })
        .then(data => {
            badgesData = data.badges;

            return badgesData;
        })
        .catch(err => {

            badgesData = [];
            return badgesData;
        });
}

function initializeBadgeSystem() {


    const existingBadges = { ...earnedBadges };
    checkAllBadges(false);
    for (const [badgeId, badgeData] of Object.entries(existingBadges)) {
        if (badgeData.earned && !earnedBadges[badgeId]) {

            earnedBadges[badgeId] = badgeData;
        }
    }
    saveEarnedBadges();

}

function checkAllBadges(showCelebration = true) {
    if (!badgesData) return;
    const previousBadges = { ...earnedBadges };
    let newBadgesEarned = false;
    badgesData.forEach(badge => {
        if (previousBadges[badge.id]?.earned === true) {
            if (!earnedBadges[badge.id]) {
                earnedBadges[badge.id] = previousBadges[badge.id];
            }
            return;
        }
        if (badge.teacherAwarded) return;
        let earned = false;
        if (badge.progression) {
            earned = checkProgressionBadge(badge);
        } else if (badge.checkFunction) {
            if (badge.checkFunction === "checkPathMastery") {
                earned = checkPathMastery(badge.params);
            } else if (badge.checkFunction === "checkColorExpert") {
                earned = checkColorExpert(badge.params);
            } else if (badge.checkFunction === "checkPerspectivePro") {
                earned = checkPerspectivePro(badge.params);
            }
        }
        if (earned) {
            if (!previousBadges[badge.id]?.earned) {
                newBadgesEarned = true;

                if (showCelebration) showBadgeNotification(badge.name);
            }
            if (!badge.progression) {
                earnedBadges[badge.id] = {
                    earned: true,
                    earnedAt: earnedBadges[badge.id]?.earnedAt || new Date().toISOString()
                };
            }
        }
    });
    saveEarnedBadges();
    if (newBadgesEarned) {

        saveBadgesToCloud();
    }

}

function checkProgressionBadge(badge) {
    if (!badge.levels) return false;
    let mvpCount = 0;
    const mvpQuestIds = [];
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (isCompleted === true) {
            const quest = quests[questId];
            if (quest && quest.style === 'mvp') {
                mvpCount++;
                mvpQuestIds.push(questId);
            }
        }
    }

    let highestLevel = null;
    if (badge.levels) {
        for (const level of badge.levels) {
            if (mvpCount >= level.count) {
                highestLevel = level;
            }
        }
    }
    if (highestLevel) {
        earnedBadges[badge.id] = {
            earned: true,
            level: highestLevel.level,
            count: mvpCount,
            image: highestLevel.image || badge.image,
            borderClass: highestLevel.borderClass,
            tooltip: highestLevel.tooltip,
            earnedAt: earnedBadges[badge.id]?.earnedAt || new Date().toISOString()
        };

        return true;
    } else {
        if (earnedBadges[badge.id] && earnedBadges[badge.id].earned) {

            return true;
        }
        return false;
    }
}

async function saveBadgesToCloud() {
    if (isLoadingFromCloud) return;
    await ensureFreshSession();
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return;
    const userId = session.user.id;
    const { error } = await guardAuth(() =>
        window.supabase
            .from('student_progress')
            .update({
                earned_badges: earnedBadges,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
    );
    if (error) {

    } else {

    }
}

function checkPathMastery(params) {
    const { path, count } = params;
    let completedCount = 0;
    Object.entries(completedQuests).forEach(([questId, isCompleted]) => {
        if (!isCompleted) return;
        const quest = quests[questId];
        if (!quest || quest.style !== "mvp") return;
        if (Array.isArray(quest.path) && quest.path.includes(path)) {
            completedCount++;
        } else if (quest.path === path) {
            completedCount++;
        }
    });
    return completedCount >= count;
}

function checkColorExpert(params) {
    const { count } = params;
    const colorQuests = [
        "quest1", "quest5", "quest8", "quest9", "quest10",
        "quest33", "quest34", "quest35", "quest36", "quest64"
    ];
    let completedCount = 0;
    colorQuests.forEach(questId => {
        if (completedQuests[questId] && quests[questId]?.style === "mvp") {
            completedCount++;
        }
    });
    return completedCount >= count;
}

function checkPerspectivePro(params) {
    const { achievement } = params;
    const targetAchievement = achievementsData.find(a => a.title === achievement);
    if (!targetAchievement) return false;
    return targetAchievement.questsNeeded.every(questId => completedQuests[questId]);
}

// ==============================================
// SECTION 64: RENDER BADGES IN PROFILE
// ==============================================

function renderBadges() {
    const container = document.getElementById("badge-container");
    const titleElement = document.getElementById("badge-title");
    if (!container || !badgesData) return;
    container.innerHTML = "";
    const profile = loadStudentProfile() || {};
    const studentName = profile.name || "Student";
    if (titleElement) {
        titleElement.textContent = `${studentName}'s Art Badges`;
    }
    const sortedBadges = [...badgesData].sort((a, b) => {
        const order = { path: 1, skill: 2, progression: 3, teacher: 4 };
        return (order[a.category] || 5) - (order[b.category] || 5);
    });
    sortedBadges.forEach(badge => {
        const badgeSlot = document.createElement("div");
        badgeSlot.className = "badge-slot";
        const earnedInfo = earnedBadges[badge.id];
        const isEarned = earnedInfo?.earned;
        const img = document.createElement("img");
        if (badge.progression && isEarned && earnedInfo?.image) {
            img.src = earnedInfo.image;
        } else {
            img.src = badge.image;
        }
        img.alt = badge.name;
        img.onerror = function() {
            this.style.backgroundColor = "rgba(100,100,100,0.3)";
            this.style.borderRadius = "50%";
        };
        if (isEarned) {
            badgeSlot.classList.add("earned");
            if (badge.category === "teacher" || earnedInfo?.teacherAwarded) {
                badgeSlot.classList.add("teacher-awarded");
            }
            if (badge.progression && earnedInfo?.borderClass) {
                badgeSlot.classList.add(earnedInfo.borderClass);
            }
            let tooltip = "";
            if (badge.progression && earnedInfo?.tooltip) {
                tooltip = earnedInfo.tooltip;
            } else if (badge.teacherAwarded) {
                tooltip = `Teacher Award: ${badge.name}`;
            } else {
                tooltip = badge.tooltipEarned ? badge.tooltipEarned.replace("{name}", studentName) : badge.name;
            }
            badgeSlot.setAttribute("data-tooltip", tooltip);
        } else {
            badgeSlot.classList.add("shadow");
            let tooltip = "";
            if (badge.progression) {
                const count = earnedInfo?.count || 0;
                const nextLevel = badge.levels?.find(l => l.count > count);
                if (nextLevel) {
                    tooltip = `Quest Completer: ${count}/${nextLevel.count} summatives completed. ${nextLevel.tooltip}`;
                } else {
                    tooltip = badge.tooltipShadow || badge.name;
                }
            } else {
                tooltip = badge.tooltipShadow || badge.name;
            }
            badgeSlot.setAttribute("data-tooltip", tooltip);
        }
        badgeSlot.appendChild(img);
        container.appendChild(badgeSlot);
    });
}

// ==============================================
// SECTION 65: UPDATE BADGES AFTER QUEST COMPLETION
// ==============================================

function updateBadgesAfterQuest() {

    checkAllBadges(true);
    checkBadgeExp();
    checkAchievementExp();
    if (document.getElementById("profile-overlay").style.display === "flex") {
        renderBadges();
    }
    saveBadgesToCloud();
}

// ==============================================
// SECTION 65b: REAL-TIME BADGE UPDATES
// ==============================================

function setupRealtimeRefresh() {
    if (!window.supabase || !window.supabase.auth) {

        setTimeout(setupRealtimeRefresh, 1000);
        return;
    }
    window.supabase.auth.getSession().then(({ data: { session }, error }) => {
        if (error || !session) {

            setTimeout(setupRealtimeRefresh, 3000);
            return;
        }

        if (realtimeSubscription) {
            window.supabase.removeChannel(realtimeSubscription);
        }
        realtimeSubscription = window.supabase
            .channel('student-progress-changes')
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'student_progress',
                filter: `user_id=eq.${session.user.id}`
            }, (payload) => {


                refreshStudentData();
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'student_works',
                filter: `user_id=eq.${session.user.id}`
            }, (payload) => {

                const galleryOverlay = document.getElementById("gallery-overlay");
                if (galleryOverlay && galleryOverlay.style.display === "flex") {
                    renderGalleryItems();
                }
                refreshStudentData();
            })
            .subscribe((status) => {

            });
    }).catch(error => {

        setTimeout(setupRealtimeRefresh, 2000);
    });
}

function showBadgeNotification(badgeName) {
    const notification = document.createElement('div');
    notification.className = 'badge-notification';
    notification.innerHTML = `<div class="badge-notification-content">🎉 New Badge Unlocked: ${badgeName}! 🎉</div>`;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => notification.remove(), 500);
    }, 4000);
}

async function manualRefreshBadges() {

    await loadStudentDataFromCloud();
    const profileOverlay = document.getElementById("profile-overlay");
    if (profileOverlay && profileOverlay.style.display === "flex") {
        renderBadges();
    }
    const localBadges = loadEarnedBadges();


    alert("Badges refreshed! Check console for details.");
}

// ==============================================
// SECTION 66: WEIGHTED CATEGORIES (NCAS only)
// ==============================================
//
// Splits all graded standards into 5 weighted categories:
//   Resolved Artworks            45%
//   Art Study                    20%
//   Independent Art Research     15%
//   Art Community Collaboration  10%
//   Art Material and Resources Care  10%
//
// Routing rules:
//   1. Art.FA.CN.10.1.IA  → always "Independent Art Research"
//      (severed from the quest's other standards, regardless of category)
//   2. All other standards → the quest's `category` field
//   3. Missing category   → fallback: mvp → "Resolved Artworks",
//                                     else → "Art Study"
//
// Math per category:
//   rawAvg     = sum(grades) / count          (0–4 scale)
//   percent    = (rawAvg / 4) * 100
//   weighted   = percent * (weight / 100)
//
// Overall = sum of all weighted contributions. Empty category → 0.
//
// ==============================================

const WEIGHTED_CATEGORY_CONFIG = {
    resolvedArtworks: {
        key: 'resolvedArtworks',
        label: 'Resolved Artworks',
        fullLabel: 'Resolved Artworks',
        weight: 45,
        dbCategory: 'Resolved Artworks'
    },
    artStudy: {
        key: 'artStudy',
        label: 'Art Study',
        fullLabel: 'Art Study',
        weight: 20,
        dbCategory: 'Art Study'
    },
    independentResearch: {
        key: 'independentResearch',
        label: 'Independent Art Research',
        fullLabel: 'Independent Art Research',
        weight: 15,
        dbCategory: null   // derived from CN.10.1.IA, not from `category`
    },
    collaboration: {
        key: 'collaboration',
        label: 'Art Community Collaboration',
        fullLabel: 'Art Community Collaboration',
        weight: 10,
        dbCategory: 'Art Community Collaboration'
    },
    materialCare: {
        key: 'materialCare',
        label: 'Art Material and Resources Care.',
        fullLabel: 'Art Material and Resources Care',
        weight: 10,
        dbCategory: 'Art Material and Resources Care'
    }
};

// ============================================================
// GRADE → PERCENTAGE CURVE
// ============================================================
// The teacher still enters grades on the 1–4 scale (0.5 steps).
// This curve converts a grade (or a bucket's average grade) to the
// percentage that is displayed and aggregated everywhere in the app.
//
// Non-linear on purpose:
//   4   → 100%
//   3.5 → 95%
//   3   → 90%
//   2.5 → 80%
//   2   → 70%
//   1.5 → 65%
//   1   → 60%
//   0.5 → 55%
//   0   → 50%   (a 0 is treated as 50%, not 0%)
//
// Semantics: AVERAGE-THEN-CURVE. Callers first average the raw 1–4
// grades in a bucket, then pass that average to gradeToPercent().
// Do not curve individual grades and then average — that produces
// different (and unintended) results because the curve is non-linear.
// ============================================================

const GRADE_PERCENT_CURVE = {
    4:   100,
    3.5: 95,
    3:   90,
    2.5: 80,
    2:   70,
    1.5: 65,
    1:   60,
    0.5: 55,
    0:   50
};

/**
 * Convert a raw NCAS grade (or an average of raw grades) to a percentage
 * using GRADE_PERCENT_CURVE.
 *
 * - Snaps the input to the nearest 0.5 so float noise (e.g. 2.4999999)
 *   still lands on a table key.
 * - Falls back to the old linear formula (grade / 4 * 100) for any
 *   value that slips through the table (defensive; should never happen
 *   given the NCAS rubric's 1–4 step-0.5 inputs).
 *
 * @param {number|string} grade
 * @returns {number|null}  percentage 0–100, or null if the input is not numeric
 */
function gradeToPercent(grade) {
    const g = parseFloat(grade);
    if (isNaN(g)) return null;
    const key = Math.round(g * 2) / 2;
    return GRADE_PERCENT_CURVE[key] ?? (g / 4) * 100;
}

const INDEPENDENT_RESEARCH_STANDARD = 'Art.FA.CN.10.1.IA';

// ----------------------------------------------------------------
// Resolve which category a quest's *non-research* standards belong to.
// Handles the compound form  "Art Study + Independent Art Research"
// by taking the first segment. Falls back to MVP / formative defaults.
// ----------------------------------------------------------------
function resolveQuestBaseCategory(quest) {
    if (!quest) return 'Art Study';

    let raw = quest.category;

    // Support accidental array form for safety
    if (Array.isArray(raw)) raw = raw[0];

    if (typeof raw === 'string' && raw.trim()) {
        // "Art Study + Independent Art Research" → "Art Study"
        const base = raw.split('+')[0].trim();
        const known = [
            'Resolved Artworks',
            'Art Study',
            'Art Community Collaboration',
            'Art Material and Resources Care'
        ];
        if (known.includes(base)) return base;
    }

    // Fallback: MVP → Resolved Artworks, else Art Study
    // Fallback: MVP → Resolved Artworks, else Art Study
    if (quest.style === 'mvp' || quest.is_mvp === true) return 'Resolved Artworks';
    return 'Art Study';
}

// ----------------------------------------------------------------
// Iterate every completed quest, every graded standard, and bucket
// each grade into the correct category.
//
// Only considers quests where completedQuests[id] === true.
// Skips null/undefined/"" grades (a 0 is a valid grade and is kept).
//
// Returns:
//   {
//     resolvedArtworks:     { rawAvg, percent, weighted, count, sum },
//     artStudy:             { ... },
//     independentResearch:  { ... },
//     collaboration:        { ... },
//     materialCare:         { ... },
//     overallPercent:       number
//   }
// ----------------------------------------------------------------
function calculateWeightedCategories() {
    // Buckets now accumulate QUEST AVERAGES, not raw standard grades.
    //   sum   = sum of the per-quest averages that touched this bucket
    //   count = number of DISTINCT quests that touched this bucket
    // This is the "quest-level averaging" model: each quest counts
    // exactly once per category it contributes to, regardless of how
    // many standards it assessed in that category.
    const buckets = {
        resolvedArtworks:    { sum: 0, count: 0 },
        artStudy:            { sum: 0, count: 0 },
        independentResearch: { sum: 0, count: 0 },
        collaboration:       { sum: 0, count: 0 },
        materialCare:        { sum: 0, count: 0 }
    };

    // Map DB category string → bucket key
    const categoryToBucket = {
        'Resolved Artworks':                'resolvedArtworks',
        'Art Study':                        'artStudy',
        'Art Community Collaboration':      'collaboration',
        'Art Material and Resources Care':  'materialCare'
    };

    for (const [questId, isCompleted] of Object.entries(completedQuests || {})) {
        if (isCompleted !== true) continue;

        const quest = quests[questId];
        if (!quest) continue;

        const column = quest.style === 'mvp' ? 'mvpGrade' : 'grade';
        const grades = questGrades?.[questId]?.[column];
        if (!grades || typeof grades !== 'object') continue;

        const baseCategory = resolveQuestBaseCategory(quest);
        const baseBucket = categoryToBucket[baseCategory] || 'artStudy';

        // --- First pass: group this quest's grades by target bucket ---
        // A quest may touch multiple buckets if it contains CN.10.1.IA
        // alongside its base-category standards.
        const gradesByBucket = {};

        for (const [standardCode, rawGrade] of Object.entries(grades)) {
            if (standardCode === 'teacher_comment') continue;
            if (standardCode === 'completed_at') continue;

            // Parse numeric grade (framework NCAS only uses numbers)
            const grade = parseFloat(rawGrade);
            if (isNaN(grade)) continue;

            // Route: research standard is always severed
            const bucketKey = (standardCode === INDEPENDENT_RESEARCH_STANDARD)
                ? 'independentResearch'
                : baseBucket;

            if (!gradesByBucket[bucketKey]) gradesByBucket[bucketKey] = [];
            gradesByBucket[bucketKey].push(grade);
        }

        // --- Second pass: each touched bucket gets ONE contribution —
        // the average of this quest's standards that landed in it. ---
        for (const [bucketKey, arr] of Object.entries(gradesByBucket)) {
            if (arr.length === 0) continue;
            const questAvg = arr.reduce((s, v) => s + v, 0) / arr.length;
            buckets[bucketKey].sum   += questAvg;
            buckets[bucketKey].count += 1;   // count = number of quests, NOT standards
        }
    }

    // Build the result object with derived metrics
    const result = {};
    let overallPercent = 0;

    for (const [key, cfg] of Object.entries(WEIGHTED_CATEGORY_CONFIG)) {
        const { sum, count } = buckets[key];
        const rawAvg = count > 0 ? (sum / count) : 0;
        const percent = count > 0 ? gradeToPercent(rawAvg) : 0;
        const weighted = percent * (cfg.weight / 100);

        result[key] = {
            rawAvg:    rawAvg,
            percent:   percent,
            weighted:  weighted,
            count:     count,   // number of quests in this category
            sum:       sum      // sum of per-quest averages
        };

        overallPercent += weighted;
    }

    result.overallPercent = overallPercent;
    return result;
}

// ----------------------------------------------------------------
// Tooltip helper for the category headers (weight explanation).
// ----------------------------------------------------------------
function _ensureWeightedCatTooltip() {
    let tip = document.getElementById('weighted-cat-tooltip');
    if (tip) return tip;

    tip = document.createElement('div');
    tip.id = 'weighted-cat-tooltip';
    tip.className = 'weighted-cat-tooltip';
    document.body.appendChild(tip);
    return tip;
}

function _bindWeightedCatTooltips(rootEl) {
    const tip = _ensureWeightedCatTooltip();
    const headers = rootEl.querySelectorAll('[data-weight-tip]');

    headers.forEach(h => {
        h.addEventListener('mouseenter', () => {
            tip.innerHTML = h.dataset.weightTip;
            tip.classList.add('show');
        });
        h.addEventListener('mousemove', (e) => {
            // Position tooltip near cursor, flip at edges
            const rect = tip.getBoundingClientRect();
            let left = e.clientX + 14;
            let top  = e.clientY + 14;

            if (left + rect.width + 8 > window.innerWidth) {
                left = e.clientX - rect.width - 14;
            }
            if (top + rect.height + 8 > window.innerHeight) {
                top = e.clientY - rect.height - 14;
            }
            tip.style.left = left + 'px';
            tip.style.top  = top + 'px';
        });
        h.addEventListener('mouseleave', () => {
            tip.classList.remove('show');
        });
    });
}

// ----------------------------------------------------------------
// Render the Weighted Categories row into the profile grid.
// Called from the profile-open handler and after data refreshes.
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// Render the Weighted Categories row into the profile grid.
// Collapsible: header bar always visible, table behind a toggle.
// Called from the profile-open handler and after data refreshes.
// ----------------------------------------------------------------
function renderWeightedCategories() {
    const grid = document.querySelector('#profile-overlay .profile-grid');
    if (!grid) return;

    // --- Framework guard: NCAS only ---
    const framework = TeacherCache.framework || 'ncas';
    const existing = document.getElementById('weighted-categories-row');

    if (framework !== 'ncas') {
        if (existing) existing.remove();
        return;
    }

    const data = calculateWeightedCategories();

    const orderedKeys = [
        'resolvedArtworks',
        'artStudy',
        'independentResearch',
        'collaboration',
        'materialCare'
    ];

    // --- Header bar (always visible) ---
    const headerBar = `
        <div class="weighted-categories-header" id="weighted-categories-header">
            <div class="weighted-categories-header-left">
                <span class="weighted-categories-title">Weighted Grades</span>
                <span class="weighted-categories-summary">
                    <span class="summary-label">Overall</span>${data.overallPercent.toFixed(2)}%
                </span>
            </div>
            <span class="weighted-categories-toggle">▼</span>
        </div>
    `;

    // --- Body (collapsible) ---
    let headerCells = `<th class="overall-col" data-weight-tip="<strong>Overall Weighted Grade</strong><br>Sum of all weighted category contributions.">Overall W. Grade</th>`;
    let percentCells = `<td class="percent overall">${data.overallPercent.toFixed(2)}%</td>`;
    let rawCells = `<td class="raw-avg overall">—</td>`;

        for (const key of orderedKeys) {
        const cfg = WEIGHTED_CATEGORY_CONFIG[key];
        const cat = data[key];
        const tip = `<strong>${cfg.fullLabel}</strong><br>Weight: <strong>${cfg.weight}%</strong> of the total grade.`;

        // Color the header label to match the radar axis colors.
        // Falls back to the existing color if a key isn't in the map.
        const axisColor = (typeof RADAR_AXIS_COLORS === "object" && RADAR_AXIS_COLORS[key])
            ? RADAR_AXIS_COLORS[key].hex
            : null;
        const colorStyle = axisColor ? ` style="color:${axisColor};"` : "";

        headerCells += `<th data-weight-tip="${tip}"${colorStyle}>${cfg.label}</th>`;

        if (cat.count === 0) {
            percentCells += `<td class="percent empty">0.00%</td>`;
            rawCells     += `<td class="raw-avg empty">—</td>`;
        } else {
            percentCells += `<td class="percent">${cat.percent.toFixed(2)}%</td>`;
            rawCells     += `<td class="raw-avg">${cat.rawAvg.toFixed(2)}</td>`;
        }
    }

    const bodyHtml = `
        <div class="weighted-categories-body">
            <table class="weighted-categories-table">
                <thead>
                    <tr>${headerCells}</tr>
                </thead>
                <tbody>
                    <tr>${percentCells}</tr>
                    <tr>${rawCells}</tr>
                </tbody>
            </table>
        </div>
    `;

    const fullHtml = headerBar + bodyHtml;

    if (existing) {
        // Preserve expanded state across re-renders
        const wasExpanded = existing.classList.contains('expanded');
        existing.innerHTML = fullHtml;
        if (wasExpanded) existing.classList.add('expanded');
    } else {
        const row = document.createElement('div');
        row.id = 'weighted-categories-row';
        row.className = 'weighted-categories-row';
        row.innerHTML = fullHtml;

        const badgeRow = grid.querySelector('.badge-row');
        if (badgeRow) {
            grid.insertBefore(row, badgeRow);
        } else {
            grid.appendChild(row);
        }
    }

    const rowEl = document.getElementById('weighted-categories-row');
    if (!rowEl) return;

    // --- Wire the toggle (clone header to strip stale listeners) ---
    const headerEl = rowEl.querySelector('#weighted-categories-header');
    if (headerEl && !headerEl.dataset.wired) {
        headerEl.dataset.wired = '1';
        headerEl.addEventListener('click', (e) => {
            // Don't toggle when clicking a header cell with a tooltip
            // (they don't bubble up here anyway, but being safe)
            e.stopPropagation();
            rowEl.classList.toggle('expanded');
        });
    }

    // --- Wire tooltips on the header cells ---
    _bindWeightedCatTooltips(rowEl);
}

// ==============================================
// SECTION 67: 
// ==============================================


// ==============================================
// SECTION 68: REFRESH STUDENT DATA
// ==============================================

async function refreshStudentData() {

    invalidateStudentDataCache();
    await loadStudentDataFromCloud(true, true);
    await loadScheduleForStudent();
    try { await syncExpFromGradedWork(); } catch (e) { console.warn("[EXP] sync failed:", e); }
    updateProfileUI();
    invalidateTreeCompletedCache();
     // --- Featured quests: refresh panel with fresh completion state ---
    invalidateFeaturedQuestsCache();
    try { await renderFeaturedQuestsPanel(); } catch (e) { console.warn("[featured] render failed:", e); }
    updateProfileStandardsTable();
    renderRadarChart();
    checkAllQuestWarnings();
    if (currentQuestId && document.getElementById("rubric-overlay").style.display === "flex") {
        openRubricPopup(currentQuestId);
    }
        const profileOverlay = document.getElementById("profile-overlay");
    if (profileOverlay && profileOverlay.style.display === "flex") {
        renderBadges();
        if (typeof renderWeightedCategories === 'function') renderWeightedCategories();
        if (typeof renderProfileExpBar === 'function') renderProfileExpBar();
    }
    if (typeof renderQuestList === 'function') {
        const filterSelect = document.getElementById("questlist-filter");
        if (filterSelect) {
            renderQuestList(filterSelect.value);
        }
    }

}

// ==============================================
// SECTION 69: ART BATTLE FUNCTIONS (STUDENT SIDE)
// ==============================================

async function openArtBattle() {
    const overlay = document.getElementById('artbattle-overlay');
    const content = document.getElementById('artbattle-content');
    content.innerHTML = '<div class="artbattle-loading">Loading competitions...</div>';
    overlay.style.display = 'flex';
    try { await syncArtBattleSubmissionExp(); } catch (e) { console.warn("[EXP] art battle sync failed:", e); }
    await loadArtBattleContests();
}

async function loadArtBattleContests() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {
        document.getElementById('artbattle-content').innerHTML = '<div class="artbattle-loading">Please log in to view competitions.</div>';
        return;
    }
    const { data: contests, error } = await window.supabase
        .from('art_battle_contests')
        .select('*')
        .order('start_date', { ascending: true });
    if (error) {

        document.getElementById('artbattle-content').innerHTML = `<div class="artbattle-loading">Error: ${error.message}</div>`;
        return;
    }
    if (!contests || contests.length === 0) {
        document.getElementById('artbattle-content').innerHTML = '<div class="artbattle-loading">No active competitions at this time. Check back later!</div>';
        return;
    }
    const profile = loadStudentProfile();
    const { data: teacherData } = await window.supabase
        .from('teachers')
        .select('id')
        .eq('class_code', profile.teacher_code)
        .single();
    const teacherId = teacherData?.id;
    const visibleContests = contests.filter(contest => {
        const hiddenBy = contest.hidden_by_teachers || [];
        return !hiddenBy.includes(teacherId);
    });
    if (visibleContests.length === 0) {
        document.getElementById('artbattle-content').innerHTML = '<div class="artbattle-loading">No active competitions at this time. Check back later!</div>';
        return;
    }
    const now = new Date();
    let html = '<h2 style="color: #ffd700; margin-bottom: 20px;">⚔️ Art Battle Competitions</h2>';
    for (const contest of visibleContests) {
        const startDate = new Date(contest.start_date);
        const endDate = new Date(contest.end_date);
        let status = '';
        let statusClass = '';
        if (now < startDate) {
            status = 'Upcoming';
            statusClass = 'status-upcoming';
        } else if (now > endDate) {
            status = 'Ended';
            statusClass = 'status-ended';
        } else {
            status = 'Active';
            statusClass = 'status-active';
        }
        html += `
            <div class="artbattle-contest-card" data-contest-id="${contest.id}" data-contest-status="${status.toLowerCase()}">
                <div class="artbattle-contest-title">⚔️ ${escapeHtml(contest.title)}</div>
                <div class="artbattle-contest-dates">
                    📅 ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}
                    <span class="artbattle-contest-status ${statusClass}">${status}</span>
                </div>
                <div class="artbattle-contest-description">${escapeHtml(contest.description.substring(0, 150))}${contest.description.length > 150 ? '...' : ''}</div>
            </div>
        `;
    }
    document.getElementById('artbattle-content').innerHTML = html;
    document.querySelectorAll('.artbattle-contest-card').forEach(card => {
        card.addEventListener('click', () => {
            const contestId = card.dataset.contestId;
            const status = card.dataset.contestStatus;
            if (window.raceJitterInterval) {
                clearInterval(window.raceJitterInterval);
                window.raceJitterInterval = null;
            }
            openArtBattleContest(contestId, status);
        });
    });
}

async function voteForSubmission(contestId, submissionId) {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {
        alert("Please log in to vote.");
        return;
    }
    const { data: approvedSubmissions } = await window.supabase
        .from('art_battle_submissions')
        .select('id')
        .eq('contest_id', contestId)
        .eq('status', 'approved');
    const totalSubmissions = approvedSubmissions?.length || 0;
    const maxVotes = totalSubmissions <= 2 ? 1 : 2;
    const { data: existingVotes } = await window.supabase
        .from('art_battle_votes')
        .select('submission_id')
        .eq('contest_id', contestId)
        .eq('student_id', session.user.id);
    const currentVoteCount = existingVotes?.length || 0;
    const alreadyVotedForThis = existingVotes?.some(v => v.submission_id === submissionId);
    if (alreadyVotedForThis) {
        alert("You have already voted for this artwork!");
        return;
    }
    if (currentVoteCount >= maxVotes) {
        alert(`You must vote for ${maxVotes} different artwork${maxVotes > 1 ? 's' : ''}. You have already used all your votes.`);
        return;
    }
    if (maxVotes === 2 && currentVoteCount === 1) {
        const confirmed = confirm("You have cast 1 of 2 required votes. Continue with your second vote?");
        if (!confirmed) return;
    }
    const { error } = await window.supabase
        .from('art_battle_votes')
        .insert({
            contest_id: contestId,
            student_id: session.user.id,
            submission_id: submissionId
        });
    if (error) {

        alert("Error voting. Please try again.");
        return;
    }
    await window.supabase.rpc('increment_vote_count', { submission_id: submissionId });

    // --- EXP: vote in art battle (once per submission) ---
    addExp(EXP_RULES.VOTE, `vote:${contestId}:${submissionId}`, `Voted in art battle`);

    const remainingVotes = maxVotes - (currentVoteCount + 1);
    if (remainingVotes > 0) {
        alert(`Vote cast! You have ${remainingVotes} more vote${remainingVotes > 1 ? 's' : ''} remaining.`);
    } else {
        alert("Vote cast successfully! You have used all your votes for this contest.");
    }
    await openArtBattleContest(contestId, 'active');
}

async function viewStudentContestSubmission(submissionId) {
    const { data: submission, error } = await window.supabase
        .from('art_battle_submissions')
        .select('*, profiles(name, avatar_url)')
        .eq('id', submissionId)
        .single();
    if (error) {

        return;
    }
    alert(`Title: ${submission.title}\nStudent: ${submission.profiles?.name}\nDescription: ${submission.description || 'No description'}\nVotes: ${submission.votes || 0}`);
}

function initArtBattleHotspot() {
    const hotspot = document.querySelector('.hotspot.artbattle-hotspot');
    if (hotspot) {
        hotspot.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openArtBattle();
        });
    }
}

function closeArtBattle() {
    const overlay = document.getElementById('artbattle-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function initArtBattleClose() {
    const closeBtn = document.getElementById('close-artbattle');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeArtBattle);
    }
    const overlay = document.getElementById('artbattle-overlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeArtBattle();
            }
        });
    }
}

async function openSubmitArtworkModal(contestId) {
    const { data: session } = await window.supabase.auth.getSession();
    const { data: existingSubmission } = await window.supabase
        .from('art_battle_submissions')
        .select('id, status')
        .eq('contest_id', contestId)
        .eq('student_id', session?.user?.id)
        .maybeSingle();
    if (existingSubmission) {
        if (existingSubmission.status === 'pending') {
            const replace = confirm("You already have a pending submission. Do you want to replace it with a new one?");
            if (!replace) return;
            const { error: deleteError } = await window.supabase
                .from('art_battle_submissions')
                .delete()
                .eq('id', existingSubmission.id);
            if (deleteError) {
                alert("Error deleting old submission: " + deleteError.message);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        } else if (existingSubmission.status === 'approved') {
            alert("Your artwork has already been approved for this contest. You cannot submit another.");
            return;
        } else if (existingSubmission.status === 'rejected') {
            const resubmit = confirm("Your previous submission was rejected. Would you like to submit a new artwork?");
            if (!resubmit) return;
            const { error: deleteError } = await window.supabase
                .from('art_battle_submissions')
                .delete()
                .eq('id', existingSubmission.id);
            if (deleteError) {
                alert("Error deleting rejected submission: " + deleteError.message);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    currentContestForSubmission = contestId;
    const titleInput = document.getElementById('contest-submission-title');
    const descInput = document.getElementById('contest-submission-description');
    const imageInput = document.getElementById('contest-submission-image');
    const filenameDiv = document.getElementById('contest-submission-filename');
    const messageDiv = document.getElementById('contest-submission-message');
    const modal = document.getElementById('submit-contest-work-modal');
    if (titleInput) titleInput.value = '';
    if (descInput) descInput.value = '';
    if (imageInput) imageInput.value = '';
    if (filenameDiv) filenameDiv.style.display = 'none';
    if (messageDiv) messageDiv.innerHTML = '';
    if (modal) modal.style.display = 'flex';
}

function closeSubmitArtworkModal() {
    document.getElementById('submit-contest-work-modal').style.display = 'none';
}

async function viewContestSubmissionDetails(submissionId, forStudent = false, contestEnded = false) {
    const { data: submission, error } = await window.supabase
        .from('art_battle_submissions')
        .select('*')
        .eq('id', submissionId)
        .single();
    if (error) {

        return;
    }
    let isContestEnded = contestEnded;
    if (!contestEnded && submission.contest_id) {
        const { data: contest } = await window.supabase
            .from('art_battle_contests')
            .select('end_date')
            .eq('id', submission.contest_id)
            .single();
        if (contest) {
            isContestEnded = new Date(contest.end_date) < new Date();
        }
    }
    const modal = document.getElementById('teacher-work-modal');
    if (!modal) {

        return;
    }
    const content = document.getElementById('teacher-work-content');
    if (!content) {

        return;
    }
    const showStudentName = isContestEnded;
    content.innerHTML = `
        <div style="max-width: 500px; margin: 0 auto; text-align: center;">
            <h3 style="color: #ffd700;">${escapeHtml(submission.title || 'Untitled')}</h3>
            <div style="margin: 15px 0;">
                <img src="${submission.image_url}" alt="Student work" style="max-width: 100%; border-radius: 8px;">
            </div>
            <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; text-align: left;">
                ${showStudentName ? `<p><strong>Student:</strong> ${escapeHtml(submission.student_name || 'Unknown')}</p>` : ''}
                <p><strong>Votes:</strong> ⭐ ${parseFloat(submission.votes || 0).toFixed(1)}</p>
                <p><strong>Description:</strong><br>${escapeHtml(submission.description || 'No description')}</p>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
    const closeBtn = modal.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.style.display = 'none';
        };
    }
    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    };
}

function setupSubmissionImagePreview() {
    const imageInput = document.getElementById('contest-submission-image');
    const filenameDiv = document.getElementById('contest-submission-filename');
    if (imageInput) {
        imageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file && filenameDiv) {
                filenameDiv.textContent = `📎 Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
                filenameDiv.style.display = 'block';
            }
        });
    }
}

async function submitContestArtwork() {
    const title = document.getElementById('contest-submission-title').value.trim();
    const description = document.getElementById('contest-submission-description').value.trim();
    const imageFile = document.getElementById('contest-submission-image').files[0];
    const messageDiv = document.getElementById('contest-submission-message');
    if (!title) {
        messageDiv.innerHTML = 'Please enter a title.';
        messageDiv.style.color = '#ff8888';
        return;
    }
    if (!imageFile) {
        messageDiv.innerHTML = 'Please select an image.';
        messageDiv.style.color = '#ff8888';
        return;
    }
    if (imageFile.size > 2 * 1024 * 1024) {
        messageDiv.innerHTML = 'Image too large. Max 2MB. Upload a Screenshot or the photo, not the photo';
        messageDiv.style.color = '#ff8888';
        return;
    }
    messageDiv.innerHTML = 'Uploading...';
    messageDiv.style.color = '#ffd700';
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) {
        messageDiv.innerHTML = 'Please log in.';
        messageDiv.style.color = '#ff8888';
        return;
    }
    const { data: profile } = await window.supabase
        .from('profiles')
        .select('name, avatar_url')
        .eq('id', session.user.id)
        .single();
    const studentName = profile?.name || 'Unknown';
    const studentAvatar = profile?.avatar_url || 'profile.png';
    try {
        const compressedFile = await compressImage(imageFile, 1024, 0.85);
        const fileName = `contest_${currentContestForSubmission}_${session.user.id}_${Date.now()}.jpg`;
        const { data: uploadData, error: uploadError } = await window.supabase.storage
            .from('contest-submissions')
            .upload(fileName, compressedFile);
        if (uploadError) {
            throw uploadError;
        }
        const { data: urlData } = window.supabase.storage
            .from('contest-submissions')
            .getPublicUrl(fileName);
        const { error: insertError } = await window.supabase
            .from('art_battle_submissions')
            .insert({
                contest_id: currentContestForSubmission,
                student_id: session.user.id,
                image_url: urlData.publicUrl,
                title: title,
                description: description,
                avatar_url: studentAvatar,
                student_name: studentName,
                status: 'pending',
                votes: 0,
                submitted_at: new Date().toISOString()
            });
                if (insertError) {
            throw insertError;
        }

        // --- EXP: submitted to art battle (once per contest) ---
        addExp(EXP_RULES.SUBMIT_ART_BATTLE, `submit_battle:${currentContestForSubmission}`, `Submitted to art battle`);

        messageDiv.innerHTML = '✅ Artwork submitted! Waiting for teacher approval.';
        messageDiv.style.color = '#4caf50';
        setTimeout(() => {
            closeSubmitArtworkModal();
            openArtBattleContest(currentContestForSubmission, 'active');
        }, 2000);
    } catch (error) {

        messageDiv.innerHTML = 'Error submitting artwork. Please try again.';
        messageDiv.style.color = '#ff8888';
    }
}

function initSubmissionModal() {
    const modal = document.getElementById('submit-contest-work-modal');
    const closeX = document.getElementById('close-submit-contest-modal');
    const cancel = document.getElementById('cancel-submit-contest-btn');
    const submit = document.getElementById('confirm-submit-contest-btn');
    function closeModal() {
        if (modal) modal.style.display = 'none';
    }
    if (closeX) closeX.onclick = closeModal;
    if (cancel) cancel.onclick = closeModal;
    if (modal) modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    if (submit) submit.onclick = submitContestArtwork;
    setupSubmissionImagePreview();

}

async function deletePendingSubmission(contestId) {
    const { data: session } = await window.supabase.auth.getSession();
    const confirmed = confirm("Are you sure you want to delete your pending submission? This cannot be undone.");
    if (!confirmed) return;
    const { data: submission } = await window.supabase
        .from('art_battle_submissions')
        .select('id')
        .eq('contest_id', contestId)
        .eq('student_id', session?.user?.id)
        .eq('status', 'pending')
        .single();
    if (!submission) {
        alert("No pending submission found.");
        return;
    }
    const { error } = await window.supabase
        .from('art_battle_submissions')
        .delete()
        .eq('id', submission.id);
    if (error) {
        alert("Error deleting submission: " + error.message);
        return;
    }
    alert("Your submission has been deleted.");
    await openArtBattleContest(contestId, 'active');
}

async function replaceSubmission(contestId) {
    const { data: session } = await window.supabase.auth.getSession();
    const confirmed = confirm("Replace your current submission? Your existing artwork will be deleted and you can upload a new one.");
    if (!confirmed) return;
    const { data: submission } = await window.supabase
        .from('art_battle_submissions')
        .select('id')
        .eq('contest_id', contestId)
        .eq('student_id', session?.user?.id)
        .eq('status', 'pending')
        .single();
    if (submission) {
        await window.supabase
            .from('art_battle_submissions')
            .delete()
            .eq('id', submission.id);
    }
    openSubmitArtworkModal(contestId);
}

async function openArtBattleContest(contestId, status) {

    const { data: contest, error } = await window.supabase
        .from('art_battle_contests')
        .select('*')
        .eq('id', contestId)
        .single();
    if (error) {

        return;
    }
    const { data: allSubmissions, error: subError } = await window.supabase
        .from('art_battle_submissions')
        .select('*, profiles(name, avatar_url)')
        .eq('contest_id', contestId);
    if (subError) {

    }
    const submissions = allSubmissions?.filter(s => s.status === 'approved') || [];
    const startDate = new Date(contest.start_date);
    const endDate = new Date(contest.end_date);
    const now = new Date();
    const isActive = now >= startDate && now <= endDate;
    const isUpcoming = now < startDate;
    const isEnded = now > endDate;
    const startDateStr = startDate.toLocaleDateString();
    const endDateStr = endDate.toLocaleDateString();
    const { data: { user } } = await window.supabase.auth.getUser();
    const mySubmission = allSubmissions?.find(s => s.student_id === user?.id);
    const isRejected = mySubmission && mySubmission.status === 'rejected';
    const rejectionReason = mySubmission?.rejection_reason || '';
    const { data: myVotes } = await window.supabase
        .from('art_battle_votes')
        .select('submission_id')
        .eq('contest_id', contestId)
        .eq('student_id', user?.id);
    const { data: approvedSubmissionsForVotes } = await window.supabase
        .from('art_battle_submissions')
        .select('id')
        .eq('contest_id', contestId)
        .eq('status', 'approved');
    const totalApproved = approvedSubmissionsForVotes?.length || 0;
    const maxVotesAllowed = totalApproved <= 2 ? 1 : 2;
    const currentVoteCount = myVotes?.length || 0;
    const remainingVotes = maxVotesAllowed - currentVoteCount;
    const hasVotedCompletely = currentVoteCount >= maxVotesAllowed;
    const isContestActive = isActive && status !== 'ended';
    if (isContestActive && hasVotedCompletely && submissions.length > 0) {
        await renderRaceTrackView(contestId);
        return;
    }
    if (isEnded) {
        await renderResultsView(contestId);
        return;
    }
    let actionButtons = '';
    if (isRejected) {
        actionButtons = `
            <div class="contest-status-message" style="background: rgba(244, 67, 54, 0.3); border-color: #f44336; margin-top: 20px;">
                ❌ Your submission was not approved.<br>
                <strong>Reason:</strong> ${escapeHtml(rejectionReason)}
            </div>
        `;
    } else if (isActive && status !== 'ended') {
        const hasSubmitted = allSubmissions?.some(s => s.student_id === user?.id);
        if (!hasSubmitted) {
            actionButtons = `
                <div class="contest-action-buttons" style="margin-top: 20px;">
                    <button id="submit-artwork-btn" class="submit-artwork-btn">🎨 Submit Your Artwork</button>
                </div>
            `;
        } else if (hasSubmitted) {
            const mySubmission = allSubmissions?.find(s => s.student_id === user?.id);
            const isPending = mySubmission?.status === 'pending';
            actionButtons = `
                <div class="contest-action-buttons" style="margin-top: 20px;">
                    <div class="already-submitted">✅ You have already submitted artwork for this contest!</div>
                    ${isPending ? `
                        <div style="display: flex; gap: 10px; margin-top: 10px;">
                            <button id="delete-submission-btn" class="delete-submission-btn">🗑️ Delete Pending Submission</button>
                            <button id="replace-submission-btn" class="replace-submission-btn">🔄 Replace with New Artwork</button>
                        </div>
                    ` : ''}
                </div>
            `;
        }
    } else if (isUpcoming) {
        actionButtons = `<div class="contest-status-message">⏳ This contest starts on ${startDateStr}</div>`;
    } else if (isEnded) {
        actionButtons = `<div class="contest-status-message">🏁 This contest has ended. Winners will be announced soon!</div>`;
    }
    let submissionsHtml = '<div class="contest-submissions-section"><h3>📷 Submitted Artworks</h3><div class="contest-submissions-grid">';
    if (submissions && submissions.length > 0) {
        for (const sub of submissions) {
            const isOwnSubmission = sub.student_id === user?.id;
            const canVote = isActive && !isRejected && !isOwnSubmission && remainingVotes > 0;
            submissionsHtml += `
                <div class="contest-submission-card" data-submission-id="${sub.id}">
                    <div class="submission-thumbnail" style="cursor: pointer;">
                        <img src="${sub.image_url}" alt="${sub.title || 'Artwork'}">
                    </div>
                    <div class="submission-info">
                        <div class="submission-title">${escapeHtml(sub.title || 'Untitled')}</div>
                        <div class="submission-student">👤 ${escapeHtml(sub.profiles?.name || 'Unknown')}</div>
                        <div class="submission-votes">⭐ ${parseFloat(sub.votes || 0).toFixed(1)} votes</div>
                        ${canVote ? `<button class="vote-btn" data-submission-id="${sub.id}">👍 Vote (${remainingVotes} more needed)</button>` : ''}
                    </div>
                </div>
            `;
        }
    } else {
        submissionsHtml += '<div class="no-submissions">No submissions yet. Be the first to submit!</div>';
    }
    submissionsHtml += '</div></div>';
    const contestHtml = `
        <div class="contest-detail-view">
            <button id="back-to-contests" class="back-btn">← Back to Contests</button>
            <div class="contest-info-section">
                <div class="contest-info-title">📋 ${escapeHtml(contest.title)}</div>
                <div class="contest-info-row">
                    <div class="contest-info-label">Dates:</div>
                    <div class="contest-info-value">${startDateStr} - ${endDateStr}</div>
                </div>
                <div class="contest-info-row">
                    <div class="contest-info-label">Your Votes:</div>
                    <div class="contest-info-value">${currentVoteCount} of ${maxVotesAllowed} required (${remainingVotes} more needed)</div>
                </div>
                <div class="contest-info-row">
                    <div class="contest-info-label">Description:</div>
                    <div class="contest-info-value">${escapeHtml(contest.description)}</div>
                </div>
                <div class="contest-info-row">
                    <div class="contest-info-label">Requirements:</div>
                    <div class="contest-info-value">${escapeHtml(contest.requirements)}</div>
                </div>
                <div class="contest-info-row">
                    <div class="contest-info-label">Voting Guidelines:</div>
                    <div class="contest-info-value">${escapeHtml(contest.rubric)}</div>
                </div>
            </div>
            ${submissionsHtml}
            ${actionButtons}
        </div>
    `;
    document.getElementById('artbattle-content').innerHTML = contestHtml;
    document.getElementById('back-to-contests')?.addEventListener('click', () => {
        loadArtBattleContests();
    });
    document.querySelectorAll('.contest-submission-card .submission-thumbnail').forEach(thumb => {
        thumb.addEventListener('click', async () => {
            const card = thumb.closest('.contest-submission-card');
            const submissionId = card.dataset.submissionId;
            if (typeof viewContestSubmissionDetails === 'function') {
                await viewContestSubmissionDetails(submissionId, true, false);
            } else {

            }
        });
    });
    if (!isRejected) {
        document.querySelectorAll('.vote-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const submissionId = btn.dataset.submissionId;
                await voteForSubmission(contestId, submissionId);
            });
        });
    }
    document.getElementById('delete-submission-btn')?.addEventListener('click', () => {
        deletePendingSubmission(contestId);
    });
    document.getElementById('replace-submission-btn')?.addEventListener('click', () => {
        replaceSubmission(contestId);
    });
    const hasSubmitted = submissions?.some(s => s.student_id === user?.id);
    if (!isRejected && !hasSubmitted && isActive && status !== 'ended') {
        document.getElementById('submit-artwork-btn')?.addEventListener('click', () => {
            openSubmitArtworkModal(contestId);
        });
    }
}

async function renderRaceTrackView(contestId) {

    if (window.raceJitterInterval) {
        clearInterval(window.raceJitterInterval);
        window.raceJitterInterval = null;
    }
    const { data: contest, error } = await window.supabase
        .from('art_battle_contests')
        .select('*')
        .eq('id', contestId)
        .single();
    if (error) {

        return;
    }
    const { data: submissions, error: subError } = await window.supabase
        .from('art_battle_submissions')
        .select('*')
        .eq('contest_id', contestId)
        .eq('status', 'approved');
    if (subError) {

        return;
    }
    if (!submissions || submissions.length === 0) {
        document.getElementById('artbattle-content').innerHTML = '<div class="artbattle-loading">No artworks in this contest yet.</div>';
        return;
    }
    const totalVotes = submissions.reduce((sum, sub) => sum + (sub.votes || 0), 0);
    const sortedSubmissions = [...submissions].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    const startDate = new Date(contest.start_date);
    const endDate = new Date(contest.end_date);
    const startDateStr = startDate.toLocaleDateString();
    const endDateStr = endDate.toLocaleDateString();
    const { data: { user } } = await window.supabase.auth.getUser();
    const hasSubmitted = submissions?.some(s => s.student_id === user?.id);
    const userSubmission = submissions?.find(s => s.student_id === user?.id);
    const isPending = userSubmission?.status === 'pending';
    let submitButtonHtml = '';
    if (!hasSubmitted) {
        submitButtonHtml = `
            <div class="contest-action-buttons" style="margin-top: 20px;">
                <button id="submit-artwork-btn" class="submit-artwork-btn">🎨 Submit Your Artwork</button>
            </div>
        `;
    } else if (isPending) {
        submitButtonHtml = `
            <div class="contest-action-buttons" style="margin-top: 20px;">
                <div class="already-submitted">⏳ Your artwork is pending teacher approval.</div>
            </div>
        `;
    }
    let raceHtml = `
        <div class="contest-detail-view">
            <button id="back-to-contests" class="back-btn">← Back to Contests</button>
            <div class="contest-info-section" style="text-align: center;">
                <div class="contest-info-title" style="text-align: center; border-left: none;">🏁 ${escapeHtml(contest.title)}</div>
                <div class="contest-info-row">
                    <div class="contest-info-value">${startDateStr} - ${endDateStr}</div>
                </div>
            </div>
            <div class="race-track-container" id="race-track-container">
                <div class="race-header">
                    <span class="start-line">🏁 START</span>
                    <span class="finish-line">🏁 FINISH</span>
                </div>
                <div class="race-track" id="race-track">
    `;
    for (let i = 0; i < sortedSubmissions.length; i++) {
        const sub = sortedSubmissions[i];
        const votePercentage = totalVotes > 0 ? ((sub.votes || 0) / totalVotes) * 100 : 0;
        const basePosition = Math.min(votePercentage, 95);
        const randomOffset = (Math.random() * 40) - 20;
        let position = basePosition + randomOffset;
        position = Math.max(2, Math.min(95, position));
        const randomDistance = (Math.random() * 15) + 5;
        const studentAvatar = sub.avatar_url || 'profile.png';
        raceHtml += `
            <div class="race-lane" data-submission-id="${sub.id}">
                <div class="race-character racing" style="left: ${position}%; --random-offset: ${randomDistance}px;">
                    <div class="race-avatar">
                        <img src="${studentAvatar}" alt="Student">
                    </div>
                    <div class="race-votes">${parseFloat(sub.votes || 0).toFixed(1)} ⭐</div>
                </div>
                <div class="race-track-line"></div>
            </div>
        `;
    }
    raceHtml += `
                </div>
            </div>
            ${submitButtonHtml}
            <div style="text-align: center; margin-top: 10px;">
                <button id="reset-race-btn" class="refresh-race-btn">🏁 Reset Race Positions</button>
            </div>
        </div>
    `;
    document.getElementById('artbattle-content').innerHTML = raceHtml;
    document.getElementById('back-to-contests')?.addEventListener('click', () => {
        if (window.raceJitterInterval) {
            clearInterval(window.raceJitterInterval);
            window.raceJitterInterval = null;
        }
        loadArtBattleContests();
    });
    document.querySelectorAll('.race-lane').forEach(lane => {
        lane.addEventListener('click', async () => {
            const submissionId = lane.dataset.submissionId;
            await viewContestSubmissionDetails(submissionId, true, true);
        });
    });
    document.getElementById('submit-artwork-btn')?.addEventListener('click', () => {
        openSubmitArtworkModal(contestId);
    });
    document.getElementById('reset-race-btn')?.addEventListener('click', () => {
        const lanes = document.querySelectorAll('.race-lane');
        lanes.forEach((lane, index) => {
            const sub = sortedSubmissions[index];
            if (sub) {
                const votePercentage = totalVotes > 0 ? ((sub.votes || 0) / totalVotes) * 100 : 0;
                const actualPosition = Math.min(votePercentage, 95);
                const character = lane.querySelector('.race-character');
                if (character) {
                    character.style.left = `${actualPosition}%`;
                }
            }
        });
    });
    startRaceJitter(contestId);
}

function startRaceJitter(contestId) {
    if (window.raceJitterInterval) {
        clearInterval(window.raceJitterInterval);
    }
    window.raceJitterInterval = setInterval(() => {
        const raceTrack = document.getElementById('race-track');
        if (!raceTrack) {
            clearInterval(window.raceJitterInterval);
            window.raceJitterInterval = null;
            return;
        }
        const lanes = document.querySelectorAll('.race-lane');
        lanes.forEach(lane => {
            const character = lane.querySelector('.race-character');
            if (character) {
                let currentLeft = parseFloat(character.style.left);
                if (isNaN(currentLeft)) currentLeft = 50;
                let newLeft = currentLeft + (Math.random() * 12 - 6);
                newLeft = Math.max(2, Math.min(95, newLeft));
                character.style.left = `${newLeft}%`;
                const newDistance = (Math.random() * 15) + 5;
                character.style.setProperty('--random-offset', `${newDistance}px`);
            }
        });
    }, 500);
}

async function renderResultsView(contestId) {

    const { data: contest, error } = await window.supabase
        .from('art_battle_contests')
        .select('*')
        .eq('id', contestId)
        .single();
    if (error) {

        return;
    }
    const { data: submissions, error: subError } = await window.supabase
        .from('art_battle_submissions')
        .select('*, profiles(name, avatar_url)')
        .eq('contest_id', contestId)
        .eq('status', 'approved')
        .order('votes', { ascending: false });
    if (subError) {

        return;
    }
    if (!submissions || submissions.length === 0) {
        document.getElementById('artbattle-content').innerHTML = '<div class="artbattle-loading">No artworks in this contest.</div>';
        return;
    }
    const winners = submissions.slice(0, 3);
    const totalVotes = submissions.reduce((sum, sub) => sum + (sub.votes || 0), 0);
    const startDate = new Date(contest.start_date);
    const endDate = new Date(contest.end_date);
    const startDateStr = startDate.toLocaleDateString();
    const endDateStr = endDate.toLocaleDateString();
    let podiumHtml = `
        <div class="results-podium">
            <h3 style="color: #ffd700; text-align: center; margin-bottom: 20px;">🏆 WINNERS 🏆</h3>
            <div class="podium-container">
    `;
    const podiumOrder = [1, 0, 2];
    for (let i = 0; i < 3; i++) {
        const idx = podiumOrder[i];
        const winner = winners[idx];
        if (winner) {
            const medal = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : '🥉');
            const medalClass = idx === 0 ? 'gold' : (idx === 1 ? 'silver' : 'bronze');
            podiumHtml += `
            <div class="podium-spot ${medalClass}">
                <div class="podium-medal">${medal}</div>
                <div class="podium-avatar">
                    <img src="${winner.avatar_url || 'profile.png'}" alt="${escapeHtml(winner.title)}">
                </div>
                <div class="podium-name">${escapeHtml(winner.student_name || 'Unknown Student')}</div>
                <div class="podium-votes">${winner.votes || 0} ⭐</div>
                <div class="podium-thumbnail">
                    <img src="${winner.image_url}" alt="${winner.title}">
                </div>
            </div>
            `;
        }
    }
    podiumHtml += `
            </div>
        </div>
    `;
    const sortedSubmissions = [...submissions].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    let raceHtml = `
        <div class="race-track-container">
            <div class="race-header">
                <span class="start-line">🏁 START</span>
                <span class="finish-line">🏁 FINISH</span>
            </div>
            <div class="race-track">
    `;
    for (let i = 0; i < sortedSubmissions.length; i++) {
        const sub = sortedSubmissions[i];
        let finalPosition;
        if (i === 0) {
            finalPosition = 95;
        } else {
            const votePercentage = totalVotes > 0 ? ((sub.votes || 0) / totalVotes) * 100 : 0;
            finalPosition = Math.min(votePercentage, 95);
        }
        const studentAvatar = sub.avatar_url || 'profile.png';
        raceHtml += `
            <div class="race-lane" data-submission-id="${sub.id}">
                <div class="race-character" style="left: ${finalPosition}%;">
                    <div class="race-avatar">
                        <img src="${studentAvatar}" alt="Student">
                    </div>
                    <div class="race-name">${escapeHtml(sub.student_name || 'Unknown Student')}</div>
                    <div class="race-votes">${parseFloat(sub.votes || 0).toFixed(1)} ⭐</div>
                </div>
                <div class="race-track-line"></div>
            </div>
        `;
    }
    raceHtml += `
            </div>
        </div>
    `;
    const fullHtml = `
        <div class="contest-detail-view">
            <button id="back-to-contests" class="back-btn">← Back to Contests</button>
            <div class="contest-info-section">
                <div class="contest-info-title">🏁 ${escapeHtml(contest.title)}</div>
                <div class="contest-info-row">
                    <div class="contest-info-label">Dates:</div>
                    <div class="contest-info-value">${startDateStr} - ${endDateStr}</div>
                </div>
            </div>
            <div class="results-tabs">
                <button class="results-tab-btn active" data-tab="podium">🏆 Winners</button>
                <button class="results-tab-btn" data-tab="racetrack">🏁 Final Positions</button>
            </div>
            <div id="results-podium-tab" class="results-tab-content active">
                ${podiumHtml}
            </div>
            <div id="results-racetrack-tab" class="results-tab-content" style="display: none;">
                ${raceHtml}
            </div>
        </div>
    `;
    document.getElementById('artbattle-content').innerHTML = fullHtml;
    document.getElementById('back-to-contests')?.addEventListener('click', () => {
        loadArtBattleContests();
    });
    document.querySelectorAll('.results-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.results-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('results-podium-tab').style.display = tab === 'podium' ? 'block' : 'none';
            document.getElementById('results-racetrack-tab').style.display = tab === 'racetrack' ? 'block' : 'none';
        });
    });
    document.querySelectorAll('.race-lane').forEach(lane => {
        lane.addEventListener('click', async () => {
            const submissionId = lane.dataset.submissionId;
            await viewContestSubmissionDetails(submissionId, true, false);
        });
    });
}

// ==============================================
// SECTION 70: DOM CONTENT LOADED
// ==============================================

document.addEventListener("DOMContentLoaded", () => {
    loadExpFromLocal();
    renderExpBar();
    getQuestsWithLocalCache().then(questsData => {
        quests = questsData;
        cachedQuests = questsData;          // ← Mark in-memory cache as set
        cachedQuestsIncludeCustom = true;   // ← Mark as fully loaded (skip re-fetch)

        
        // Build quest relationships once on load
        buildQuestRelationships();
        // Build the summative path menu from the loaded quests
        buildPathQuests();

        // ==============================================
        // Pre-cache all teacher timer values in background
        // (defined here so it has access to `quests`)
        // ==============================================
        async function preCacheAllTimerValues() {
            if (!quests || Object.keys(quests).length === 0) return;
            const profile = loadStudentProfile();
            if (!profile?.teacher_code) return;
            try {
                const { data: teacher } = await window.supabase
                    .from('teachers')
                    .select('id')
                    .eq('class_code', profile.teacher_code)
                    .maybeSingle();
                if (!teacher) return;
                
                const { data: timers } = await window.supabase
                    .from('teacher_quest_standards')
                    .select('quest_id, timer_classes')
                    .eq('teacher_id', teacher.id);
                
                if (timers) {
                    timers.forEach(t => {
                        AppState.teacherData.customTimers[t.quest_id] = t.timer_classes;
                    });
                }
                AppState.teacherData.classDuration = await getClassDuration();
                AppState.teacherData.loaded = true;

            } catch (err) {

            }
        }
        // Fire and forget (don't await — runs in background)
        preCacheAllTimerValues();
        
        // Initialize everything that needs quests
        initializeWorkOverlay();
        initializeGallery();
        updateProfileUI();
        renderFeaturedQuestsPanel();
                // --- Silent cloud refresh so the panel and completion state are fresh ---
        // Skips if not logged in. Debounced internally by the 5s cache window.
        window.supabase.auth.getSession().then(({ data: { session } }) => {
            if (!session) return;
            loadStudentDataFromCloud(true)
                .then(() => {
                    // Once fresh data is in, re-render things that depend on it
                    invalidateFeaturedQuestsCache();
                    renderFeaturedQuestsPanel();
                    updateProfileUI();
                    if (typeof updateHotspotVisibility === "function") updateHotspotVisibility();
                })
                .catch(err => console.warn("[featured] background load failed:", err));
        });
        initializeRewardsOverlay();
        initializeActiveQuest();
        startBackgroundTimerCheck();
        initializeFloatingNavigation();
        initializeFullscreenViewer();
        bindHotspots();
        initializeHotspotTooltips()
        updateProfileStandardsTable();
        renderRadarChart();
        initializeQuestTimers();
        initializeQuestList();
        initializeRationaleOverlay();
        initializeAchievementsSystem();
        initializeProfileSystem();
        initializeResponsiveBehaviors();
        initializeHelpModal();
        setupCalendarTooltipDelegation();
        initArtBattleHotspot();
        initArtBattleClose();
        initSubmissionModal();
        setupActiveQuestButton();
        updateActiveQuestButton();
        initializeQuestTree();
        
        // Hotspot positioning
        const mapImage = document.getElementById("map-image");
        if (mapImage) {
            if (mapImage.complete) {
                initializeHotspotPositions();
                updateHotspotPositions();
                updateHotspotVisibility();
                addCustomQuestHotspots();
            } else {
                mapImage.onload = () => {
                    initializeHotspotPositions();
                    updateHotspotPositions();
                    updateHotspotVisibility();
                    addCustomQuestHotspots();
                };
            }
        }
        
        loadBadgesFromJSON().then(() => {
            initializeBadgeSystem();
        });
        
        // UI event listeners
        document.getElementById("path-selector")?.addEventListener("change", handlePathChange);
        document.getElementById("mvp-quests")?.addEventListener("change", function() {
            if (this.value) openQuest(this.value);
            this.style.display = "none";
        });

        const container = document.getElementById("map-container");
        window.addEventListener("wheel", e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const zoomFactor = 0.1;
            const MIN_SCALE = 1;
            scale += e.deltaY < 0 ? zoomFactor : -zoomFactor;
            if (scale < MIN_SCALE) scale = MIN_SCALE;
            if (container) {
                container.style.transform = `scale(${scale})`;
                requestAnimationFrame(() => updateHotspotPositions());
            }
        }, { passive: false });

        function isVisible(el) {
            return el && getComputedStyle(el).display !== "none";
        }
        
        const workImageInput = document.getElementById("work-image-input");
        if (workImageInput) {
            workImageInput.addEventListener("change", function(e) {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = function(event) {
                    const preview = document.getElementById("work-preview");
                    if (preview) preview.src = event.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        initializeStudentSetup();

        // Load self-assessments from localStorage
        const savedSelfAssessments = localStorage.getItem('selfAssessments');
        if (savedSelfAssessments) {
            try {
                window.selfAssessments = JSON.parse(savedSelfAssessments);

            } catch (e) {
                window.selfAssessments = {};
            }
        } else {
            window.selfAssessments = {};
        }

        // Check if there's a pending self-assessment (in case of page refresh)
        const pendingQuest = localStorage.getItem('pendingSelfAssessmentQuest');
        if (pendingQuest) {

            setTimeout(() => {
                if (confirm(`You have a pending self-assessment for a quest. Would you like to complete it now?`)) {
                    window._selfAssessmentPending = true;
                    openRubricPopup(pendingQuest, true);
                    localStorage.removeItem('pendingSelfAssessmentQuest');
                }
            }, 2000);
        }

        // Create New Profile and Back to Login links
        const createProfileLink = document.getElementById("create-profile-link");
        if (createProfileLink) {
            createProfileLink.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                document.getElementById("welcome-overlay").style.display = "none";
                showStudentSetupOverlay();
            });
        }

        const backToLoginLink = document.getElementById("back-to-login-link");
        if (backToLoginLink) {
            backToLoginLink.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                document.getElementById("student-setup-overlay").style.display = "none";
                document.getElementById("welcome-overlay").style.display = "flex";
            });
        }

        // ESC key handler
        window.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;

            const achievementsOverlay = document.getElementById("achievements-overlay");
            const rationaleOverlay = document.getElementById("rationale-overlay");
            const questOverlay = document.getElementById("quest-overlay");
            const rubricOverlay = document.getElementById("rubric-overlay");
            const workOverlay = document.getElementById("work-overlay"); 
            const galleryOverlay = document.getElementById("gallery-overlay");
            const modal = document.getElementById("helpModal");
            const restrictionPopup = document.getElementById("accept-quest-restriction-popup");
            const setupOverlay = document.getElementById("student-setup-overlay");
            const profileOverlay = document.getElementById("profile-overlay");
            const artBattleOverlay = document.getElementById("artbattle-overlay");
            const submitModal = document.getElementById('submit-contest-work-modal');
            const teacherWorkModal = document.getElementById('teacher-work-modal');
            const calendarModal = document.getElementById('calendar-modal');
            const questTreeOverlay = document.getElementById("quest-tree-overlay");
            const rewardsOverlay = document.getElementById("rewards-overlay");

            if (questTreeOverlay && questTreeOverlay.style.display === "block") {
                closeQuestTree();
                return;
            }
            if (isVisible(achievementsOverlay)) {
                closeAchievementsOverlay();
                return;
            }
            if (calendarModal && calendarModal.style.display === 'flex') {
                calendarModal.style.display = 'none';
                return;
            }
            if (isVisible(rationaleOverlay)) {
                closeRationalePopup();
                return;
            }
            if (isVisible(modal)) {
                if (typeof window.closeHelpModal === 'function') {
                    window.closeHelpModal();
                } else {
                    modal.style.display = "none";
                }
                return;
            }
            if (isVisible(workOverlay)) {
                closeWorkOverlay();
                return;
            }
            if (isVisible(rubricOverlay)) {
                rubricOverlay.style.display = "none";
                questOverlay.style.display = "block";
                return;
            }
                if (isVisible(questOverlay)) {
                closeQuest();
                return;
            }
            if (rewardsOverlay && rewardsOverlay.style.display === "flex") {
                closeRewardsOverlay();
                return;
            }
            if (profileOverlay && profileOverlay.style.display === "flex") {
                profileOverlay.style.display = "none";
                return;
            
            }
            if (restrictionPopup && restrictionPopup.style.display === "flex") {
                closeAcceptQuestRestrictionPopup();
                return;
            }
            if (galleryOverlay && galleryOverlay.style.display === "flex") {
                closeGallery();
                return;
            }
            if (teacherWorkModal && teacherWorkModal.style.display === 'flex') {
                teacherWorkModal.style.display = 'none';
                return;
            }
            if (artBattleOverlay && artBattleOverlay.style.display === "flex") {
                closeArtBattle();
                return;
            }
            if (submitModal && submitModal.style.display === 'flex') {
                submitModal.style.display = 'none';
                return;
            }
            if (setupOverlay && setupOverlay.style.display === "flex") {
                setupOverlay.style.display = "none";
                setupOverlay.classList.remove("hide-setup-text");
                const nameInput = document.getElementById("student-name-input");
                const nameSubmit = document.getElementById("student-name-submit");
                const characterDiv = document.getElementById("character-selection");
                if (nameInput) nameInput.style.display = "block";
                if (nameSubmit) nameSubmit.style.display = "block";
                if (characterDiv) characterDiv.style.display = "none";
                return;
            }
        });

                // Redraw tree connectors when the window resizes while the tree is open.
        window.addEventListener("resize", () => {
            const overlay = document.getElementById("quest-tree-overlay");
            if (overlay && overlay.style.display === "block") {
                redrawAllTreeConnectors();
            }
        });
        
        // Tab buttons
        document.querySelectorAll(".tab-button").forEach(button => {
            button.addEventListener("click", () => {
                const tab = button.dataset.tab;
                document.querySelectorAll(".tab-content").forEach(tc => tc.style.display = "none");
                document.querySelectorAll(".tab-button").forEach(b => b.classList.remove("active"));
                const tabEl = document.getElementById("tab-" + tab);
                if (tabEl) tabEl.style.display = "block";
                button.classList.add("active");
                
                if (tab === "questlist") {
                    const filterSelect = document.getElementById("questlist-filter");
                    if (filterSelect && typeof renderQuestList === 'function') {
                        renderQuestList(filterSelect.value);
                    }
                } else if (tab === "pathfinder") {
                    if (!pathfinderQuestions && typeof initializePathfinder === 'function') {
                        initializePathfinder();
                    }
                } else if (tab === "resources") {
                if (typeof renderResourcesTab === 'function') {
                    renderResourcesTab();
                }
                } else if (tab === "mysterygift") {
                    if (typeof renderMysteryGiftList === 'function') {
                        renderMysteryGiftList();
                    }
                }
            });
        });
        initializeStudentSetup();

        // Login/Logout listeners
        const loginBtn = document.getElementById("login-submit-btn");
        if (loginBtn) {
            loginBtn.addEventListener("click", handleLoginSubmit);

        }
        initializeLoginEnterKey();        
        
        const logoutBtn = document.getElementById("logout-profile-btn");
        if (logoutBtn) {
            logoutBtn.addEventListener("click", logout);
        }
        
        // Calendar button
        const calendarBtn = document.getElementById('calendar-btn');
        if (calendarBtn) {
            calendarBtn.addEventListener('click', openStudentCalendar);
        }
        
        // Close calendar
        const closeCalendar = document.getElementById('close-calendar');
        if (closeCalendar) {
            closeCalendar.addEventListener('click', () => {
                document.getElementById('calendar-modal').style.display = 'none';
            });
        }
        
        // Calendar navigation
        const prevBtn = document.getElementById('calendar-prev-month');
        if (prevBtn) {
            prevBtn.addEventListener('click', calendarPrevMonth);
        }
        
        const nextBtn = document.getElementById('calendar-next-month');
        if (nextBtn) {
            nextBtn.addEventListener('click', calendarNextMonth);
        }
        
        const calendarModal = document.getElementById('calendar-modal');
        if (calendarModal) {
            calendarModal.addEventListener('click', (e) => {
                if (e.target === calendarModal) {
                    calendarModal.style.display = 'none';
                }
            });
        }
        
        // Real-time refresh (after login)
        setTimeout(() => {
            setupRealtimeRefresh();
        }, 3000);
    }).catch(err => console.error("Failed to load quests:", err));
});

/* ==========================================================
   FLOATING ACTION CLUSTER  —  wiring
   Handles the 5 cluster buttons + the search toggle.
   Reuses existing openGallery / openAchievementsOverlay /
   openStudentCalendar / openQuestTree and fuzzySearchQuests.
   ========================================================== */
(function initFloatingCluster() {

    // ---------- 1. Simple buttons ----------
    const buttonMap = [
        { id: 'cluster-gallery',      handler: () => { if (typeof openGallery === 'function') openGallery(); } },
        { id: 'cluster-achievements', handler: () => { if (typeof openAchievementsOverlay === 'function') openAchievementsOverlay(); } },
        { id: 'cluster-tree',         handler: () => { if (typeof openQuestTree === 'function') openQuestTree(); } },
        { id: 'cluster-calendar',     handler: () => { if (typeof openStudentCalendar === 'function') openStudentCalendar(); } }
    ];

    buttonMap.forEach(({ id, handler }) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        // Clone to drop any listeners if this ever runs twice
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', (e) => {
            e.preventDefault();
            handler();
        });
    });

    // ---------- 2. Search toggle ----------
    const searchBtn     = document.getElementById('cluster-search');
    const searchWrapper = document.getElementById('cluster-search-wrapper');
    const searchPanel   = document.getElementById('cluster-search-panel');
    const searchInput   = document.getElementById('cluster-search-input');
    const searchResults = document.getElementById('cluster-search-results');

    if (!searchBtn || !searchPanel || !searchInput || !searchResults) {

        return;
    }

    // Clone to strip stale listeners
    const freshSearchBtn = searchBtn.cloneNode(true);
    searchBtn.parentNode.replaceChild(freshSearchBtn, searchBtn);

    function openSearchPanel() {
        searchPanel.classList.add('open');
        searchPanel.setAttribute('aria-hidden', 'false');
        // Let the browser paint the panel before focusing
        setTimeout(() => searchInput.focus(), 30);
    }

    function closeSearchPanel() {
        searchPanel.classList.remove('open');
        searchPanel.setAttribute('aria-hidden', 'true');
        searchInput.value = '';
        searchResults.innerHTML = '';
    }

    function isOpen() {
        return searchPanel.classList.contains('open');
    }

    // Toggle on click
    freshSearchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isOpen()) closeSearchPanel();
        else openSearchPanel();
    });

    // Prevent clicks inside the panel from bubbling to the document handler
    searchPanel.addEventListener('click', (e) => e.stopPropagation());

    // Click outside → close
    document.addEventListener('click', (e) => {
        if (!isOpen()) return;
        if (searchWrapper.contains(e.target)) return;
        closeSearchPanel();
    });

    // ESC closes the search panel first
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) {
            // stopPropagation is not possible on document-level;
            // instead, we close here and let other ESC handlers run their thing.
            // To avoid double-close weirdness, we rely on the user pressing ESC
            // once for search, once more for the overlay underneath.
            closeSearchPanel();
        }
    });

    // ---------- 3. Live search ----------
    // Reuses the existing fuzzySearchQuests() and quests object from script.js.
    let debounceTimer = null;

    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const term = searchInput.value.trim().toLowerCase();
            searchResults.innerHTML = '';

            if (term.length < 2) return;

            if (typeof fuzzySearchQuests !== 'function' || typeof quests !== 'object') {
                searchResults.innerHTML = `<div class="search-result">Search unavailable</div>`;
                return;
            }

            const matches = fuzzySearchQuests(term);

            if (!matches.length) {
                searchResults.innerHTML = `<div class="search-result">No results</div>`;
                return;
            }

            matches.forEach(({ id, quest }) => {
                const div = document.createElement('div');
                div.className = 'search-result';

                const paths = Array.isArray(quest.path)
                    ? quest.path.join(', ')
                    : (quest.path || 'No path');

                div.innerHTML = `
                    <strong>${paths}</strong><br>
                    <span>${quest.title || id}</span>
                `;

                div.addEventListener('click', () => {
                    // Reset zoom when jumping via search
                    scale = 1;
                    const container = document.getElementById('map-container');
                    if (container) container.style.transform = 'scale(1)';

                    closeSearchPanel();

                    if (typeof openQuest === 'function') openQuest(id);
                });

                searchResults.appendChild(div);
            });
        }, 120);
    });

    // Enter key on the input → open the first result
    searchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const first = searchResults.querySelector('.search-result');
        if (first) first.click();
    });


})();
/* ==========================================================
   Hide MVP dropdown when clicking outside #dropdown-container
   ========================================================== */
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('dropdown-container');
    const mvpSel   = document.getElementById('mvp-quests');
    if (!dropdown || !mvpSel) return;

    // If the click was inside the dropdown container → do nothing
    if (dropdown.contains(e.target)) return;

    // Otherwise, hide the MVP select and reset it
    if (mvpSel.style.display !== 'none') {
        mvpSel.style.display = 'none';
        mvpSel.innerHTML = '<option value="">Select MVP Quest</option>';

        // Also reset the path selector visual (optional — remove if you
        // want to keep the chosen path shown)
        const pathSel = document.getElementById('path-selector');
        // if (pathSel) pathSel.value = "";   // ← uncomment if you want this
    }
});
/* ==========================================================
   Prevent clicks inside #dropdown-container from reaching
   the map / hotspots behind it.
   ========================================================== */
(function shieldDropdown() {
    const dropdown = document.getElementById('dropdown-container');
    if (!dropdown) return;

    // Swallow clicks that land on the dropdown (including its
    // background padding and the selects inside it).
    ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown', 'pointerup']
        .forEach(evt => {
            dropdown.addEventListener(evt, (e) => {
                e.stopPropagation();
            });
        });
})();
