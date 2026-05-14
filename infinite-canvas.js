(function () {
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function positiveMod(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
  }

  function isEditableElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    return Boolean(
      element.closest(
        'input, textarea, select, button, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
      ),
    );
  }

  class InfiniteCanvasBackground {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.stage = canvas.closest(".stage");
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.onStateChange = options.onStateChange ?? null;
      this.onViewportChange = options.onViewportChange ?? null;
      this.onUserViewChange = options.onUserViewChange ?? null;

      this.backgroundColor = options.backgroundColor ?? "#1c1d20";
      this.baseSpacing = options.baseSpacing ?? 16;
      this.baseDotColor = options.baseDotColor ?? "#656565";
      this.hoverDotColor = options.hoverDotColor ?? "#f5f5f5";
      this.hoverRadius = options.hoverRadius ?? 104;
      this.hoverSigma = options.hoverSigma ?? 40;
      this.hoverMinAlpha = options.hoverMinAlpha ?? 0.03;
      this.minScale = options.minScale ?? 0.05;
      this.maxScale = options.maxScale ?? 1;
      this.initialScale = options.initialScale ?? 0.06;
      this.zoomIntensity = options.zoomIntensity ?? 0.002;
      this.minDotRadius = options.minDotRadius ?? 0.2;
      this.maxDotRadius = options.maxDotRadius ?? 1.5;
      this.toolMode = options.toolMode ?? "cursor";
      this.interactionEnabled = options.interactionEnabled ?? true;

      this.cssWidth = 0;
      this.cssHeight = 0;
      this.dpr = window.devicePixelRatio || 1;

      this.offsetX = 0;
      this.offsetY = 0;
      this.scale = this.initialScale;

      this.pointerX = 0;
      this.pointerY = 0;
      this.pointerInside = false;
      this.spacePressed = false;
      this.isPanning = false;
      this.isTouchPanning = false;
      this.dragPointerId = null;
      this.lastPointerX = 0;
      this.lastPointerY = 0;
      this.activeTouchPointers = new Map();
      this.pinchGesture = null;
      this.latestPinchMetrics = null;
      this.pinchFrame = 0;
      this.latestPanPointer = null;
      this.panFrame = 0;
      this.touchNavigationCount = 0;
      this.panTravel = 0;
      this.suppressClickUntil = 0;
      this.pointerCaptureElement = null;
      this.hasInitialTransform = false;
      this.rafId = 0;
      this.viewAnimationFrame = 0;
      this.mounted = false;

      this.handleResize = this.handleResize.bind(this);
      this.handleKeyDown = this.handleKeyDown.bind(this);
      this.handleKeyUp = this.handleKeyUp.bind(this);
      this.handlePointerDown = this.handlePointerDown.bind(this);
      this.handlePointerMove = this.handlePointerMove.bind(this);
      this.handlePointerUp = this.handlePointerUp.bind(this);
      this.handlePointerLeave = this.handlePointerLeave.bind(this);
      this.handleWheel = this.handleWheel.bind(this);
      this.handleWindowBlur = this.handleWindowBlur.bind(this);
    }

    mount() {
      if (this.mounted || !this.ctx || !this.stage) {
        return;
      }

      this.mounted = true;

      window.addEventListener("resize", this.handleResize);
      window.addEventListener("keydown", this.handleKeyDown);
      window.addEventListener("keyup", this.handleKeyUp);
      window.addEventListener("blur", this.handleWindowBlur);

      this.stage.addEventListener("pointerdown", this.handlePointerDown);
      this.stage.addEventListener("pointermove", this.handlePointerMove);
      this.stage.addEventListener("pointerup", this.handlePointerUp);
      this.stage.addEventListener("pointercancel", this.handlePointerUp);
      this.stage.addEventListener("pointerleave", this.handlePointerLeave);
      this.stage.addEventListener("wheel", this.handleWheel, { passive: false });

      this.handleResize();
    }

    destroy() {
      if (!this.mounted) {
        return;
      }

      this.mounted = false;

      window.removeEventListener("resize", this.handleResize);
      window.removeEventListener("keydown", this.handleKeyDown);
      window.removeEventListener("keyup", this.handleKeyUp);
      window.removeEventListener("blur", this.handleWindowBlur);

      this.stage.removeEventListener("pointerdown", this.handlePointerDown);
      this.stage.removeEventListener("pointermove", this.handlePointerMove);
      this.stage.removeEventListener("pointerup", this.handlePointerUp);
      this.stage.removeEventListener("pointercancel", this.handlePointerUp);
      this.stage.removeEventListener("pointerleave", this.handlePointerLeave);
      this.stage.removeEventListener("wheel", this.handleWheel);

      if (this.rafId) {
        window.cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }

      if (this.viewAnimationFrame) {
        window.cancelAnimationFrame(this.viewAnimationFrame);
        this.viewAnimationFrame = 0;
      }

      this.cancelPanFrame();
      this.cancelPinchFrame();
      document.body.classList.remove("is-canvas-panning");
      this.stage.classList.remove("is-hand-mode", "is-panning");
      this.forceEndTouchNavigation();
    }

    notifyStateChange() {
      if (typeof this.onStateChange === "function") {
        this.onStateChange(this.getState());
      }
    }

    notifyViewportChange(detail) {
      if (typeof this.onViewportChange === "function") {
        this.onViewportChange(detail);
      }
    }

    notifyUserViewChange(reason) {
      if (typeof this.onUserViewChange === "function") {
        this.onUserViewChange(reason);
      }
    }

    handleResize() {
      const bounds = this.canvas.getBoundingClientRect();
      const nextWidth = Math.round(bounds.width);
      const nextHeight = Math.round(bounds.height);
      const nextDpr = window.devicePixelRatio || 1;

      if (!nextWidth || !nextHeight) {
        return;
      }

      const didViewportChange =
        nextWidth !== this.cssWidth || nextHeight !== this.cssHeight || nextDpr !== this.dpr;

      this.cssWidth = nextWidth;
      this.cssHeight = nextHeight;
      this.dpr = nextDpr;

      this.canvas.width = Math.round(nextWidth * nextDpr);
      this.canvas.height = Math.round(nextHeight * nextDpr);

      if (!this.hasInitialTransform) {
        this.offsetX = nextWidth / 2;
        this.offsetY = nextHeight / 2;
        this.hasInitialTransform = true;
      }

      this.notifyStateChange();
      this.scheduleRender();

      if (didViewportChange) {
        this.notifyViewportChange({
          width: this.cssWidth,
          height: this.cssHeight,
          dpr: this.dpr,
        });
      }
    }

    handleKeyDown(event) {
      if (!this.interactionEnabled || event.code !== "Space" || event.repeat || !this.canActivateHandTool(event.target)) {
        return;
      }

      this.spacePressed = true;
      this.syncStageState();
      this.notifyStateChange();
      event.preventDefault();
      this.scheduleRender();
    }

    handleKeyUp(event) {
      if (event.code !== "Space" || !this.spacePressed) {
        return;
      }

      this.spacePressed = false;
      this.stopPanning();
      this.syncStageState();
      this.notifyStateChange();
      event.preventDefault();
      this.scheduleRender();
    }

    handlePointerDown(event) {
      const pointer = this.getPointerPosition(event);

      if (event.pointerType === "touch" && this.canUseCanvasSurface(event.target)) {
        this.activeTouchPointers.set(event.pointerId, pointer);

        if (!this.interactionEnabled) {
          return;
        }

        if (this.activeTouchPointers.size >= 2) {
          this.stopPanning();
          this.startPinchGesture();
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        if (this.canStartTouchPanning(event.target)) {
          this.startPanning(event, pointer);
          return;
        }
      }

      if (
        event.button !== 0 ||
        !this.interactionEnabled ||
        !this.isHandModeEnabled() ||
        !this.canStartPanning(event.target)
      ) {
        return;
      }

      this.startPanning(event, pointer);
    }

    startPanning(event, pointer) {
      if (event.pointerType === "touch") {
        this.beginTouchNavigation();
      }

      this.pointerInside = true;
      this.pointerX = pointer.x;
      this.pointerY = pointer.y;
      this.lastPointerX = pointer.x;
      this.lastPointerY = pointer.y;
      this.panTravel = 0;
      this.dragPointerId = event.pointerId;
      this.isTouchPanning = event.pointerType === "touch";
      this.isPanning = true;

      document.body.classList.add("is-canvas-panning");
      this.syncStageState();
      this.pointerCaptureElement = this.stage;
      this.pointerCaptureElement.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      this.scheduleRender();
    }

    handlePointerMove(event) {
      const pointer = this.getPointerPosition(event);

      if (event.pointerType === "touch" && this.activeTouchPointers.has(event.pointerId)) {
        this.activeTouchPointers.set(event.pointerId, pointer);

        if (this.activeTouchPointers.size >= 2) {
          if (!this.pinchGesture) {
            this.startPinchGesture();
          }

          this.queuePinchGestureUpdate();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      if (this.isPanning && this.dragPointerId === event.pointerId) {
        this.queuePanGestureUpdate(pointer);
        event.preventDefault();
        return;
      }

      if (!this.isWithinCanvas(pointer.x, pointer.y)) {
        return;
      }

      this.pointerInside = true;
      this.pointerX = pointer.x;
      this.pointerY = pointer.y;
      this.scheduleRender();
    }

    handlePointerUp(event) {
      if (event.pointerType === "touch") {
        const wasPinching = Boolean(this.pinchGesture);

        this.activeTouchPointers.delete(event.pointerId);

        if (wasPinching) {
          this.cancelPinchFrame();
          this.pinchGesture = null;
          this.latestPinchMetrics = null;
          this.suppressClickUntil = performance.now() + 160;
          this.endTouchNavigation();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      if (this.dragPointerId !== event.pointerId) {
        return;
      }

      this.latestPanPointer = this.getPointerPosition(event);
      this.flushPanGestureUpdate();

      if (this.panTravel > 4) {
        this.suppressClickUntil = performance.now() + 160;
      }

      this.stopPanning();
      this.pointerInside = this.isWithinCanvas(this.pointerX, this.pointerY);
      this.scheduleRender();
    }

    handlePointerLeave() {
      if (this.isPanning || this.pinchGesture || !this.pointerInside) {
        return;
      }

      this.pointerInside = false;
      this.scheduleRender();
    }

    handleWheel(event) {
      if (
        !this.interactionEnabled ||
        (!event.altKey && !event.ctrlKey && !event.metaKey) ||
        !this.canUseCanvasSurface(event.target)
      ) {
        return;
      }

      const pointer = this.getPointerPosition(event);
      const nextScale = clamp(this.scale * Math.exp(-event.deltaY * this.zoomIntensity), this.minScale, this.maxScale);

      if (nextScale === this.scale) {
        event.preventDefault();
        return;
      }

      const worldX = (pointer.x - this.offsetX) / this.scale;
      const worldY = (pointer.y - this.offsetY) / this.scale;

      this.scale = nextScale;
      this.offsetX = pointer.x - worldX * nextScale;
      this.offsetY = pointer.y - worldY * nextScale;
      this.pointerX = pointer.x;
      this.pointerY = pointer.y;
      this.pointerInside = this.isWithinCanvas(pointer.x, pointer.y);

      event.preventDefault();
      this.notifyUserViewChange("wheel-zoom");
      this.notifyStateChange();
      this.scheduleRender();
    }

    handleWindowBlur() {
      this.spacePressed = false;
      this.pointerInside = false;
      this.activeTouchPointers.clear();
      this.cancelPanFrame();
      this.cancelPinchFrame();
      this.pinchGesture = null;
      this.latestPinchMetrics = null;
      this.stopPanning();
      this.forceEndTouchNavigation();
      this.syncStageState();
      this.scheduleRender();
    }

    canActivateHandTool(target) {
      if (isEditableElement(target)) {
        return false;
      }

      if (isEditableElement(document.activeElement)) {
        return false;
      }

      return true;
    }

    canUseCanvasSurface(target) {
      if (!(target instanceof Element)) {
        return false;
      }

      if (isEditableElement(target) || target.closest(".corner")) {
        return false;
      }

      return Boolean(target.closest("[data-infinite-canvas], [data-canvas-world]"));
    }

    canStartPanning(target) {
      return this.canUseCanvasSurface(target);
    }

    canStartTouchPanning(target) {
      if (!(target instanceof Element)) {
        return false;
      }

      if (target.closest("a, button")) {
        return false;
      }

      return this.canUseCanvasSurface(target);
    }

    isHandModeEnabled() {
      return this.toolMode === "hand" || this.spacePressed;
    }

    stopPanning() {
      const pointerId = this.dragPointerId;
      const wasTouchPanning = this.isTouchPanning;

      this.flushPanGestureUpdate();

      if (pointerId !== null && this.pointerCaptureElement?.hasPointerCapture(pointerId)) {
        this.pointerCaptureElement.releasePointerCapture(pointerId);
      }

      this.isPanning = false;
      this.isTouchPanning = false;
      this.dragPointerId = null;
      this.pointerCaptureElement = null;
      document.body.classList.remove("is-canvas-panning");
      if (wasTouchPanning) {
        this.endTouchNavigation();
      }
      this.syncStageState();
      this.notifyStateChange();
    }

    queuePanGestureUpdate(pointer) {
      this.latestPanPointer = pointer;

      if (this.panFrame) {
        return;
      }

      this.panFrame = window.requestAnimationFrame(() => {
        this.panFrame = 0;
        this.applyPanGesture();
      });
    }

    applyPanGesture() {
      const pointer = this.latestPanPointer;

      if (!this.isPanning || !pointer) {
        this.latestPanPointer = null;
        return;
      }

      this.latestPanPointer = null;

      const deltaX = pointer.x - this.lastPointerX;
      const deltaY = pointer.y - this.lastPointerY;

      if (deltaX || deltaY) {
        this.notifyUserViewChange("pan");
      }

      this.offsetX += deltaX;
      this.offsetY += deltaY;
      this.panTravel += Math.hypot(deltaX, deltaY);
      this.lastPointerX = pointer.x;
      this.lastPointerY = pointer.y;
      this.pointerX = pointer.x;
      this.pointerY = pointer.y;
      this.pointerInside = true;
      this.notifyStateChange();
      this.scheduleRender();
    }

    flushPanGestureUpdate() {
      if (this.panFrame) {
        window.cancelAnimationFrame(this.panFrame);
        this.panFrame = 0;
      }

      if (this.latestPanPointer) {
        this.applyPanGesture();
      }
    }

    cancelPanFrame() {
      if (!this.panFrame) {
        this.latestPanPointer = null;
        return;
      }

      window.cancelAnimationFrame(this.panFrame);
      this.panFrame = 0;
      this.latestPanPointer = null;
    }

    getPinchPointers() {
      return Array.from(this.activeTouchPointers.values()).slice(0, 2);
    }

    getPinchMetrics() {
      const [firstPointer, secondPointer] = this.getPinchPointers();

      if (!firstPointer || !secondPointer) {
        return null;
      }

      return {
        centerX: (firstPointer.x + secondPointer.x) / 2,
        centerY: (firstPointer.y + secondPointer.y) / 2,
        distance: Math.hypot(secondPointer.x - firstPointer.x, secondPointer.y - firstPointer.y),
      };
    }

    startPinchGesture() {
      if (!this.interactionEnabled) {
        return;
      }

      const metrics = this.getPinchMetrics();

      if (!metrics || metrics.distance <= 0) {
        return;
      }

      this.cancelViewAnimation();
      this.cancelPinchFrame();
      this.beginTouchNavigation();
      this.pinchGesture = {
        startDistance: metrics.distance,
        startScale: this.scale,
        worldX: (metrics.centerX - this.offsetX) / this.scale,
        worldY: (metrics.centerY - this.offsetY) / this.scale,
      };
      this.latestPinchMetrics = metrics;
    }

    queuePinchGestureUpdate() {
      const metrics = this.getPinchMetrics();

      if (!this.pinchGesture || !metrics || metrics.distance <= 0) {
        return;
      }

      this.latestPinchMetrics = metrics;

      if (this.pinchFrame) {
        return;
      }

      this.pinchFrame = window.requestAnimationFrame(() => {
        this.pinchFrame = 0;
        this.applyPinchGesture();
      });
    }

    applyPinchGesture() {
      const metrics = this.latestPinchMetrics;

      if (!this.pinchGesture || !metrics || metrics.distance <= 0) {
        return;
      }

      const nextScale = clamp(
        this.pinchGesture.startScale * (metrics.distance / this.pinchGesture.startDistance),
        this.minScale,
        this.maxScale,
      );

      this.scale = nextScale;
      this.offsetX = metrics.centerX - this.pinchGesture.worldX * nextScale;
      this.offsetY = metrics.centerY - this.pinchGesture.worldY * nextScale;
      this.pointerX = metrics.centerX;
      this.pointerY = metrics.centerY;
      this.pointerInside = this.isWithinCanvas(metrics.centerX, metrics.centerY);

      this.notifyUserViewChange("pinch-zoom");
      this.notifyStateChange();
      this.scheduleRender();
    }

    cancelPinchFrame() {
      if (!this.pinchFrame) {
        return;
      }

      window.cancelAnimationFrame(this.pinchFrame);
      this.pinchFrame = 0;
    }

    beginTouchNavigation() {
      this.touchNavigationCount += 1;

      if (this.touchNavigationCount !== 1) {
        return;
      }

      this.stage.classList.add("is-touch-navigating");
      document.dispatchEvent(new CustomEvent("caseforfit:touch-navigation-start"));
    }

    endTouchNavigation() {
      if (this.touchNavigationCount <= 0) {
        return;
      }

      this.touchNavigationCount -= 1;

      if (this.touchNavigationCount > 0) {
        return;
      }

      this.stage.classList.remove("is-touch-navigating");
      document.dispatchEvent(new CustomEvent("caseforfit:touch-navigation-end"));
    }

    forceEndTouchNavigation() {
      const wasTouchNavigating = this.touchNavigationCount > 0 || this.stage.classList.contains("is-touch-navigating");

      this.touchNavigationCount = 0;
      this.stage.classList.remove("is-touch-navigating");

      if (wasTouchNavigating) {
        document.dispatchEvent(new CustomEvent("caseforfit:touch-navigation-end"));
      }
    }

    syncStageState() {
      this.stage.classList.toggle("is-hand-mode", this.interactionEnabled && this.isHandModeEnabled() && !this.isPanning);
      this.stage.classList.toggle("is-panning", this.isPanning);
    }

    getPointerPosition(event) {
      const bounds = this.canvas.getBoundingClientRect();

      return {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
    }

    isWithinCanvas(x, y) {
      return x >= 0 && y >= 0 && x <= this.cssWidth && y <= this.cssHeight;
    }

    scheduleRender() {
      if (this.rafId) {
        return;
      }

      this.rafId = window.requestAnimationFrame(() => {
        this.rafId = 0;
        this.render();
      });
    }

    getState() {
      return {
        offsetX: this.offsetX,
        offsetY: this.offsetY,
        scale: this.scale,
        pointerInside: this.pointerInside,
        spacePressed: this.spacePressed,
        isPanning: this.isPanning,
        toolMode: this.toolMode,
        interactionEnabled: this.interactionEnabled,
        suppressClickUntil: this.suppressClickUntil,
        minScale: this.minScale,
        maxScale: this.maxScale,
        viewportWidth: this.cssWidth,
        viewportHeight: this.cssHeight,
      };
    }

    refreshViewport() {
      this.handleResize();
      return this.getState();
    }

    shouldSuppressCanvasClick() {
      return (
        !this.interactionEnabled ||
        this.toolMode === "hand" ||
        this.spacePressed ||
        this.isPanning ||
        performance.now() < this.suppressClickUntil
      );
    }

    screenToWorld(screenX, screenY) {
      return {
        x: (screenX - this.offsetX) / this.scale,
        y: (screenY - this.offsetY) / this.scale,
      };
    }

    worldToScreen(worldX, worldY) {
      return {
        x: this.offsetX + worldX * this.scale,
        y: this.offsetY + worldY * this.scale,
      };
    }

    setInteractionEnabled(enabled) {
      this.interactionEnabled = Boolean(enabled);

      if (!this.interactionEnabled) {
        this.spacePressed = false;
        this.activeTouchPointers.clear();
        this.cancelPanFrame();
        this.cancelPinchFrame();
        this.pinchGesture = null;
        this.latestPinchMetrics = null;
        this.stopPanning();
        this.forceEndTouchNavigation();
      }

      this.syncStageState();
      this.notifyStateChange();
      this.scheduleRender();
    }

    setToolMode(mode) {
      if (mode !== "cursor" && mode !== "hand") {
        return;
      }

      this.toolMode = mode;

      if (mode === "hand") {
        this.spacePressed = false;
      }

      this.syncStageState();
      this.notifyStateChange();
      this.scheduleRender();
    }

    cancelViewAnimation() {
      if (!this.viewAnimationFrame) {
        return;
      }

      window.cancelAnimationFrame(this.viewAnimationFrame);
      this.viewAnimationFrame = 0;
    }

    setView({ scale = this.scale, offsetX = this.offsetX, offsetY = this.offsetY } = {}) {
      this.cancelViewAnimation();
      this.scale = clamp(scale, this.minScale, this.maxScale);
      this.offsetX = offsetX;
      this.offsetY = offsetY;
      this.notifyStateChange();
      this.scheduleRender();
    }

    setScaleBounds({ minScale = this.minScale, maxScale = this.maxScale } = {}) {
      if (!Number.isFinite(minScale) || !Number.isFinite(maxScale) || minScale <= 0 || maxScale < minScale) {
        return;
      }

      this.minScale = minScale;
      this.maxScale = maxScale;

      if (this.scale < this.minScale || this.scale > this.maxScale) {
        this.setScale(this.scale);
        return;
      }

      this.notifyStateChange();
    }

    animateViewTo(targetView, duration = 800) {
      if (!targetView) {
        return Promise.resolve();
      }

      this.cancelViewAnimation();

      if (duration <= 0) {
        this.setView(targetView);
        return Promise.resolve();
      }

      const targetScale = Number.isFinite(targetView.scale)
        ? clamp(targetView.scale, this.minScale, this.maxScale)
        : this.scale;
      const startScale = this.scale;
      const startOffsetX = this.offsetX;
      const startOffsetY = this.offsetY;
      const startTime = performance.now();

      return new Promise((resolve) => {
        const step = (now) => {
          const elapsed = now - startTime;
          const progress = clamp(elapsed / duration, 0, 1);
          const eased = 1 - Math.pow(1 - progress, 3);

          this.scale = startScale + (targetScale - startScale) * eased;
          this.offsetX = startOffsetX + (targetView.offsetX - startOffsetX) * eased;
          this.offsetY = startOffsetY + (targetView.offsetY - startOffsetY) * eased;
          this.notifyStateChange();
          this.scheduleRender();

          if (progress >= 1) {
            this.viewAnimationFrame = 0;
            resolve();
            return;
          }

          this.viewAnimationFrame = window.requestAnimationFrame(step);
        };

        this.viewAnimationFrame = window.requestAnimationFrame(step);
      });
    }

    setScale(nextScale, anchorX = this.cssWidth / 2, anchorY = this.cssHeight / 2) {
      this.cancelViewAnimation();
      const clampedScale = clamp(nextScale, this.minScale, this.maxScale);

      if (!this.cssWidth || !this.cssHeight || clampedScale === this.scale) {
        return;
      }

      const worldX = (anchorX - this.offsetX) / this.scale;
      const worldY = (anchorY - this.offsetY) / this.scale;

      this.scale = clampedScale;
      this.offsetX = anchorX - worldX * clampedScale;
      this.offsetY = anchorY - worldY * clampedScale;
      this.notifyStateChange();
      this.scheduleRender();
    }

    resetView(scale = this.initialScale) {
      if (!this.cssWidth || !this.cssHeight) {
        return;
      }

      this.setView({
        scale,
        offsetX: this.cssWidth / 2,
        offsetY: this.cssHeight / 2,
      });
    }

    render() {
      const { ctx } = this;

      if (!ctx || !this.cssWidth || !this.cssHeight) {
        return;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;

      ctx.fillStyle = this.backgroundColor;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

      this.renderGrid(ctx);
    }

    getZoomBandStride() {
      if (this.scale <= 0.1) {
        return 10;
      }

      if (this.scale <= 0.3) {
        return 4;
      }

      return 1;
    }

    getGridMetrics() {
      const stride = this.getZoomBandStride();
      const spacing = this.baseSpacing * this.scale * stride;
      const dotRadius = clamp(spacing / 16, this.minDotRadius, this.maxDotRadius);
      const phaseX = positiveMod(this.offsetX, spacing);
      const phaseY = positiveMod(this.offsetY, spacing);
      const padding = dotRadius + 2;
      const startColumn = Math.floor((-phaseX - padding) / spacing);
      const endColumn = Math.ceil((this.cssWidth - phaseX + padding) / spacing);
      const startRow = Math.floor((-phaseY - padding) / spacing);
      const endRow = Math.ceil((this.cssHeight - phaseY + padding) / spacing);

      return {
        spacing,
        dotRadius,
        dotSize: dotRadius * 2,
        phaseX,
        phaseY,
        startColumn,
        endColumn,
        startRow,
        endRow,
      };
    }

    renderGrid(ctx) {
      const metrics = this.getGridMetrics();
      const hasHover = this.pointerInside;
      const radiusSquared = this.hoverRadius * this.hoverRadius;
      const sigmaSquared = 2 * this.hoverSigma * this.hoverSigma;
      const dotSize = metrics.dotSize;
      const dotOffset = dotSize / 2;

      ctx.fillStyle = this.baseDotColor;

      for (let row = metrics.startRow; row <= metrics.endRow; row += 1) {
        const y = metrics.phaseY + row * metrics.spacing;
        const dy = y - this.pointerY;
        const dySquared = dy * dy;

        for (let column = metrics.startColumn; column <= metrics.endColumn; column += 1) {
          const x = metrics.phaseX + column * metrics.spacing;

          ctx.globalAlpha = 1;
          ctx.fillRect(x - dotOffset, y - dotOffset, dotSize, dotSize);

          if (!hasHover) {
            continue;
          }

          const dx = x - this.pointerX;
          const distanceSquared = dx * dx + dySquared;

          if (distanceSquared > radiusSquared) {
            continue;
          }

          const alpha = 0.9 * Math.exp(-distanceSquared / sigmaSquared);

          if (alpha < this.hoverMinAlpha) {
            continue;
          }

          ctx.globalAlpha = alpha;
          ctx.fillStyle = this.hoverDotColor;
          ctx.fillRect(x - dotOffset, y - dotOffset, dotSize, dotSize);
          ctx.fillStyle = this.baseDotColor;
        }
      }

      ctx.globalAlpha = 1;
    }
  }

  window.InfiniteCanvasBackground = InfiniteCanvasBackground;
})();
