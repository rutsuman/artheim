// ==========================
// TEACHER DASHBOARD
// ==========================

// Class Management Variables
let currentClassFilter = 'all';
let teacherClasses = [];
let classManagementActive = false;
let bulkAssignMode = false;
let selectedStudentsForBulk = new Set();
let currentStudentId = null; // Store current student ID globally
let deleteMode = false;
let selectedStudentsForDelete = new Set();
let currentTeacherEmail = null;
let currentQuestData = null;
let cachedQuests = null;
let currentFramework = null;
let cachedFramework = null;
let cachedFrameworkTime = 0;
const FRAMEWORK_CACHE_DURATION = 300000; // 5 minutes
let analyticsData = {
    students: [],
    questStats: {},
    framework: 'ncas',
    classFilter: 'all'
};


// Helper function to escape HTML (add this anywhere in your file, near other helper functions)
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}
// Get quests from cache or fetch once
async function getQuests() {
    // If we already have cached quests, return them immediately
    if (cachedQuests) {
        console.log("Returning cached quests, count:", Object.keys(cachedQuests).length);
        return cachedQuests;
    }
    
    // If not cached, load framework and then fetch
    const framework = await loadTeacherFramework();
    const questsFile = getQuestsFileForFramework(framework);
    console.log(`Loading quests from ${questsFile} (first time, will cache)...`);
    
    const response = await fetch(questsFile);
    cachedQuests = await response.json();
    console.log("Quests cached successfully:", Object.keys(cachedQuests).length, "quests found");
    
    return cachedQuests;
}
// Force refresh cache if needed (useful for development)
function refreshQuestsCache() {
    cachedQuests = null;
    console.log("Quest cache cleared");
}
// Handle teacher login
async function handleTeacherLogin() {
    const email = document.getElementById('teacher-email').value;
    const password = document.getElementById('teacher-password').value;
    const messageEl = document.getElementById('teacher-login-message');
    
    if (!email || !password) {
        messageEl.textContent = 'Please enter email and password';
        return;
    }
    
    messageEl.textContent = 'Logging in...';
    
    const { data, error } = await window.supabase.auth.signInWithPassword({
        email: email,
        password: password
    });
    
    if (error) {
        messageEl.textContent = error.message;
        return;
    }
    
    console.log("Login successful, user:", data.user);
    messageEl.textContent = 'Login successful! Checking teacher status...';
    
    const { data: { session } } = await window.supabase.auth.getSession();
    
    const { data: teacher, error: teacherError } = await window.supabase
        .from('teachers')
        .select('*')
        .eq('id', session.user.id);
    
    if (teacherError || !teacher || teacher.length === 0) {
        messageEl.textContent = 'This account is not a teacher.';
        await window.supabase.auth.signOut();
        return;
    }
    
    // Store teacher email for password verification
    currentTeacherEmail = email;
    
    messageEl.textContent = 'Teacher verified! Loading dashboard...';
    
    // Show dashboard, hide login
    document.getElementById('teacher-login-container').style.display = 'none';
    document.getElementById('teacher-dashboard-container').style.display = 'block';
    
    // Load classes and render accordion
    
    await loadClasses();
    await renderClassAccordion();
    await loadAllStudents();
}
// Load teacher's current framework selection
async function loadTeacherFramework(forceRefresh = false) {
    // Return cached framework if still valid
    if (!forceRefresh && cachedFramework && (Date.now() - cachedFrameworkTime) < FRAMEWORK_CACHE_DURATION) {
        console.log("Using cached framework:", cachedFramework);
        return cachedFramework;
    }
    
    console.log("Fetching framework from database...");
    const auth = await checkTeacherAuth();
    if (!auth) return 'ncas';
    
    const { data, error } = await window.supabase
        .from('teachers')
        .select('framework')
        .eq('id', auth.teacher.id)
        .single();
    
    const framework = (error || !data) ? 'ncas' : (data.framework || 'ncas');
    
    cachedFramework = framework;
    cachedFrameworkTime = Date.now();
    
    console.log("Framework cached:", framework);
    return framework;
}
// Save teacher's framework selection
async function saveTeacherFramework(framework) {
    const auth = await checkTeacherAuth();
    if (!auth) return false;
    
    const { error } = await window.supabase
        .from('teachers')
        .update({ framework: framework })
        .eq('id', auth.teacher.id);
    
    if (error) {
        console.error("Error saving framework:", error);
        return false;
    }
    
    return true;
}
// Show framework change warning and get confirmation
async function confirmFrameworkChange(newFramework) {
    return new Promise((resolve) => {
        const confirmMessage = confirm(
            `⚠️ CHANGE FRAMEWORK TO ${newFramework.toUpperCase()}?\n\n` +
            `This will permanently DELETE:\n` +
            `• All student grades for all quests\n` +
            `• All rubric scores and standards mastery data\n` +
            `• All badge progress tied to specific standards\n\n` +
            `Student profiles and artwork will be preserved.\n\n` +
            `This action CANNOT be undone.\n\n` +
            `Click OK to continue or Cancel to abort.`
        );
        
        if (!confirmMessage) {
            resolve(false);
            return;
        }
        
        // Second confirmation with typing
        const userInput = prompt(
            `Type "CONFIRM" to permanently switch to ${newFramework.toUpperCase()} and delete ALL grade data:`
        );
        
        if (userInput === 'CONFIRM') {
            resolve(true);
        } else {
            alert('Framework change cancelled.');
            resolve(false);
        }
    });
}
// Initialize framework selector UI
async function initializeFrameworkSelector() {
    console.log("Initializing framework selector...");
    
    const currentFrameworkValue = await loadTeacherFramework();
    currentFramework = currentFrameworkValue;
    
    console.log("Current framework:", currentFrameworkValue);
    
    // Set radio button
    const radio = document.querySelector(`input[name="framework"][value="${currentFrameworkValue}"]`);
    if (radio) {
        radio.checked = true;
    }
    
    // Add change listener to show warning
    const radios = document.querySelectorAll('input[name="framework"]');
    radios.forEach(radio => {
        radio.addEventListener('change', () => {
            const warningDiv = document.getElementById('framework-warning');
            if (radio.checked && radio.value !== currentFramework) {
                if (warningDiv) warningDiv.style.display = 'block';
            } else {
                if (warningDiv) warningDiv.style.display = 'none';
            }
        });
    });
    
    // Save button handler
    const saveBtn = document.getElementById('save-framework-btn');
    if (saveBtn) {
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        
        newSaveBtn.addEventListener('click', async () => {
            const selectedRadio = document.querySelector('input[name="framework"]:checked');
            const newFramework = selectedRadio?.value;
            
            if (!newFramework) {
                showFrameworkMessage('Please select a framework', 'error');
                return;
            }
            
            if (newFramework === currentFramework) {
                showFrameworkMessage('This is already your current framework', 'error');
                return;
            }
            
            // Verify password
            const passwordValid = await verifyTeacherPassword();
            if (!passwordValid) {
                showFrameworkMessage('Password verification failed. Framework not changed.', 'error');
                const currentRadio = document.querySelector(`input[name="framework"][value="${currentFramework}"]`);
                if (currentRadio) currentRadio.checked = true;
                return;
            }
            
            // Confirm with user
            const confirmed = await confirmFrameworkChange(newFramework);
            if (!confirmed) {
                const currentRadio = document.querySelector(`input[name="framework"][value="${currentFramework}"]`);
                if (currentRadio) currentRadio.checked = true;
                showFrameworkMessage('Framework change cancelled', 'error');
                return;
            }
            
            // Delete all grading data
            await deleteAllGradingData();
            
            // Save new framework
            const success = await saveTeacherFramework(newFramework);
            
            if (success) {
                currentFramework = newFramework;
                
                // Clear the quest cache
                cachedQuests = null;
                
                showFrameworkMessage(`✅ Framework changed to ${newFramework.toUpperCase()}. Page will reload to apply changes.`, 'success');
                
                // Force page reload after a short delay
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
                
            } else {
                showFrameworkMessage('Error saving framework. Please try again.', 'error');
            }
        });
    }
}
// Show message in framework selector
function showFrameworkMessage(message, type) {
    const messageDiv = document.getElementById('framework-message');
    if (messageDiv) {
        messageDiv.textContent = message;
        messageDiv.className = `framework-message ${type}`;
        setTimeout(() => {
            messageDiv.textContent = '';
            messageDiv.className = 'framework-message';
        }, 5000);
    }
}
// Delete all grading data when framework changes
async function deleteAllGradingData() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    console.log("Deleting all grading data for framework change...");
    
    // Get all students
    const { data: students } = await window.supabase
        .from('profiles')
        .select('id')
        .eq('teacher_code', auth.teacher.class_code);
    
    if (!students || students.length === 0) return;
    
    const studentIds = students.map(s => s.id);
    
    // Delete all student_progress data
    const { error: progressError } = await window.supabase
        .from('student_progress')
        .delete()
        .in('user_id', studentIds);
    
    if (progressError) {
        console.error("Error deleting progress:", progressError);
    }
    
    // Reset all student_works to pending
    const { error: worksError } = await window.supabase
        .from('student_works')
        .update({ grading_status: 'pending' })
        .in('user_id', studentIds);
    
    if (worksError) {
        console.error("Error resetting works:", worksError);
    }
    
    console.log("All grading data deleted");
}
// Modified getQuests to support different frameworks
async function getQuests() {
    const framework = await loadTeacherFramework();
    const questsFile = getQuestsFileForFramework(framework);
    
    if (!cachedQuests) {
        console.log(`Loading quests from ${questsFile}...`);
        const response = await fetch(questsFile);
        cachedQuests = await response.json();
        console.log("Quests cached successfully:", Object.keys(cachedQuests).length, "quests found");
    }
    return cachedQuests;
}
// Get quests file path based on framework
function getQuestsFileForFramework(framework) {
    switch(framework) {
        case 'ib-myp':
            return 'quests-ib-myp.json';
        case 'igcse':
            return 'quests-igcse.json';
        default:
            return 'quests.json';
    }
}// Check if already logged in
async function checkExistingSession() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (session) {
        // Check if user is a teacher
        const { data: teacher } = await window.supabase
            .from('teachers')
            .select('id')
            .eq('id', session.user.id)
            .single();
        
        if (teacher) {
            document.getElementById('teacher-login-container').style.display = 'none';
            document.getElementById('teacher-dashboard-container').style.display = 'block';
            
            // Load classes and render accordion
            await loadClasses();
            await renderClassAccordion();
            await loadAllStudents();
        }
    }
}
// Check if user is a teacher (used by dashboard functions)
async function checkTeacherAuth() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return null;
    
    const { data: teacher, error } = await window.supabase
        .from('teachers')
        .select('id, class_code')
        .eq('id', session.user.id)
        .single();
    
    if (error || !teacher) return null;
    
    return { session, teacher };
}
// Forgot Password functionality for teacher
function setupTeacherForgotPassword() {
    const forgotLink = document.getElementById('teacher-forgot-password-link');
    const modal = document.getElementById('forgot-password-modal');
    const cancelBtn = document.getElementById('reset-cancel-btn');
    const submitBtn = document.getElementById('reset-submit-btn');
    const emailInput = document.getElementById('reset-email-input');
    const messageDiv = document.getElementById('reset-message');
    
    if (!forgotLink) return;
    
    forgotLink.addEventListener('click', (e) => {
        e.preventDefault();
        modal.style.display = 'flex';
        emailInput.value = '';
        messageDiv.innerHTML = '';
    });
    
    cancelBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    submitBtn.addEventListener('click', async () => {
        const email = emailInput.value.trim();
        if (!email) {
            messageDiv.innerHTML = 'Please enter your email address.';
            messageDiv.style.color = '#ff8888';
            return;
        }
        
        messageDiv.innerHTML = 'Sending reset link...';
        messageDiv.style.color = '#ffd700';
        
        const { error } = await window.supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/reset-password.html'
        });
        
        if (error) {
            messageDiv.innerHTML = error.message;
            messageDiv.style.color = '#ff8888';
        } else {
            messageDiv.innerHTML = 'Reset link sent! Check your email.';
            messageDiv.style.color = '#4caf50';
            setTimeout(() => {
                modal.style.display = 'none';
            }, 3000);
        }
    });
}

//-----------------------Teacher Dashboard My students, Quests, manage Class, Analytics tabs----------------------

// Tab switching between Students, Quests, and Class Management
function setupMainTabs() {
    const studentsMainTab = document.getElementById('students-main-tab');
    const questsMainTab = document.getElementById('quests-main-tab');
    const classesMainTab = document.getElementById('classes-main-tab');
    const analyticsMainTab = document.getElementById('analytics-main-tab');
    
    const studentsMainContent = document.getElementById('students-main-content');
    const questsMainContent = document.getElementById('quests-main-content');
    const classesMainContent = document.getElementById('classes-main-content');
    const analyticsMainContent = document.getElementById('analytics-main-content');
    
    if (!studentsMainTab || !questsMainTab || !classesMainTab || !analyticsMainTab) return;    

    // Students Tab
    studentsMainTab.addEventListener('click', async () => {
        studentsMainTab.classList.add('active');
        questsMainTab.classList.remove('active');
        classesMainTab.classList.remove('active');
        analyticsMainTab.classList.remove('active');
        
        studentsMainContent.style.display = 'block';
        questsMainContent.style.display = 'none';
        classesMainContent.style.display = 'none';
        analyticsMainContent.style.display = 'none';
        
        // Refresh students list when tab opens
        await renderClassAccordion();
    });
    
    // Quests Tab
    questsMainTab.addEventListener('click', async () => {
        questsMainTab.classList.add('active');
        studentsMainTab.classList.remove('active');
        classesMainTab.classList.remove('active');
        analyticsMainTab.classList.remove('active');
        
        studentsMainContent.style.display = 'none';
        questsMainContent.style.display = 'block';
        classesMainContent.style.display = 'none';
        analyticsMainContent.style.display = 'none';
        
        // Render all quest accordions when tab is opened
        await renderAllQuestAccordions();
    });
    
    // Class Management Tab
        classesMainTab.addEventListener('click', async () => {
        classesMainTab.classList.add('active');
        studentsMainTab.classList.remove('active');
        questsMainTab.classList.remove('active');
        analyticsMainTab.classList.remove('active');
        
        studentsMainContent.style.display = 'none';
        questsMainContent.style.display = 'none';
        classesMainContent.style.display = 'block';
        analyticsMainContent.style.display = 'none';
        
        // Load classes and render class management view
        console.log("Loading classes for class management...");
        await loadClasses();
        console.log("Classes loaded:", teacherClasses.length);
        await renderClassManagementView();
        await renderClassSettingsTable();
        await loadTeacherClassCode();
        await initializeFrameworkSelector();
    });
        // Analytics Tab
        analyticsMainTab.addEventListener('click', async () => {
        analyticsMainTab.classList.add('active');
        studentsMainTab.classList.remove('active');
        questsMainTab.classList.remove('active');
        classesMainTab.classList.remove('active');
        
        studentsMainContent.style.display = 'none';
        questsMainContent.style.display = 'none';
        classesMainContent.style.display = 'none';
        analyticsMainContent.style.display = 'block';
        
        // Load analytics data
        await loadAnalyticsData();
    });
}
// Render quests accordion grouped by path
async function renderQuestsAccordion() {
    const container = document.getElementById('quests-accordion-container');
    if (!container) return;
    
    // Use getAllQuestsForTeacher instead of getQuests
    const allQuests = await getAllQuestsForTeacher();
    
    // Only show quests that have a valid path
    const validPaths = ['Painter Path', 'Sketcher Path', 'Watercolor Path', '3D Path'];
    
    const questsByPath = {
        'Painter Path': [],
        'Sketcher Path': [],
        'Watercolor Path': [],
        '3D Path': []
    };
    
    for (const [questId, quest] of Object.entries(allQuests)) {
        if (!quest || !quest.path) continue;
        
        let foundPath = null;
        if (Array.isArray(quest.path) && quest.path.length > 0) {
            const pathName = quest.path[0];
            if (validPaths.includes(pathName)) {
                foundPath = pathName;
            }
        } else if (typeof quest.path === 'string' && validPaths.includes(quest.path)) {
            foundPath = quest.path;
        }
        
        if (foundPath) {
            questsByPath[foundPath].push({
                id: questId,
                title: quest.title,
                isMVP: quest.style === 'mvp',
                isCustom: quest.is_custom === true,
                customId: quest.custom_id
            });
        }
    }
    
    container.innerHTML = '';
    
    const pathOrder = ['Painter Path', 'Sketcher Path', 'Watercolor Path', '3D Path'];
    const allPathHeaders = [];
    const allPathContents = [];
    
    for (const path of pathOrder) {
        const quests = questsByPath[path];
        if (quests.length === 0) continue;
        
        const pathDiv = document.createElement('div');
        pathDiv.className = 'quest-accordion-item';
        
        const pathHeader = document.createElement('div');
        pathHeader.className = 'quest-accordion-header';
        pathHeader.innerHTML = `
            <div>
                <span class="quest-title">📚 ${path}</span>
                <span class="quest-path-badge">(${quests.length} quests)</span>
            </div>
            <span class="quest-expand-icon">▼</span>
        `;
        
        const pathContent = document.createElement('div');
        pathContent.className = 'quest-accordion-content';
        
        const questsList = document.createElement('div');
        questsList.className = 'quests-list';
        
        quests.forEach(quest => {
            const questLink = document.createElement('div');
            questLink.className = 'quest-link-item';
            if (quest.isMVP) questLink.classList.add('mvp-quest-link');
            if (quest.isCustom) questLink.classList.add('custom-quest-item');
            
            questLink.innerHTML = `
                <span class="quest-link-title">${escapeHtml(quest.title)}</span>
                ${quest.isMVP ? '<span class="mvp-badge">👑 MVP</span>' : ''}
                ${quest.isCustom ? '<span class="custom-quest-badge">📝 Custom</span>' : ''}
                ${quest.isCustom ? '<button class="delete-custom-quest-btn" data-quest-id="' + quest.id + '" data-quest-title="' + escapeHtml(quest.title) + '" title="Delete Custom Quest">🗑️</button>' : ''}
            `;
            
            questLink.addEventListener('click', async (e) => {
            // Don't trigger if clicking delete button
            if (e.target.classList.contains('delete-custom-quest-btn')) return;
            
            e.stopPropagation();
            console.log("Opening quest:", quest.id);
            // Use getAllQuestsForTeacher instead of just getQuests
            const freshQuests = await getAllQuestsForTeacher();
            console.log("Fresh quests keys:", Object.keys(freshQuests));
    console.log("Looking for quest:", quest.id);
    console.log("Found quest:", freshQuests[quest.id]);
            openQuestDetailsPanel(quest.id, freshQuests);
            });
            
            questsList.appendChild(questLink);
        });
        
        pathContent.appendChild(questsList);
        
        allPathHeaders.push(pathHeader);
        allPathContents.push(pathContent);
        
        let pathExpanded = false;
        
        pathHeader.addEventListener('click', () => {
            if (pathExpanded) {
                pathExpanded = false;
                pathContent.classList.remove('expanded');
                pathHeader.classList.remove('expanded');
            } else {
                allPathHeaders.forEach((header, idx) => {
                    if (header !== pathHeader) {
                        allPathContents[idx].classList.remove('expanded');
                        allPathHeaders[idx].classList.remove('expanded');
                    }
                });
                pathExpanded = true;
                pathContent.classList.add('expanded');
                pathHeader.classList.add('expanded');
            }
        });
        
        pathDiv.appendChild(pathHeader);
        pathDiv.appendChild(pathContent);
        container.appendChild(pathDiv);
    }
}
// Load quest statistics for this teacher's students
async function loadQuestStatistics() {
    const auth = await checkTeacherAuth();
    if (!auth) return { activeQuests: {}, completedQuests: {} };
    
    // Get all students for this teacher
    const { data: students } = await window.supabase
        .from('profiles')
        .select('id')
        .eq('teacher_code', auth.teacher.class_code);
    
    if (!students || students.length === 0) {
        return { activeQuests: {}, completedQuests: {} };
    }
    
    const studentIds = students.map(s => s.id);
    
    // Get progress data for all students
    const { data: progressData } = await window.supabase
        .from('student_progress')
        .select('user_id, completed_quests, quest_accepted')
        .in('user_id', studentIds);
    
    const activeQuests = {};   // quest_id -> count of students who accepted (but NOT completed)
    const completedQuests = {}; // quest_id -> count of students who completed/graded
    
    if (progressData) {
        progressData.forEach(progress => {
            const completed = progress.completed_quests || {};
            const questAccepted = progress.quest_accepted || {};
            
            // Check accepted quests - ONLY if NOT completed
            Object.keys(questAccepted).forEach(questId => {
                if (questAccepted[questId] === true) {
                    // Only count as active if NOT completed
                    if (!completed[questId]) {
                        activeQuests[questId] = (activeQuests[questId] || 0) + 1;
                    }
                }
            });
            
            // Check completed quests
            Object.keys(completed).forEach(questId => {
                if (completed[questId] === true) {
                    completedQuests[questId] = (completedQuests[questId] || 0) + 1;
                }
            });
        });
    }
    
    return { activeQuests, completedQuests };
}
// Render Active Quests Accordion
async function renderActiveQuestsAccordion() {
    const container = document.getElementById('active-quests-accordion');
    if (!container) return;
    
    const { activeQuests } = await loadQuestStatistics();
    const allQuests = await getQuests();
    
    const activeQuestIds = Object.keys(activeQuests);
    
    if (activeQuestIds.length === 0) {
        container.innerHTML = '<div class="no-active-quests">No active quests at the moment</div>';
        return;
    }
    
    // Group by path
    const validPaths = ['Painter Path', 'Sketcher Path', 'Watercolor Path', '3D Path'];
    const questsByPath = {
        'Painter Path': [],
        'Sketcher Path': [],
        'Watercolor Path': [],
        '3D Path': []
    };
    
    for (const questId of activeQuestIds) {
        const quest = allQuests[questId];
        if (!quest) continue;
        
        let foundPath = null;
        if (quest.path && Array.isArray(quest.path) && quest.path.length > 0) {
            const pathName = quest.path[0];
            if (validPaths.includes(pathName)) {
                foundPath = pathName;
            }
        }
        
        if (foundPath) {
            questsByPath[foundPath].push({
                id: questId,
                title: quest.title,
                studentCount: activeQuests[questId],
                isMVP: quest.style === 'mvp'
            });
        }
    }
    
    container.innerHTML = '';
    
    const pathOrder = ['Painter Path', 'Sketcher Path', 'Watercolor Path', '3D Path'];
    const allPathHeaders = [];
    const allPathContents = [];
    
    for (const path of pathOrder) {
        const quests = questsByPath[path];
        if (quests.length === 0) continue;
        
        const pathDiv = document.createElement('div');
        pathDiv.className = 'quest-accordion-item';
        
        const totalStudents = quests.reduce((sum, q) => sum + q.studentCount, 0);
        
        const pathHeader = document.createElement('div');
        pathHeader.className = 'quest-accordion-header';
        pathHeader.innerHTML = `
            <div>
                <span class="quest-title">📚 ${path}</span>
                <span class="quest-path-badge">(${quests.length} quests, ${totalStudents} active students)</span>
            </div>
            <span class="quest-expand-icon">▼</span>
        `;
        
        const pathContent = document.createElement('div');
        pathContent.className = 'quest-accordion-content';
        
        const questsList = document.createElement('div');
        questsList.className = 'quests-list';
        
        quests.forEach(quest => {
            const questLink = document.createElement('div');
            questLink.className = 'quest-link-item';
            if (quest.isMVP) questLink.classList.add('mvp-quest-link');
            
            questLink.innerHTML = `
                <span class="quest-link-title">${escapeHtml(quest.title)}</span>
                <span class="quest-student-count-badge">${quest.studentCount} student${quest.studentCount !== 1 ? 's' : ''}</span>
                ${quest.isMVP ? '<span class="mvp-badge">👑 MVP</span>' : ''}
            `;
            
            questLink.addEventListener('click', async (e) => {
                e.stopPropagation();
                const freshRes = await fetch('quests.json');
                const freshQuests = await freshRes.json();
                openQuestDetailsPanel(quest.id, freshQuests);
            });
            
            questsList.appendChild(questLink);
        });
        
        pathContent.appendChild(questsList);
        
        allPathHeaders.push(pathHeader);
        allPathContents.push(pathContent);
        
        let pathExpanded = false;
        
        pathHeader.addEventListener('click', () => {
            if (pathExpanded) {
                pathExpanded = false;
                pathContent.classList.remove('expanded');
                pathHeader.classList.remove('expanded');
            } else {
                allPathHeaders.forEach((header, idx) => {
                    if (header !== pathHeader) {
                        allPathContents[idx].classList.remove('expanded');
                        allPathHeaders[idx].classList.remove('expanded');
                    }
                });
                pathExpanded = true;
                pathContent.classList.add('expanded');
                pathHeader.classList.add('expanded');
            }
        });
        
        pathDiv.appendChild(pathHeader);
        pathDiv.appendChild(pathContent);
        container.appendChild(pathDiv);
    }
}
// Render Completed Quests Accordion
async function renderCompletedQuestsAccordion() {
    const container = document.getElementById('completed-quests-accordion');
    if (!container) return;
    
    const { completedQuests } = await loadQuestStatistics();
    const allQuests = await getQuests();
    
    const completedQuestIds = Object.keys(completedQuests);
    
    if (completedQuestIds.length === 0) {
        container.innerHTML = '<div class="no-completed-quests">No completed quests yet</div>';
        return;
    }
    
    // Group by path
    const validPaths = ['Painter Path', 'Sketcher Path', 'Watercolor Path', '3D Path'];
    const questsByPath = {
        'Painter Path': [],
        'Sketcher Path': [],
        'Watercolor Path': [],
        '3D Path': []
    };
    
    for (const questId of completedQuestIds) {
        const quest = allQuests[questId];
        if (!quest) continue;
        
        let foundPath = null;
        if (quest.path && Array.isArray(quest.path) && quest.path.length > 0) {
            const pathName = quest.path[0];
            if (validPaths.includes(pathName)) {
                foundPath = pathName;
            }
        }
        
        if (foundPath) {
            questsByPath[foundPath].push({
                id: questId,
                title: quest.title,
                studentCount: completedQuests[questId],
                isMVP: quest.style === 'mvp'
            });
        }
    }
    
    container.innerHTML = '';
    
    const pathOrder = ['Painter Path', 'Sketcher Path', 'Watercolor Path', '3D Path'];
    const allPathHeaders = [];
    const allPathContents = [];
    
    for (const path of pathOrder) {
        const quests = questsByPath[path];
        if (quests.length === 0) continue;
        
        const pathDiv = document.createElement('div');
        pathDiv.className = 'quest-accordion-item';
        
        const totalStudents = quests.reduce((sum, q) => sum + q.studentCount, 0);
        
        const pathHeader = document.createElement('div');
        pathHeader.className = 'quest-accordion-header';
        pathHeader.innerHTML = `
            <div>
                <span class="quest-title">📚 ${path}</span>
                <span class="quest-path-badge">(${quests.length} quests, ${totalStudents} completed)</span>
            </div>
            <span class="quest-expand-icon">▼</span>
        `;
        
        const pathContent = document.createElement('div');
        pathContent.className = 'quest-accordion-content';
        
        const questsList = document.createElement('div');
        questsList.className = 'quests-list';
        
        quests.forEach(quest => {
            const questLink = document.createElement('div');
            questLink.className = 'quest-link-item';
            if (quest.isMVP) questLink.classList.add('mvp-quest-link');
            
            questLink.innerHTML = `
                <span class="quest-link-title">${escapeHtml(quest.title)}</span>
                <span class="quest-student-count-badge completed">${quest.studentCount} student${quest.studentCount !== 1 ? 's' : ''}</span>
                ${quest.isMVP ? '<span class="mvp-badge">👑 MVP</span>' : ''}
            `;
            
            questLink.addEventListener('click', async (e) => {
                e.stopPropagation();
                const freshRes = await fetch('quests.json');
                const freshQuests = await freshRes.json();
                openQuestDetailsPanel(quest.id, freshQuests);
            });
            
            questsList.appendChild(questLink);
        });
        
        pathContent.appendChild(questsList);
        
        allPathHeaders.push(pathHeader);
        allPathContents.push(pathContent);
        
        let pathExpanded = false;
        
        pathHeader.addEventListener('click', () => {
            if (pathExpanded) {
                pathExpanded = false;
                pathContent.classList.remove('expanded');
                pathHeader.classList.remove('expanded');
            } else {
                allPathHeaders.forEach((header, idx) => {
                    if (header !== pathHeader) {
                        allPathContents[idx].classList.remove('expanded');
                        allPathHeaders[idx].classList.remove('expanded');
                    }
                });
                pathExpanded = true;
                pathContent.classList.add('expanded');
                pathHeader.classList.add('expanded');
            }
        });
        
        pathDiv.appendChild(pathHeader);
        pathDiv.appendChild(pathContent);
        container.appendChild(pathDiv);
    }
}
// Update all quest accordions
async function renderAllQuestAccordions() {
    await renderQuestsAccordion();      // All quests
    await renderActiveQuestsAccordion();   // Active quests
    await renderCompletedQuestsAccordion(); // Completed quests
}
// Load all students for this teacher
async function loadAllStudents() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    const teacherCode = auth.teacher.class_code;
    
    let query = window.supabase
        .from('profiles')
        .select('*')
        .eq('teacher_code', teacherCode);
    
    if (currentClassFilter !== 'all') {
        query = query.eq('class_id', currentClassFilter);
    }
    
    const { data: profiles, error } = await query;
    
    const container = document.getElementById('student-list-container');
    if (!container) return;
    
    if (error || !profiles || profiles.length === 0) {
        container.innerHTML = '<div class="no-students">No students found</div>';
        return;
    }
    
    // Get pending works count
    const studentIds = profiles.map(p => p.id);
    const { data: pendingWorks } = await window.supabase
        .from('student_works')
        .select('user_id, quest_id')
        .eq('grading_status', 'pending')
        .in('user_id', studentIds);
    
    const pendingCounts = {};
    if (pendingWorks) {
        pendingWorks.forEach(work => {
            pendingCounts[work.user_id] = (pendingCounts[work.user_id] || 0) + 1;
        });
    }
    
    container.innerHTML = '';
    profiles.forEach(profile => {
        const studentCard = document.createElement('div');
        studentCard.className = 'student-card';
        studentCard.dataset.userId = profile.id;
        
        const pendingCount = pendingCounts[profile.id] || 0;
        const redDotHtml = pendingCount > 0 ? `<span class="pending-dot" title="${pendingCount} quest${pendingCount !== 1 ? 's' : ''} pending grading"></span>` : '';
        
        studentCard.innerHTML = `
            ${redDotHtml}
            <img src="${profile.avatar_url || 'profile.png'}" alt="${profile.name}">
            <div class="student-info">
                <h3>${escapeHtml(profile.name)}</h3>
                <p>${profile.email || ''}</p>
            </div>
        `;
        studentCard.addEventListener('click', () => loadStudentDetails(profile.id, profile.name));
        container.appendChild(studentCard);
    });
    
    // Also render the accordion view
    await renderClassAccordion();
}

