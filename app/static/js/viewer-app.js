import { ApiClient } from "./api-client.js";
import { AssetCache } from "./asset-cache.js";
import { MapRenderer } from "./map-renderer.js";
import {
  ASSET_PATHS,
  SEARCH_RESULT_LIMIT,
  SERVER_SELECTION_STORAGE_KEY,
  STABLE_VIEWER_CONFIG,
  buildTokenStorageKey,
  TRIBE_FILTER_OPTIONS,
  TYPE_FILTER_OPTIONS,
  createEmptyBaseFilter,
  describeTribe,
  describeYardType,
  escapeHtml,
  formatDistance,
  formatNumber,
  getLocalViewerConfig,
  hasActiveBaseFilterState,
  normalizeApiVersion,
  normalizeBaseUrl,
  setViewerConfig,
} from "./shared.js";

const MAP_REFRESH_COOLDOWN_MS = 60_000;
const INITIAL_OVERLAY_MESSAGE = "Loading...";
const SIGNED_OUT_OVERLAY_MESSAGE = "Please log in.";

// This viewer's sibling for the other map room version — linked when an
// account's world doesn't match the one this viewer is built for.
const OTHER_VIEWER_URL = "https://bymr-maproom2-viewer.chibbluffy.fyi/";
const WRONG_MAP_VERSION_OVERLAY_MESSAGE = "This account is not on a Map Room 3 world.";
const WRONG_MAP_VERSION_MESSAGE =
  `${WRONG_MAP_VERSION_OVERLAY_MESSAGE} Please make sure it is on an ` +
  `upgraded map room, or try the other map viewer: ` +
  `<a href="${OTHER_VIEWER_URL}" target="_blank" rel="noopener">${OTHER_VIEWER_URL}</a>`;

export class ViewerApp {
  constructor() {
    this.api = null;
    this.assets = null;
    this.config = null;
    this.localConfig = null;
    this.session = null;
    this.worlds = [];
    this.leaderboardCache = new Map();
    this.leaderboardRequests = new Map();
    this.selectedWorldId = null;
    this.ownWorldId = null;
    this.hoveredCell = null;
    this.selectedCell = null;
    this.playerBaseIconUrl = "";
    this.searchEntries = [];
    this.searchMatches = [];
    this.searchActiveIndex = -1;
    this.playerFilterEntries = [];
    this.playerFilterMatches = [];
    this.playerFilterActiveIndex = -1;
    this.filterState = createEmptyBaseFilter();
    this.availableFilterLevels = [];
    this.filterMenuOpen = false;
    this.refreshInFlight = false;
    this.refreshCooldownUntil = 0;
    this.refreshCooldownTimer = 0;
    this.serverSelection = null;

    this.elements = {
      appRoot: document.getElementById("app"),
      serverSelect: document.getElementById("server-select"),
      serverCustomFields: document.getElementById("server-custom-fields"),
      serverHostInput: document.getElementById("server-host-input"),
      serverPortInput: document.getElementById("server-port-input"),
      emailInput: document.getElementById("email-input"),
      passwordInput: document.getElementById("password-input"),
      loginForm: document.getElementById("login-form"),
      loginButton: document.getElementById("login-button"),
      logoutButton: document.getElementById("logout-button"),
      sessionName: document.getElementById("session-name"),
      sessionStatus: document.getElementById("session-status"),
      sessionTriggerButton: document.getElementById("session-trigger-button"),
      sessionTriggerLabel: document.getElementById("session-trigger-label"),
      sessionPopover: document.getElementById("session-popover"),
      worldsToggleButton: document.getElementById("worlds-toggle-button"),
      worldsModal: document.getElementById("worlds-modal"),
      worldsCloseButton: document.getElementById("worlds-close-button"),
      worldList: document.getElementById("world-list"),
      leaderboardTitle: document.getElementById("leaderboard-title"),
      leaderboardList: document.getElementById("leaderboard-list"),
      cellDetailPanel: document.getElementById("cell-detail-panel"),
      detailsTitle: document.getElementById("details-title"),
      detailsContent: document.getElementById("details-content"),
      detailsCloseButton: document.getElementById("details-close-button"),
      mapCanvas: document.getElementById("map-canvas"),
      mapCoordinates: document.getElementById("map-coordinates"),
      mapOverlay: document.getElementById("map-overlay"),
      searchToggleButton: document.getElementById("search-toggle-button"),
      searchPanel: document.getElementById("search-panel"),
      searchInput: document.getElementById("search-input"),
      searchResults: document.getElementById("search-results"),
      searchStatus: document.getElementById("search-status"),
      filterToggleButton: document.getElementById("filter-toggle-button"),
      filterToggleLabel: document.getElementById("filter-toggle-label"),
      filterMenu: document.getElementById("filter-menu"),
      filterClearButton: document.getElementById("filter-clear-button"),
      filterPlayerInput: document.getElementById("filter-player-input"),
      filterPlayerResults: document.getElementById("filter-player-results"),
      filterTypeOptions: document.getElementById("filter-type-options"),
      filterTribeOptions: document.getElementById("filter-tribe-options"),
      filterLevelRange: document.getElementById("filter-level-range"),
      filterLevelMinInput: document.getElementById("filter-level-min-input"),
      filterLevelMaxInput: document.getElementById("filter-level-max-input"),
      filterLevelMinLabel: document.getElementById("filter-level-min-label"),
      filterLevelMaxLabel: document.getElementById("filter-level-max-label"),
      filterLevelRangeFill: document.getElementById("filter-level-range-fill"),
      filterLevelHelp: document.getElementById("filter-level-help"),
      filterMatchCount: document.getElementById("filter-match-count"),
      refreshButton: document.getElementById("refresh-button"),
      refreshButtonCooldown: document.getElementById("refresh-button-cooldown"),
      findHomeButton: document.getElementById("find-home-button"),
      zoomInButton: document.getElementById("zoom-in-button"),
      zoomOutButton: document.getElementById("zoom-out-button"),
    };
  }

  async start() {
    this.localConfig = getLocalViewerConfig();
    this.serverSelection = this.loadServerSelection();
    this.portalPopovers();
    this.bindEvents();
    this.syncServerInputs();
    await this.applyServerSelection({ restoreSession: true });
  }

  // Portal dropdowns/popovers to <body> — an ancestor's backdrop-filter (the
  // top-bar, the map tool panels) breaks position:fixed children otherwise.
  portalPopovers() {
    [this.elements.sessionPopover, this.elements.searchResults, this.elements.filterPlayerResults]
      .forEach((el) => { if (el) document.body.appendChild(el); });
  }

