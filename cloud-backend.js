/* CreativeBridge shared-cloud adapter.
 * Uses the Supabase client already loaded by index.html. No server secret belongs here.
 * Local/demo workspaces remain local; real accounts use shared Supabase tables/storage.
 */
(function () {
  const originalPersist = persist;
  const local = {
    submitProject,
    saveBrandProfile,
    applyToProject,
    assignInterestedCreative,
    inviteCreative,
    respondInvite,
    analyzeProject,
    setProgress,
    submitDeliverable,
    finishSubmitDeliverable,
    sendProjectMessage,
    completeProject,
    finishRevision,
    reopenProject,
    cancelInvitation,
    saveProjectQuote,
    toggleCreativeApproval,
    savePricing,
    resetPricing,
    viewProject,
    openDemo,
    logout,
    enterAccount,
    renderApp,
  };
  let suppressLocal = false;
  let realtimeChannel = null;
  let refreshTimer = null;
  let activeProjectId = null;
  let refreshing = false;

  function cloudAccount() {
    return !!(typeof cloudConfigured === 'function' && cloudConfigured() && !demoSession && cbCloudUser?.id && state?.userId === cbCloudUser.id);
  }
  function adminCloudAccount() { return cloudAccount() && state.role === 'admin'; }
  function fail(message) { notify(message || 'Something went wrong. Please try again.', true); }
  function getError(error, fallback) { return error?.message || fallback || 'Supabase request failed.'; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function splitSkills(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 40); }
  function safeArray(x) { return Array.isArray(x) ? x : []; }
  function numberOrNull(n) { return n === null || n === undefined || n === '' || !Number.isFinite(Number(n)) ? null : Number(n); }
  function mapPortfolio(p) {
    if (Array.isArray(p)) return p.map(x => ({ title: String(x?.title || ''), category: String(x?.category || ''), description: String(x?.description || ''), url: String(x?.url || '') }));
    return [];
  }
  function mapCreative(row, profile) {
    return {
      id: row.user_id,
      name: profile?.display_name || 'Creative professional',
      email: cbCloudUser?.id === row.user_id ? (cbCloudUser.email || '') : '',
      createdAt: row.created_at || profile?.created_at || new Date().toISOString(),
      headline: row.headline || 'Independent Creative',
      bio: row.bio || '',
      tier: row.experience_tier || 'Emerging',
      skills: safeArray(row.skills),
      tools: safeArray(row.tools),
      categories: safeArray(row.categories),
      availability: row.availability || 'Unavailable',
      capacity: Number(row.capacity || 0),
      priority: !!row.priority_agreement_accepted,
      rating: row.average_rating == null ? null : Number(row.average_rating),
      projects: Number(row.completed_projects || 0),
      emoji: '✦',
      portfolio: mapPortfolio(row.portfolio),
      startingFee: numberOrNull(row.starting_fee),
      approved: row.approval_status === 'approved',
      approvalStatus: row.approval_status || 'pending',
    };
  }
  function mapProject(row) {
    return {
      id: row.id,
      brandId: row.brand_id,
      brandName: row.brand_name || 'Brand',
      title: row.title,
      category: row.category,
      serviceId: row.service_id,
      description: row.description || '',
      deliverables: row.deliverables || '',
      skills: safeArray(row.required_skills),
      references: safeArray(row.reference_urls),
      publicListing: !!row.public_listing,
      budget: Number(row.budget || 0),
      deadline: row.deadline,
      complexity: row.complexity || 'Standard',
      tier: row.target_tier || 'Intermediate',
      urgency: row.urgency || 'Standard',
      base: Number(row.base_price || 0),
      creativeFee: Number(row.creative_fee || 0),
      platformFee: Number(row.platform_fee || 0),
      handlingFee: Number(row.handling_fee || 0),
      total: Number(row.total_price || 0),
      status: row.status || 'Submitted',
      invitedCreativeId: row.invited_creative_id || null,
      assignedCreativeId: row.assigned_creative_id || null,
      createdAt: row.created_at ? String(row.created_at).slice(0, 10) : today(),
      history: Array.isArray(row.history) ? row.history : [],
      messages: [],
      applications: [],
      interestedCreativeIds: [],
      deliverable: null,
    };
  }
  function toProjectInsert(p) {
    return {
      id: p.id,
      brand_id: p.brandId,
      brand_name: p.brandName,
      title: p.title,
      category: p.category,
      service_id: p.serviceId,
      description: p.description,
      deliverables: p.deliverables,
      required_skills: safeArray(p.skills),
      reference_urls: safeArray(p.references),
      public_listing: !!p.publicListing,
      budget: Number(p.budget || 0),
      deadline: p.deadline,
      complexity: p.complexity || 'Standard',
      target_tier: p.tier || 'Intermediate',
      urgency: p.urgency || 'Standard',
      history: safeArray(p.history),
    };
  }
  function quoteUpdate(p) {
    return {
      brand_name: p.brandName,
      title: p.title,
      category: p.category,
      service_id: p.serviceId,
      description: p.description,
      deliverables: p.deliverables,
      required_skills: safeArray(p.skills),
      reference_urls: safeArray(p.references),
      public_listing: !!p.publicListing,
      budget: Number(p.budget || 0),
      deadline: p.deadline,
      complexity: p.complexity || 'Standard',
      target_tier: p.tier || 'Intermediate',
      urgency: p.urgency || 'Standard',
      history: safeArray(p.history),
      updated_at: new Date().toISOString(),
    };
  }
  function cacheDb() {
    try { localStorage.setItem(DATA_KEY, JSON.stringify(db)); } catch (e) { console.warn('Could not save local cache', e); }
  }
  async function selectOrThrow(query, label) {
    const { data, error } = await query;
    if (error) throw new Error((label ? label + ': ' : '') + error.message);
    return data;
  }

  // This replaces profile-only hydration with a real, shared workspace load.
  hydrateCloudAccount = async function (authUser) {
    if (!cbSupabase || !authUser?.id) throw new Error('Please sign in to CreativeBridge again.');
    const profile = await selectOrThrow(
      cbSupabase.from('profiles').select('id,role,display_name,created_at').eq('id', authUser.id).single(),
      'Could not load your account'
    );
    const adminRow = await selectOrThrow(
      cbSupabase.from('admin_users').select('user_id').eq('user_id', authUser.id).maybeSingle(),
      'Could not verify admin access'
    );
    const role = adminRow ? 'admin' : profile.role;
    if (!['brand', 'creative', 'admin'].includes(role)) throw new Error('This account role is not supported.');

    const [profiles, creativeRows, brandRows, projectRows, appRows, messageRows, deliverableRows, transactionRows, settingsRows] = await Promise.all([
      selectOrThrow(cbSupabase.from('profiles').select('id,role,display_name,created_at'), 'Could not load user directory'),
      selectOrThrow(cbSupabase.from('creative_profiles').select('*'), 'Could not load creative profiles'),
      selectOrThrow(cbSupabase.from('brand_profiles').select('*'), 'Could not load brand profiles'),
      selectOrThrow(cbSupabase.from('projects').select('*').order('created_at', { ascending: false }), 'Could not load projects'),
      selectOrThrow(cbSupabase.from('project_applications').select('*').order('created_at', { ascending: false }), 'Could not load project applications'),
      selectOrThrow(cbSupabase.from('project_messages').select('*').order('created_at', { ascending: true }), 'Could not load project messages'),
      selectOrThrow(cbSupabase.from('project_deliverables').select('*').order('created_at', { ascending: false }), 'Could not load deliverables'),
      selectOrThrow(cbSupabase.from('platform_transactions').select('*').order('created_at', { ascending: false }), 'Could not load platform records'),
      selectOrThrow(cbSupabase.from('platform_settings').select('id,value').eq('id', 'pricing').maybeSingle(), 'Could not load platform settings'),
    ]);
    const profileMap = new Map((profiles || []).map(p => [p.id, p]));
    const brandMap = new Map((brandRows || []).map(b => [b.user_id, b]));
    const creativeMap = new Map();
    (creativeRows || []).forEach(cp => creativeMap.set(cp.user_id, mapCreative(cp, profileMap.get(cp.user_id))));
    const brands = (profiles || []).filter(p => p.role === 'brand' && (role === 'admin' || p.id === authUser.id)).map(p => {
      const bp = brandMap.get(p.id) || {};
      return { id: p.id, name: p.display_name || 'Brand', email: bp.contact_email || (p.id === authUser.id ? authUser.email : ''), industry: bp.industry || '', website: bp.website || '', createdAt: p.created_at || null };
    });
    const projects = (projectRows || []).map(mapProject);
    const projectMap = new Map(projects.map(p => [p.id, p]));
    (appRows || []).forEach(a => {
      const p = projectMap.get(a.project_id);
      if (!p) return;
      p.interestedCreativeIds.push(a.creative_id);
      p.applications.push({ creativeId: a.creative_id, status: a.status, at: a.created_at, coverMessage: a.cover_message || '' });
    });
    (messageRows || []).forEach(m => {
      const p = projectMap.get(m.project_id);
      if (!p) return;
      p.messages.push({ id: m.id, sender: m.sender_name || 'CreativeBridge user', senderRole: m.sender_role || '', senderId: m.sender_id, text: m.message_text, at: m.created_at });
    });
    const signedPaths = [];
    (deliverableRows || []).forEach(d => {
      const p = projectMap.get(d.project_id);
      if (!p || p.deliverable) return;
      p.deliverable = { id: d.id, note: d.note || '', url: d.external_url || '', storagePath: d.storage_path || '', fileName: d.file_name || '', mimeType: d.mime_type || '', byteSize: Number(d.byte_size || 0), status: d.status, reviewNote: d.review_note || '', submittedAt: d.created_at };
      if (d.storage_path) signedPaths.push({ project: p, path: d.storage_path });
    });
    for (const item of signedPaths) {
      try {
        const { data, error } = await cbSupabase.storage.from('deliverables').createSignedUrl(item.path, 3600);
        if (!error && data?.signedUrl && !item.project.deliverable.url) item.project.deliverable.url = data.signedUrl;
      } catch (e) { console.warn('Could not sign deliverable URL', e); }
    }
    const currentProfile = profileMap.get(authUser.id) || profile;
    if (role === 'brand') {
      const existing = brands.find(b => b.id === authUser.id) || { id: authUser.id, name: currentProfile.display_name || authUser.email?.split('@')[0] || 'Brand', email: authUser.email || '', industry: '', website: '' };
      if (!brands.some(b => b.id === authUser.id)) brands.push(existing);
    }
    if (role === 'creative' && !creativeMap.has(authUser.id)) {
      creativeMap.set(authUser.id, { id: authUser.id, name: currentProfile.display_name || authUser.email?.split('@')[0] || 'Creative', email: authUser.email || '', headline: 'Independent Creative', bio: '', tier: 'Emerging', skills: [], tools: [], categories: [], availability: 'Available', capacity: 1, priority: false, rating: null, projects: 0, emoji: '✦', portfolio: [], startingFee: null, approved: false, approvalStatus: 'pending' });
    }
    db = {
      ...db,
      accounts: [], brands,
      creatives: [...creativeMap.values()],
      projects,
      activities: projects.flatMap(p => safeArray(p.history).map((h, i) => ({ id: `${p.id}-${i}`, at: h.at || p.createdAt, text: `${p.title}: ${h.label || 'Project updated'}` }))).sort((a,b) => new Date(b.at) - new Date(a.at)).slice(0,100),
      transactions: (transactionRows || []).map(t => ({ id: t.id, projectId: t.project_id, platformFee: Number(t.platform_fee || 0), handlingFee: Number(t.handling_fee || 0), totalRevenue: Number(t.platform_fee || 0) + Number(t.handling_fee || 0), grossAmount: Number(t.gross_amount || 0), status: t.status, at: t.created_at })),
    };
    if (settingsRows?.value && role !== 'creative' && role !== 'brand') db.settings = settingsRows.value;
    else if (settingsRows?.value) db.settings = settingsRows.value;
    // Don't send freshly loaded records back to Supabase.
    suppressLocal = true; cacheDb(); suppressLocal = false;
    return { role, userId: authUser.id };
  };

  // Browser cache remains useful for page state, but real shared records are written explicitly below.
  persist = function (d = db) { originalPersist(d); };

  const originalRender = local.renderApp;
  renderApp = function () {
    originalRender();
    const live = cloudAccount();
    const badge = document.querySelector('.app-topbar .top-actions .tag');
    if (badge) { badge.textContent = live ? 'LIVE WORKSPACE' : 'DEMO MODE'; badge.className = 'tag ' + (live ? 'green' : 'gray'); }
    const help = document.querySelector('.sidebar-bottom .help-card span');
    if (help) help.textContent = live ? 'Your shared profile and project workspace are stored in CreativeBridge cloud services.' : 'This is an interactive demo. Sample data is saved in this browser only.';
    const resetButton = document.querySelector('.sidebar-bottom .side-link[onclick="resetDemo()"]');
    if (resetButton) resetButton.style.display = live ? 'none' : '';
  };

  async function reloadCloudWorkspace(repaint = true) {
    if (!cloudAccount() || refreshing) return;
    refreshing = true;
    try {
      const workspace = await hydrateCloudAccount(cbCloudUser);
      state.role = workspace.role; state.userId = workspace.userId;
      if (repaint) {
        renderApp();
        if (activeProjectId && document.querySelector('#modalRoot .modal')) local.viewProject(activeProjectId);
      }
    } catch (error) { console.error('CreativeBridge cloud refresh failed', error); }
    finally { refreshing = false; }
  }
  function scheduleRefresh(payload) {
    if (payload?.table === 'project_messages' && payload?.new?.project_id && activeProjectId && payload.new.project_id === activeProjectId) {
      // Refresh below will re-open the current project panel so the new message appears.
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => reloadCloudWorkspace(true), 450);
  }
  function subscribeRealtime() {
    if (!cloudAccount() || !cbSupabase) return;
    if (realtimeChannel) { cbSupabase.removeChannel(realtimeChannel); realtimeChannel = null; }
    realtimeChannel = cbSupabase.channel('creativebridge-live-' + cbCloudUser.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_applications' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_deliverables' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'creative_profiles' }, scheduleRefresh)
      .subscribe(status => { if (status === 'CHANNEL_ERROR') console.warn('Realtime is unavailable. Reload the page to refresh shared data.'); });
  }

  // Ensure a session is hydrated before the main app's startup restore runs.
  const originalRestoreCloudSession = restoreCloudSession;
  restoreCloudSession = async function () {
    if (!cloudConfigured()) { restoreLocalPrototypeSession(); return; }
    // Keep this listener synchronous; Supabase advises avoiding awaited network work inside auth callbacks.
    cbSupabase.auth.onAuthStateChange((event, session) => {
      window.CREATIVEBRIDGE_SUPABASE_SESSION = session || null;
      if (session?.user) cbCloudUser = session.user;
      if (event === 'SIGNED_OUT') { cbCloudUser = null; window.CREATIVEBRIDGE_SUPABASE_SESSION = null; }
      if (event === 'PASSWORD_RECOVERY') setTimeout(() => {
        openModal('Set a new password', `<form onsubmit="saveRecoveredPassword(event)"><div class="field"><label for="recoveredPassword">New password</label><input id="recoveredPassword" type="password" minlength="8" autocomplete="new-password" required><div class="help">Use at least 8 characters.</div></div><div class="field"><label for="recoveredPasswordConfirm">Confirm password</label><input id="recoveredPasswordConfirm" type="password" minlength="8" autocomplete="new-password" required></div><button class="btn btn-primary">Save new password</button></form>`, '');
      }, 0);
    });
    try {
      const { data, error } = await cbSupabase.auth.getSession();
      if (error) throw error;
      if (!data?.session?.user) { restoreLocalPrototypeSession(); return; }
      cbCloudUser = data.session.user; window.CREATIVEBRIDGE_SUPABASE_SESSION = data.session;
      const ws = await hydrateCloudAccount(data.session.user);
      state.role = ws.role; state.userId = ws.userId; state.page = 'dashboard'; demoSession = false;
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(ws)); } catch (_) {}
      hideAllViews(); document.getElementById('appShell').classList.remove('hidden'); renderApp(); subscribeRealtime();
    } catch (error) {
      console.error('Cloud session restore failed', error);
      restoreLocalPrototypeSession();
      if (error?.message) notify('Could not load shared workspace: ' + error.message, true);
    }
  };

  // Explicit project creation: real accounts write to the shared projects table.
  submitProject = async function (e) {
    if (!cloudAccount()) return local.submitProject(e);
    e.preventDefault();
    if (state.role !== 'brand') return fail('Only a brand account can submit a project.');
    const title = document.getElementById('ptitle').value.trim();
    const cat = document.getElementById('pcategory').value;
    const serviceId = document.getElementById('pservice').value;
    const desc = document.getElementById('pdescription').value.trim();
    const deliverables = document.getElementById('pdeliverables').value.trim();
    const deadline = document.getElementById('pdeadline').value;
    const budget = Number(document.getElementById('pbudget').value);
    if (!title || !desc || !deliverables || !deadline || !Number.isFinite(budget) || budget <= 0) return fail('Complete the required fields and enter a valid budget.');
    const complexity = document.getElementById('pcomplexity').value;
    const tier = document.getElementById('ptier').value;
    const urgency = document.getElementById('purgency').value;
    const skills = splitSkills(document.getElementById('pskills').value);
    const references = document.getElementById('pReferences').value.split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
    const publicListing = document.getElementById('pPublicListing').checked;
    const svc = SERVICES.find(s => s.id === serviceId) || SERVICES[0];
    const q = calcPrice({ serviceId, complexity, tier, urgency });
    const brand = curUser();
    const p = { id: 'p' + Date.now().toString(36), brandId: brand.id, brandName: brand.name, title, category: cat, serviceId, description: desc, deliverables, skills: skills.length ? skills : svc.skills, references, publicListing, budget, deadline, complexity, tier, urgency, base: q.base, creativeFee: q.creativeFee, platformFee: q.platformFee, handlingFee: q.handlingFee, total: q.total, status: 'Submitted', createdAt: today(), invitedCreativeId: null, assignedCreativeId: null, interestedCreativeIds: [], history: [{ at: new Date().toISOString(), label: `Project submitted by ${brand.name}` }], messages: [] };
    const { data, error } = await cbSupabase.from('projects').insert(toProjectInsert(p)).select('*').single();
    if (error) return fail('Project was not saved: ' + error.message);
    await reloadCloudWorkspace(false); state.selectedProject = data.id; state.page = 'projects'; renderApp(); notify('Project published to the shared CreativeBridge marketplace.'); subscribeRealtime();
  };

  applyToProject = async function (pid) {
    if (!cloudAccount()) return local.applyToProject(pid);
    if (state.role !== 'creative') return fail('Sign in as a creative to express interest.');
    const p = getProject(pid); if (!p || !p.publicListing || !['Submitted','Under Review','Matching','Awaiting Creative Response'].includes(p.status)) return fail('This project is no longer open for interest.');
    if (!curUser()?.approved) return fail('Your creative profile must be approved before applying. Complete your profile and contact CreativeBridge for review.');
    const { error } = await cbSupabase.from('project_applications').insert({ project_id: pid, creative_id: state.userId, cover_message: '' });
    if (error) { if (error.code === '23505') return fail('You have already expressed interest in this project.'); return fail('Could not send your application: ' + error.message); }
    await reloadCloudWorkspace(false); renderApp(); notify('Your interest was sent. The brand can now review your profile.');
  };

  assignInterestedCreative = async function (pid, cid) {
    if (!cloudAccount()) return local.assignInterestedCreative(pid, cid);
    if (state.role !== 'brand' && state.role !== 'admin') return fail('Only the project owner or platform admin can assign a creative.');
    const { error } = await cbSupabase.rpc('cb_assign_creative', { p_project_id: pid, p_creative_id: cid });
    if (error) return fail('Assignment failed: ' + error.message);
    await reloadCloudWorkspace(false); renderApp(); notify('Creative assigned. The project workspace and chat are now available.'); subscribeRealtime();
  };

  inviteCreative = async function (pid, cid) {
    if (!cloudAccount()) return local.inviteCreative(pid, cid);
    const { error } = await cbSupabase.rpc('cb_invite_creative', { p_project_id: pid, p_creative_id: cid });
    if (error) return fail('Invitation failed: ' + error.message);
    await reloadCloudWorkspace(false); renderApp(); notify('Invitation sent to the creative.'); subscribeRealtime();
  };

  respondInvite = async function (pid, accept) {
    if (!cloudAccount()) return local.respondInvite(pid, accept);
    const { error } = await cbSupabase.rpc('cb_respond_to_invitation', { p_project_id: pid, p_accept: !!accept });
    if (error) return fail('Could not respond to the invitation: ' + error.message);
    await reloadCloudWorkspace(false); renderApp(); notify(accept ? 'Invitation accepted. You are assigned to this project.' : 'Invitation declined. The project returned to matching.'); subscribeRealtime();
  };

  analyzeProject = async function (pid) {
    if (!cloudAccount()) return local.analyzeProject(pid);
    if (!adminCloudAccount()) return fail('Admin access is required to analyze the intake queue.');
    const { error } = await cbSupabase.rpc('cb_admin_set_project_status', { p_project_id: pid, p_status: 'Matching' });
    if (error) return fail('Could not move project to matching: ' + error.message);
    await reloadCloudWorkspace(false); state.selectedProject = pid; state.page = 'matching'; renderApp(); notify('Project moved to the matching workspace.');
  };

  saveBrandProfile = async function (e) {
    if (!cloudAccount()) return local.saveBrandProfile(e);
    e.preventDefault();
    const b = curUser();
    const displayName = document.getElementById('brandNameInput').value.trim();
    const industry = document.getElementById('brandIndustryInput').value.trim();
    const email = document.getElementById('brandEmailInput').value.trim();
    const website = document.getElementById('brandWebsiteInput')?.value.trim() || '';
    const { error: profileError } = await cbSupabase.from('profiles').update({ display_name: displayName }).eq('id', state.userId);
    if (profileError) return fail('Could not save company name: ' + profileError.message);
    const { error } = await cbSupabase.from('brand_profiles').upsert({ user_id: state.userId, industry, website, contact_email: email }, { onConflict: 'user_id' });
    if (error) return fail('Could not save company details: ' + error.message);
    await reloadCloudWorkspace(false); renderApp(); notify('Company profile saved to CreativeBridge.');
  };

  setProgress = async function (pid) {
    if (!cloudAccount()) return local.setProgress(pid);
    const { error } = await cbSupabase.rpc('cb_creative_change_project_status', { p_project_id: pid, p_status: 'In Progress' });
    if (error) return fail('Could not start the project: ' + error.message);
    await reloadCloudWorkspace(false); renderApp(); notify('Project marked In Progress.');
  };

  submitDeliverable = function (pid) {
    if (!cloudAccount()) return local.submitDeliverable(pid);
    openModal('Submit a deliverable', `<form id="deliverForm" onsubmit="finishSubmitDeliverable(event,'${String(pid).replace(/[^a-zA-Z0-9_-]/g,'')}')">
      <div class="notice">Upload a file (up to 150 MB) or provide a secure external link. Files are stored privately and are visible to project participants and authorized support.</div>
      <div class="field"><label for="deliverNote">Delivery note *</label><textarea id="deliverNote" required maxlength="3000" placeholder="Describe the version, edits, exports and any notes for the brand."></textarea></div>
      <div class="field"><label for="deliverFile">Upload file (optional)</label><input id="deliverFile" type="file" accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,application/pdf,application/zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"><span class="help">For larger videos, use an external file-sharing link if the upload limit is reached.</span></div>
      <div class="field"><label for="deliverUrl">External preview or download URL (optional)</label><input id="deliverUrl" type="url" placeholder="https://…"></div>
      <button class="btn btn-primary">Upload and submit for review</button></form>`, '');
  };

  finishSubmitDeliverable = async function (e, pid) {
    e.preventDefault();
    if (!cloudAccount()) return local.finishSubmitDeliverable(e, pid);
    const p = getProject(pid);
    if (!p || p.assignedCreativeId !== state.userId) return fail('Only the assigned creative can submit work to this project.');
    const note = document.getElementById('deliverNote').value.trim();
    const file = document.getElementById('deliverFile')?.files?.[0] || null;
    const externalUrl = document.getElementById('deliverUrl').value.trim();
    if (!file && !externalUrl) return fail('Choose a file or add an external URL.');
    if (file && file.size > 157286400) return fail('This file exceeds the 150 MB upload limit. Use an external file-sharing URL instead.');
    if (externalUrl && !/^https:\/\//i.test(externalUrl)) return fail('Use a valid HTTPS URL.');
    let storagePath = '';
    if (file) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'deliverable';
      storagePath = `${pid}/${state.userId}/${Date.now()}-${cleanName}`;
      const { error: uploadError } = await cbSupabase.storage.from('deliverables').upload(storagePath, file, { upsert: false, contentType: file.type || 'application/octet-stream', cacheControl: '3600' });
      if (uploadError) return fail('File upload failed: ' + uploadError.message);
    }
    const { data: deliverable, error: insertError } = await cbSupabase.from('project_deliverables').insert({
      project_id: pid, creative_id: state.userId, note, external_url: externalUrl, storage_path: storagePath,
      file_name: file?.name || '', mime_type: file?.type || '', byte_size: file?.size || 0
    }).select('*').single();
    if (insertError) return fail('Uploaded file could not be registered: ' + insertError.message);
    const { error: statusError } = await cbSupabase.rpc('cb_creative_change_project_status', { p_project_id: pid, p_status: 'Submitted for Review' });
    if (statusError) return fail('The submission was saved, but status did not update: ' + statusError.message + '. Please refresh and retry the status update.');
    closeModal(); await reloadCloudWorkspace(false); renderApp(); notify('Deliverable uploaded securely and sent to the brand for review.'); subscribeRealtime();
  };

  sendProjectMessage = async function (e, pid) {
    e.preventDefault();
    if (!cloudAccount()) return local.sendProjectMessage(e, pid);
    const p = getProject(pid); const text = document.getElementById('projectMessageInput')?.value.trim();
    const allowed = p && (state.role === 'admin' || (state.role === 'brand' && p.brandId === state.userId && !!p.assignedCreativeId) || (state.role === 'creative' && p.assignedCreativeId === state.userId));
    if (!allowed) return fail('Project chat is only available to the assigned brand and creative, plus authorized support.');
    if (!text) return fail('Write a message first.');
    const { error } = await cbSupabase.from('project_messages').insert({ project_id: pid, sender_id: state.userId, message_text: text });
    if (error) return fail('Message not sent: ' + error.message);
    activeProjectId = pid; await reloadCloudWorkspace(false); local.viewProject(pid); notify('Message sent.'); subscribeRealtime();
  };

  completeProject = async function (pid) {
    if (!cloudAccount()) return local.completeProject(pid);
    const p = getProject(pid); if (!p?.deliverable?.id) return fail('There is no uploaded deliverable to approve.');
    const { error } = await cbSupabase.rpc('cb_review_deliverable', { p_project_id: pid, p_deliverable_id: p.deliverable.id, p_action: 'approve', p_review_note: '' });
    if (error) return fail('Could not approve the deliverable: ' + error.message);
    closeModal(); await reloadCloudWorkspace(false); renderApp(); notify('Deliverable approved. Platform fee records updated; this does not process a real payment.'); subscribeRealtime();
  };

  finishRevision = async function (e, pid) {
    e.preventDefault();
    if (!cloudAccount()) return local.finishRevision(e, pid);
    const p = getProject(pid); const text = document.getElementById('revisionText').value.trim();
    if (!p?.deliverable?.id) return fail('No uploaded deliverable is available for review.');
    const { error } = await cbSupabase.rpc('cb_review_deliverable', { p_project_id: pid, p_deliverable_id: p.deliverable.id, p_action: 'revision', p_review_note: text });
    if (error) return fail('Could not send the revision request: ' + error.message);
    closeModal(); await reloadCloudWorkspace(false); renderApp(); notify('Revision request sent to the creative.'); subscribeRealtime();
  };

  reopenProject = async function (pid) {
    if (!cloudAccount()) return local.reopenProject(pid);
    if (!adminCloudAccount()) return fail('Admin access required.');
    const { error } = await cbSupabase.rpc('cb_admin_set_project_status', { p_project_id: pid, p_status: 'In Progress' });
    if (error) return fail('Could not reopen project: ' + error.message);
    closeModal(); await reloadCloudWorkspace(false); renderApp(); notify('Project returned to In Progress.');
  };

  cancelInvitation = async function (pid) {
    if (!cloudAccount()) return local.cancelInvitation(pid);
    if (!adminCloudAccount()) return fail('Admin access required.');
    const { error } = await cbSupabase.rpc('cb_admin_cancel_invitation', { p_project_id: pid });
    if (error) return fail('Could not cancel invitation: ' + error.message);
    await reloadCloudWorkspace(false); state.selectedProject = pid; renderApp(); notify('Invitation cancelled. Project returned to matching.');
  };

  saveProjectQuote = async function (e, pid) {
    if (!cloudAccount()) return local.saveProjectQuote(e, pid);
    e.preventDefault(); const p = getProject(pid); if (!p) return fail('Project not found.');
    if (state.role !== 'brand' && !adminCloudAccount()) return fail('Only the project owner or admin can update the quote.');
    const cat = document.getElementById('editCat').value, serviceId = document.getElementById('editService').value;
    const complexity = document.getElementById('editComplexity').value, tier = document.getElementById('editTier').value, urgency = document.getElementById('editUrgency').value;
    const q = calcPrice({ serviceId, complexity, tier, urgency });
    const updated = { ...p, category: cat, serviceId, complexity, tier, urgency, base: q.base, creativeFee: q.creativeFee, platformFee: q.platformFee, handlingFee: q.handlingFee, total: q.total, history: [...safeArray(p.history), { at: new Date().toISOString(), label: `Quote updated to ${money(q.total)}` }] };
    const { error } = await cbSupabase.from('projects').update(quoteUpdate(updated)).eq('id', pid);
    if (error) return fail('Quote could not be saved: ' + error.message);
    closeModal(); await reloadCloudWorkspace(false); renderApp(); notify('Updated project quote saved to the shared workspace.');
  };

  toggleCreativeApproval = async function (cid) {
    if (!cloudAccount()) return local.toggleCreativeApproval(cid);
    if (!adminCloudAccount()) return fail('Only a designated CreativeBridge administrator can approve profiles.');
    const c = getCreative(cid); if (!c) return fail('Creative profile not found.');
    const { error } = await cbSupabase.rpc('cb_admin_set_creative_approval', { p_user_id: cid, p_approved: !c.approved });
    if (error) return fail('Profile review failed: ' + error.message);
    await reloadCloudWorkspace(false); renderApp(); notify(!c.approved ? 'Creative approved and eligible for discovery.' : 'Creative marked pending.');
  };

  savePricing = async function (e) {
    if (!cloudAccount()) return local.savePricing(e);
    e.preventDefault(); if (!adminCloudAccount()) return fail('Only a designated administrator can update shared pricing.');
    SERVICES.forEach(s => db.settings.bases[s.id] = Number(document.getElementById('base_' + s.id).value));
    Object.keys(db.settings.complexity).forEach(k => db.settings.complexity[k] = Number(document.getElementById('cm_' + k).value));
    Object.keys(db.settings.experience).forEach(k => db.settings.experience[k] = Number(document.getElementById('em_' + k).value));
    Object.keys(db.settings.urgency).forEach(k => db.settings.urgency[k] = Number(document.getElementById('um_' + k).value));
    db.settings.serviceRate = Number(document.getElementById('serviceRate').value);
    db.settings.handlingFee = Number(document.getElementById('handlingFee').value);
    const { error } = await cbSupabase.rpc('cb_update_pricing_settings', { p_settings: db.settings });
    if (error) return fail('Pricing was not saved in the shared database: ' + error.message);
    cacheDb(); renderApp(); notify('Pricing rules saved for the platform.');
  };

  resetPricing = async function () {
    if (!cloudAccount()) return local.resetPricing();
    if (!adminCloudAccount()) return fail('Only a designated administrator can reset pricing.');
    db.settings = seedData().settings;
    const { error } = await cbSupabase.rpc('cb_update_pricing_settings', { p_settings: db.settings });
    if (error) return fail('Could not reset pricing: ' + error.message);
    cacheDb(); renderApp(); notify('Shared pricing reset to defaults.');
  };

  // Establish shared realtime subscriptions when explicit sign-in succeeds.
  enterAccount = function (role, userId) {
    const result = local.enterAccount(role, userId);
    if (cloudAccount()) subscribeRealtime();
    return result;
  };

  // Track the open project for live chat refreshes, and retain a fresh sample dataset for demo mode.
  viewProject = function (pid) {
    activeProjectId = pid;
    return local.viewProject(pid);
  };
  openDemo = function (role) {
    const hasSeedWorkspace = Array.isArray(db.brands) && db.brands.some(b => b.id === 'b1') && Array.isArray(db.creatives) && db.creatives.some(c => c.id === 'c1');
    if (!hasSeedWorkspace) { db = seedData(); cacheDb(); }
    return local.openDemo(role);
  };
  logout = async function () {
    if (realtimeChannel && cbSupabase) { try { await cbSupabase.removeChannel(realtimeChannel); } catch (_) {} realtimeChannel = null; }
    activeProjectId = null;
    return local.logout();
  };

  // The regular profile editor already calls this cloud sync after saving portfolio/profile changes.
  const originalSyncCreativeProfile = syncCreativeProfileToCloud;
  syncCreativeProfileToCloud = async function (c) {
    if (!cloudAccount() || state.role !== 'creative' || c?.id !== state.userId) return { ok: true, skipped: true };
    const row = {
      headline: c.headline || '', bio: c.bio || '', skills: safeArray(c.skills), tools: safeArray(c.tools),
      categories: (c.categories && c.categories.length) ? c.categories : inferredCategoriesForCreative(c),
      experience_tier: c.tier || 'Emerging', availability: c.availability || 'Unavailable',
      capacity: Math.max(0, Math.min(100, Number(c.capacity) || 0)), portfolio: safeArray(c.portfolio),
      starting_fee: c.startingFee ?? null, priority_agreement_accepted: !!c.priority,
    };
    const { error } = await cbSupabase.from('creative_profiles').update(row).eq('user_id', c.id);
    if (error) return { ok: false, error: error.message };
    const { error: profileError } = await cbSupabase.from('profiles').update({ display_name: c.name }).eq('id', c.id);
    if (profileError) return { ok: false, error: profileError.message };
    await reloadCloudWorkspace(false); return { ok: true };
  };

  // Record a brand's direct invitation / cancellation through trusted RPCs, never via local-only mutations.
  // Handle explicit cloud admin user promotion outside the app via a SQL statement in the setup guide.
  window.sendPasswordReset = async function () {
    if (!cloudConfigured()) return fail('Password recovery is available after Supabase is configured.');
    const email = document.getElementById('authEmail')?.value.trim().toLowerCase();
    if (!email) return setAuthMessage('Enter your email address first, then click Forgot password?', true);
    const { error } = await cbSupabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split('#')[0] });
    if (error) return setAuthMessage('Could not send the reset email: ' + error.message, true);
    setAuthMessage('If an account exists for that address, Supabase will send a password-reset link. Check your inbox and spam folder.', false);
  };
  window.saveRecoveredPassword = async function (e) {
    e.preventDefault();
    const password = document.getElementById('recoveredPassword')?.value || '';
    const confirm = document.getElementById('recoveredPasswordConfirm')?.value || '';
    if (password.length < 8) return fail('Use at least 8 characters.');
    if (password !== confirm) return fail('The passwords do not match.');
    const { error } = await cbSupabase.auth.updateUser({ password });
    if (error) return fail('Could not update the password: ' + error.message);
    closeModal(); notify('Password updated. You can now sign in with it.');
  };

  window.CREATIVEBRIDGE_CLOUD = {
    isConnected: () => cloudConfigured(),
    isLiveSession: () => cloudAccount(),
    refresh: () => reloadCloudWorkspace(true),
    subscribe: subscribeRealtime,
  };
})();