//------------------------------------Student Profile ------------------------------------------------------------
//Load student's details for overlay
async function loadStudentDetails(userId, studentName) {
    console.log("Loading details for:", studentName, userId);
    document.getElementById('selected-student-name').textContent = studentName;
    document.getElementById('student-details-panel').style.display = 'block';
    
    await loadStudentProfileData(userId); 
    await loadStudentProgressData(userId);
    await loadStudentWorksData(userId);
}
// Load student progress data -  shows completed AND pending quests
async function loadStudentProgressData(userId) {
    const container = document.getElementById('student-quests-list');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Loading quest data...</div>';
    
    // Get progress data
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('completed_quests, quest_grades, earned_badges, quest_accepted')
        .eq('user_id', userId)
        .single();
    
    // Get student works (to know which quests have saved work)
    const { data: studentWorks } = await window.supabase
        .from('student_works')
        .select('quest_id, grading_status, title, image_url')
        .eq('user_id', userId);
    
    const completedQuests = progress?.completed_quests || {};
    const questGrades = progress?.quest_grades || {};
    const questAccepted = progress?.quest_accepted || {};
    
    // Detect which framework the teacher is using
    const framework = await loadTeacherFramework();
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
    // Create a map of quests that have saved work
    const savedWorksMap = new Map();
    if (studentWorks) {
        studentWorks.forEach(work => {
            savedWorksMap.set(work.quest_id, {
                grading_status: work.grading_status,
                title: work.title,
                hasImage: !!work.image_url
            });
        });
    }
    
    // Get all quests from quests.json
    const allQuests = await getQuests();
    
    // Get completed quest IDs
    const completedQuestList = Object.keys(completedQuests).filter(qid => completedQuests[qid] === true);
    
    // Get active quest IDs (accepted but NOT completed)
    const activeQuestList = [];
    for (const [questId, isAccepted] of Object.entries(questAccepted)) {
        if (isAccepted === true && !completedQuests[questId]) {
            activeQuestList.push(questId);
        }
    }
    
    // Get quests with saved work that are NOT accepted and NOT completed
    const pendingQuestList = [];
    for (const [questId, workInfo] of savedWorksMap) {
        if (!completedQuestList.includes(questId) && !activeQuestList.includes(questId)) {
            pendingQuestList.push(questId);
        }
    }
    
    // Combine all lists (completed, active, pending)
    const allDisplayQuests = [...new Set([...completedQuestList, ...activeQuestList, ...pendingQuestList])];
    
    if (allDisplayQuests.length === 0) {
        container.innerHTML = '<div class="no-data">No quests with saved work or completed quests yet</div>';
        return;
    }
    
    // Sort: Active first, then Pending, then Completed
    const sortedQuests = allDisplayQuests.sort((a, b) => {
        const aIsActive = activeQuestList.includes(a);
        const bIsActive = activeQuestList.includes(b);
        const aIsCompleted = completedQuestList.includes(a);
        const bIsCompleted = completedQuestList.includes(b);
        
        if (aIsActive && !bIsActive) return -1;
        if (!aIsActive && bIsActive) return 1;
        if (!aIsCompleted && bIsCompleted) return -1;
        if (aIsCompleted && !bIsCompleted) return 1;
        return 0;
    });
    
    container.innerHTML = '';
    
    // Add section headers
    if (activeQuestList.length > 0) {
        const activeHeader = document.createElement('div');
        activeHeader.className = 'quest-section-header';
        activeHeader.innerHTML = '<h3>🟢 Active Quests</h3><hr>';
        container.appendChild(activeHeader);
    }
    
    const template = document.getElementById('quest-item-template');
    let lastWasActive = true;
    let activeSectionEnded = false;
    
    for (const questId of sortedQuests) {
        const quest = allQuests[questId];
        if (!quest) continue;
        
        const isActive = activeQuestList.includes(questId);
        const isCompleted = completedQuestList.includes(questId);
        const hasSavedWork = savedWorksMap.has(questId);
        const workInfo = savedWorksMap.get(questId);
        
        // Add Pending section header when transitioning from Active to Pending
        if (!isActive && !activeSectionEnded && !isCompleted) {
            const pendingHeader = document.createElement('div');
            pendingHeader.className = 'quest-section-header';
            pendingHeader.innerHTML = '<h3>⏳ Pending Grading</h3><hr>';
            container.appendChild(pendingHeader);
            activeSectionEnded = true;
            lastWasActive = false;
        }
        
        // Add Completed section header when transitioning to Completed
        if (isCompleted && (lastWasActive || !activeSectionEnded)) {
            const completedHeader = document.createElement('div');
            completedHeader.className = 'quest-section-header';
            completedHeader.innerHTML = '<h3>✅ Completed & Graded</h3><hr>';
            container.appendChild(completedHeader);
            activeSectionEnded = true;
            lastWasActive = false;
        }
        
        const clone = template.content.cloneNode(true);
        const questDiv = clone.querySelector('.teacher-quest-item');
        questDiv.dataset.questId = questId;
        
        const titleSpan = clone.querySelector('.teacher-quest-title');
        titleSpan.textContent = quest.title || questId;
        
        // Determine status
        const column = quest.style === 'mvp' ? 'mvpGrade' : 'grade';
        const grades = questGrades[questId]?.[column] || {};
        const hasGrades = Object.keys(grades).length > 0;
        
        let statusText = '';
        let statusClass = '';
        let showRedDot = false;
        
        if (isActive) {
            statusText = '🟢 Active';
            statusClass = 'active';
            showRedDot = false;
        } else if (hasGrades) {
            statusText = '✓ Graded';
            statusClass = 'graded';
            showRedDot = false;
        } else if (hasSavedWork && workInfo?.grading_status === 'pending') {
            statusText = '⚠ Pending Grading';
            statusClass = 'pending';
            showRedDot = true;
        } else if (isCompleted) {
            statusText = '⚠ Not Graded';
            statusClass = 'ungraded';
            showRedDot = true;
        } else if (hasSavedWork) {
            statusText = '⚠ Pending Grading';
            statusClass = 'pending';
            showRedDot = true;
        } else {
            statusText = 'Not Started';
            statusClass = 'not-started';
            showRedDot = false;
        }
        
        const statusSpan = clone.querySelector('.teacher-quest-status');
        statusSpan.textContent = statusText;
        statusSpan.classList.add(statusClass);
        
        if (showRedDot) {
            const redDot = document.createElement('span');
            redDot.className = 'quest-pending-dot';
            redDot.innerHTML = '🔴';
            redDot.style.marginLeft = '8px';
            redDot.style.fontSize = '12px';
            redDot.title = 'Awaiting grading';
            statusSpan.appendChild(redDot);
        }
        
        const expandBtn = clone.querySelector('.teacher-expand-btn');
        const detailsDiv = clone.querySelector('.teacher-quest-details');
        
        expandBtn.addEventListener('click', () => {
            const isVisible = detailsDiv.style.display === 'block';
            detailsDiv.style.display = isVisible ? 'none' : 'block';
            expandBtn.textContent = isVisible ? '▼' : '▲';
            
            if (!isVisible) {
                loadRubricForQuest(questId, quest, questGrades, detailsDiv, userId);
            }
        });
        
        const viewWorkBtn = clone.querySelector('.teacher-view-work-btn');
        viewWorkBtn.addEventListener('click', () => {
            viewStudentWork(userId, questId);
        });
        
        // Delete button handler (works for both active and completed)
        const deleteBtn = clone.querySelector('.teacher-delete-quest-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                
                let statusText = isActive ? 'ACTIVE' : (isCompleted ? 'COMPLETED' : 'PENDING');
                
                const confirmDelete = confirm(
                    `⚠️ DELETE QUEST DATA\n\n` +
                    `Quest: ${quest.title || questId}\n` +
                    `Student: ${document.getElementById('selected-student-name').textContent}\n` +
                    `Status: ${statusText}\n\n` +
                    `This will permanently delete:\n` +
                    `• All grades for this quest\n` +
                    `• Student's artwork submission\n` +
                    `• Timer data for this quest\n\n` +
                    `This action cannot be undone.\n\n` +
                    `Click OK to delete.`
                );
                
                if (!confirmDelete) return;
                
                await deleteQuestData(userId, questId, quest);
                
                // Refresh the view
                await loadStudentProgressData(userId);
                await updateStudentCardPendingCount(userId);
            });
        }
        
        container.appendChild(clone);
        lastWasActive = isActive;
    }
}// Load rubric inside student's card
async function loadRubricForQuest(questId, quest, questGrades, detailsDiv, userId) {
    const rubricContainer = detailsDiv.querySelector('.teacher-rubric-container');
    
    if (!quest.rubric) {
        rubricContainer.innerHTML = '<p>No rubric available</p>';
        return;
    }
    
    // Get teacher's selected standards for this quest
    const auth = await checkTeacherAuth();
    let selectedStandards = null;
    
    if (auth) {
        const { data } = await window.supabase
            .from('teacher_quest_standards')
            .select('selected_standards')
            .eq('teacher_id', auth.teacher.id)
            .eq('quest_id', questId)
            .single();
        selectedStandards = data?.selected_standards;
    }
    
    // Check which format we have
    const isIB = quest.rubric.criteria && Array.isArray(quest.rubric.criteria);
    const isNCAS = quest.rubric.standards && Array.isArray(quest.rubric.standards);
    const isIGCSE = quest.rubric.assessment_objectives && Array.isArray(quest.rubric.assessment_objectives);
    
    let itemsToShow = [];
    let gradeLevels = [];
    let gradeInputMax = 0;
    let headerLabel = '';
    let inputType = 'number';
    
    if (isNCAS) {
        itemsToShow = quest.rubric.standards;
        gradeLevels = ['4', '3', '2', '1'];
        gradeInputMax = 4;
        headerLabel = 'Standard';
        inputType = 'number';
    } else if (isIB) {
        itemsToShow = quest.rubric.criteria;
        gradeLevels = ['7-8', '5-6', '3-4', '1-2'];
        gradeInputMax = 8;
        headerLabel = 'Criterion';
        inputType = 'number';
    } else if (isIGCSE) {
        itemsToShow = quest.rubric.assessment_objectives;
        gradeLevels = ['A*-A', 'B-C', 'D-E', 'F-G'];
        gradeInputMax = 8;
        headerLabel = 'Assessment Objective';
        inputType = 'text';
    }
    
    // Filter items based on selected standards
    if (selectedStandards && selectedStandards.length > 0) {
        itemsToShow = itemsToShow.filter(item => 
            selectedStandards.includes(item.code)
        );
    }
    
    if (itemsToShow.length === 0) {
        rubricContainer.innerHTML = '<p>No standards selected for this quest.</p>';
        return;
    }
    
    const column = quest.style === "mvp" ? "mvpGrade" : "grade";
    const grades = questGrades[questId]?.[column] || {};
    
    let html = `<table class="rubric-table">
        <thead>
            <tr>
                <th>${headerLabel}</th>
                <th>${gradeLevels[0]}</th>
                <th>${gradeLevels[1]}</th>
                <th>${gradeLevels[2]}</th>
                <th>${gradeLevels[3]}</th>
                <th>Grade</th>
            </tr>
        </thead>
        <tbody>`;
    
    itemsToShow.forEach(item => {
        const savedGrade = grades[item.code] || "";
        
        // For IGCSE, convert stored number to letter for display
        let displayValue = savedGrade;
        if (isIGCSE && savedGrade) {
            displayValue = convertNumberToLetterGrade(parseInt(savedGrade));
        }
        
        html += `<tr>
            <td><strong>${item.code}</strong>${!isNCAS ? `: ${item.name}` : ''}</td>
            <td>${item.levels[gradeLevels[0]] || ""}</td>
            <td>${item.levels[gradeLevels[1]] || ""}</td>
            <td>${item.levels[gradeLevels[2]] || ""}</td>
            <td>${item.levels[gradeLevels[3]] || ""}</td>
            <td>`;
        
        if (isIGCSE) {
            html += `<input type="text" value="${displayValue}" class="teacher-grade-input" 
                           data-standard="${item.code}" data-quest="${questId}" 
                           placeholder="A*-G" maxlength="2">`;
        } else {
            html += `<input type="number" step="0.5" min="1" max="${gradeInputMax}" value="${savedGrade}" 
                           class="teacher-grade-input" data-standard="${item.code}" data-quest="${questId}">`;
        }
        
        html += `</td>
            </tr>`;
    });
    
    html += `</tbody>
    证able
    <button class="teacher-save-grades-btn" data-quest="${questId}">Save Grades</button>`;
    
    rubricContainer.innerHTML = html;
    
    const saveBtn = rubricContainer.querySelector('.teacher-save-grades-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveTeacherGrades(questId, quest, userId, detailsDiv));
    }
}
// Save grades
async function saveTeacherGrades(questId, quest, userId, detailsDiv) {
    const inputs = detailsDiv.querySelectorAll('.teacher-grade-input');
    const grades = {};
    
    // Determine which format we have
    const isIB = quest.rubric && quest.rubric.criteria && Array.isArray(quest.rubric.criteria);
    const isIGCSE = quest.rubric && quest.rubric.assessment_objectives && Array.isArray(quest.rubric.assessment_objectives);
    const isNCAS = quest.rubric && quest.rubric.standards && Array.isArray(quest.rubric.standards);
    
    // Set max grade based on format
    let maxGrade = 4; // Default NCAS
    if (isIB) maxGrade = 8;
    if (isIGCSE) maxGrade = 8; // IGCSE stores numbers 1-8 internally
    
    inputs.forEach(input => {
        const standard = input.dataset.standard;
        let value = input.value;
        
        if (isIGCSE) {
            // For IGCSE: convert letter grade (A*-G) to number (1-8)
            const numValue = convertLetterGradeToNumber(value);
            if (numValue !== null) {
                grades[standard] = numValue;
            }
        } else {
            // For NCAS and IB: parse number input
            const numValue = parseFloat(value);
            if (!isNaN(numValue) && numValue >= 1 && numValue <= maxGrade) {
                grades[standard] = numValue;
            }
        }
    });
    
    const column = quest.style === "mvp" ? "mvpGrade" : "grade";
    
    // Get current progress
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests, earned_badges, quest_accepted, quest_start_times')
        .eq('user_id', userId)
        .single();
    
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    const existingBadges = progress?.earned_badges || {};
    let questAccepted = progress?.quest_accepted || {};
    let questStartTimes = progress?.quest_start_times || {};
    
    // Update grades
    if (!questGrades[questId]) questGrades[questId] = {};
    questGrades[questId][column] = grades;
    
    // Mark as completed (since we're saving grades)
    completedQuests[questId] = true;
    
    // Update database
    const { error } = await window.supabase
        .from('student_progress')
        .upsert({
            user_id: userId,
            quest_grades: questGrades,
            completed_quests: completedQuests,
            earned_badges: existingBadges,
            quest_accepted: questAccepted,
            quest_start_times: questStartTimes,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
    
    if (error) {
        alert('Error saving grades: ' + error.message);
        return;
    }
    
    // Update student_works grading_status
    await window.supabase
        .from('student_works')
        .update({ grading_status: 'graded' })
        .eq('user_id', userId)
        .eq('quest_id', questId);
    
    alert('Grades saved and quest marked as complete!');
    
    // Update status indicator
    const statusSpan = detailsDiv.closest('.teacher-quest-item').querySelector('.teacher-quest-status');
    if (statusSpan) {
        statusSpan.textContent = '✓ Graded';
        statusSpan.classList.remove('ungraded', 'pending');
        statusSpan.classList.add('graded');
        
        // Remove red dot if exists
        const redDot = statusSpan.querySelector('.quest-pending-dot');
        if (redDot) redDot.remove();
    }
    
    // Update student card red dot
    await updateStudentCardPendingCount(userId);
    
    // Refresh the view
    await loadStudentProgressData(userId);
}
// Add this helper function to update the student card red dot
async function updateStudentCardPendingCount(userId) {
    // Count remaining pending works for this student
    const { data: pendingWorks } = await window.supabase
        .from('student_works')
        .select('id')
        .eq('user_id', userId)
        .eq('grading_status', 'pending');
    
    const pendingCount = pendingWorks?.length || 0;
    
    // Find and update the student card
    const studentCard = document.querySelector(`.student-card[data-user-id="${userId}"]`);
    if (studentCard) {
        // Remove existing red dot
        const existingDot = studentCard.querySelector('.pending-dot');
        if (existingDot) existingDot.remove();
        
        // Add new red dot if there are pending works
        if (pendingCount > 0) {
            const redDot = document.createElement('span');
            redDot.className = 'pending-dot';
            redDot.title = `${pendingCount} quest${pendingCount !== 1 ? 's' : ''} pending grading`;
            studentCard.insertBefore(redDot, studentCard.firstChild);
        }
    }
}
// --------------------------------------------Quest Profile -----------------------------------------------------
// Open Quest Details panel
async function openQuestDetailsPanel(questId, allQuests) {
    console.log("openQuestDetailsPanel called with questId:", questId);
    console.log("allQuests has this quest?", allQuests[questId] ? "Yes" : "No");
    // Get filtered rubric for this teacher
    const filteredQuest = await getFilteredRubricForQuest(questId);
    const quest = filteredQuest;
    
    if (!quest) {
        console.error("Quest not found:", questId);
        return;
    }

    // Store current quest data
    currentQuestData = { id: questId, data: quest, allQuests: allQuests };
    
    // Set header title
    document.getElementById('quest-details-title').textContent = quest.title || questId;
    
    // Fill Quest Profile tab with filtered rubric
    document.getElementById('quest-profile-image').src = quest.character || 'profile.png';
    document.getElementById('quest-profile-title').textContent = quest.title || 'Untitled';
    
    let pathText = 'No path assigned';
    if (quest.path && Array.isArray(quest.path)) {
        pathText = quest.path.join(', ');
    } else if (quest.path) {
        pathText = quest.path;
    }
    document.getElementById('quest-profile-path').textContent = `Path: ${pathText}`;
    
    let difficultyText = 'Not specified';
    if (quest.difficulty) {
        const difficultyValue = Math.min(quest.difficulty, 3); // Cap at 3
        const emptyStars = Math.max(0, 3 - difficultyValue); // Ensure not negative
        const stars = '★'.repeat(difficultyValue) + '☆'.repeat(emptyStars);
        difficultyText = `${quest.difficulty}/3 ${stars}`;
}    document.getElementById('quest-profile-difficulty').textContent = `Difficulty: ${difficultyText}`;
    
    // Requirements
    const requirementsList = document.getElementById('quest-requirements-list');
    requirementsList.innerHTML = '';
    if (quest.requirements && Array.isArray(quest.requirements)) {
        quest.requirements.forEach(req => {
            const li = document.createElement('li');
            li.textContent = req;
            requirementsList.appendChild(li);
        });
    } else {
        requirementsList.innerHTML = '<li>No specific requirements</li>';
    }
    
// Rubric - Supports NCAS, IB, and IGCSE formats
const rubricContainer = document.getElementById('quest-rubric-container');
if (quest.rubric) {
    // Check which format we have
    const isIB = quest.rubric.criteria && Array.isArray(quest.rubric.criteria);
    const isNCAS = quest.rubric.standards && Array.isArray(quest.rubric.standards);
    const isIGCSE = quest.rubric.assessment_objectives && Array.isArray(quest.rubric.assessment_objectives);
    
    let rubricHtml = '';
    
    if (isNCAS && quest.rubric.standards.length > 0) {
        rubricHtml = `<table class="rubric-table">
            <thead>
                <tr><th>Standard</th><th>Grade 4</th><th>Grade 3</th><th>Grade 2</th><th>Grade 1</th></tr>
            </thead>
            <tbody>`;
        
        quest.rubric.standards.forEach(std => {
            rubricHtml += `<tr>
                <td>${std.code}${std.name ? `: ${std.name}` : ''}</td>
                <td>${std.levels["4"] || ""}</td>
                <td>${std.levels["3"] || ""}</td>
                <td>${std.levels["2"] || ""}</td>
                <td>${std.levels["1"] || ""}</td>
            </tr>`;
        });
        
        rubricHtml += `</tbody>
        </table>`;
    } else if (isIB && quest.rubric.criteria.length > 0) {
        rubricHtml = `<table class="rubric-table">
            <thead>
                <tr><th>Criterion</th><th>Grade 7-8</th><th>Grade 5-6</th><th>Grade 3-4</th><th>Grade 1-2</th></tr>
            </thead>
            <tbody>`;
        
        quest.rubric.criteria.forEach(criterion => {
            rubricHtml += `<tr>
                <td><strong>${criterion.code}</strong>: ${criterion.name}</td>
                <td>${criterion.levels["7-8"] || ""}</td>
                <td>${criterion.levels["5-6"] || ""}</td>
                <td>${criterion.levels["3-4"] || ""}</td>
                <td>${criterion.levels["1-2"] || ""}</td>
            </tr>`;
        });
        
        rubricHtml += `</tbody>
        </table>`;
    } else if (isIGCSE && quest.rubric.assessment_objectives.length > 0) {
        rubricHtml = `<table class="rubric-table">
            <thead>
                <tr><th>Assessment Objective</th><th>Grade A*-A</th><th>Grade B-C</th><th>Grade D-E</th><th>Grade F-G</th></tr>
            </thead>
            <tbody>`;
        
        quest.rubric.assessment_objectives.forEach(ao => {
            rubricHtml += `<tr>
                <td><strong>${ao.code}</strong>: ${ao.name}</td>
                <td>${ao.levels["A*-A"] || ""}</td>
                <td>${ao.levels["B-C"] || ""}</td>
                <td>${ao.levels["D-E"] || ""}</td>
                <td>${ao.levels["F-G"] || ""}</td>
            </tr>`;
        });
        
        rubricHtml += `</tbody>
        </table>`;
    } else {
        rubricHtml = '<p>No standards, criteria, or assessment objectives selected for this quest. Please go to the "Select Standards" tab to choose which items to assess.</p>';
    }
    
    rubricContainer.innerHTML = rubricHtml;
} else {
    rubricContainer.innerHTML = '<p>No rubric available for this quest.</p>';
}
    
// Rationale
const rationaleElement = document.getElementById('quest-rationale-text');
if (quest.rationale) {
    rationaleElement.innerHTML = quest.rationale;
} else {
    rationaleElement.innerHTML = 'No rationale provided.';
}    

// Make sure profile tab is visible
document.getElementById('quest-profile-tab').style.display = 'block';
document.getElementById('quest-prerequisites-tab').style.display = 'none';
document.getElementById('quest-standards-tab').style.display = 'none';
document.getElementById('quest-students-tab').style.display = 'none';

// Reset active tab button
document.querySelectorAll('#quest-details-panel .quest-tab-btn').forEach(btn => {
    btn.classList.remove('active');
});
document.querySelector('#quest-details-panel .quest-tab-btn[data-quest-tab="profile"]')?.classList.add('active');

// Load prerequisites data
loadPrerequisitesAndLeadsTo(questId, allQuests);

// Show the panel
document.getElementById('quest-details-panel').style.display = 'block';
}
// Close quest details panel
function closeQuestDetailsPanel() {
    document.getElementById('quest-details-panel').style.display = 'none';
}
// Setup quest details tab switching
function setupQuestDetailsTabs() {
    const tabsContainer = document.querySelector('#quest-details-panel .teacher-tabs');
    if (!tabsContainer) return;
    
    tabsContainer.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.quest-tab-btn');
        if (!tabBtn) return;
        
        const tabId = tabBtn.dataset.questTab;
        console.log("Tab clicked:", tabId);
        
        const profileTab = document.getElementById('quest-profile-tab');
        const prereqTab = document.getElementById('quest-prerequisites-tab');
        const standardsTab = document.getElementById('quest-standards-tab');  // NEW
        const studentsTab = document.getElementById('quest-students-tab');
        
        document.querySelectorAll('#quest-details-panel .quest-tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        tabBtn.classList.add('active');
        
        if (profileTab) profileTab.style.display = 'none';
        if (prereqTab) prereqTab.style.display = 'none';
        if (standardsTab) standardsTab.style.display = 'none';  // NEW
        if (studentsTab) studentsTab.style.display = 'none';
        
        if (tabId === 'profile') {
            if (profileTab) profileTab.style.display = 'block';
        } else if (tabId === 'prerequisites') {
            if (prereqTab) {
                prereqTab.style.display = 'block';
                if (currentQuestData) {
                    loadPrerequisitesAndLeadsTo(currentQuestData.id, currentQuestData.allQuests);
                }
            }
        } else if (tabId === 'standards') {  // NEW
            if (standardsTab) {
                standardsTab.style.display = 'block';
                if (currentQuestData) {
                    renderStandardsSelectionTab(currentQuestData.id);
                }
            }
        } else if (tabId === 'students') {
            if (studentsTab) {
                studentsTab.style.display = 'block';
                if (currentQuestData) {
                    loadActiveStudentsForQuest(currentQuestData.id);
                }
            }
        }
    });
}
// Setup quest details close button
function setupQuestDetailsClose() {
    const closeBtn = document.getElementById('close-quest-details-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeQuestDetailsPanel);
    }
}
function loadPrerequisitesAndLeadsTo(questId, allQuests) {
    const quest = allQuests[questId];
    
    // Wait a tiny bit to ensure the tab is visible
    setTimeout(() => {
        const prerequisitesList = document.getElementById('prerequisites-list');
        const leadsToList = document.getElementById('leads-to-list');
        
        console.log("prerequisites-list element:", prerequisitesList);
        console.log("leads-to-list element:", leadsToList);
        
        if (!prerequisitesList) {
            console.error("prerequisites-list not found!");
            return;
        }
        
        // Get prerequisites
        const prerequisites = [];
        if (quest.prerequisites && Array.isArray(quest.prerequisites)) {
            quest.prerequisites.forEach(prereqId => {
                if (allQuests[prereqId]) {
                    prerequisites.push({
                        id: prereqId,
                        title: allQuests[prereqId].title
                    });
                }
            });
        }
        
        // Get leads to
        const leadsTo = [];
        for (const [id, q] of Object.entries(allQuests)) {
            if (q.prerequisites && Array.isArray(q.prerequisites) && q.prerequisites.includes(questId)) {
                leadsTo.push({
                    id: id,
                    title: q.title
                });
            }
        }
        
        console.log("Prerequisites found:", prerequisites.length);
        console.log("Leads to found:", leadsTo.length);
        
        // Render prerequisites
        prerequisitesList.innerHTML = '';
        if (prerequisites.length === 0) {
            prerequisitesList.innerHTML = '<div class="prerequisite-link">No prerequisites required</div>';
        } else {
            prerequisites.forEach(prereq => {
                const link = document.createElement('div');
                link.className = 'prerequisite-link';
                link.textContent = prereq.title;
                link.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const freshQuests = await getQuests();
                    openQuestDetailsPanel(prereq.id, freshQuests);
                });
                prerequisitesList.appendChild(link);
            });
        }
        
        // Render leads to
        leadsToList.innerHTML = '';
        if (leadsTo.length === 0) {
            leadsToList.innerHTML = '<div class="leads-to-link">This quest does not lead to any other quests</div>';
        } else {
            leadsTo.forEach(lead => {
                const link = document.createElement('div');
                link.className = 'leads-to-link';
                link.textContent = lead.title;
                link.addEventListener('click', async (e) => {
                    e.stopPropagation();
                const freshQuests = await getQuests();
                openQuestDetailsPanel(lead.id, freshQuests);
                });
                leadsToList.appendChild(link);
            });
        }
    }, 50);
}
// Load active and completed students for a quest
async function loadActiveStudentsForQuest(questId) {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    const activeContainer = document.getElementById('active-students-list');
    const completedContainer = document.getElementById('completed-students-list');
    
    if (!activeContainer || !completedContainer) return;
    
    // Get all students for this teacher
    const { data: students } = await window.supabase
        .from('profiles')
        .select('*')
        .eq('teacher_code', auth.teacher.class_code);
    
    if (!students || students.length === 0) {
        activeContainer.innerHTML = '<div class="no-data">No students found</div>';
        completedContainer.innerHTML = '<div class="no-data">No students found</div>';
        return;
    }
    
    // Get progress data for all students
    const studentIds = students.map(s => s.id);
    const { data: progressData } = await window.supabase
        .from('student_progress')
        .select('user_id, completed_quests, quest_accepted')
        .in('user_id', studentIds);
    
    const progressMap = new Map();
    if (progressData) {
        progressData.forEach(p => {
            progressMap.set(p.user_id, p);
        });
    }
    
    const activeStudents = [];
    const completedStudents = [];
    
    for (const student of students) {
        const progress = progressMap.get(student.id);
        const completedQuests = progress?.completed_quests || {};
        const questAccepted = progress?.quest_accepted || {};
        
        if (completedQuests[questId] === true) {
            completedStudents.push(student);
        } else if (questAccepted[questId] === true) {
            activeStudents.push(student);
        }
    }
    
    // Render active students
    if (activeStudents.length === 0) {
        activeContainer.innerHTML = '<div class="no-data">No active students for this quest</div>';
    } else {
        activeContainer.innerHTML = '';
        activeStudents.forEach(student => {
            const card = document.createElement('div');
            card.className = 'quest-student-card';
            card.innerHTML = `
                <img src="${student.avatar_url || 'profile.png'}" alt="${student.name}">
                <span class="quest-student-name">${escapeHtml(student.name)}</span>
            `;
            card.addEventListener('click', () => {
                closeQuestDetailsPanel();
                loadStudentDetails(student.id, student.name);
            });
            activeContainer.appendChild(card);
        });
    }
    
    // Render completed students
    if (completedStudents.length === 0) {
        completedContainer.innerHTML = '<div class="no-data">No completed students for this quest</div>';
    } else {
        completedContainer.innerHTML = '';
        completedStudents.forEach(student => {
            const card = document.createElement('div');
            card.className = 'quest-student-card';
            card.innerHTML = `
                <img src="${student.avatar_url || 'profile.png'}" alt="${student.name}">
                <span class="quest-student-name">${escapeHtml(student.name)}</span>
            `;
            card.addEventListener('click', () => {
                closeQuestDetailsPanel();
                loadStudentDetails(student.id, student.name);
            });
            completedContainer.appendChild(card);
        });
    }
}
// Load teacher's saved standards for a specific quest
async function loadTeacherQuestStandards(questId) {
    const auth = await checkTeacherAuth();
    if (!auth) return null;
    
    const { data, error } = await window.supabase
        .from('teacher_quest_standards')
        .select('selected_standards')
        .eq('teacher_id', auth.teacher.id)
        .eq('quest_id', questId)
        .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        console.error("Error loading standards override:", error);
    }
    
    return data?.selected_standards || null;
}
// Save teacher's standards selection for a quest
async function saveTeacherQuestStandards(questId, selectedStandards) {
    const auth = await checkTeacherAuth();
    if (!auth) return false;
    
    const { error } = await window.supabase
        .from('teacher_quest_standards')
        .upsert({
            teacher_id: auth.teacher.id,
            quest_id: questId,
            selected_standards: selectedStandards,
            updated_at: new Date().toISOString()
        }, { onConflict: 'teacher_id, quest_id' });
    
    if (error) {
        console.error("Error saving standards:", error);
        alert("Error saving standards: " + error.message);
        return false;
    }
    
    return true;
}
// Delete teacher's standards selection (reset to all standards)
async function resetTeacherQuestStandards(questId) {
    const auth = await checkTeacherAuth();
    if (!auth) return false;
    
    const { error } = await window.supabase
        .from('teacher_quest_standards')
        .delete()
        .eq('teacher_id', auth.teacher.id)
        .eq('quest_id', questId);
    
    if (error) {
        console.error("Error resetting standards:", error);
        alert("Error resetting standards: " + error.message);
        return false;
    }
    
    return true;
}
// Get filtered rubric for a quest (respects teacher's selections)
async function getFilteredRubricForQuest(questId, teacherId = null) {
    // Use getAllQuestsForTeacher to include custom quests
    const allQuests = await getAllQuestsForTeacher();
    const quest = allQuests[questId];
    
    if (!quest || !quest.rubric) {
        return quest;
    }
    
    // Check which format we have
    const hasStandards = quest.rubric.standards && Array.isArray(quest.rubric.standards);
    const hasCriteria = quest.rubric.criteria && Array.isArray(quest.rubric.criteria);
    const hasAssessmentObjectives = quest.rubric.assessment_objectives && Array.isArray(quest.rubric.assessment_objectives);
    
    if (!hasStandards && !hasCriteria && !hasAssessmentObjectives) {
        return quest;
    }
    
    // If no teacherId provided, try to get current teacher
    if (!teacherId) {
        const auth = await checkTeacherAuth();
        if (!auth) return quest;
        teacherId = auth.teacher.id;
    }
    
    // Load saved selections
    const { data } = await window.supabase
        .from('teacher_quest_standards')
        .select('selected_standards')
        .eq('teacher_id', teacherId)
        .eq('quest_id', questId)
        .single();
    
    if (data?.selected_standards && data.selected_standards.length > 0) {
        if (hasStandards) {
            const filteredStandards = quest.rubric.standards.filter(std => 
                data.selected_standards.includes(std.code)
            );
            return {
                ...quest,
                rubric: {
                    ...quest.rubric,
                    standards: filteredStandards
                }
            };
        } else if (hasCriteria) {
            const filteredCriteria = quest.rubric.criteria.filter(criterion => 
                data.selected_standards.includes(criterion.code)
            );
            return {
                ...quest,
                rubric: {
                    ...quest.rubric,
                    criteria: filteredCriteria
                }
            };
        } else if (hasAssessmentObjectives) {
            const filteredAOs = quest.rubric.assessment_objectives.filter(ao => 
                data.selected_standards.includes(ao.code)
            );
            return {
                ...quest,
                rubric: {
                    ...quest.rubric,
                    assessment_objectives: filteredAOs
                }
            };
        }
    }
    
    return quest;
}
// Render the Standard Sellecting Tab
async function renderStandardsSelectionTab(questId) {
    const container = document.getElementById('standards-checkbox-list');
    if (!container) return;
    
    const allQuests = await getAllQuestsForTeacher();
    const quest = allQuests[questId];
    
    if (!quest || !quest.rubric) {
        container.innerHTML = '<p>No rubric found for this quest.</p>';
        return;
    }
    
    // Check which framework structure we're using
    const isIB = quest.rubric.criteria && Array.isArray(quest.rubric.criteria);
    const isNCAS = quest.rubric.standards && Array.isArray(quest.rubric.standards);
    const isIGCSE = quest.rubric.assessment_objectives && Array.isArray(quest.rubric.assessment_objectives);
    
    let itemsToShow = [];
    let gradeLevels = [];
    let headerLabel = '';
    
    if (isIB) {
        itemsToShow = quest.rubric.criteria;
        gradeLevels = ['7-8', '5-6', '3-4', '1-2'];
        headerLabel = 'Criterion';
    } else if (isNCAS) {
        itemsToShow = quest.rubric.standards;
        gradeLevels = ['4', '3', '2', '1'];
        headerLabel = 'Standard';
    } else if (isIGCSE) {
        itemsToShow = quest.rubric.assessment_objectives;
        gradeLevels = ['A*-A', 'B-C', 'D-E', 'F-G'];
        headerLabel = 'Assessment Objective';
    } else {
        container.innerHTML = '<p>No standards, criteria, or assessment objectives found for this quest.</p>';
        return;
    }
    
    // Load saved selections
    const savedStandards = await loadTeacherQuestStandards(questId);
    
    // START BUILDING THE TABLE
    let tableHtml = `
        <table class="rubric-table standards-selection-table">
            <thead>
                <tr>
                    <th style="width: 50px;">✓</th>
                    <th>${headerLabel}</th>
                    <th>${gradeLevels[0]}</th>
                    <th>${gradeLevels[1]}</th>
                    <th>${gradeLevels[2]}</th>
                    <th>${gradeLevels[3]}</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // ADD ALL ROWS INSIDE THE LOOP
    for (const item of itemsToShow) {
        const itemCode = item.code;
        const isChecked = savedStandards ? savedStandards.includes(itemCode) : true;
        
        const level1Value = item.levels?.[gradeLevels[0]] || '';
        const level2Value = item.levels?.[gradeLevels[1]] || '';
        const level3Value = item.levels?.[gradeLevels[2]] || '';
        const level4Value = item.levels?.[gradeLevels[3]] || '';
        
        tableHtml += `
            <tr class="standard-select-row" data-standard="${itemCode}">
                <td style="text-align: center;">
                    <input type="checkbox" class="standard-select-checkbox" value="${itemCode}" ${isChecked ? 'checked' : ''}>
                </td>
                <td class="standard-code-cell"><strong>${escapeHtml(itemCode)}: ${escapeHtml(item.name || '')}</strong></td>
                <td><input type="text" class="grade-level-input" data-standard="${itemCode}" data-level="${gradeLevels[0]}" value="${escapeHtml(level1Value)}" placeholder="Grade ${gradeLevels[0]} description" style="width: 100%; padding: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,215,0,0.3); border-radius: 4px; color: white;"></td>
                <td><input type="text" class="grade-level-input" data-standard="${itemCode}" data-level="${gradeLevels[1]}" value="${escapeHtml(level2Value)}" placeholder="Grade ${gradeLevels[1]} description" style="width: 100%; padding: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,215,0,0.3); border-radius: 4px; color: white;"></td>
                <td><input type="text" class="grade-level-input" data-standard="${itemCode}" data-level="${gradeLevels[2]}" value="${escapeHtml(level3Value)}" placeholder="Grade ${gradeLevels[2]} description" style="width: 100%; padding: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,215,0,0.3); border-radius: 4px; color: white;"></td>
                <td><input type="text" class="grade-level-input" data-standard="${itemCode}" data-level="${gradeLevels[3]}" value="${escapeHtml(level4Value)}" placeholder="Grade ${gradeLevels[3]} description" style="width: 100%; padding: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,215,0,0.3); border-radius: 4px; color: white;"></td>
            </tr>
        `;
    }
    
    // CLOSE THE TABLE AFTER THE LOOP
    tableHtml += `
            </tbody>
        </table>
    `;
    
    container.innerHTML = tableHtml;
    
    // Add visual feedback when checkboxes are clicked
    document.querySelectorAll('.standard-select-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const row = e.target.closest('.standard-select-row');
            if (row) {
                if (e.target.checked) {
                    row.style.opacity = '1';
                    row.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
                } else {
                    row.style.opacity = '0.6';
                    row.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
                }
            }
        });
        
        // Set initial style
        const row = cb.closest('.standard-select-row');
        if (row && !cb.checked) {
            row.style.opacity = '0.6';
            row.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
        }
    });
    
    // Save Standards Button
    const saveStandardsBtn = document.getElementById('save-standards-btn');
    if (saveStandardsBtn) {
        const newSaveBtn = saveStandardsBtn.cloneNode(true);
        saveStandardsBtn.parentNode.replaceChild(newSaveBtn, saveStandardsBtn);
        
        newSaveBtn.addEventListener('click', async () => {
            const checkboxes = document.querySelectorAll('#standards-checkbox-list .standard-select-checkbox');
            const selectedStandards = [];
            checkboxes.forEach(cb => {
                if (cb.checked) selectedStandards.push(cb.value);
            });
            
            if (selectedStandards.length === 0) {
                alert("You must select at least one standard/criterion/assessment objective for this quest.");
                return;
            }
            
            // Collect rubric text from inputs
            const inputs = document.querySelectorAll('#standards-checkbox-list .grade-level-input');
            const rubricText = {};
            inputs.forEach(input => {
                const standard = input.dataset.standard;
                const level = input.dataset.level;
                if (!rubricText[standard]) rubricText[standard] = {};
                rubricText[standard][level] = input.value;
            });
            
            // Update the rubric in the database for custom quests
            const auth = await checkTeacherAuth();
            if (auth && quest.is_custom === true) {
                const { data: questData } = await window.supabase
                    .from('teacher_custom_quests')
                    .select('rubric')
                    .eq('quest_id', questId)
                    .single();
                
                if (questData) {
                    const updatedRubric = questData.rubric;
                    
                    if (updatedRubric.standards) {
                        updatedRubric.standards.forEach(standard => {
                            if (rubricText[standard.code]) {
                                Object.assign(standard.levels, rubricText[standard.code]);
                            }
                        });
                    } else if (updatedRubric.criteria) {
                        updatedRubric.criteria.forEach(criterion => {
                            if (rubricText[criterion.code]) {
                                Object.assign(criterion.levels, rubricText[criterion.code]);
                            }
                        });
                    } else if (updatedRubric.assessment_objectives) {
                        updatedRubric.assessment_objectives.forEach(ao => {
                            if (rubricText[ao.code]) {
                                Object.assign(ao.levels, rubricText[ao.code]);
                            }
                        });
                    }
                    
                    const { error } = await window.supabase
                        .from('teacher_custom_quests')
                        .update({ rubric: updatedRubric })
                        .eq('quest_id', questId);
                    
                    if (error) {
                        console.error("Error saving rubric:", error);
                        alert("Error saving rubric: " + error.message);
                        return;
                    }
                }
            }
            
            const success = await saveTeacherQuestStandards(questId, selectedStandards);
            if (success) {
                alert(`${selectedStandards.length} item(s) saved!`);
                const allQuestsFresh = await getAllQuestsForTeacher();
                openQuestDetailsPanel(questId, allQuestsFresh);
            }
        });
    }
    
    // Reset Standards Button
    const resetStandardsBtn = document.getElementById('reset-standards-btn');
    if (resetStandardsBtn) {
        const newResetBtn = resetStandardsBtn.cloneNode(true);
        resetStandardsBtn.parentNode.replaceChild(newResetBtn, resetStandardsBtn);
        
        newResetBtn.addEventListener('click', async () => {
            if (confirm("Reset to all standards/criteria/assessment objectives? This will restore everything.")) {
                const success = await resetTeacherQuestStandards(questId);
                if (success) {
                    alert("Reset to all items.");
                    await renderStandardsSelectionTab(questId);
                    const allQuestsFresh = await getAllQuestsForTeacher();
                    openQuestDetailsPanel(questId, allQuestsFresh);
                }
            }
        });
    }
}
// Show message in framework selector
function showFrameworkMessage(message, type) {
    const messageDiv = document.getElementById('framework-message');
    if (messageDiv) {
        messageDiv.textContent = message;
        messageDiv.className = `framework-message ${type}`;
        setTimeout(() => {
            messageDiv.textContent = '';
            messageDiv.className = 'framework-message';
        }, 5000);
    }
}
// Delete all grading data when framework changes
async function deleteAllGradingData() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    console.log("Deleting all grading data for framework change...");
    
    // Get all students
    const { data: students } = await window.supabase
        .from('profiles')
        .select('id')
        .eq('teacher_code', auth.teacher.class_code);
    
    if (!students || students.length === 0) return;
    
    const studentIds = students.map(s => s.id);
    
    // Delete all student_progress data (grades, completed quests, badges, timers)
    const { error: progressError } = await window.supabase
        .from('student_progress')
        .delete()
        .in('user_id', studentIds);
    
    if (progressError) {
        console.error("Error deleting progress:", progressError);
    }
    
    // Reset all student_works to pending (keep artwork, but reset grading status)
    const { error: worksError } = await window.supabase
        .from('student_works')
        .update({ grading_status: 'pending' })
        .in('user_id', studentIds);
    
    if (worksError) {
        console.error("Error resetting works:", worksError);
    }
    
    console.log("All grading data deleted");
}
// Password verification function
async function verifyTeacherPassword() {
    if (!currentTeacherEmail) {
        alert("Session error. Please log in again.");
        return false;
    }
    
    return new Promise((resolve) => {
        const modal = document.getElementById('password-verify-modal');
        const input = document.getElementById('verify-password-input');
        const confirmBtn = document.getElementById('verify-confirm-btn');
        const cancelBtn = document.getElementById('verify-cancel-btn');
        const closeBtn = document.querySelector('.password-verify-close');
        
        input.value = '';
        modal.style.display = 'flex';
        input.focus();
        
        const cleanup = () => {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            closeBtn.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', escHandler);
        };
        
        const handleConfirm = async () => {
            const password = input.value;
            if (!password) {
                alert("Please enter your password.");
                input.focus();
                return;
            }
            
            const { error } = await window.supabase.auth.signInWithPassword({
                email: currentTeacherEmail,
                password: password
            });
            
            if (error) {
                alert("Incorrect password. Please try again.");
                input.value = '';
                input.focus();
                return;
            }
            
            cleanup();
            resolve(true);
        };
        
        const handleCancel = () => {
            cleanup();
            resolve(false);
        };
        
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };
        
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        closeBtn.addEventListener('click', handleCancel);
        document.addEventListener('keydown', escHandler);
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        });
        
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleConfirm();
            }
        });
    });
}

// ----------------------------------Custom Quest Modal Functions--------------------------------------------------
// Open create custom quest modal
async function openCreateCustomQuestModal() {
    // Check if teacher has reached the limit (max 5 custom quests)
    const canCreate = await canCreateCustomQuest();
    if (!canCreate) {
        alert("You have reached the maximum of 5 custom quests. Delete an existing custom quest to create a new one.");
        return;
    }
    
    // Clear form
    document.getElementById('custom-quest-title').value = '';
    document.getElementById('custom-quest-path').value = 'Painter Path';
    document.getElementById('custom-quest-difficulty').value = '1';
    document.getElementById('custom-quest-rationale').value = '';
    document.getElementById('custom-quest-description').value = '';
    
    // Reset requirements list to one empty row
    const requirementsContainer = document.getElementById('custom-quest-requirements-list');
    requirementsContainer.innerHTML = `
        <div class="requirement-item">
            <input type="text" class="requirement-input" placeholder="Requirement">
            <button type="button" class="remove-requirement-btn">✖</button>
        </div>
    `;
    
    // Reset links list to one empty row
    const linksContainer = document.getElementById('custom-quest-links-list');
    linksContainer.innerHTML = `
        <div class="link-item">
            <input type="text" class="link-type" placeholder="Type (e.g., Video sample)">
            <input type="url" class="link-url" placeholder="URL">
            <button type="button" class="remove-link-btn">✖</button>
        </div>
    `;
    
    // Clear message
    document.getElementById('custom-quest-message').innerHTML = '';
    
    // Show modal
    document.getElementById('create-custom-quest-modal').style.display = 'flex';
}
// Check if teacher can create more custom quests (max 5)
async function canCreateCustomQuest() {
    const auth = await checkTeacherAuth();
    if (!auth) return false;
    
    const { count, error } = await window.supabase
        .from('teacher_custom_quests')
        .select('*', { count: 'exact', head: true })
        .eq('teacher_id', auth.teacher.id)
        .eq('deleted', false);
    
    if (error) {
        console.error("Error checking custom quest count:", error);
        return true; // Allow if error (fail open)
    }
    
    const MAX_CUSTOM_QUESTS = 5;
    return count < MAX_CUSTOM_QUESTS;
}
// Get current custom quest count
async function updateCustomQuestCountDisplay() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    const { count, error } = await window.supabase
        .from('teacher_custom_quests')
        .select('*', { count: 'exact', head: true })
        .eq('teacher_id', auth.teacher.id)
        .eq('deleted', false);
    
    if (!error) {
        const maxQuests = 5;
        const remaining = maxQuests - count;
        
        // You can display this somewhere if you want
        console.log(`Custom quests: ${count}/${maxQuests} used, ${remaining} remaining`);
    }
}
// Save custom quest to database
async function saveCustomQuest() {
    // Collect form data
    const title = document.getElementById('custom-quest-title').value.trim();
    const path = document.getElementById('custom-quest-path').value;
    const difficulty = parseInt(document.getElementById('custom-quest-difficulty').value);
    const rationale = document.getElementById('custom-quest-rationale').value.trim();
    const description = document.getElementById('custom-quest-description').value.trim();
    
    // Validate required fields
    if (!title) {
        showCustomQuestMessage("Please enter a quest title.", "error");
        return;
    }
    if (!rationale) {
        showCustomQuestMessage("Please enter a rationale.", "error");
        return;
    }
    if (!description) {
        showCustomQuestMessage("Please enter a description.", "error");
        return;
    }
    
    // Collect requirements
    const requirementInputs = document.querySelectorAll('.requirement-input');
    const requirements = [];
    requirementInputs.forEach(input => {
        const value = input.value.trim();
        if (value) requirements.push(value);
    });
    
    if (requirements.length === 0) {
        showCustomQuestMessage("Please add at least one requirement.", "error");
        return;
    }
    
    // Collect links
    const linkTypeInputs = document.querySelectorAll('.link-type');
    const linkUrlInputs = document.querySelectorAll('.link-url');
    const links = [];
    for (let i = 0; i < linkTypeInputs.length; i++) {
        const type = linkTypeInputs[i].value.trim();
        const url = linkUrlInputs[i].value.trim();
        if (type && url) {
            links.push({ type: type, url: url });
        }
    }
    
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    // Verify teacher password
    const passwordValid = await verifyTeacherPassword();
    if (!passwordValid) {
        showCustomQuestMessage("Password verification failed. Quest not created.", "error");
        return;
    }
    
    // Check limit again before saving
    const canCreate = await canCreateCustomQuest();
    if (!canCreate) {
        showCustomQuestMessage("You have reached the maximum of 5 custom quests.", "error");
        return;
    }
    
    // Get current count to determine which image to use
    const { count } = await window.supabase
        .from('teacher_custom_quests')
        .select('*', { count: 'exact', head: true })
        .eq('teacher_id', auth.teacher.id)
        .eq('deleted', false);
    
    // Define images for each custom quest slot
    const customImages = [
        "charimage/custom1.gif",
        "charimage/custom2.gif",
        "charimage/custom3.gif",
        "charimage/custom4.gif",
        "charimage/custom5.gif"
    ];
    
    const imageIndex = count; // 0, 1, 2, 3, or 4
    const customImage = customImages[imageIndex] || "charimage/teacher_quest.png";
    
    // Generate unique quest ID
    const timestamp = Date.now();
    const questId = `custom_${auth.teacher.id.substring(0, 8)}_${timestamp}`;
    
    // Get current framework for rubric structure
    const framework = await loadTeacherFramework();
    
    // Create base rubric structure based on framework
    let rubric = null;
    if (framework === 'ib-myp') {
        rubric = {
            overall: title,
            criteria: [
                { code: "A", name: "Knowing & Understanding", levels: { "7-8": "", "5-6": "", "3-4": "", "1-2": "" } },
                { code: "B", name: "Developing Skills", levels: { "7-8": "", "5-6": "", "3-4": "", "1-2": "" } },
                { code: "C", name: "Thinking Creatively", levels: { "7-8": "", "5-6": "", "3-4": "", "1-2": "" } },
                { code: "D", name: "Responding", levels: { "7-8": "", "5-6": "", "3-4": "", "1-2": "" } }
            ]
        };
    } else if (framework === 'igcse') {
        rubric = {
            overall: title,
            assessment_objectives: [
                { code: "AO1", name: "Record", levels: { "A*-A": "", "B-C": "", "D-E": "", "F-G": "" } },
                { code: "AO2", name: "Explore & Select", levels: { "A*-A": "", "B-C": "", "D-E": "", "F-G": "" } },
                { code: "AO3", name: "Develop", levels: { "A*-A": "", "B-C": "", "D-E": "", "F-G": "" } },
                { code: "AO4", name: "Present", levels: { "A*-A": "", "B-C": "", "D-E": "", "F-G": "" } }
            ]
        };
    } else {
        // NCAS
        rubric = {
            overall: title,
            standards: [
                { code: "Art.FA.CR.1.1.IA", name: "Generate", levels: { "4": "", "3": "", "2": "", "1": "" } },
                { code: "Art.FA.CR.1.2.IA", name: "Practice", levels: { "4": "", "3": "", "2": "", "1": "" } },
                { code: "Art.FA.CR.2.1.IA", name: "Explore", levels: { "4": "", "3": "", "2": "", "1": "" } },
                { code: "Art.FA.CR.2.3.IA", name: "Transform", levels: { "4": "", "3": "", "2": "", "1": "" } },
                { code: "Art.FA.CR.3.1.IA", name: "Reflect", levels: { "4": "", "3": "", "2": "", "1": "" } },
                { code: "Art.FA.PR.6.1.IA", name: "Analyze", levels: { "4": "", "3": "", "2": "", "1": "" } },
                { code: "Art.FA.RE.8.1.8A", name: "Interpret", levels: { "4": "", "3": "", "2": "", "1": "" } },
                { code: "Art.FA.CN.10.1.IA", name: "Document", levels: { "4": "", "3": "", "2": "", "1": "" } }
            ]
        };
    }
    
    // Show loading
    const saveBtn = document.getElementById('save-custom-quest-btn');
    const originalText = saveBtn.textContent;
    saveBtn.textContent = 'Creating...';
    saveBtn.disabled = true;
    
    try {
        // Insert into database
        const { error } = await window.supabase
            .from('teacher_custom_quests')
            .insert({
                teacher_id: auth.teacher.id,
                quest_id: questId,
                title: title,
                rationale: rationale,
                description: description,
                requirements: requirements,
                links: links,
                difficulty: difficulty,
                path: path,
                rubric: rubric,
                selected_standards: [],
                character: customImage,
                created_at: new Date().toISOString()
            });
        
        if (error) {
            console.error("Error saving custom quest:", error);
            showCustomQuestMessage("Error creating quest: " + error.message, "error");
        } else {
            showCustomQuestMessage(`✅ Custom quest "${title}" created successfully!`, "success");
            
            // Close modal after 2 seconds
            setTimeout(() => {
                document.getElementById('create-custom-quest-modal').style.display = 'none';
                // Refresh quest lists
                renderAllQuestAccordions();
                updateCustomQuestCountDisplay();
            }, 2000);
        }
    } catch (error) {
        console.error("Error:", error);
        showCustomQuestMessage("An error occurred. Please try again.", "error");
    } finally {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }
}
// Show message in custom quest modal
function showCustomQuestMessage(message, type) {
    const messageDiv = document.getElementById('custom-quest-message');
    messageDiv.textContent = message;
    messageDiv.className = `settings-message ${type}`;
    setTimeout(() => {
        messageDiv.textContent = '';
        messageDiv.className = 'settings-message';
    }, 5000);
}

// Delete (soft delete) a custom quest
async function deleteCustomQuest(questId, questTitle) {
    const confirmDelete = confirm(`Delete custom quest "${questTitle}"?\n\nStudent grades and artwork will be preserved (archived).\n\nThis action can be undone by restoring the quest later.`);
    if (!confirmDelete) return;
    
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    // Verify teacher password
    const passwordValid = await verifyTeacherPassword();
    if (!passwordValid) {
        alert("Password verification failed. Quest not deleted.");
        return;
    }
    
    const { error } = await window.supabase
        .from('teacher_custom_quests')
        .update({ deleted: true, deleted_at: new Date().toISOString() })
        .eq('quest_id', questId)
        .eq('teacher_id', auth.teacher.id);
    
    if (error) {
        console.error("Error deleting quest:", error);
        alert("Error deleting quest: " + error.message);
    } else {
        alert(`✅ Quest "${questTitle}" has been archived. Student data preserved.`);
        // Refresh quest lists
        renderAllQuestAccordions();
        updateCustomQuestCountDisplay();
    }
}

// Load teacher's custom quests from database
async function loadTeacherCustomQuests() {
    const auth = await checkTeacherAuth();
    if (!auth) return [];
    
    const { data, error } = await window.supabase
        .from('teacher_custom_quests')
        .select('*')
        .eq('teacher_id', auth.teacher.id)
        .eq('deleted', false);
    
    if (error) {
        console.error("Error loading custom quests:", error);
        return [];
    }
    
    return data || [];
}
// Get all quests including custom quests (for teacher view)
async function getAllQuestsForTeacher() {
    // Get base quests from cached JSON
    const baseQuests = await getQuests();
    const customQuests = await loadTeacherCustomQuests();
    
    // Convert custom quests to quest format
    const allQuests = { ...baseQuests };
    
    for (const custom of customQuests) {
        allQuests[custom.quest_id] = {
            path: [custom.path],
            difficulty: custom.difficulty,
            title: custom.title,
            rationale: custom.rationale,
            description: custom.description,
            requirements: custom.requirements,
            rubric: custom.rubric,
            links: custom.links,
            reward: "",
            character: "charimage/teacher_quest.png", 
            style: "custom",
            prerequisites: [],
            timer: { allottedMinutes: 75 },
            is_custom: true,
            custom_id: custom.id
        };
    }
    
    return allQuests;
}
//--------------------------------------------Classroom Management Tab functions------------------------------------
// Render the drag & drop class management view
async function renderClassManagementView() {
      console.log("renderClassManagementView - START");
    try {
        console.log("renderClassManagementView started");
        const auth = await checkTeacherAuth();
        console.log("auth:", auth);
        if (!auth) return;
        
        // Get all students
        console.log("Fetching students...");
        const { data: students, error: studentsError } = await window.supabase
            .from('profiles')
            .select('*')
            .eq('teacher_code', auth.teacher.class_code);
        
        if (studentsError) {
            console.error("Error fetching students:", studentsError);
            return;
        }
        
        console.log("Students fetched:", students?.length);
        
        // Get pending works for red dots
        const studentIds = students.map(s => s.id);
        const { data: pendingWorks } = await window.supabase
            .from('student_works')
            .select('user_id')
            .eq('grading_status', 'pending')
            .in('user_id', studentIds);
        
        console.log("Pending works:", pendingWorks?.length);
        
        const pendingSet = new Set(pendingWorks?.map(w => w.user_id) || []);
        
        // Group students by class
        const studentsByClass = {};
        const unassignedStudents = [];
        
        students.forEach(student => {
            if (student.class_id) {
                if (!studentsByClass[student.class_id]) studentsByClass[student.class_id] = [];
                studentsByClass[student.class_id].push(student);
            } else {
                unassignedStudents.push(student);
            }
        });
        
        console.log("Students grouped by class");
        
        const dropZones = document.getElementById('class-drop-zones');
        console.log("dropZones element:", dropZones);
        if (!dropZones) {
            console.error("class-drop-zones not found!");
            return;
        }
        console.log("class-drop-zones found, clearing...");
        dropZones.innerHTML = '';
        
        // Add "Unassigned" column
        console.log("Creating Unassigned column...");
        const unassignedColumn = await createClassColumn('unassigned', 'Unassigned', unassignedStudents, pendingSet, null);
        dropZones.appendChild(unassignedColumn);
        
        // Add class columns
        console.log("Creating class columns, teacherClasses:", teacherClasses?.length);
        for (const cls of teacherClasses) {
            const classStudents = studentsByClass[cls.id] || [];
            const column = createClassColumn(cls.id, cls.name, classStudents, pendingSet, cls);
            dropZones.appendChild(column);
        }
        
        // Add "Create New Class" button column
        const addColumn = document.createElement('div');
        addColumn.className = 'class-drop-zone';
        addColumn.style.display = 'flex';
        addColumn.style.alignItems = 'center';
        addColumn.style.justifyContent = 'center';
        addColumn.style.minHeight = '200px';
        addColumn.innerHTML = '<button id="add-new-class-btn" class="add-class-btn">+ Create New Class</button>';
        dropZones.appendChild(addColumn);
        
        // Add event listener for create class button
        const addBtn = document.getElementById('add-new-class-btn');
        if (addBtn) {
            addBtn.addEventListener('click', showCreateClassModal);
        }
        
        // Update bulk panel UI if in bulk mode
        if (bulkAssignMode) {
            updateBulkPanelUI();
        }
        
        // Update delete panel UI if in delete mode
        if (deleteMode) {
            updateDeletePanelUI();
        }
        
    } catch (error) {
        console.error("Error in renderClassManagementView:", error);
    }
}
// Create a draggable/droppable class column
function createClassColumn(classId, className, students, pendingSet, classData) {
    console.log(`Creating column: ${className}, students: ${students.length}`);
    
    const column = document.createElement('div');
    column.className = 'class-drop-zone';
    column.dataset.classId = classId;
    
    // Header
    const header = document.createElement('div');
    header.className = 'class-header';
    header.innerHTML = `
        <div>
            <span class="class-title">🗃️ ${escapeHtml(className)}</span>
            <span class="class-student-count">(${students.length} student${students.length !== 1 ? 's' : ''})</span>
        </div>
        ${classData ? `<button class="delete-class-btn" data-id="${classData.id}" title="Delete Class">🗑️</button>` : ''}
    `;
    
    // Student list container
    const studentList = document.createElement('div');
    studentList.className = 'class-student-list';
    
    console.log(`  Adding ${students.length} students to ${className}`);
    
    students.forEach((student, idx) => {
        console.log(`    Student ${idx + 1}: ${student.name}`);
        const hasPending = pendingSet.has(student.id);
        const studentCard = createDraggableStudentCard(student, hasPending);
        studentList.appendChild(studentCard);
    });
    
    column.appendChild(header);
    column.appendChild(studentList);
    
    // Make column droppable
    column.setAttribute('draggable', 'false');
    
    // Drop zone event listeners
    column.addEventListener('dragover', (e) => {
        e.preventDefault();
        column.classList.add('drag-over');
    });
    
    column.addEventListener('dragleave', () => {
        column.classList.remove('drag-over');
    });
    
    column.addEventListener('drop', async (e) => {
        e.preventDefault();
        column.classList.remove('drag-over');
        
        const studentId = e.dataTransfer.getData('text/plain');
        if (!studentId) return;
        
        const targetClassId = classId === 'unassigned' ? null : classId;
        
        await assignStudentToClass(studentId, targetClassId);
        await renderClassManagementView();
        await renderClassAccordion();
    });
    
    // Delete class button handler
    if (classData) {
        const deleteBtn = header.querySelector('.delete-class-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Delete class "${className}"? Students will be moved to Unassigned.`)) {
                    await deleteClass(classData.id);
                    await renderClassManagementView();
                    await renderClassAccordion();
                }
            });
        }
    }
    
    console.log(`Column ${className} created successfully`);
    return column;
}
// Assign student to a class
async function assignStudentToClass(studentId, classId) {
    const { error } = await window.supabase
        .from('profiles')
        .update({ class_id: classId })
        .eq('id', studentId);
    
    if (error) {
        console.error("Error assigning student:", error);
        alert("Error assigning student: " + error.message);
    }
}
// Delete a class
async function deleteClass(classId) {
    // First, unassign all students in this class
    await window.supabase
        .from('profiles')
        .update({ class_id: null })
        .eq('class_id', classId);
    
    // Then delete the class
    const { error } = await window.supabase
        .from('classes')
        .delete()
        .eq('id', classId);
    
    if (error) {
        alert("Error deleting class: " + error.message);
    } else {
        await loadClasses();
    }
}
// Show create class modal using your existing modal
function showCreateClassModal() {
    const modal = document.getElementById('create-class-modal');
    modal.style.display = 'flex';
    
    const input = document.getElementById('new-class-name-input');
    input.value = '';
    
    const confirmBtn = document.getElementById('confirm-create-class');
    // Remove old listener to avoid duplicates
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    newConfirmBtn.addEventListener('click', async () => {
        const className = input.value.trim();
        if (!className) return;
        
        const auth = await checkTeacherAuth();
        if (!auth) return;
        
        const { error } = await window.supabase
            .from('classes')
            .insert({ teacher_id: auth.teacher.id, name: className });
        
        if (error) {
            alert("Error creating class: " + error.message);
        } else {
            modal.style.display = 'none';
            await loadClasses();
            await renderClassManagementView();
            await renderClassAccordion();
        }
    });
}
// Close create class modal
document.querySelector('#create-class-modal .teacher-work-close')?.addEventListener('click', () => {
    document.getElementById('create-class-modal').style.display = 'none';
});
document.getElementById('create-class-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('create-class-modal')) {
        document.getElementById('create-class-modal').style.display = 'none';
    }
});
// Toggle bulk assign mode
function toggleBulkAssignMode() {
    console.log("toggleBulkAssignMode called, current mode:", bulkAssignMode);
    bulkAssignMode = !bulkAssignMode;
    selectedStudentsForBulk.clear();
    
    const bulkBtn = document.getElementById('bulk-assign-mode-btn');
    if (bulkBtn) {
        bulkBtn.classList.toggle('active', bulkAssignMode);
        bulkBtn.textContent = bulkAssignMode ? '✕ Exit Bulk Mode' : '✓ Bulk Assign Students';
    }
    
    // Re-render the class management view
    renderClassManagementView();
}
// Confirm bulk assign
async function confirmBulkAssign() {
    const select = document.getElementById('bulk-class-select');
    const targetClassId = select.value;
    
    if (!targetClassId) {
        alert("Please select a class");
        return;
    }
    
    if (selectedStudentsForBulk.size === 0) {
        alert("No students selected");
        return;
    }
    
    const classIdToAssign = targetClassId === 'unassigned' ? null : targetClassId;
    
    for (const studentId of selectedStudentsForBulk) {
        await assignStudentToClass(studentId, classIdToAssign);
    }
    
    selectedStudentsForBulk.clear();
    bulkAssignMode = false;
    
    await renderClassManagementView();
    await renderClassAccordion();
    
    const bulkBtn = document.getElementById('bulk-assign-mode-btn');
    if (bulkBtn) {
        bulkBtn.classList.remove('active');
        bulkBtn.textContent = '✓ Bulk Assign Students';
    }
    
    alert(`Students assigned successfully`);
}
// createDraggableStudentCard function
function createDraggableStudentCard(student, hasPending) {
     console.log(`    Creating card for: ${student.name}, bulkMode: ${bulkAssignMode}, deleteMode: ${deleteMode}`);
    const card = document.createElement('div');
    card.className = 'class-student-card';
    card.dataset.studentId = student.id;
    
    if (bulkAssignMode) {
        console.log(`      Bulk mode - checkbox for ${student.name}`);
        // Bulk mode - show checkboxes for bulk assign
        card.draggable = false;
        const isChecked = selectedStudentsForBulk.has(student.id);
        card.innerHTML = `
            <input type="checkbox" class="bulk-student-checkbox" data-id="${student.id}" ${isChecked ? 'checked' : ''}>
            <img src="${student.avatar_url || 'profile.png'}" class="class-student-avatar">
            <span class="class-student-name">${escapeHtml(student.name)}${hasPending ? ' 🔴' : ''}</span>
        `;
        
        const checkbox = card.querySelector('.bulk-student-checkbox');
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedStudentsForBulk.add(student.id);
            } else {
                selectedStudentsForBulk.delete(student.id);
            }
            updateBulkPanelUI();
        });
    } else if (deleteMode) {
        console.log(`      Delete mode - checkbox for ${student.name}`);
        // Delete mode - show checkboxes for deletion
        card.draggable = false;
        const isChecked = selectedStudentsForDelete.has(student.id);
        card.innerHTML = `
            <input type="checkbox" class="delete-student-checkbox" data-id="${student.id}" ${isChecked ? 'checked' : ''}>
            <img src="${student.avatar_url || 'profile.png'}" class="class-student-avatar">
            <span class="class-student-name">${escapeHtml(student.name)}${hasPending ? ' 🔴' : ''}</span>
        `;
        console.log(`      Normal mode - draggable card for ${student.name}`);
        const checkbox = card.querySelector('.delete-student-checkbox');
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedStudentsForDelete.add(student.id);
            } else {
                selectedStudentsForDelete.delete(student.id);
            }
            updateDeletePanelUI();
        });
    } else {
        // Normal mode - make draggable for class assignment
        card.draggable = true;
        card.style.cursor = 'grab';
        card.innerHTML = `
            <img src="${student.avatar_url || 'profile.png'}" class="class-student-avatar">
            <span class="class-student-name">${escapeHtml(student.name)}${hasPending ? ' 🔴' : ''}</span>
        `;
        
        // Drag start event
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', student.id);
            e.dataTransfer.effectAllowed = 'move';
            card.style.opacity = '0.5';
        });
        
        card.addEventListener('dragend', () => {
            card.style.opacity = '1';
        });
        
        // Also allow clicking to view student details
        card.addEventListener('click', (e) => {
            e.stopPropagation();
            loadStudentDetails(student.id, student.name);
        });
    }
    
    return card;
}
// Update bulk panel UI
function updateBulkPanelUI() {
    const bulkPanel = document.getElementById('bulk-assign-panel');
    const studentListDiv = document.getElementById('bulk-student-list');
    const classSelect = document.getElementById('bulk-class-select');
    
    if (selectedStudentsForBulk.size > 0) {
        bulkPanel.style.display = 'block';
        
        classSelect.innerHTML = '<option value="">-- Select Class --</option>';
        classSelect.innerHTML += '<option value="unassigned">📁 No Class (Unassigned)</option>';
        teacherClasses.forEach(cls => {
            classSelect.innerHTML += `<option value="${cls.id}">📁 ${escapeHtml(cls.name)}</option>`;
        });
        
        studentListDiv.innerHTML = `<span>${selectedStudentsForBulk.size} student(s) selected</span>`;
    } else {
        bulkPanel.style.display = 'none';
    }
}
//Delete function
function toggleDeleteMode() {
    deleteMode = !deleteMode;
    selectedStudentsForDelete.clear();
    
    const deleteBtn = document.getElementById('delete-students-btn');
    if (deleteBtn) {
        deleteBtn.classList.toggle('active', deleteMode);
        deleteBtn.textContent = deleteMode ? '✕ Exit Delete Mode' : '🗑️ Delete Students';
    }
    
    // If entering delete mode, exit bulk mode
    if (deleteMode && bulkAssignMode) {
        toggleBulkAssignMode();
    }
    
    // Re-render the class management view
    renderClassManagementView();
}
// Update delete panel UI
function updateDeletePanelUI() {
    const deletePanel = document.getElementById('delete-confirm-panel');
    
    if (selectedStudentsForDelete.size > 0) {
        if (!deletePanel) {
            createDeletePanel();
        }
        const panel = document.getElementById('delete-confirm-panel');
        const countSpan = document.getElementById('delete-student-count');
        if (countSpan) countSpan.innerText = selectedStudentsForDelete.size;
        panel.style.display = 'block';
    } else {
        if (deletePanel) deletePanel.style.display = 'none';
    }
}
// Create delete panel
function createDeletePanel() {
    const classManagementArea = document.getElementById('class-management-area');
    const existingPanel = document.getElementById('delete-confirm-panel');
    if (existingPanel) return;
    
    const panel = document.createElement('div');
    panel.id = 'delete-confirm-panel';
    panel.className = 'delete-confirm-panel';
    panel.innerHTML = `
        <p>⚠️ You are about to delete <span id="delete-student-count">0</span> student(s). This action cannot be undone.</p>
        <p>All quest data, grades, and artwork will be permanently deleted.</p>
        <div class="delete-confirm-buttons">
            <button id="confirm-delete-btn" class="confirm-delete-btn">Yes, Delete Permanently</button>
            <button id="cancel-delete-btn" class="cancel-delete-btn">Cancel</button>
        </div>
    `;
    
    // Insert after class-drop-zones
    const dropZones = document.getElementById('class-drop-zones');
    dropZones.insertAdjacentElement('afterend', panel);
    
    document.getElementById('confirm-delete-btn').addEventListener('click', confirmDeleteStudents);
    document.getElementById('cancel-delete-btn').addEventListener('click', () => {
        selectedStudentsForDelete.clear();
        updateDeletePanelUI();
        renderClassManagementView();
    });
}
// Confirm delete
async function confirmDeleteStudents() {
    if (selectedStudentsForDelete.size === 0) return;
    
    const isValid = await verifyTeacherPassword();
    if (!isValid) {
        alert("Password verification failed. Deletion cancelled.");
        return;
    }
    
    const confirmMessage = confirm(`⚠️ WARNING: You are about to delete ${selectedStudentsForDelete.size} student(s). This action CANNOT be undone.\n\nAll quest data, grades, and artwork will be permanently deleted.\n\nClick OK to confirm.`);
    if (!confirmMessage) return;
    
    let deletedCount = 0;
    let errorCount = 0;
    const SUPABASE_URL = 'https://qzxvwoyigrrpdywvhckk.supabase.co';
    
    for (const studentId of selectedStudentsForDelete) {
        // First delete the auth user via Edge Function (before profile is deleted)
        let authDeleted = false;
        
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            const response = await fetch(`${SUPABASE_URL}/functions/v1/delete-user`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({ studentUserId: studentId })
            });
            
            if (!response.ok) {
                const result = await response.json();
                console.error("Error deleting auth user:", result.error);
                errorCount++;
            } else {
                authDeleted = true;
            }
        } catch (err) {
            console.error("Error calling delete-user function:", err);
            errorCount++;
        }
        
        // Only delete from profiles if auth deletion succeeded
        if (authDeleted) {
            const { error: profileError } = await window.supabase
                .from('profiles')
                .delete()
                .eq('id', studentId);
            
            if (profileError) {
                console.error("Error deleting student profile:", profileError);
                errorCount++;
            } else {
                deletedCount++;
            }
        }
    }
    
    alert(`Deleted ${deletedCount} student(s). ${errorCount} error(s).`);
    
    deleteMode = false;
    selectedStudentsForDelete.clear();
    
    const deleteBtn = document.getElementById('delete-students-btn');
    if (deleteBtn) {
        deleteBtn.classList.remove('active');
        deleteBtn.textContent = '🗑️ Delete Students';
    }
    
    await loadClasses();
    await renderClassManagementView();
    await renderClassAccordion();
    await loadAllStudents();
    
    const panel = document.getElementById('delete-confirm-panel');
    if (panel) panel.style.display = 'none';
}
// Load class settings from database
async function loadClassSettings() {
    const settings = {};
    for (const cls of teacherClasses) {
        const { data } = await window.supabase
            .from('class_settings')
            .select('target_formative, target_summative')
            .eq('class_id', cls.id)
            .single();
        
        settings[cls.id] = {
            target_formative: data?.target_formative || 15,
            target_summative: data?.target_summative || 5
        };
    }
    return settings;
}
// Render class settings table
async function renderClassSettingsTable() {
    const tbody = document.getElementById('class-settings-tbody');
    if (!tbody) return;
    
    const settings = await loadClassSettings();
    
    tbody.innerHTML = '';
    
    for (const cls of teacherClasses) {
        const clsSettings = settings[cls.id] || { target_formative: 15, target_summative: 5 };
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${escapeHtml(cls.name)}</strong></td>
            <td>
                <input type="number" class="target-formative-input" data-class-id="${cls.id}" 
                       value="${clsSettings.target_formative}" min="0" max="81" step="1">
            </td>
            <td>
                <input type="number" class="target-summative-input" data-class-id="${cls.id}" 
                       value="${clsSettings.target_summative}" min="0" max="81" step="1">
            </td>
            <td>
                <button class="reset-class-defaults-btn" data-class-id="${cls.id}" 
                        style="background: none; border: none; color: #ff8888; cursor: pointer;">↺ Reset</button>
            </td>
        `;
        tbody.appendChild(row);
    }
    
    // Add event listeners for reset buttons
    document.querySelectorAll('.reset-class-defaults-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const classId = btn.dataset.classId;
            const formativeInput = document.querySelector(`.target-formative-input[data-class-id="${classId}"]`);
            const summativeInput = document.querySelector(`.target-summative-input[data-class-id="${classId}"]`);
            if (formativeInput) formativeInput.value = 15;
            if (summativeInput) summativeInput.value = 5;
        });
    });
}
// Save all class settings
async function saveAllClassSettings() {
    const auth = await checkTeacherAuth();
    if (!auth) return false;
    
    const formativeInputs = document.querySelectorAll('.target-formative-input');
    const summativeInputs = document.querySelectorAll('.target-summative-input');
    
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < formativeInputs.length; i++) {
        const classId = formativeInputs[i].dataset.classId;
        const target_formative = parseInt(formativeInputs[i].value) || 0;
        const target_summative = parseInt(summativeInputs[i].value) || 0;
        
        const { error } = await window.supabase
            .from('class_settings')
            .upsert({
                class_id: classId,
                target_formative: target_formative,
                target_summative: target_summative,
                updated_at: new Date().toISOString()
            }, { onConflict: 'class_id' });
        
        if (error) {
            console.error("Error saving setting for class:", classId, error);
            errorCount++;
        } else {
            successCount++;
        }
    }
    
    showSettingsMessage(`Saved ${successCount} class setting(s). ${errorCount} error(s).`, errorCount === 0 ? 'success' : 'error');
    
    // Refresh analytics if open
    if (document.getElementById('analytics-main-content').style.display === 'block') {
        await loadAnalyticsData();
    }
}
// Show message in class settings
function showSettingsMessage(message, type) {
    const messageDiv = document.getElementById('settings-message');
    if (messageDiv) {
        messageDiv.textContent = message;
        messageDiv.className = `settings-message ${type}`;
        messageDiv.style.display = 'block';
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 5000);
    } else {
        // Fallback alert if message div doesn't exist
        alert(message);
    }
}
// Get target quests for a specific class
async function getClassTargets(classId) {
    const { data } = await window.supabase
        .from('class_settings')
        .select('target_formative, target_summative')
        .eq('class_id', classId)
        .single();
    
    return {
        formative: data?.target_formative || 15,
        summative: data?.target_summative || 5,
        total: (data?.target_formative || 15) + (data?.target_summative || 5)
    };
}
// --------------------------------------------Teacher code hide functions -----------------------------------------
// Load and display teacher class code
let classCodeVisible = false;
let actualClassCode = '';
async function loadTeacherClassCode() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    actualClassCode = auth.teacher.class_code;
    const classCodeSpan = document.getElementById('teacher-class-code');
    if (classCodeSpan) {
        classCodeSpan.textContent = '••••••';
        classCodeSpan.classList.add('class-code-hidden');
        classCodeSpan.classList.remove('class-code-visible');
    }
}
// Toggle class code visibility
function toggleClassCodeVisibility() {
    const classCodeSpan = document.getElementById('teacher-class-code');
    const toggleBtn = document.getElementById('toggle-code-visibility');
    
    if (!classCodeSpan || !actualClassCode) return;
    
    classCodeVisible = !classCodeVisible;
    
    if (classCodeVisible) {
        classCodeSpan.textContent = actualClassCode;
        classCodeSpan.classList.remove('class-code-hidden');
        classCodeSpan.classList.add('class-code-visible');
        toggleBtn.textContent = '🙈';
        toggleBtn.title = 'Hide code';
    } else {
        classCodeSpan.textContent = '••••••';
        classCodeSpan.classList.add('class-code-hidden');
        classCodeSpan.classList.remove('class-code-visible');
        toggleBtn.textContent = '👁️';
        toggleBtn.title = 'Show code';
    }
}
// ----------------------------------------Student invitation system functions -----------------------------------
// Open invite modal
async function openInviteModal() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    // Populate class dropdown
    const classSelect = document.getElementById('invite-class');
    classSelect.innerHTML = '<option value="">Select Class (optional)</option>';
    
    for (const cls of teacherClasses) {
        classSelect.innerHTML += `<option value="${cls.id}">${escapeHtml(cls.name)}</option>`;
    }
    
    // Clear previous values
    document.getElementById('invite-email').value = '';
    document.getElementById('invite-message').innerHTML = '';
    
    document.getElementById('invite-modal').style.display = 'flex';
}
// Send invitation
async function sendInvitation() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    const email = document.getElementById('invite-email').value.trim();
    const classId = document.getElementById('invite-class').value;
    
    if (!email) {
        showInviteMessage("Please enter a student email address.", "error");
        return;
    }
    
    // Verify teacher password
    const passwordValid = await verifyTeacherPassword();
    if (!passwordValid) {
        showInviteMessage("Password verification failed.", "error");
        return;
    }
    
    // Show loading
    const sendBtn = document.getElementById('send-invite-btn');
    const originalText = sendBtn.textContent;
    sendBtn.textContent = 'Sending...';
    sendBtn.disabled = true;
    
    try {
        // Generate a unique invitation token
        const inviteToken = generateInviteToken();
        
        // Store invitation in database
        const { error: inviteError } = await window.supabase
            .from('student_invitations')
            .insert({
                email: email,
                teacher_code: auth.teacher.class_code,
                class_id: classId || null,
                token: inviteToken,
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
            });
        
        if (inviteError) {
            console.error("Error saving invitation:", inviteError);
            showInviteMessage("Failed to create invitation. Please try again.", "error");
            return;
        }
        
        // Create invitation link
        const inviteLink = `${window.location.origin}/signup.html?invite=${inviteToken}`;
        
        // Here you would send email with the link
        // For now, show the link to the teacher (they can share with student)
        showInviteMessage(`✅ Invitation created! Share this link with the student:\n\n${inviteLink}\n\nThe link expires in 7 days.`, "success");
        
        // Close modal after 3 seconds
        setTimeout(() => {
            document.getElementById('invite-modal').style.display = 'none';
        }, 5000);
        
    } catch (error) {
        console.error("Error:", error);
        showInviteMessage("An error occurred. Please try again.", "error");
    } finally {
        sendBtn.textContent = originalText;
        sendBtn.disabled = false;
    }
}
// Generate random invitation token
function generateInviteToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}
// Show message in invite modal
function showInviteMessage(message, type) {
    const messageDiv = document.getElementById('invite-message');
    messageDiv.textContent = message;
    messageDiv.className = `settings-message ${type}`;
    messageDiv.style.whiteSpace = 'pre-wrap';
    setTimeout(() => {
        messageDiv.textContent = '';
        messageDiv.className = 'settings-message';
    }, 8000);
}

//--------------------------------------------- Analytics Tab Functions---------------------------------------------
// Main function to load all analytics data
async function loadAnalyticsData() {
    console.log("Loading analytics data...");
    
    // Get current framework
    analyticsData.framework = await loadTeacherFramework();
    
    // Get class filter element and populate classes
    await populateClassFilter();
    
    // Load all data
    await loadStudentAnalytics();
    await loadQuestAnalytics();
    
    // Update UI
    await updateAnalyticsUI();
}
// Populate class filter dropdown
async function populateClassFilter() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    const filterSelect = document.getElementById('analytics-class-filter');
    if (!filterSelect) return;
    
    // Save current selection
    const currentValue = filterSelect.value;
    
    // Clear and repopulate
    filterSelect.innerHTML = '<option value="all">All Classes</option>';
    
    for (const cls of teacherClasses) {
        const option = document.createElement('option');
        option.value = cls.id;
        option.textContent = cls.name;
        filterSelect.appendChild(option);
    }
    
    // Restore selection if still valid
    if (currentValue !== 'all' && teacherClasses.some(c => c.id === currentValue)) {
        filterSelect.value = currentValue;
    } else {
        filterSelect.value = 'all';
    }
    analyticsData.classFilter = filterSelect.value;
    
    // Add change event listener
    filterSelect.removeEventListener('change', handleClassFilterChange);
    filterSelect.addEventListener('change', handleClassFilterChange);
}
// Handle class filter change
async function handleClassFilterChange(e) {
    analyticsData.classFilter = e.target.value;
    await loadStudentAnalytics();
    await updateAnalyticsUI();
}
// Load student analytics data
async function loadStudentAnalytics() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    // Get all students
    let query = window.supabase
        .from('profiles')
        .select('*')
        .eq('teacher_code', auth.teacher.class_code);
    
    if (analyticsData.classFilter !== 'all') {
        query = query.eq('class_id', analyticsData.classFilter);
    }
    
    const { data: students, error } = await query;
    if (error || !students) {
        console.error("Error loading students:", error);
        return;
    }
    
    // Get progress data for all students
    const studentIds = students.map(s => s.id);
    const { data: progressData } = await window.supabase
        .from('student_progress')
        .select('*')
        .in('user_id', studentIds);
    
    // Get student works for last upload dates
    const { data: worksData } = await window.supabase
        .from('student_works')
        .select('user_id, uploaded_at')
        .in('user_id', studentIds)
        .order('uploaded_at', { ascending: false });
    
    // Create maps for quick lookup
    const progressMap = new Map();
    if (progressData) {
        progressData.forEach(p => {
            progressMap.set(p.user_id, p);
        });
    }
    
    const lastUploadMap = new Map();
    if (worksData) {
        worksData.forEach(w => {
            if (!lastUploadMap.has(w.user_id)) {
                lastUploadMap.set(w.user_id, w.uploaded_at);
            }
        });
    }
    
    // Get class names map
    const classMap = new Map();
    teacherClasses.forEach(cls => {
        classMap.set(cls.id, cls.name);
    });
    
    // Get all quests
    const allQuests = await getQuests();
    
    // Build student data
    analyticsData.students = [];
    let totalCompletedQuests = 0;
    let totalActiveStudents = 0;
    
    for (const student of students) {
        const progress = progressMap.get(student.id);
        const completedQuests = progress?.completed_quests || {};
        const questAccepted = progress?.quest_accepted || {};
        const questGrades = progress?.quest_grades || {};
        
        // Count completed quests (both formative and MVP)
        let completedCount = 0;
        for (const [questId, isCompleted] of Object.entries(completedQuests)) {
            if (isCompleted === true) completedCount++;
        }
        totalCompletedQuests += completedCount;
        
        // Find active quest
        let activeQuest = null;
        for (const [questId, isAccepted] of Object.entries(questAccepted)) {
            if (isAccepted === true && !completedQuests[questId]) {
                const quest = allQuests[questId];
                activeQuest = quest?.title || questId;
                break;
            }
        }
        
        if (activeQuest) totalActiveStudents++;

        //Get class targets for this student
        const classTargets = await getClassTargets(student.class_id);
        const targetTotal = classTargets.total;
        
        // Calculate domain grades
        const domainGrades = calculateStudentDomainGrades(questGrades, completedQuests, allQuests);
        
        // Get last upload date
        const lastUpload = lastUploadMap.get(student.id);
        
        analyticsData.students.push({
            id: student.id,
            name: student.name,
            classId: student.class_id,
            className: classMap.get(student.class_id) || 'No Class',
            completedCount: completedCount,
            targetTotal: targetTotal, 
            activeQuest: activeQuest,
            domainGrades: domainGrades,
            lastUpload: lastUpload
        });
    }
    
    // Calculate class averages
    const studentCount = analyticsData.students.length;
    analyticsData.classAverages = {
        completionRate: studentCount > 0 ? (totalCompletedQuests / studentCount).toFixed(1) : 0,
        activeStudents: totalActiveStudents,
        domainAverages: calculateClassDomainAverages(analyticsData.students)
    };
}
// Calculate domain grades for a student based on framework
function calculateStudentDomainGrades(questGrades, completedQuests, allQuests) {
    const framework = analyticsData.framework;
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
    // Initialize scores
    let scores = {};
    let counts = {};
    
    if (isIB) {
        scores = { A: 0, B: 0, C: 0, D: 0 };
        counts = { A: 0, B: 0, C: 0, D: 0 };
    } else if (isIGCSE) {
        scores = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
        counts = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
    } else {
        // NCAS domains
        scores = { creating: 0, presenting: 0, responding: 0, connecting: 0 };
        counts = { creating: 0, presenting: 0, responding: 0, connecting: 0 };
    }
    
    // Process completed quests
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        
        const quest = allQuests[questId];
        if (!quest) continue;
        
        const column = quest.style === 'mvp' ? 'mvpGrade' : 'grade';
        const grades = questGrades[questId]?.[column] || {};
        
        if (isIB && quest.rubric?.criteria) {
            quest.rubric.criteria.forEach(criterion => {
                const grade = grades[criterion.code];
                if (grade && typeof grade === 'number') {
                    scores[criterion.code] += grade;
                    counts[criterion.code]++;
                }
            });
        } else if (isIGCSE && quest.rubric?.assessment_objectives) {
            quest.rubric.assessment_objectives.forEach(ao => {
                const grade = grades[ao.code];
                if (grade && typeof grade === 'number') {
                    scores[ao.code] += grade;
                    counts[ao.code]++;
                }
            });
        } else if (quest.rubric?.standards) {
            // NCAS mapping to domains
            quest.rubric.standards.forEach(standard => {
                const grade = grades[standard.code];
                if (grade && typeof grade === 'number') {
                    const domain = mapStandardToDomain(standard.code);
                    if (domain) {
                        scores[domain] = (scores[domain] || 0) + grade;
                        counts[domain] = (counts[domain] || 0) + 1;
                    }
                }
            });
        }
    }
    
    // Calculate averages
    const result = {};
    for (const key of Object.keys(scores)) {
        if (counts[key] > 0) {
            let avg = scores[key] / counts[key];
            if (isIGCSE) {
                // Convert to letter grade for display
                avg = convertNumberToLetterGrade(Math.round(avg));
            } else {
                avg = avg.toFixed(1);
            }
            result[key] = avg;
        } else {
            result[key] = '—';
        }
    }
    
    return result;
}
// Map NCAS standard code to domain
function mapStandardToDomain(standardCode) {
    const mapping = {
        'Art.FA.CR.1.1.IA': 'creating',
        'Art.FA.CR.1.2.IA': 'creating',
        'Art.FA.CR.2.1.IA': 'creating',
        'Art.FA.CR.2.3.IA': 'creating',
        'Art.FA.CR.3.1.IA': 'creating',
        'Art.FA.PR.6.1.IA': 'presenting',
        'Art.FA.RE.8.1.8A': 'responding',
        'Art.FA.CN.10.1.IA': 'connecting'
    };
    return mapping[standardCode];
}
// Calculate class averages for domains
function calculateClassDomainAverages(students) {
    const framework = analyticsData.framework;
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
    let keys = [];
    if (isIB) keys = ['A', 'B', 'C', 'D'];
    else if (isIGCSE) keys = ['AO1', 'AO2', 'AO3', 'AO4'];
    else keys = ['creating', 'presenting', 'responding', 'connecting'];
    
    const totals = {};
    const counts = {};
    keys.forEach(key => {
        totals[key] = 0;
        counts[key] = 0;
    });
    
    for (const student of students) {
        for (const key of keys) {
            const val = student.domainGrades[key];
            if (val !== '—' && typeof val === 'number') {
                totals[key] += val;
                counts[key]++;
            }
        }
    }
    
    const averages = {};
    for (const key of keys) {
        if (counts[key] > 0) {
            let avg = totals[key] / counts[key];
            if (isIGCSE) {
                avg = convertNumberToLetterGrade(Math.round(avg));
            } else {
                avg = avg.toFixed(1);
            }
            averages[key] = avg;
        } else {
            averages[key] = '—';
        }
    }
    return averages;
}
// Load quest analytics data
async function loadQuestAnalytics() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    // Get all students
    let query = window.supabase
        .from('profiles')
        .select('id')
        .eq('teacher_code', auth.teacher.class_code);
    
    if (analyticsData.classFilter !== 'all') {
        query = query.eq('class_id', analyticsData.classFilter);
    }
    
    const { data: students } = await query;
    if (!students || students.length === 0) return;
    
    const studentIds = students.map(s => s.id);
    
    // Get progress data
    const { data: progressData } = await window.supabase
        .from('student_progress')
        .select('user_id, completed_quests, quest_grades, quest_accepted')
        .in('user_id', studentIds);
    
    // Get all quests
    const allQuests = await getQuests();
    
    // Initialize quest stats
    analyticsData.questStats = {};
    
    for (const [questId, quest] of Object.entries(allQuests)) {
        if (!questId.startsWith('quest')) continue;
        
        analyticsData.questStats[questId] = {
            id: questId,
            title: quest.title,
            path: quest.path?.[0] || 'Unknown',
            type: quest.style === 'mvp' ? 'MVP' : 'Formative',
            completedCount: 0,
            totalStudents: students.length,
            totalTime: 0,
            timesCompleted: 0,
            activeCount: 0,
            domainScores: {},
            domainCounts: {}
        };
    }
    
    // Process each student's data
    for (const progress of (progressData || [])) {
        const completedQuests = progress.completed_quests || {};
        const questGrades = progress.quest_grades || {};
        const questAccepted = progress.quest_accepted || {};
        
        for (const [questId, isCompleted] of Object.entries(completedQuests)) {
            if (isCompleted === true && analyticsData.questStats[questId]) {
                analyticsData.questStats[questId].completedCount++;
                analyticsData.questStats[questId].timesCompleted++;
                
                // Collect domain grades for this quest
                const quest = allQuests[questId];
                if (quest) {
                    const column = quest.style === 'mvp' ? 'mvpGrade' : 'grade';
                    const grades = questGrades[questId]?.[column] || {};
                    collectQuestDomainGrades(questId, quest, grades, analyticsData.questStats[questId]);
                }
            }
        }
        
        // Count active quests
        for (const [questId, isAccepted] of Object.entries(questAccepted)) {
            if (isAccepted === true && !completedQuests[questId] && analyticsData.questStats[questId]) {
                analyticsData.questStats[questId].activeCount++;
            }
        }
    }
    
    // Calculate averages for each quest
    for (const questId in analyticsData.questStats) {
        const stat = analyticsData.questStats[questId];
        stat.completionPercentage = stat.totalStudents > 0 ? ((stat.completedCount / stat.totalStudents) * 100).toFixed(1) : 0;
        stat.popularity = stat.completedCount + stat.activeCount;
        
        // Calculate average domain grades
        for (const domain in stat.domainScores) {
            if (stat.domainCounts[domain] > 0) {
                let avg = stat.domainScores[domain] / stat.domainCounts[domain];
                if (analyticsData.framework === 'igcse') {
                    avg = convertNumberToLetterGrade(Math.round(avg));
                } else {
                    avg = avg.toFixed(1);
                }
                stat.domainAverages = stat.domainAverages || {};
                stat.domainAverages[domain] = avg;
            }
        }
    }
    
    // Sort quests by popularity
    const questArray = Object.values(analyticsData.questStats);
    questArray.sort((a, b) => b.popularity - a.popularity);
    analyticsData.sortedQuests = questArray;
}
// Collect domain grades for quest analytics
function collectQuestDomainGrades(questId, quest, grades, stat) {
    const framework = analyticsData.framework;
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
    if (isIB && quest.rubric?.criteria) {
        quest.rubric.criteria.forEach(criterion => {
            const grade = grades[criterion.code];
            if (grade && typeof grade === 'number') {
                stat.domainScores[criterion.code] = (stat.domainScores[criterion.code] || 0) + grade;
                stat.domainCounts[criterion.code] = (stat.domainCounts[criterion.code] || 0) + 1;
            }
        });
    } else if (isIGCSE && quest.rubric?.assessment_objectives) {
        quest.rubric.assessment_objectives.forEach(ao => {
            const grade = grades[ao.code];
            if (grade && typeof grade === 'number') {
                stat.domainScores[ao.code] = (stat.domainScores[ao.code] || 0) + grade;
                stat.domainCounts[ao.code] = (stat.domainCounts[ao.code] || 0) + 1;
            }
        });
    } else if (quest.rubric?.standards) {
        quest.rubric.standards.forEach(standard => {
            const grade = grades[standard.code];
            if (grade && typeof grade === 'number') {
                const domain = mapStandardToDomain(standard.code);
                if (domain) {
                    stat.domainScores[domain] = (stat.domainScores[domain] || 0) + grade;
                    stat.domainCounts[domain] = (stat.domainCounts[domain] || 0) + 1;
                }
            }
        });
    }
}
// Main UI update function
async function updateAnalyticsUI() {
    await updateTopCards();
    await updateAverageGradeGrid();
    await updateStudentsTable();
    await updateQuestsTable();
}
// Update top statistics cards
async function updateTopCards() {
    const framework = analyticsData.framework;
    const students = analyticsData.students;
    const classAverages = analyticsData.classAverages;
    
    // Calculate total completed and total target across all students
    let totalCompleted = 0;
    let totalTarget = 0;
    for (const student of students) {
        totalCompleted += student.completedCount;
        totalTarget += student.targetTotal;
    }
    const completionRate = students.length > 0 && totalTarget > 0 ? Math.round((totalCompleted / totalTarget) * 100) : 0;    
    // Update completion card
    document.getElementById('analytics-completion').textContent = `${completionRate}%`;
    document.getElementById('analytics-completion-detail').textContent = `(${totalCompleted}/${totalTarget})`;
    
    // Update active students card
    document.getElementById('analytics-active-students').textContent = classAverages?.activeStudents || 0;
    
    // Update time cards (placeholder - will be implemented when timer data is available)
    document.getElementById('analytics-avg-time-formative').textContent = '2.3 days';
    document.getElementById('analytics-avg-time-summative').textContent = '5.8 days';
}
// Update average grade 2x2 grid
async function updateAverageGradeGrid() {
    const framework = analyticsData.framework;
    const classAverages = analyticsData.classAverages;
    const gridContainer = document.getElementById('analytics-avg-grade-grid');
    
    if (!gridContainer) return;
    
    let domains = [];
    let labels = [];
    
    if (framework === 'ib-myp') {
        domains = ['A', 'B', 'C', 'D'];
        labels = ['Knowing & Understanding', 'Developing Skills', 'Thinking Creatively', 'Responding'];
    } else if (framework === 'igcse') {
        domains = ['AO1', 'AO2', 'AO3', 'AO4'];
        labels = ['Record', 'Explore & Select', 'Develop', 'Present'];
    } else {
        domains = ['creating', 'presenting', 'responding', 'connecting'];
        labels = ['Creating', 'Presenting', 'Responding', 'Connecting'];
    }
    
    const domainAverages = classAverages?.domainAverages || {};
    
    // Get the appropriate CSS class for each domain
    const getCellClass = (domain, framework) => {
        if (framework === 'ib-myp') {
            const mapping = { 'A': 'grade-cell-creating', 'B': 'grade-cell-presenting', 'C': 'grade-cell-responding', 'D': 'grade-cell-connecting' };
            return mapping[domain] || 'grade-cell-creating';
        } else if (framework === 'igcse') {
            const mapping = { 'AO1': 'grade-cell-creating', 'AO2': 'grade-cell-presenting', 'AO3': 'grade-cell-responding', 'AO4': 'grade-cell-connecting' };
            return mapping[domain] || 'grade-cell-creating';
        } else {
            const mapping = { 'creating': 'grade-cell-creating', 'presenting': 'grade-cell-presenting', 'responding': 'grade-cell-responding', 'connecting': 'grade-cell-connecting' };
            return mapping[domain] || 'grade-cell-creating';
        }
    };
    
    const getDisplayName = (domain, framework) => {
        if (framework === 'ib-myp') {
            const mapping = { 'A': 'A', 'B': 'B', 'C': 'C', 'D': 'D' };
            return mapping[domain] || domain;
        } else if (framework === 'igcse') {
            return domain;
        } else {
            const mapping = { 'creating': 'Cr', 'presenting': 'Pr', 'responding': 'Re', 'connecting': 'Cn' };
            return mapping[domain] || domain;
        }
    };
    
    gridContainer.innerHTML = `
        <div class="${getCellClass(domains[0], framework)}">
            <div class="grade-cell-label">${getDisplayName(domains[0], framework)}: ${labels[0]}</div>
            <div class="grade-cell-value">${domainAverages[domains[0]] || '—'}</div>
        </div>
        <div class="${getCellClass(domains[1], framework)}">
            <div class="grade-cell-label">${getDisplayName(domains[1], framework)}: ${labels[1]}</div>
            <div class="grade-cell-value">${domainAverages[domains[1]] || '—'}</div>
        </div>
        <div class="${getCellClass(domains[2], framework)}">
            <div class="grade-cell-label">${getDisplayName(domains[2], framework)}: ${labels[2]}</div>
            <div class="grade-cell-value">${domainAverages[domains[2]] || '—'}</div>
        </div>
        <div class="${getCellClass(domains[3], framework)}">
            <div class="grade-cell-label">${getDisplayName(domains[3], framework)}: ${labels[3]}</div>
            <div class="grade-cell-value">${domainAverages[domains[3]] || '—'}</div>
        </div>
    `;
}
// Update students table
async function updateStudentsTable() {
    const tbody = document.getElementById('analytics-students-tbody');
    const tfoot = document.getElementById('analytics-students-tfoot');
    const framework = analyticsData.framework;
    
    if (!tbody) return;
    
    if (analyticsData.students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6">No students found...</td></tr>';
        return;
    }
    
    tbody.innerHTML = '';
    
    // Get domain keys based on framework
    let domains = [];
    let shortLabels = [];
    if (framework === 'ib-myp') {
        domains = ['A', 'B', 'C', 'D'];
        shortLabels = ['A', 'B', 'C', 'D'];
    } else if (framework === 'igcse') {
        domains = ['AO1', 'AO2', 'AO3', 'AO4'];
        shortLabels = ['AO1', 'AO2', 'AO3', 'AO4'];
    } else {
        domains = ['creating', 'presenting', 'responding', 'connecting'];
        shortLabels = ['Cr', 'Pr', 'Re', 'Cn'];
    }
    
    const getCellClass = (domain, framework) => {
        if (framework === 'ib-myp') {
            const mapping = { 'A': 'grade-cell-creating', 'B': 'grade-cell-presenting', 'C': 'grade-cell-responding', 'D': 'grade-cell-connecting' };
            return mapping[domain] || '';
        } else if (framework === 'igcse') {
            const mapping = { 'AO1': 'grade-cell-creating', 'AO2': 'grade-cell-presenting', 'AO3': 'grade-cell-responding', 'AO4': 'grade-cell-connecting' };
            return mapping[domain] || '';
        } else {
            const mapping = { 'creating': 'grade-cell-creating', 'presenting': 'grade-cell-presenting', 'responding': 'grade-cell-responding', 'connecting': 'grade-cell-connecting' };
            return mapping[domain] || '';
        }
    };
    
    for (const student of analyticsData.students) {
        const row = document.createElement('tr');
        
        // Format last upload
        let lastUploadText = 'Never';
        if (student.lastUpload) {
            const date = new Date(student.lastUpload);
            const daysAgo = Math.floor((Date.now() - date) / (1000 * 60 * 60 * 24));
            if (daysAgo === 0) lastUploadText = 'Today';
            else if (daysAgo === 1) lastUploadText = 'Yesterday';
            else lastUploadText = `${daysAgo} days ago`;
        }
        
        // Build domain grades HTML
        let domainHtml = '<div class="domain-mini-grid">';
        for (let i = 0; i < domains.length; i++) {
            const grade = student.domainGrades[domains[i]] || '—';
            domainHtml += `
                <div class="domain-mini-cell ${getCellClass(domains[i], framework)}">
                    <div class="domain-mini-label">${shortLabels[i]}</div>
                    <div>${grade}</div>
                </div>
            `;
        }
        domainHtml += '</div>';
        
        row.innerHTML = `
            <td class="student-name-link" data-user-id="${student.id}">${escapeHtml(student.name)}</td>
            <td>${escapeHtml(student.className)}</td>
            <td>${student.completedCount}/${student.targetTotal} (${Math.round((student.completedCount/student.targetTotal)*100)}%)</td>
            <td>${student.activeQuest ? `<span class="active-quest-badge">${escapeHtml(student.activeQuest)}</span>` : '—'}</td>
            <td>${domainHtml}</td>
            <td>${lastUploadText}</td>
        `;
        
        tbody.appendChild(row);
    }
    
    // Add click handlers for student names
    document.querySelectorAll('.student-name-link').forEach(el => {
        el.addEventListener('click', async (e) => {
            const userId = el.dataset.userId;
            const student = analyticsData.students.find(s => s.id === userId);
            if (student) {
                await loadStudentDetails(userId, student.name);
            }
        });
    });
    
    // Add class average row
    if (analyticsData.classAverages && analyticsData.students.length > 0) {
        tfoot.style.display = 'table-footer-group';
        const classAvg = analyticsData.classAverages.domainAverages || {};
        let avgDomainHtml = '<div class="domain-mini-grid">';
        for (let i = 0; i < domains.length; i++) {
            const avg = classAvg[domains[i]] || '—';
            avgDomainHtml += `
                <div class="domain-mini-cell ${getCellClass(domains[i], framework)}">
                    <div class="domain-mini-label">${shortLabels[i]}</div>
                    <div>${avg}</div>
                </div>
            `;
        }
        avgDomainHtml += '</div>';
        
        const avgCompletion = analyticsData.students.reduce((sum, s) => sum + s.completedCount, 0) / analyticsData.students.length;
        tfoot.innerHTML = `
            <tr style="background: rgba(0, 0, 0, 0.3); font-weight: bold;">
                <td>Class Average</td>
                <td>—</td>
                <td>${avgCompletion.toFixed(1)}/${analyticsData.students[0]?.targetTotal || 22}</td>
                <td>—</td>
                <td>${avgDomainHtml}</td>
                <td>—</td>
            </tr>
        `;
    }
}
// Update quests table (top 10 popular)
let currentQuestPage = 1;
const QUESTS_PER_PAGE = 10;
async function updateQuestsTable() {
    const tbody = document.getElementById('analytics-quests-tbody');
    const framework = analyticsData.framework;
    
    if (!tbody) return;
    
    const sortedQuests = analyticsData.sortedQuests || [];
    
    if (sortedQuests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7">No quest data available...</td></tr>';
        return;
    }
    
    // Pagination
    const totalPages = Math.ceil(sortedQuests.length / QUESTS_PER_PAGE);
    const startIndex = (currentQuestPage - 1) * QUESTS_PER_PAGE;
    const pageQuests = sortedQuests.slice(startIndex, startIndex + QUESTS_PER_PAGE);
    
    // Update pagination controls
    updatePaginationControls(totalPages);
    
    // Get domain keys
    let domains = [];
    let shortLabels = [];
    if (framework === 'ib-myp') {
        domains = ['A', 'B', 'C', 'D'];
        shortLabels = ['A', 'B', 'C', 'D'];
    } else if (framework === 'igcse') {
        domains = ['AO1', 'AO2', 'AO3', 'AO4'];
        shortLabels = ['AO1', 'AO2', 'AO3', 'AO4'];
    } else {
        domains = ['creating', 'presenting', 'responding', 'connecting'];
        shortLabels = ['Cr', 'Pr', 'Re', 'Cn'];
    }
    
    const getCellClass = (domain, framework) => {
        if (framework === 'ib-myp') {
            const mapping = { 'A': 'grade-cell-creating', 'B': 'grade-cell-presenting', 'C': 'grade-cell-responding', 'D': 'grade-cell-connecting' };
            return mapping[domain] || '';
        } else if (framework === 'igcse') {
            const mapping = { 'AO1': 'grade-cell-creating', 'AO2': 'grade-cell-presenting', 'AO3': 'grade-cell-responding', 'AO4': 'grade-cell-connecting' };
            return mapping[domain] || '';
        } else {
            const mapping = { 'creating': 'grade-cell-creating', 'presenting': 'grade-cell-presenting', 'responding': 'grade-cell-responding', 'connecting': 'grade-cell-connecting' };
            return mapping[domain] || '';
        }
    };
    
    tbody.innerHTML = '';
    
    for (const quest of pageQuests) {
        const row = document.createElement('tr');
        
        // Build domain grades HTML
        let domainHtml = '<div class="domain-mini-grid">';
        for (let i = 0; i < domains.length; i++) {
            const grade = quest.domainAverages?.[domains[i]] || '—';
            domainHtml += `
                <div class="domain-mini-cell ${getCellClass(domains[i], framework)}">
                    <div class="domain-mini-label">${shortLabels[i]}</div>
                    <div>${grade}</div>
                </div>
            `;
        }
        domainHtml += '</div>';
        
        row.innerHTML = `
            <td class="quest-name-link" data-quest-id="${quest.id}">${escapeHtml(quest.title)}</td>
            <td>${escapeHtml(quest.path)}</td>
            <td>${quest.type}</td>
            <td>${quest.completedCount}/${quest.totalStudents} (${quest.completionPercentage}%)</td>
            <td>—</td>
            <td>${domainHtml}</td>
            <td>${quest.popularity}</td>
        `;
        
        tbody.appendChild(row);
    }
    
    // Add click handlers for quest names
    document.querySelectorAll('.quest-name-link').forEach(el => {
        el.addEventListener('click', async (e) => {
            const questId = el.dataset.questId;
            const allQuests = await getQuests();
            openQuestDetailsPanel(questId, allQuests);
        });
    });
}
// Update pagination controls
function updatePaginationControls(totalPages) {
    const container = document.getElementById('analytics-pagination');
    if (!container) return;
    
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    
    let html = '';
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="pagination-btn ${i === currentQuestPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    container.innerHTML = html;
    
    // Add click handlers
    container.querySelectorAll('.pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            currentQuestPage = parseInt(btn.dataset.page);
            await updateQuestsTable();
        });
    });
}
// Export Analytics to CVS
async function exportAnalyticsToCSV() {
    console.log("Exporting analytics data to CSV...");
    
    // Get all quests (for complete export)
    const allQuests = await getQuests();
    const framework = analyticsData.framework;
    
    // Get domain info for headers
    let domainHeaders = [];
    if (framework === 'ib-myp') {
        domainHeaders = ['A: Knowing & Understanding', 'B: Developing Skills', 'C: Thinking Creatively', 'D: Responding'];
    } else if (framework === 'igcse') {
        domainHeaders = ['AO1: Record', 'AO2: Explore & Select', 'AO3: Develop', 'AO4: Present'];
    } else {
        domainHeaders = ['Creating (Cr)', 'Presenting (Pr)', 'Responding (Re)', 'Connecting (Cn)'];
    }
    
    // ========== STUDENTS SHEET ==========
    const studentsData = [];
    
    // Headers for students sheet
    const studentHeaders = ['Student Name', 'Class', 'Quests Completed', 'Target Quests', 'Completion %', 'Active Quest', ...domainHeaders, 'Last Upload'];
    studentsData.push(studentHeaders);
    
    for (const student of analyticsData.students) {
        const targetTotal = student.targetTotal || 22;
        const completionPercent = targetTotal > 0 ? Math.round((student.completedCount / targetTotal) * 100) : 0;
        
        const row = [
            student.name,
            student.className,
            student.completedCount,
            targetTotal,
            `${completionPercent}%`,
            student.activeQuest || 'None',
            student.domainGrades[Object.keys(student.domainGrades)[0]] || '—',
            student.domainGrades[Object.keys(student.domainGrades)[1]] || '—',
            student.domainGrades[Object.keys(student.domainGrades)[2]] || '—',
            student.domainGrades[Object.keys(student.domainGrades)[3]] || '—',
            student.lastUpload ? new Date(student.lastUpload).toLocaleDateString() : 'Never'
        ];
        studentsData.push(row);
    }
    
    // ========== QUESTS SHEET (ALL QUESTS) ==========
    const questsData = [];
    
    // Get all quests sorted by ID
    const allQuestIds = Object.keys(allQuests).filter(id => id.startsWith('quest')).sort();
    
    // Headers for quests sheet
    const questHeaders = ['Quest ID', 'Title', 'Path', 'Type', 'Completed Count', 'Total Students', 'Completion %', 'Popularity (Activated+Completed)', ...domainHeaders];
    questsData.push(questHeaders);
    
    for (const questId of allQuestIds) {
        const quest = allQuests[questId];
        const stats = analyticsData.questStats[questId] || {
            completedCount: 0,
            totalStudents: analyticsData.students.length,
            completionPercentage: 0,
            popularity: 0,
            domainAverages: {}
        };
        
        const completionPercent = stats.totalStudents > 0 ? ((stats.completedCount / stats.totalStudents) * 100).toFixed(1) : 0;
        
        const row = [
            questId,
            quest.title || 'Untitled',
            quest.path?.[0] || 'Unknown',
            quest.style === 'mvp' ? 'MVP (Summative)' : 'Formative',
            stats.completedCount,
            stats.totalStudents,
            `${completionPercent}%`,
            stats.popularity || 0,
            stats.domainAverages?.[Object.keys(stats.domainAverages || {})[0]] || '—',
            stats.domainAverages?.[Object.keys(stats.domainAverages || {})[1]] || '—',
            stats.domainAverages?.[Object.keys(stats.domainAverages || {})[2]] || '—',
            stats.domainAverages?.[Object.keys(stats.domainAverages || {})[3]] || '—'
        ];
        questsData.push(row);
    }
    
    // ========== CREATE CSV FILES ==========
    
    // Convert to CSV strings
    const studentsCSV = convertToCSV(studentsData);
    const questsCSV = convertToCSV(questsData);
    
    // Download students file
    downloadCSV(studentsCSV, `analytics_students_${new Date().toISOString().slice(0, 19)}.csv`);
    
    // Download quests file (small delay to avoid browser blocking)
    setTimeout(() => {
        downloadCSV(questsCSV, `analytics_quests_${new Date().toISOString().slice(0, 19)}.csv`);
    }, 100);
    
    alert("✅ Export complete! Two CSV files have been downloaded:\n- Students data\n- Quests data");
}
// Helper function to convert array to CSV string
function convertToCSV(data) {
    return data.map(row => 
        row.map(cell => {
            // Handle cells that contain commas or quotes
            if (typeof cell === 'string' && (cell.includes(',') || cell.includes('"') || cell.includes('\n'))) {
                return `"${cell.replace(/"/g, '""')}"`;
            }
            return cell;
        }).join(',')
    ).join('\n');
}
// Helper function to download CSV file
function downloadCSV(csvContent, filename) {
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}