  bindEvents() {
    this.elements.serverSelect.addEventListener("change", () => this.handleServerSelectionChange());
    this.elements.serverHostInput.addEventListener("change", () => this.handleCustomServerChange());
    this.elements.serverPortInput.addEventListener("change", () => this.handleCustomServerChange());
    this.elements.serverHostInput.addEventListener("keydown", (event) => this.handleCustomServerKeyDown(event));
    this.elements.serverPortInput.addEventListener("keydown", (event) => this.handleCustomServerKeyDown(event));
    this.elements.loginForm.addEventListener("submit", (event) => this.handleLogin(event));
    this.elements.logoutButton.addEventListener("click", () => this.handleLogout());
    this.elements.refreshButton.addEventListener("click", () => this.handleRefreshMap());
    this.elements.findHomeButton.addEventListener("click", () => this.renderer.focusHome());
    this.elements.zoomInButton.addEventListener("click", () => this.renderer.zoomBy(1.18, true));
    this.elements.zoomOutButton.addEventListener("click", () => this.renderer.zoomBy(1 / 1.18, true));

    this.elements.sessionTriggerButton.addEventListener("click", () => this.toggleSessionPopover());
    this.elements.worldsToggleButton.addEventListener("click", () => this.openWorldsModal());
    this.elements.worldsCloseButton.addEventListener("click", () => this.closeWorldsModal());
    this.elements.worldsModal.addEventListener("click", (event) => {
      if (event.target === this.elements.worldsModal) {
        this.closeWorldsModal();
      }
    });

    this.elements.detailsCloseButton.addEventListener("click", () => this.handleDetailsClose());

    this.elements.searchToggleButton.addEventListener("click", () => this.handleSearchToggle());
    this.elements.searchInput.addEventListener("input", () => this.handleSearchInput());
    this.elements.searchInput.addEventListener("keydown", (event) => this.handleSearchKeyDown(event));
    this.elements.searchInput.addEventListener("focus", () => this.renderSearchResults());
    this.elements.searchInput.addEventListener("blur", () => {
      window.setTimeout(() => this.hideSearchResults(), 120);
    });

    this.elements.filterToggleButton.addEventListener("click", () => this.handleFilterToggle());
    this.elements.filterClearButton.addEventListener("click", () => this.clearFilters());
    this.elements.filterPlayerInput.addEventListener("input", () => this.handlePlayerFilterInput());
    this.elements.filterPlayerInput.addEventListener("keydown", (event) => this.handlePlayerFilterKeyDown(event));
    this.elements.filterPlayerInput.addEventListener("focus", () => this.handlePlayerFilterFocus());
    this.elements.filterPlayerInput.addEventListener("blur", () => {
      window.setTimeout(() => this.hidePlayerFilterResults(), 120);
    });
    this.elements.filterTypeOptions.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterTribeOptions.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterLevelMinInput.addEventListener("input", (event) => this.handleLevelRangeInput(event));
    this.elements.filterLevelMaxInput.addEventListener("input", (event) => this.handleLevelRangeInput(event));

    document.addEventListener("pointerdown", (event) => this.handleGlobalPointerDown(event));
    document.addEventListener("keydown", (event) => this.handleGlobalKeyDown(event));

    // Re-clamp whichever top-bar popover is open on resize/orientation change —
    // its position is computed once at open time, not tracked continuously.
    window.addEventListener("resize", () => {
      const { sessionPopover, sessionTriggerButton } = this.elements;
      if (!sessionPopover.hidden) {
        this.positionPopover(sessionPopover, sessionTriggerButton, 300, { align: "right" });
      }
    });
  }

  loadServerSelection() {
    const fallback = {
      mode: "stable",
      customHost: "http://127.0.0.1",
      customPort: "3001",
    };

    try {
      const raw = window.localStorage.getItem(SERVER_SELECTION_STORAGE_KEY);
      if (!raw) {
        return fallback;
      }

      const parsed = JSON.parse(raw);
      return {
        mode: ["stable", "local", "custom"].includes(parsed?.mode) ? parsed.mode : fallback.mode,
        customHost: String(parsed?.customHost || fallback.customHost),
        customPort: String(parsed?.customPort || fallback.customPort),
      };
    } catch (error) {
      console.warn("Failed to restore server selection.", error);
      return fallback;
    }
  }

  persistServerSelection() {
    window.localStorage.setItem(SERVER_SELECTION_STORAGE_KEY, JSON.stringify(this.serverSelection));
  }

  syncServerInputs() {
    this.elements.serverSelect.value = this.serverSelection.mode;
    this.elements.serverCustomFields.hidden = this.serverSelection.mode !== "custom";
    this.elements.serverHostInput.value = this.serverSelection.customHost;
    this.elements.serverPortInput.value = this.serverSelection.customPort;
  }

  async handleServerSelectionChange() {
    this.serverSelection.mode = this.elements.serverSelect.value;
    this.syncServerInputs();
    this.persistServerSelection();
    try {
      await this.applyServerSelection({ restoreSession: true });
    } catch (error) {
      console.error(error);
      this.setSessionStatus(error.message || "Failed to switch BYM server.", true);
    }
  }

  async handleCustomServerChange() {
    this.serverSelection.customHost = this.elements.serverHostInput.value.trim() || "http://127.0.0.1";
    this.serverSelection.customPort = this.normalizePort(this.elements.serverPortInput.value);
    this.syncServerInputs();
    this.persistServerSelection();

    if (this.serverSelection.mode === "custom") {
      try {
        await this.applyServerSelection({ restoreSession: true });
      } catch (error) {
        console.error(error);
        this.setSessionStatus(error.message || "Failed to switch BYM server.", true);
      }
    }
  }

  async handleCustomServerKeyDown(event) {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    await this.handleCustomServerChange();
  }

  buildConfigForSelection() {
    if (this.serverSelection.mode === "stable") {
      return STABLE_VIEWER_CONFIG;
    }

    if (this.serverSelection.mode === "local") {
      return this.localConfig;
    }

    return {
      bymBaseUrl: this.buildCustomBaseUrl(this.serverSelection.customHost, this.serverSelection.customPort),
      cdnBaseUrl: this.buildCustomBaseUrl(this.serverSelection.customHost, this.serverSelection.customPort),
      apiVersion: normalizeApiVersion(this.localConfig.apiVersion),
    };
  }

  buildCustomBaseUrl(host, port) {
    const rawHost = String(host || "").trim() || "http://127.0.0.1";
    const normalizedHost = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
    const url = new URL(normalizedHost);
    url.port = this.normalizePort(port);
    return normalizeBaseUrl(url.origin);
  }

  normalizePort(value) {
    const parsed = Number.parseInt(String(value || ""), 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      return "3001";
    }

    return String(parsed);
  }

  async applyServerSelection({ restoreSession }) {
    this.serverSelection.customPort = this.normalizePort(this.serverSelection.customPort);
    this.syncServerInputs();

    const baseConfig = this.buildConfigForSelection();
    const discoveryClient = new ApiClient(baseConfig);
    const resolvedApiVersion = await discoveryClient.resolveApiVersion();
    this.config = setViewerConfig({
      ...baseConfig,
      apiVersion: resolvedApiVersion,
    });
    this.api = new ApiClient(this.config);
    this.assets = new AssetCache(this.config);
    this.playerBaseIconUrl = this.assets.urlFor(ASSET_PATHS.playerBase);
    this.updateFavicon();

    this.setSessionStatus(`Connecting to ${this.describeSelectedServer()}...`);
    this.setSearchEnabled(false, "Loading CDN assets...");
    this.setFilterEnabled(false);
    this.session = null;
    this.worlds = [];
    this.leaderboardCache = new Map();
    this.leaderboardRequests = new Map();
    this.selectedWorldId = null;
    this.ownWorldId = null;
    this.hoveredCell = null;
    this.selectedCell = null;
    this.refreshInFlight = false;
    this.refreshCooldownUntil = 0;
    this.clearRefreshCooldownTimer();
    this.renderWorldList();
    this.elements.leaderboardTitle.textContent = "No world selected";
    this.elements.leaderboardList.textContent = "";
    this.renderDetails();

    this.setSessionStatus("Loading CDN assets...");
    await this.assets.preload();

    if (!this.renderer) {
      this.renderer = new MapRenderer({
        canvas: this.elements.mapCanvas,
        overlayEl: this.elements.mapOverlay,
        coordsEl: this.elements.mapCoordinates,
        statusEl: null,
        assets: this.assets,
        api: this.api,
        onHoverCell: (cell) => this.handleHoveredCell(cell),
        onSelectCell: (cell) => this.handleSelectedCell(cell),
      });
    } else {
      this.renderer.api = this.api;
      this.renderer.assets = this.assets;
    }

    this.setPendingSessionState();
    const worldsPromise = this.loadWorlds();

    if (restoreSession) {
      await this.restoreSession();
    } else {
      this.setSignedOutState();
    }

    await worldsPromise;
    this.renderer.render();
  }

