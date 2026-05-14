(function () {
  const staticMapQuery = window.matchMedia("(max-width: 767px), (pointer: coarse)");

  function keepStaticMapFallbacks() {
    for (const mapElement of document.querySelectorAll("[data-map-card]:not([data-map-ready])")) {
      mapElement.dataset.mapReady = "static";
    }
  }

  function initMapCards() {
    if (staticMapQuery.matches) {
      keepStaticMapFallbacks();
      return;
    }

    const mapElements = Array.from(document.querySelectorAll("[data-map-card]:not([data-map-ready])"));

    if (!mapElements.length || !window.L) {
      return;
    }

    for (const mapElement of mapElements) {
      const lat = Number.parseFloat(mapElement.dataset.mapLat);
      const lng = Number.parseFloat(mapElement.dataset.mapLng);
      const zoom = Number.parseInt(mapElement.dataset.mapZoom || "15", 10);
      const coordinates = [
        Number.isFinite(lat) ? lat : 50.11432588966449,
        Number.isFinite(lng) ? lng : 14.481933249169707,
      ];
      const title = mapElement.dataset.mapTitle || "Map location";

      mapElement.dataset.mapReady = "true";
      mapElement.querySelector(".map-card-fallback")?.remove();

      const map = window.L.map(mapElement, {
        attributionControl: true,
        boxZoom: false,
        doubleClickZoom: false,
        dragging: false,
        keyboard: false,
        scrollWheelZoom: false,
        tap: false,
        touchZoom: false,
        zoomControl: false,
      }).setView(coordinates, Number.isFinite(zoom) ? zoom : 15);

      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      const markerIcon = window.L.divIcon({
        className: "map-card-marker",
        html: '<span class="map-card-marker-pin"></span>',
        iconAnchor: [12, 24],
        iconSize: [24, 24],
      });

      window.L.marker(coordinates, {
        icon: markerIcon,
        interactive: false,
        keyboard: false,
        title,
      }).addTo(map);

      window.requestAnimationFrame(() => {
        map.invalidateSize();
      });
    }
  }

  initMapCards();
  document.addEventListener("caseforfit:canvas-rendered", initMapCards);
})();