//-----------------------------------------Other functions-----------------------------------------------------

//printing student's profile function
async function printStudentProfile(includeQuests = true) {
    if (!currentStudentId) {
        alert("No student selected.");
        return;
    }
    
    const student = await getStudentInfo(currentStudentId);
    if (!student) {
        alert("Student not found.");
        return;
    }
    // Make sure classId is included
    const studentWithClassId = {
        ...student,
        classId: student.classId  // Ensure this is passed
    };
    // Show loading indicator
    const loadingMsg = document.createElement('div');
    loadingMsg.textContent = 'Generating print preview...';
    loadingMsg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;color:#ffd700;padding:20px;border-radius:12px;z-index:10000;';
    document.body.appendChild(loadingMsg);
    
    try {
        // Generate HTML for print
        const printHtml = await generateStudentPrintHtml(student, includeQuests);
        
        // Open print window
        const printWindow = window.open('', '_blank');
        printWindow.document.write(printHtml);
        printWindow.document.close();
        
        // Wait for images to load then print
        printWindow.onload = () => {
            setTimeout(() => {
                printWindow.print();
                loadingMsg.remove();
            }, 500);
        };
    } catch (error) {
        console.error("Error generating print:", error);
        alert("Error generating print preview. Please try again.");
        loadingMsg.remove();
    }
}
// Get student info by ID
async function getStudentInfo(userId) {
    const auth = await checkTeacherAuth();
    if (!auth) return null;
    
    const { data: profile } = await window.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
    
    if (!profile) return null;
    
    // Get teacher name
    const { data: teacher } = await window.supabase
        .from('teachers')
        .select('name')
        .eq('class_code', profile.teacher_code)
        .single();
    
        // Get class name
        let className = 'No Class';
        let classId = null;
        if (profile.class_id) {
            const cls = teacherClasses.find(c => c.id === profile.class_id);
            if (cls) {
                className = cls.name;
                classId = profile.class_id; 
             }
    }
    
    return {
        id: profile.id,
        name: profile.name,
        email: profile.email || 'Not provided',
        avatar: profile.avatar_url || 'profile.png',
        teacherName: teacher?.name || 'Teacher',
        className: className,
        classId: classId,
        teacherCode: profile.teacher_code
    };
}
// Generate HTML for student print
async function generateStudentPrintHtml(student, includeQuests = true) {
    // Get framework and standards data
    const framework = await loadTeacherFramework();
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
    // Get student progress data
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('*')
        .eq('user_id', student.id)
        .single();
    
    const completedQuests = progress?.completed_quests || {};
    const questGrades = progress?.quest_grades || {};
    const earnedBadges = progress?.earned_badges || {};
    
    // Get all quests
    const allQuests = await getQuests();
    
    // Get class targets for this student
    const classTargets = await getClassTargets(student.classId);
    const targetTotal = classTargets.total;
    
    // Get completed quests list (only if includeQuests is true)
    let completedQuestList = [];
    if (includeQuests) {
        for (const [questId, isCompleted] of Object.entries(completedQuests)) {
            if (isCompleted === true) {
                const quest = allQuests[questId];
                if (quest) {
                    completedQuestList.push({
                        id: questId,
                        quest: quest,
                        grade: questGrades[questId]
                    });
                }
            }
        }
    }
    
    // Get badges data
    const badgesRes = await fetch('badges.json');
    const badgesData = (await badgesRes.json()).badges;
    
    // Generate standards table HTML
    const standardsHtml = await generateStandardsTableForPrint(student.id, framework);
    
    // Generate badges HTML
    const badgesHtml = generateBadgesForPrint(earnedBadges, badgesData);
    
    // Calculate student stats
    const totalCompleted = Object.keys(completedQuests).filter(qid => completedQuests[qid] === true).length;
    
    const statsHtml = `
        <div style="display: flex; gap: 20px; margin: 20px 0; flex-wrap: wrap;">
            <div style="background: #f5f5f5; padding: 15px; border-radius: 12px; flex: 1; text-align: center;">
                <div style="font-size: 12px; color: #666;">📚 Quests Completed</div>
                <div style="font-size: 28px; font-weight: bold; color: #4a6a8a;">${totalCompleted}</div>
                <div style="font-size: 11px; color: #999;">out of ${targetTotal} target</div>
            </div>
            <div style="background: #f5f5f5; padding: 15px; border-radius: 12px; flex: 1; text-align: center;">
                <div style="font-size: 12px; color: #666;">⏱️ Avg Time per Quest</div>
                <div style="font-size: 28px; font-weight: bold; color: #4a6a8a;">—</div>
                <div style="font-size: 11px; color: #999;">per completed quest</div>
            </div>
        </div>
    `;
    
    const notesHtml = `
        <h2>📝 Teacher Notes</h2>
        <div style="border: 1px solid #ccc; padding: 15px; min-height: 120px; margin: 20px 0; background: #fafafa; border-radius: 8px;">
            <p style="color: #666; margin-bottom: 8px;"><strong>Strengths:</strong></p>
            <p style="color: #666; margin-bottom: 15px;">_________________________________________</p>
            <p style="color: #666; margin-bottom: 8px;"><strong>Areas for Improvement:</strong></p>
            <p style="color: #666; margin-bottom: 15px;">_________________________________________</p>
            <p style="color: #666; margin-bottom: 8px;"><strong>Teacher's Signature:</strong></p>
            <p style="color: #666;">_________________________  Date: ___________</p>
            <p style="color: #666; margin-bottom: 15px;">                                         </p>
        </div>
    `;
    
    // Generate quests HTML only if includeQuests is true
    const questsHtml = includeQuests ? await generateCompletedQuestsForPrint(completedQuestList, framework) : '';
    
    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>${student.name} - Art Progress Report</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            body {
                font-family: Arial, Helvetica, sans-serif;
                background: white;
                color: black;
                padding: 20px;
            }
            .print-container {
                max-width: 1100px;
                margin: 0 auto;
            }
            .print-student-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 30px;
                border-bottom: 2px solid #333;
                padding-bottom: 15px;
            }
            .print-student-info h1 {
                font-size: 24px;
                margin-bottom: 8px;
                color: #1a1a2e;
            }
            .print-student-info p {
                margin: 5px 0;
                color: #333;
            }
            .print-student-avatar img {
                width: 80px;
                height: 80px;
                border-radius: 0;
                object-fit: contain;
                background: transparent;
            }
            h2 {
                font-size: 18px;
                margin: 20px 0 15px 0;
                color: #1a1a2e;
                border-left: 4px solid #4a6a8a;
                padding-left: 10px;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 20px;
            }
            th, td {
                border: 1px solid #ccc;
                padding: 8px;
                text-align: left;
                vertical-align: top;
            }
            th {
                background: #f0f0f0;
                font-weight: bold;
            }
            .badge-grid {
                display: flex;
                flex-wrap: wrap;
                gap: 20px;
                margin-top: 10px;
            }
            .badge-item {
                text-align: center;
                width: 80px;
            }
            .badge-item img {
                width: 60px;
                height: 60px;
                border-radius: 50%;
            }
            .badge-item .badge-name {
                font-size: 11px;
                margin-top: 5px;
                color: #333;
            }
            .badge-item.unearned img {
                opacity: 0.3;
                filter: grayscale(100%);
            }
            .badge-item.unearned .badge-name {
                color: #999;
            }
            .quest-section {
                margin-bottom: 30px;
                break-inside: avoid;
                page-break-inside: avoid;
            }
            .quest-section.mvp {
                border-left: 4px solid #ffd700;
                padding-left: 12px;
            }
            .quest-header {
                margin-bottom: 10px;
            }
            .quest-title {
                font-size: 16px;
                font-weight: bold;
                color: #1a1a2e;
            }
            .quest-path {
                font-size: 12px;
                color: #666;
                margin-left: 10px;
            }
            .highlight {
                background-color: #ffff99 !important;
                font-weight: bold !important;
            }
            @media print {
                body {
                    padding: 0;
                }
                .quest-section {
                    break-inside: avoid;
                    page-break-inside: avoid;
                }
                table {
                    break-inside: avoid;
                }
                .highlight {
                    background-color: #ffff99 !important;
                    font-weight: bold !important;
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
            }
        </style>
    </head>
    <body>
        <div class="print-container">
            <!-- Header -->
            <div class="print-student-header">
                <div class="print-student-info">
                    <h1>${escapeHtml(student.name)}</h1>
                    <p><strong>Email:</strong> ${escapeHtml(student.email)}</p>
                    <p><strong>Class:</strong> ${escapeHtml(student.className)}</p>
                    <p><strong>Teacher:</strong> ${escapeHtml(student.teacherName)}</p>
                </div>
                <div class="print-student-avatar">
                    <img src="${student.avatar}" alt="Avatar">
                </div>
            </div>
            
            <!-- Art Standards Table -->
            <h2>🎨 Art Standards Summary</h2>
            ${standardsHtml}
            
            <!-- Badges Earned -->
            <h2>🏆 Badges Earned</h2>
            ${badgesHtml}
            
            <!-- Stats Cards -->
            ${statsHtml}
            
            <!-- Teacher Notes -->
            ${notesHtml}
            
            <!-- Completed Quests (only if includeQuests is true AND there are quests) -->
            ${includeQuests && questsHtml ? '<h2>📋 Completed Quests</h2>' + questsHtml : ''}
        </div>
    </body>
    </html>`;
}// Generate standards table for print
async function generateStandardsTableForPrint(userId, framework) {
    // Get student progress
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests')
        .eq('user_id', userId)
        .single();
    
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    
    // Get all quests
    const allQuests = await getQuests();
    
    // Separate MVP and non-MVP quests
    const mvpQuests = [];
    const regularQuests = [];
    
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = allQuests[questId];
        if (!quest) continue;
        
        if (quest.style === 'mvp') {
            mvpQuests.push(questId);
        } else {
            regularQuests.push(questId);
        }
    }
    
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
    if (isIB) {
        // IB format
        const mvpScores = { A: 0, B: 0, C: 0, D: 0 };
        const mvpCounts = { A: 0, B: 0, C: 0, D: 0 };
        const regularScores = { A: 0, B: 0, C: 0, D: 0 };
        const regularCounts = { A: 0, B: 0, C: 0, D: 0 };
        
        for (const questId of regularQuests) {
            const quest = allQuests[questId];
            if (!quest || !quest.rubric?.criteria) continue;
            const grades = questGrades[questId]?.grade || {};
            quest.rubric.criteria.forEach(criterion => {
                const grade = grades[criterion.code];
                if (grade && typeof grade === 'number') {
                    regularScores[criterion.code] += grade;
                    regularCounts[criterion.code]++;
                }
            });
        }
        
        for (const questId of mvpQuests) {
            const quest = allQuests[questId];
            if (!quest || !quest.rubric?.criteria) continue;
            const grades = questGrades[questId]?.mvpGrade || {};
            quest.rubric.criteria.forEach(criterion => {
                const grade = grades[criterion.code];
                if (grade && typeof grade === 'number') {
                    mvpScores[criterion.code] += grade;
                    mvpCounts[criterion.code]++;
                }
            });
        }
        
        const criteria = [
            { code: "A", name: "Knowing & Understanding" },
            { code: "B", name: "Developing Skills" },
            { code: "C", name: "Thinking Creatively" },
            { code: "D", name: "Responding" }
        ];
        
        let html = `<table>
            <thead>
                <tr><th>Criterion</th><th>Description</th><th>Formative Grade</th><th>Summative Grade</th></tr>
            </thead>
            <tbody>`;
        
        for (const criterion of criteria) {
            const formativeAvg = regularCounts[criterion.code] ? (regularScores[criterion.code] / regularCounts[criterion.code]).toFixed(2) : '—';
            const summativeAvg = mvpCounts[criterion.code] ? (mvpScores[criterion.code] / mvpCounts[criterion.code]).toFixed(2) : '—';
            html += `<tr>
                <td><strong>${criterion.code}</strong></td>
                <td>${criterion.name}</td>
                <td>${formativeAvg}</td>
                <td>${summativeAvg}</td>
            </tr>`;
        }
        html += `</tbody></table>`;
        return html;
        
    } else if (isIGCSE) {
        // IGCSE format - all quests combined
        const allCompletedQuests = [...regularQuests, ...mvpQuests];
        const totalScores = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
        const totalCounts = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
        
        for (const questId of allCompletedQuests) {
            const quest = allQuests[questId];
            if (!quest || !quest.rubric?.assessment_objectives) continue;
            const column = quest.style === 'mvp' ? 'mvpGrade' : 'grade';
            const grades = questGrades[questId]?.[column] || {};
            quest.rubric.assessment_objectives.forEach(ao => {
                const grade = grades[ao.code];
                if (grade && typeof grade === 'number') {
                    totalScores[ao.code] += grade;
                    totalCounts[ao.code]++;
                }
            });
        }
        
        const aos = [
            { code: "AO1", name: "Record" },
            { code: "AO2", name: "Explore & Select" },
            { code: "AO3", name: "Develop" },
            { code: "AO4", name: "Present" }
        ];
        
        let html = `<table>
            <thead>
                <tr><th>Assessment Objective</th><th>Description</th><th>Grade</th></tr>
            </thead>
            <tbody>`;
        
        for (const ao of aos) {
            const avg = totalCounts[ao.code] ? (totalScores[ao.code] / totalCounts[ao.code]).toFixed(2) : '—';
            let displayGrade = avg;
            if (avg !== '—') {
                displayGrade = convertNumberToLetterGrade(Math.round(parseFloat(avg)));
            }
            html += `<tr>
                <td><strong>${ao.code}</strong></td>
                <td>${ao.name}</td>
                <td>${displayGrade}</td>
            </tr>`;
        }
        html += `</tbody></table>`;
        return html;
        
    } else {
        // NCAS format
        const mvpScores = {};
        const mvpCounts = {};
        const regularScores = {};
        const regularCounts = {};
        
        for (const questId of regularQuests) {
            const grades = questGrades[questId]?.grade || {};
            for (const [standard, grade] of Object.entries(grades)) {
                regularScores[standard] = (regularScores[standard] || 0) + grade;
                regularCounts[standard] = (regularCounts[standard] || 0) + 1;
            }
        }
        
        for (const questId of mvpQuests) {
            const grades = questGrades[questId]?.mvpGrade || {};
            for (const [standard, grade] of Object.entries(grades)) {
                mvpScores[standard] = (mvpScores[standard] || 0) + grade;
                mvpCounts[standard] = (mvpCounts[standard] || 0) + 1;
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
        
        let html = `<table>
            <thead>
                <tr><th>Standard Code</th><th>Standard Name</th><th>Formative Grade</th><th>Summative Grade</th></tr>
            </thead>
            <tbody>`;
        
        for (const standard of standards) {
            const formativeAvg = regularCounts[standard.code] ? (regularScores[standard.code] / regularCounts[standard.code]).toFixed(2) : '—';
            const summativeAvg = mvpCounts[standard.code] ? (mvpScores[standard.code] / mvpCounts[standard.code]).toFixed(2) : '—';
            html += `<tr>
                <td>${standard.code}</td>
                <td>${standard.name}</td>
                <td>${formativeAvg}</td>
                <td>${summativeAvg}</td>
            </tr>`;
        }
        html += `</tbody></table>`;
        return html;
    }
}
// Generate badges HTML for print (show all badges)
function generateBadgesForPrint(earnedBadges, badgesData) {
    const earnedBadgeIds = Object.keys(earnedBadges).filter(id => earnedBadges[id]?.earned === true);
    
    let html = '<div class="badge-grid">';
    
    for (const badge of badgesData) {
        const isEarned = earnedBadgeIds.includes(badge.id);
        
        html += `
            <div class="badge-item ${isEarned ? 'earned' : 'unearned'}">
                <img src="${badge.image}" alt="${badge.name}" style="${isEarned ? '' : 'opacity: 0.3; filter: grayscale(100%);'}">
                <div class="badge-name" style="${isEarned ? 'color: black;' : 'color: #999;'}">${escapeHtml(badge.name)}</div>
            </div>
        `;
    }
    html += '</div>';
    
    return html;
}
// Generate completed quests HTML for print
async function generateCompletedQuestsForPrint(completedQuestList, framework) {
    if (completedQuestList.length === 0) {
        return '<p>No completed quests yet.</p>';
    }
    
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
    let html = '';
    
    for (const item of completedQuestList) {
        const quest = item.quest;
        const questId = item.id;
        const gradeData = item.grade;
        const isMVP = quest.style === 'mvp';
        
        // Get grade level bands based on framework
        let gradeLevels = [];
        let itemsToShow = [];
        
        if (isIB) {
            itemsToShow = quest.rubric?.criteria || [];
            gradeLevels = ['7-8', '5-6', '3-4', '1-2'];
        } else if (isIGCSE) {
            itemsToShow = quest.rubric?.assessment_objectives || [];
            gradeLevels = ['A*-A', 'B-C', 'D-E', 'F-G'];
        } else {
            itemsToShow = quest.rubric?.standards || [];
            gradeLevels = ['4', '3', '2', '1'];
        }
        
        if (itemsToShow.length === 0) continue;
        
        // Determine which column to use
        const column = isMVP ? 'mvpGrade' : 'grade';
        const grades = gradeData?.[column] || {};
        
        const mvpClass = isMVP ? 'mvp' : '';
        
        html += `<div class="quest-section ${mvpClass}">
            <div class="quest-header">
                <span class="quest-title">${escapeHtml(quest.title)}</span>
                <span class="quest-path">(${escapeHtml(quest.path?.[0] || 'Unknown')} - ${isMVP ? 'MVP' : 'Formative'})</span>
            </div>
            <table class="quest-rubric-table">
                <thead>
                    <tr>
                        <th>${isIB ? 'Criterion' : (isIGCSE ? 'Assessment Objective' : 'Standard')}</th>
                        <th>${gradeLevels[0]}</th>
                        <th>${gradeLevels[1]}</th>
                        <th>${gradeLevels[2]}</th>
                        <th>${gradeLevels[3]}</th>
                    </tr>
                </thead>
                <tbody>`;
        
        for (const rubricItem of itemsToShow) {
            const studentGrade = grades[rubricItem.code] || '';
            
            // Determine which column to highlight based on student's grade
            let col1Highlight = '';
            let col2Highlight = '';
            let col3Highlight = '';
            let col4Highlight = '';
            let gradeDisplay = '—';
            
            if (studentGrade) {
                if (isIGCSE) {
                    const numGrade = Math.round(studentGrade);
                    gradeDisplay = convertNumberToLetterGrade(numGrade);
                    // Determine which band to highlight based on letter grade
                    if (gradeDisplay === 'A*' || gradeDisplay === 'A') {
                        col1Highlight = 'highlight';
                    } else if (gradeDisplay === 'B' || gradeDisplay === 'C') {
                        col2Highlight = 'highlight';
                    } else if (gradeDisplay === 'D' || gradeDisplay === 'E') {
                        col3Highlight = 'highlight';
                    } else if (gradeDisplay === 'F' || gradeDisplay === 'G') {
                        col4Highlight = 'highlight';
                    }
                } else {
                    gradeDisplay = studentGrade;
                    const gradeValue = Math.floor(studentGrade);
                    // For NCAS and IB, highlight the band column
                    if (gradeValue >= 7 || gradeValue === 4) {
                        col1Highlight = 'highlight';
                    } else if (gradeValue >= 5 || gradeValue === 3) {
                        col2Highlight = 'highlight';
                    } else if (gradeValue >= 3 || gradeValue === 2) {
                        col3Highlight = 'highlight';
                    } else if (gradeValue >= 1 || gradeValue === 1) {
                        col4Highlight = 'highlight';
                    }
                }
            }
            
            // Get the descriptor text without any extra HTML
            const level1Text = escapeHtml(rubricItem.levels?.[gradeLevels[0]] || '—');
            const level2Text = escapeHtml(rubricItem.levels?.[gradeLevels[1]] || '—');
            const level3Text = escapeHtml(rubricItem.levels?.[gradeLevels[2]] || '—');
            const level4Text = escapeHtml(rubricItem.levels?.[gradeLevels[3]] || '—');
            
            html += `<tr>
                <td><strong>${escapeHtml(rubricItem.code)}</strong>${rubricItem.name ? `: ${escapeHtml(rubricItem.name)}` : ''}</td>
                <td class="${col1Highlight}">${col1Highlight ? `<strong>${level1Text}</strong>` : level1Text}</td>
                <td class="${col2Highlight}">${col2Highlight ? `<strong>${level2Text}</strong>` : level2Text}</td>
                <td class="${col3Highlight}">${col3Highlight ? `<strong>${level3Text}</strong>` : level3Text}</td>
                <td class="${col4Highlight}">${col4Highlight ? `<strong>${level4Text}</strong>` : level4Text}</td>
            </tr>`;
        }
        
        html += `</tbody>
            </table>
        </div>`;
    }
    
    return html;
}
// Batch print all profiles (compact version - no quests)
async function printAllProfilesCompact() {
    await printAllProfilesBatch(false);
}
// Batch print all profiles (full version - with quests)
async function printAllProfilesFull() {
    await printAllProfilesBatch(true);
}
// Core batch print function
async function printAllProfilesBatch(includeQuests) {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    // Get filter value
    const classFilter = document.getElementById('analytics-class-filter')?.value || 'all';
    
    // Get students based on filter
    let query = window.supabase
        .from('profiles')
        .select('*')
        .eq('teacher_code', auth.teacher.class_code);
    
    if (classFilter !== 'all') {
        query = query.eq('class_id', classFilter);
    }
    
    const { data: students } = await query;
    
    if (!students || students.length === 0) {
        alert("No students found to print.");
        return;
    }
    
    const className = classFilter !== 'all' 
        ? teacherClasses.find(c => c.id === classFilter)?.name || 'Selected Class'
        : 'All Classes';
    
    const questsText = includeQuests ? 'with quests' : 'compact (no quests)';
    if (!confirm(`Print ${students.length} student profile(s) (${questsText}) from ${className}? This may take a moment.`)) {
        return;
    }
    
    // Show loading indicator
    const loadingMsg = document.createElement('div');
    loadingMsg.textContent = `Generating ${students.length} profile(s)... Please wait.`;
    loadingMsg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;color:#ffd700;padding:20px;border-radius:12px;z-index:10000;';
    document.body.appendChild(loadingMsg);
    
    try {
        // Generate HTML for each student and combine
        let allHtmlChunks = [];
        
        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            loadingMsg.textContent = `Generating profile ${i+1} of ${students.length}...`;
            
            const studentInfo = await getStudentInfo(student.id);
            if (!studentInfo) continue;
            
            // Generate complete HTML for this student
            const studentHtml = await generateStudentPrintHtml(studentInfo, includeQuests);
            
            // Extract just the body content but preserve structure
            const bodyMatch = studentHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
            const bodyContent = bodyMatch ? bodyMatch[1] : '';
            
            allHtmlChunks.push(`
                <div class="student-section" style="page-break-after: always; break-after: page;">
                    ${bodyContent}
                </div>
            `);
        }
        
        // Combine with full HTML wrapper
        const fullHtml = `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Class Progress Reports - ${className}</title>
            <style>
                /* All print styles - copied from generateStudentPrintHtml */
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body {
                    font-family: Arial, Helvetica, sans-serif;
                    background: white;
                    color: black;
                    padding: 20px;
                }
                .print-container {
                    max-width: 1100px;
                    margin: 0 auto;
                }
                .student-section {
                    margin-bottom: 40px;
                    page-break-after: always;
                    break-after: page;
                }
                .student-section:last-child {
                    page-break-after: auto;
                    break-after: auto;
                }
                .print-student-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 30px;
                    border-bottom: 2px solid #333;
                    padding-bottom: 15px;
                }
                .print-student-info h1 {
                    font-size: 24px;
                    margin-bottom: 8px;
                    color: #1a1a2e;
                }
                .print-student-info p {
                    margin: 5px 0;
                    color: #333;
                }
                .print-student-avatar img {
                    width: 80px;
                    height: 80px;
                    border-radius: 0;
                    object-fit: contain;
                    background: transparent;
                }
                h2 {
                    font-size: 18px;
                    margin: 20px 0 15px 0;
                    color: #1a1a2e;
                    border-left: 4px solid #4a6a8a;
                    padding-left: 10px;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-bottom: 20px;
                }
                th, td {
                    border: 1px solid #ccc;
                    padding: 8px;
                    text-align: left;
                    vertical-align: top;
                }
                th {
                    background: #f0f0f0;
                    font-weight: bold;
                }
                .badge-grid {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 20px;
                    margin-top: 10px;
                }
                .badge-item {
                    text-align: center;
                    width: 80px;
                }
                .badge-item img {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                }
                .badge-item .badge-name {
                    font-size: 11px;
                    margin-top: 5px;
                    color: #333;
                }
                .badge-item.unearned img {
                    opacity: 0.3;
                    filter: grayscale(100%);
                }
                .badge-item.unearned .badge-name {
                    color: #999;
                }
                .quest-section {
                    margin-bottom: 30px;
                    break-inside: avoid;
                    page-break-inside: avoid;
                }
                .quest-section.mvp {
                    border-left: 4px solid #ffd700;
                    padding-left: 12px;
                }
                .quest-header {
                    margin-bottom: 10px;
                }
                .quest-title {
                    font-size: 16px;
                    font-weight: bold;
                    color: #1a1a2e;
                }
                .quest-path {
                    font-size: 12px;
                    color: #666;
                    margin-left: 10px;
                }
                .highlight {
                    background-color: #ffff99 !important;
                    font-weight: bold !important;
                }
                @media print {
                    body {
                        padding: 0;
                    }
                    .student-section {
                        page-break-after: always;
                        break-after: page;
                    }
                    .quest-section {
                        break-inside: avoid;
                        page-break-inside: avoid;
                    }
                    table {
                        break-inside: avoid;
                    }
                    .highlight {
                        background-color: #ffff99 !important;
                        font-weight: bold !important;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }
                }
            </style>
        </head>
        <body>
            <div class="print-container">
                ${allHtmlChunks.join('')}
            </div>
        </body>
        </html>`;
        
        const printWindow = window.open('', '_blank');
        printWindow.document.write(fullHtml);
        printWindow.document.close();
        
        printWindow.onload = () => {
            setTimeout(() => {
                printWindow.print();
                loadingMsg.remove();
            }, 500);
        };
        
    } catch (error) {
        console.error("Error generating batch print:", error);
        alert("Error generating print preview. Please try again.");
        loadingMsg.remove();
    }
}
// Batch print all profiles (compact version - no quests)
async function printAllProfilesCompact() {
    await printAllProfilesBatch(false);
}
// Batch print all profiles (full version - with quests)
async function printAllProfilesFull() {
    await printAllProfilesBatch(true);
}
//---------------------------------------End of Printing functions-------------------------------------------------

// Convert number (1-8) to IGCSE letter grade
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
// Convert IGCSE letter grade to number (1-8)
function convertLetterGradeToNumber(letter) {
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
    return gradeMap[letter] || null;
}
function renderClassFilters() {
    const container = document.getElementById('class-filter-container');
    if (!container) return;
    
    let html = `<button class="class-filter-btn ${currentClassFilter === 'all' ? 'active' : ''}" data-class="all">📋 All Students</button>`;
    
    teacherClasses.forEach(cls => {
        html += `<button class="class-filter-btn ${currentClassFilter === cls.id ? 'active' : ''}" data-class="${cls.id}">📁 ${escapeHtml(cls.name)}</button>`;
    });
    
    container.innerHTML = html;
    
    container.querySelectorAll('.class-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentClassFilter = btn.dataset.class;
            renderClassFilters();
            loadAllStudents();
        });
    });
}
// Load and render student accordion by class
async function renderClassAccordion() {
    const auth = await checkTeacherAuth();
    if (!auth) return;
    
    const container = document.getElementById('class-accordion-container');
    if (!container) return;
    
    // Get all students
    const { data: students } = await window.supabase
        .from('profiles')
        .select('*')
        .eq('teacher_code', auth.teacher.class_code);
    
    // Get pending works
    const studentIds = students.map(s => s.id);
    const { data: pendingWorks } = await window.supabase
        .from('student_works')
        .select('user_id')
        .eq('grading_status', 'pending')
        .in('user_id', studentIds);
    
    const pendingSet = new Set(pendingWorks?.map(w => w.user_id) || []);
    
    // Group students by class
    const studentsByClass = {};
    const unassignedStudents = [];
    
    students.forEach(student => {
        if (student.class_id) {
            if (!studentsByClass[student.class_id]) studentsByClass[student.class_id] = [];
            studentsByClass[student.class_id].push(student);
        } else {
            unassignedStudents.push(student);
        }
    });
    
    container.innerHTML = '';
    
    // Helper function to create accordion (to avoid code duplication)
    function createAccordionItem(id, name, studentList, pendingSet) {
        const accordion = document.createElement('div');
        accordion.className = 'class-accordion-item';
        
        const pendingCount = studentList.filter(s => pendingSet.has(s.id)).length;
        
        const header = document.createElement('div');
        header.className = 'class-accordion-header';
        header.innerHTML = `
            <div>
                <span class="class-title">📋 ${escapeHtml(name)}</span>
                <span class="class-stats">(${studentList.length} student${studentList.length !== 1 ? 's' : ''}${pendingCount > 0 ? `, ${pendingCount} pending` : ''})</span>
            </div>
            <span class="class-expand-icon">▼</span>
        `;
        
        const studentListDiv = document.createElement('div');
        studentListDiv.className = 'class-student-list';
        
        studentList.forEach(student => {
            const hasPending = pendingSet.has(student.id);
            const studentCard = document.createElement('div');
            studentCard.className = 'class-student-card';
            studentCard.dataset.userId = student.id;
            studentCard.innerHTML = `
                <img src="${student.avatar_url || 'profile.png'}" alt="${student.name}">
                <div class="class-student-info">
                    <div class="class-student-name">
                        ${escapeHtml(student.name)}
                        ${hasPending ? '<span class="pending-dot-small" title="Has pending work"></span>' : ''}
                    </div>
                    <div class="class-student-email">${student.email || ''}</div>
                </div>
            `;
            studentCard.addEventListener('click', () => loadStudentDetails(student.id, student.name));
            studentListDiv.appendChild(studentCard);
        });
        
        // Start collapsed (not expanded)
        let expanded = false;
        studentListDiv.classList.remove('expanded');
        
        header.addEventListener('click', () => {
            expanded = !expanded;
            if (expanded) {
                studentListDiv.classList.add('expanded');
                header.classList.add('expanded');
            } else {
                studentListDiv.classList.remove('expanded');
                header.classList.remove('expanded');
            }
        });
        
        accordion.appendChild(header);
        accordion.appendChild(studentListDiv);
        return accordion;
    }
    
    // Render class accordions
    for (const cls of teacherClasses) {
        const classStudents = studentsByClass[cls.id] || [];
        const accordion = createAccordionItem(cls.id, cls.name, classStudents, pendingSet);
        container.appendChild(accordion);
    }
    
    // Render "No Class" accordion for unassigned students
    if (unassignedStudents.length > 0) {
        const noClassAccordion = createAccordionItem('unassigned', 'No Class', unassignedStudents, pendingSet);
        container.appendChild(noClassAccordion);
    }
    
    if (students.length === 0) {
        container.innerHTML = '<div class="no-students">No students found</div>';
    }
}
// Create a class accordion item
function createClassAccordion(classId, className, students, pendingSet) {
    const accordion = document.createElement('div');
    accordion.className = 'class-accordion-item';
    
    const pendingCount = students.filter(s => pendingSet.has(s.id)).length;
    
    // Header
    const header = document.createElement('div');
    header.className = 'class-accordion-header';
    header.innerHTML = `
        <div>
            <span class="class-title">🗃️ ${escapeHtml(className)}</span>
            <span class="class-stats">(${students.length} student${students.length !== 1 ? 's' : ''}${pendingCount > 0 ? `, ${pendingCount} pending` : ''})</span>
        </div>
        <span class="class-expand-icon">▼</span>
    `;
    
    // Student list container
    const studentList = document.createElement('div');
    studentList.className = 'class-student-list';
    
    students.forEach(student => {
        const hasPending = pendingSet.has(student.id);
        const studentCard = document.createElement('div');
        studentCard.className = 'class-student-card';
        studentCard.dataset.userId = student.id;
        studentCard.innerHTML = `
            <img src="${student.avatar_url || 'profile.png'}" alt="${student.name}">
            <div class="class-student-info">
                <div class="class-student-name">
                    ${escapeHtml(student.name)}
                    ${hasPending ? '<span class="pending-dot-small" title="Has pending work"></span>' : ''}
                </div>
                <div class="class-student-email">${student.email || ''}</div>
            </div>
        `;
        studentCard.addEventListener('click', () => loadStudentDetails(student.id, student.name));
        studentList.appendChild(studentCard);
    });
    
    // Toggle expand/collapse
    let expanded = false;
    header.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) {
            studentList.classList.add('expanded');
            header.classList.add('expanded');
        } else {
            studentList.classList.remove('expanded');
            header.classList.remove('expanded');
        }
    });
    
    accordion.appendChild(header);
    accordion.appendChild(studentList);
    
    return accordion;
}
// Update loadAllStudents to use the new accordion
async function loadAllStudents() {
    await renderClassAccordion();
}
// Load classes from database
async function loadClasses() {
    const auth = await checkTeacherAuth();
    if (!auth) return [];
    
    const { data, error } = await window.supabase
        .from('classes')
        .select('*')
        .eq('teacher_id', auth.teacher.id)
        .order('name');
    
    if (error) {
        console.error("Error loading classes:", error);
        return [];
    }
    
    teacherClasses = data || [];
    console.log("Classes loaded:", teacherClasses.length);
    return teacherClasses;
}
// Load student profile data
async function loadStudentProfileData(userId) {
    const { data: profile, error } = await window.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
    
    if (error || !profile) return;
    
    document.getElementById('teacher-profile-avatar').src = profile.avatar_url || 'profile.png';
    document.getElementById('teacher-profile-name').textContent = profile.name;
    document.getElementById('teacher-profile-email').textContent = `Email: ${profile.email || 'Not provided'}`;
    document.getElementById('teacher-profile-code').textContent = `Teacher Code: ${profile.teacher_code || 'N/A'}`;
    
    await loadStudentStandardsData(userId);
    await loadStudentRewardsData(userId);
    await loadStudentBadgesData(userId);
}
// Load standards grades
async function loadStudentStandardsData(userId) {
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('quest_grades, completed_quests')
        .eq('user_id', userId)
        .single();
    
    const tbody = document.getElementById('teacher-standards-tbody');
    if (!tbody) return;
    
    const questGrades = progress?.quest_grades || {};
    const completedQuests = progress?.completed_quests || {};
    
    // Get quests data
    const allQuests = await getQuests();
    
    // Detect which framework the teacher is using
    const framework = await loadTeacherFramework();
    const isIB = framework === 'ib-myp';
    const isIGCSE = framework === 'igcse';
    
   // Reset table headers based on framework
    const table = document.getElementById('teacher-standards-table');
    if (table) {
        const thead = table.querySelector('thead');
        if (thead) {
            if (isIB) {
                thead.innerHTML = `
                    <tr>
                        <th>Criterion</th>
                        <th>Description</th>
                        <th>Formative Grade</th>
                        <th>Summative Grade</th>
                    </tr>
                `;
            } else if (isIGCSE) {
                thead.innerHTML = `
                    <tr>
                        <th>Assessment Objective</th>
                        <th>Description</th>
                        <th>Grade</th>
                    </tr>
                `;
            } else {
                // NCAS default
                thead.innerHTML = `
                    <tr>
                        <th>Standard Code</th>
                        <th>Standard Name</th>
                        <th>Formative Grade</th>
                        <th>Summative Grade</th>
                    </tr>
                `;
            }
        }
    }
    
    if (isIB) {
        await renderTeacherIBStandardsTable(tbody, questGrades, completedQuests, allQuests);
    } else if (isIGCSE) {
        await renderTeacherIGCSESTandardsTable(tbody, questGrades, completedQuests, allQuests);
    } else {
        await renderTeacherNCASStandardsTable(tbody, questGrades, completedQuests, allQuests);
    }
}
// NCAS Standards Table for Teacher
async function renderTeacherNCASStandardsTable(tbody, questGrades, completedQuests, allQuests) {
    // Separate MVP and non-MVP quests
    const mvpQuests = [];
    const regularQuests = [];
    
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = allQuests[questId];
        if (!quest) continue;
        
        if (quest.style === 'mvp') {
            mvpQuests.push(questId);
        } else {
            regularQuests.push(questId);
        }
    }
    
    // Calculate averages per standard
    const mvpScores = {};
    const mvpCounts = {};
    const regularScores = {};
    const regularCounts = {};
    
    for (const questId of mvpQuests) {
        const grades = questGrades[questId]?.mvpGrade || {};
        for (const [standard, grade] of Object.entries(grades)) {
            if (!mvpScores[standard]) mvpScores[standard] = 0;
            if (!mvpCounts[standard]) mvpCounts[standard] = 0;
            mvpScores[standard] += grade;
            mvpCounts[standard]++;
        }
    }
    
    for (const questId of regularQuests) {
        const grades = questGrades[questId]?.grade || {};
        for (const [standard, grade] of Object.entries(grades)) {
            if (!regularScores[standard]) regularScores[standard] = 0;
            if (!regularCounts[standard]) regularCounts[standard] = 0;
            regularScores[standard] += grade;
            regularCounts[standard]++;
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
            <td><strong>${standard.code}</strong></td>
            <td>${standard.name}</td>
            <td>${formativeAvg}</td>
            <td>${summativeAvg}</td>
`;        tbody.appendChild(row);
    }
}