  describeSelectedServer() {
    switch (this.serverSelection.mode) {
      case "stable":
        return "the stable BYMR server";
      case "local":
        return "the local BYMR server";
      default:
        return this.buildCustomBaseUrl(this.serverSelection.customHost, this.serverSelection.customPort);
    }
  }

  updateFavicon() {
    const favicon = document.getElementById("app-favicon");
    if (!favicon || favicon.tagName !== "LINK") {
      return;
    }

    favicon.href = `${this.config.cdnBaseUrl}/assets/buildings/maproom/top.1.png`;
  }

  async restoreSession() {
    const storedToken = window.localStorage.getItem(buildTokenStorageKey(this.config));
    if (!storedToken) {
      this.setSignedOutState();
      return;
    }

    this.setSessionStatus("Refreshing BYM session...");

    try {
      await this.establishSession(() => this.api.refresh(storedToken));
    } catch (error) {
      console.error(error);
      this.handleLogout(error.message || "Your BYM session expired.");
    }
  }

  async establishSession(loader) {
    this.elements.loginButton.disabled = true;
    try {
      const session = await loader();
      window.localStorage.setItem(buildTokenStorageKey(this.config), session.token);
      this.session = session;
      this.elements.logoutButton.hidden = false;
      this.elements.loginForm.hidden = true;
      this.elements.sessionPopover.classList.add("signed-in");
      this.elements.sessionName.textContent = session.user.username || "Signed in";
      this.elements.sessionTriggerLabel.textContent = session.user.username || "Signed in";
      this.refreshCooldownUntil = 0;
      this.clearRefreshCooldownTimer();
      this.setSessionStatus("");

      // bootstrap() has no way to tell the account is on the wrong map room
      // version — initialPlayerCellData filters by map_version server-side,
      // so a Map Room 2 account just gets an empty result set back, not an
      // error. Check up front and point the player at the right viewer
      // instead of silently rendering an empty map.
      const wrongVersionMessage = await this.checkMapVersion();
      this.selectDefaultWorld();
      if (wrongVersionMessage) {
        // #session-status is CSS-hidden once .signed-in is set (it's meant
        // for pre-login status only), so the link-carrying message has to go
        // on the map overlay instead — that's the only thing still visible
        // in the signed-in state. Still set the plain text on sessionStatus
        // too, harmless and correct if that CSS ever changes.
        this.setSessionStatus(WRONG_MAP_VERSION_OVERLAY_MESSAGE, true);
        this.renderer?.reset(wrongVersionMessage);
        this.setSearchEnabled(false, "");
        this.setFilterEnabled(false);
        this.renderDetails();
        return;
      }

      this.setSearchEnabled(false, "Loading full world map...");
      this.setFilterEnabled(false);
      await this.renderer.bootstrap(session);
      this.rebuildSearchIndex();
      this.rebuildFilterOptions();
      this.updateRefreshButtonState();
      this.setSearchEnabled(
        true,
        this.searchEntries.length
          ? `${formatNumber(this.searchEntries.length)} player bases indexed.`
          : "No searchable player bases found.",
      );
      this.setFilterEnabled(true);
      this.renderDetails();
      this.closeSessionPopover();
    } finally {
      this.elements.loginButton.disabled = false;
    }
  }

  // Resolves the account's own worldid via /base/load, then cross-references
  // it against the public world list to confirm it's actually a Map Room 3
  // world. Returns an HTML message (with a link to the sibling viewer) if
  // not, or null if everything checks out or the check itself couldn't be
  // completed (in which case bootstrap() is left to fail on its own terms).
  async checkMapVersion() {
    const userid = this.session?.user?.userid;
    if (!userid) return null;

    let worldid = "";
    try {
      const save = await this.api.getOwnSave(this.session.token, userid);
      worldid = save?.worldid || "";
    } catch {
      return null;
    }

    this.ownWorldId = worldid || null;

    if (!worldid) return WRONG_MAP_VERSION_MESSAGE;

    let worlds;
    try {
      ({ worlds } = await this.api.getWorlds());
    } catch {
      return null;
    }

    const world = (worlds || []).find((candidate) => candidate.uuid === worldid);
    return world && world.map_version === 3 ? null : WRONG_MAP_VERSION_MESSAGE;
  }

  async handleLogin(event) {
    event.preventDefault();
    const email = this.elements.emailInput.value.trim();
    const password = this.elements.passwordInput.value;

    if (!email || !password) {
      this.setSessionStatus("Email and password are required.", true);
      return;
    }

    this.setSessionStatus("Signing into BYM...");

    try {
      await this.establishSession(() => this.api.login(email, password));
      this.elements.passwordInput.value = "";
    } catch (error) {
      console.error(error);
      this.setSignedOutState({
        sessionStatus: error.message || "Authentication failed.",
        isError: true,
      });
    }
  }

  handleLogout(message = "Signed out.") {
    this.refreshInFlight = false;
    this.refreshCooldownUntil = 0;
    this.clearRefreshCooldownTimer();
    window.localStorage.removeItem(buildTokenStorageKey(this.config));
    this.session = null;
    this.ownWorldId = null;
    this.setSignedOutState({ sessionStatus: message });
  }

  async handleRefreshMap() {
    if (!this.session || !this.renderer || this.refreshInFlight) {
      return;
    }

    if (Date.now() < this.refreshCooldownUntil) {
      this.updateRefreshButtonState();
      return;
    }

    this.refreshInFlight = true;
    this.updateRefreshButtonState();

    try {
      await this.renderer.refreshMapData();
      this.rebuildSearchIndex();
      this.rebuildFilterOptions(true);
      this.renderDetails();
      this.startRefreshCooldown();
    } catch (error) {
      console.error(error);
      const sessionToken = this.session?.token || null;
      this.renderer.setOverlay(error.message || "Failed to refresh world map.");
      window.setTimeout(() => {
        if (this.session?.token === sessionToken && !this.refreshInFlight) {
          this.renderer?.setOverlay("");
        }
      }, 2200);
    } finally {
      this.refreshInFlight = false;
      this.updateRefreshButtonState();
    }
  }

  // ─── Session popover (top bar) ─────────────────────────────────────────

  toggleSessionPopover() {
    if (this.elements.sessionPopover.hidden) {
      this.openSessionPopover();
    } else {
      this.closeSessionPopover();
    }
  }

  openSessionPopover() {
    const { sessionPopover, sessionTriggerButton, emailInput } = this.elements;
    this.positionPopover(sessionPopover, sessionTriggerButton, 300, { align: "right" });
    sessionPopover.hidden = false;
    sessionTriggerButton.setAttribute("aria-expanded", "true");
    if (!this.session) {
      emailInput.focus();
    }
  }

  closeSessionPopover() {
    const { sessionPopover, sessionTriggerButton } = this.elements;
    sessionPopover.hidden = true;
    sessionTriggerButton.setAttribute("aria-expanded", "false");
  }

  // ─── Worlds/leaderboard modal (stats only — never changes the viewed world) ──

  openWorldsModal() {
    this.elements.worldsModal.hidden = false;
  }

  closeWorldsModal() {
    this.elements.worldsModal.hidden = true;
  }

  // Positions a fixed popover near its anchor with its own preferred width,
  // clamped so it never runs off either edge of a narrow viewport.
  positionPopover(popover, anchor, preferredWidth, { align = "left" } = {}) {
    const margin = 12;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(preferredWidth, window.innerWidth - margin * 2);
    let left = align === "right" ? rect.right - width : rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    popover.style.top = `${rect.bottom + 8}px`;
    popover.style.left = `${left}px`;
    popover.style.width = `${width}px`;
  }

