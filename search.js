document.addEventListener('DOMContentLoaded', () => {
    // --- DEVELOPMENT SWITCH ---
    const IS_LOCAL_TESTING = false;
    
    // --- GLOBAL STATE & CONFIG ---
    let isExporting = false; // Flag to prevent multiple export actions
    const PDSL = {
        manifest: null,
        numericManifest: null,
        isFetching: false,
        allServerIds: [],
        loadedServers: [],
        currentIndex: 0,
        postFilters: [],
        currentSort: { key: 'profile.member_count', direction: 'desc' }
    };
    const SORT_KEY_MAP = {
        'profile.member_count': 'mc',
        'profile.online_count': 'oc'
    };
    const FIELD_ALIASES = { 'members': 'profile.member_count', 'online': 'profile.online_count', 'boosts': 'guild.premium_subscription_count', 'tier': 'guild.premium_tier', 'nsfw': 'guild.nsfw', 'verification': 'guild.verification_level', 'feature': 'guild.features', 'global_name': 'inviter.global_name', 'tag': 'profile.tag', 'trait': 'profile.traits' };
    const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'new', 'you', 'are', 'server', 'our', 'from', 'a', 'is', 'in', 'it', 'us', 'to', 'of', 'we']);
    const ALL_COLUMNS = [
        { id: 'guild.icon', header: 'Icon', default: true, sortable: false },
        { id: 'guild.name', header: 'Name', default: true, sortable: true },
        { id: 'guild.description', header: 'Description', default: true, sortable: false },
        { id: 'profile.member_count', header: 'Members', default: true, sortable: true },
        { id: 'profile.online_count', header: 'Online', default: true, sortable: true },
        { id: 'invite', header: 'Invite', default: true, sortable: false },
        { id: 'guild.id', header: 'Guild ID', default: false, sortable: true },
        { id: 'guild.nsfw', header: 'NSFW', default: false, sortable: true },
    ];
    let visibleColumns = new Set(ALL_COLUMNS.filter(c => c.default).map(c => c.id));

    // --- DOM ELEMENTS ---
    const searchInput = document.getElementById('searchInput');
    const searchButton = document.getElementById('searchButton');
    const resultsTableHead = document.getElementById('results-table-head');
    const resultsTableBody = document.getElementById('results-table-body');
    const columnControlsContainer = document.getElementById('column-controls');
    const exportButton = document.getElementById('exportButton');
    const statusText = document.getElementById('status-text');
    
    // --- UTILITIES ---
    const getNestedVal = (obj, path) => path.split('.').reduce((acc, part) => acc && acc[part] !== undefined && acc[part] !== null ? acc[part] : null, obj);
    const fetchJSON = (url) => fetch(url).then(res => res.ok ? res.json() : null).catch(err => { console.error(`Fetch error for ${url}:`, err); return null; });
    function bustCache(url) { if (PDSL.manifest && PDSL.manifest.last_updated) { return `${url}?v=${PDSL.manifest.last_updated}`; } return url; }
    
    // --- CORE INITIALIZATION ---
    async function init() {
        try {
            statusText.textContent = 'Loading manifest...';
            const manifestUrl = (IS_LOCAL_TESTING ? 'http://localhost:8000/pdsl/manifest.json' : './manifest.json') + `?t=${new Date().getTime()}`;
            PDSL.manifest = await fetchJSON(manifestUrl);
            if (!PDSL.manifest) throw new Error('Manifest not found!');
            
			const rootUrl = IS_LOCAL_TESTING ? 'http://localhost:8000/pdsl' : '.';
			const numericManifestUrl = bustCache(`${rootUrl}/numeric_manifest.json`);
			PDSL.numericManifest = await fetchJSON(numericManifestUrl);

            initializeControls();
            renderTableHeader();
            statusText.textContent = `Ready. ${PDSL.manifest.total_servers.toLocaleString()} servers indexed.`;
            performSearch(true);
        } catch (error) {
            console.error("Failed to initialize PDSL:", error);
            statusText.textContent = "Error: Could not load the search manifest. The service might be down.";
        }
    }

    // --- DYNAMIC URL BUILDERS ---
    function getRepoUrl(repoNum) { if (IS_LOCAL_TESTING) { const repoName = PDSL.manifest.repo_name_template.replace('{}', repoNum); return `http://localhost:8000${repoName}`; } return `${PDSL.manifest.repo_base_url}${PDSL.manifest.repo_name_template.replace('{}', repoNum)}`; }
    function getUrlForIndex(field, shardKey) { const repoNum = PDSL.manifest.index_shard_map[field] || 1; const fieldPath = field.replace(/\./g, '_'); const baseUrl = `${getRepoUrl(repoNum)}/index/${fieldPath}/${shardKey}.json`; return bustCache(baseUrl); }
	function getUrlForDataFile(internalId) {
		const dataShardInfo = PDSL.manifest.data_shard_map.find(m => m.start_id <= internalId && (!m.end_id || m.end_id >= internalId)) || PDSL.manifest.data_shard_map[0];
		const repoNum = dataShardInfo ? dataShardInfo.repo : 1;

		// --- THIS IS THE FIX ---
		// The batch ID must be calculated relative to the start of the shard it's in.
		const relativeId = internalId % PDSL.manifest.servers_per_shard;
		const batchId = Math.floor(relativeId / PDSL.manifest.docs_per_file);
		// --- END FIX ---

		const baseUrl = `${getRepoUrl(repoNum)}/data/d_${batchId}.json`;
		return bustCache(baseUrl);
	}
    
    // --- SEARCH LOGIC ---
    const simpleStem = (word) => (word.length > 3 && word.endsWith('s')) ? word.slice(0, -1) : word;
    function createQueryPlan(query) { const plan = { orGroups: [], postFilters: [] }; const orGroups = query.split(/ OR | \| /gi); for (const groupQuery of orGroups) { const conditions = []; const regex = /(-)?([a-zA-Z._]+:(?:"[^"]*"|[^ ]+)|"[^"]*"|[^ ]+)/g; let match; while ((match = regex.exec(groupQuery)) !== null) { const negated = match[1] === '-'; let term = match[2]; let field, value, isPhrase = false; if (term.startsWith('"') && term.endsWith('"')) { field = 'default'; value = term.slice(1, -1); isPhrase = true; } else if (term.includes(':')) { [field, ...valueParts] = term.split(':'); value = valueParts.join(':'); } else { const defaultTokens = term.toLowerCase().match(/\b[a-z0-9]{2,}\b/g) || []; for (const token of defaultTokens) { if (!STOP_WORDS.has(token)) conditions.push({ type: 'keyword', field: 'default', val: simpleStem(token), negated: false }); } continue; } field = FIELD_ALIASES[field] || field; if (!value) continue; const condition = { negated, field, value }; if (field === 'has' || field === 'missing') { condition.type = 'postFilter'; condition.op = field; condition.field = value; plan.postFilters.push(condition); } else if (isPhrase) { condition.type = 'postFilter'; condition.op = 'phrase'; plan.postFilters.push(condition); const tokens = value.toLowerCase().match(/\b[a-z0-9]{2,}\b/g) || []; tokens.forEach(token => { if (!STOP_WORDS.has(token)) conditions.push({ type: 'keyword', field: 'default', val: simpleStem(token), negated: false }); }); } else if (value.includes('..')) { const [start, end] = value.split('..').map(Number); if (!isNaN(start) && !isNaN(end)) conditions.push({ type: 'numericRange', field, start, end, negated }); } else { const numericMatch = value.match(/^(>=|>|<=|<)(\d+)$/); if (numericMatch) conditions.push({ type: 'numeric', field, op: numericMatch[1], val: parseInt(numericMatch[2], 10), negated }); else conditions.push({ type: 'keyword', field, val: simpleStem(value.toLowerCase()), negated }); } } if (conditions.length > 0) plan.orGroups.push(conditions); } return plan; }
	async function getIdsForCondition(condition) {
		if (condition.field === 'default') {
			const promises = ['guild.name', 'guild.description', 'profile.tag', 'profile.traits'].map(field => getIdsForCondition({ ...condition, field }));
			const pointerLists = await Promise.all(promises);
			return pointerLists.flat().filter(Boolean);
		}
		if (condition.type === 'numeric' || condition.type === 'numericRange') {
			if (!PDSL.numericManifest || !PDSL.numericManifest[condition.field]) return [];
			let targetValues = [];
			if (condition.type === 'numericRange') targetValues = PDSL.numericManifest[condition.field].filter(v => v >= condition.start && v <= condition.end);
			else if (condition.op === '>=') targetValues = PDSL.numericManifest[condition.field].filter(v => v >= condition.val);
			else if (condition.op === '<=') targetValues = PDSL.numericManifest[condition.field].filter(v => v <= condition.val);
			else if (condition.op === '>') targetValues = PDSL.numericManifest[condition.field].filter(v => v > condition.val);
			else if (condition.op === '<') targetValues = PDSL.numericManifest[condition.field].filter(v => v < condition.val);
			const pointerLists = await Promise.all(targetValues.map(val => getIdsForCondition({ type: 'keyword', field: condition.field, val })));
			return pointerLists.flat();
		}
		if (condition.type === 'keyword') {
			const SHARD_PREFIX_LENGTH = 2;
			const value = String(condition.val);
			const shardKey = value.length >= SHARD_PREFIX_LENGTH ? value.substring(0, SHARD_PREFIX_LENGTH) : '_';
			const fieldPath = condition.field.replace(/\./g, '_');

			// Create a fetch promise for every potential shard
			const promises = [];
			for (let i = 1; i <= PDSL.manifest.total_shards; i++) {
				const url = bustCache(`${getRepoUrl(i)}/index/${fieldPath}/${shardKey}.json`);
				promises.push(fetchJSON(url));
			}

			const shardResults = await Promise.all(promises);

			// Combine the results from all shards
			const combinedPointers = [];
			shardResults.forEach(shardData => {
				if (shardData && shardData[value]) {
					combinedPointers.push(...shardData[value]);
				}
			});
			return combinedPointers;
		}
		return [];
	}
    async function executeQueryPlan(plan) { let finalResultsMap = new Map(); for (let i = 0; i < plan.orGroups.length; i++) { const group = plan.orGroups[i]; const positiveConditions = group.filter(c => !c.negated); const negativeConditions = group.filter(c => c.negated); if (positiveConditions.length === 0) continue; let pointerLists = await Promise.all(positiveConditions.map(getIdsForCondition)); if (pointerLists.some(p => p.length === 0)) continue; let groupResultsMap = new Map(pointerLists[0].map(p => [p.id, p])); for (let j = 1; j < pointerLists.length; j++) { const nextIds = new Set(pointerLists[j].map(p => p.id)); for (const id of groupResultsMap.keys()) { if (!nextIds.has(id)) { groupResultsMap.delete(id); } } } for (const cond of negativeConditions) { const negativePointers = await getIdsForCondition(cond); const negativeIds = new Set(negativePointers.map(p => p.id)); if (negativeIds.size > 0) { for (const id of groupResultsMap.keys()) { if (negativeIds.has(id)) { groupResultsMap.delete(id); } } } } groupResultsMap.forEach((value, key) => { if (!finalResultsMap.has(key)) { finalResultsMap.set(key, value); } }); } let finalPointers = Array.from(finalResultsMap.values()); const sortKey = SORT_KEY_MAP[PDSL.currentSort.key]; if (sortKey) { finalPointers.sort((a, b) => { const valA = a[sortKey] || 0; const valB = b[sortKey] || 0; return PDSL.currentSort.direction === 'desc' ? valB - valA : valA - valB; }); } return finalPointers.map(p => p.id); }
    function applyPostFilters(serverItem) { if (!PDSL.postFilters || PDSL.postFilters.length === 0) return true; return PDSL.postFilters.every(cond => { let result = true; const fieldPath = `data.${cond.field}`; if (cond.op === 'phrase') { let textToSearch = ''; if (cond.field === 'default') { textToSearch = [ getNestedVal(serverItem, 'data.guild.name'), getNestedVal(serverItem, 'data.guild.description'), getNestedVal(serverItem, 'data.profile.tag'), ...(getNestedVal(serverItem, 'data.profile.traits') || []).map(t => t.label) ].join(' ').toLowerCase(); } else { textToSearch = (getNestedVal(serverItem, fieldPath) || '').toLowerCase(); } result = textToSearch.includes(cond.value.toLowerCase()); } else if (cond.op === 'has' || cond.op === 'missing') { const value = getNestedVal(serverItem, fieldPath); result = value !== null && value !== '' && (!Array.isArray(value) || value.length > 0); if (cond.op === 'missing') result = !result; } return cond.negated ? !result : result; }); }
    async function fetchAndRenderBatch() { if (PDSL.isFetching || PDSL.currentIndex >= PDSL.allServerIds.length) return; PDSL.isFetching = true; const batchSize = 20; const batchIds = PDSL.allServerIds.slice(PDSL.currentIndex, PDSL.currentIndex + batchSize); PDSL.currentIndex += batchSize; const fetchesByUrl = new Map(); batchIds.forEach(id => { const url = getUrlForDataFile(id); if (!fetchesByUrl.has(url)) fetchesByUrl.set(url, []); }); const dataPromises = Array.from(fetchesByUrl.keys()).map(url => fetchJSON(url)); const dataChunks = await Promise.all(dataPromises); const serverMap = new Map(dataChunks.flat().filter(Boolean).map(item => [item.internal_id, item])); batchIds.forEach(id => { const serverItem = serverMap.get(id); if (serverItem && applyPostFilters(serverItem)) { PDSL.loadedServers.push(serverItem); } }); updateDisplay(); PDSL.isFetching = false; }
    async function performSearch(isInitialLoad = false) { if (!PDSL.manifest) { statusText.textContent = "Search system not loaded. Please wait."; return; } const query = searchInput.value.trim(); if (query === "" && !isInitialLoad) return; resetSearchState(); statusText.textContent = 'Loading...'; try { if (query === "") { statusText.textContent = 'Loading most popular servers...'; const rootUrl = IS_LOCAL_TESTING ? 'http://localhost:8000/pdsl' : '.'; const sortedListUrl = bustCache(`${rootUrl}/all_servers_sorted_by_members.json`); const sortedIds = await fetchJSON(sortedListUrl); PDSL.allServerIds = sortedIds || []; } else { statusText.textContent = 'Executing query plan...'; const plan = createQueryPlan(query); PDSL.postFilters = plan.postFilters; const finalServerIds = await executeQueryPlan(plan); if (finalServerIds.length === 0) { statusText.textContent = 'No results found.'; exportButton.disabled = true; return; } statusText.textContent = `Found ${finalServerIds.length} potential servers. Loading...`; PDSL.allServerIds = finalServerIds; } await fetchAndRenderBatch(); } catch (error) { console.error("Query failed:", error); statusText.textContent = `Error: ${error.message}`; } }
    
    // --- UI & DISPLAY ---
    function resetSearchState() { PDSL.isFetching = false; PDSL.allServerIds = []; PDSL.currentIndex = 0; PDSL.postFilters = []; PDSL.loadedServers = []; resultsTableBody.innerHTML = ''; statusText.textContent = ''; exportButton.disabled = true; }
    function handleSortClick(colId) { const currentKey = PDSL.currentSort.key; const currentDir = PDSL.currentSort.direction; if (currentKey === colId) { PDSL.currentSort.direction = currentDir === 'asc' ? 'desc' : 'asc'; } else { PDSL.currentSort.key = colId; PDSL.currentSort.direction = 'desc'; } if (SORT_KEY_MAP[PDSL.currentSort.key] || SORT_KEY_MAP[currentKey] ) { performSearch(searchInput.value.trim() === ''); } else { updateDisplay(); } }
    function updateSortIndicators() { document.querySelectorAll('#results-table-head th').forEach(th => { th.classList.remove('sorted', 'asc', 'desc'); if (th.dataset.columnId === PDSL.currentSort.key) { th.classList.add('sorted', PDSL.currentSort.direction); } }); }
    function renderTableHeader() { resultsTableHead.innerHTML = ''; const tr = document.createElement('tr'); ALL_COLUMNS.forEach(col => { if (visibleColumns.has(col.id)) { const th = document.createElement('th'); th.textContent = col.header; th.dataset.columnId = col.id; if (col.sortable) { th.classList.add('sortable'); th.addEventListener('click', () => handleSortClick(col.id)); const indicator = document.createElement('span'); indicator.className = 'sort-indicator'; th.appendChild(indicator); } tr.appendChild(th); } }); resultsTableHead.appendChild(tr); updateSortIndicators(); }
    function createResultRow(serverItem) { const tr = document.createElement('tr'); const s = serverItem.data; ALL_COLUMNS.forEach(col => { if (visibleColumns.has(col.id)) { const td = document.createElement('td'); let value = getNestedVal(s, col.id) ?? ''; if (col.id === 'invite') value = `https://discord.gg/${s.invite}`; if (col.id === 'guild.icon') value = s.guild?.icon ? `https://cdn.discordapp.com/icons/${s.id}/${s.guild.icon}.webp?size=64` : ''; if (col.id === 'invite') td.innerHTML = `<a href="${value}" target="_blank" rel="noopener noreferrer">${String(s.invite)}</a>`; else if (col.id === 'guild.icon') { td.className = 'icon-cell'; if (value) td.innerHTML = `<img src="${value}" alt="Server Icon" loading="lazy">`; } else td.textContent = Array.isArray(value) ? value.join(', ') : value; tr.appendChild(td); } }); return tr; }
    function updateDisplay() { const { key, direction } = PDSL.currentSort; if (key && !SORT_KEY_MAP[key]) { PDSL.loadedServers.sort((a, b) => { const valA = getNestedVal(a.data, key); const valB = getNestedVal(b.data, key); const isANull = valA === null || valA === ''; const isBNull = valB === null || valB === ''; if (isANull && isBNull) return 0; if (isANull) return 1; if (isBNull) return -1; const numA = parseFloat(String(valA)); const numB = parseFloat(String(valB)); if (!isNaN(numA) && !isNaN(numB)) return direction === 'desc' ? numB - numA : numA - numB; return direction === 'desc' ? String(valB).localeCompare(String(valA)) : String(valA).localeCompare(String(valB)); }); } resultsTableBody.innerHTML = ''; PDSL.loadedServers.forEach(serverItem => resultsTableBody.appendChild(createResultRow(serverItem))); statusText.textContent = `Showing ${PDSL.loadedServers.length} of ${PDSL.allServerIds.length} results...`; if (PDSL.loadedServers.length < PDSL.allServerIds.length) statusText.textContent += ' (scroll for more)'; updateSortIndicators(); exportButton.disabled = PDSL.allServerIds.length === 0 || isExporting; }

    // --- CSV EXPORT FUNCTIONALITY (REWRITTEN) ---
    function escapeCsvCell(cell) { let strCell = String(cell == null ? '' : cell); if (strCell.includes(',') || strCell.includes('"') || strCell.includes('\n')) { return `"${strCell.replace(/"/g, '""')}"`; } return strCell; }
    function generateAndDownloadCSV(serverList) { if (serverList.length === 0) { alert("No data to export after filtering."); return; } const orderedVisibleColumns = ALL_COLUMNS.filter(c => visibleColumns.has(c.id)); const headers = orderedVisibleColumns.map(col => col.header); const rows = serverList.map(serverItem => { return orderedVisibleColumns.map(col => { const s = serverItem.data; let value = getNestedVal(s, col.id); if (col.id === 'invite') value = `https://discord.gg/${s.invite}`; else if (col.id === 'guild.icon') value = s.guild?.icon ? `https://cdn.discordapp.com/icons/${s.id}/${s.guild.icon}.webp?size=64` : ''; else if (Array.isArray(value)) value = value.join('; '); return escapeCsvCell(value); }).join(','); }); const csvContent = [headers.join(','), ...rows].join('\r\n'); const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a"); const url = URL.createObjectURL(blob); link.setAttribute("href", url); const timestamp = new Date().toISOString().slice(0, 10); link.setAttribute("download", `pdsl-export-${timestamp}.csv`); link.style.visibility = 'hidden'; document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url); }
    async function fetchAllDataForExport() { const allIds = PDSL.allServerIds; const fetchesByUrl = new Map(); allIds.forEach(id => { const url = getUrlForDataFile(id); if (!fetchesByUrl.has(url)) { fetchesByUrl.set(url, []); } fetchesByUrl.get(url).push(id); }); const dataPromises = Array.from(fetchesByUrl.keys()).map(url => fetchJSON(url)); const dataChunks = await Promise.all(dataPromises); const serverMap = new Map(dataChunks.flat().filter(Boolean).map(item => [item.internal_id, item])); const allServerData = allIds.map(id => serverMap.get(id)).filter(Boolean); return allServerData; }
    async function handleExportClick() { if (isExporting || PDSL.allServerIds.length === 0) { return; } isExporting = true; exportButton.disabled = true; const originalButtonText = exportButton.textContent; exportButton.textContent = 'Preparing...'; const originalStatusText = statusText.textContent; try { statusText.textContent = `Fetching all ${PDSL.allServerIds.length} results for export... (this may take a moment)`; const allServerData = await fetchAllDataForExport(); const filteredData = allServerData.filter(applyPostFilters); const { key, direction } = PDSL.currentSort; if (key) { filteredData.sort((a, b) => { const valA = getNestedVal(a.data, key); const valB = getNestedVal(b.data, key); const isANull = valA === null || valA === ''; const isBNull = valB === null || valB === ''; if (isANull && isBNull) return 0; if (isANull) return 1; if (isBNull) return -1; const numA = parseFloat(String(valA)); const numB = parseFloat(String(valB)); if (!isNaN(numA) && !isNaN(numB)) return direction === 'desc' ? numB - numA : numA - numB; return direction === 'desc' ? String(valB).localeCompare(String(valA)) : String(valA).localeCompare(String(valB)); }); } statusText.textContent = `Generating CSV for ${filteredData.length} servers...`; generateAndDownloadCSV(filteredData); } catch (error) { console.error("Export failed:", error); alert("An error occurred during the export process. Please check the console for details."); } finally { isExporting = false; exportButton.textContent = originalButtonText; exportButton.disabled = PDSL.allServerIds.length === 0; statusText.textContent = originalStatusText; } }

    // --- EVENT LISTENERS & INITIALIZATION ---
    function initializeControls() { ALL_COLUMNS.forEach(col => { const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = visibleColumns.has(col.id); checkbox.dataset.columnId = col.id; checkbox.addEventListener('change', (e) => { e.target.checked ? visibleColumns.add(col.id) : visibleColumns.delete(col.id); renderTableHeader(); updateDisplay(); }); label.appendChild(checkbox); label.appendChild(document.createTextNode(col.header)); columnControlsContainer.appendChild(label); }); exportButton.addEventListener('click', handleExportClick); exportButton.disabled = true; }
    searchButton.addEventListener('click', () => performSearch(false));
    searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') performSearch(false); });
    window.addEventListener('scroll', () => { if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) { if (!isExporting && !PDSL.isFetching) fetchAndRenderBatch(); } });
    
    init();
});