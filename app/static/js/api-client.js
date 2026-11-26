import {
  FETCH_TIMEOUT_LONG_MS,
  MR3,
  buildBymUrl,
  buildSessionPayload,
  fetchJson,
  getViewerConfig,
  normalizeApiVersion,
} from "./shared.js";

export class ApiClient {
  constructor(config = getViewerConfig()) {
    this.config = config;
    this.mapCellsRequestGate = Promise.resolve();
    this.mapCellsRequestTimestamps = [];
  }

  async getConfig() {
    return this.config;
  }

  /** Current game API version from the CDN's version manifest — the same source the launcher and server use. */
  async resolveApiVersion() {
    try {
      const manifest = await fetchJson(`${this.config.cdnBaseUrl}/versionManifest.json`);
      if (manifest?.currentGameVersion) {
        return `v${manifest.currentGameVersion}-beta`;
      }
    } catch (error) {
      void error;
    }

    return normalizeApiVersion(this.config.apiVersion);
  }

  async login(email, password) {
    const loginResponse = await fetchJson(this.buildApiUrl("/player/getinfo"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        email,
        password,
        sessionType: "game",
      }),
    });

    const map = await this.getMapMeta(loginResponse.token);
    return buildSessionPayload(loginResponse, map);
  }

  async refresh(token) {
    const loginResponse = await fetchJson(this.buildApiUrl("/player/getinfo"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        token,
        sessionType: "game",
      }),
    });

    const map = await this.getMapMeta(loginResponse.token);
    return buildSessionPayload(loginResponse, map);
  }

  async getWorlds() {
    return fetchJson(this.buildApiUrl("/worlds"));
  }

  // Neither /player/getinfo nor /bm/getnewmap expose the player's worldid, so
  // this is the only client-callable source of it: the same /base/load call
  // (type=build, baseid=DEFAULT) the real game client makes on first login.
  // It also runs the game's own one-time login side effects (Town Hall reward
  // grants, invasion wave rollover) — harmless/idempotent, same reasoning as
  // the MR2 viewer's equivalent call. Returns the player's full filtered
  // save, worldid included. Used by ViewerApp.checkMapVersion().
  async getOwnSave(token, userid) {
    return fetchJson(buildBymUrl("/base/load", null, this.config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({ type: "build", userid: String(userid), baseid: "0", mapversion: "3" }),
    });
  }

  async getLeaderboard(worldId, mapVersion = 3) {
    return fetchJson(this.buildApiUrl("/leaderboards", {
      worldid: worldId,
      mapversion: mapVersion,
    }));
  }

  async getMapMeta(token) {
    return fetchJson(this.buildApiUrl("/bm/getnewmap"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(),
    });
  }

  async getMapInit(token) {
    return fetchJson(buildBymUrl("/worldmapv3/initworldmap", null, this.config), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  async getMapCells(token, cellIds) {
    if (!Array.isArray(cellIds) || !cellIds.length) {
      return { celldata: [] };
    }

    if (cellIds.length > MR3.fullMapRequestChunkSize) {
      throw new Error(`Cell batch exceeds the ${MR3.fullMapRequestChunkSize} cell limit.`);
    }

    await this.waitForMapCellsRequestSlot();

    return fetchJson(buildBymUrl("/worldmapv3/getcells", null, this.config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        cellids: JSON.stringify(cellIds),
      }),
    }, FETCH_TIMEOUT_LONG_MS);
  }

  buildApiUrl(path, query = null) {
    return buildBymUrl(`/api/${this.config.apiVersion}${path}`, query, this.config);
  }

  async waitForMapCellsRequestSlot() {
    let releaseGate = null;
    const previousGate = this.mapCellsRequestGate;
    this.mapCellsRequestGate = new Promise((resolve) => {
      releaseGate = resolve;
    });

    await previousGate;

    try {
      const maxRequests = Math.max(1, Number(MR3.fullMapRequestsPerMinute) || 1);
      const windowMs = Math.max(1, Number(MR3.fullMapRequestWindowMs) || 60_000);

      while (true) {
        const now = Date.now();
        const cutoff = now - windowMs;
        this.mapCellsRequestTimestamps = this.mapCellsRequestTimestamps.filter(
          (startedAt) => startedAt > cutoff,
        );

        if (this.mapCellsRequestTimestamps.length < maxRequests) {
          this.mapCellsRequestTimestamps.push(now);
          return;
        }

        const oldestStartedAt = this.mapCellsRequestTimestamps[0];
        const waitMs = Math.max(0, oldestStartedAt + windowMs - now + 5);
        await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs));
      }
    } finally {
      releaseGate();
    }
  }
}