  // Positions a fixed dropdown directly below an anchor, matching its width.
  positionDropdown(dropdown, anchor) {
    const rect = anchor.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.width = `${rect.width}px`;
  }

  async loadWorlds() {
    const worldsResponse = await this.api.getWorlds();
    this.worlds = (worldsResponse.worlds || [])
      .filter((world) => Number(world.map_version) === 3)
      .sort((left, right) => Number(right.playerCount || 0) - Number(left.playerCount || 0));

    await this.selectDefaultWorld();
    this.prefetchLeaderboards(this.worlds
      .map((world) => world.uuid)
      .filter((worldId) => worldId && worldId !== this.selectedWorldId));
  }

  // Prefers the logged-in account's own world (once checkMapVersion() has
  // resolved it) over the busiest one. Called from both loadWorlds() and
  // establishSession() since they run in parallel and either can resolve
  // ownWorldId first — a no-op if the right world is already selected.
  async selectDefaultWorld() {
    const preferredId = this.ownWorldId && this.worlds.some((world) => world.uuid === this.ownWorldId)
      ? this.ownWorldId
      : (this.worlds[0]?.uuid || null);

    if (preferredId === this.selectedWorldId) {
      return;
    }

    this.selectedWorldId = preferredId;
    this.renderWorldList();
    if (this.selectedWorldId) {
      await this.loadLeaderboard(this.selectedWorldId);
    }
  }