// IB Standards Table for Teacher
async function renderTeacherIBStandardsTable(tbody, questGrades, completedQuests, allQuests) {
    // Separate MVP and non-MVP quests
    const mvpQuests = [];
    const regularQuests = [];
    
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = allQuests[questId];
        if (!quest) continue;
        
        if (quest.style === 'mvp') {
            mvpQuests.push(questId);
        } else {
            regularQuests.push(questId);
        }
    }
    
    // Initialize scores for IB criteria
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
    
    // Process all quests
    for (const questId of regularQuests) {
        const quest = allQuests[questId];
        if (!quest || !quest.rubric?.criteria) continue;
        
        const grades = questGrades[questId]?.grade || {};
        quest.rubric.criteria.forEach(criterion => {
            const grade = grades[criterion.code];
            addGradeToCriterion(criterion.code, grade, false);
        });
    }
    
    for (const questId of mvpQuests) {
        const quest = allQuests[questId];
        if (!quest || !quest.rubric?.criteria) continue;
        
        const grades = questGrades[questId]?.mvpGrade || {};
        quest.rubric.criteria.forEach(criterion => {
            const grade = grades[criterion.code];
            addGradeToCriterion(criterion.code, grade, true);
        });
    }
    
    const criteria = [
        { code: "A", name: "Knowing & Understanding" },
        { code: "B", name: "Developing Skills" },
        { code: "C", name: "Thinking Creatively" },
        { code: "D", name: "Responding" }
    ];
    
    // Update table headers for IB
    const table = document.getElementById('teacher-standards-table');
    if (table) {
        const thead = table.querySelector('thead');
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th>Criterion</th>
                    <th>Description</th>
                    <th>Formative Grade</th>
                    <th>Summative Grade</th>
                </tr>
            `;
        }
    }
    
    tbody.innerHTML = '';
    
    for (const criterion of criteria) {
        const formativeAvg = regularCounts[criterion.code] ? (regularScores[criterion.code] / regularCounts[criterion.code]).toFixed(2) : '—';
        const summativeAvg = mvpCounts[criterion.code] ? (mvpScores[criterion.code] / mvpCounts[criterion.code]).toFixed(2) : '—';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${criterion.code}</strong></td>
            <td>${criterion.name}</td>
            <td>${formativeAvg}</td>
            <td>${summativeAvg}</td>
        `;
        tbody.appendChild(row);
    }
}
// IGCSE Standards Table for Teacher
async function renderTeacherIGCSESTandardsTable(tbody, questGrades, completedQuests, allQuests) {
    // For IGCSE, all quests count toward the grade (no formative/summative distinction)
    // We'll combine all quests and show a single grade column
    
    const allCompletedQuests = [];
    
    for (const [questId, isCompleted] of Object.entries(completedQuests)) {
        if (!isCompleted) continue;
        const quest = allQuests[questId];
        if (!quest) continue;
        allCompletedQuests.push(questId);
    }
    
    // Initialize scores for IGCSE AOs
    const totalScores = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
    const totalCounts = { AO1: 0, AO2: 0, AO3: 0, AO4: 0 };
    
    function addGradeToAO(aoCode, grade) {
        if (!grade || isNaN(grade)) return;
        totalScores[aoCode] = (totalScores[aoCode] || 0) + grade;
        totalCounts[aoCode] = (totalCounts[aoCode] || 0) + 1;
    }
    
    // Process all completed quests (both formative and MVP count equally for IGCSE)
    for (const questId of allCompletedQuests) {
        const quest = allQuests[questId];
        if (!quest || !quest.rubric?.assessment_objectives) continue;
        
        // For IGCSE, use the appropriate column based on quest style
        const column = quest.style === "mvp" ? "mvpGrade" : "grade";
        const grades = questGrades[questId]?.[column] || {};
        
        quest.rubric.assessment_objectives.forEach(ao => {
            const grade = grades[ao.code];
            addGradeToAO(ao.code, grade);
        });
    }
    
    const assessmentObjectives = [
        { code: "AO1", name: "Record - Record ideas, observations and insights" },
        { code: "AO2", name: "Explore & Select - Explore and select appropriate resources, media and techniques" },
        { code: "AO3", name: "Develop - Develop ideas through investigations" },
        { code: "AO4", name: "Present - Present a personal and meaningful response" }
    ];
    
    // Update table headers for IGCSE (no Summative column)
    const table = document.getElementById('teacher-standards-table');
    if (table) {
        const thead = table.querySelector('thead');
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th>Assessment Objective</th>
                    <th>Description</th>
                    <th>Grade</th>
                </tr>
            `;
        }
    }
    
    tbody.innerHTML = '';
    
    for (const ao of assessmentObjectives) {
        const avgGrade = totalCounts[ao.code] ? (totalScores[ao.code] / totalCounts[ao.code]).toFixed(2) : '—';
        
        // Convert numeric average to letter grade for display
        let displayGrade = avgGrade;
        if (avgGrade !== '—') {
            const numAvg = parseFloat(avgGrade);
            displayGrade = convertNumberToLetterGrade(Math.round(numAvg));
        }
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${ao.code}</strong></td>
            <td>${ao.name}</td>
            <td>${displayGrade}</td>
        `;
        tbody.appendChild(row);
    }
}
// Load rewards data
async function loadStudentRewardsData(userId) {
    const { data: progress } = await window.supabase
        .from('student_progress')
        .select('quest_grades, standard_deductions')
        .eq('user_id', userId)
        .single();
    
    const container = document.getElementById('teacher-total-coins');
    if (!container) return;
    
    const questGrades = progress?.quest_grades || {};
    const standardDeductions = progress?.standard_deductions || {};
    
    console.log("standardDeductions loaded:", standardDeductions);
    
    // Calculate total earned from grades (10 coins per grade point)
    let totalEarned = 0;
    
    for (const [questId, questData] of Object.entries(questGrades)) {
        const regularGrades = questData.grade || {};
        const mvpGrades = questData.mvpGrade || {};
        
        for (const grade of Object.values(regularGrades)) {
            if (typeof grade === 'number' && !isNaN(grade)) {
                totalEarned += Math.round(grade * 10);
            }
        }
        for (const grade of Object.values(mvpGrades)) {
            if (typeof grade === 'number' && !isNaN(grade)) {
                totalEarned += Math.round(grade * 10);
            }
        }
    }
    
    // Calculate total deductions
    let totalDeductions = 0;
    for (const deduction of Object.values(standardDeductions)) {
        if (typeof deduction === 'number') {
            totalDeductions += deduction;
        }
    }
    
    console.log("totalEarned:", totalEarned);
    console.log("totalDeductions:", totalDeductions);
    
    const netRewards = Math.max(0, totalEarned - totalDeductions);
    
    container.innerHTML = `Total Coins: <strong>${netRewards} 💰</strong>`;
}
// Load badges data
async function loadStudentBadgesData(userId) {
    console.log("loadStudentBadgesData called with userId:", userId);
    
    // Get student name for tooltips
    const { data: profile } = await window.supabase
        .from('profiles')
        .select('name')
        .eq('id', userId)
        .single();
    
    const studentName = profile?.name || "Student";
    
    // Get progress data - including earned_badges
    const { data: progress, error: progressError } = await window.supabase
        .from('student_progress')
        .select('earned_badges')
        .eq('user_id', userId)
        .single();
    
    if (progressError) {
        console.error("Error loading badges from progress:", progressError);
    }
    
    const earnedBadges = progress?.earned_badges || {};
    console.log("Earned badges from database:", earnedBadges);
    
    const container = document.getElementById('teacher-badges-container');
    if (!container) return;
    
    // Load badges data from badges.json
    const badgesRes = await fetch('badges.json');
    const badgesData = (await badgesRes.json()).badges;
    
    container.innerHTML = '';
    const badgesGrid = document.createElement('div');
    badgesGrid.className = 'badge-container';
    
    // Sort badges by category
    const sortedBadges = [...badgesData].sort((a, b) => {
        const order = { path: 1, skill: 2, progression: 3, teacher: 4 };
        return (order[a.category] || 5) - (order[b.category] || 5);
    });
    
    let earnedCount = 0;
    
    for (const badge of sortedBadges) {
        const badgeSlot = document.createElement('div');
        badgeSlot.className = 'badge-slot';
        
        const earnedInfo = earnedBadges[badge.id];
        const isEarned = earnedInfo?.earned === true;
        
        if (isEarned) earnedCount++;
        
        const img = document.createElement('img');
        
        if (badge.progression && isEarned && earnedInfo?.image) {
            img.src = earnedInfo.image;
        } else if (badge.progression && !isEarned && earnedInfo?.count !== undefined) {
            img.src = badge.image;
            img.style.opacity = '0.3';
        } else {
            img.src = badge.image;
        }
        
        img.alt = badge.name;
        img.style.width = '60px';
        img.style.height = '60px';
        img.style.borderRadius = '50%';
        
        // Create tooltip text
        let tooltipText = '';
        if (isEarned) {
            if (badge.progression && earnedInfo?.tooltip) {
                tooltipText = earnedInfo.tooltip;
            } else if (badge.teacherAwarded) {
                tooltipText = `Teacher Award: ${badge.name}`;
            } else {
                tooltipText = badge.tooltipEarned ? badge.tooltipEarned.replace('{name}', studentName) : badge.name;
            }
        } else {
            if (badge.progression) {
                const count = earnedInfo?.count || 0;
                const nextLevel = badge.levels?.find(l => l.count > count);
                if (nextLevel) {
                    tooltipText = `Quest Completer: ${count}/${nextLevel.count} summatives completed. ${nextLevel.tooltip}`;
                } else {
                    tooltipText = badge.tooltipShadow || badge.name;
                }
            } else {
                tooltipText = badge.tooltipShadow || badge.name;
            }
        }
        
        badgeSlot.setAttribute('data-tooltip', tooltipText);
        
        if (isEarned) {
            badgeSlot.classList.add('earned');
        } else {
            badgeSlot.classList.add('shadow');
        }
        
        // For teacher-awarded badges, add click to award
        if (badge.teacherAwarded && !isEarned) {
            badgeSlot.style.cursor = 'pointer';
            badgeSlot.addEventListener('click', async (e) => {
                e.stopPropagation();
                console.log("Awarding badge. UserId:", userId);
                console.log("Badge being awarded:", badge);
                
                // Verify teacher password using the modal
                const isValid = await verifyTeacherPassword();
                if (!isValid) {
                    alert("Password verification failed. Badge not awarded.");
                    return;
                }
                
                console.log("Password correct, awarding badge to userId:", userId);
                
                // Get current progress
                const { data: progress, error: progressError } = await window.supabase
                    .from('student_progress')
                    .select('earned_badges')
                    .eq('user_id', userId)
                    .single();
                
                const updatedBadges = progress?.earned_badges || {};
                updatedBadges[badge.id] = {
                    earned: true,
                    teacherAwarded: true,
                    earnedAt: new Date().toISOString()
                };
                
                const { error: upsertError } = await window.supabase
                    .from('student_progress')
                    .upsert({
                        user_id: userId,
                        earned_badges: updatedBadges,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'user_id' });
                
                if (upsertError) {
                    alert("Error saving badge: " + upsertError.message);
                } else {
                    alert(`✅ Badge "${badge.name}" awarded!`);
                    await loadStudentBadgesData(userId);
                }
            });
        }
        
        badgeSlot.appendChild(img);
        badgesGrid.appendChild(badgeSlot);
    }
    
    container.appendChild(badgesGrid);
    console.log(`Displayed ${earnedCount} earned badges out of ${sortedBadges.length} total badges`);
}
// Delete all data for a specific quest
async function deleteQuestData(userId, questId, quest) {
    try {
        // Get current progress
        const { data: progress } = await window.supabase
            .from('student_progress')
            .select('quest_grades, completed_quests, earned_badges, quest_accepted, quest_start_times')
            .eq('user_id', userId)
            .single();
        
        if (!progress) return;
        
        let questGrades = progress.quest_grades || {};
        let completedQuests = progress.completed_quests || {};
        let questAccepted = progress.quest_accepted || {};
        let questStartTimes = progress.quest_start_times || {};
        
        // Delete grades for this quest
        if (questGrades[questId]) {
            delete questGrades[questId];
        }
        
        // Remove from completed quests
        if (completedQuests[questId]) {
            delete completedQuests[questId];
        }
        
        // Reset timer data
        if (questAccepted[questId]) {
            delete questAccepted[questId];
        }
        if (questStartTimes[questId]) {
            delete questStartTimes[questId];
        }
        
        // Update the database
        const { error: updateError } = await window.supabase
            .from('student_progress')
            .update({
                quest_grades: questGrades,
                completed_quests: completedQuests,
                quest_accepted: questAccepted,
                quest_start_times: questStartTimes,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);
        
        if (updateError) {
            console.error("Error updating progress:", updateError);
            alert("Error deleting grades: " + updateError.message);
            return;
        }
        
        // Delete student's work from student_works table
        const { error: deleteWorkError } = await window.supabase
            .from('student_works')
            .delete()
            .eq('user_id', userId)
            .eq('quest_id', questId);
        
        if (deleteWorkError) {
            console.error("Error deleting student work:", deleteWorkError);
            // Don't alert here, just log - grades were still deleted
        }
        
        alert(`✅ Quest data deleted successfully!\n\nAll grades and artwork for "${quest.title || questId}" have been removed.`);
        
    } catch (error) {
        console.error("Error in deleteQuestData:", error);
        alert("An error occurred while deleting quest data.");
    }
}
// Load student works gallery
async function loadStudentWorksData(userId) {
    const { data: works, error } = await window.supabase
        .from('student_works')
        .select('*')
        .eq('user_id', userId);
    
    const container = document.getElementById('student-works-gallery');
    if (!container) return;
    
    if (error || !works || works.length === 0) {
        container.innerHTML = '<div class="no-data">No artwork uploaded yet</div>';
        return;
    }
    
    // Load quests data to get titles
    const allQuests = await getQuests();    
    
    container.innerHTML = '';
    
    for (const work of works) {
        const quest = allQuests[work.quest_id];
        const questTitle = quest?.title || work.quest_id;
        
        const workItem = document.createElement('div');
        workItem.className = 'teacher-gallery-item';
        workItem.innerHTML = `
            <div class="teacher-gallery-thumbnail">
                <img src="${work.image_url || 'placeholder.png'}" alt="${work.title || 'Artwork'}">
            </div>
            <div class="teacher-gallery-info">
                <div class="teacher-gallery-title">${work.title || 'Untitled'}</div>
                <div class="teacher-gallery-quest">Quest: ${questTitle}</div>
                <button class="teacher-gallery-view-btn" data-quest="${work.quest_id}">View Details</button>
            </div>
        `;
        
        // Add click handler for view button
        const viewBtn = workItem.querySelector('.teacher-gallery-view-btn');
        viewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            viewStudentWork(userId, work.quest_id);
        });
        
        container.appendChild(workItem);
    }
}
// Initialize work modal event listeners
function initWorkModal() {
    const modal = document.getElementById('teacher-work-modal');
    const closeBtn = document.querySelector('.teacher-work-close');
    
    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.style.display = 'none';
        };
    }
    
    window.onclick = (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    };
}
// View student work
async function viewStudentWork(userId, questId) {
    const { data: work, error } = await window.supabase
        .from('student_works')
        .select('*')
        .eq('user_id', userId)
        .eq('quest_id', questId)
        .single();
    
    if (error || !work) {
        alert('No work found for this quest.');
        return;
    }
    
    const allQuests = await getQuests();    
    const quest = allQuests[questId];
    
    const content = document.getElementById('teacher-work-content');
    content.innerHTML = `
        <h3>${work.title || 'Untitled'}</h3>
        <div class="teacher-work-details">
            <p><strong>Quest:</strong> ${quest?.title || questId}</p>
            ${work.size ? `<p><strong>Size:</strong> ${work.size}</p>` : ''}
            ${work.media ? `<p><strong>Media:</strong> ${work.media}</p>` : ''}
            <p><strong>Submitted:</strong> ${new Date(work.uploaded_at).toLocaleString()}</p>
        </div>
        <p><strong>Description:</strong><br>${work.description || 'No description'}</p>
        ${work.image_url ? `<div class="teacher-work-image"><img src="${work.image_url}" alt="Student work"></div>` : ''}
    `;
    
    const modal = document.getElementById('teacher-work-modal');
    modal.style.display = 'flex';
    
    // Make sure close button works
    const closeBtn = modal.querySelector('.teacher-work-close');
    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.style.display = 'none';
        };
    }
}
// Setup Escape key handling for modals
function setupModalEscapeHandling() {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        
        // Order matters - check most specific modals first
        
        // 1. View Work Modal (teacher-work-modal)
        const workModal = document.getElementById('teacher-work-modal');
        if (workModal && workModal.style.display === 'flex') {
            workModal.style.display = 'none';
            e.preventDefault();
            return;
        }
        
        const questDetailsPanel = document.getElementById('quest-details-panel');
        if (questDetailsPanel && questDetailsPanel.style.display === 'block') {
            questDetailsPanel.style.display = 'none';
            e.preventDefault();
            return;
}
        // 2. Create Class Modal
        const createClassModal = document.getElementById('create-class-modal');
        if (createClassModal && createClassModal.style.display === 'flex') {
            createClassModal.style.display = 'none';
            e.preventDefault();
            return;
        }
        
        // 3. Password Verify Modal
        const passwordModal = document.getElementById('password-verify-modal');
        if (passwordModal && passwordModal.style.display === 'flex') {
            passwordModal.style.display = 'none';
            e.preventDefault();
            return;
        }
        
        // 4. Student Details Panel (profile)
        const detailsPanel = document.getElementById('student-details-panel');
        if (detailsPanel && detailsPanel.style.display === 'block') {
            detailsPanel.style.display = 'none';
            e.preventDefault();
            return;
        }
        
        // 5. Class Management Area
        const classManagementArea = document.getElementById('class-management-area');
        const studentsSection = document.querySelector('.students-section');
        if (classManagementArea && classManagementArea.style.display === 'block') {
            classManagementArea.style.display = 'none';
            if (studentsSection) studentsSection.style.display = 'block';
            e.preventDefault();
            return;
        }
        
        // 6. Restriction Popups
        const restrictionPopup = document.getElementById('restriction-popup');
        if (restrictionPopup && restrictionPopup.style.display === 'flex') {
            restrictionPopup.style.display = 'none';
            e.preventDefault();
            return;
        }
        
        const prerequisitePopup = document.getElementById('prerequisite-popup');
        if (prerequisitePopup && prerequisitePopup.style.display === 'flex') {
            prerequisitePopup.style.display = 'none';
            e.preventDefault();
            return;
        }
        
        const acceptRestrictionPopup = document.getElementById('accept-quest-restriction-popup');
        if (acceptRestrictionPopup && acceptRestrictionPopup.style.display === 'flex') {
            acceptRestrictionPopup.style.display = 'none';
            e.preventDefault();
            return;
        }
    });
}
// Logout teacher
async function teacherLogout() {
    await window.supabase.auth.signOut();
    window.location.href = '/index.html';
}
// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    const loginBtn = document.getElementById('teacher-login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', handleTeacherLogin);
    }
    const logoutBtn = document.getElementById('teacher-logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', teacherLogout);
    }
    const closeDetailsBtn = document.getElementById('close-details-btn');
    if (closeDetailsBtn) {
        closeDetailsBtn.addEventListener('click', () => {
            document.getElementById('student-details-panel').style.display = 'none';
        });
    }  
    const exportBtn = document.getElementById('export-analytics-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportAnalyticsToCSV);
    }
    // Save class settings button
    const saveClassSettingsBtn = document.getElementById('save-class-settings-btn');
    if (saveClassSettingsBtn) {
        saveClassSettingsBtn.addEventListener('click', saveAllClassSettings);
    }
    // Invite Student button
    const inviteStudentBtn = document.getElementById('invite-student-btn');
    if (inviteStudentBtn) {
        inviteStudentBtn.addEventListener('click', openInviteModal);
    }
    // Send invite button
    const sendInviteBtn = document.getElementById('send-invite-btn');
    if (sendInviteBtn) {
        sendInviteBtn.addEventListener('click', sendInvitation);
    }
    // Cancel button
    const cancelInviteBtn = document.getElementById('cancel-invite-btn');
    if (cancelInviteBtn) {
        cancelInviteBtn.addEventListener('click', () => {
            document.getElementById('invite-modal').style.display = 'none';
        });
    }
    // Close modal
    const closeInviteModal = document.querySelector('#invite-modal .teacher-work-close');
    if (closeInviteModal) {
        closeInviteModal.addEventListener('click', () => {
            document.getElementById('invite-modal').style.display = 'none';
        });
    }
    // Close when clicking outside
    const inviteModal = document.getElementById('invite-modal');
    if (inviteModal) {
        inviteModal.addEventListener('click', (e) => {
            if (e.target === inviteModal) {
                inviteModal.style.display = 'none';
            }
        });
    }
    // Toggle code visibility button
    const toggleCodeBtn = document.getElementById('toggle-code-visibility');
    if (toggleCodeBtn) {
        toggleCodeBtn.addEventListener('click', toggleClassCodeVisibility);
}
    // Print buttons for student profile
    const printCompactBtn = document.getElementById('print-student-compact-btn');
    if (printCompactBtn) {
        printCompactBtn.addEventListener('click', () => printStudentProfile(false)); // false = no quests
    }
    const printFullBtn = document.getElementById('print-student-full-btn');
    if (printFullBtn) {
        printFullBtn.addEventListener('click', () => printStudentProfile(true)); // true = with quests
    }
    // Batch print buttons in Analytics tab
    const printAllCompactBtn = document.getElementById('print-all-compact-btn');
    if (printAllCompactBtn) {
        printAllCompactBtn.addEventListener('click', printAllProfilesCompact);
    }
    const printAllFullBtn = document.getElementById('print-all-full-btn');
    if (printAllFullBtn) {
        printAllFullBtn.addEventListener('click', printAllProfilesFull);
    }    
    // Create Custom Quest button
    const createCustomQuestBtn = document.getElementById('create-custom-quest-btn');
    if (createCustomQuestBtn) {
        createCustomQuestBtn.addEventListener('click', openCreateCustomQuestModal);
    }
    
    // Save Custom Quest button
    const saveCustomQuestBtn = document.getElementById('save-custom-quest-btn');
    if (saveCustomQuestBtn) {
        saveCustomQuestBtn.addEventListener('click', saveCustomQuest);
    }
    
    // Cancel Custom Quest button
    const cancelCustomQuestBtn = document.getElementById('cancel-custom-quest-btn');
    if (cancelCustomQuestBtn) {
        cancelCustomQuestBtn.addEventListener('click', () => {
            document.getElementById('create-custom-quest-modal').style.display = 'none';
        });
    }
    
    // Close modal when clicking X
    const closeCustomModalBtn = document.querySelector('#create-custom-quest-modal .teacher-work-close');
    if (closeCustomModalBtn) {
        closeCustomModalBtn.addEventListener('click', () => {
            document.getElementById('create-custom-quest-modal').style.display = 'none';
        });
    }
    
    // Close modal when clicking outside
    const customModal = document.getElementById('create-custom-quest-modal');
    if (customModal) {
        customModal.addEventListener('click', (e) => {
            if (e.target === customModal) {
                customModal.style.display = 'none';
            }
        });
    }
    
    // Add requirement button
    const addRequirementBtn = document.getElementById('add-requirement-btn');
    if (addRequirementBtn) {
        addRequirementBtn.addEventListener('click', () => {
            const container = document.getElementById('custom-quest-requirements-list');
            const newItem = document.createElement('div');
            newItem.className = 'requirement-item';
            newItem.innerHTML = `
                <input type="text" class="requirement-input" placeholder="Requirement">
                <button type="button" class="remove-requirement-btn">✖</button>
            `;
            container.appendChild(newItem);
            
            // Add remove event listener to the new button
            const removeBtn = newItem.querySelector('.remove-requirement-btn');
            removeBtn.addEventListener('click', () => {
                newItem.remove();
            });
        });
    }
    
    // Add link button
    const addLinkBtn = document.getElementById('add-link-btn');
    if (addLinkBtn) {
        addLinkBtn.addEventListener('click', () => {
            const container = document.getElementById('custom-quest-links-list');
            const newItem = document.createElement('div');
            newItem.className = 'link-item';
            newItem.innerHTML = `
                <input type="text" class="link-type" placeholder="Type (e.g., Video sample)">
                <input type="url" class="link-url" placeholder="URL">
                <button type="button" class="remove-link-btn">✖</button>
            `;
            container.appendChild(newItem);
            
            // Add remove event listener to the new button
            const removeBtn = newItem.querySelector('.remove-link-btn');
            removeBtn.addEventListener('click', () => {
                newItem.remove();
            });
        });
    }
    
    // Add event listeners for class management buttons
    document.getElementById('delete-students-btn')?.addEventListener('click', toggleDeleteMode);
    // Update loadStudentDetails to store the current student ID
    const originalLoadStudentDetails = loadStudentDetails;
    loadStudentDetails = async function(userId, studentName) {
        currentStudentId = userId;
        originalLoadStudentDetails(userId, studentName);
    };
    setupMainTabs();
    initWorkModal();
    setupModalEscapeHandling();
    setupTeacherForgotPassword();
    setupQuestDetailsTabs();
    setupQuestDetailsClose();

    
    // Add bulk assign event listeners
    document.getElementById('bulk-assign-mode-btn')?.addEventListener('click', toggleBulkAssignMode);
    document.getElementById('bulk-assign-confirm')?.addEventListener('click', confirmBulkAssign);
    document.getElementById('bulk-cancel-btn')?.addEventListener('click', () => {
        bulkAssignMode = false;
        selectedStudentsForBulk.clear();
        renderClassManagementView();
        const bulkBtn = document.getElementById('bulk-assign-mode-btn');
        if (bulkBtn) {
            bulkBtn.classList.remove('active');
            bulkBtn.textContent = '✓ Bulk Assign Students';
        }
    });
        // Preload quests immediately after login
    async function preloadQuests() {
        console.log("Preloading quests...");
        await getQuests();
        console.log("Quests preloaded successfully");
    }
    
    // Tab switching event listeners
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            document.querySelectorAll('.teacher-tab-content').forEach(tab => {
                tab.style.display = 'none';
            });
            
            const activeTab = document.getElementById(`${tabId}-tab`);
            if (activeTab) {
                activeTab.style.display = 'block';
            }
            
            if (tabId === 'quests' && currentStudentId) {
                loadStudentProgressData(currentStudentId);
            }
        });
    });

        // Remove requirement button for existing rows
    document.querySelectorAll('.remove-requirement-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.target.closest('.requirement-item').remove();
        });
    });
    
    // Remove link button for existing rows
    document.querySelectorAll('.remove-link-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.target.closest('.link-item').remove();
        });
    });
    // Delete custom quest (using event delegation)
    document.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-custom-quest-btn')) {
            const questId = e.target.dataset.questId;
            const questTitle = e.target.dataset.questTitle;
            await deleteCustomQuest(questId, questTitle);
        }
    });
    // Check existing session on page load
    checkExistingSession();
 });
