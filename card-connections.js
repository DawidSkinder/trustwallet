(function () {
  const canvasElement = document.querySelector("[data-infinite-canvas]");
  let cleanupCurrentGraph = null;
  let isTouchNavigating = false;

  function initConnectionGraph() {
    const connectionRoot = document.querySelector("[data-card-connections]");

    if (!connectionRoot) {
      return;
    }

    cleanupCurrentGraph?.();

    const cards = new Map(
      Array.from(connectionRoot.querySelectorAll("[data-card-node]")).map((card) => [card.dataset.cardNode, card]),
    );
    const lines = Array.from(connectionRoot.querySelectorAll("[data-connection-line]"));
    const graph = new Map();
    const cleanupCallbacks = [];

    function shouldIgnoreCardClick() {
      return Boolean(window.__canvasCopy?.infiniteCanvas?.shouldSuppressCanvasClick());
    }

    function shouldIgnoreConnectionInteraction(event) {
      return isTouchNavigating || event?.pointerType === "touch";
    }

    function addGraphEdge(from, to) {
      if (!cards.has(from) || !cards.has(to)) {
        return;
      }

      if (!graph.has(from)) {
        graph.set(from, new Set());
      }

      if (!graph.has(to)) {
        graph.set(to, new Set());
      }

      graph.get(from).add(to);
      graph.get(to).add(from);
    }

    for (const line of lines) {
      addGraphEdge(line.dataset.connectionFrom, line.dataset.connectionTo);
    }

    let hoveredNode = null;
    let pinnedNode = null;

    function clearActiveConnections() {
      for (const card of cards.values()) {
        card.classList.remove("is-connection-active");
      }

      for (const line of lines) {
        line.classList.remove("is-connection-active");
      }
    }

    function getConnectionGroup(nodeId) {
      if (!graph.has(nodeId)) {
        return new Set();
      }

      return new Set([nodeId, ...graph.get(nodeId)]);
    }

    function syncActiveConnections() {
      const activeNode = pinnedNode ?? hoveredNode;

      clearActiveConnections();

      if (!activeNode || !graph.has(activeNode)) {
        return;
      }

      const activeCards = getConnectionGroup(activeNode);

      for (const nodeId of activeCards) {
        cards.get(nodeId)?.classList.add("is-connection-active");
      }

      for (const line of lines) {
        if (line.dataset.connectionFrom === activeNode || line.dataset.connectionTo === activeNode) {
          line.classList.add("is-connection-active");
        }
      }
    }

    for (const [nodeId, card] of cards.entries()) {
      const handlePointerEnter = (event) => {
        if (!graph.has(nodeId) || shouldIgnoreConnectionInteraction(event)) {
          return;
        }

        hoveredNode = nodeId;
        syncActiveConnections();
      };

      const handlePointerLeave = (event) => {
        if (hoveredNode !== nodeId || shouldIgnoreConnectionInteraction(event)) {
          return;
        }

        hoveredNode = null;
        syncActiveConnections();
      };

      const handleClick = (event) => {
        if (!graph.has(nodeId) || isTouchNavigating || shouldIgnoreCardClick()) {
          return;
        }

        pinnedNode = nodeId;
        syncActiveConnections();
        event.stopPropagation();
      };

      card.addEventListener("pointerenter", handlePointerEnter);
      card.addEventListener("pointerleave", handlePointerLeave);
      card.addEventListener("click", handleClick);

      cleanupCallbacks.push(() => {
        card.removeEventListener("pointerenter", handlePointerEnter);
        card.removeEventListener("pointerleave", handlePointerLeave);
        card.removeEventListener("click", handleClick);
      });
    }

    function clearPinnedConnection() {
      if (shouldIgnoreCardClick()) {
        return;
      }

      if (!pinnedNode) {
        return;
      }

      pinnedNode = null;
      syncActiveConnections();
    }

    canvasElement?.addEventListener("click", clearPinnedConnection);
    cleanupCallbacks.push(() => {
      canvasElement?.removeEventListener("click", clearPinnedConnection);
    });

    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || !pinnedNode) {
        return;
      }

      pinnedNode = null;
      syncActiveConnections();
    };

    document.addEventListener("keydown", handleKeyDown);
    cleanupCallbacks.push(() => {
      document.removeEventListener("keydown", handleKeyDown);
    });

    const handleTouchNavigationStart = () => {
      isTouchNavigating = true;
      hoveredNode = null;
      pinnedNode = null;
      clearActiveConnections();
    };

    const handleTouchNavigationEnd = () => {
      isTouchNavigating = false;
    };

    document.addEventListener("caseforfit:touch-navigation-start", handleTouchNavigationStart);
    document.addEventListener("caseforfit:touch-navigation-end", handleTouchNavigationEnd);
    cleanupCallbacks.push(() => {
      document.removeEventListener("caseforfit:touch-navigation-start", handleTouchNavigationStart);
      document.removeEventListener("caseforfit:touch-navigation-end", handleTouchNavigationEnd);
    });

    cleanupCurrentGraph = () => {
      clearActiveConnections();

      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }

      cleanupCurrentGraph = null;
    };
  }

  initConnectionGraph();
  document.addEventListener("caseforfit:canvas-rendered", initConnectionGraph);
})();