  renderWorldList() {
    this.elements.worldList.replaceChildren();

    if (!this.worlds.length) {
      this.elements.worldList.textContent = "No MR3 worlds available.";
      return;
    }

    for (const world of this.worlds) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "world-card";
      if (world.uuid === this.selectedWorldId) {
        button.classList.add("active");
      }
      button.innerHTML = `
        <strong>${escapeHtml(world.name || "Unnamed World")}</strong>
        <div class="muted">Players: ${formatNumber(Number(world.playerCount || 0))}</div>
      `;
      button.addEventListener("click", async () => {
        this.selectedWorldId = world.uuid;
        this.renderWorldList();
        await this.loadLeaderboard(world.uuid);
      });
      this.elements.worldList.appendChild(button);
    }
  }

  async loadLeaderboard(worldId) {
    const world = this.worlds.find((candidate) => candidate.uuid === worldId) || null;
    this.elements.leaderboardTitle.textContent = world ? world.name : "Selected world";
    this.elements.leaderboardList.textContent = "Loading leaderboard...";

    try {
      const rows = await this.getLeaderboardRows(worldId);
      this.elements.leaderboardList.replaceChildren();

      if (!rows.length) {
        this.elements.leaderboardList.textContent = "No leaderboard entries available.";
        return;
      }

      const header = document.createElement("div");
      header.className = "leaderboard-row leaderboard-header";
      header.innerHTML = `
        <span class="leaderboard-rank">#</span>
        <span class="leaderboard-name">Username</span>
        <span class="leaderboard-count">Resources</span>
        <span class="leaderboard-count">Strongholds</span>
      `;
      this.elements.leaderboardList.appendChild(header);

      rows.forEach((entry, index) => {
        const row = document.createElement("div");
        row.className = "leaderboard-row";
        row.innerHTML = `
          <strong class="leaderboard-rank">${index + 1}</strong>
          <span class="leaderboard-name" title="${escapeHtml(entry.username || "Unknown")}">${escapeHtml(entry.username || "Unknown")}</span>
          <span class="leaderboard-count">${formatNumber(Number(entry.outpost_count || 0))}</span>
          <span class="leaderboard-count">${formatNumber(Number(entry.stronghold_count || 0))}</span>
        `;
        this.elements.leaderboardList.appendChild(row);
      });
    } catch (error) {
      console.error(error);
      this.elements.leaderboardList.textContent = error.message || "Failed to load leaderboard.";
    }
  }

  async getLeaderboardRows(worldId) {
    if (this.leaderboardCache.has(worldId)) {
      return this.leaderboardCache.get(worldId);
    }

    if (this.leaderboardRequests.has(worldId)) {
      return this.leaderboardRequests.get(worldId);
    }

    const request = this.api.getLeaderboard(worldId, 3)
      .then((response) => {
        const rows = response.leaderboard || [];
        this.leaderboardCache.set(worldId, rows);
        return rows;
      })
      .finally(() => {
        this.leaderboardRequests.delete(worldId);
      });

    this.leaderboardRequests.set(worldId, request);
    return request;
  }

  prefetchLeaderboards(worldIds) {
    if (!Array.isArray(worldIds) || !worldIds.length) {
      return;
    }

    Promise.allSettled(
      worldIds.map((worldId) => this.getLeaderboardRows(worldId)),
    ).catch((error) => {
      console.warn("Failed to prefetch one or more leaderboards.", error);
    });
  }

  handleHoveredCell(cell) {
    this.hoveredCell = cell;
    if (!this.selectedCell) {
      this.renderDetails();
    }
  }

  handleSelectedCell(cell) {
    this.selectedCell = cell;
    this.renderDetails();
  }

  handleDetailsClose() {
    if (this.renderer) {
      this.renderer.clearSelection();
      return;
    }

    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderDetails();
  }

  // ─── Cell details panel — hover previews, click pins it open ───────────

  renderDetails() {
    this.renderDetailsPanel(this.selectedCell || this.hoveredCell || null);
  }

  renderDetailsPanel(cell) {
    const { cellDetailPanel, detailsTitle, detailsContent, detailsCloseButton } = this.elements;
    detailsContent.replaceChildren();

    if (!cell) {
      cellDetailPanel.hidden = true;
      detailsTitle.textContent = "No selection";
      detailsContent.textContent = "Hover or select a visible MR3 cell to inspect it.";
      return;
    }

    cellDetailPanel.hidden = false;
    detailsCloseButton.hidden = !this.selectedCell;
    detailsTitle.textContent = cell.n || `${cell.x}, ${cell.y}`;

    for (const [label, value] of this.buildDetailRows(cell)) {
      const row = document.createElement("div");
      row.className = "detail-row";
      row.innerHTML = `<span class="detail-label">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span>`;
      detailsContent.appendChild(row);
    }
  }

  buildDetailRows(cell) {
    const rows = [
      ["Coordinates", `${cell.x}, ${cell.y}`],
      ["Type", describeYardType(cell)],
      ["Level", formatNumber(Number(cell.l || 0))],
    ];

    if (Number(cell.r || 0) > 0) {
      rows.push(["Range", formatNumber(Number(cell.r || 0))]);
    }

    rows.push(["Damage", `${formatNumber(Number(cell.dm || 0))}%`]);

    if (Number(cell.p || 0) === 1) {
      rows.push(["Protection", "Damage protection"]);
    }

    if (Number(cell.uid || 0) > 0) {
      const ownedBaseCounts = this.renderer?.getOwnedBaseCounts(cell.uid) || {
        resource: 0,
        stronghold: 0,
        fortification: 0,
      };
      rows.push(["Resource Outposts", formatNumber(ownedBaseCounts.resource)]);
      rows.push(["Stronghold Outposts", formatNumber(ownedBaseCounts.stronghold)]);
      rows.push(["Defender Outposts", formatNumber(ownedBaseCounts.fortification)]);
    }

    if (Number(cell.tid || 0) > 0 || Number(cell.uid || 0) === 0) {
      rows.push(["Tribe", describeTribe(cell)]);
    }

    return rows;
  }

  rebuildSearchIndex() {
    this.searchEntries = this.renderer
      ? this.renderer.getSearchablePlayerBases().sort((left, right) => {
        if (left.distance !== right.distance) {
          return Number(left.distance ?? Number.MAX_SAFE_INTEGER) - Number(right.distance ?? Number.MAX_SAFE_INTEGER);
        }

        return left.normalizedUsername.localeCompare(right.normalizedUsername);
      })
      : [];
    this.searchMatches = [];
    this.searchActiveIndex = -1;
    this.elements.searchInput.value = "";
    this.hideSearchResults();
  }

  rebuildFilterOptions(preserveState = false) {
    if (!preserveState) {
      this.filterState = createEmptyBaseFilter();
    }

    this.availableFilterLevels = this.renderer ? this.renderer.getAvailableWildBaseLevels() : [];
    this.playerFilterEntries = this.buildPlayerFilterEntries();
    this.playerFilterMatches = [];
    this.playerFilterActiveIndex = -1;
    if (preserveState) {
      const validOwnerIds = new Set(this.playerFilterEntries.map((entry) => entry.ownerId));
      const availableMinLevel = this.availableFilterLevels[0] ?? null;
      const availableMaxLevel = this.availableFilterLevels[this.availableFilterLevels.length - 1] ?? null;
      let levelMin = Number(this.filterState.levelMin || 0) > 0 ? Number(this.filterState.levelMin) : null;
      let levelMax = Number(this.filterState.levelMax || 0) > 0 ? Number(this.filterState.levelMax) : null;

      if (!this.availableFilterLevels.length) {
        levelMin = null;
        levelMax = null;
      } else {
        if (levelMin !== null) {
          levelMin = this.availableFilterLevels.find((level) => level >= levelMin) ?? availableMaxLevel;
        }

        if (levelMax !== null) {
          levelMax = [...this.availableFilterLevels].reverse().find((level) => level <= levelMax) ?? availableMinLevel;
        }

        if (levelMin !== null && levelMax !== null && levelMin > levelMax) {
          levelMin = levelMax;
        }

        if (levelMin === availableMinLevel) {
          levelMin = null;
        }

        if (levelMax === availableMaxLevel) {
          levelMax = null;
        }
      }

      this.filterState = {
        ...this.filterState,
        levelMin,
        levelMax,
        playerOwnerId: validOwnerIds.has(Number(this.filterState.playerOwnerId || 0))
          ? Number(this.filterState.playerOwnerId || 0)
          : null,
        playerUsername: validOwnerIds.has(Number(this.filterState.playerOwnerId || 0))
          ? this.filterState.playerUsername
          : "",
      };
    }
    this.renderFilterOptions();
    this.applyFilters();
  }

  buildPlayerFilterEntries() {
    if (!this.renderer) {
      return [];
    }

    const seenOwnerIds = new Set();
    return this.renderer
      .getSearchablePlayerBases()
      .filter((entry) => {
        const ownerId = Number(entry.ownerId || 0);
        if (ownerId <= 0 || seenOwnerIds.has(ownerId)) {
          return false;
        }

        seenOwnerIds.add(ownerId);
        return true;
      })
      .sort((left, right) => {
        if (left.distance !== right.distance) {
          return Number(left.distance ?? Number.MAX_SAFE_INTEGER) - Number(right.distance ?? Number.MAX_SAFE_INTEGER);
        }

        return left.normalizedUsername.localeCompare(right.normalizedUsername);
      });
  }

  setSearchEnabled(enabled, message = "") {
    this.elements.searchInput.disabled = !enabled;
    this.elements.searchToggleButton.disabled = !enabled;

    if (!enabled) {
      this.searchEntries = [];
      this.searchMatches = [];
      this.searchActiveIndex = -1;
      this.elements.searchInput.value = "";
      this.setSearchPanelOpen(false);
    }

    if (this.elements.searchStatus) {
      this.elements.searchStatus.hidden = !message;
      this.elements.searchStatus.textContent = message;
    }
  }

  setFilterEnabled(enabled) {
    this.elements.filterToggleButton.disabled = !enabled;

    if (!enabled) {
      this.filterState = createEmptyBaseFilter();
      this.availableFilterLevels = [];
      this.playerFilterEntries = [];
      this.playerFilterMatches = [];
      this.playerFilterActiveIndex = -1;
      this.setFilterMenuOpen(false);
    }

    this.renderFilterOptions();
    this.syncFilterButtonState();
    this.renderer?.setBaseFilter(this.filterState);
    this.updateFilterMatchCount(enabled);
    if (!enabled) {
      this.hidePlayerFilterResults();
    }
  }

  // ─── Map search + filter — floating buttons over the map ───────────────

  handleSearchToggle() {
    if (this.elements.searchToggleButton.disabled) {
      return;
    }

    this.setSearchPanelOpen(this.elements.searchPanel.hidden);
  }

  setSearchPanelOpen(isOpen) {
    const nextIsOpen = Boolean(isOpen) && !this.elements.searchToggleButton.disabled;
    this.elements.searchPanel.hidden = !nextIsOpen;
    this.elements.searchToggleButton.setAttribute("aria-expanded", String(nextIsOpen));
    this.elements.searchToggleButton.classList.toggle("active", nextIsOpen);

    if (nextIsOpen) {
      this.elements.searchInput.focus();
    } else {
      this.hideSearchResults();
    }
  }

  handleFilterToggle() {
    if (this.elements.filterToggleButton.disabled) {
      return;
    }

    this.setFilterMenuOpen(!this.filterMenuOpen);
  }

  setFilterMenuOpen(isOpen) {
    const nextIsOpen = Boolean(isOpen) && !this.elements.filterToggleButton.disabled;
    this.filterMenuOpen = nextIsOpen;
    this.elements.filterMenu.hidden = !nextIsOpen;
    this.elements.filterToggleButton.setAttribute("aria-expanded", String(nextIsOpen));
    this.syncFilterButtonState();
    if (!nextIsOpen) {
      this.hidePlayerFilterResults();
    }
  }

  handlePlayerFilterInput() {
    const rawQuery = this.elements.filterPlayerInput.value.trim();
    if (!rawQuery) {
      this.playerFilterMatches = [];
      this.playerFilterActiveIndex = -1;
      this.hidePlayerFilterResults();
      if (this.filterState.playerOwnerId) {
        this.filterState = {
          ...this.filterState,
          playerOwnerId: null,
          playerUsername: "",
        };
        this.applyFilters();
      }
      this.renderFilterOptions();
      return;
    }

    let didChangeFilterState = false;
    if (
      Number(this.filterState.playerOwnerId || 0) > 0 &&
      rawQuery !== String(this.filterState.playerUsername || "")
    ) {
      this.filterState = {
        ...this.filterState,
        playerOwnerId: null,
        playerUsername: "",
      };
      didChangeFilterState = true;
    }

    if (this.filterState.tribes.length > 0) {
      this.filterState = {
        ...this.filterState,
        tribes: [],
      };
      didChangeFilterState = true;
    }

    this.renderFilterOptions();
    if (didChangeFilterState) {
      this.applyFilters();
    }

    this.playerFilterMatches = this.getPlayerFilterMatches(rawQuery);
    this.playerFilterActiveIndex = this.playerFilterMatches.length ? 0 : -1;
    this.renderPlayerFilterResults();
  }

  handlePlayerFilterFocus() {
    const rawQuery = this.elements.filterPlayerInput.value.trim();
    if (!rawQuery || this.elements.filterPlayerInput.disabled) {
      this.hidePlayerFilterResults();
      return;
    }

    this.playerFilterMatches = this.getPlayerFilterMatches(rawQuery);
    this.playerFilterActiveIndex = this.playerFilterMatches.length ? 0 : -1;
    this.renderPlayerFilterResults();
  }

  handlePlayerFilterKeyDown(event) {
    if (event.key === "ArrowDown" && this.playerFilterMatches.length) {
      event.preventDefault();
      this.playerFilterActiveIndex = (this.playerFilterActiveIndex + 1) % this.playerFilterMatches.length;
      this.syncPlayerFilterActiveResult();
      return;
    }

    if (event.key === "ArrowUp" && this.playerFilterMatches.length) {
      event.preventDefault();
      this.playerFilterActiveIndex =
        (this.playerFilterActiveIndex - 1 + this.playerFilterMatches.length) % this.playerFilterMatches.length;
      this.syncPlayerFilterActiveResult();
      return;
    }

    if (event.key === "Escape") {
      this.hidePlayerFilterResults();
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const selectedMatch =
      this.playerFilterMatches[this.playerFilterActiveIndex] || this.playerFilterMatches[0] || null;
    if (selectedMatch) {
      this.selectPlayerFilterResult(selectedMatch);
    }
  }

  getPlayerFilterMatches(query) {
    return this.getRankedSearchMatches(this.playerFilterEntries, query);
  }

  renderPlayerFilterResults() {
    this.renderSearchResultsDropdown({
      resultsEl: this.elements.filterPlayerResults,
      inputEl: this.elements.filterPlayerInput,
      matches: this.playerFilterMatches,
      activeIndex: this.playerFilterActiveIndex,
      onHover: (index) => {
        this.playerFilterActiveIndex = index;
        this.syncPlayerFilterActiveResult();
      },
      onSelect: (entry) => this.selectPlayerFilterResult(entry),
    });
  }

  hidePlayerFilterResults() {
    this.elements.filterPlayerResults.hidden = true;
  }

  syncPlayerFilterActiveResult() {
    this.syncSearchActiveResult(this.elements.filterPlayerResults, this.playerFilterActiveIndex);
  }

  selectPlayerFilterResult(entry) {
    this.filterState = {
      ...this.filterState,
      tribes: [],
      playerOwnerId: entry.ownerId,
      playerUsername: entry.username,
    };
    this.renderFilterOptions();
    this.applyFilters();
    this.hidePlayerFilterResults();
  }

  handleFilterOptionChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const group = input.dataset.group;
    if (!group || !["types", "tribes"].includes(group)) {
      return;
    }

    const nextValues = new Set(this.filterState[group]);
    const rawValue = input.value;
    if (input.checked) {
      nextValues.add(rawValue);
    } else {
      nextValues.delete(rawValue);
    }

    this.filterState = {
      ...this.filterState,
      [group]: [...nextValues].sort((left, right) => {
        if (typeof left === "number" && typeof right === "number") {
          return left - right;
        }
        return String(left).localeCompare(String(right));
      }),
    };

    if (this.hasWildMonsterTribeTypeFilter()) {
      this.filterState = {
        ...this.filterState,
        playerOwnerId: null,
        playerUsername: "",
      };
      this.playerFilterMatches = [];
      this.playerFilterActiveIndex = -1;
      this.elements.filterPlayerInput.value = "";
      this.hidePlayerFilterResults();
    }

    this.renderFilterOptions();
    this.applyFilters();
  }

  handleLevelRangeInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !this.availableFilterLevels.length) {
      return;
    }

    let minIndex = Number.parseInt(this.elements.filterLevelMinInput.value, 10);
    let maxIndex = Number.parseInt(this.elements.filterLevelMaxInput.value, 10);
    if (Number.isNaN(minIndex)) {
      minIndex = 0;
    }
    if (Number.isNaN(maxIndex)) {
      maxIndex = this.availableFilterLevels.length - 1;
    }

    if (input.dataset.bound === "min" && minIndex > maxIndex) {
      maxIndex = minIndex;
      this.elements.filterLevelMaxInput.value = String(maxIndex);
    } else if (input.dataset.bound === "max" && maxIndex < minIndex) {
      minIndex = maxIndex;
      this.elements.filterLevelMinInput.value = String(minIndex);
    }

    const selectedMinLevel = this.availableFilterLevels[minIndex] ?? this.availableFilterLevels[0];
    const selectedMaxLevel =
      this.availableFilterLevels[maxIndex] ?? this.availableFilterLevels[this.availableFilterLevels.length - 1];
    const availableMinLevel = this.availableFilterLevels[0];
    const availableMaxLevel = this.availableFilterLevels[this.availableFilterLevels.length - 1];

    this.filterState = {
      ...this.filterState,
      levelMin: selectedMinLevel > availableMinLevel ? selectedMinLevel : null,
      levelMax: selectedMaxLevel < availableMaxLevel ? selectedMaxLevel : null,
    };

    this.renderLevelFilterControls(!this.elements.filterToggleButton.disabled);
    this.applyFilters();
  }

  clearFilters() {
    this.filterState = createEmptyBaseFilter();
    this.renderFilterOptions();
    this.applyFilters();
  }

  applyFilters() {
    this.renderer?.setBaseFilter(this.filterState);
    this.syncFilterButtonState();
    this.updateFilterMatchCount(true);
  }

  renderFilterOptions() {
    const filterEnabled = !this.elements.filterToggleButton.disabled;
    this.renderPlayerFilterOptions(filterEnabled && !this.hasWildMonsterTribeTypeFilter());
    this.renderFilterGroup(this.elements.filterTypeOptions, "types", TYPE_FILTER_OPTIONS, filterEnabled);
    this.renderFilterGroup(
      this.elements.filterTribeOptions,
      "tribes",
      TRIBE_FILTER_OPTIONS,
      filterEnabled && !this.hasPlayerFilterQuery(),
    );
    this.renderLevelFilterControls(filterEnabled);
    this.elements.filterClearButton.disabled = !hasActiveBaseFilterState(this.filterState);
  }

  renderPlayerFilterOptions(enabled) {
    const section = this.elements.filterPlayerInput.closest(".filter-section");
    const shell = this.elements.filterPlayerInput.closest(".filter-player-shell");
    this.elements.filterPlayerInput.disabled = !enabled;
    if (section) {
      section.classList.toggle("disabled", !enabled);
    }
    if (shell) {
      shell.classList.toggle("disabled", !enabled);
    }
    if (Number(this.filterState.playerOwnerId || 0) > 0) {
      this.elements.filterPlayerInput.value = this.filterState.playerUsername || "";
    } else if (!enabled) {
      this.elements.filterPlayerInput.value = "";
    } else if (document.activeElement !== this.elements.filterPlayerInput) {
      this.elements.filterPlayerInput.value = "";
    }
    this.elements.filterPlayerInput.placeholder = enabled
      ? "Filter by username"
      : "Unavailable for wild monster tribe";

    if (
      !enabled ||
      !this.elements.filterPlayerInput.value.trim() ||
      !this.elements.filterPlayerInput.matches(":focus")
    ) {
      this.hidePlayerFilterResults();
    }
  }

  renderFilterGroup(container, group, options, enabled) {
    container.replaceChildren();
    container.classList.toggle("disabled", !enabled);
    const section = container.closest(".filter-section");
    if (section) {
      section.classList.toggle("disabled", !enabled);
    }

    for (const option of options) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      const text = document.createElement("span");
      const optionValue = option.key;
      const isChecked = this.filterState[group].includes(optionValue);

      label.className = `filter-chip${isChecked ? " active" : ""}${!enabled ? " disabled" : ""}`;
      input.type = "checkbox";
      input.value = String(optionValue);
      input.dataset.group = group;
      input.checked = isChecked;
      input.disabled = !enabled;
      text.textContent = option.label;

      label.append(input, text);
      container.appendChild(label);
    }
  }

  renderLevelFilterControls(enabled) {
    const section = this.elements.filterLevelRange.closest(".filter-section");
    const rangeEnabled = enabled && this.availableFilterLevels.length > 0;

    if (section) {
      section.classList.toggle("disabled", !rangeEnabled);
    }
    this.elements.filterLevelRange.classList.toggle("disabled", !rangeEnabled);
    this.elements.filterLevelMinInput.disabled = !rangeEnabled;
    this.elements.filterLevelMaxInput.disabled = !rangeEnabled;

    if (!rangeEnabled) {
      this.elements.filterLevelMinInput.min = "0";
      this.elements.filterLevelMinInput.max = "0";
      this.elements.filterLevelMinInput.value = "0";
      this.elements.filterLevelMaxInput.min = "0";
      this.elements.filterLevelMaxInput.max = "0";
      this.elements.filterLevelMaxInput.value = "0";
      this.elements.filterLevelMinLabel.textContent = "Min -";
      this.elements.filterLevelMaxLabel.textContent = "Max -";
      this.elements.filterLevelRangeFill.style.left = "0%";
      this.elements.filterLevelRangeFill.style.width = "0%";
      this.elements.filterLevelHelp.textContent = enabled
        ? "No wild base levels available."
        : "Sign in to load filter levels.";
      return;
    }

    const levelState = this.getLevelFilterDisplayState();
    const maxIndex = this.availableFilterLevels.length - 1;
    this.elements.filterLevelMinInput.min = "0";
    this.elements.filterLevelMinInput.max = String(maxIndex);
    this.elements.filterLevelMinInput.value = String(levelState.minIndex);
    this.elements.filterLevelMaxInput.min = "0";
    this.elements.filterLevelMaxInput.max = String(maxIndex);
    this.elements.filterLevelMaxInput.value = String(levelState.maxIndex);
    this.elements.filterLevelMinLabel.textContent = `Min ${formatNumber(levelState.minLevel)}`;
    this.elements.filterLevelMaxLabel.textContent = `Max ${formatNumber(levelState.maxLevel)}`;

    const denominator = Math.max(1, maxIndex);
    const leftPercent = maxIndex > 0 ? (levelState.minIndex / denominator) * 100 : 0;
    const rightPercent = maxIndex > 0 ? (levelState.maxIndex / denominator) * 100 : 100;
    this.elements.filterLevelRangeFill.style.left = `${leftPercent}%`;
    this.elements.filterLevelRangeFill.style.width = `${Math.max(0, rightPercent - leftPercent)}%`;
    this.elements.filterLevelHelp.textContent = this.buildLevelRangeSummary(levelState.minLevel, levelState.maxLevel);
  }

  getLevelFilterDisplayState() {
    if (!this.availableFilterLevels.length) {
      return {
        minIndex: 0,
        maxIndex: 0,
        minLevel: null,
        maxLevel: null,
      };
    }

    const availableMinLevel = this.availableFilterLevels[0];
    const availableMaxLevel = this.availableFilterLevels[this.availableFilterLevels.length - 1];
    const requestedMinLevel = Number(this.filterState.levelMin || 0) > 0
      ? Number(this.filterState.levelMin)
      : availableMinLevel;
    const requestedMaxLevel = Number(this.filterState.levelMax || 0) > 0
      ? Number(this.filterState.levelMax)
      : availableMaxLevel;

    let minIndex = this.availableFilterLevels.findIndex((level) => level >= requestedMinLevel);
    if (minIndex === -1) {
      minIndex = this.availableFilterLevels.length - 1;
    }

    let maxIndex = this.availableFilterLevels.length - 1;
    while (maxIndex > 0 && this.availableFilterLevels[maxIndex] > requestedMaxLevel) {
      maxIndex -= 1;
    }

    if (minIndex > maxIndex) {
      minIndex = maxIndex;
    }

    return {
      minIndex,
      maxIndex,
      minLevel: this.availableFilterLevels[minIndex],
      maxLevel: this.availableFilterLevels[maxIndex],
    };
  }

  buildLevelRangeSummary(minLevel, maxLevel) {
    if (minLevel === null || maxLevel === null) {
      return "No wild base levels available.";
    }

    if (
      minLevel === this.availableFilterLevels[0] &&
      maxLevel === this.availableFilterLevels[this.availableFilterLevels.length - 1]
    ) {
      return "Showing all available levels.";
    }

    if (minLevel === maxLevel) {
      return `Showing level ${formatNumber(minLevel)}.`;
    }

    return `Showing levels ${formatNumber(minLevel)}-${formatNumber(maxLevel)}.`;
  }

  updateFilterMatchCount(isEnabled) {
    if (!this.elements.filterMatchCount) {
      return;
    }

    if (!isEnabled || !this.renderer) {
      this.elements.filterMatchCount.textContent = "Sign in to load base count.";
      return;
    }

    const count = this.renderer.getBaseFilterMatchCount({ includePlayerBases: false });
    this.elements.filterMatchCount.textContent = `${formatNumber(count)} base${count === 1 ? "" : "s"} shown`;
  }

  hasPlayerFilterQuery() {
    return (
      Number(this.filterState.playerOwnerId || 0) > 0 ||
      Boolean(this.elements.filterPlayerInput.value.trim())
    );
  }

  hasWildMonsterTribeTypeFilter() {
    return this.filterState.types.includes("outpost");
  }

  syncFilterButtonState() {
    const isActive = this.filterMenuOpen || hasActiveBaseFilterState(this.filterState);
    let label = "Show Filters";
    this.elements.filterToggleButton.classList.toggle("active", isActive);

    if (this.elements.filterToggleButton.disabled) {
      this.updateFilterToggleLabel(label);
      return;
    }

    if (this.filterMenuOpen) {
      label = "Hide Filters";
      this.updateFilterToggleLabel(label);
      return;
    }

    label = hasActiveBaseFilterState(this.filterState) ? "Filters Active" : "Show Filters";
    this.updateFilterToggleLabel(label);
  }

  updateFilterToggleLabel(label) {
    this.elements.filterToggleLabel.textContent = label;
    this.elements.filterToggleButton.setAttribute("aria-label", label);
    this.elements.filterToggleButton.title = label;
  }

  updateRefreshButtonState() {
    const button = this.elements.refreshButton;
    const cooldownBadge = this.elements.refreshButtonCooldown;
    const hasSession = Boolean(this.session);
    const cooldownSeconds = Math.max(0, Math.ceil((this.refreshCooldownUntil - Date.now()) / 1000));
    const isCoolingDown = cooldownSeconds > 0;

    button.disabled = !hasSession || this.refreshInFlight || isCoolingDown;
    button.classList.toggle("cooling-down", isCoolingDown);
    button.classList.toggle("loading", this.refreshInFlight);
    cooldownBadge.hidden = !isCoolingDown;
    cooldownBadge.textContent = isCoolingDown ? String(cooldownSeconds) : "";

    if (!hasSession) {
      button.title = "Sign in to refresh the world map";
      button.setAttribute("aria-label", "Sign in to refresh the world map");
      this.elements.findHomeButton.disabled = true;
      return;
    }

    this.elements.findHomeButton.disabled = false;

    if (this.refreshInFlight) {
      button.title = "Refreshing world map...";
      button.setAttribute("aria-label", "Refreshing world map");
      return;
    }

    if (isCoolingDown) {
      button.title = `Refresh available in ${cooldownSeconds}s`;
      button.setAttribute("aria-label", `Refresh available in ${cooldownSeconds} seconds`);
      return;
    }

    button.title = "Refresh world map";
    button.setAttribute("aria-label", "Refresh world map");
  }

  startRefreshCooldown() {
    this.refreshCooldownUntil = Date.now() + MAP_REFRESH_COOLDOWN_MS;
    this.clearRefreshCooldownTimer();
    this.updateRefreshButtonState();
    this.refreshCooldownTimer = window.setInterval(() => {
      if (Date.now() >= this.refreshCooldownUntil) {
        this.refreshCooldownUntil = 0;
        this.clearRefreshCooldownTimer();
      }

      this.updateRefreshButtonState();
    }, 1000);
  }

  clearRefreshCooldownTimer() {
    if (!this.refreshCooldownTimer) {
      return;
    }

    window.clearInterval(this.refreshCooldownTimer);
    this.refreshCooldownTimer = 0;
  }

  handleSearchInput() {
    const query = this.elements.searchInput.value.trim().toLocaleLowerCase();
    if (!query) {
      this.searchMatches = [];
      this.searchActiveIndex = -1;
      this.renderSearchResults();
      return;
    }

    this.searchMatches = this.getRankedSearchMatches(this.searchEntries, query);
    this.searchActiveIndex = this.searchMatches.length ? 0 : -1;
    this.renderSearchResults();
  }

  handleSearchKeyDown(event) {
    if (event.key === "ArrowDown" && this.searchMatches.length) {
      event.preventDefault();
      this.searchActiveIndex = (this.searchActiveIndex + 1) % this.searchMatches.length;
      this.renderSearchResults();
      return;
    }

    if (event.key === "ArrowUp" && this.searchMatches.length) {
      event.preventDefault();
      this.searchActiveIndex =
        (this.searchActiveIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
      this.renderSearchResults();
      return;
    }

    if (event.key === "Escape") {
      this.setSearchPanelOpen(false);
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const selectedMatch = this.searchMatches[this.searchActiveIndex] || this.searchMatches[0] || null;
    if (selectedMatch) {
      this.selectSearchResult(selectedMatch);
    }
  }

  renderSearchResults() {
    this.renderSearchResultsDropdown({
      resultsEl: this.elements.searchResults,
      inputEl: this.elements.searchInput,
      matches: this.searchMatches,
      activeIndex: this.searchActiveIndex,
      onHover: (index) => {
        this.searchActiveIndex = index;
        this.syncSearchActiveResult();
      },
      onSelect: (entry) => this.selectSearchResult(entry),
    });
  }

  hideSearchResults() {
    this.elements.searchResults.hidden = true;
  }

  getRankedSearchMatches(entries, query) {
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    return entries
      .map((entry) => {
        const matchIndex = entry.normalizedUsername.indexOf(normalizedQuery);
        if (matchIndex === -1) {
          return null;
        }

        return {
          ...entry,
          matchIndex,
          isPrefixMatch: matchIndex === 0,
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.isPrefixMatch !== right.isPrefixMatch) {
          return left.isPrefixMatch ? -1 : 1;
        }
        if (left.matchIndex !== right.matchIndex) {
          return left.matchIndex - right.matchIndex;
        }
        if (left.distance !== right.distance) {
          return Number(left.distance ?? Number.MAX_SAFE_INTEGER) - Number(right.distance ?? Number.MAX_SAFE_INTEGER);
        }
        return left.normalizedUsername.localeCompare(right.normalizedUsername);
      })
      .slice(0, SEARCH_RESULT_LIMIT);
  }

  renderSearchResultsDropdown({ resultsEl, inputEl, matches, activeIndex, onHover, onSelect }) {
    const query = inputEl.value.trim();
    resultsEl.replaceChildren();

    if (!query || !matches.length || inputEl.disabled) {
      resultsEl.hidden = true;
      return;
    }

    matches.forEach((entry, index) => {
      resultsEl.appendChild(this.buildSearchResultButton({
        entry,
        index,
        activeIndex,
        onHover,
        onSelect,
      }));
    });

    this.positionDropdown(resultsEl, inputEl);
    resultsEl.hidden = false;
    this.syncSearchActiveResult(resultsEl, activeIndex);
  }

  buildSearchResultButton({ entry, index, activeIndex, onHover, onSelect }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    if (index === activeIndex) {
      button.classList.add("active");
    }
    button.innerHTML = `
      <img class="search-result-icon" src="${escapeHtml(this.playerBaseIconUrl)}" alt="">
      <div class="search-result-main">
        <span class="search-result-name">${escapeHtml(entry.username)}</span>
        <span class="search-result-meta">Level ${formatNumber(entry.level)}</span>
      </div>
      <span class="search-result-distance">${escapeHtml(formatDistance(entry.distance))}</span>
    `;
    button.addEventListener("mouseenter", () => onHover(index));
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      onSelect(entry);
    });
    return button;
  }

  syncSearchActiveResult(resultsEl = this.elements.searchResults, activeIndex = this.searchActiveIndex) {
    const buttons = resultsEl.querySelectorAll(".search-result");
    buttons.forEach((button, index) => {
      button.classList.toggle("active", index === activeIndex);
    });
  }

  selectSearchResult(entry) {
    this.elements.searchInput.value = entry.username;
    this.hideSearchResults();
    this.renderer.focusCell(entry.cell, { animate: true, resetZoom: true });
  }

  handleGlobalPointerDown(event) {
    if (!(event.target instanceof Node)) {
      return;
    }

    if (
      this.filterMenuOpen &&
      !this.elements.filterMenu.contains(event.target) &&
      !this.elements.filterToggleButton.contains(event.target)
    ) {
      this.setFilterMenuOpen(false);
    }

    if (
      !this.elements.searchPanel.hidden &&
      !this.elements.searchPanel.contains(event.target) &&
      !this.elements.searchToggleButton.contains(event.target) &&
      !this.elements.searchResults.contains(event.target)
    ) {
      this.setSearchPanelOpen(false);
    }

    const { sessionPopover, sessionTriggerButton } = this.elements;
    if (
      !sessionPopover.hidden &&
      !sessionPopover.contains(event.target) &&
      !sessionTriggerButton.contains(event.target)
    ) {
      this.closeSessionPopover();
    }
  }

  handleGlobalKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }

    let didHandle = false;

    if (this.filterMenuOpen) {
      this.setFilterMenuOpen(false);
      didHandle = true;
    }

    if (!this.elements.searchPanel.hidden) {
      this.setSearchPanelOpen(false);
      didHandle = true;
    }

    if (!this.elements.sessionPopover.hidden) {
      this.closeSessionPopover();
      didHandle = true;
    }

    if (!this.elements.worldsModal.hidden) {
      this.closeWorldsModal();
      didHandle = true;
    }

    if (didHandle) {
      event.preventDefault();
    }
  }

  // innerHTML rather than textContent so WRONG_MAP_VERSION_MESSAGE's link can
  // render — every caller passes a static, trusted string, never user input.
  setSessionStatus(message, isError = false) {
    this.elements.sessionStatus.hidden = !message;
    this.elements.sessionStatus.innerHTML = message;
    this.elements.sessionStatus.style.color = isError ? "#ffb59f" : "";
  }

  setPendingSessionState() {
    this.elements.logoutButton.hidden = true;
    this.elements.loginForm.hidden = false;
    this.elements.sessionPopover.classList.remove("signed-in");
    this.elements.loginButton.disabled = false;
    this.elements.sessionName.textContent = "Loading...";
    this.elements.sessionTriggerLabel.textContent = "Loading...";
    this.setSearchEnabled(false, "Loading world map access...");
    this.setFilterEnabled(false);
    this.updateRefreshButtonState();
    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderer?.reset(INITIAL_OVERLAY_MESSAGE);
    this.renderDetails();
  }

  setSignedOutState({
    sessionStatus = "Sign in with your own BYM credentials.",
    isError = false,
  } = {}) {
    this.elements.logoutButton.hidden = true;
    this.elements.loginForm.hidden = false;
    this.elements.sessionPopover.classList.remove("signed-in");
    this.elements.loginButton.disabled = false;
    this.elements.sessionName.textContent = "Signed out";
    this.elements.sessionTriggerLabel.textContent = "Sign in";
    this.setSessionStatus(sessionStatus, isError);
    this.setSearchEnabled(false, "Sign in to search the loaded world map.");
    this.setFilterEnabled(false);
    this.updateRefreshButtonState();
    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderer?.reset(SIGNED_OUT_OVERLAY_MESSAGE);
    this.renderDetails();
  }
}
