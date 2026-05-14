(function () {
  const stage = document.querySelector(".stage");
  const canvas = document.querySelector("[data-scaled-view-canvas]");
  const params = new URLSearchParams(window.location.search);
  const desktopManifestUrl = "data/generated/scaled-view-tiles/manifest.json?v=20260514-tile-capture-fix-1";
  const mobileManifestUrl = "data/generated/scaled-view-tiles/mobile-manifest.json?v=20260514-mobile-hires-tiles-1";
  const mobileTileMediaQuery = window.matchMedia("(max-width: 1025px), (pointer: coarse)");
  const preloadPadding = 1;
  const allowIncomplete = params.has("scaledViewAllowIncomplete");
  const debugMode = params.has("scaledViewDebug");
  const transformDebugMode = params.has("scaledViewTransformDebug");
  const overlayDisabled = params.has("scaledViewOverlayOff");
  const forceFreshManifest =
    debugMode || params.has("renderCapture") || params.has("tileCapture") || params.has("scaledViewFreshManifest");
  const desktopMinTileModeScale = 0.05;
  const mobileMinTileModeScale = 0.018;
  const desktopMaxTileModeScale = 0.35;
  const mobileMaxTileModeScale = 0.55;
  const maxTileSourceScale = 0.75;
  const disabledByDebugRing = params.has("debugRing");
  const disabledByQuery =
    disabledByDebugRing ||
    params.has("scaledViewOff") ||
    params.has("disableScaledView") ||
    params.get("scaledView") === "off";
  const disabledReason = disabledByDebugRing ? "disabled-by-debug-ring" : "disabled-by-query";

  const state = {
    manifest: null,
    manifestUrl: "",
    tileProfile: "",
    renderManifest: window.__ds2026RenderManifest ?? null,
    levels: [],
    canvasState: null,
    imageCache: new Map(),
    preferredTileFormat: "png",
    overlayObserver: null,
    overlayLineCanvas: null,
    overlayLineContext: null,
    canvasRect: null,
    canvasRectDirty: true,
    cardHitIndex: null,
    hoveredCardId: "",
    pinnedCardId: "",
    activeTagFilter: null,
    frame: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    dpr: 1,
    active: false,
    disabled: disabledByQuery,
    disableReason: disabledByQuery ? disabledReason : "",
    debugBadge: null,
    diagnostics: {
      active: false,
      available: Boolean(canvas),
      disabled: disabledByQuery,
      disabledByQuery,
      disabledByDebugRing,
      manifestLoaded: false,
      manifestUrl: "",
      tileProfile: "",
      maxTileModeScale: null,
      mobileRasterFirstThroughMaxZoom: false,
      levelId: "",
      level: null,
      levelSelectionStrategy: "single-highest-source",
      tileSize: null,
      loadedTiles: 0,
      visibleTileCount: 0,
      drawnTileCount: 0,
      missingVisibleTiles: 0,
      pendingVisibleTiles: 0,
      activeOverlayCardCount: 0,
      activeOverlayLineCount: 0,
      overlayDisabled,
      forceFreshManifest,
      transformReferenceCount: 0,
      hoveredCardId: "",
      activeTagFilter: null,
      drawMs: 0,
      sourceVersionStatus: "unchecked",
      fallbackReason: canvas ? "manifest-not-loaded" : "missing-canvas",
      error: "",
    },
  };

  window.__ds2026ScaledViewTileDiagnostics = state.diagnostics;

  function getTileProfile() {
    return mobileTileMediaQuery.matches ? "mobile" : "desktop";
  }

  function getManifestUrlForProfile(profile) {
    return profile === "mobile" ? mobileManifestUrl : desktopManifestUrl;
  }

  function getMinTileModeScale() {
    return state.tileProfile === "mobile" ? mobileMinTileModeScale : desktopMinTileModeScale;
  }

  function getMaxTileModeScale() {
    return state.tileProfile === "mobile" ? mobileMaxTileModeScale : desktopMaxTileModeScale;
  }

  function ensureDebugBadge() {
    if (!debugMode || state.debugBadge) {
      return state.debugBadge;
    }

    const badge = document.createElement("div");
    badge.className = "scaled-view-debug-badge";
    badge.setAttribute("data-scaled-view-debug-badge", "");
    document.body.append(badge);
    state.debugBadge = badge;
    return badge;
  }

  function updateDebugBadge() {
    const badge = ensureDebugBadge();

    if (!badge) {
      return;
    }

    const diagnostics = state.diagnostics;
    const mode = diagnostics.active ? "tiles" : "DOM";
    const level = diagnostics.level ? `${Math.round(Number(diagnostics.level) * 100)}% source` : "none";
    const reason = diagnostics.fallbackReason || diagnostics.sourceVersionStatus || "active";

    badge.textContent = `Scaled view: ${mode} | level ${level} | ${reason}`;
    badge.dataset.mode = diagnostics.active ? "tiles" : "dom";
  }

  function updateDiagnostics(nextDiagnostics = {}) {
    Object.assign(state.diagnostics, nextDiagnostics, {
      active: state.active,
      available: Boolean(canvas),
      disabled: state.disabled,
      disabledByQuery,
      manifestUrl: state.manifestUrl,
      tileProfile: state.tileProfile,
      maxTileModeScale: getMaxTileModeScale(),
      mobileRasterFirstThroughMaxZoom: state.tileProfile === "mobile" && getMaxTileModeScale() >= maxTileSourceScale,
      manifestLoaded: Boolean(state.manifest),
      loadedTiles: Array.from(state.imageCache.values()).filter((entry) => entry.status === "loaded").length,
    });

    window.__ds2026ScaledViewTileDiagnostics = state.diagnostics;
    updateDebugBadge();
  }

  function setActive(isActive, fallbackReason = "") {
    state.active = Boolean(isActive);
    stage?.classList.toggle("is-scaled-view-tiles-active", state.active);
    stage?.setAttribute("data-scaled-view-tiles", state.active ? "active" : fallbackReason || "inactive");
    updateDiagnostics({ fallbackReason: state.active ? "" : fallbackReason });
  }

  function setDisabled(isDisabled, reason = "disabled-by-runtime-toggle") {
    state.disabled = Boolean(isDisabled);
    state.disableReason = state.disabled ? reason : "";
    stage?.classList.toggle("is-scaled-view-tiles-disabled", state.disabled);

    if (state.disabled) {
      setActive(false, reason);
    }

    scheduleDraw();
    return state.disabled;
  }

  function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
  }

  function normalizeLevel(level) {
    const tileSize = Number(state.manifest?.tileSize);
    const scale = Number(level.level);
    const columns = Number(level.columns);
    const rows = Number(level.rows);
    const tileAssetBaseUrl = getTileAssetBaseUrl();

    if (
      !isFiniteNumber(tileSize) ||
      !isFiniteNumber(scale) ||
      !isFiniteNumber(columns) ||
      !isFiniteNumber(rows) ||
      scale <= 0 ||
      columns <= 0 ||
      rows <= 0
    ) {
      return null;
    }

    const tileMap = new Map();

    for (const tile of level.tiles ?? []) {
      const column = Number(tile.column);
      const row = Number(tile.row);
      const src = String(tile.src ?? "").trim();
      const formatSources = {
        png: String(tile.formats?.png ?? tile.src ?? "").trim(),
        avif: String(tile.formats?.avif ?? "").trim(),
      };

      if (!Number.isInteger(column) || !Number.isInteger(row) || !src) {
        continue;
      }

      const tileUrls = Object.fromEntries(
        Object.entries(formatSources)
          .filter(([, source]) => source)
          .map(([format, source]) => {
            const url = new URL(source, tileAssetBaseUrl);
            return [format, url];
          }),
      );
      const cacheKey =
        state.manifest?.generatedAt ||
        state.manifest?.source?.renderHash ||
        state.manifest?.source?.sourceVersions?.data ||
        "";

      if (cacheKey) {
        for (const url of Object.values(tileUrls)) {
          url.searchParams.set("v", cacheKey);
        }
      }

      const candidates = [
        tileUrls.avif ? { format: "avif", url: tileUrls.avif.toString() } : null,
        tileUrls.png ? { format: "png", url: tileUrls.png.toString() } : null,
      ].filter(Boolean);

      tileMap.set(`${column}:${row}`, {
        column,
        row,
        src,
        url: tileUrls.png?.toString() ?? candidates[0]?.url ?? "",
        candidates,
      });
    }

    return {
      ...level,
      level: scale,
      columns,
      rows,
      tileMap,
      tileSize,
    };
  }

  function getTileAssetBaseUrl() {
    const outputDir = String(state.manifest?.outputDir ?? "").trim().replace(/^\/+/, "");

    if (outputDir) {
      return new URL(`${outputDir.replace(/\/+$/, "")}/`, window.location.href);
    }

    return new URL(".", new URL(state.manifestUrl, window.location.href));
  }

  function chooseLevel(scale) {
    const maxTileModeScale = getMaxTileModeScale();

    if (!state.levels.length || !isFiniteNumber(scale) || scale < getMinTileModeScale() || scale > maxTileModeScale + 0.0001) {
      return null;
    }

    const numericScale = Number(scale);
    const eligibleLevels = state.levels.filter((level) => level.level <= maxTileSourceScale + 0.0001);
    if (!eligibleLevels.length || numericScale > maxTileModeScale + 0.0001) {
      return null;
    }

    return eligibleLevels.find((level) => level.level + 0.0001 >= numericScale) ?? eligibleLevels[eligibleLevels.length - 1];
  }

  function normalizeAssetRefs(refs = [], options = {}) {
    return refs
      .map((ref) => String(ref ?? "").trim())
      .filter(Boolean)
      .filter((ref) => {
        if (options.ignoreScaledViewRenderer) {
          return !ref.startsWith("scaled-view-tile-renderer.js");
        }

        return true;
      })
      .sort();
  }

  function areAssetRefsEqual(leftRefs = [], rightRefs = [], options = {}) {
    const left = normalizeAssetRefs(leftRefs, options);
    const right = normalizeAssetRefs(rightRefs, options);

    if (left.length !== right.length) {
      return false;
    }

    return left.every((ref, index) => ref === right[index]);
  }

  function stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }

    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(",")}}`;
    }

    return JSON.stringify(value);
  }

  function areObjectsEqual(left, right) {
    return stableStringify(left ?? null) === stableStringify(right ?? null);
  }

  function getSourceVersionStatus() {
    const captured = state.manifest?.source?.sourceVersions ?? null;
    const current = window.__ds2026RenderManifest?.sourceVersions ?? null;

    if (!captured) {
      return { current: false, status: "missing-captured-source-versions" };
    }

    if (!current) {
      return { current: false, status: "waiting-for-current-source-versions" };
    }

    if (captured.data !== current.data || captured.renderManifest !== current.renderManifest) {
      return { current: false, status: "data-or-render-manifest-version-mismatch" };
    }

    if (!captured.dataContentHashes || !current.dataContentHashes) {
      return { current: false, status: "missing-data-content-hashes" };
    }

    if (!areObjectsEqual(captured.dataContentHashes, current.dataContentHashes)) {
      return { current: false, status: "data-content-hash-mismatch" };
    }

    if (!state.manifest?.source?.renderHash) {
      return { current: false, status: "missing-captured-render-hash" };
    }

    if (!window.__ds2026RenderManifest?.renderHash) {
      return { current: false, status: "waiting-for-current-render-hash" };
    }

    if (state.manifest.source.renderHash !== window.__ds2026RenderManifest.renderHash) {
      return { current: false, status: "render-hash-mismatch" };
    }

    if (!areAssetRefsEqual(captured.stylesheets, current.stylesheets)) {
      return { current: false, status: "stylesheet-version-mismatch" };
    }

    if (!areAssetRefsEqual(captured.scripts, current.scripts, { ignoreScaledViewRenderer: true })) {
      return { current: false, status: "script-version-mismatch" };
    }

    return { current: true, status: "current" };
  }

  function getOverlayCards() {
    const renderManifest = state.renderManifest;
    const activeCardId = getActiveOverlayCardId();

    if (!renderManifest?.cards?.length) {
      return [];
    }

    if (state.activeTagFilter) {
      return getCardsMatchingTag(state.activeTagFilter.kind, state.activeTagFilter.value);
    }

    if (activeCardId) {
      const activeCardIds = getManifestConnectionGroup(activeCardId);
      return renderManifest.cards.filter((card) => activeCardIds.has(card.id));
    }

    return renderManifest.cards.filter((card) => {
      if (!card.id) {
        return false;
      }

      return document.querySelector(`[data-card-id="${CSS.escape(card.id)}"].is-connection-active`);
    });
  }

  function getEmptyOverlayDiagnostics() {
    return {
      activeOverlayCardCount: 0,
      activeOverlayLineCount: 0,
      hoveredCardId: state.active ? state.hoveredCardId : "",
      activeTagFilter: state.active ? state.activeTagFilter : null,
    };
  }

  function getActiveOverlayCardId() {
    return state.hoveredCardId || state.pinnedCardId || "";
  }

  function getManifestConnectionGroup(cardId) {
    const group = new Set();
    const renderManifest = state.renderManifest;

    if (!cardId || !renderManifest?.connections?.length) {
      return group;
    }

    group.add(cardId);

    for (const connection of renderManifest.connections) {
      if (connection.from === cardId && connection.to) {
        group.add(connection.to);
      }

      if (connection.to === cardId && connection.from) {
        group.add(connection.from);
      }
    }

    return group;
  }

  function getManifestOverlayLines(cardId) {
    const renderManifest = state.renderManifest;

    if (!cardId || !renderManifest?.connections?.length) {
      return [];
    }

    return renderManifest.connections.filter((connection) => connection.from === cardId || connection.to === cardId);
  }

  function normalizeTag(value) {
    return String(value || "").trim().toLowerCase();
  }

  function getCardsMatchingTag(kind, value) {
    const normalizedKind = String(kind || "");
    const normalizedValue = normalizeTag(value);

    if (!normalizedKind || !normalizedValue || !state.renderManifest?.cards?.length) {
      return [];
    }

    return state.renderManifest.cards.filter((card) =>
      (card.tags ?? []).some((tag) => tag.kind === normalizedKind && normalizeTag(tag.value) === normalizedValue),
    );
  }

  function getOverlayLines() {
    const activeCardId = getActiveOverlayCardId();

    if (state.activeTagFilter) {
      return [];
    }

    if (activeCardId) {
      return getManifestOverlayLines(activeCardId);
    }

    const activeLines = Array.from(document.querySelectorAll(".active-connection-layer .active-connection-line"));

    if (activeLines.length) {
      return activeLines;
    }

    return Array.from(document.querySelectorAll(".connection-layer .connection-line.is-connection-active"));
  }

  function worldToScreenPoint(canvasState, x, y) {
    return {
      x: Number(canvasState.offsetX) + x * Number(canvasState.scale),
      y: Number(canvasState.offsetY) + y * Number(canvasState.scale),
    };
  }

  function getScreenRect(canvasState, rect) {
    if (!rect) {
      return null;
    }

    const scale = Number(canvasState.scale);
    const origin = worldToScreenPoint(canvasState, Number(rect.x), Number(rect.y));

    return {
      x: origin.x,
      y: origin.y,
      width: Number(rect.width) * scale,
      height: Number(rect.height) * scale,
      radius: 24 * scale,
    };
  }

  function drawRoundedScreenRectPath(ctx, screenRect) {
    const radius = Math.max(0, Math.min(screenRect.radius, screenRect.width / 2, screenRect.height / 2));
    const x = screenRect.x;
    const y = screenRect.y;
    const width = screenRect.width;
    const height = screenRect.height;

    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x, y + height);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function drawCardOutline(ctx, screenRect, scale) {
    if (!screenRect || screenRect.width <= 0 || screenRect.height <= 0) {
      return;
    }

    const nodeRadius = Math.max(3, Math.min(8 * scale, Math.max(screenRect.width, screenRect.height) / 2));
    const nodeX = screenRect.x + screenRect.width / 2;
    const nodeY = screenRect.y + screenRect.height / 2;

    ctx.beginPath();
    ctx.arc(nodeX, nodeY, nodeRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#fffb00";
    ctx.shadowColor = "rgba(255, 251, 0, 0.55)";
    ctx.shadowBlur = Math.max(0, 8 * scale);
    ctx.fill();
  }

  function getConnectionStrokeWidth(scale) {
    if (scale <= 0.1) {
      return Math.max(1.5, 16 * scale);
    }

    if (scale <= 0.3) {
      return Math.max(2, 8 * scale);
    }

    return Math.max(2.25, 4 * scale);
  }

  function getOverlayLineContext() {
    const width = Math.max(1, Math.round(state.viewportWidth * state.dpr));
    const height = Math.max(1, Math.round(state.viewportHeight * state.dpr));

    if (!state.overlayLineCanvas) {
      state.overlayLineCanvas = document.createElement("canvas");
    }

    if (
      !state.overlayLineContext ||
      state.overlayLineCanvas.width !== width ||
      state.overlayLineCanvas.height !== height
    ) {
      state.overlayLineCanvas.width = width;
      state.overlayLineCanvas.height = height;
      state.overlayLineContext = state.overlayLineCanvas.getContext("2d", { alpha: true });
    }

    if (!state.overlayLineContext) {
      return null;
    }

    state.overlayLineContext.setTransform(1, 0, 0, 1, 0, 0);
    state.overlayLineContext.clearRect(0, 0, width, height);
    state.overlayLineContext.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    return state.overlayLineContext;
  }

  function drawOverlayLines(ctx, canvasState, overlayLines, overlayCards) {
    if (!overlayLines.length) {
      return;
    }

    const scale = Number(canvasState.scale);
    const lineCtx = getOverlayLineContext();

    if (!lineCtx) {
      return;
    }

    lineCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    lineCtx.lineCap = "round";
    lineCtx.lineJoin = "round";
    lineCtx.strokeStyle = "#fffb00";
    lineCtx.lineWidth = getConnectionStrokeWidth(scale);

    for (const line of overlayLines) {
      const x1 = typeof line.getAttribute === "function" ? line.getAttribute("x1") : line.x1;
      const y1 = typeof line.getAttribute === "function" ? line.getAttribute("y1") : line.y1;
      const x2 = typeof line.getAttribute === "function" ? line.getAttribute("x2") : line.x2;
      const y2 = typeof line.getAttribute === "function" ? line.getAttribute("y2") : line.y2;
      const start = worldToScreenPoint(canvasState, Number(x1), Number(y1));
      const end = worldToScreenPoint(canvasState, Number(x2), Number(y2));

      lineCtx.beginPath();
      lineCtx.moveTo(start.x, start.y);
      lineCtx.lineTo(end.x, end.y);
      lineCtx.stroke();
    }

    if (overlayCards.length) {
      lineCtx.save();
      lineCtx.globalCompositeOperation = "destination-out";
      lineCtx.fillStyle = "#000000";

      for (const card of overlayCards) {
        const screenRect = getScreenRect(canvasState, card.rect);

        if (screenRect?.width > 0 && screenRect?.height > 0) {
          drawRoundedScreenRectPath(lineCtx, {
            ...screenRect,
            x: screenRect.x - 1,
            y: screenRect.y - 1,
            width: screenRect.width + 2,
            height: screenRect.height + 2,
          });
          lineCtx.fill();
        }
      }

      lineCtx.restore();
    }

    ctx.save();
    ctx.drawImage(state.overlayLineCanvas, 0, 0, state.viewportWidth, state.viewportHeight);
    ctx.restore();
  }

  function drawOverlayCards(ctx, canvasState, overlayCards) {
    if (!overlayCards.length) {
      return;
    }

    const scale = Number(canvasState.scale);

    ctx.save();

    for (const card of overlayCards) {
      drawCardOutline(ctx, getScreenRect(canvasState, card.connectorNodeRect || card.rect), scale);
    }

    ctx.restore();
  }

  function getOverlayDrawState() {
    if (overlayDisabled) {
      return {
        cards: [],
        lines: [],
        cardCount: 0,
        lineCount: 0,
      };
    }

    const cards = getOverlayCards();
    const lines = getOverlayLines();

    return {
      cards,
      lines,
      cardCount: cards.length,
      lineCount: lines.length,
    };
  }

  function getTransformReferencePoints(canvasState, limit = 12) {
    if (!canvasState || !state.renderManifest) {
      return [];
    }

    const references = [];
    const bounds = state.renderManifest.bounds;

    if (bounds) {
      references.push(
        { id: "bounds-top-left", kind: "bounds", x: bounds.x, y: bounds.y },
        { id: "bounds-top-right", kind: "bounds", x: bounds.x + bounds.width, y: bounds.y },
        { id: "bounds-bottom-left", kind: "bounds", x: bounds.x, y: bounds.y + bounds.height },
        { id: "bounds-bottom-right", kind: "bounds", x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { id: "bounds-center", kind: "bounds", x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      );
    }

    for (const card of state.renderManifest.cards ?? []) {
      if (!card.rect || references.length >= limit) {
        continue;
      }

      references.push({
        id: card.id,
        kind: "card-center",
        x: Number(card.rect.x) + Number(card.rect.width) / 2,
        y: Number(card.rect.y) + Number(card.rect.height) / 2,
      });
    }

    return references.map((reference) => ({
      ...reference,
      screen: worldToScreenPoint(canvasState, reference.x, reference.y),
    }));
  }

  function drawTransformDebug(ctx, canvasState) {
    const references = getTransformReferencePoints(canvasState);

    if (!transformDebugMode || !references.length) {
      return 0;
    }

    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = "11px Arial, sans-serif";
    ctx.textBaseline = "top";

    for (const reference of references) {
      const { x, y } = reference.screen;
      const color = reference.kind === "bounds" ? "#ff2d55" : "#007aff";

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 8, y);
      ctx.lineTo(x + 8, y);
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x, y + 8);
      ctx.stroke();
      ctx.fillText(reference.id, x + 10, y + 10);
    }

    ctx.restore();
    return references.length;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getVisibleTileWindow(level, canvasState, padding = 0) {
    const scale = Number(canvasState.scale);
    const offsetX = Number(canvasState.offsetX);
    const offsetY = Number(canvasState.offsetY);
    const viewportWidth = Number(canvasState.viewportWidth || state.viewportWidth);
    const viewportHeight = Number(canvasState.viewportHeight || state.viewportHeight);

    if (
      !isFiniteNumber(scale) ||
      !isFiniteNumber(offsetX) ||
      !isFiniteNumber(offsetY) ||
      !isFiniteNumber(viewportWidth) ||
      !isFiniteNumber(viewportHeight) ||
      scale <= 0 ||
      viewportWidth <= 0 ||
      viewportHeight <= 0
    ) {
      return null;
    }

    const worldMinX = (0 - offsetX) / scale;
    const worldMinY = (0 - offsetY) / scale;
    const worldMaxX = (viewportWidth - offsetX) / scale;
    const worldMaxY = (viewportHeight - offsetY) / scale;
    const scaledMinX = worldMinX * level.level;
    const scaledMinY = worldMinY * level.level;
    const scaledMaxX = worldMaxX * level.level;
    const scaledMaxY = worldMaxY * level.level;

    return {
      columnStart: clamp(Math.floor(Math.min(scaledMinX, scaledMaxX) / level.tileSize) - padding, 0, level.columns - 1),
      columnEnd: clamp(Math.floor(Math.max(scaledMinX, scaledMaxX) / level.tileSize) + padding, 0, level.columns - 1),
      rowStart: clamp(Math.floor(Math.min(scaledMinY, scaledMaxY) / level.tileSize) - padding, 0, level.rows - 1),
      rowEnd: clamp(Math.floor(Math.max(scaledMinY, scaledMaxY) / level.tileSize) + padding, 0, level.rows - 1),
    };
  }

  function getTilesInWindow(level, tileWindow) {
    const tiles = [];
    const missing = [];

    if (!tileWindow) {
      return { tiles, missing };
    }

    for (let row = tileWindow.rowStart; row <= tileWindow.rowEnd; row += 1) {
      for (let column = tileWindow.columnStart; column <= tileWindow.columnEnd; column += 1) {
        const key = `${column}:${row}`;
        const tile = level.tileMap.get(key);

        if (tile) {
          tiles.push(tile);
        } else {
          missing.push(key);
        }
      }
    }

    return { tiles, missing };
  }

  function loadTileImage(tile) {
    const cacheKey = (tile.candidates ?? []).map((candidate) => `${candidate.format}:${candidate.url}`).join("|") || tile.url;
    const cached = state.imageCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const entry = {
      status: "pending",
      image: null,
      promise: null,
      format: "",
      fallbackCount: 0,
    };

    entry.promise = new Promise((resolve) => {
      const image = new Image();
      const candidates = tile.candidates?.length ? tile.candidates : [{ format: "png", url: tile.url }];
      let candidateIndex = 0;

      const loadCandidate = () => {
        const candidate = candidates[candidateIndex];

        if (!candidate?.url) {
          entry.status = "error";
          resolve(entry);
          scheduleDraw();
          return;
        }

        entry.format = candidate.format;
        image.src = candidate.url;
      };

      image.decoding = "async";
      image.onload = () => {
        entry.status = "loaded";
        entry.image = image;
        resolve(entry);
        scheduleDraw();
      };
      image.onerror = () => {
        candidateIndex += 1;
        entry.fallbackCount = candidateIndex;

        if (candidateIndex < candidates.length) {
          loadCandidate();
          return;
        }

        entry.status = "error";
        resolve(entry);
        scheduleDraw();
      };
      loadCandidate();
    });

    state.imageCache.set(cacheKey, entry);
    return entry;
  }

  function resizeCanvas() {
    if (!canvas) {
      return false;
    }

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(Math.round(rect.width), 0);
    const height = Math.max(Math.round(rect.height), 0);
    const dpr = window.devicePixelRatio || 1;

    if (!width || !height) {
      return false;
    }

    if (width !== state.viewportWidth || height !== state.viewportHeight || dpr !== state.dpr) {
      state.viewportWidth = width;
      state.viewportHeight = height;
      state.dpr = dpr;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    return true;
  }

  function clearCanvas(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    if (!canvas) {
      updateDiagnostics({ fallbackReason: "missing-canvas" });
      return;
    }

    state.frame = 0;
    const startedAt = performance.now();
    const ctx = canvas.getContext("2d", { alpha: true });

    if (!ctx || !resizeCanvas()) {
      setActive(false, "canvas-not-measurable");
      return;
    }

    clearCanvas(ctx);

    const canvasState = state.canvasState;
    const selectedLevel = chooseLevel(canvasState?.scale);

    if (state.disabled) {
      setActive(false, state.disableReason || "disabled");
      updateDiagnostics({
        ...getEmptyOverlayDiagnostics(),
        sourceVersionStatus: "disabled",
        levelId: "",
        level: null,
        visibleTileCount: 0,
        drawnTileCount: 0,
        missingVisibleTiles: 0,
        pendingVisibleTiles: 0,
        drawMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
      return;
    }

    if (!state.manifest) {
      setActive(false, "manifest-not-loaded");
      return;
    }

    const sourceVersionStatus = getSourceVersionStatus();

    if (!sourceVersionStatus.current) {
      setActive(false, sourceVersionStatus.status);
      updateDiagnostics({
        ...getEmptyOverlayDiagnostics(),
        sourceVersionStatus: sourceVersionStatus.status,
        levelId: "",
        level: null,
        visibleTileCount: 0,
        drawnTileCount: 0,
        missingVisibleTiles: 0,
        pendingVisibleTiles: 0,
        drawMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
      return;
    }

    if (!selectedLevel) {
      const maxTileModeScale = getMaxTileModeScale();
      const fallbackReason =
        Number(canvasState?.scale) > maxTileModeScale + 0.0001
          ? "above-scaled-view-band"
          : "outside-scaled-view-band";
      setActive(false, fallbackReason);
      updateDiagnostics({
        ...getEmptyOverlayDiagnostics(),
        sourceVersionStatus: sourceVersionStatus.status,
        levelId: "",
        level: null,
        visibleTileCount: 0,
        drawnTileCount: 0,
        missingVisibleTiles: 0,
        pendingVisibleTiles: 0,
        drawMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
      return;
    }

    const visibleWindow = getVisibleTileWindow(selectedLevel, canvasState, 0);
    const preloadWindow = getVisibleTileWindow(selectedLevel, canvasState, preloadPadding);
    const visible = getTilesInWindow(selectedLevel, visibleWindow);
    const preload = getTilesInWindow(selectedLevel, preloadWindow);
    let pendingVisibleTiles = 0;
    let drawnTileCount = 0;
    const drawnTileFormats = new Set();

    for (const tile of preload.tiles) {
      loadTileImage(tile);
    }

    for (const tile of visible.tiles) {
      const entry = loadTileImage(tile);

      if (entry.status === "pending") {
        pendingVisibleTiles += 1;
      }
    }

    const missingVisibleTiles = visible.missing.length;
    const hasCoverage = missingVisibleTiles === 0 && pendingVisibleTiles === 0 && visible.tiles.length > 0;

    if (!hasCoverage && !allowIncomplete) {
      setActive(false, missingVisibleTiles > 0 ? "visible-tiles-missing" : "visible-tiles-loading");
      updateDiagnostics({
        ...getEmptyOverlayDiagnostics(),
        sourceVersionStatus: sourceVersionStatus.status,
        levelId: selectedLevel.id ?? "",
        level: selectedLevel.level,
        tileSize: selectedLevel.tileSize,
        visibleTileCount: visible.tiles.length + visible.missing.length,
        drawnTileCount: 0,
        missingVisibleTiles,
        pendingVisibleTiles,
        drawMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
      return;
    }

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const overlay = getOverlayDrawState();
    const currentScale = Number(canvasState.scale);
    const tileWorldSize = selectedLevel.tileSize / selectedLevel.level;
    const seamOverlap = currentScale <= getMaxTileModeScale() ? 0.75 : 0;

    for (const tile of visible.tiles) {
      const entry = loadTileImage(tile);

      if (entry.status !== "loaded" || !entry.image) {
        continue;
      }

      const screenX = Number(canvasState.offsetX) + tile.column * tileWorldSize * currentScale;
      const screenY = Number(canvasState.offsetY) + tile.row * tileWorldSize * currentScale;
      const screenSize = tileWorldSize * currentScale;

      ctx.drawImage(
        entry.image,
        screenX - seamOverlap / 2,
        screenY - seamOverlap / 2,
        screenSize + seamOverlap,
        screenSize + seamOverlap,
      );
      drawnTileCount += 1;

      if (entry.format) {
        drawnTileFormats.add(entry.format);
      }
    }

    drawOverlayLines(ctx, canvasState, overlay.lines, overlay.cards);
    drawOverlayCards(ctx, canvasState, overlay.cards);
    const transformReferenceCount = drawTransformDebug(ctx, canvasState);

    const canActivate = allowIncomplete ? drawnTileCount > 0 : hasCoverage;
    setActive(canActivate, canActivate ? "" : "visible-tiles-loading");
    updateDiagnostics({
      sourceVersionStatus: sourceVersionStatus.status,
      levelId: selectedLevel.id ?? "",
      level: selectedLevel.level,
      tileSize: selectedLevel.tileSize,
      visibleTileCount: visible.tiles.length + visible.missing.length,
      drawnTileCount,
      missingVisibleTiles,
      pendingVisibleTiles,
      activeOverlayCardCount: overlay.cardCount,
      activeOverlayLineCount: overlay.lineCount,
      transformReferenceCount,
      hoveredCardId: state.hoveredCardId,
      activeTagFilter: state.activeTagFilter,
      tileFormats: Array.from(drawnTileFormats).sort(),
      drawMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });

    if (debugMode) {
      console.debug("[scaled-view-tiles]", window.__ds2026ScaledViewTileDiagnostics);
    }
  }

  function scheduleDraw() {
    if (state.frame) {
      return;
    }

    state.frame = window.requestAnimationFrame(draw);
  }

  function connectOverlayObserver() {
    if (state.overlayObserver) {
      return;
    }

    const connectionRoot = document.querySelector("[data-card-connections]");

    if (!connectionRoot) {
      return;
    }

    state.overlayObserver = new MutationObserver(scheduleDraw);
    state.overlayObserver.observe(connectionRoot, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
  }

  function shouldIgnorePointerEvent(event) {
    return Boolean(
      event.target instanceof Element &&
        event.target.closest(".corner, .case-study-detail-layer, .keyboard-popover"),
    );
  }

  function invalidateCanvasRect() {
    state.canvasRectDirty = true;
  }

  function getCanvasRect() {
    if (!canvas) {
      return null;
    }

    if (!state.canvasRect || state.canvasRectDirty) {
      state.canvasRect = canvas.getBoundingClientRect();
      state.canvasRectDirty = false;
    }

    return state.canvasRect;
  }

  function buildCardHitIndex() {
    const cards = state.renderManifest?.cards ?? [];
    const cellSize = 1200;
    const buckets = new Map();

    for (const card of cards) {
      const rect = card.rect;

      if (!rect) {
        continue;
      }

      const minColumn = Math.floor(rect.x / cellSize);
      const maxColumn = Math.floor((rect.x + rect.width) / cellSize);
      const minRow = Math.floor(rect.y / cellSize);
      const maxRow = Math.floor((rect.y + rect.height) / cellSize);

      for (let column = minColumn; column <= maxColumn; column += 1) {
        for (let row = minRow; row <= maxRow; row += 1) {
          const key = `${column}:${row}`;
          const bucket = buckets.get(key);

          if (bucket) {
            bucket.push(card);
          } else {
            buckets.set(key, [card]);
          }
        }
      }
    }

    state.cardHitIndex = {
      cards,
      cellSize,
      buckets,
    };
  }

  function getHitTestCandidates(point) {
    const cards = state.renderManifest?.cards ?? [];

    if (!cards.length) {
      return [];
    }

    if (!state.cardHitIndex || state.cardHitIndex.cards !== cards) {
      buildCardHitIndex();
    }

    if (!state.cardHitIndex) {
      return cards;
    }

    const column = Math.floor(point.x / state.cardHitIndex.cellSize);
    const row = Math.floor(point.y / state.cardHitIndex.cellSize);
    return state.cardHitIndex.buckets.get(`${column}:${row}`) ?? [];
  }

  function getWorldPointFromEvent(event) {
    if (!canvas || !state.canvasState) {
      return null;
    }

    const rect = getCanvasRect();

    if (!rect) {
      return null;
    }

    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const scale = Number(state.canvasState.scale);

    if (!Number.isFinite(scale) || scale <= 0) {
      return null;
    }

    return {
      x: (screenX - Number(state.canvasState.offsetX)) / scale,
      y: (screenY - Number(state.canvasState.offsetY)) / scale,
    };
  }

  function hitTestCard(event) {
    const point = getWorldPointFromEvent(event);
    const cards = point ? getHitTestCandidates(point) : [];

    if (!point || !cards.length) {
      return null;
    }

    for (let index = cards.length - 1; index >= 0; index -= 1) {
      const card = cards[index];
      const rect = card.rect;

      if (
        rect &&
        point.x >= rect.x &&
        point.y >= rect.y &&
        point.x <= rect.x + rect.width &&
        point.y <= rect.y + rect.height
      ) {
        return card;
      }
    }

    return null;
  }

  function hitTestTag(event) {
    const point = getWorldPointFromEvent(event);
    const cards = point ? getHitTestCandidates(point) : [];

    if (!point || !cards.length) {
      return null;
    }

    for (let cardIndex = cards.length - 1; cardIndex >= 0; cardIndex -= 1) {
      const tags = cards[cardIndex].tags ?? [];

      for (let tagIndex = tags.length - 1; tagIndex >= 0; tagIndex -= 1) {
        const tag = tags[tagIndex];
        const rect = tag.rect;

        if (
          rect &&
          point.x >= rect.x &&
          point.y >= rect.y &&
          point.x <= rect.x + rect.width &&
          point.y <= rect.y + rect.height
        ) {
          return tag;
        }
      }
    }

    return null;
  }

  function dispatchScaledViewCardEvent(name, cardId = "") {
    document.dispatchEvent(
      new CustomEvent(name, {
        detail: {
          cardId,
          renderMode: "scaled-view-tiles",
        },
      }),
    );
  }

  function clearScaledOverlay() {
    if (!state.hoveredCardId && !state.pinnedCardId && !state.activeTagFilter) {
      return;
    }

    state.hoveredCardId = "";
    state.pinnedCardId = "";
    state.activeTagFilter = null;
    dispatchScaledViewCardEvent("ds2026:scaled-view-card-hover", "");
    scheduleDraw();
  }

  function setScaledOverlayHover(cardId = "") {
    const nextCardId = String(cardId || "");

    if (nextCardId && !state.renderManifest?.cards?.some((card) => card.id === nextCardId)) {
      return false;
    }

    state.hoveredCardId = nextCardId;
    state.pinnedCardId = "";
    state.activeTagFilter = null;
    dispatchScaledViewCardEvent("ds2026:scaled-view-card-hover", nextCardId);
    scheduleDraw();
    return true;
  }

  function setScaledTagFilter(kind = "", value = "") {
    const nextFilter = {
      kind: String(kind || ""),
      value: String(value || ""),
    };

    if (!nextFilter.kind || !nextFilter.value || !getCardsMatchingTag(nextFilter.kind, nextFilter.value).length) {
      return false;
    }

    const isSame =
      state.activeTagFilter?.kind === nextFilter.kind &&
      normalizeTag(state.activeTagFilter.value) === normalizeTag(nextFilter.value);

    state.activeTagFilter = isSame ? null : nextFilter;
    state.hoveredCardId = "";
    state.pinnedCardId = "";
    scheduleDraw();
    return true;
  }

  function syncHoveredCard(event) {
    if (!state.active || shouldIgnorePointerEvent(event)) {
      if (state.hoveredCardId) {
        state.hoveredCardId = "";
        dispatchScaledViewCardEvent("ds2026:scaled-view-card-hover", "");
        scheduleDraw();
      }

      return;
    }

    const card = hitTestCard(event);
    const nextCardId = card?.id ?? "";

    if (nextCardId === state.hoveredCardId) {
      return;
    }

    state.hoveredCardId = nextCardId;
    dispatchScaledViewCardEvent("ds2026:scaled-view-card-hover", nextCardId);
    scheduleDraw();
  }

  function handleScaledViewClick(event) {
    if (!state.active || shouldIgnorePointerEvent(event)) {
      return;
    }

    if (window.__ds2026Canvas?.infiniteCanvas?.shouldSuppressCanvasClick?.()) {
      return;
    }

    const tag = hitTestTag(event);

    if (tag && setScaledTagFilter(tag.kind, tag.value)) {
      event.stopPropagation();
      return;
    }

    const card = hitTestCard(event);
    state.pinnedCardId = state.pinnedCardId === card?.id ? "" : card?.id ?? "";
    dispatchScaledViewCardEvent("ds2026:scaled-view-card-click", card?.id ?? "");
    scheduleDraw();
  }

  function handleKeydown(event) {
    if (event.key === "Escape") {
      clearScaledOverlay();
    }
  }

  function handleExternalTagFilter(event) {
    const kind = event.detail?.kind;
    const value = event.detail?.value;

    if (!state.active || !kind || !value) {
      return;
    }

    setScaledTagFilter(kind, value);
  }

  async function loadManifest() {
    if (!canvas) {
      return;
    }

    const nextProfile = getTileProfile();
    const nextManifestUrl = getManifestUrlForProfile(nextProfile);

    if (state.manifestUrl !== nextManifestUrl) {
      state.imageCache.clear();
    }

    state.tileProfile = nextProfile;
    state.manifestUrl = nextManifestUrl;
    updateDiagnostics({
      manifestUrl: state.manifestUrl,
      tileProfile: state.tileProfile,
      fallbackReason: "manifest-loading",
      sourceVersionStatus: "unchecked",
    });

    try {
      const requestOptions = forceFreshManifest ? { cache: "no-store" } : {};
      const response = await fetch(state.manifestUrl, requestOptions);

      if (!response.ok) {
        throw new Error(`Manifest request failed with ${response.status}.`);
      }

      state.manifest = await response.json();
      state.levels = (state.manifest.levels ?? [])
        .map(normalizeLevel)
        .filter(Boolean)
        .sort((a, b) => a.level - b.level);

      stage?.classList.toggle("is-scaled-view-tiles-ready", state.levels.length > 0);
      updateDiagnostics({
        error: "",
        fallbackReason: state.levels.length > 0 ? "waiting-for-canvas-state" : "manifest-has-no-levels",
        tileSize: Number(state.manifest.tileSize) || null,
      });
      scheduleDraw();
    } catch (error) {
      state.manifest = null;
      state.levels = [];
      stage?.classList.remove("is-scaled-view-tiles-ready");
      setActive(false, "manifest-load-failed");
      updateDiagnostics({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  function handleTileProfileChange() {
    state.manifest = null;
    state.levels = [];
    state.cardHitIndex = null;
    stage?.classList.remove("is-scaled-view-tiles-ready");
    setActive(false, "tile-profile-changing");
    loadManifest();
  }

  document.addEventListener("ds2026:canvas-state", (event) => {
    state.canvasState = event.detail ? { ...event.detail } : null;
    scheduleDraw();
  });

  document.addEventListener("ds2026:render-manifest-ready", (event) => {
    state.renderManifest = event.detail ?? window.__ds2026RenderManifest ?? null;
    state.cardHitIndex = null;
    connectOverlayObserver();
    scheduleDraw();
  });

  stage?.addEventListener("pointermove", syncHoveredCard);
  stage?.addEventListener("pointerleave", syncHoveredCard);
  stage?.addEventListener("click", handleScaledViewClick);
  window.addEventListener("keydown", handleKeydown);
  document.addEventListener("ds2026:tag-filter-selected", handleExternalTagFilter);
  window.addEventListener("resize", () => {
    invalidateCanvasRect();
    scheduleDraw();
  });
  window.visualViewport?.addEventListener("resize", () => {
    invalidateCanvasRect();
    scheduleDraw();
  });
  window.visualViewport?.addEventListener("scroll", () => {
    invalidateCanvasRect();
    scheduleDraw();
  });
  mobileTileMediaQuery.addEventListener?.("change", handleTileProfileChange);
  window.__ds2026ScaledViewTileSetHover = setScaledOverlayHover;
  window.__ds2026ScaledViewTileSetTagFilter = setScaledTagFilter;
  window.__ds2026ScaledViewTileClearOverlay = clearScaledOverlay;
  window.__ds2026ScaledViewTileSetDisabled = setDisabled;
  window.__ds2026ScaledViewTileGetTransformReferences = () => getTransformReferencePoints(state.canvasState);
  connectOverlayObserver();
  setDisabled(disabledByQuery, disabledByQuery ? disabledReason : "");
  loadManifest();
})();
